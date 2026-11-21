import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, lstatSync } from "node:fs";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  effectiveAgentStatus,
  isJoinId,
  isPairCode,
  joinLink,
  pairLink,
  parsePairInput,
  type Agent,
  type ClientFrame,
  type Device,
  type DeviceKind,
  type JoinClaim,
  type JoinRequest,
  type JoinTicket,
  type PairCode,
  type PairResponse,
  type RpcError,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type ServerFrame,
  type NotifyFrame,
  type AssistantConfirm,
  type LogLevel,
  type LedgerTxDirection,
  type LedgerTxSource,
} from "@xiaoaixiaoai/protocol";
import { VERSION } from "@xiaoaixiaoai/update";
import { Store } from "./store.ts";
import { LedgerService } from "./ledger/service.ts";
import { issueSetupCode, type SetupInfo } from "./setup.ts";
import { joinLanding, notFoundLanding, pairLanding, type LandingPage } from "./landing.ts";
import { Assistant, type AssistantOptions } from "./assistant/assistant.ts";
import { makeLlm, type Llm, type LlmProvider, type LlmTarget } from "./assistant/llm.ts";
import { ModelConfigService } from "./assistant/model-config.ts";
import { startCall, endAllCalls, type LiveConfig } from "./assistant/live.ts";
import { EventLog, levelsFrom, parseSince, redact, type EventInput } from "./eventlog.ts";
import { adminPage } from "./admin.ts";
import {
  buildDiagnosticsBundle,
  filterEventsForAgent,
  formatDiagnosticsMarkdown,
  sanitizeDiagnosticAgents,
} from "./diagnostics.ts";
import {
  confirmsRuntimeTask,
  parseRuntimeTaskFrame,
  RUNTIME_TASK_FRAME_MAX_BYTES,
  runtimeTaskDispatch,
  RuntimeTaskUploadRate,
  type RuntimeTaskDispatch,
} from "./runtime-task-notices.ts";

export interface RelayOptions {
  dbPath: string;
  /** Optional local directory holding verified release bundles & signed APKs for direct downloads. */
  releasesDir?: string;
  /** Admin token: may mint pair codes. Required to bootstrap the first device. */
  adminToken?: string;
  /** Public base URL put into pairing links, e.g. https://xiaoaixiaoai.example.com */
  publicUrl?: string;
  /** Trust X-Forwarded-For (set when behind Caddy/nginx). */
  trustProxy?: boolean;
  rpcTimeoutMs?: number;
  log?: (msg: string) => void;
  /** Text assistant: models tried in order, each at its provider (see src/config.ts). */
  assistant?: { targets: LlmTarget[]; providers?: LlmProvider[]; name?: string; persona?: string; firstByteMs?: number };
  /** Injected model for tests; wins over `assistant`. */
  llm?: Llm;
  /** Live voice (MOSS-Live or an OpenAI Realtime service); off when unset. */
  live?: LiveConfig;
  /** Timing overrides for tests. */
  assistantTiming?: Omit<AssistantOptions, "store" | "host" | "llm" | "model" | "name" | "persona" | "voice" | "confirm">;
  /** Whether the assistant asks before acting until the app changes it (POCKET_ASSISTANT_CONFIRM). Default `never`. */
  assistantConfirm?: AssistantConfirm;
}

interface Conn {
  ws: WebSocket;
  device: Device;
  alive: boolean;
}

interface Pending {
  /** A device's call, answered over its socket; or the relay's own (assistant) call. */
  caller: Conn | { resolve: (v: unknown) => void; reject: (e: Error) => void };
  callerId: string;
  target: string;
  timer: NodeJS.Timeout;
  /** Private target IDs and exact routed socket for a viewer's DSH dispatch. */
  runtimeTask?: { dispatch: RuntimeTaskDispatch; target: Conn };
  /** For the log. */
  method: string;
  from: string;
  params: unknown;
  t0: number;
}

/** Calls that change something on a computer: logged even when they work. Typing keystrokes and "seen" marks are not. */
const MUTATING = new Set(["terminal.send", "terminal.keys", "agent.create", "terminal.interrupt", "terminal.kill", "herdr.command", "sessions.resume"]);
/** Calls that may run longer than the usual RPC timeout: a new agent's first task is typed in once its program is up (hostd waits up to 45 s). */
const SLOW_RPC_MS: Partial<Record<string, number>> = { "agent.create": 100_000 };
/** Bodies of log uploads are larger than other requests. */
const MAX_LOG_BODY = 512 * 1024;
const STARTED = Date.now();

export class HostCallError extends Error {
  code: RpcError["code"];
  constructor(error: RpcError) {
    super(error.message);
    this.code = error.code;
  }
}

/** A device that asked to join and waits for a paired device to approve it. */
interface Join {
  req: JoinRequest;
  secret: string;
  ip: string;
  /** Device this request replaces when approved (the asker's previous registration). */
  replaces?: string;
  state: "pending" | "denied" | "approved";
  /** Held only until the asking device collects it. */
  granted?: PairResponse;
}

interface StreamPending {
  caller: Conn;
  target: string;
}

const MAX_BODY = 64 * 1024;
const MAX_AGENTS = 2000;
const PAIR_FAIL_LIMIT = 10;
const PAIR_FAIL_WINDOW_MS = 10 * 60 * 1000;
const JOIN_TTL_MS = 5 * 60 * 1000;
const JOIN_MAX = 200;
const JOIN_MAX_PER_IP = 5;

export class Relay {
  readonly store: Store;
  readonly http: Server;
  private wss: WebSocketServer;
  private conns = new Map<string, Conn>();
  private agents = new Map<string, Agent[]>();
  private pending = new Map<string, Pending>();
  private streams = new Map<string, StreamPending>();
  private seq = 0;
  private pairFails = new Map<string, { n: number; since: number }>();
  private joins = new Map<string, Join>();
  private heartbeat: NodeJS.Timeout;
  /** Every line also becomes an event (see eventlog.ts); `journal` is the raw output. */
  private log: (msg: string) => void;
  readonly events: EventLog;
  private notifyWss: WebSocketServer;
  private notifySubs = new Set<{ ws: WebSocket; deviceId: string; alive: boolean }>();
  private runtimeTaskUploadRate = new RuntimeTaskUploadRate();
  readonly ledger: LedgerService;
  readonly assistant: Assistant;
  readonly modelConfig: ModelConfigService;

  private opts: RelayOptions;

