import { WebSocket, type RawData } from "ws";
import {
  isRuntimeId, isRuntimeRequestId, RUNTIME_SESSION_TEXT_LIMIT,
  type RuntimeProject, type RuntimeSession, type RuntimeSessionReceipt, type RuntimeSessionSend,
} from "@xiaoaixiaoai/protocol";

const OPERATION_MS = 8_000;
const MAX_PREFLIGHT_MS = 2_000;
const MAX_OPERATIONS = 5;
const MAX_THREADS = 100;
const MAX_PROJECTS = 20;
const LIST_BATCH = 8;
const MAX_LOADED_IDS = 2_048;
const MAX_FRAME = 256 * 1024;

const messages = {
  invalid_config: "Invalid Codex App Server configuration.",
  invalid_input: "Invalid Codex session input.",
  thread_not_allowed: "This exact Codex thread is not allowlisted for the project.",
  read_only: "This Codex thread is not enabled for sending.",
  thread_busy: "This Codex thread is busy; nothing was sent.",
  thread_not_loaded: "This Codex thread is not loaded in the configured App Server; nothing was sent.",
  thread_state_unverified: "Could not verify a fresh, idle Codex thread; nothing was sent.",
  thread_confirmation_required: "A prior Codex send may have been accepted. Check the original thread before re-enabling sends.",
  auth_failed: "Could not establish authenticated access to the Codex App Server.",
  unavailable: "The configured Codex App Server is unavailable.",
  protocol_error: "Unexpected response from the Codex App Server.",
  timeout: "Timed out waiting for the Codex App Server before dispatch.",
  aborted: "The Codex App Server operation was closed before dispatch.",
  rpc_rejected: "The Codex App Server rejected a read or initialization request.",
  turn_rejected: "The Codex App Server rejected the turn request.",
  turn_acceptance_unknown: "Codex may have accepted the turn. Check the original thread; do not resend automatically.",
} as const;

export type CodexRuntimeErrorCode = keyof typeof messages;

/** Safe to report: never contains the token, prompt, endpoint, or raw server error. */
export class CodexRuntimeError extends Error {
  readonly code: CodexRuntimeErrorCode;
  constructor(code: CodexRuntimeErrorCode) {
    super(messages[code]);
    this.name = "CodexRuntimeError";
    this.code = code;
  }
}

interface AllowedThread {
  id: string;
  projectId: string;
  projectTitle: string;
  /** Explicit write grant; the operator must prevent concurrent input from other clients. */
  canSend?: boolean;
}

interface CodexRuntimeOptions {
  url: string;
  token: string;
  threads: readonly AllowedThread[];
}

interface AppServerParams {
  initialize: { clientInfo: { name: string; title: string; version: string } };
  "thread/loaded/list": Record<string, never>;
  "thread/read": { threadId: string; includeTurns: false };
  "turn/start": { threadId: string; input: [{ type: "text"; text: string }] };
}

interface Pending {
  turn: boolean;
  resolve: (result: unknown) => void;
  reject: (error: CodexRuntimeError) => void;
}

type ThreadChange = "thread_busy" | "thread_not_loaded" | "thread_state_unverified";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function loopbackEndpoint(value: unknown): string {
  // Check the literal before WHATWG URL normalization (which accepts IP aliases).
  const match = typeof value === "string" ? /^ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/.exec(value) : null;
  if (!match || match[0] !== value || Number(match[1]) > 65535) throw new CodexRuntimeError("invalid_config");
  return `ws://127.0.0.1:${match[1]}/`;
}

function label(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length > 4_096) return fallback;
  return Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim()).slice(0, 120).join("") || fallback;
}

function rpcId(value: unknown): value is number | string {
  return typeof value === "number" ? Number.isSafeInteger(value)
    : typeof value === "string" && value.length <= 256;
}

