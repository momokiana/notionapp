import { randomUUID } from "node:crypto";
import { homedir, hostname, platform } from "node:os";
import type { Agent as HttpsAgent } from "node:https";
import { WebSocket } from "ws";
import {
  HARNESS_ICON_MAX,
  PROTOCOL_VERSION,
  RUNTIME_SESSION_TEXT_LIMIT,
  agentKey,
  parseAgentKey,
  rowsChange,
  type Agent,
  type AgentStatus,
  type ConvEvent,
  type HostSource,
  type LayoutSpace,
  type Device,
  type ClientFrame,
  type RpcError,
  type RpcMethod,
  type RpcMethods,
  type RuntimeSessionDetail,
  type ServerFrame,
  type SessionHit,
  type SessionInfo,
  type SessionRuntime,
  type TerminalRowsEvent,
} from "@xiaoaixiaoai/protocol";
import { HcAdapter, type AppNames } from "./hc.ts";
import type { ScreenLines } from "./hcscreen.ts";
import { HerdrApp, NoDesktopApp, checkFolder, herdrCommandArgs, installedLaunchers, launcherArgv, resumeArgv, withProgramPath } from "./create.ts";
import { HerdrAdapter } from "./herdr.ts";
import { UnifloAdapter, harnessId } from "./uniflo.ts";
import { SessionHints } from "./sessionhint.ts";
import { base, debounce } from "./util.ts";
import { InputWaits } from "./waiting.ts";
import { typeFirstTask, type TypeTaskOptions } from "./firsttask.ts";
import { FILES_DIR, checkFiles, putLocal, putThrough, type CheckedFile } from "./put.ts";
import { LogBuffer, clipChars, levelOf } from "./logbuf.ts";
import type { HostConfig } from "./config.ts";
import { RuntimeError, encodeRuntimeLocalId, encodeRuntimeSessionKey, parseRuntimeTarget, type RuntimeSessions } from "./runtime-sessions.ts";
import {
  RuntimeEventSeqTracker,
  entryMatchesFilter,
  entrySearchPriority,
  extractSearchHit,
  formatRuntimeTerminalText,
  matchQuestionAnswer,
  nextRuntimeState,
  parseRuntimeSearchQuery,
  type RuntimeAgentState,
} from "./runtime-bridge.ts";
import { RuntimeTaskReporter } from "./runtime-task-reporter.ts";
import { VERSION } from "@xiaoaixiaoai/update";

/** The repository version (root package.json), shared with the relay and the app. */
export const HOSTD_VERSION = VERSION;

/** Calls that change something here: logged when they work too. */
const MUTATING = new Set(["terminal.send", "terminal.keys", "terminal.put", "agent.create", "terminal.interrupt", "terminal.kill", "herdr.command", "sessions.resume", "runtimeSessions.send", "runtimeSessions.answer"]);

/** What a call was about, short: never more than 200 characters of anyone's message. */
function callSummary(params: unknown, result?: unknown): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (params && typeof params === "object") {
    const p = params as Record<string, unknown>;
    for (const k of ["agent", "launcher", "space", "spaceName", "tabName", "folder", "command", "session"]) if (typeof p[k] === "string") out[k] = p[k];
    if (typeof p.text === "string") out.text = clipChars(p.text, 200);
    if (typeof p.task === "string") out.task = clipChars(p.task, 200);
    if (Array.isArray(p.keys)) out.keys = p.keys.slice(0, 16).join(" ");
    // Pictures: how many, never their contents.
    if (Array.isArray(p.files)) out.files = p.files.length;
    if (p.args && typeof p.args === "object") out.args = clipChars(JSON.stringify(p.args), 200);
  }
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    for (const k of ["agent", "terminal", "position", "waiting", "agentStatus", "task", "taskNote"]) if (r[k] !== undefined && typeof r[k] !== "object") out[`result.${k}`] = r[k];
  }
  return Object.keys(out).length ? out : undefined;
}

type Handler<M extends RpcMethod> = (params: RpcMethods[M]["params"], from: string) => Promise<RpcMethods[M]["result"]>;