  constructor(opts: RelayOptions) {
    this.opts = opts;
    this.store = new Store(opts.dbPath);
    const journal = opts.log ?? ((m: string) => console.log(`[relay] ${m}`));
    this.events = new EventLog(this.store, { journal, deviceName: (id) => (id === "relay" ? "relay" : this.store.getDevice(id)?.name) });
    // Plain lines ("paired ...", "live: ...") are events too: kind from their prefix, trouble from their words.
    this.log = (m) => this.events.record(plainEvent(m));
    this.http = createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        this.log(`http error: ${err instanceof Error ? err.stack : String(err)}`);
        if (!res.headersSent) sendJson(res, 500, { error: { code: "internal", message: "internal error" } });
      });
    });
    // Screens and conversations are text that shrinks several times over; hosts usually sit behind a slow uplink.
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 8 * 1024 * 1024,
      perMessageDeflate: { threshold: 512, zlibDeflateOptions: { level: 4 }, concurrencyLimit: 16 },
    });
    this.http.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.notifyWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.heartbeat = setInterval(() => this.sweep(), 30_000);
    this.ledger = new LedgerService(this.store, () => this.toViewers({ type: "ledger_updated" }));
    const a = opts.assistant;
    this.modelConfig = new ModelConfigService(this.store, a?.targets ?? [], a?.providers ?? []);
    const initialTargets = this.modelConfig.targets();
    const llm =
      opts.llm ??
      (initialTargets.length
        ? this.buildLlm(initialTargets)
        : undefined);
    const hasVoice = Boolean(opts.live && (opts.live.provider === "local" || opts.live.apiKey));
    this.assistant = new Assistant({
      store: this.store,
      llm,
      model: opts.llm ? "test" : initialTargets[0]?.model,
      name: a?.name,
      persona: a?.persona,
      voice: hasVoice,
      chatVoice: opts.live?.provider === "local",
      confirm: opts.assistantConfirm,
      ...opts.assistantTiming,
      host: {
        devices: () => this.devices(),
        agents: () => this.allAgents(),
        call: (to, method, params, timeoutMs) => this.callHost(to, method, params, timeoutMs),
        toViewers: (frame) => this.toViewers(frame),
        log: this.log,
        event: (e) => this.events.record(e),
        logs: (q) => this.events.query(q),
        ledger: this.ledger,
      },
    });
    this.assistant.onNotice((notice) => {
      const data = JSON.stringify({ type: "notice", notice } satisfies NotifyFrame);
      for (const s of this.notifySubs) if (s.ws.readyState === WebSocket.OPEN) s.ws.send(data);
    });
  }

  /**
   * First run: while no device is registered, a one-time setup code lets the first phone or
   * computer in without the admin token. Null once the relay has devices.
   */
  setupCode(fresh = false): SetupInfo | null {
    return issueSetupCode(this.store, this.opts.publicUrl, fresh);
  }

  listen(port: number, host = "0.0.0.0"): Promise<number> {
    return new Promise((resolve) => {
      this.http.listen(port, host, () => {
        const addr = this.http.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  private closing = false;

  async close(): Promise<void> {
    // Sockets report their close after the store is gone; they have nothing left to record.
    this.closing = true;
    clearInterval(this.heartbeat);
    this.assistant.close();
    endAllCalls();
    for (const s of this.notifySubs) s.ws.terminate();
    this.notifySubs.clear();
    this.notifyWss.close();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.streams.clear();
    for (const c of this.conns.values()) c.ws.terminate();
    this.wss.close();
    await new Promise<void>((r) => this.http.close(() => r()));
    this.store.close();
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://relay");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // QR landing pages: they echo the URL and never look the code or request up.
    const lm = /^\/(p|j)\/([^/]+)$/.exec(path);
    if (lm && (req.method === "GET" || req.method === "HEAD")) {
      const value = lm[2]!;
      const server = this.publicUrl(req);
      const code = lm[1] === "p" && isPairCode(value) ? parsePairInput(value)?.code : undefined;
      const landing = code ? pairLanding(server, code) : lm[1] === "j" && isJoinId(value) ? joinLanding(server, value) : null;
      sendPage(res, landing ? 200 : 404, landing ?? notFoundLanding(), req.method === "HEAD");
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && path === "/admin") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      });
      res.end(req.method === "HEAD" ? undefined : adminPage());
      return;
    }

    if (req.method === "GET" && (path === "/v1/health" || path === "/")) {
      const activeTargets = this.modelConfig.targets();
      sendJson(res, 200, {
        ok: true,
        name: "xiaoaixiaoai-relay",
        version: VERSION,
        protocol: PROTOCOL_VERSION,
        devices: this.store.listDevices().length,
        online: this.conns.size,
        // Which services are configured (names only, never keys or addresses).
        assistant: [...new Set(activeTargets.map((t) => t.provider))],
        voice: this.opts.live ? (this.opts.live.provider ?? "moss-live") : null,
      });
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && path.startsWith("/v1/releases/")) {
      const name = path.slice("/v1/releases/".length);
      const valid =
        name === "SHA256SUMS" ||
        /^xiaoaixiaoai-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:-android-arm64\.apk|\.tar\.gz)$/.test(name);
      if (!valid || !this.opts.releasesDir) {
        sendError(res, 404, "not_found", "release asset not found");
        return;
      }
      const targetPath = join(resolve(this.opts.releasesDir), name);
      try {
        const st = lstatSync(targetPath);
        if (st.isSymbolicLink() || !st.isFile()) {
          sendError(res, 404, "not_found", "release asset not found");
          return;
        }
        const contentType = name === "SHA256SUMS"
          ? "text/plain; charset=utf-8"
          : name.endsWith(".apk")
            ? "application/vnd.android.package-archive"
            : "application/gzip";
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": String(st.size),
          "Cache-Control": "no-cache",
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        await new Promise<void>((done) => {
          const stream = createReadStream(targetPath);
          const cleanup = () => { stream.destroy(); done(); };
          stream.on("error", cleanup);
          res.on("close", cleanup);
          res.on("finish", done);
          stream.pipe(res);
        });
      } catch {
        if (!res.headersSent) sendError(res, 404, "not_found", "release asset not found");
      }
      return;
    }

    if (req.method === "POST" && path === "/v1/pair") {
      const ip = this.clientIp(req);
      if (this.pairBlocked(ip)) {
        sendError(res, 429, "forbidden", "配对尝试太多次，请 10 分钟后再试");
        return;
      }
      const body = await readJson(req);
      const code = str(body?.code, 32);
      const name = str(body?.name, 64)?.trim();
      const kind = body?.kind === "host" || body?.kind === "viewer" ? (body.kind as DeviceKind) : null;
      const platform = str(body?.platform, 32);
      if (!code || !name || !kind) {
        sendError(res, 400, "bad_request", "需要 code、name 和 kind（host 或 viewer）");
        return;
      }
      const row = this.store.consumePairCode(code, kind);
      if (typeof row === "string") {
        this.pairFailed(ip);
        if (row === "wrong_kind") {
          sendError(
            res,
            400,
            "bad_request",
            kind === "viewer"
              ? "这个配对码是给电脑用的。给手机配对请在“添加设备”里选手机，或在电脑上运行 xiaoaixiaoai pair"
              : "这个配对码是给手机用的。给电脑配对请运行 xiaoaixiaoai pair --kind host，或在 App 的“添加设备”里选电脑",
          );
        } else if (row === "expired") sendError(res, 401, "unauthorized", "配对码已过期，换一个新的");
        else sendError(res, 401, "unauthorized", "配对码不对，或者已经用过了");
        return;
      }
      // A device that pairs again while still holding its old token is the same device coming back:
      // it takes over its old entry instead of leaving a dead twin in the list.
      const previous = this.authenticate(req, url);
      if (previous && previous !== "admin" && previous.kind === kind) this.removeDevice(previous.id, "re-paired");
      const { device, token } = this.store.createDevice({ name: this.store.uniqueName(name), kind, platform });
      this.log(`paired ${kind} "${name}" (${device.id})`);
      this.broadcast({ type: "device", seq: ++this.seq, device: this.decorate(device) });
      const out: PairResponse = { device: this.decorate(device), token };
      sendJson(res, 200, out);
      return;
    }

    if (req.method === "POST" && path === "/v1/join") {
      const ip = this.clientIp(req);
      this.sweepJoins();
      const mine = [...this.joins.values()].filter((j) => j.ip === ip && j.state === "pending").length;
      if (this.joins.size >= JOIN_MAX || mine >= JOIN_MAX_PER_IP) {
        sendError(res, 429, "forbidden", "等待确认的加入请求太多了，过几分钟再试");
        return;
      }
      const body = await readJson(req);
      const name = str(body?.name, 64)?.trim();
      const kind = body?.kind === "host" || body?.kind === "viewer" ? (body.kind as DeviceKind) : null;
      if (!name || !kind) {
        sendError(res, 400, "bad_request", "需要 name 和 kind（host 或 viewer）");
        return;
      }
      const previous = this.authenticate(req, url);
      const join: Join = {
        req: { id: randomBytes(12).toString("base64url"), name, kind, platform: str(body?.platform, 32), expiresAt: Date.now() + JOIN_TTL_MS },
        secret: randomBytes(24).toString("base64url"),
        ip,
        replaces: previous && previous !== "admin" && previous.kind === kind ? previous.id : undefined,
        state: "pending",
      };
      this.joins.set(join.req.id, join);
      const out: JoinTicket = { ...join.req, secret: join.secret, link: joinLink(this.publicUrl(req), join.req.id) };
      sendJson(res, 200, out);
      return;
    }

    const jm = /^\/v1\/join\/([A-Za-z0-9_-]{8,32})(?:\/(claim|approve|deny))?$/.exec(path);
    if (jm && req.method === "POST" && jm[2] === "claim") {
      this.sweepJoins();
      const join = this.joins.get(jm[1]!);
      const secret = str((await readJson(req))?.secret, 64);
      if (!join || !secret || !safeEqual(secret, join.secret)) {
        sendError(res, 404, "not_found", "这个加入请求已经过期，重新发起一次");
        return;
      }
      let out: JoinClaim = { status: "pending" };
      if (join.state === "denied") out = { status: "denied" };
      else if (join.state === "approved" && join.granted) out = { status: "approved", ...join.granted };
      // Answered requests are handed over exactly once.
      if (join.state !== "pending") this.joins.delete(join.req.id);
      sendJson(res, 200, out);
      return;
    }

    // Everything below needs a device token (or the admin token where noted).
    const auth = this.authenticate(req, url);

    if (jm && (req.method === "GET" ? !jm[2] : jm[2] === "approve" || jm[2] === "deny")) {
      if (!auth) {
        sendError(res, 401, "unauthorized", "需要设备令牌");
        return;
      }
      this.sweepJoins();
      const join = this.joins.get(jm[1]!);
      if (!join || join.state !== "pending") {
        sendError(res, 404, "not_found", "这个加入请求已经过期或处理过了，让对方重新显示二维码");
        return;
      }
      if (req.method === "GET") {
        sendJson(res, 200, join.req);
        return;
      }
      const by = auth === "admin" ? "admin" : auth.id;
      if (jm[2] === "deny") {
        join.state = "denied";
        this.log(`join denied "${join.req.name}" by ${by}`);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (join.replaces) this.removeDevice(join.replaces, "re-paired");
      const { device, token } = this.store.createDevice({ name: this.store.uniqueName(join.req.name), kind: join.req.kind, platform: join.req.platform });
      join.state = "approved";
      join.granted = { device: this.decorate(device), token };
      this.log(`joined ${device.kind} "${device.name}" (${device.id}), approved by ${by}`);
      this.broadcast({ type: "device", seq: ++this.seq, device: this.decorate(device) });
      sendJson(res, 200, { device: this.decorate(device) });
      return;
    }

    if (req.method === "POST" && path === "/v1/pair/codes") {
      if (!auth) {
        sendError(res, 401, "unauthorized", "需要设备令牌或管理员令牌");
        return;
      }
      const body = (await readJson(req)) ?? {};
      const kind = body.kind === "host" || body.kind === "viewer" ? (body.kind as DeviceKind) : undefined;
      const ttlSec = typeof body.ttlSec === "number" ? body.ttlSec : undefined;
      const row = this.store.createPairCode({ kind, ttlSec, createdBy: auth === "admin" ? "admin" : auth.id });
      const out: PairCode = { code: row.code, expiresAt: row.expiresAt, link: pairLink(this.publicUrl(req), row.code) };
      sendJson(res, 200, out);
      return;
    }

    if (req.method === "GET" && path === "/v1/devices") {
      if (!auth) {
        sendError(res, 401, "unauthorized", "需要设备令牌");
        return;
      }
      sendJson(res, 200, { devices: this.devices() });
      return;
    }

    const m = /^\/v1\/devices\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (m && req.method === "DELETE") {
      if (!auth) {
        sendError(res, 401, "unauthorized", "需要设备令牌");
        return;
      }
      const id = m[1]!;
      if (!this.removeDevice(id, `revoked by ${auth === "admin" ? "admin" : auth.id}`)) {
        sendError(res, 404, "not_found", "没有这个设备");
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === "/v1/logs") {
      if (!auth) {
        sendError(res, 401, "unauthorized", "需要设备令牌或管理员令牌");
        return;
      }
      if (req.method === "POST") {
        if (auth === "admin") {
          sendError(res, 400, "bad_request", "日志要由设备自己上传");
          return;
        }
        const body = await readJson(req, MAX_LOG_BODY);
        if (!body || !Array.isArray(body.entries)) {
          sendError(res, 400, "bad_request", "需要 entries 数组（太大也会被拒，每批最多 200 条）");
          return;
        }
        sendJson(res, 200, { stored: this.events.ingest(auth, body.entries) });
        return;
      }
      if (req.method === "GET") {
        sendJson(res, 200, { entries: this.events.query(this.logQuery(url.searchParams)) });
        return;
      }
    }

    if (req.method === "GET" && path === "/v1/admin/overview") {
      if (auth !== "admin") {
        sendError(res, 401, "unauthorized", "需要管理员令牌");
        return;
      }
      sendJson(res, 200, this.overview());
      return;
    }

    if (req.method === "GET" && path === "/v1/admin/agents") {
      if (auth !== "admin") {
        sendError(res, 401, "unauthorized", "需要管理员令牌");
        return;
      }
      const includeShell = url.searchParams.get("includeShell") === "1";
      const list = this.allAgents().filter((x) => includeShell || !x.isShell);
      const devName = (id: string) => this.store.getDevice(id)?.name;
      sendJson(res, 200, {
        agents: sanitizeDiagnosticAgents(
          list,
          devName,
          (k) => this.assistant.lastReason(k),
          (k) => this.assistant.watcherCount(k),
        ),
      });
      return;
    }

    if (req.method === "POST" && path === "/v1/admin/probe") {
      if (auth !== "admin") {
        sendError(res, 401, "unauthorized", "需要管理员令牌");
        return;
      }
      const body = await readJson(req);
      const onlyIndex = typeof body?.index === "number" && Number.isInteger(body.index) ? body.index : undefined;
      sendJson(res, 200, { results: await this.probeModels(onlyIndex) });
      return;
    }

    if (path === "/v1/admin/models" || path.startsWith("/v1/admin/models/")) {
      if (auth !== "admin") {
        sendError(res, 401, "unauthorized", "需要管理员令牌");
        return;
      }
      await this.handleAdminModels(req, res, path);
      return;
    }

    if (req.method === "GET" && path === "/v1/diagnostics") {
      if (!auth) {
        sendError(res, 401, "unauthorized", "需要设备令牌或管理员令牌");
        return;
      }
      const bundle = this.diagnosticsBundle(url.searchParams);
      if (url.searchParams.get("format") === "markdown") {
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(formatDiagnosticsMarkdown(bundle));
        return;
      }
      sendJson(res, 200, bundle);
      return;
    }

    if (path === "/v1/assistant" || path.startsWith("/v1/assistant/")) {
      // The assistant belongs to the person: phones (and the admin), not computers.
      if (!auth || (auth !== "admin" && auth.kind !== "viewer")) {
        sendError(res, 401, "unauthorized", "需要手机的设备令牌");
        return;
      }
      await this.handleAssistant(req, res, path, auth);
      return;
    }

    if (path === "/v1/ledger" || path.startsWith("/v1/ledger/")) {
      if (!auth || (auth !== "admin" && auth.kind !== "viewer")) {
        sendError(res, 401, "unauthorized", "需要手机的设备令牌");
        return;
      }
      await this.handleLedger(req, res, path);
      return;
    }

    sendError(res, 404, "not_found", "not found");
  }

  private async handleLedger(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (path === "/v1/ledger" && req.method === "GET") {
      sendJson(res, 200, this.ledger.state());
      return;
    }
    if (path === "/v1/ledger" && req.method === "DELETE") {
      sendJson(res, 200, this.ledger.clearData());
      return;
    }
    if (path === "/v1/ledger/config" && req.method === "POST") {
      const body = await readJson(req);
      if (!body) {
        sendError(res, 400, "bad_request", "需要 JSON 参数");
        return;
      }
      try {
        const patch: { enabled?: boolean; balanceCents?: number | null; savingsGoalCents?: number } = {};
        if (body.enabled !== undefined) {
          if (typeof body.enabled !== "boolean") throw new Error("enabled 需要是布尔值");
          patch.enabled = body.enabled;
        }
        if (body.balanceCents !== undefined) patch.balanceCents = body.balanceCents as number | null;
        if (body.savingsGoalCents !== undefined) patch.savingsGoalCents = body.savingsGoalCents as number;
        sendJson(res, 200, this.ledger.updateConfig(patch));
      } catch (e) {
        sendError(res, 400, "bad_request", (e as Error).message);
      }
      return;
    }
    if (path === "/v1/ledger/fixed" && req.method === "POST") {
      const body = await readJson(req);
      try {
        const resFixed = this.ledger.addFixed({
          name: typeof body?.name === "string" ? body.name : "",
          amountCents: Number(body?.amountCents),
          paidThisMonth: body?.paidThisMonth === true,
        });
        sendJson(res, 200, resFixed.state);
      } catch (e) {
        sendError(res, 400, "bad_request", (e as Error).message);
      }
      return;
    }
    const fm = /^\/v1\/ledger\/fixed\/([A-Za-z0-9_-]{1,40})$/.exec(path);
    if (fm) {
      if (req.method === "PATCH") {
        const body = await readJson(req);
        try {
          const patch: { name?: string; amountCents?: number; paid?: boolean } = {};
          if (typeof body?.name === "string") patch.name = body.name;
          if (body?.amountCents !== undefined) patch.amountCents = Number(body.amountCents);
          if (typeof body?.paid === "boolean") patch.paid = body.paid;
          sendJson(res, 200, this.ledger.updateFixed(fm[1]!, patch).state);
        } catch (e) {
          sendError(res, 400, "bad_request", (e as Error).message);
        }
        return;
      }
      if (req.method === "DELETE") {
        try {
          sendJson(res, 200, this.ledger.deleteFixed(fm[1]!));
        } catch (e) {
          sendError(res, 404, "not_found", (e as Error).message);
        }
        return;
      }
    }
    if (path === "/v1/ledger/transactions" && req.method === "POST") {
      const body = await readJson(req);
      try {
        const source = body?.source === "wechat_notify" || body?.source === "assistant" ? (body.source as LedgerTxSource) : "manual";
        if (!this.ledger.isEnabled() && source === "wechat_notify") {
          sendError(res, 409, "bad_request", "微信账单插件未启用");
          return;
        }
        const out = this.ledger.recordTransaction({
          direction: body?.direction as LedgerTxDirection,
          amountCents: Number(body?.amountCents),
          title: typeof body?.title === "string" ? body.title : "",
          note: typeof body?.note === "string" ? body.note : undefined,
          source,
          externalId: typeof body?.externalId === "string" ? body.externalId : undefined,
          fixedId: typeof body?.fixedId === "string" ? body.fixedId : undefined,
          ts: typeof body?.ts === "number" ? body.ts : undefined,
          adjustBalance: typeof body?.adjustBalance === "boolean" ? body.adjustBalance : true,
        });
        if (source === "wechat_notify") {
          this.events.record({
            kind: "ledger",
            level: out.duplicate ? "debug" : "info",
            msg: `wechat_notify ${out.duplicate ? "duplicate" : "recorded"} ${out.transaction.direction} ${(out.transaction.amountCents / 100).toFixed(2)}`,
            data: { txId: out.transaction.id, title: out.transaction.title, duplicate: out.duplicate },
          });
          if (!out.duplicate) this.assistant.onLedgerCapture(out);
        }
        sendJson(res, 200, out);
      } catch (e) {
        sendError(res, 400, "bad_request", (e as Error).message);
      }
      return;
    }
    const tm = /^\/v1\/ledger\/transactions\/([A-Za-z0-9_-]{1,40})$/.exec(path);
    if (tm) {
      if (req.method === "PATCH") {
        const body = await readJson(req);
        try {
          const patch: { direction?: LedgerTxDirection; amountCents?: number; title?: string; note?: string; fixedId?: string | null } = {};
          if (body?.direction === "income" || body?.direction === "expense") patch.direction = body.direction;
          if (body?.amountCents !== undefined) patch.amountCents = Number(body.amountCents);
          if (typeof body?.title === "string") patch.title = body.title;
          if (typeof body?.note === "string") patch.note = body.note;
          if (body?.fixedId !== undefined) patch.fixedId = body.fixedId as string | null;
          sendJson(res, 200, this.ledger.updateTransaction(tm[1]!, patch));
        } catch (e) {
          sendError(res, 400, "bad_request", (e as Error).message);
        }
        return;
      }
      if (req.method === "DELETE") {
        const resDel = this.ledger.deleteTransaction(tm[1]!, true);
        if (!resDel.deleted) {
          sendError(res, 404, "not_found", "找不到这条账单记录");
          return;
        }
        sendJson(res, 200, resDel.state);
        return;
      }
    }
    sendError(res, 404, "not_found", "unknown ledger endpoint");
  }

  private async handleAssistant(req: IncomingMessage, res: ServerResponse, path: string, auth: Device | "admin"): Promise<void> {
    const asker = auth === "admin" ? { id: "admin", name: "admin" } : { id: auth.id, name: auth.name };
    if (req.method === "GET" && path === "/v1/assistant") {
      sendJson(res, 200, this.assistant.state());
      return;
    }
    if (req.method === "POST" && path === "/v1/assistant/messages") {
      const text = str((await readJson(req))?.text, 4000)?.trim();
      if (!text) {
        sendError(res, 400, "bad_request", "消息是空的");
        return;
      }
      sendJson(res, 200, { item: this.assistant.say(text, asker) });
      return;
    }
    if (req.method === "POST" && path === "/v1/assistant/voice/warmup") {
      this.assistant.warmupVoice();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && path === "/v1/assistant/voice") {
      const body = await readJson(req, 4 * 1024 * 1024);
      const audioBase64 = typeof body?.audioBase64 === "string" ? body.audioBase64.trim() : "";
      if (!audioBase64 || audioBase64.length > 3_600_000) {
        sendError(res, 400, "bad_request", "音频数据无效或超过 60 秒限制");
        return;
      }
      const rawRate = body?.sampleRate;
      const sampleRate = typeof rawRate === "number" && Number.isFinite(rawRate) ? Math.round(rawRate) : 16_000;
      if (sampleRate < 8_000 || sampleRate > 48_000) {
        sendError(res, 400, "bad_request", "sampleRate 超出范围");
        return;
      }
      try {
        sendJson(res, 200, await this.assistant.sayVoice(audioBase64, sampleRate, asker));
      } catch (e) {
        const msg = (e as Error).message || "语音识别失败";
        sendError(res, /不在线|未开启/.test(msg) ? 503 : 500, /不在线|未开启/.test(msg) ? "offline" : "internal", msg);
      }
      return;
    }
    if (req.method === "POST" && path === "/v1/assistant/speak") {
      const body = await readJson(req);
      const itemId = str(body?.itemId, 120)?.trim();
      const text = str(body?.text, 4000)?.trim();
      if (!itemId && !text) {
        sendError(res, 400, "bad_request", "需要 itemId 或 text");
        return;
      }
      const started = this.assistant.speakItem(itemId || "manual", text);
      if (!started) {
        sendError(res, 503, "offline", "电脑未在线或未开启本地语音服务");
        return;
      }
      sendJson(res, 200, { ok: true, utteranceId: started.utteranceId });
      return;
    }
    if (req.method === "POST" && path === "/v1/assistant/speak/stop") {
      this.assistant.stopChatSpeech(false);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (path === "/v1/assistant/settings") {
      if (req.method === "GET") {
        sendJson(res, 200, { ...this.assistant.settings(), default: this.assistant.defaultConfirm() });
        return;
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        const hasConfirm = body != null && Object.hasOwn(body, "confirm");
        const hasReplyMode = body != null && Object.hasOwn(body, "replyMode");
        if (!hasConfirm && !hasReplyMode) {
          sendError(res, 400, "bad_request", "需要提供 confirm 或 replyMode");
          return;
        }
        if (hasConfirm && body!.confirm !== "never" && body!.confirm !== "always") {
          sendError(res, 400, "bad_request", "confirm 需要是 never 或 always");
          return;
        }
        if (hasReplyMode && body!.replyMode !== "text" && body!.replyMode !== "voice") {
          sendError(res, 400, "bad_request", "replyMode 需要是 text 或 voice");
          return;
        }
        const by = auth === "admin" ? "admin" : auth.name;
        let settings = this.assistant.settings();
        if (hasConfirm) settings = this.assistant.setConfirm(body!.confirm as "never" | "always", by);
        if (hasReplyMode) settings = this.assistant.setReplyMode(body!.replyMode as "text" | "voice", by);
        sendJson(res, 200, settings);
        return;
      }
    }
    const am = /^\/v1\/assistant\/actions\/([A-Za-z0-9_-]{1,40})$/.exec(path);
    if (am && req.method === "POST") {
      const decision = (await readJson(req))?.decision;
      if (decision !== "confirm" && decision !== "cancel") {
        sendError(res, 400, "bad_request", "decision 需要是 confirm 或 cancel");
        return;
      }
      try {
        sendJson(res, 200, { item: await this.assistant.decide(am[1]!, decision) });
      } catch (e) {
        sendError(res, 404, "not_found", (e as Error).message);
      }
      return;
    }
    if (req.method === "DELETE" && path === "/v1/assistant/thread") {
      this.assistant.clear();
      sendJson(res, 200, { ok: true });
      return;
    }
    const rm = /^\/v1\/assistant\/reminders\/([A-Za-z0-9_-]{1,40})$/.exec(path);
    if (rm && req.method === "DELETE") {
      if (!this.assistant.cancelReminder(rm[1]!)) sendError(res, 404, "not_found", "没有这个提醒");
      else sendJson(res, 200, { ok: true });
      return;
    }
    if (path === "/v1/assistant/profile") {
      if (req.method === "GET") {
        sendJson(res, 200, { profile: this.assistant.profile(), presets: this.assistant.presets() });
        return;
      }
      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
        const body = await readJson(req);
        if (!body || typeof body !== "object") {
          sendError(res, 400, "bad_request", "需要 JSON 对象");
          return;
        }
        try {
          const by = auth === "admin" ? "admin" : auth.name;
          const profile = this.assistant.setProfile(body, by);
          sendJson(res, 200, { profile, presets: this.assistant.presets() });
        } catch (e) {
          sendError(res, 400, "bad_request", (e as Error).message);
        }
        return;
      }
    }
    if (req.method === "GET" && path === "/v1/assistant/memories/export") {
      sendJson(res, 200, { markdown: this.assistant.memory.exportMarkdown(this.assistant.profile()) });
      return;
    }
    if (path === "/v1/assistant/memories") {
      if (req.method === "GET") {
        const sp = new URL(req.url ?? path, "http://relay").searchParams;
        const rawLimit = sp.get("limit");
        const limit = rawLimit !== null ? Number(rawLimit) : undefined;
        sendJson(
          res,
          200,
          this.assistant.memory.list({
            category: sp.get("category") ?? undefined,
            q: sp.get("q") ?? undefined,
            limit: Number.isFinite(limit) ? limit : undefined,
          }),
        );
        return;
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        if (!body || typeof body !== "object") {
          sendError(res, 400, "bad_request", "需要 JSON 对象");
          return;
        }
        try {
          const resMem = this.assistant.memory.remember({
            category: body.category,
            slotKey: body.slotKey ?? body.slot_key,
            content: body.content,
            importance: body.importance,
            pinned: body.pinned,
            expiresAt: body.expiresAt,
            ttlDays: body.ttlDays ?? body.ttl_days,
            source: "user",
          });
          this.assistant.notifyMemoriesChanged();
          sendJson(res, 200, resMem);
        } catch (e) {
          sendError(res, 400, "bad_request", (e as Error).message);
        }
        return;
      }
      if (req.method === "DELETE") {
        const removed = this.assistant.memory.clear();
        this.assistant.notifyMemoriesChanged();
        sendJson(res, 200, { ok: true, removed });
        return;
      }
    }
    const mm = /^\/v1\/assistant\/memories\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (mm) {
      if (req.method === "PATCH" || req.method === "PUT") {
        const body = await readJson(req);
        if (!body || typeof body !== "object") {
          sendError(res, 400, "bad_request", "需要 JSON 对象");
          return;
        }
        try {
          const item = this.assistant.memory.update(mm[1]!, {
            ...(Object.hasOwn(body, "category") ? { category: body.category } : {}),
            ...(Object.hasOwn(body, "slotKey") || Object.hasOwn(body, "slot_key") ? { slotKey: body.slotKey ?? body.slot_key } : {}),
            ...(Object.hasOwn(body, "content") ? { content: body.content } : {}),
            ...(Object.hasOwn(body, "importance") ? { importance: body.importance } : {}),
            ...(Object.hasOwn(body, "pinned") ? { pinned: body.pinned } : {}),
            ...(Object.hasOwn(body, "expiresAt") ? { expiresAt: body.expiresAt } : {}),
          });
          this.assistant.notifyMemoriesChanged();
          sendJson(res, 200, { item });
        } catch (e) {
          const msg = (e as Error).message;
          sendError(res, msg.includes("没有找到") ? 404 : 400, msg.includes("没有找到") ? "not_found" : "bad_request", msg);
        }
        return;
      }
      if (req.method === "DELETE") {
        const out = this.assistant.memory.forget({ id: mm[1]! });
        if (!out.removed) {
          sendError(res, 404, "not_found", "没有这条记忆");
          return;
        }
        this.assistant.notifyMemoriesChanged();
        sendJson(res, 200, { ok: true });
        return;
      }
    }
    sendError(res, 404, "not_found", "not found");
  }

  /** The relay's own call to a computer (used by the assistant). */
  callHost<M extends RpcMethod>(to: string, method: M, params: RpcParams<M>, timeoutMs?: number): Promise<RpcResult<M>> {
    return new Promise((resolve, reject) => {
      const target = this.conns.get(to);
      if (!target || target.device.kind !== "host") {
        this.rpcEvent({ method, from: "relay", target: to, params, t0: Date.now() }, { code: "offline", message: "这台电脑现在不在线" });
        reject(new HostCallError({ code: "offline", message: "这台电脑现在不在线" }));
        return;
      }
      const id = randomUUID();
      const t0 = Date.now();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.rpcEvent({ method, from: "relay", target: to, params, t0 }, { code: "timeout", message: "电脑端没有及时回应" });
        reject(new HostCallError({ code: "timeout", message: "电脑端没有及时回应" }));
      }, timeoutMs ?? this.opts.rpcTimeoutMs ?? 30_000);
      this.pending.set(id, { caller: { resolve: resolve as (v: unknown) => void, reject }, callerId: id, target: to, timer, method, from: "relay", params, t0 });
      this.send(target, { type: "rpc", id, from: "relay", method, params });
    });
  }

  /** One line per forwarded call that changed something or failed; reads that work are not worth a row. */
  private rpcEvent(p: { method: string; from: string; target: string; params: unknown; t0: number }, error?: RpcError): void {
    if (!error && !MUTATING.has(p.method)) return;
    const from = p.from === "relay" ? "assistant" : (this.store.getDevice(p.from)?.name ?? p.from);
    const to = this.store.getDevice(p.target)?.name ?? p.target;
    // Don't let a runtime-supplied dispatch error accidentally put private task data in the log.
    const outcome = error ? (p.method.startsWith("runtimeSessions.") ? "failed" : `${error.code}: ${error.message.slice(0, 200)}`) : "ok";
    this.events.record({
      kind: "rpc",
      level: error ? (error.code === "internal" || error.code === "timeout" || error.code === "offline" ? "warn" : "info") : "info",
      msg: `${p.method} ${from} -> ${to} ${outcome} ${Date.now() - p.t0}ms`,
      device: p.target,
      data: rpcSummary(p.method, p.params),
    });
  }

  private logQuery(q: URLSearchParams) {
    const now = Date.now();
    let device = q.get("device")?.trim() || undefined;
    if (device && !this.store.getDevice(device)) {
      const all = this.store.listDevices();
      const want = device.toLowerCase();
      device = (all.find((d) => d.name.toLowerCase() === want) ?? all.find((d) => d.name.toLowerCase().includes(want)))?.id ?? device;
    }
    const after = Number(q.get("after"));
    return {
      since: parseSince(q.get("since"), now) ?? (Number.isFinite(after) && after > 0 ? undefined : now - 3_600_000),
      until: parseSince(q.get("until"), now),
      after: Number.isFinite(after) && after > 0 ? after : undefined,
      device,
      source: ["relay", "host", "viewer"].includes(q.get("source") ?? "") ? q.get("source")! : undefined,
      kind: q.get("kind")?.trim().slice(0, 40) || undefined,
      levels: levelsFrom(q.get("level") as LogLevel | null),
      text: q.get("text")?.trim().slice(0, 80) || undefined,
      limit: Math.min(Math.max(Number(q.get("limit")) || 200, 1), 2000),
    };
  }

  /** What the control panel shows at the top: health and how the relay is set up (never keys). */
  private overview() {
    const devices = this.devices();
    const activeTargets = this.modelConfig.targets();
    const live = this.opts.live;
    const dayAgo = Date.now() - 86_400_000;
    const trouble = this.events.query({ since: dayAgo, levels: ["warn", "error"], limit: 5000 });
    const hostOf = (u: string) => {
      try {
        return new URL(u).host;
      } catch {
        return "";
      }
    };
    const host = [...new Set(activeTargets.map((t) => hostOf(t.baseUrl)).filter(Boolean))].join(", ");
    const nonShell = this.allAgents().filter((x) => !x.isShell);
    const board = { blocked: 0, working: 0, done: 0, idle: 0 };
    for (const ag of nonShell) {
      const eff = effectiveAgentStatus(ag);
      if (eff === "blocked" || eff === "working" || eff === "done" || eff === "idle") board[eff]++;
    }
    const assistantState = this.assistant.state();
    const profile = this.assistant.profile();
    const ledgerState = this.ledger.state();
    return {
      version: VERSION,
      protocol: PROTOCOL_VERSION,
      startedAt: STARTED,
      devices: devices.length,
      online: devices.filter((d) => d.online).length,
      notifySubs: this.notifySubs.size,
      agents: nonShell.length,
      board,
      assistant: {
        ready: assistantState.ready,
        name: profile.name,
        userCall: profile.userCall,
        models: this.opts.llm ? ["test"] : activeTargets.map((t) => `${t.provider}:${t.model}`),
        endpoint: host,
        confirm: this.assistant.confirmMode(),
        replyMode: this.assistant.replyMode(),
        voiceHostOnline: devices.some((d) => d.kind === "host" && d.online && d.sources?.includes("local-voice")),
        memoryCount: this.assistant.memory.list({ limit: 1 }).total,
        busy: assistantState.busy,
      },
      ledger: {
        enabled: ledgerState.config.enabled,
        balanceCents: ledgerState.plan.balanceCents,
        todayRemainingCents: ledgerState.plan.todayRemainingCents,
        txCount: ledgerState.recentTransactions.length,
      },
      voice: live
        ? live.provider === "local"
          ? { provider: "local", model: live.model, endpoint: "local-host" }
          : live.apiKey
            ? { provider: live.provider ?? "moss-live", model: live.model, endpoint: hostOf(live.url) }
            : null
        : null,
      last24h: { warn: trouble.filter((e) => e.level === "warn").length, error: trouble.filter((e) => e.level === "error").length },
      actions: assistantState.items
        .filter((i) => i.action)
        .slice(-30)
        .reverse()
        .map((i) => i.action),
    };
  }

  private diagnosticsBundle(q: URLSearchParams) {
    const query = this.logQuery(q);
    const agent = q.get("agent")?.trim() || undefined;
    const rawLimit = Math.min(Math.max(Number(q.get("limit")) || 300, 1), 1000);
    const fetched = this.events.query({
      ...query,
      // When filtering to one agent across relay+host+viewer, scan a wider window before slicing.
      limit: agent ? Math.max(rawLimit * 4, 1500) : rawLimit,
    });
    const events = agent ? filterEventsForAgent(fetched, agent, rawLimit) : fetched.slice(-rawLimit);
    const ov = this.overview();
    return buildDiagnosticsBundle({
      generatedAt: Date.now(),
      relay: {
        version: ov.version,
        protocol: ov.protocol,
        startedAt: ov.startedAt,
        uptimeMs: Math.max(0, Date.now() - ov.startedAt),
        notifySubs: ov.notifySubs,
        assistantReady: ov.assistant.ready,
        models: ov.assistant.models,
        endpoint: ov.assistant.endpoint,
        confirm: ov.assistant.confirm,
        replyMode: ov.assistant.replyMode,
        voice: ov.voice,
      },
      filter: {
        since: query.since,
        until: query.until,
        agent,
        device: query.device,
        source: query.source,
        level: q.get("level")?.trim() || undefined,
        kind: query.kind,
        text: query.text,
        limit: rawLimit,
      },
      devices: this.devices(),
      agents: this.allAgents(),
      deviceName: (id) => this.store.getDevice(id)?.name,
      reasonOf: (k) => this.assistant.lastReason(k),
      watcherCount: (k) => this.assistant.watcherCount(k),
      last24h: ov.last24h,
      recentActions: (ov.actions ?? []).filter((x): x is NonNullable<typeof x> => !!x),
      events,
    });
  }

  private buildLlm(targets: LlmTarget[]): Llm {
    return makeLlm({
      targets,
      firstByteMs: this.opts.assistant?.firstByteMs,
      log: (m) => this.events.record({ kind: "model", level: /fail|error|refus/i.test(m) ? "warn" : "info", msg: m }),
    });
  }

  private applyModelRuntime(summary: string): void {
    const targets = this.modelConfig.targets();
    if (!this.opts.llm) {
      const nextLlm = targets.length ? this.buildLlm(targets) : undefined;
      this.assistant.setModelRuntime(nextLlm, targets[0]?.model);
    }
    this.events.record({
      kind: "config",
      level: "info",
      msg: summary,
      data: { primary: targets[0] ? `${targets[0].provider}:${targets[0].model}` : "none", count: targets.length },
    });
  }

  private async handleAdminModels(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (req.method === "GET" && path === "/v1/admin/models") {
      sendJson(res, 200, this.modelConfig.view());
      return;
    }
    if (req.method === "POST" && path === "/v1/admin/models/provider") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") {
        sendError(res, 400, "bad_request", "需要 JSON 对象");
        return;
      }
      try {
        const view = this.modelConfig.upsertProvider(
          {
            id: typeof body.id === "string" ? body.id : "",
            label: typeof body.label === "string" ? body.label : undefined,
            protocol: typeof body.protocol === "string" ? body.protocol : "",
            baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
            apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
            auth: typeof body.auth === "string" ? body.auth : undefined,
            maxTokensField: typeof body.maxTokensField === "string" ? body.maxTokensField : undefined,
          },
          "admin",
        );
        this.applyModelRuntime(`provider updated (${String(body.id).toLowerCase()})`);
        sendJson(res, 200, view);
      } catch (e) {
        sendError(res, 400, "bad_request", (e as Error).message);
      }
      return;
    }
    const pm = /^\/v1\/admin\/models\/provider\/([a-z0-9-]{1,32})$/i.exec(path);
    if (pm && req.method === "DELETE") {
      try {
        const view = this.modelConfig.removeProvider(pm[1]!, "admin");
        this.applyModelRuntime(`provider reverted/removed (${pm[1]!.toLowerCase()})`);
        sendJson(res, 200, view);
      } catch (e) {
        sendError(res, 400, "bad_request", (e as Error).message);
      }
      return;
    }
    if (req.method === "POST" && path === "/v1/admin/models/order") {
      const body = await readJson(req);
      if (!body || !Array.isArray(body.order)) {
        sendError(res, 400, "bad_request", "需要 order 数组");
        return;
      }
      try {
        const view = this.modelConfig.setOrder(body.order as Array<{ provider: string; model: string }>, "admin");
        const primary = view.order[0];
        this.applyModelRuntime(`model order updated -> primary=${primary ? `${primary.provider}:${primary.model}` : "none"}`);
        sendJson(res, 200, view);
      } catch (e) {
        sendError(res, 400, "bad_request", (e as Error).message);
      }
      return;
    }
    if (req.method === "POST" && path === "/v1/admin/models/reset") {
      const view = this.modelConfig.reset();
      this.applyModelRuntime("models & providers reset to server defaults");
      sendJson(res, 200, view);
      return;
    }
    if (req.method === "POST" && path === "/v1/admin/models/fetch") {
      const body = await readJson(req);
      const provider = typeof body?.provider === "string" ? body.provider : "";
      if (!provider) {
        sendError(res, 400, "bad_request", "需要 provider");
        return;
      }
      try {
        sendJson(res, 200, await this.modelConfig.fetchProviderModels(provider));
      } catch (e) {
        sendError(res, 502, "internal", `拉取模型失败：${(e as Error).message}`);
      }
      return;
    }
    sendError(res, 404, "not_found", "not found");
  }

  private async probeModels(onlyIndex?: number): Promise<
    Array<{ index: number; provider: string; model: string; protocol: string; endpointHost: string; ok: boolean; latencyMs: number; reply?: string; error?: string }>
  > {
    const targets: Array<{ index: number; label: string; provider: string; model: string; protocol: string; endpointHost: string; llm: Llm }> = [];
    const hostOf = (u: string) => {
      try {
        return new URL(u).host;
      } catch {
        return "";
      }
    };
    const configured = this.modelConfig.targets();
    if (this.opts.llm && (!configured.length || onlyIndex === undefined)) {
      if (!configured.length) {
        targets.push({ index: 1, label: "test:test", provider: "test", model: "test", protocol: "mock", endpointHost: "local", llm: this.opts.llm });
      }
    }
    if (!targets.length) {
      configured.forEach((t, idx) => {
        const index = idx + 1;
        if (onlyIndex !== undefined && onlyIndex !== index) return;
        targets.push({
          index,
          label: `${t.provider}:${t.model}`,
          provider: t.provider,
          model: t.model,
          protocol: t.protocol,
          endpointHost: hostOf(t.baseUrl),
          llm: this.opts.llm ?? makeLlm({ targets: [t], firstByteMs: 12_000, totalMs: 15_000 }),
        });
      });
    }
    const results: Array<{ index: number; provider: string; model: string; protocol: string; endpointHost: string; ok: boolean; latencyMs: number; reply?: string; error?: string }> = [];
    for (const target of targets) {
      const t0 = Date.now();
      try {
        const res = await target.llm({
          system: "Reply with OK only.",
          messages: [{ role: "user", content: "ping" }],
          tools: [],
          maxTokens: 512,
        });
        const latencyMs = Date.now() - t0;
        const reply = res.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text.trim())
          .join(" ")
          .slice(0, 60);
        this.events.record({ kind: "model", level: "info", msg: `probe ${target.label} ok ${latencyMs}ms` });
        results.push({ index: target.index, provider: target.provider, model: target.model, protocol: target.protocol, endpointHost: target.endpointHost, ok: true, latencyMs, reply: reply || "ok" });
      } catch (e) {
        const latencyMs = Date.now() - t0;
        const error = redact((e instanceof Error ? e.message : String(e)).slice(0, 180));
        this.events.record({ kind: "model", level: "warn", msg: `probe ${target.label} failed ${latencyMs}ms: ${error}` });
        results.push({ index: target.index, provider: target.provider, model: target.model, protocol: target.protocol, endpointHost: target.endpointHost, ok: false, latencyMs, error });
      }
    }
    return results;
  }

  private toViewers(frame: ServerFrame): void {
    const data = JSON.stringify(frame);
    for (const c of this.conns.values()) {
      if (c.device.kind === "viewer" && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  }

  /** Deletes a device, drops its live connection and tells everyone. */
  private removeDevice(id: string, why: string): boolean {
    if (!this.store.deleteDevice(id)) return false;
    this.runtimeTaskUploadRate.forget(id);
    this.log(`removed ${id}: ${why}`);
    const c = this.conns.get(id);
    if (c) {
      this.conns.delete(id);
      c.ws.close(4001, "revoked");
    }
    // Detach before the close handshake: no later notice may reach this registration.
    for (const sub of this.notifySubs) {
      if (sub.deviceId !== id) continue;
      this.notifySubs.delete(sub);
      sub.ws.close(4001, "revoked");
    }
    this.agents.delete(id);
    this.broadcast({ type: "device_removed", seq: ++this.seq, id });
    return true;
  }

  private authenticate(req: IncomingMessage, url: URL): Device | "admin" | null {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : url.searchParams.get("token");
    if (!token) return null;
    if (this.opts.adminToken && safeEqual(token, this.opts.adminToken)) return "admin";
    return this.store.deviceByToken(token);
  }

  private publicUrl(req: IncomingMessage): string {
    if (this.opts.publicUrl) return this.opts.publicUrl.replace(/\/+$/, "");
    const proto = this.opts.trustProxy ? String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0] : "http";
    return `${proto}://${req.headers.host ?? "localhost"}`;
  }

  private clientIp(req: IncomingMessage): string {
    if (this.opts.trustProxy) {
      const xff = req.headers["x-forwarded-for"];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "?";
  }

  private sweepJoins(): void {
    const now = Date.now();
    for (const [id, j] of this.joins) if (j.req.expiresAt < now) this.joins.delete(id);
  }

  private pairBlocked(ip: string): boolean {
    const f = this.pairFails.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > PAIR_FAIL_WINDOW_MS) {
      this.pairFails.delete(ip);
      return false;
    }
    return f.n >= PAIR_FAIL_LIMIT;
  }

  private pairFailed(ip: string): void {
    const f = this.pairFails.get(ip);
    if (!f || Date.now() - f.since > PAIR_FAIL_WINDOW_MS) this.pairFails.set(ip, { n: 1, since: Date.now() });
    else f.n++;
  }

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  private handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://relay");
    const path = url.pathname.replace(/\/+$/, "");
    if (path !== "/v1/ws" && path !== "/v1/notify" && path !== "/v1/assistant/live") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const auth = this.authenticate(req, url);
    if (!auth || auth === "admin") {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    if (path === "/v1/ws") {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, auth));
      return;
    }
    if (auth.kind !== "viewer") {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    if (path === "/v1/notify") {
      const since = Number(url.searchParams.get("since") ?? 0);
      this.notifyWss.handleUpgrade(req, socket, head, (ws) => this.onNotifyConnection(ws, auth.id, since));
      return;
    }
    const live = this.opts.live;
    const voiceEnabled = Boolean(live && (live.provider === "local" || live.apiKey));
    if (!live || !voiceEnabled) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }
    this.notifyWss.handleUpgrade(req, socket, head, (ws) => {
      this.log(`live: call from "${auth.name}" (${auth.id})`);
      startCall(ws, auth.id, live, this.assistant, this.log);
    });
  }

  /** A phone's background push channel: notices only, never replaces the main socket. */
  private onNotifyConnection(ws: WebSocket, deviceId: string, since: number): void {
    const devName = this.store.getDevice(deviceId)?.name ?? deviceId;
    const sub = { ws, deviceId, alive: true };
    this.notifySubs.add(sub);
    ws.on("pong", () => (sub.alive = true));
    ws.on("message", () => (sub.alive = true));
    ws.on("close", (code) => {
      this.notifySubs.delete(sub);
      if (this.closing) return;
      this.events.record({ kind: "notify", level: "debug", msg: `notify close "${devName}" code=${code} subs=${this.notifySubs.size}`, device: deviceId });
    });
    ws.on("error", () => this.notifySubs.delete(sub));
    const send = (f: NotifyFrame) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(f));
    const now = Date.now();
    send({ type: "hello", ts: now });
    let replayed = 0;
    if (Number.isSafeInteger(since) && since > 0) {
      // Native uses a single time cursor; neither source may leapfrog the other's older notices.
      const notices = [...this.assistant.noticesSince(since), ...this.store.runtimeTaskNoticesSince(deviceId, since, now)];
      notices.sort((a, b) => a.ts - b.ts);
      replayed = notices.length;
      for (const notice of notices) send({ type: "notice", notice });
    }
    this.events.record({ kind: "notify", level: "debug", msg: `notify open "${devName}" since=${since > 0 ? "cursor" : "0"} replayed=${replayed} subs=${this.notifySubs.size}`, device: deviceId });
  }

  private onConnection(ws: WebSocket, device: Device): void {
    const prev = this.conns.get(device.id);
    if (prev) {
      // A newer connection of the same device wins.
      this.conns.delete(device.id);
      prev.ws.close(4000, "replaced");
      // Before this connection's frames: a phone subscribes again right away, often with the same ids.
      this.endStreams(prev);
    }
    const conn: Conn = { ws, device, alive: true };
    this.conns.set(device.id, conn);
    this.store.touch(device.id);
    this.events.record({ kind: "device", msg: `online ${device.kind} "${device.name}"`, device: device.id });

    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (data, isBinary) => {
      if (this.closing || this.conns.get(device.id) !== conn) return;
      conn.alive = true;
      if (isBinary) return;
      const text = data.toString();
      let frame: ClientFrame;
      try {
        frame = JSON.parse(text) as ClientFrame;
      } catch {
        this.send(conn, { type: "error", error: { code: "bad_request", message: "invalid json" } });
        return;
      }
      if (!frame || typeof frame !== "object") return;
      if (frame.type === "runtime_task_event" && Buffer.byteLength(text) > RUNTIME_TASK_FRAME_MAX_BYTES) return;
      this.onFrame(conn, frame);
    });
    ws.on("close", () => {
      if (this.closing || this.conns.get(device.id) !== conn) return; // shutting down, or replaced
      this.conns.delete(device.id);
      this.store.touch(device.id);
      this.failPendingFor(device.id);
      this.endStreams(conn);
      this.events.record({ kind: "device", msg: `offline ${device.kind} "${device.name}"`, device: device.id });
      if (this.agents.delete(device.id)) {
        this.broadcast({ type: "agents", seq: ++this.seq, deviceId: device.id, agents: [] });
      }
      const d = this.store.getDevice(device.id);
      if (d) this.broadcast({ type: "device", seq: ++this.seq, device: this.decorate(d) });
    });
    ws.on("error", () => {});

    this.send(conn, {
      type: "welcome", version: PROTOCOL_VERSION, device: this.decorate(device), seq: this.seq,
      runtimeTaskNotices: true,
    });
    this.send(conn, { type: "snapshot", seq: this.seq, devices: this.devices(), agents: this.allAgents() });
    this.broadcast({ type: "device", seq: ++this.seq, device: this.decorate(device) }, device.id);
  }

  private onFrame(conn: Conn, frame: ClientFrame): void {
    switch (frame.type) {
      case "hello": {
        conn.device.platform = str(frame.platform, 32) ?? conn.device.platform;
        conn.device.sources = Array.isArray(frame.sources) ? frame.sources.slice(0, 8) : undefined;
        conn.device.version = str(frame.appVersion, 32);
        this.store.touch(conn.device.id, conn.device.platform);
        this.events.record({ kind: "device", level: "debug", msg: `hello "${conn.device.name}" ${conn.device.version ?? "?"} ${conn.device.platform ?? ""}`.trim(), device: conn.device.id });
        this.broadcast({ type: "device", seq: ++this.seq, device: this.decorate(conn.device) });
        return;
      }
      case "agents": {
        if (conn.device.kind !== "host") {
          this.send(conn, { type: "error", error: { code: "forbidden", message: "only hosts publish agents" } });
          return;
        }
        if (!Array.isArray(frame.agents)) return;
        // Never trust the host about whose agents these are.
        const agents = frame.agents
          .slice(0, MAX_AGENTS)
          .filter((a) => a && typeof a.localId === "string" && typeof a.source === "string")
          .map((a) => ({ ...a, deviceId: conn.device.id, key: `${conn.device.id}/${a.source}:${a.localId}` }));
        this.agents.set(conn.device.id, agents);
        this.broadcast({ type: "agents", seq: ++this.seq, deviceId: conn.device.id, agents });
        this.assistant.onAgents(conn.device.id, agents);
        return;
      }
      case "rpc": {
        this.routeRpc(conn, frame);
        return;
      }
      case "stream_subscribe": {
        this.routeStreamSubscribe(conn, frame);
        return;
      }
      case "stream_unsubscribe": {
        this.routeStreamUnsubscribe(conn, frame);
        return;
      }
      case "stream_open": {
        const s = this.streams.get(frame.id);
        if (!s || s.target !== conn.device.id) return;
        this.send(s.caller, frame);
        if (frame.error) this.streams.delete(frame.id);
        return;
      }
      case "stream_event": {
        const s = this.streams.get(frame.id);
        if (s?.target === conn.device.id) this.send(s.caller, frame);
        return;
      }
      case "rpc_result": {
        const p = this.pending.get(frame.id);
        // Only the target host can answer; a notice-binding receipt needs the exact routed socket.
        if (!p || p.target !== conn.device.id || (p.runtimeTask && p.runtimeTask.target !== conn)) return;
        clearTimeout(p.timer);
        this.pending.delete(frame.id);
        const dispatch = p.runtimeTask?.dispatch;
        if (dispatch && !("resolve" in p.caller) && frame.error === undefined && confirmsRuntimeTask(frame.result, dispatch.requestId)) {
          try {
            this.store.bindRuntimeTask({ hostId: conn.device.id, ...dispatch }, p.caller.device.id, Date.now());
          } catch { /* Notice persistence is best-effort; leave the real RPC result unchanged and private. */ }
        }
        if (
          !("resolve" in p.caller) &&
          p.caller.device.kind === "viewer" &&
          frame.error === undefined &&
          (p.method === "terminal.send" || p.method === "terminal.keys") &&
          p.params &&
          typeof p.params === "object"
        ) {
          const rawAgent = (p.params as Record<string, unknown>).agent;
          if (typeof rawAgent === "string" && rawAgent) {
            const key = rawAgent.includes("/")
              ? rawAgent
              : (this.agents.get(conn.device.id)?.find((a) => a.localId === rawAgent || a.key === rawAgent)?.key ?? `${conn.device.id}/${rawAgent}`);
            this.assistant.noteUserTouch(key);
          }
        }
        this.rpcEvent(p, frame.error);
        if ("resolve" in p.caller) {
          if (frame.error) p.caller.reject(new HostCallError(frame.error));
          else p.caller.resolve(frame.result);
        } else this.send(p.caller, { type: "rpc_result", id: p.callerId, result: frame.result, error: frame.error });
        return;
      }
      case "runtime_task_event": {
        if (conn.device.kind !== "host") return;
        const event = parseRuntimeTaskFrame(frame);
        const now = Date.now();
        if (!event || !this.runtimeTaskUploadRate.take(conn.device.id, now)) return;
        let delivery;
        try {
          delivery = this.store.recordRuntimeTaskEvent(conn.device.id, event, now);
        } catch { return; } // Retry quietly; never ack a failed write or log private data.
        if (!delivery) return;
        this.send(conn, { type: "runtime_task_ack", eventId: event.eventId });
        if (delivery === "duplicate") return;
        const data = JSON.stringify({ type: "notice", notice: delivery.notice } satisfies NotifyFrame);
        for (const sub of this.notifySubs) {
          if (sub.deviceId === delivery.viewerId && sub.ws.readyState === WebSocket.OPEN) sub.ws.send(data);
        }
        return;
      }
      case "ping": {
        this.send(conn, { type: "pong", t: frame.t });
        return;
      }
      case "log": {
        this.events.ingest(conn.device, frame.entries);
        return;
      }
      default:
        return; // unknown frames are ignored (forward compatible)
    }
  }

  private routeStreamSubscribe(caller: Conn, frame: Extract<ClientFrame, { type: "stream_subscribe" }>): void {
    const fail = (error: RpcError) => this.send(caller, { type: "stream_open", id: frame.id, error });
    if (typeof frame.id !== "string" || typeof frame.to !== "string" || (frame.stream !== "terminal" && frame.stream !== "session")) {
      fail({ code: "bad_request", message: "stream_subscribe 需要 id、to、stream" });
      return;
    }
    const target = this.conns.get(frame.to);
    if (!target) {
      fail({ code: "offline", message: "这台电脑现在不在线" });
      return;
    }
    if (target.device.kind !== "host") {
      fail({ code: "forbidden", message: "只能订阅电脑端的流" });
      return;
    }
    if (this.streams.has(frame.id)) {
      fail({ code: "bad_request", message: "重复的流 id" });
      return;
    }
    this.streams.set(frame.id, { caller, target: frame.to });
    this.send(target, { type: "stream_subscribe", id: frame.id, from: caller.device.id, stream: frame.stream, params: frame.params });
  }

  /**
   * A connection is gone. Its hosts stop streaming to it (else they keep a
   * screen watch running for nobody, and refuse the same stream id when the
   * phone comes back); its viewers learn the stream ended, so they subscribe
   * again once the computer is back (older apps fall back to polling).
   */
  private endStreams(conn: Conn): void {
    for (const [id, s] of this.streams) {
      if (s.caller === conn) {
        this.streams.delete(id);
        const target = this.conns.get(s.target);
        if (target) this.send(target, { type: "stream_unsubscribe", id, from: conn.device.id });
      } else if (s.target === conn.device.id) {
        this.streams.delete(id);
        this.send(s.caller, { type: "stream_open", id, error: { code: "offline", message: "这台电脑断开了" } });
      }
    }
  }

  private routeStreamUnsubscribe(caller: Conn, frame: Extract<ClientFrame, { type: "stream_unsubscribe" }>): void {
    const s = this.streams.get(frame.id);
    if (!s || s.caller !== caller) return;
    this.streams.delete(frame.id);
    const target = this.conns.get(s.target);
    if (target) this.send(target, { type: "stream_unsubscribe", id: frame.id, from: caller.device.id });
  }

  private routeRpc(caller: Conn, frame: Extract<ClientFrame, { type: "rpc" }>): void {
    const { id: callerId, to, method, params } = frame;
    const fail = (error: RpcError) => this.send(caller, { type: "rpc_result", id: String(callerId), error });
    if (typeof callerId !== "string" || typeof to !== "string" || typeof method !== "string") {
      fail({ code: "bad_request", message: "rpc needs id, to and method" });
      return;
    }
    const from = caller.device.id;
    if (to === from) {
      fail({ code: "bad_request", message: "cannot call yourself through the relay" });
      return;
    }
    const target = this.conns.get(to);
    const audit = { method, from, target: to, params: method.startsWith("runtimeSessions.") ? undefined : params, t0: Date.now() };
    if (!target) {
      this.rpcEvent(audit, { code: "offline", message: "这台电脑现在不在线" });
      fail({ code: "offline", message: "这台电脑现在不在线" });
      return;
    }
    if (target.device.kind !== "host") {
      fail({ code: "forbidden", message: "只能调用电脑端（host）" });
      return;
    }
    const dispatch = caller.device.kind === "viewer" && (method === "runtimeSessions.send" || method === "runtimeSessions.answer") ? runtimeTaskDispatch(params) : undefined;
    const id = randomUUID();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      const error: RpcError = { code: "timeout", message: "电脑端没有及时回应" };
      this.rpcEvent(audit, error);
      fail(error);
    }, Math.max(this.opts.rpcTimeoutMs ?? 30_000, SLOW_RPC_MS[method] ?? 0));
    this.pending.set(id, { ...audit, caller, callerId, timer, runtimeTask: dispatch && { dispatch, target } });
    this.send(target, { type: "rpc", id, from, method, params });
  }

  private failPendingFor(deviceId: string): void {
    for (const [id, p] of this.pending) {
      if (p.target === deviceId) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        const error: RpcError = { code: "offline", message: "电脑端断开了连接" };
        this.rpcEvent(p, error);
        if ("resolve" in p.caller) p.caller.reject(new HostCallError(error));
        else this.send(p.caller, { type: "rpc_result", id: p.callerId, error });
      } else if (!("resolve" in p.caller) && p.caller.device.id === deviceId) {
        clearTimeout(p.timer);
        this.pending.delete(id);
      }
    }
  }

  private sweep(): void {
    const now = Date.now();
    this.runtimeTaskUploadRate.prune(now);
    try { this.store.pruneRuntimeTasks(now); } catch { /* Retry at the next sweep. */ }
    for (const c of this.conns.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
    for (const s of this.notifySubs) {
      if (!s.alive) {
        s.ws.terminate();
        this.notifySubs.delete(s);
        continue;
      }
      s.alive = false;
      s.ws.ping();
    }
  }

  // -------------------------------------------------------------------------

  private decorate(d: Device): Device {
    const live = this.conns.get(d.id);
    return {
      ...d,
      online: !!live,
      platform: live?.device.platform ?? d.platform,
      sources: live?.device.sources ?? d.sources,
      version: live?.device.version ?? d.version,
      lastSeenAt: live ? Date.now() : d.lastSeenAt,
    };
  }

  private devices(): Device[] {
    return this.store.listDevices().map((d) => this.decorate(d));
  }

  private allAgents(): Agent[] {
    return [...this.agents.values()].flat();
  }

  private send(conn: Conn, frame: ServerFrame): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(frame));
  }

  private broadcast(frame: ServerFrame, exceptId?: string): void {
    const data = JSON.stringify(frame);
    for (const c of this.conns.values()) {
      if (c.device.id !== exceptId && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  }
}

// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

function sendPage(res: ServerResponse, status: number, page: LandingPage, headOnly: boolean): void {
  res.writeHead(status, page.headers);
  res.end(headOnly ? undefined : page.html);
}

function sendError(res: ServerResponse, status: number, code: RpcError["code"], message: string): void {
  sendJson(res, status, { error: { code, message } });
}

/** A plain journal line as an event: "live: call ended" is kind live, "http error" is an error. */
function plainEvent(m: string): EventInput {
  const prefix = /^([a-z][a-z-]{1,20}):\s/i.exec(m);
  const kind = prefix && ["assistant", "live", "assistant notice"].includes(prefix[1]!.toLowerCase()) ? prefix[1]!.toLowerCase() : "relay";
  const msg = kind === "relay" ? m : m.slice(prefix![0].length);
  const level = /^http error/.test(m) ? "error" : /\b(fail(ed|ure)?|error|rejected|refused|timeout|dropped)\b/i.test(m) ? "warn" : "info";
  return { kind, level, msg };
}

/** What a mutating call was about, short; message text clipped. */
function rpcSummary(method: string, params: unknown): Record<string, unknown> | undefined {
  // Runtime operations are manual and private; never retain their inputs or target IDs.
  if (method.startsWith("runtimeSessions.")) return undefined;
  if (!params || typeof params !== "object") return undefined;
  const p = params as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["agent", "launcher", "space", "spaceName", "tabName", "folder", "command", "session"]) if (typeof p[k] === "string") out[k] = p[k];
  if (typeof p.text === "string") out.text = Array.from(p.text).slice(0, 200).join("");
  if (typeof p.task === "string") out.task = Array.from(p.task).slice(0, 200).join("");
  if (Array.isArray(p.keys)) out.keys = p.keys.slice(0, 16).join(" ");
  if (method === "herdr.command" && p.args && typeof p.args === "object") out.args = JSON.stringify(p.args).slice(0, 200);
  return Object.keys(out).length ? out : undefined;
}

async function readJson(req: IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  if (!size) return null;
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
