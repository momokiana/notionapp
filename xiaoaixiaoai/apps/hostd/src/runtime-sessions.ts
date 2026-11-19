import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  DSH_ARCHIVE, DSH_UNFILED, DSH_DIRECTORY_PAGE_SIZE, DSH_DIRECTORY_SEARCH_LIMIT, isRuntimeId, isRuntimeRequestId, RUNTIME_SESSION_TEXT_LIMIT,
  RUNTIME_TASK_EVENTS_LIMIT, RUNTIME_TASK_EVENT_KINDS,
  type DshDirectoryProject, type DshDirectoryReply, type DshDirectoryRequest,
  type RpcErrorCode, type RuntimeCatalog, type RuntimeProject, type RuntimeSession, type RuntimeSessionReceipt, type RuntimeSessionSend, type RuntimeTaskEvent, type SessionRuntime,
} from "@xiaoaixiaoai/protocol";
import { CodexRuntime, CodexRuntimeError } from "./codex-runtime.ts";

const MAX_CONFIG = 48 * 1024;
const MAX_REPLY = 192 * 1024;
const MAX_CLAIMS = 10_000;
const states = new Set(["running", "idle", "attention", "inactive", "unknown"]);
const uid = process.getuid?.();

export class RuntimeError extends Error {
  readonly code: RpcErrorCode;
  constructor(code: RpcErrorCode, message: string) { super(message); this.code = code; }
}
const UNKNOWN = () => new RuntimeError("outcome_unknown", "没收到明确回执。请在原会话核对，不要重发。 ");
const OFFLINE = () => new RuntimeError("offline", "本机连接器不可用，请检查电脑端配置。");
const INVALID = () => new RuntimeError("bad_request", "会话或请求参数无效。");

export interface RuntimeAdapter {
  list(): Promise<RuntimeProject[]>;
  send(input: RuntimeSessionSend): Promise<RuntimeSessionReceipt>;
  close?(): void;
}

function row(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const r = row(value);
  if (!r || Object.keys(r).some((k) => !fields.includes(k))) throw INVALID();
  return r;
}
function label(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length > 4096) return fallback;
  return Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim()).slice(0, 120).join("") || fallback;
}
function canonical(path: string): boolean {
  if (!isAbsolute(path) || normalize(path) !== path) return false;
  const resolved = realpathSync(path);
  return process.platform === "win32" ? resolved.toLowerCase() === path.toLowerCase() : resolved === path;
}
function privateDirectory(path: string): boolean {
  const s = lstatSync(path);
  return s.isDirectory() && canonical(path) && (uid === undefined || (s.uid === uid && (s.mode & 0o077) === 0));
}
function readPrivateText(path: string, limit: number): string {
  if (!privateDirectory(dirname(path)) || !canonical(path)) throw INVALID();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.size > limit || (uid !== undefined && (s.uid !== uid || (s.mode & 0o077) !== 0))) throw INVALID();
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
function readPrivate(path: string, limit: number): unknown { return JSON.parse(readPrivateText(path, limit)); }

/** Never accept paths, history, prompts, or executable values returned by a bridge. */
function projects(runtime: SessionRuntime, value: unknown): RuntimeProject[] {
  if (!Array.isArray(value) || value.length > 20) throw OFFLINE();
  const projectIds = new Set<string>();
  let count = 0;
  return value.map((raw) => {
    const p = row(raw);
    if (!p || !isRuntimeId(p.id) || projectIds.has(p.id) || !Array.isArray(p.sessions)) throw OFFLINE();
    projectIds.add(p.id);
    const sessionIds = new Set<string>();
    const sessions: RuntimeSession[] = p.sessions.map((rawSession: unknown) => {
      const s = row(rawSession);
      if (++count > 100 || !s || !isRuntimeId(s.id) || sessionIds.has(s.id) || typeof s.state !== "string" || !states.has(s.state)) throw OFFLINE();
      sessionIds.add(s.id);
      return { id: s.id, title: label(s.title, "未命名会话"), state: s.state as RuntimeSession["state"], canSend: s.canSend === true };
    });
    return { runtime, id: p.id, title: label(p.title, "未命名项目"), sessions };
  });
}