function stateOf(value: unknown): RuntimeSession["state"] {
  const status = record(value);
  switch (status?.type) {
    case "notLoaded": return "inactive";
    case "idle": return status.activeFlags === undefined ? "idle" : "unknown";
    case "systemError": return "attention";
    case "active": return Array.isArray(status.activeFlags) && status.activeFlags.some(
      (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
    ) ? "attention" : "running";
    default: return "unknown";
  }
}

function readThread(value: unknown, expectedId: string): { title: string; state: RuntimeSession["state"] } {
  const thread = record(record(value)?.thread);
  if (thread?.id !== expectedId || (thread.turns !== undefined && (!Array.isArray(thread.turns) || thread.turns.length !== 0))) {
    throw new CodexRuntimeError("protocol_error");
  }
  // `preview` may be the first prompt. Only a thread name is display metadata.
  return { title: label(thread.name, `Codex ${expectedId}`), state: stateOf(thread.status) };
}

class Deadline {
  #controller = new AbortController();
  #end = performance.now() + OPERATION_MS;
  #timer = setTimeout(() => this.stop("timeout"), OPERATION_MS);
  readonly signal = this.#controller.signal;

  check(): void {
    if (performance.now() >= this.#end) this.stop("timeout");
    this.signal.throwIfAborted();
  }

  stop(code: "aborted" | "timeout"): void {
    clearTimeout(this.#timer);
    this.#controller.abort(new CodexRuntimeError(code));
  }
}

function websocket(url: string, token?: string): WebSocket {
  try {
    return new WebSocket(url, {
      agent: false,
      followRedirects: false,
      maxPayload: MAX_FRAME,
      perMessageDeflate: false,
      ...(token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } }),
    });
  } catch {
    throw new CodexRuntimeError("unavailable");
  }
}

function unauthorized(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

/** A bearer on a successful upgrade alone does not tell us auth is enabled. */
async function requireAuthentication(url: string, deadline: Deadline): Promise<void> {
  deadline.check();
  const socket = websocket(url);
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const abort = () => finish(deadline.signal.reason);
    const finish = (error?: CodexRuntimeError) => {
      if (done) return;
      done = true;
      deadline.signal.removeEventListener("abort", abort);
      socket.terminate();
      if (error) reject(error); else resolve();
    };
    socket.on("open", () => finish(new CodexRuntimeError("auth_failed")));
    socket.on("error", () => finish(new CodexRuntimeError("unavailable")));
    socket.on("close", () => finish(new CodexRuntimeError("unavailable")));
    socket.on("unexpected-response", (_request, response) => {
      finish(unauthorized(response.statusCode) ? undefined : new CodexRuntimeError("unavailable"));
      response.destroy();
    });
    deadline.signal.addEventListener("abort", abort, { once: true });
  });
}

class AppServerWire {
  #socket: WebSocket;
  #deadline: Deadline;
  #watch: (id: string) => boolean;
  #ready: Promise<void>;
  #rejectReady?: (error: CodexRuntimeError) => void;
  #failure?: CodexRuntimeError;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #changes = new Map<string, ThreadChange>();

