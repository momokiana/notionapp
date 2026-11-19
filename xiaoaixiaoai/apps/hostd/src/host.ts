import { homedir, hostname, platform } from "node:os";
import type { Agent as HttpsAgent } from "node:https";
import { WebSocket } from "ws";
import {
  HARNESS_ICON_MAX,
  PROTOCOL_VERSION,
  agentKey,
  parseAgentKey,
  rowsChange,
  type Agent,
  type HostSource,
  type LayoutSpace,
  type Device,
  type ClientFrame,
  type RpcError,
  type RpcMethod,
  type RpcMethods,
  type ServerFrame,
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
import { RuntimeError, type RuntimeSessions } from "./runtime-sessions.ts";
import { RuntimeTaskReporter } from "./runtime-task-reporter.ts";
import { VERSION } from "@xiaoaixiaoai/update";

/** The repository version (root package.json), shared with the relay and the app. */
export const HOSTD_VERSION = VERSION;

/** Calls that change something here: logged when they work too. */
const MUTATING = new Set(["terminal.send", "terminal.keys", "terminal.put", "agent.create", "terminal.interrupt", "terminal.kill", "herdr.command", "sessions.resume", "runtimeSessions.send"]);

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
    if (this.opts.runtimeSessions) this.sources.push("runtime-sessions");
    if (this.opts.runtimeSessions?.hasDirectory) this.sources.push("dsh-directory");
    if (!hc && !herdr && !this.opts.runtimeSessions) this.log("no herdr runtime found: start the herdr app (hc) or `herdr` first. Waiting anyway.");
    this.logTimer = setInterval(() => this.flushLogs(), this.logEveryMs);
    this.logTimer.unref?.();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.namesTimer) clearInterval(this.namesTimer);
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
    const reports = runtime?.hasDirectory && !this.opts.readOnly ? new RuntimeTaskReporter(
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

  private async handleRpc(f: Extract<ServerFrame, { type: "rpc" }>): Promise<void> {
    try {
      const allow = this.opts.allow ?? [];
      if (allow.length && !allow.includes(f.from)) throw new RpcFailure("forbidden", "这台电脑没有授权给你");
      if (this.opts.runtimeOnly && !["runtimeSessions.list", "runtimeSessions.browse", "runtimeSessions.send", "host.info", "agents.list"].includes(f.method)) {
        throw new RpcFailure("unsupported", "这台电脑仅提供共享的项目会话，不开放终端。");
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
    if (this.opts.runtimeOnly) {
      this.send({ type: "stream_open", id: f.id, error: { code: "unsupported", message: "这台电脑仅提供共享的项目会话，不开放终端。" } });
      return;
    }
    const allow = this.opts.allow ?? [];
    if (allow.length && !allow.includes(f.from)) {
      this.send({ type: "stream_open", id: f.id, error: { code: "forbidden", message: "这台电脑没有授权给你" } });
      return;
    }
    const p = (f.params ?? {}) as Record<string, unknown>;
    const agentName = p.agent;
    try {
      const a = this.resolve(agentName);
      const prev = this.streamMeta.get(f.id);
      if (prev && prev.from !== f.from) throw new RpcFailure("bad_request", "重复的流 id");
      // The same viewer again (it reconnected through a relay that did not end the old one): the new one replaces it.
      if (prev) this.stopStream(f.id);
      const meta = { from: f.from, kind: f.stream, agent: a.key };
      this.streamMeta.set(f.id, meta);
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

  private async drainSendQueue(a: Agent): Promise<void> {
    const q = this.sendQueues.get(a.key);
    if (!q) return;
    while (q.length) {
      const item = q[0]!;
      this.queueEvent(a.key, { queueId: item.id, status: "sending", position: 0 });
      try {
        if (a.source === "hc") await this.hc.send(a.localId, item.text, item.enter);
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
        if (await this.waits.settle(this.agents, async (key) => (await this.uniflo.events(key, 15)).events, Date.now(), screen)) this.publish();
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
    if (!this.sources.includes("uniflo")) throw new RpcFailure("unsupported", "这台电脑没有运行 Uniflo，查不了会话记录");
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
    "runtimeSessions.send": async (p, from) => {
      const view = this.runtimeAccess(from);
      this.writable();
      return view.send(p);
    },
    "agents.list": async (p) => {
      this.agents = this.collect();
      return { agents: p.includeShells === false ? this.agents.filter((a) => !a.isShell) : this.agents };
    },
    "terminal.read": async (p) => {
      const a = this.resolve(p.agent);
      const lines = Math.min(Math.max(Number(p.lines ?? 200) || 200, 0), 2000);
      return a.source === "hc" ? this.hc.read(a.localId, lines) : this.herdr.read(a.localId, lines);
    },
    "terminal.send": async (p) => {
      this.writable();
      const a = this.resolve(p.agent);
      if (typeof p.text !== "string" || p.text.length > 20_000) throw new RpcFailure("bad_request", "text is required");
      const status = a.status;
      const queued = this.enqueueSend(a, p.text, p.enter !== false);
      // In a turn, the program keeps typed text in its input box until the turn ends.
      const waiting = p.enter !== false && status === "working";
      if (waiting) {
        this.waits.add(a.key, queued.id, p.text, Date.now());
        this.watchWaits();
        this.publish();
      }
      return { ok: true as const, queueId: queued.id, position: queued.position, agentStatus: status, waiting };
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
    "session.events": async (p) => {
      const key = await this.sessionOf(p.agent, p.sub);
      if (!key) return { sessionKey: null, events: [], more: false, nextBefore: null };
      const r = await this.uniflo.events(key, p.limit ?? 80, p.before);
      return { sessionKey: key, events: r.events, more: r.more, nextBefore: r.nextBefore };
    },
    "session.children": async (p) => {
      const key = await this.sessionOf(p.agent, p.sub);
      return { sessions: key ? await this.uniflo.children(key) : [] };
    },
    "spaces.list": async () => {
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
    "agent.create": async (p) => {
      this.writable();
      if (!this.sources.includes("hc")) throw new RpcFailure("unsupported", "这台电脑没有装桌面 herdr");
      const launcher = typeof p.launcher === "string" ? (await this.launchers).find((l) => l.id === p.launcher) : undefined;
      if (!launcher) throw new RpcFailure("bad_request", "这台电脑上没有这个程序");
      const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
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
    "agent.seen": async (p) => {
      this.writable();
      const a = this.resolve(p.agent);
      const t = a.source === "hc" ? this.hc.terminals.get(a.localId) : undefined;
      // Same mark the desktop app leaves when the person looks at a finished turn.
      if (t && typeof t.turn === "number" && HcAdapter.status(t) === "done") {
        await this.hc.label(a.localId, { "herdr.seen": String(t.turn) });
        await this.hc.list();
      }
      return { ok: true as const };
    },
    "terminal.interrupt": async (p) => {
      this.writable();
      const a = this.resolve(p.agent);
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
      const sessions = await this.uniflo.list(typeof p.q === "string" ? p.q.slice(0, 300) : undefined, limit);
      const live = new Map(this.agents.filter((a) => a.sessionKey).map((a) => [a.sessionKey!, a.key]));
      return { sessions: sessions.map((s) => ({ ...s, agent: live.get(s.key) })) };
    },
    "sessions.search": async (p, from) => {
      this.assistantOnly(from);
      if (typeof p.q !== "string" || !p.q.trim()) throw new RpcFailure("bad_request", "要搜什么");
      return this.uniflo.search(p.q.trim().slice(0, 300), Math.min(Math.max(Number(p.limit ?? 8) || 8, 1), 20));
    },
    "sessions.read": async (p, from) => {
      this.assistantOnly(from);
      if (typeof p.session !== "string" || !p.session) throw new RpcFailure("bad_request", "session is required");
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
  };
}