function directoryRequest(value: unknown): DshDirectoryRequest {
  const v = row(value);
  if (v?.view === "exact") {
    exact(v, ["view", "sessionIds"]);
    if (!Array.isArray(v.sessionIds) || !v.sessionIds.length || v.sessionIds.length > DSH_DIRECTORY_PAGE_SIZE ||
        !v.sessionIds.every(isRuntimeId) || new Set(v.sessionIds).size !== v.sessionIds.length) throw INVALID();
    return { view: "exact", sessionIds: v.sessionIds };
  }
  if (v?.view !== "projects" && v?.view !== "sessions") throw INVALID();
  const cursor = v.after;
  if (cursor !== undefined && !isRuntimeId(cursor)) throw INVALID();
  const page = cursor === undefined ? {} : { after: cursor };
  if (v.view === "projects") {
    exact(v, ["view", "after"]);
    return { view: "projects", ...page };
  }
  exact(v, ["view", "after", "projectId", "search"]);
  const { search, projectId } = v;
  if ((projectId !== undefined && !isRuntimeId(projectId)) || (search !== undefined &&
      (typeof search !== "string" || search.length > DSH_DIRECTORY_SEARCH_LIMIT || /[\p{Cc}\p{Cf}\uD800-\uDFFF]/u.test(search)))) throw INVALID();
  return { view: "sessions", ...page, ...(projectId !== undefined && { projectId }), ...(search !== undefined && { search }) };
}

function directoryReply(value: unknown, input: DshDirectoryRequest): DshDirectoryReply {
  const v = row(value);
  if (!v || v.view !== input.view || (v.scope !== "profile" && v.scope !== "selected")) throw OFFLINE();
  const scope = v.scope;
  const named = (raw: unknown, fallback: string): DshDirectoryProject => {
    const r = row(raw);
    if (!r || !isRuntimeId(r.id)) throw OFFLINE();
    const safe = typeof r.title === "string" && !/[/\\\uD800-\uDFFF]/u.test(r.title) ? label(r.title, fallback) : fallback;
    return { id: r.id, title: safe };
  };
  const bounded = (raw: unknown): unknown[] => {
    if (!Array.isArray(raw) || raw.length > DSH_DIRECTORY_PAGE_SIZE) throw OFFLINE();
    return raw;
  };
  const paged = (ids: string[], after?: string) => {
    let previous = after ?? "";
    for (const id of ids) { if (id <= previous) throw OFFLINE(); previous = id; }
    if (v.next === undefined) return {};
    if (ids.length !== DSH_DIRECTORY_PAGE_SIZE || !isRuntimeId(v.next) || v.next !== ids.at(-1)) throw OFFLINE();
    return { next: v.next };
  };
  if (input.view === "projects") {
    const rows = bounded(v.projects).map((p) => named(p, "未命名项目"));
    if (scope === "selected" && rows.some((p) => p.id === DSH_ARCHIVE || p.id === DSH_UNFILED)) throw OFFLINE();
    return { view: "projects", scope, projects: rows, ...paged(rows.map((p) => p.id), input.after) };
  }
  const seen = new Set<string>();
  const entries = bounded(v.entries).map((raw) => {
    const item = row(raw);
    const project = named(item?.project, "未命名项目");
    const s = row(item?.session);
    const sessionName = named(s, "未命名会话");
    if (!s || typeof s.state !== "string" || !states.has(s.state) || typeof item?.archived !== "boolean" ||
        seen.has(sessionName.id) || (item.archived !== (project.id === DSH_ARCHIVE)) ||
        (scope === "selected" && (item.archived || project.id === DSH_UNFILED))) throw OFFLINE();
    seen.add(sessionName.id);
    const state = item.archived ? "inactive" : s.state as RuntimeSession["state"];
    // The local DSH plugin is authoritative for an eligible unfiled or explicitly
    // resumable row in profile mode. Never trust an archived or unknown row.
    const canSend = !item.archived && s.canSend === true && (state === "idle" || state === "running" || (scope === "profile" && state === "inactive"));
    return { project, session: { ...sessionName, state, canSend }, archived: item.archived };
  });
  if (input.view === "exact") {
    if (v.next !== undefined || entries.some((e) => !input.sessionIds.includes(e.session.id))) throw OFFLINE();
    return { view: "exact", scope, entries };
  }
  if (input.projectId !== undefined && entries.some((e) => e.project.id !== input.projectId)) throw OFFLINE();
  return { view: "sessions", scope, entries, ...paged(entries.map((e) => e.session.id), input.after) };
}