  constructor(url: string, token: string, deadline: Deadline, watch: (id: string) => boolean) {
    deadline.check();
    this.#deadline = deadline;
    this.#watch = watch;
    this.#socket = websocket(url, token);
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#rejectReady = reject;
      this.#socket.once("open", () => { this.#rejectReady = undefined; resolve(); });
    });
    this.#socket.on("message", (data, isBinary) => this.#receive(data, isBinary));
    this.#socket.on("error", () => this.#stop(new CodexRuntimeError("unavailable")));
    this.#socket.on("close", () => this.#stop(new CodexRuntimeError("unavailable")));
    this.#socket.on("unexpected-response", (_request, response) => {
      this.#stop(new CodexRuntimeError(unauthorized(response.statusCode) ? "auth_failed" : "unavailable"));
      response.destroy();
    });
    deadline.signal.addEventListener("abort", this.#abort, { once: true });
  }

  readonly #abort = () => this.#stop(this.#deadline.signal.reason);

  #stop(error: CodexRuntimeError): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#deadline.signal.removeEventListener("abort", this.#abort);
    this.#rejectReady?.(error);
    this.#rejectReady = undefined;
    for (const call of this.#pending.values()) {
      call.reject(call.turn ? new CodexRuntimeError("turn_acceptance_unknown") : error);
    }
    this.#pending.clear();
    this.#socket.terminate();
  }

  // Notifications can veto a snapshot, never authorize a send. Do not answer
  // server-initiated requests, even if their IDs collide with our own requests.
  #observe(method: string, params: unknown, request: boolean): void {
    const p = record(params);
    const id = p?.threadId;
    if (typeof id !== "string" || !this.#watch(id)) return;
    if (request || method === "turn/started") this.#changes.set(id, "thread_busy");
    else if (method === "thread/closed" || method === "thread/deleted" || method === "thread/archived") {
      this.#changes.set(id, "thread_not_loaded");
    } else if (method === "thread/reverted" || method === "turn/completed") this.#changes.set(id, "thread_state_unverified");
    else if (method === "thread/status/changed") {
      const state = stateOf(p?.status);
      if (state === "running" || state === "attention") this.#changes.set(id, "thread_busy");
      else if (state === "inactive") this.#changes.set(id, "thread_not_loaded");
      else if (state !== "idle") this.#changes.set(id, "thread_state_unverified");
    }
  }

  #receive(data: RawData, binary: boolean): void {
    if (this.#failure) return;
    try { this.#deadline.check(); } catch { return; }
    const invalid = () => this.#stop(new CodexRuntimeError("protocol_error"));
    if (binary || !Buffer.isBuffer(data)) return invalid();
    let frame: Record<string, unknown> | undefined;
    try { frame = record(JSON.parse(data.toString("utf8"))); } catch { return invalid(); }
    if (!frame || (frame.jsonrpc !== undefined && frame.jsonrpc !== "2.0")) return invalid();
    const hasId = Object.hasOwn(frame, "id");
    const hasResult = Object.hasOwn(frame, "result");
    const hasError = Object.hasOwn(frame, "error");
    if (Object.hasOwn(frame, "method")) {
      if (typeof frame.method !== "string" || !frame.method || frame.method.length > 128 ||
          hasResult || hasError || (hasId && !rpcId(frame.id))) return invalid();
      this.#observe(frame.method, frame.params, hasId);
      return;
    }
    if (!rpcId(frame.id) || hasResult === hasError) return invalid();
    if (typeof frame.id !== "number") return;
    const call = this.#pending.get(frame.id);
    if (!call) return;
    const rpcError = hasError ? record(frame.error) : undefined;
    if (hasError && (!rpcError || typeof rpcError.code !== "number" || !Number.isSafeInteger(rpcError.code) ||
        typeof rpcError.message !== "string")) return invalid();
    this.#pending.delete(frame.id);
    if (!rpcError) call.resolve(frame.result);
    else if (!call.turn) call.reject(new CodexRuntimeError("rpc_rejected"));
    // Only documented admission/validation failures establish non-acceptance.
    else if (rpcError.code === -32001 || rpcError.code === -32600 || rpcError.code === -32601 || rpcError.code === -32602) {
      call.reject(new CodexRuntimeError("turn_rejected"));
    } else call.reject(new CodexRuntimeError("turn_acceptance_unknown"));
  }

  check(): void {
    this.#deadline.check();
    if (this.#failure) throw this.#failure;
    if (this.#socket.readyState !== WebSocket.OPEN) throw new CodexRuntimeError("unavailable");
  }

  change(id: string): ThreadChange | undefined {
    return this.#changes.get(id);
  }

  #write(encoded: string): void {
    try {
      this.#socket.send(encoded, (error) => { if (error) this.#stop(new CodexRuntimeError("unavailable")); });
    } catch {
      this.#stop(new CodexRuntimeError("unavailable"));
    }
  }

  request<M extends keyof AppServerParams>(method: M, params: AppServerParams[M]): Promise<unknown> {
    this.check();
    const id = this.#nextId++;
    const encoded = JSON.stringify({ method, id, params });
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { turn: method === "turn/start", resolve, reject });
      this.#write(encoded);
    });
  }

  async initialize(): Promise<void> {
    await this.#ready;
    const agent = record(await this.request("initialize", {
      clientInfo: { name: "xiaoaixiaoai_hostd", title: "小爱小爱", version: "0.1.0" },
    }))?.userAgent;
    if (typeof agent !== "string" || !agent.trim() || agent.length > 4_096) throw new CodexRuntimeError("protocol_error");
    this.check();
    this.#write(JSON.stringify({ method: "initialized", params: {} }));
  }

  async loaded(): Promise<Set<string>> {
    const result = record(await this.request("thread/loaded/list", {}));
    const ids: unknown = result?.data;
    if (!Array.isArray(ids) || ids.length > MAX_LOADED_IDS ||
        (result?.nextCursor !== undefined && result.nextCursor !== null) || !ids.every(isRuntimeId)) {
      throw new CodexRuntimeError("protocol_error");
    }
    return new Set(ids.filter(this.#watch));
  }
}

/** Talks only to an explicitly provisioned, existing, authenticated App Server. */
export class CodexRuntime {
  #url: string;
  #token: string;
  #threads = new Map<string, AllowedThread>();
  #operations = new Set<Deadline>();
  #writing = new Set<string>();
  #uncertain = new Set<string>();
  #closed = false;

  constructor(options: CodexRuntimeOptions) {
    if (!options) throw new CodexRuntimeError("invalid_config");
    this.#url = loopbackEndpoint(options.url);
    if (typeof options.token !== "string" || options.token.length > 4_096 ||
        /^[A-Za-z0-9._~+/-]+=*$/.exec(options.token)?.[0] !== options.token ||
        !Array.isArray(options.threads) || options.threads.length > MAX_THREADS) {
      throw new CodexRuntimeError("invalid_config");
    }
    this.#token = options.token;
    const titles = new Map<string, string>();
    for (const t of options.threads) {
      if (!t || !isRuntimeId(t.id) || this.#threads.has(t.id) || !isRuntimeId(t.projectId) ||
          typeof t.projectTitle !== "string" || t.projectTitle.length > 4_096 ||
          (t.canSend !== undefined && typeof t.canSend !== "boolean")) throw new CodexRuntimeError("invalid_config");
      const title = label(t.projectTitle, "Codex");
      const previous = titles.get(t.projectId);
      if (previous !== undefined && previous !== title) throw new CodexRuntimeError("invalid_config");
      titles.set(t.projectId, title);
      if (titles.size > MAX_PROJECTS) throw new CodexRuntimeError("invalid_config");
      this.#threads.set(t.id, { id: t.id, projectId: t.projectId, projectTitle: title, canSend: t.canSend === true });
    }
  }

  async #run<T>(watch: (id: string) => boolean, fn: (wire: AppServerWire) => Promise<T>): Promise<T> {
    if (this.#closed) throw new CodexRuntimeError("aborted");
    if (this.#operations.size >= MAX_OPERATIONS) throw new CodexRuntimeError("unavailable");
    const deadline = new Deadline();
    this.#operations.add(deadline);
    try {
      await requireAuthentication(this.#url, deadline);
      const wire = new AppServerWire(this.#url, this.#token, deadline, watch);
      await wire.initialize();
      return await fn(wire);
    } finally {
      deadline.stop("aborted");
      this.#operations.delete(deadline);
    }
  }

  async list(): Promise<RuntimeProject[]> {
    if (this.#closed) throw new CodexRuntimeError("aborted");
    const threads = [...this.#threads.values()];
    if (!threads.length) return [];
    return this.#run((id) => this.#threads.has(id), async (wire) => {
      const started = performance.now();
      const loaded = await wire.loaded();
      const metadata: Array<ReturnType<typeof readThread>> = [];
      for (let i = 0; i < threads.length; i += LIST_BATCH) {
        const batch = await Promise.all(threads.slice(i, i + LIST_BATCH).map(async (t) => {
          try {
            return readThread(await wire.request("thread/read", { threadId: t.id, includeTurns: false }), t.id);
          } catch (error) {
            // A stale configured ID must not make other allowed rows disappear.
            if (error instanceof CodexRuntimeError && error.code === "rpc_rejected") {
              return { title: `Codex ${t.id}`, state: "unknown" as const };
            }
            throw error;
          }
        }));
        metadata.push(...batch);
      }
      wire.check();
      const fresh = performance.now() - started <= MAX_PREFLIGHT_MS;
      const projects = new Map<string, RuntimeProject>();
      threads.forEach((t, i) => {
        const info = metadata[i]!;
        const consistent = loaded.has(t.id) ? info.state !== "inactive" : info.state === "inactive";
        const state = consistent && !wire.change(t.id) ? info.state : "unknown";
        const canSend = t.canSend === true && state === "idle" && fresh && !this.#writing.has(t.id) && !this.#uncertain.has(t.id);
        let project = projects.get(t.projectId);
        if (!project) {
          project = { runtime: "codex", id: t.projectId, title: t.projectTitle, sessions: [] };
          projects.set(t.projectId, project);
        }
        project.sessions.push({ id: t.id, title: info.title, state, canSend });
      });
      return [...projects.values()];
    });
  }

  async send(input: RuntimeSessionSend): Promise<RuntimeSessionReceipt> {
    const p = record(input);
    if (!p || Object.keys(p).some((key) => !["runtime", "projectId", "sessionId", "requestId", "text"].includes(key)) ||
        p.runtime !== "codex" || !isRuntimeId(p.projectId) || !isRuntimeId(p.sessionId) || !isRuntimeRequestId(p.requestId) ||
        typeof p.text !== "string" || p.text.length > RUNTIME_SESSION_TEXT_LIMIT || !p.text.trim() || p.text.includes("\0")) {
      throw new CodexRuntimeError("invalid_input");
    }
    const { sessionId, projectId, requestId, text } = p;
    const t = this.#threads.get(sessionId);
    if (!t || t.projectId !== projectId) throw new CodexRuntimeError("thread_not_allowed");
    if (t.canSend !== true) throw new CodexRuntimeError("read_only");
    if (this.#uncertain.has(sessionId)) throw new CodexRuntimeError("thread_confirmation_required");
    if (this.#writing.has(sessionId)) throw new CodexRuntimeError("thread_busy");
    this.#writing.add(sessionId);
    try {
      return await this.#run((id) => id === sessionId, async (wire) => {
        const started = performance.now();
        if (!(await wire.loaded()).has(sessionId)) throw new CodexRuntimeError("thread_not_loaded");
        const snapshot = readThread(await wire.request("thread/read", { threadId: sessionId, includeTurns: false }), sessionId);
        const changed = wire.change(sessionId);
        if (changed) throw new CodexRuntimeError(changed);
        if (snapshot.state === "inactive") throw new CodexRuntimeError("thread_not_loaded");
        if (snapshot.state === "running" || snapshot.state === "attention") throw new CodexRuntimeError("thread_busy");
        if (snapshot.state !== "idle" || performance.now() - started > MAX_PREFLIGHT_MS) {
          throw new CodexRuntimeError("thread_state_unverified");
        }
        // There is no atomic only-if-idle parameter. The explicit write grant
        // requires single-writer operation outside this fresh same-wire check.
        const result = record(await wire.request("turn/start", { threadId: sessionId, input: [{ type: "text", text }] }));
        const turn = record(result?.turn);
        if (turn?.status !== "inProgress" || !isRuntimeId(turn.id) ||
            (result?.threadId !== undefined && result.threadId !== sessionId) ||
            (turn.threadId !== undefined && turn.threadId !== sessionId)) {
          throw new CodexRuntimeError("turn_acceptance_unknown");
        }
        return { accepted: true, requestId, receiptId: turn.id };
      });
    } catch (error) {
      if (error instanceof CodexRuntimeError && error.code === "turn_acceptance_unknown") this.#uncertain.add(sessionId);
      throw error;
    } finally {
      this.#writing.delete(sessionId);
    }
  }

  close(): void {
    this.#closed = true;
    this.#token = "";
    for (const operation of this.#operations) operation.stop("aborted");
  }
}