class RpcFailure extends Error {
  code: RpcError["code"];
  constructor(code: RpcError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface HostOptions {
  config: HostConfig;
  /** Device ids allowed to drive this computer. Empty = every paired device. */
  allow?: string[];
  readOnly?: boolean;
  runtimeSessions?: RuntimeSessions;
  runtimeOnly?: boolean;
  /** Optional owned local CONNECT agent for the authenticated relay WebSocket only. */
  relayAgent?: HttpsAgent;
  log?: (msg: string) => void;
}

/**
 * Runs on each computer: publishes its herdr agents to the relay and answers
 * rpc calls from phones and other computers.
 */
export class Host {
  hc = new HcAdapter();
  herdr = new HerdrAdapter();
  uniflo = new UnifloAdapter();
  /** Session ids running agents name themselves (Claude Code registry, `--resume <id>`). */
  sessionHints = new SessionHints();
  app = new HerdrApp();
  private launchersCache: { at: number; list: ReturnType<typeof installedLaunchers> } | null = null;
  /** Installed programs, re-checked every 10 minutes so a newly installed agent shows up without a restart. */
  private get launchers(): ReturnType<typeof installedLaunchers> {
    if (!this.launchersCache || Date.now() - this.launchersCache.at > 10 * 60_000) {
      const list = installedLaunchers();
      this.launchersCache = { at: Date.now(), list };
      list.catch(() => {
        if (this.launchersCache?.list === list) this.launchersCache = null;
      });
    }
    return this.launchersCache.list;
  }
  sources: HostSource[] = [];
  agents: Agent[] = [];
  deviceId = "";

  /** Everything the relay knows (all devices, all hosts' agents). */
  devices = new Map<string, Device>();
  remoteAgents = new Map<string, Agent[]>();

  private ws: WebSocket | null = null;
  private calls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private callSeq = 0;
  private streamStops = new Map<string, () => void>();
  private streamMeta = new Map<string, { from: string; kind: "terminal" | "session"; agent: string }>();
  private sendQueues = new Map<string, Array<{ id: string; text: string; enter: boolean }>>();
  private queueSeq = 0;
  private stopped = false;
  private backoff = 1000;
  /** How often the relay link is pinged; a ping still unanswered at the next one drops the link. */
  heartbeatMs = 30_000;
  private lastPublished = "";
  private log: (msg: string) => void;
  private opts: HostOptions;
  private publish = debounce(() => this.publishNow(), 300);
  /** Space and tab names from the desktop app; the last good copy is kept while its window is closed. */
  private names: AppNames | undefined;
  private namesSig = "";
  private namesTimer: NodeJS.Timeout | null = null;
  /** Text typed into busy agents that their programs have not taken yet. */
  waits = new InputWaits();
  private waitTimer: NodeJS.Timeout | null = null;
  /** This computer's own log lines, uploaded to the relay every minute. */
  logs = new LogBuffer();
  private logTimer: NodeJS.Timeout | null = null;
  /** How often the log ring is uploaded. */
  logEveryMs = 60_000;
  /** How long agent.create waits for a program before typing its first task (tests shorten it). */
  firstTaskOptions: TypeTaskOptions = {};
  /** Where pictures for agents of the herdr terminal app are kept (tests point it elsewhere). */
  filesDir = FILES_DIR;
  private runtimeAgents: Agent[] = [];
  private runtimeTimer: NodeJS.Timeout | null = null;
  private runtimeState = new Map<string, RuntimeAgentState>();
  private runtimeEventSeq = new RuntimeEventSeqTracker();
  private runtimeRefreshLock: Promise<void> | null = null;

  constructor(opts: HostOptions) {
    this.opts = opts;
    const out = opts.log ?? ((m: string) => console.log(`[hostd] ${m}`));
    // Every plain line also goes to the relay's log, so trouble here can be seen from there.
    this.log = (m) => {
      out(m);
      this.logs.push(levelOf(m), "hostd", m);
    };
    this.deviceId = opts.config.deviceId;
  }

  /** A structured line for the relay's log (not printed). */
  note(level: "info" | "warn" | "error", kind: string, msg: string, data?: Record<string, unknown>): void {
    this.logs.push(level, kind, msg, data);
  }

  /** Sends what the ring holds, at most a few batches at a time. */
  flushLogs(): void {
    for (let i = 0; i < 5 && this.logs.size && this.connected; i++) {
      const entries = this.logs.take(200);
      this.send({ type: "log", entries });
    }
  }

  async start(): Promise<void> {
    const [hc, herdr, uniflo] = this.opts.runtimeOnly ? [false, false, false] : await Promise.all([this.hc.available(), this.herdr.available(), this.uniflo.available()]);
    if (hc) {
      this.sources.push("hc");
      this.hc.on("change", this.publish);
      this.hc.start();
      void this.refreshNames();
      this.namesTimer = setInterval(() => void this.refreshNames(), 15_000);
    }
    if (herdr) {
      this.sources.push("herdr");
      this.herdr.on("change", this.publish);
      this.herdr.start();
    }
    if (uniflo) {
      this.sources.push("uniflo");
      this.uniflo.start(this.publish);
    }
    this.log(
      `sources: herdr GUI core (hc) ${hc ? `✓ ${this.hc.version ?? ""}` : "✗"} · herdr TUI ${herdr ? "✓" : "✗"} · uniflo ${uniflo ? "✓" : "✗"}`,
    );
    if (this.opts.runtimeSessions) {
      this.sources.push("runtime-sessions", "runtime-detail");
      if (this.opts.runtimeSessions.hasDirectory) this.sources.push("dsh-directory");
      if (this.opts.runtimeSessions.publishAgents) {
        if (this.opts.runtimeSessions.hasCreate && !this.opts.readOnly) this.sources.push("runtime-create");
        await this.refreshRuntimeAgents();
        this.runtimeTimer = setInterval(() => void this.refreshRuntimeAgents(), 4000);
        this.runtimeTimer.unref?.();
      }
      if (this.opts.runtimeSessions.localVoice?.enabled) this.sources.push("local-voice");
    }
    if (!hc && !herdr && !this.opts.runtimeSessions) this.log("no herdr runtime found: start the herdr app (hc) or `herdr` first. Waiting anyway.");
    this.logTimer = setInterval(() => this.flushLogs(), this.logEveryMs);
    this.logTimer.unref?.();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.namesTimer) clearInterval(this.namesTimer);
    if (this.runtimeTimer) clearInterval(this.runtimeTimer);
    if (this.logTimer) clearInterval(this.logTimer);
    if (this.waitTimer) clearInterval(this.waitTimer);
    this.flushLogs();
    this.hc.stop();
    this.herdr.stop();
    this.uniflo.stop();
    this.opts.runtimeSessions?.close();
    for (const stop of this.streamStops.values()) stop();
    this.streamStops.clear();
    this.streamMeta.clear();
    this.ws?.close();
    this.opts.relayAgent?.destroy();
  }

  // -------------------------------------------------------------------------

  async refreshRuntimeAgents(): Promise<void> {
    const view = this.opts.runtimeSessions;
    if (!view?.publishAgents || this.stopped) return;
    if (this.runtimeRefreshLock) return this.runtimeRefreshLock;
    this.runtimeRefreshLock = (async () => {
      try {
        const entries = await view.unifiedEntries();
        const now = Date.now();
        const seen = new Set<string>();
        const next: Agent[] = [];
        for (const entry of entries) {
          const localId = encodeRuntimeLocalId(entry.runtime, entry.projectId, entry.session.id);
          seen.add(localId);
          const state = nextRuntimeState(this.runtimeState.get(localId), entry.session.state, now, entry.session.updatedAt);
          this.runtimeState.set(localId, state);
          const canSend = !this.opts.readOnly && entry.sendConfigured;
          const readOnlyReason = this.opts.readOnly
            ? "这台电脑当前为只读模式。"
            : !canSend
              ? (entry.runtime === "antigravity"
                ? "Antigravity 会话当前处于只读状态或运行中，暂不支持发送消息。"
                : "当前会话处于只读状态，仅支持查看消息记录。")
              : undefined;
          next.push({
            key: agentKey(this.deviceId, "runtime", localId),
            deviceId: this.deviceId,
            source: "runtime",
            localId,
            harness: entry.runtime,
            title: entry.session.title,
            where: entry.projectTitle,
            status: state.status,
            statusSince: state.since,
            ...(state.turn > 0 ? { turn: state.turn } : {}),
            isShell: false,
            sessionKey: encodeRuntimeSessionKey(entry.runtime, entry.projectId, entry.session.id),
            canSend,
            ...(readOnlyReason ? { readOnlyReason } : {}),
            updatedAt: entry.session.updatedAt ?? state.since,
          });
        }
        for (const localId of [...this.runtimeState.keys()]) {
          if (!seen.has(localId)) this.runtimeState.delete(localId);
        }
        this.runtimeAgents = next;
        this.publish();
      } catch {
        /* keep last published snapshot while one runtime poll is busy */
      } finally {
        this.runtimeRefreshLock = null;
      }
    })();
    return this.runtimeRefreshLock;
  }

  /** Re-reads the desktop app's space and tab names (a rename there does not always reach hc). */
  private async refreshNames(): Promise<void> {
    let names: AppNames;
    try {
      names = await this.app.names();
    } catch {
      return; // window closed: keep what we have, `where` labels cover the rest
    }
    const sig = JSON.stringify([[...names.spaces], [...names.tabs]]);
    if (sig === this.namesSig) return;
    this.namesSig = sig;
    this.names = names;
    this.publish();
  }

  collect(): Agent[] {
    const id = this.deviceId;
    const pids = new Map<string, number | undefined>();
    const hints = new Map<string, string>();
    const live = new Set<number>();
    const agents: Agent[] = [];
    for (const t of this.hc.terminals.values()) {
      const a = HcAdapter.toAgent(t, id, this.names);
      const pid = t.foreground?.pid;
      pids.set(a.key, pid);
      if (pid) live.add(pid);
      const hint = a.isShell ? undefined : this.sessionHints.key(harnessId(a.harness), t.foreground?.argv, pid);
      if (hint) hints.set(a.key, hint);
      agents.push(a);
    }
    this.sessionHints.prune(live);
    for (const info of this.herdr.agents) agents.push(HerdrAdapter.toAgent(info, id));
    for (const a of this.runtimeAgents) {
      agents.push({ ...a, deviceId: id, key: agentKey(id, "runtime", a.localId) });
    }
    return this.waits.decorate(this.uniflo.enrich(agents, pids, hints));
  }

  private publishNow(): void {
    this.agents = this.collect();
    const data = JSON.stringify(this.agents.map((a) => ({ ...a, updatedAt: 0 })));
    if (data === this.lastPublished) return;
    this.lastPublished = data;
    this.send({ type: "agents", agents: this.agents });
  }

  // -------------------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;
    const { server, token } = this.opts.config;
    const url = `${server.replace(/^http/, "ws").replace(/\/+$/, "")}/v1/ws`;
    // A handshake that never gets an answer must not wait forever either.
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 15_000,
      ...(this.opts.relayAgent ? { agent: this.opts.relayAgent } : {}),
      ...(this.opts.runtimeSessions || this.opts.relayAgent ? { rejectUnauthorized: true } : {}),
    });
    this.ws = ws;
    const runtime = this.opts.runtimeSessions;
    let taskCapability = false;
    let taskSnapshot = false;
    let taskTimer: NodeJS.Timeout | undefined;
    const reports = runtime?.hasTaskEvents && !this.opts.readOnly ? new RuntimeTaskReporter(
      () => runtime.taskEvents(),
      (event) => ws.send(JSON.stringify({ type: "runtime_task_event", event } satisfies ClientFrame)),
      () => {
        if (!taskCapability || !taskSnapshot || this.stopped || this.ws !== ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 64 * 1024 ||
            (this.opts.allow?.length && !this.opts.allow.includes(runtime.viewerId))) return false;
        try { this.runtimeAccess(runtime.viewerId); return true; } catch { return false; }
      },
    ) : undefined;
    // The relay can vanish without a close (server restart behind a proxy, sleep, network
    // switch): a ping that goes unanswered for a whole interval drops the socket so it reconnects.
    let alive = true;
    const beat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        this.log("relay stopped answering, reconnecting");
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, this.heartbeatMs);
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("open", () => {
      this.backoff = 1000;
      this.log(`connected to ${server}`);
      this.send({
        type: "hello",
        version: PROTOCOL_VERSION,
        platform: platform(),
        sources: this.sources,
        appVersion: HOSTD_VERSION,
      });
      this.lastPublished = "";
      this.publishNow();
      // What happened while the link was down goes up first.
      this.flushLogs();
    });
    ws.on("message", (data) => {
      if (this.ws !== ws || this.stopped) return;
      alive = true;
      let f: ServerFrame;
      try {
        f = JSON.parse(data.toString()) as ServerFrame;
      } catch {
        return;
      }
      if (f.type === "welcome") {
        this.deviceId = f.device.id;
        taskCapability = f.runtimeTaskNotices === true && f.device.kind === "host" && f.device.id === this.opts.config.deviceId;
        if (taskCapability && reports && !taskTimer) {
          taskTimer = setInterval(() => void reports.tick(), 3_000);
          taskTimer.unref();
        }
      } else if (f.type === "runtime_task_ack") reports?.ack(f.eventId);
      else if (f.type === "rpc") void this.handleRpc(f);
      else if (f.type === "stream_subscribe") void this.handleStreamSubscribe(f);
      else if (f.type === "stream_unsubscribe") this.stopStream(f.id);
      else if (f.type === "snapshot") {
        this.devices = new Map(f.devices.map((d) => [d.id, d]));
        this.remoteAgents = new Map();
        for (const a of f.agents) this.remoteAgents.set(a.deviceId, [...(this.remoteAgents.get(a.deviceId) ?? []), a]);
        taskSnapshot = true;
        void reports?.tick();
      } else if (f.type === "device") this.devices.set(f.device.id, f.device);
      else if (f.type === "device_removed") {
        this.devices.delete(f.id);
        this.remoteAgents.delete(f.id);
      } else if (f.type === "agents") this.remoteAgents.set(f.deviceId, f.agents);
      else if (f.type === "rpc_result") {
        const c = this.calls.get(f.id);
        if (!c) return;
        clearTimeout(c.timer);
        this.calls.delete(f.id);
        if (f.error) c.reject(new Error(`${f.error.code}: ${f.error.message}`));
        else c.resolve(f.result);
      }
      else if (f.type === "error") this.log(`relay error: ${f.error.message}`);
    });
    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) {
        this.log("relay rejected this computer's token (revoked?). Run `xiaoaixiaoai login` again.");
        this.stopped = true;
      } else {
        this.log(`relay answered ${res.statusCode}`);
      }
      // With this listener attached, `ws` no longer aborts the handshake on its own: a 502 from
      // the proxy while the relay restarted left the socket connecting forever, never retrying.
      ws.terminate();
    });
    ws.on("close", (code) => {
      clearInterval(beat);
      if (taskTimer) clearInterval(taskTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      for (const stop of this.streamStops.values()) stop();
      this.streamStops.clear();
      this.streamMeta.clear();
      if (code === 4001) {
        this.log("this computer was removed from the relay. Run `xiaoaixiaoai login` to pair again.");
        this.stopped = true;
      }
      if (this.stopped) return;
      this.log(`disconnected, retrying in ${Math.round(this.backoff / 1000)}s`);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
    ws.on("error", () => {});
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Calls a method on another computer through the relay. */
  call<M extends RpcMethod>(to: string, method: M, params: RpcMethods[M]["params"], timeoutMs = 35_000): Promise<RpcMethods[M]["result"]> {
    if (!this.connected) return Promise.reject(new Error("offline: not connected to the relay"));
    const id = `h${++this.callSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error("timeout"));
      }, timeoutMs);
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ type: "rpc", id, to, method, params });
    });
  }

  private send(f: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(f));
  }

  // -------------------------------------------------------------------------

  private isAllowedCaller(from: string): boolean {
    const allow = this.opts.allow ?? [];
    if (!allow.length || allow.includes(from)) return true;
    if (from === "relay" && (allow.includes("assistant") || allow.includes("relay") || this.opts.runtimeSessions?.allowAssistant === true)) {
      return true;
    }
    return false;
  }

  private runtimeTargetOf(a: Agent): { runtime: SessionRuntime; projectId: string; sessionId: string } {
    const parsed = parseRuntimeTarget(a.localId);
    if (!parsed) throw new RpcFailure("not_found", "找不到对应的项目会话。");
    return parsed;
  }

  private async runtimeDetailForTarget(
    from: string,
    target: { runtime: SessionRuntime; projectId: string; sessionId: string },
    limit: number,
  ): Promise<{
    sessionKey: string;
    detail: RuntimeSessionDetail;
    events: ConvEvent[];
    canSend: boolean;
    readOnlyReason?: string;
  }> {
    const view = this.runtimeAccess(from);
    const detail = await view.detail({
      runtime: target.runtime,
      projectId: target.projectId,
      sessionId: target.sessionId,
      limit: Math.min(Math.max(limit || 60, 1), 100),
    });
    if (this.opts.readOnly) {
      detail.session.canSend = false;
      detail.pendingQuestions = detail.pendingQuestions.map((q) => ({ ...q, state: "readonly" as const }));
      detail.readOnlyReason ??= "这台电脑当前为只读模式。";
    }
    const sessionKey = encodeRuntimeSessionKey(target.runtime, target.projectId, target.sessionId);
    const events = this.runtimeEventSeq.toConvEvents(sessionKey, detail);
    const canSend =
      !this.opts.readOnly &&
      (detail.session.canSend || detail.pendingQuestions.some((q) => q.state !== "readonly"));
    const readOnlyReason = !canSend
      ? (detail.readOnlyReason ?? "当前会话处于只读状态，仅支持查看消息记录。")
      : undefined;
    return { sessionKey, detail, events, canSend, ...(readOnlyReason ? { readOnlyReason } : {}) };
  }

  private async handleRpc(f: Extract<ServerFrame, { type: "rpc" }>): Promise<void> {
    try {
      if (!this.isAllowedCaller(f.from)) throw new RpcFailure("forbidden", "这台电脑没有授权给你");
      if (this.opts.runtimeOnly) {
        const baseAllowed = ["runtimeSessions.list", "runtimeSessions.browse", "runtimeSessions.detail", "runtimeSessions.answer", "runtimeSessions.send", "host.info", "agents.list"];
        const publishAllowed = this.opts.runtimeSessions?.publishAgents === true
          ? ["session.events", "session.children", "agent.seen", "terminal.read", "terminal.send", "terminal.interrupt", "spaces.list", "agent.create"]
          : [];
        const assistantAllowed = f.from === "relay" && this.opts.runtimeSessions?.allowAssistant === true
          ? ["sessions.list", "sessions.search", "sessions.read", "sessions.usage", "spaces.list", "agent.create", "terminal.interrupt"]
          : [];
        const voiceAllowed = f.from === "relay" && this.opts.runtimeSessions?.localVoice?.enabled === true
          ? ["voice.warmup", "voice.transcribe", "voice.synthesize", "voice.cancel", "voice.release"]
          : [];
        if (!baseAllowed.includes(f.method) && !publishAllowed.includes(f.method) && !assistantAllowed.includes(f.method) && !voiceAllowed.includes(f.method)) {
          throw new RpcFailure("unsupported", "这台电脑仅提供共享的项目会话，不开放终端。");
        }
      }
      const handler = (this.handlers as Record<string, Handler<any> | undefined>)[f.method];
      if (!handler) throw new RpcFailure("unsupported", `unknown method ${f.method}`);
      const result = await handler((f.params ?? {}) as never, f.from);
      this.send({ type: "rpc_result", id: f.id, result });
      if (MUTATING.has(f.method)) this.note("info", "rpc", `${f.method} from ${this.who(f.from)} ok`, f.method.startsWith("runtimeSessions.") ? undefined : callSummary(f.params, result));
    } catch (e) {
      const error: RpcError =
        e instanceof RpcFailure || e instanceof RuntimeError
          ? { code: e.code, message: e.message }
          : { code: "internal", message: e instanceof Error ? e.message : String(e) };
      this.send({ type: "rpc_result", id: f.id, error });
      // Reads that find nothing are normal; anything else failing is worth a line.
      const quiet = error.code === "not_found" && !MUTATING.has(f.method);
      if (!quiet) this.note(error.code === "internal" ? "error" : "warn", "rpc", `${f.method} from ${this.who(f.from)} failed: ${error.code}: ${error.message}`, typeof f.method === "string" && f.method.startsWith("runtimeSessions.") ? undefined : callSummary(f.params));
    }
  }

  private sendStream(id: string, event: unknown): void {
    this.send({ type: "stream_event", id, event });
  }

  private async handleStreamSubscribe(f: Extract<ServerFrame, { type: "stream_subscribe" }>): Promise<void> {
    if (!this.isAllowedCaller(f.from)) {
      this.send({ type: "stream_open", id: f.id, error: { code: "forbidden", message: "这台电脑没有授权给你" } });
      return;
    }
    if (this.opts.runtimeOnly && this.opts.runtimeSessions?.publishAgents !== true) {
      this.send({ type: "stream_open", id: f.id, error: { code: "unsupported", message: "这台电脑仅提供共享的项目会话，不开放终端。" } });
      return;
    }
    const p = (f.params ?? {}) as Record<string, unknown>;
    const agentName = p.agent;
    try {
      const a = this.resolve(agentName);
      if (this.opts.runtimeOnly && a.source !== "runtime") {
        throw new RpcFailure("unsupported", "这台电脑仅提供共享的项目会话，不开放终端。");
      }
      const prev = this.streamMeta.get(f.id);
      if (prev && prev.from !== f.from) throw new RpcFailure("bad_request", "重复的流 id");
      // The same viewer again (it reconnected through a relay that did not end the old one): the new one replaces it.
      if (prev) this.stopStream(f.id);
      const meta = { from: f.from, kind: f.stream, agent: a.key };
      this.streamMeta.set(f.id, meta);
      if (a.source === "runtime") {
        this.runtimeAccess(f.from);
        const target = this.runtimeTargetOf(a);
        if (f.stream === "terminal") {
          if (p.screen !== false) {
            const { detail } = await this.runtimeDetailForTarget(f.from, target, 40);
            const text = formatRuntimeTerminalText(a, detail);
            const paint = this.terminalPainter(f.id, p.rows === true);
            paint({ lines: text.split("\n"), text, cols: 0, rows: 0 });
          }
          if (this.streamMeta.get(f.id) !== meta) return;
          this.streamStops.set(f.id, () => undefined);
          this.send({ type: "stream_open", id: f.id, result: { kind: "terminal", agent: a.key } });
          return;
        }
        if (typeof p.sub === "string" && p.sub) throw new RpcFailure("not_found", "这个会话没有子对话");
        let stopped = false;
        const seen = new Map<string, string>();
        let busy = false;
        let failing = false;
        let initialized = false;
        const tick = async () => {
          if (stopped || busy) return;
          busy = true;
          try {
            const { events } = await this.runtimeDetailForTarget(f.from, target, 60);
            if (failing) {
              failing = false;
              this.sendStream(f.id, { kind: "alive", at: Date.now() });
            }
            let added = false;
            for (const e of events) {
              const sig = JSON.stringify({ kind: e.kind, text: "text" in e ? e.text : undefined, output: "output" in e ? e.output : undefined, is_error: "is_error" in e ? e.is_error : undefined });
              if (seen.get(e.id) === sig) continue;
              seen.set(e.id, sig);
              if (seen.size > 2000) seen.delete(seen.keys().next().value!);
              this.sendStream(f.id, { kind: "session", event: e, at: Date.now() });
              added = true;
            }
            if (initialized && added) void this.refreshRuntimeAgents();
            initialized = true;
          } catch (e) {
            if (!failing) this.sendStream(f.id, { kind: "stale", message: (e as Error).message, at: Date.now() });
            failing = true;
          } finally {
            busy = false;
          }
        };
        const timer = setInterval(() => void tick(), 2000);
        void tick();
        if (this.streamMeta.get(f.id) !== meta) {
          stopped = true;
          clearInterval(timer);
          return;
        }
        this.streamStops.set(f.id, () => {
          stopped = true;
          clearInterval(timer);
        });
        this.send({ type: "stream_open", id: f.id, result: { kind: "session", sessionKey: a.sessionKey ?? encodeRuntimeSessionKey(target.runtime, target.projectId, target.sessionId) } });
        return;
      }
      if (f.stream === "terminal") {
        let stop: () => void = () => undefined;
        // `screen: false`: only queue notices (they go to every terminal stream of the agent).
        if (p.screen !== false) {
          const paint = this.terminalPainter(f.id, p.rows === true);
          const onError = (error: Error) => this.sendStream(f.id, { kind: "stale", message: error.message, at: Date.now() });
          if (a.source === "hc") {
            const history = Math.min(Math.max(Number(p.history ?? 120) || 120, 0), 600);
            stop = await this.hc.watch(a.localId, history, paint, onError, { text: p.rows !== true });
          } else {
            let busy = false;
            const tick = async () => {
              if (busy) return;
              busy = true;
              try {
                const r = a.source === "herdr" ? await this.herdr.read(a.localId, 400) : null;
                if (r) paint({ lines: (r.ansi ?? r.text).split("\n"), text: r.text, cols: 0, rows: 0 });
              } catch (e) {
                onError(e as Error);
              } finally {
                busy = false;
              }
            };
            const timer = setInterval(() => void tick(), 500);
            void tick();
            stop = () => clearInterval(timer);
          }
        }
        // Unsubscribed (or replaced) while the watch was starting.
        if (this.streamMeta.get(f.id) !== meta) {
          stop();
          return;
        }
        this.streamStops.set(f.id, stop);
        this.send({ type: "stream_open", id: f.id, result: { kind: "terminal", agent: a.key } });
        return;
      }
      const sessionKey = await this.sessionOf(a.key, p.sub);
      if (!sessionKey) throw new RpcFailure("not_found", "这个 agent 没有对话会话");
      let stopped = false;
      const seen = new Map<string, string>();
      let busy = false;
      let failing = false;
      const tick = async () => {
        if (stopped || busy) return;
        busy = true;
        try {
          // The viewer loads the page itself; the stream only has to carry what is new.
          const r = await this.uniflo.events(sessionKey, 40);
          if (failing) {
            failing = false;
            this.sendStream(f.id, { kind: "alive", at: Date.now() });
          }
          for (const e of r.events) {
            const sig = JSON.stringify(e);
            if (seen.get(e.id) === sig) continue;
            seen.set(e.id, sig);
            if (seen.size > 2000) seen.delete(seen.keys().next().value!);
            this.sendStream(f.id, { kind: "session", event: e, at: Date.now() });
          }
        } catch (e) {
          if (!failing) this.sendStream(f.id, { kind: "stale", message: (e as Error).message, at: Date.now() });
          failing = true;
        } finally {
          busy = false;
        }
      };
      const timer = setInterval(() => void tick(), 250);
      void tick();
      this.streamStops.set(f.id, () => {
        stopped = true;
        clearInterval(timer);
      });
      this.send({ type: "stream_open", id: f.id, result: { kind: "session", sessionKey } });
    } catch (e) {
      const error: RpcError = e instanceof RpcFailure ? { code: e.code, message: e.message } : { code: "internal", message: String(e) };
      this.streamMeta.delete(f.id);
      this.send({ type: "stream_open", id: f.id, error });
      if (error.code !== "not_found") this.note("warn", "stream", `${f.stream} stream for ${String(agentName)} failed: ${error.code}: ${error.message}`);
    }
  }

  /**
   * Sends a terminal's paints on stream `id`, unchanged ones skipped. `rows`:
   * as `terminal_rows` changes (only what moved or changed); else a whole
   * `terminal` screen each time, for apps before that.
   */
  private terminalPainter(id: string, rows: boolean): (paint: ScreenLines) => void {
    let last: string[] | null = null;
    let lastText: string | undefined;
    let seq = 0;
    return ({ lines, text, cols, rows: height }) => {
      if (!rows) {
        const same = last && text === lastText && last.length === lines.length && lines.every((l, i) => l === last![i]);
        if (same) return;
        last = lines;
        lastText = text;
        const screen = { ansi: lines.join("\n"), text: text ?? "", ...(cols ? { cols, rows: height } : {}) };
        this.sendStream(id, { kind: "terminal", screen, at: Date.now() });
        return;
      }
      const change = rowsChange(last, lines);
      if (!change) return;
      last = lines;
      const event: TerminalRowsEvent = { kind: "terminal_rows", seq: ++seq, cols, rows: height, ...change, at: Date.now() };
      this.sendStream(id, event);
    };
  }

  private stopStream(id: string): void {
    this.streamStops.get(id)?.();
    this.streamStops.delete(id);
    this.streamMeta.delete(id);
  }

  private queueEvent(agent: string, event: unknown): void {
    for (const [id, meta] of this.streamMeta) {
      if (meta.kind === "terminal" && meta.agent === agent) this.sendStream(id, { kind: "queue", ...event as Record<string, unknown>, at: Date.now() });
    }
  }

  private enqueueSend(a: Agent, text: string, enter: boolean): { id: string; position: number } {
    const id = `q${Date.now().toString(36)}${(++this.queueSeq).toString(36)}`;
    const q = this.sendQueues.get(a.key) ?? [];
    const position = q.length;
    q.push({ id, text, enter });
    this.sendQueues.set(a.key, q);
    this.queueEvent(a.key, { queueId: id, status: "queued", position });
    if (q.length === 1) void this.drainSendQueue(a);
    return { id, position };
  }

  private async dispatchRuntimeQueueItem(a: Agent, text: string): Promise<void> {
    const view = this.opts.runtimeSessions;
    if (!view) throw new RpcFailure("unsupported", "电脑端没有开启项目会话连接。");
    const target = this.runtimeTargetOf(a);
    let pending: RuntimeSessionDetail["pendingQuestions"] = [];
    try {
      const detail = await view.detail({ runtime: target.runtime, projectId: target.projectId, sessionId: target.sessionId, limit: 10 });
      pending = detail.pendingQuestions;
    } catch {
      pending = [];
    }
    const actionable = pending.find((pq) => pq.state !== "readonly" && pq.questions.length === 1);
    if (actionable) {
      await view.answer({
        runtime: target.runtime,
        projectId: target.projectId,
        sessionId: target.sessionId,
        requestId: randomUUID(),
        callId: actionable.callId,
        answers: [matchQuestionAnswer(actionable.questions[0]!, text)],
      });
      void this.refreshRuntimeAgents();
      return;
    }
    try {
      await view.send({ runtime: target.runtime, projectId: target.projectId, sessionId: target.sessionId, requestId: randomUUID(), input: text });
      void this.refreshRuntimeAgents();
      return;
    } catch (e) {
      if (!(e instanceof RuntimeError && e.code === "not_found" && (target.runtime === "codex" || target.runtime === "antigravity"))) throw e;
    }
    // Codex local runtime rejects `thread/resume` writes while an active turn is still in progress: wait briefly until idle.
    const deadline = Date.now() + 180_000;
    while (!this.stopped && this.sendQueues.has(a.key) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      let detail: RuntimeSessionDetail;
      try {
        detail = await view.detail({ runtime: target.runtime, projectId: target.projectId, sessionId: target.sessionId, limit: 2 });
      } catch {
        continue;
      }
      if (detail.session.canSend) {
        await view.send({ runtime: target.runtime, projectId: target.projectId, sessionId: target.sessionId, requestId: randomUUID(), input: text });
        void this.refreshRuntimeAgents();
        return;
      }
      if (detail.session.state !== "running" && detail.session.state !== "attention") {
        throw new RuntimeError("forbidden", detail.readOnlyReason ?? "当前会话已转为只读状态，未能发送消息。");
      }
    }
    throw new RuntimeError("timeout", "等待上一轮结束超时，消息未发送。");
  }

  private async drainSendQueue(a: Agent): Promise<void> {
    const q = this.sendQueues.get(a.key);
    if (!q) return;
    while (q.length) {
      const item = q[0]!;
      this.queueEvent(a.key, { queueId: item.id, status: "sending", position: 0 });
      try {
        if (a.source === "runtime") await this.dispatchRuntimeQueueItem(a, item.text);
        else if (a.source === "hc") await this.hc.send(a.localId, item.text, item.enter);
        else await this.herdr.send(a.localId, item.text, item.enter);
        this.queueEvent(a.key, { queueId: item.id, status: "sent", position: 0 });
      } catch (e) {
        this.queueEvent(a.key, { queueId: item.id, status: "failed", position: 0, message: (e as Error).message });
      }
      q.shift();
      for (let i = 0; i < q.length; i++) this.queueEvent(a.key, { queueId: q[i]!.id, status: "queued", position: i });
    }
    this.sendQueues.delete(a.key);
  }

  /** Checks every few seconds whether busy agents have taken what was typed into them. */
  private watchWaits(): void {
    if (this.waitTimer) return;
    let busy = false;
    this.waitTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const screen = async (a: Agent) =>
          a.source === "hc" && !this.sendQueues.has(a.key) ? (await this.hc.read(a.localId, 0)).text : undefined;
        const events = async (key: string) => {
          const target = parseRuntimeTarget(key);
          if (target && this.opts.runtimeSessions) {
            const detail = await this.opts.runtimeSessions.detail({ runtime: target.runtime, projectId: target.projectId, sessionId: target.sessionId, limit: 20 });
            return this.runtimeEventSeq.toConvEvents(key, detail);
          }
          return (await this.uniflo.events(key, 15)).events;
        };
        if (await this.waits.settle(this.agents, events, Date.now(), screen)) this.publish();
      } finally {
        busy = false;
      }
      if (!this.waits.size && this.waitTimer) {
        clearInterval(this.waitTimer);
        this.waitTimer = null;
      }
    }, 3000);
    this.waitTimer.unref?.();
  }

  /** A caller's name for the log. */
  private who(from: string): string {
    return from === "relay" ? "assistant" : (this.devices.get(from)?.name ?? from);
  }

  /** Accepts a full agent key or a bare local id (t42) on this host. */
  private resolve(agent: unknown): Agent {
    if (typeof agent !== "string" || !agent) throw new RpcFailure("bad_request", "agent is required");
    const parsed = parseAgentKey(agent);
    if (parsed && parsed.deviceId !== this.deviceId) throw new RpcFailure("not_found", "这个 agent 不在这台电脑上");
    const found = this.agents.find((a) => (parsed ? a.key === agent : a.localId === agent));
    if (!found) throw new RpcFailure("not_found", "找不到这个 agent，可能已经关掉了");
    return found;
  }

  /**
   * Session to read for an agent: its own, or `sub` when that subagent session
   * really descends from it, so a viewer cannot read arbitrary sessions.
   */
  private async sessionOf(agent: unknown, sub: unknown): Promise<string | null> {
    const a = this.resolve(agent);
    if (!a.sessionKey) return null;
    if (sub === undefined || sub === null || sub === "") return a.sessionKey;
    if (typeof sub !== "string") throw new RpcFailure("bad_request", "sub must be a session key");
    let ok = false;
    try {
      ok = await this.uniflo.descends(sub, a.sessionKey);
    } catch {
      ok = false;
    }
    if (!ok) throw new RpcFailure("forbidden", "这个子会话不属于这个 agent");
    return sub;
  }

  /** Folders worth offering for a new agent: spaces', live agents', recent sessions'. */
  private suggestFolders(extra: Array<string | undefined>): string[] {
    const home = homedir();
    const seen = new Set<string>();
    const out: string[] = [];
    const recent = [...this.uniflo.sessions].sort((a, b) => b.updated_at - a.updated_at).map((s) => s.cwd);
    for (const f of [...extra, ...this.agents.map((a) => a.cwd), ...recent]) {
      if (!f || seen.has(f) || f === "/") continue;
      seen.add(f);
      try {
        checkFolder(f);
      } catch {
        continue;
      }
      out.push(f.startsWith(home) ? `~${f.slice(home.length)}` : f);
      if (out.length >= 16) break;
    }
    return out;
  }

  private writable(): void {
    if (this.opts.readOnly) throw new RpcFailure("forbidden", "这台电脑开了只读模式");
  }

  /**
   * Whole-computer session access (any session, not only a live agent's) is for
   * the assistant on the relay; phones and other computers keep `session.events`.
   */
  private assistantOnly(from: string): void {
    if (from !== "relay") throw new RpcFailure("forbidden", "只有助理可以查这台电脑的全部会话");
    if (!this.sources.includes("uniflo") && this.opts.runtimeSessions?.allowAssistant !== true) {
      throw new RpcFailure("unsupported", "这台电脑没有运行 Uniflo，查不了会话记录");
    }
  }

  /**
   * A new terminal through the desktop app; where there is none (herdr-core alone, as on
   * Windows or a server) one of hc's own, outside any space. `direct` says which it was.
   */
  private async newTerminal(
    viaApp: () => Promise<{ space: string; tab: string; terminal: string }>,
    argv: string[],
    folder: string | undefined,
  ): Promise<{ space: string; tab: string; terminal: string; direct: boolean }> {
    try {
      return { ...(await viaApp()), direct: false };
    } catch (e) {
      if (!(e instanceof NoDesktopApp)) throw new RpcFailure("unsupported", (e as Error).message);
    }
    try {
      const terminal = await this.hc.spawnTerminal(argv, folder ?? checkFolder("~"));
      this.note("info", "create", `no desktop herdr here: started ${argv[0] ? base(argv[0]) : "a shell"} as ${terminal} with hc run`);
      return { space: "", tab: "", terminal, direct: true };
    } catch (e) {
      throw new RpcFailure("unsupported", (e as Error).message);
    }
  }

  private needApp(): void {
    if (!this.sources.includes("hc")) throw new RpcFailure("unsupported", "这台电脑没有装桌面 herdr");
  }

  private async installed(): Promise<string[]> {
    return (await this.launchers).map((l) => l.id);
  }

  private runtimeAccess(from: string): RuntimeSessions {
    const view = this.opts.runtimeSessions;
    if (!view) throw new RpcFailure("unsupported", "电脑端没有开启项目会话连接。");
    const relay = new URL(this.opts.config.server);
    if (relay.protocol !== "https:" && !(relay.protocol === "http:" && relay.hostname === "127.0.0.1")) {
      throw new RpcFailure("forbidden", "项目会话只允许经过 HTTPS 中转或本机测试中转。");
    }
    if (from === "relay" && view.allowAssistant === true) return view;
    // The relay derives `from` from the authenticated connection, never client parameters.
    if (from !== view.viewerId || this.devices.get(from)?.kind !== "viewer") throw new RpcFailure("forbidden", "这部手机没有获得项目会话授权。");
    return view;
  }

  private handlers: { [M in RpcMethod]: Handler<M> } = {
    "runtimeSessions.list": async (p, from) => {
      const view = this.runtimeAccess(from);
      if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).length) throw new RpcFailure("bad_request", "项目目录不接受其他参数。");
      const data = await view.list();
      if (this.opts.readOnly) for (const project of data.projects) for (const session of project.sessions) session.canSend = false;
      return data;
    },
    "runtimeSessions.browse": async (p, from) => {
      const data = await this.runtimeAccess(from).browse(p);
      if (this.opts.readOnly && data.view !== "projects") for (const entry of data.entries) entry.session.canSend = false;
      return data;
    },
    "runtimeSessions.detail": async (p, from) => {
      const data = await this.runtimeAccess(from).detail(p);
      if (this.opts.readOnly) {
        data.session.canSend = false;
        data.pendingQuestions = data.pendingQuestions.map((q) => ({ ...q, state: "readonly" as const }));
        data.readOnlyReason ??= "这台电脑当前为只读模式。";
      }
      return data;
    },
    "runtimeSessions.answer": async (p, from) => {
      const view = this.runtimeAccess(from);
      this.writable();
      return view.answer(p);
    },
    "runtimeSessions.send": async (p, from) => {
      const view = this.runtimeAccess(from);
      this.writable();
      return view.send(p);
    },
    "agents.list": async (p) => {
      this.agents = this.collect();
      return { agents: p.includeShells === false ? this.agents.filter((a) => !a.isShell) : this.agents };
    },
    "terminal.read": async (p, from) => {
      const a = this.resolve(p.agent);
      const lines = Math.min(Math.max(Number(p.lines ?? 200) || 200, 0), 2000);
      if (a.source === "runtime") {
        const { detail } = await this.runtimeDetailForTarget(from, this.runtimeTargetOf(a), Math.min(Math.max(lines, 10), 100));
        return { text: formatRuntimeTerminalText(a, detail), complete: true };
      }
      return a.source === "hc" ? this.hc.read(a.localId, lines) : this.herdr.read(a.localId, lines);
    },
    "terminal.send": async (p, from) => {
      this.writable();
      const a = this.resolve(p.agent);
      if (typeof p.text !== "string" || p.text.length > 20_000) throw new RpcFailure("bad_request", "text is required");
      if (a.source === "runtime") {
        this.runtimeAccess(from);
        if (a.canSend === false) {
          throw new RpcFailure("forbidden", a.readOnlyReason ?? "当前会话仅支持查看，不能发送消息。");
        }
        if (p.text.length > RUNTIME_SESSION_TEXT_LIMIT || /[\uD800-\uDFFF]/u.test(p.text) || p.text.includes("\0") || !p.text.trim()) {
          throw new RpcFailure("bad_request", `消息内容无效或超过 ${RUNTIME_SESSION_TEXT_LIMIT} 字符限制。`);
        }
      }
      const status = a.status;
      const queued = this.enqueueSend(a, p.text, p.enter !== false);
      // In a turn, the program keeps typed text in its input box until the turn ends.
      const waiting = p.enter !== false && status === "working";
      if (waiting) {
        this.waits.add(a.key, queued.id, p.text, Date.now());
        this.watchWaits();
        this.publish();
      }
      const reportedStatus: AgentStatus = a.source === "runtime" && status === "blocked" ? "working" : status;
      return { ok: true as const, queueId: queued.id, position: queued.position, agentStatus: reportedStatus, waiting };
    },
    "terminal.keys": async (p) => {
      this.writable();
      const a = this.resolve(p.agent);
      if (!Array.isArray(p.keys) || !p.keys.length || p.keys.length > 32 || !p.keys.every((k) => typeof k === "string"))
        throw new RpcFailure("bad_request", "keys must be a non-empty list");
      if (a.source === "hc") await this.hc.keys(a.localId, p.keys);
      else await this.herdr.keys(a.localId, p.keys);
      return { ok: true as const };
    },
    "terminal.input": async (p) => {
      this.writable();
      const a = this.resolve(p.agent);
      if (typeof p.data !== "string" || !p.data || p.data.length > 4096) throw new RpcFailure("bad_request", "data is required");
      if (a.source !== "hc") throw new RpcFailure("unsupported", "这个 agent 不是桌面 herdr 开的，只能用输入框发送");
      await this.hc.input(a.localId, p.data);
      return { ok: true as const };
    },
    "terminal.put": async (p) => {
      this.writable();
      const a = this.resolve(p.agent);
      let files: CheckedFile[];
      try {
        files = checkFiles(p.files);
      } catch (e) {
        throw new RpcFailure("bad_request", (e as Error).message);
      }
      try {
        // hc keeps its own copy beside the terminal; the herdr terminal app has no such place, so this computer keeps one.
        const paths = a.source === "hc" ? await putThrough(files, (file) => this.hc.put(a.localId, file)) : await putLocal(files, a.localId, this.filesDir);
        return { paths };
      } catch (e) {
        const msg = (e as Error).message;
        if (/unrecognized subcommand|unknown command/i.test(msg)) throw new RpcFailure("unsupported", "这台电脑的 herdr 太旧，还不能收图片（没有 hc put），更新 herdr 后再试");
        throw new RpcFailure("internal", `图片没能放到这台电脑上：${msg}`);
      }
    },
    "session.events": async (p, from) => {
      const a = this.resolve(p.agent);
      if (a.source === "runtime") {
        if (typeof p.sub === "string" && p.sub) return { sessionKey: null, events: [], more: false, nextBefore: null };
        const res = await this.runtimeDetailForTarget(from, this.runtimeTargetOf(a), p.limit ?? 60);
        return {
          sessionKey: res.sessionKey,
          events: res.events,
          more: false,
          nextBefore: null,
          pendingQuestions: res.detail.pendingQuestions,
          canSend: res.canSend,
          ...(res.readOnlyReason ? { readOnlyReason: res.readOnlyReason } : {}),
        };
      }
      const key = await this.sessionOf(p.agent, p.sub);
      if (!key) return { sessionKey: null, events: [], more: false, nextBefore: null };
      const r = await this.uniflo.events(key, p.limit ?? 80, p.before);
      return { sessionKey: key, events: r.events, more: r.more, nextBefore: r.nextBefore };
    },
    "session.children": async (p) => {
      const a = this.resolve(p.agent);
      if (a.source === "runtime") return { sessions: [] };
      const key = await this.sessionOf(p.agent, p.sub);
      return { sessions: key ? await this.uniflo.children(key) : [] };
    },
    "spaces.list": async () => {
      if (this.opts.runtimeOnly || (!this.sources.includes("hc") && this.opts.runtimeSessions?.publishAgents)) {
        const view = this.opts.runtimeSessions;
        if (!this.opts.readOnly && view?.publishAgents && view.hasCreate) {
          const opts = await view.createOptions();
          if (opts.launchers.length > 0) {
            return {
              spaces: opts.spaces,
              launchers: opts.launchers,
              folders: opts.folders,
              canCreate: true,
              typesTask: true,
              ...(opts.spaces.length === 0 ? { standalone: true } : {}),
            };
          }
        }
        return {
          spaces: [],
          launchers: [],
          folders: [],
          canCreate: false,
          reason: this.opts.readOnly ? "这台电脑开了只读模式" : "当前运行时未开启新建会话授权，可在电脑端 DSH、Codex 或 Antigravity 中直接新建。",
          typesTask: false,
        };
      }
      const launchers = await this.launchers;
      let spaces: Awaited<ReturnType<HerdrApp["spaces"]>> = [];
      let reason: string | undefined;
      let standalone = false;
      if (this.opts.readOnly) reason = "这台电脑开了只读模式";
      else if (!this.sources.includes("hc")) reason = "这台电脑没有装桌面 herdr";
      try {
        spaces = await this.app.spaces();
      } catch (e) {
        // Without the desktop app (Windows, servers) new agents get terminals of their own.
        if (e instanceof NoDesktopApp) standalone = true;
        else reason ??= "桌面 herdr 没有打开，先在电脑上打开它";
      }
      return {
        spaces,
        launchers,
        folders: this.suggestFolders(spaces.map((x) => x.folder)),
        canCreate: !reason,
        reason,
        typesTask: true,
        ...(standalone ? { standalone } : {}),
      };
    },
    "agent.create": async (p, from) => {
      this.writable();
      const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
      if (this.opts.runtimeOnly || (!this.sources.includes("hc") && this.opts.runtimeSessions?.publishAgents)) {
        const view = this.runtimeAccess(from);
        const runtime = p.launcher === "dsh" || p.launcher === "codex" || p.launcher === "antigravity" ? p.launcher : undefined;
        if (!runtime) throw new RpcFailure("bad_request", "这台电脑当前仅支持新建 DSH、Codex 或 Antigravity 会话。");
        let folder: string | undefined;
        try {
          folder = p.folder === undefined || p.folder === "" ? undefined : checkFolder(p.folder);
        } catch (e) {
          throw new RpcFailure("bad_request", (e as Error).message);
        }
        const task = str(p.task, 4000);
        const spaceId = str(p.space, 100);
        const created = await view.createSession({
          runtime,
          ...(spaceId ? { projectId: spaceId } : {}),
          ...(folder ? { cwd: folder } : {}),
          ...(task ? { task } : {}),
        });
        if (this.runtimeRefreshLock) await this.runtimeRefreshLock;
        await this.refreshRuntimeAgents();
        const localId = encodeRuntimeLocalId(created.runtime, created.projectId, created.sessionId);
        return {
          agent: agentKey(this.deviceId, "runtime", localId),
          space: created.projectId,
          terminal: localId,
          ...(task ? { task: "started" as const } : {}),
        };
      }
      if (!this.sources.includes("hc")) throw new RpcFailure("unsupported", "这台电脑没有装桌面 herdr");
      const launcher = typeof p.launcher === "string" ? (await this.launchers).find((l) => l.id === p.launcher) : undefined;
      if (!launcher) throw new RpcFailure("bad_request", "这台电脑上没有这个程序");
      let folder: string | undefined;
      try {
        folder = p.folder === undefined || p.folder === "" ? undefined : checkFolder(p.folder);
      } catch (e) {
        throw new RpcFailure("bad_request", (e as Error).message);
      }
      if (!p.space && !folder) folder = checkFolder("~");
      const task = str(p.task, 20_000);
      const r = await this.newTerminal(
        () =>
          this.app.create({
            space: str(p.space, 100),
            spaceName: str(p.spaceName, 60),
            tabName: str(p.tabName, 60),
            folder,
            launcher: launcher.id,
            // Only programs that take it on their command line get it at start; the others have it typed in below.
            task: launcher.takesTask ? task : undefined,
          }),
        launcherArgv(launcher.id),
        folder,
      );
      await Promise.all([this.hc.list(), this.refreshNames()]);
      const made = { agent: agentKey(this.deviceId, "hc", r.terminal), space: r.space, terminal: r.terminal };
      if (!task) return made;
      // `hc run` starts the bare program: the task is typed in like for any other.
      if (launcher.takesTask && !r.direct) return { ...made, task: "started" as const };
      if (launcher.id === "shell") return { ...made, task: "failed" as const, taskNote: "终端不接任务" };
      const typed = await typeFirstTask(
        task,
        {
          terminal: async () => {
            if (!this.hc.terminals.has(r.terminal)) await this.hc.list().catch(() => undefined);
            return this.hc.terminals.get(r.terminal);
          },
          screen: async () => (await this.hc.read(r.terminal, 0)).text,
          type: (text) => this.hc.send(r.terminal, text),
          now: () => Date.now(),
          sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
        },
        this.firstTaskOptions,
      );
      this.note(typed.ok ? "info" : "warn", "create", typed.ok ? `first task typed into ${launcher.id} ${r.terminal} after ${typed.waitedMs}ms (${typed.how})` : `first task for ${launcher.id} ${r.terminal} not typed after ${typed.waitedMs}ms: ${typed.reason}`, {
        task: clipChars(task, 200),
      });
      return typed.ok ? { ...made, task: "typed" as const } : { ...made, task: "failed" as const, taskNote: typed.reason };
    },
    "host.info": async () => ({
      name: this.opts.config.name || hostname(),
      platform: platform(),
      sources: this.sources,
      version: HOSTD_VERSION,
      hcVersion: this.hc.version,
    }),
    "agent.seen": async (p, from) => {
      const a = this.resolve(p.agent);
      if (a.source === "runtime") {
        this.runtimeAccess(from);
        const state = this.runtimeState.get(a.localId);
        if (state) {
          const turn = Math.max(state.turn, 1);
          this.runtimeState.set(a.localId, { ...state, seenTurn: turn, status: state.status === "done" ? "idle" : state.status });
          this.runtimeAgents = this.runtimeAgents.map((item) =>
            item.localId === a.localId && item.status === "done" ? { ...item, status: "idle" } : item,
          );
          this.publish();
        }
        return { ok: true as const };
      }
      this.writable();
      const t = a.source === "hc" ? this.hc.terminals.get(a.localId) : undefined;
      // Same mark the desktop app leaves when the person looks at a finished turn.
      if (t && typeof t.turn === "number" && HcAdapter.status(t) === "done") {
        await this.hc.label(a.localId, { "herdr.seen": String(t.turn) });
        await this.hc.list();
      }
      return { ok: true as const };
    },
    "terminal.interrupt": async (p, from) => {
      this.writable();
      const a = this.resolve(p.agent);
      if (a.source === "runtime") {
        const view = this.runtimeAccess(from);
        const target = parseRuntimeTarget(a.localId);
        if (!target) throw new RpcFailure("not_found", "无法识别对应的运行时会话。");
        const res = await view.interrupt(target);
        void this.refreshRuntimeAgents();
        return { ok: true as const, report: res.interrupted ? "已发送停止信号" : "当前没有正在运行的轮次" };
      }
      if (a.source !== "hc") {
        await this.herdr.keys(a.localId, ["esc"]);
        return { ok: true as const };
      }
      return { ok: true as const, report: await this.hc.interrupt(a.localId) };
    },
    "terminal.kill": async (p) => {
      this.writable();
      const a = this.resolve(p.agent);
      if (a.source !== "hc") throw new RpcFailure("unsupported", "这个 agent 不是桌面 herdr 开的，从这里关不了");
      await this.hc.kill(a.localId);
      await this.hc.list();
      return { ok: true as const };
    },
    "herdr.layout": async () => {
      this.needApp();
      let ls: Awaited<ReturnType<HerdrApp["ls"]>>;
      try {
        ls = await this.app.ls();
      } catch {
        throw new RpcFailure("unsupported", "桌面 herdr 没有打开，先在电脑上打开它");
      }
      this.agents = this.collect();
      const byLocal = new Map(this.agents.filter((a) => a.source === "hc").map((a) => [a.localId, a]));
      const spaces: LayoutSpace[] = ls.spaces
        .filter((s) => !s.machine)
        .map((s) => ({
          id: s.id,
          name: s.name,
          folder: s.folder,
          active: !!s.active,
          tabs: (s.tabs ?? []).map((t) => ({
            id: t.id ?? "",
            name: t.name ?? "",
            active: !!t.active,
            settled: !!t.settled,
            terminals: (t.terminals ?? [])
              .filter((x) => typeof x.terminal === "string")
              .map((x) => {
                const a = byLocal.get(x.terminal!);
                return { terminal: x.terminal!, pane: x.pane ?? undefined, agent: a?.key, title: a?.title ?? x.name ?? undefined, harness: a?.harness ?? x.app ?? undefined, status: a?.status };
              }),
          })),
        }));
      return { spaces };
    },
    "herdr.command": async (p) => {
      this.writable();
      this.needApp();
      const args: Record<string, unknown> = { ...(p.args ?? {}) };
      // An agent key is as good as its terminal address.
      if (typeof args.terminal === "string" && args.terminal.includes("/")) args.terminal = this.resolve(args.terminal).localId;
      let checked: ReturnType<typeof herdrCommandArgs>;
      try {
        checked = herdrCommandArgs(p.command, args, await this.installed());
      } catch (e) {
        throw new RpcFailure("bad_request", (e as Error).message);
      }
      let result: unknown;
      try {
        result = await this.app.command(checked.command, checked.args);
      } catch (e) {
        throw new RpcFailure("unsupported", (e as Error).message);
      }
      await Promise.all([this.hc.list(), this.refreshNames()]);
      return { ok: true as const, result: result ?? undefined };
    },
    "sessions.list": async (p, from) => {
      this.assistantOnly(from);
      const limit = Math.min(Math.max(Number(p.limit ?? 15) || 15, 1), 50);
      if (!this.sources.includes("uniflo")) {
        const view = this.runtimeAccess(from);
        const query = parseRuntimeSearchQuery(typeof p.q === "string" ? p.q.slice(0, 300) : undefined);
        const entries = (await view.unifiedEntries()).filter((entry) => entryMatchesFilter(entry, query)).slice(0, limit);
        const live = new Map(this.agents.filter((a) => a.sessionKey).map((a) => [a.sessionKey!, a.key]));
        const sessions: SessionInfo[] = entries.map((entry) => {
          const key = encodeRuntimeSessionKey(entry.runtime, entry.projectId, entry.session.id);
          return {
            key,
            harness: entry.runtime,
            title: entry.session.title,
            cwd: entry.projectTitle,
            status: entry.session.state === "running" || entry.session.state === "attention" ? "working" : "idle",
            updatedAt: entry.session.updatedAt ?? Date.now(),
            ...(live.has(key) ? { agent: live.get(key) } : {}),
          };
        });
        return { sessions };
      }
      const sessions = await this.uniflo.list(typeof p.q === "string" ? p.q.slice(0, 300) : undefined, limit);
      const live = new Map(this.agents.filter((a) => a.sessionKey).map((a) => [a.sessionKey!, a.key]));
      return { sessions: sessions.map((s) => ({ ...s, agent: live.get(s.key) })) };
    },
    "sessions.search": async (p, from) => {
      this.assistantOnly(from);
      if (typeof p.q !== "string" || !p.q.trim()) throw new RpcFailure("bad_request", "要搜什么");
      const limit = Math.min(Math.max(Number(p.limit ?? 8) || 8, 1), 20);
      if (!this.sources.includes("uniflo")) {
        const view = this.runtimeAccess(from);
        const query = parseRuntimeSearchQuery(p.q.trim().slice(0, 300));
        const allEntries = await view.unifiedEntries();
        const ranked = allEntries
          .map((entry) => ({ entry, score: entrySearchPriority(entry, query) }))
          .filter((item) => item.score >= 0)
          .sort((a, b) => (b.score - a.score) || ((b.entry.session.updatedAt ?? 0) - (a.entry.session.updatedAt ?? 0)));
        const candidates = ranked.slice(0, 20).map((item) => item.entry);
        const results: SessionHit[] = [];
        let cursor = 0;
        const worker = async () => {
          while (cursor < candidates.length) {
            const entry = candidates[cursor++]!;
            let detail: RuntimeSessionDetail | undefined;
            try {
              detail = await view.detail({ runtime: entry.runtime, projectId: entry.projectId, sessionId: entry.session.id, limit: 30 });
            } catch {
              detail = undefined;
            }
            const hit = extractSearchHit(entry, detail, query);
            if (hit) results.push(hit);
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, Math.max(1, candidates.length)) }, () => worker()));
        results.sort((a, b) => b.updatedAt - a.updatedAt);
        return { total: results.length, results: results.slice(0, limit) };
      }
      return this.uniflo.search(p.q.trim().slice(0, 300), limit);
    },
    "sessions.read": async (p, from) => {
      this.assistantOnly(from);
      if (typeof p.session !== "string" || !p.session) throw new RpcFailure("bad_request", "session is required");
      if (!this.sources.includes("uniflo")) {
        const target = parseRuntimeTarget(p.session);
        if (!target) throw new RpcFailure("not_found", "这台电脑上没有这个会话");
        const res = await this.runtimeDetailForTarget(from, target, p.limit ?? 40);
        const s = res.detail.session;
        const info: SessionInfo = {
          key: res.sessionKey,
          harness: target.runtime,
          title: s.title,
          cwd: res.detail.project.title,
          status: s.state === "running" || s.state === "attention" ? "working" : "idle",
          updatedAt: s.updatedAt ?? Date.now(),
          agent: this.agents.find((a) => a.sessionKey === res.sessionKey)?.key,
        };
        return { session: info, events: res.events, more: false, nextBefore: null };
      }
      let session: Awaited<ReturnType<UnifloAdapter["info"]>>;
      try {
        session = await this.uniflo.info(p.session);
      } catch {
        throw new RpcFailure("not_found", "这台电脑上没有这个会话");
      }
      const r = await this.uniflo.events(p.session, p.limit ?? 40, p.before);
      return { session: { ...session, agent: this.agents.find((a) => a.sessionKey === session.key)?.key }, events: r.events, more: r.more, nextBefore: r.nextBefore };
    },
    "harness.icons": async (p) => {
      if (!Array.isArray(p.ids) || !p.ids.every((id) => typeof id === "string")) throw new RpcFailure("bad_request", "ids must be a list");
      return { icons: await this.uniflo.icons(p.ids.slice(0, HARNESS_ICON_MAX)) };
    },
    "sessions.usage": async (p, from) => {
      this.assistantOnly(from);
      if (!this.sources.includes("uniflo")) {
        return {
          rows: [],
          total: { key: "total", label: "合计", sessions: 0, steps: 0, prompts: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
        };
      }
      const groupBy = p.groupBy && ["harness", "model", "cwd", "day", "session"].includes(p.groupBy) ? p.groupBy : "harness";
      return this.uniflo.usage(typeof p.since === "string" ? p.since.slice(0, 40) : undefined, groupBy);
    },
    "sessions.resume": async (p, from) => {
      this.assistantOnly(from);
      this.writable();
      this.needApp();
      if (typeof p.session !== "string" || !p.session) throw new RpcFailure("bad_request", "session is required");
      this.agents = this.collect();
      const open = this.agents.find((a) => a.sessionKey === p.session);
      if (open) throw new RpcFailure("bad_request", `这个会话正在「${open.title ?? open.localId}」里开着，不用再开一个`);
      let argv: string[];
      let folder: string | undefined;
      try {
        const r = await this.uniflo.resume(p.session);
        if (!r.supported) throw new Error("这个程序的会话不支持续跑");
        argv = resumeArgv(r.argv, await this.installed());
        folder = r.cwd ? checkFolder(r.cwd) : undefined;
      } catch (e) {
        throw new RpcFailure("unsupported", (e as Error).message);
      }
      const space = typeof p.space === "string" && p.space ? p.space.slice(0, 100) : undefined;
      const r = await this.newTerminal(() => this.app.open({ space, folder, argv }), withProgramPath(argv), folder);
      await Promise.all([this.hc.list(), this.refreshNames()]);
      return { agent: agentKey(this.deviceId, "hc", r.terminal), space: r.space, terminal: r.terminal };
    },
    "voice.warmup": async (_p, from) => this.voiceAccess(from).warmup(),
    "voice.transcribe": async (p, from) => {
      const bridge = this.voiceAccess(from);
      if (typeof p?.requestId !== "string" || typeof p?.audioBase64 !== "string" || typeof p?.sampleRate !== "number" || !Number.isFinite(p.sampleRate)) {
        throw new RpcFailure("bad_request", "语音识别参数无效。");
      }
      return bridge.transcribe({ requestId: p.requestId, audioBase64: p.audioBase64, sampleRate: p.sampleRate });
    },
    "voice.synthesize": async (p, from) => {
      const bridge = this.voiceAccess(from);
      if (typeof p?.requestId !== "string" || typeof p?.text !== "string") {
        throw new RpcFailure("bad_request", "语音合成参数无效。");
      }
      return bridge.synthesize({
        requestId: p.requestId,
        text: p.text,
        ...(typeof p.speed === "number" && Number.isFinite(p.speed) ? { speed: p.speed } : {}),
      });
    },
    "voice.cancel": async (p, from) => this.voiceAccess(from).cancel(typeof p?.requestId === "string" ? p.requestId : undefined),
    "voice.release": async (_p, from) => this.voiceAccess(from).release(),
  };

  private voiceAccess(from: string) {
    if (from !== "relay") throw new RpcFailure("forbidden", "仅中继语音服务可调用本地语音能力。");
    const bridge = this.opts.runtimeSessions?.localVoice;
    if (!bridge || !bridge.enabled) throw new RpcFailure("unsupported", "这台电脑未配置或未启用本地语音服务。");
    return bridge;
  }
}