class DshRuntime implements RuntimeAdapter {
  private readonly socket: string;
  constructor(socket: string) {
    if (process.platform !== "linux" || !isAbsolute(socket) || normalize(socket) !== socket || Buffer.byteLength(socket) > 103 || /[\x00-\x1f]/.test(socket)) throw INVALID();
    this.socket = socket;
  }

  private exchange(path: "/v1/catalog" | "/v1/send" | "/v2/browse" | "/v3/task-events", body?: string): Promise<unknown> {
    const sending = path === "/v1/send";
    try {
      const s = lstatSync(this.socket);
      if (!s.isSocket() || s.uid !== uid || (s.mode & 0o777) !== 0o600 || !privateDirectory(dirname(this.socket))) throw OFFLINE();
    } catch { return Promise.reject(OFFLINE()); }
    return new Promise((resolve, reject) => {
      const failed = () => reject(sending ? UNKNOWN() : OFFLINE());
      const req = request({
        socketPath: this.socket, method: body === undefined ? "GET" : "POST", path, agent: false,
        headers: body === undefined ? undefined : { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        signal: AbortSignal.timeout(8_000),
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          // 4xx responses are explicit refusal by the pinned local bridge, not a delivery receipt.
          if (sending && res.statusCode === 403) reject(new RuntimeError("forbidden", "这个 DSH 会话未授权发送。"));
          else if (sending && (res.statusCode === 404 || res.statusCode === 409)) reject(new RuntimeError("not_found", "目标不在线或已不在允许的项目中。"));
          else if (path === "/v2/browse" && res.statusCode === 404) reject(new RuntimeError("unsupported", "请更新这台电脑的 DSH 连接插件。"));
          else failed();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          if ((size += chunk.length) > MAX_REPLY) { failed(); req.destroy(); }
          else chunks.push(chunk);
        });
        res.on("error", failed);
        res.on("aborted", failed);
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { failed(); }
        });
      });
      req.on("error", failed);
      req.end(body);
    });
  }

  async list(): Promise<RuntimeProject[]> {
    return projects("dsh", row(await this.exchange("/v1/catalog"))?.projects);
  }

  private activeReads = 0;

  async browse(input: DshDirectoryRequest): Promise<DshDirectoryReply> {
    if (this.activeReads >= 3) throw new RuntimeError("offline", "DSH 目录正忙，请稍后刷新。");
    this.activeReads++;
    try { return directoryReply(await this.exchange("/v2/browse", JSON.stringify(input)), input); }
    finally { this.activeReads--; }
  }

  async taskEvents(): Promise<RuntimeTaskEvent[]> {
    const reply = row(await this.exchange("/v3/task-events", "{}"));
    if (!reply || Object.keys(reply).length !== 1 || !Array.isArray(reply.events) || reply.events.length > RUNTIME_TASK_EVENTS_LIMIT) throw OFFLINE();
    const seen = new Set<string>();
    return reply.events.map((value: unknown) => {
      const e = row(value);
      if (!e || Object.keys(e).length !== 3 || !isRuntimeRequestId(e.eventId) || !isRuntimeRequestId(e.requestId) ||
          e.eventId !== e.eventId.toLowerCase() || e.requestId !== e.requestId.toLowerCase() || seen.has(e.eventId) ||
          !RUNTIME_TASK_EVENT_KINDS.some((kind) => kind === e.kind)) throw OFFLINE();
      seen.add(e.eventId);
      return { eventId: e.eventId, requestId: e.requestId, kind: e.kind as RuntimeTaskEvent["kind"] };
    });
  }

  async send({ projectId, sessionId, requestId, text }: RuntimeSessionSend): Promise<RuntimeSessionReceipt> {
    const result = row(await this.exchange("/v1/send", JSON.stringify({ projectId, sessionId, requestId, text })));
    if (result?.accepted !== true || result.requestId !== requestId) throw UNKNOWN();
    return { accepted: true, requestId };
  }
}

/** Claim before dispatch. An interrupted attempt stays fenced across host restarts. */
class DispatchLedger {
  private readonly dir: string;
  constructor(dir: string) { this.dir = dir; }
  private prepare() {
    try { mkdirSync(this.dir, { mode: 0o700 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    if (!privateDirectory(this.dir)) throw OFFLINE();
  }
  private put(path: string, data: object) {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(data)); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  claim(key: string, digest: string): RuntimeSessionReceipt | undefined {
    this.prepare();
    const path = join(this.dir, key + ".claim");
    try { this.put(path, { digest }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let existing: unknown;
      try { existing = readPrivate(path, 512); } catch { throw UNKNOWN(); }
      if (row(existing)?.digest !== digest) throw INVALID();
      try {
        const a = row(readPrivate(join(this.dir, key + ".receipt"), 512));
        if (a?.accepted === true && a.requestId === key) return { accepted: true, requestId: key, ...(isRuntimeId(a.receiptId) ? { receiptId: a.receiptId } : {}) };
      } catch { /* missing or torn receipt: never send again */ }
      throw UNKNOWN();
    }
  }
  record(key: string, receipt: RuntimeSessionReceipt) { this.put(join(this.dir, key + ".receipt"), receipt); }
}

export class RuntimeSessions {
  private loading?: Promise<RuntimeCatalog>;
  private ledger: DispatchLedger;
  private sent = 0;
  readonly viewerId: string;
  private readonly adapters: Partial<Record<SessionRuntime, RuntimeAdapter>>;
  constructor(viewerId: string, adapters: Partial<Record<SessionRuntime, RuntimeAdapter>>, ledgerDir: string) {
    this.viewerId = viewerId;
    this.adapters = { ...adapters };
    this.ledger = new DispatchLedger(ledgerDir);
  }
  list(): Promise<RuntimeCatalog> {
    if (this.loading) return this.loading;
    this.loading = Promise.all((["dsh", "codex"] as const).flatMap((runtime) => {
      const adapter = this.adapters[runtime];
      if (!adapter) return [];
      return [Promise.resolve().then(() => adapter.list()).then((ps) => ({ runtime, online: true, projects: projects(runtime, ps) }))
        .catch(() => ({ runtime, online: false, projects: [] as RuntimeProject[] }))];
    })).then((rs) => ({ runtimes: rs.map(({ runtime, online }) => ({ runtime, online })), projects: rs.flatMap((r) => r.projects) }))
      .finally(() => { this.loading = undefined; });
    return this.loading;
  }
  get hasDirectory(): boolean { return this.adapters.dsh instanceof DshRuntime; }

  taskEvents(): Promise<RuntimeTaskEvent[]> {
    const adapter = this.adapters.dsh;
    return adapter instanceof DshRuntime ? adapter.taskEvents() : Promise.resolve([]);
  }

  browse(input: unknown): Promise<DshDirectoryReply> {
    const adapter = this.adapters.dsh;
    if (!(adapter instanceof DshRuntime)) throw new RuntimeError("unsupported", "这台电脑没有配置 DSH 目录。");
    return adapter.browse(directoryRequest(input));
  }

  async send(input: unknown): Promise<RuntimeSessionReceipt> {
    const p = exact(input, ["runtime", "projectId", "sessionId", "requestId", "input"]);
    if ((p.runtime !== "dsh" && p.runtime !== "codex") || !isRuntimeId(p.projectId) || !isRuntimeId(p.sessionId) ||
      !isRuntimeRequestId(p.requestId) || typeof p.input !== "string" || p.input.length > RUNTIME_SESSION_TEXT_LIMIT || /[\uD800-\uDFFF]/u.test(p.input) || !p.input.trim() || p.input.includes("\0")) throw INVALID();
    const adapter = this.adapters[p.runtime];
    if (!adapter) throw OFFLINE();
    // Canonicalize public request IDs and exclude extra input fields from the fence.
    const target: RuntimeSessionSend = { runtime: p.runtime, projectId: p.projectId, sessionId: p.sessionId, requestId: p.requestId.toLowerCase(), text: p.input };
    if (this.sent >= MAX_CLAIMS) throw new RuntimeError("unsupported", "本次电脑端运行已达发送上限。 ");
    const digest = createHash("sha256").update(JSON.stringify([this.viewerId, target.runtime, target.projectId, target.sessionId, target.text])).digest("hex");
    let old: RuntimeSessionReceipt | undefined;
    try { old = this.ledger.claim(target.requestId, digest); }
    catch (e) { if (e instanceof RuntimeError) throw e; throw OFFLINE(); }
    if (old) return old;
    this.sent++;
    let result: RuntimeSessionReceipt;
    try { result = await adapter.send(target); }
    catch (e) {
      if (e instanceof RuntimeError) throw e;
      if (e instanceof CodexRuntimeError) {
        if (["thread_busy", "thread_not_loaded", "thread_state_unverified"].includes(e.code)) throw new RuntimeError("not_found", "未确认这是当前运行时的空闲 Codex 会话，没有发送。");
        if (e.code === "thread_not_allowed" || e.code === "read_only") throw new RuntimeError("forbidden", "这个会话未授权发送。");
        if (e.code === "turn_rejected") throw new RuntimeError("bad_request", "Codex 拒绝了这次请求，没有确认接收。");
      }
      throw UNKNOWN();
    }
    if (result?.accepted !== true || result.requestId !== target.requestId) throw UNKNOWN();
    const receipt: RuntimeSessionReceipt = { accepted: true, requestId: target.requestId, ...(isRuntimeId(result.receiptId) ? { receiptId: result.receiptId } : {}) };
    try { this.ledger.record(target.requestId, receipt); } catch { /* the claim still prevents a duplicate */ }
    return receipt;
  }
  close() { for (const adapter of Object.values(this.adapters)) adapter.close?.(); }
}

/** Explicit local config only. Never search DSH/Codex history, sockets or auth files. */
export function loadRuntimeSessions(path: string | undefined): RuntimeSessions | undefined {
  if (path === undefined) return undefined;
  try {
    const cfg = exact(readPrivate(path, MAX_CONFIG), ["viewerId", "dsh", "codex"]);
    if (!isRuntimeId(cfg.viewerId)) throw INVALID();
    const adapters: Partial<Record<SessionRuntime, RuntimeAdapter>> = {};
    if (cfg.dsh !== undefined) {
      const d = exact(cfg.dsh, ["socketPath"]);
      if (typeof d.socketPath !== "string") throw INVALID();
      adapters.dsh = new DshRuntime(d.socketPath);
    }
    if (cfg.codex !== undefined) {
      const c = exact(cfg.codex, ["url", "tokenFile", "threads", "exclusiveWriter"]);
      if (typeof c.url !== "string" || typeof c.tokenFile !== "string" || !Array.isArray(c.threads) || !c.threads.length || c.threads.length > 100) throw INVALID();
      const token = readPrivateText(c.tokenFile, 512).trim();
      if (c.exclusiveWriter !== undefined && typeof c.exclusiveWriter !== "boolean") throw INVALID();
      const threads = c.threads.map((item: unknown) => {
        const t = exact(item, ["id", "projectId", "projectTitle", "canSend"]);
        if (!isRuntimeId(t.id) || !isRuntimeId(t.projectId) || typeof t.projectTitle !== "string" || (t.canSend !== undefined && typeof t.canSend !== "boolean")) throw INVALID();
        // A normal Desktop session is NOT exclusive. This must be a verified same-server, single-writer setup.
        return { id: t.id, projectId: t.projectId, projectTitle: label(t.projectTitle, "Codex"), canSend: c.exclusiveWriter === true && t.canSend === true };
      });
      adapters.codex = new CodexRuntime({ url: c.url, token, threads });
    }
    if (!Object.keys(adapters).length) throw INVALID();
    return new RuntimeSessions(cfg.viewerId, adapters, join(dirname(path), "runtime-dispatch"));
  } catch {
    throw new RuntimeError("bad_request", "电脑端会话连接配置无效：请检查专用目录权限、允许的手机及连接器设置。");
  }
}
