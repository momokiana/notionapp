import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  DSH_ARCHIVE, DSH_UNFILED, DSH_DIRECTORY_PAGE_SIZE, DSH_DIRECTORY_SEARCH_LIMIT,
  isRuntimeId, isRuntimeRequestId, RUNTIME_DETAIL_LIMIT, RUNTIME_SESSION_TEXT_LIMIT,
  RUNTIME_TASK_EVENTS_LIMIT, RUNTIME_TASK_EVENT_KINDS,
  type DshDirectoryProject, type DshDirectoryReply, type DshDirectoryRequest,
  type RpcErrorCode, type RuntimeCatalog, type RuntimePendingQuestion, type RuntimeProject, type RuntimeQuestionItem,
  type RuntimeSession, type RuntimeSessionAnswer, type RuntimeSessionDetail, type RuntimeSessionMessage,
  type RuntimeSessionReceipt, type RuntimeSessionSend, type RuntimeTaskEvent, type SessionRuntime,
} from "@xiaoaixiaoai/protocol";
import { AntigravityRuntime } from "./antigravity-runtime.ts";
import { CodexLocalRuntime } from "./codex-local-runtime.ts";
import { CodexRuntime, CodexRuntimeError } from "./codex-runtime.ts";

const MAX_CONFIG = 48 * 1024;
const MAX_REPLY = 512 * 1024;
const MAX_CLAIMS = 10_000;
const states = new Set(["running", "idle", "inactive", "attention", "unknown"]);
const RUNTIMES: readonly SessionRuntime[] = ["dsh", "codex", "antigravity"];
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
  browse?(input: DshDirectoryRequest): Promise<DshDirectoryReply>;
  detail?(projectId: string, sessionId: string, limit?: number): Promise<RuntimeSessionDetail>;
  answer?(input: RuntimeSessionAnswer): Promise<RuntimeSessionReceipt>;
  taskEvents?(): Promise<RuntimeTaskEvent[]> | RuntimeTaskEvent[];
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
function readPrivateText(rawPath: string, limit: number): string {
  const path = normalize(rawPath);
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
      return {
        id: s.id,
        title: label(s.title, "未命名会话"),
        state: s.state as RuntimeSession["state"],
        canSend: s.canSend === true,
        ...(typeof s.updatedAt === "number" && Number.isSafeInteger(s.updatedAt) && s.updatedAt > 0 ? { updatedAt: s.updatedAt } : {}),
      };
    });
    return { runtime, id: p.id, title: label(p.title, "未命名项目"), sessions };
  });
}

function runtimeOf(value: unknown): SessionRuntime | undefined {
  return value === "dsh" || value === "codex" || value === "antigravity" ? value : undefined;
}

function directoryRequest(value: unknown): DshDirectoryRequest {
  const v = row(value);
  const rt = v?.runtime;
  if (rt !== undefined && !runtimeOf(rt)) throw INVALID();
  const withRt = rt === undefined ? {} : { runtime: rt as SessionRuntime };
  if (v?.view === "exact") {
    exact(v, ["view", "sessionIds", "runtime"]);
    if (!Array.isArray(v.sessionIds) || !v.sessionIds.length || v.sessionIds.length > DSH_DIRECTORY_PAGE_SIZE ||
        !v.sessionIds.every(isRuntimeId) || new Set(v.sessionIds).size !== v.sessionIds.length) throw INVALID();
    return { ...withRt, view: "exact", sessionIds: v.sessionIds };
  }
  if (v?.view !== "projects" && v?.view !== "sessions") throw INVALID();
  const cursor = v.after;
  if (cursor !== undefined && !isRuntimeId(cursor)) throw INVALID();
  const page = cursor === undefined ? {} : { after: cursor };
  if (v.view === "projects") {
    exact(v, ["view", "after", "runtime"]);
    return { ...withRt, view: "projects", ...page };
  }
  exact(v, ["view", "after", "projectId", "search", "runtime"]);
  const { search, projectId } = v;
  if ((projectId !== undefined && !isRuntimeId(projectId)) || (search !== undefined &&
      (typeof search !== "string" || search.length > DSH_DIRECTORY_SEARCH_LIMIT || /[\p{Cc}\p{Cf}\uD800-\uDFFF]/u.test(search)))) throw INVALID();
  return { ...withRt, view: "sessions", ...page, ...(projectId !== undefined && { projectId }), ...(search !== undefined && { search }) };
}

function directoryReply(value: unknown, input: DshDirectoryRequest): DshDirectoryReply {
  const v = row(value);
  if (!v || v.view !== input.view || (v.scope !== "profile" && v.scope !== "selected")) throw OFFLINE();
  if (v.runtime !== undefined && !runtimeOf(v.runtime)) throw OFFLINE();
  const scope = v.scope;
  const replyRuntime = runtimeOf(v.runtime) ?? input.runtime;
  const withReplyRt = v.runtime !== undefined ? { runtime: v.runtime as SessionRuntime } : {};
  const named = (raw: unknown, fallback: string): DshDirectoryProject => {
    const r = row(raw);
    if (!r || !isRuntimeId(r.id)) throw OFFLINE();
    if (r.runtime !== undefined && !runtimeOf(r.runtime)) throw OFFLINE();
    const safe = typeof r.title === "string" && !/[/\\\uD800-\uDFFF]/u.test(r.title) ? label(r.title, fallback) : fallback;
    return { id: r.id, title: safe, ...(r.runtime !== undefined ? { runtime: r.runtime as SessionRuntime } : {}) };
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
    return { ...withReplyRt, view: "projects", scope, projects: rows, ...paged(rows.map((p) => p.id), input.after) };
  }
  const seen = new Set<string>();
  const entries = bounded(v.entries).map((raw) => {
    const item = row(raw);
    if (item?.runtime !== undefined && !runtimeOf(item.runtime)) throw OFFLINE();
    const project = named(item?.project, "未命名项目");
    const s = row(item?.session);
    const sessionName = named(s, "未命名会话");
    if (!s || typeof s.state !== "string" || !states.has(s.state) || typeof item?.archived !== "boolean" ||
        seen.has(sessionName.id) || (item.archived !== (project.id === DSH_ARCHIVE)) ||
        (scope === "selected" && (item.archived || project.id === DSH_UNFILED))) throw OFFLINE();
    seen.add(sessionName.id);
    const state = item.archived ? "inactive" : s.state as RuntimeSession["state"];
    const entryRuntime = runtimeOf(item.runtime) ?? project.runtime ?? replyRuntime;
    const canSend = !item.archived && s.canSend === true && entryRuntime !== "antigravity" && (
      state === "idle" || state === "running" || state === "attention" || (scope === "profile" && entryRuntime !== "codex" && state === "inactive")
    );
    const updatedAt = typeof s.updatedAt === "number" && Number.isSafeInteger(s.updatedAt) && s.updatedAt > 0 ? s.updatedAt : undefined;
    return {
      ...(item.runtime !== undefined ? { runtime: item.runtime as SessionRuntime } : {}),
      project,
      session: { id: sessionName.id, title: sessionName.title, state, canSend, ...(updatedAt !== undefined ? { updatedAt } : {}) },
      archived: item.archived,
    };
  });
  if (input.view === "exact") {
    if (v.next !== undefined || entries.some((e) => !input.sessionIds.includes(e.session.id))) throw OFFLINE();
    return { ...withReplyRt, view: "exact", scope, entries };
  }
  if (input.projectId !== undefined && entries.some((e) => e.project.id !== input.projectId)) throw OFFLINE();
  return { ...withReplyRt, view: "sessions", scope, entries, ...paged(entries.map((e) => e.session.id), input.after) };
}

class DshRuntime implements RuntimeAdapter {
  private readonly socket: string;
  constructor(socket: string) {
    if (process.platform !== "linux" || !isAbsolute(socket) || normalize(socket) !== socket || Buffer.byteLength(socket) > 103 || /[\x00-\x1f]/.test(socket)) throw INVALID();
    this.socket = socket;
  }

  private exchange(path: "/v1/catalog" | "/v1/send" | "/v2/browse" | "/v3/task-events" | "/v4/detail" | "/v4/answer", body?: string): Promise<unknown> {
    const mutating = path === "/v1/send" || path === "/v4/answer";
    try {
      const s = lstatSync(this.socket);
      if (!s.isSocket() || s.uid !== uid || (s.mode & 0o777) !== 0o600 || !privateDirectory(dirname(this.socket))) throw OFFLINE();
    } catch { return Promise.reject(OFFLINE()); }
    return new Promise((resolve, reject) => {
      const failed = () => reject(mutating ? UNKNOWN() : OFFLINE());
      const req = request({
        socketPath: this.socket, method: body === undefined ? "GET" : "POST", path, agent: false,
        headers: body === undefined ? undefined : { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        signal: AbortSignal.timeout(8_000),
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          // 4xx responses are explicit refusal by the pinned local bridge, not a delivery receipt.
          if (mutating && res.statusCode === 400) reject(INVALID());
          else if (mutating && res.statusCode === 403) reject(new RuntimeError("forbidden", "这个 DSH 会话未授权执行该操作。"));
          else if (mutating && (res.statusCode === 404 || res.statusCode === 409)) reject(new RuntimeError("not_found", "目标不在线、问题已过期或不在允许的项目中。"));
          else if ((path === "/v2/browse" || path === "/v4/detail" || path === "/v4/answer") && res.statusCode === 404) {
            reject(path === "/v4/detail" ? new RuntimeError("not_found", "未找到目标会话或当前 DSH 插件版本较旧。") : new RuntimeError("unsupported", "请更新这台电脑的 DSH 连接插件。"));
          } else failed();
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

  async detail(projectId: string, sessionId: string, limit = 60): Promise<RuntimeSessionDetail> {
    const reply = row(await this.exchange("/v4/detail", JSON.stringify({ projectId, sessionId, limit })));
    if (!reply) throw OFFLINE();
    return sanitizeDetail("dsh", reply);
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

  async answer({ projectId, sessionId, requestId, callId, answers }: RuntimeSessionAnswer): Promise<RuntimeSessionReceipt> {
    const result = row(await this.exchange("/v4/answer", JSON.stringify({ projectId, sessionId, requestId, callId, answers })));
    if (result?.accepted !== true || result.requestId !== requestId) throw UNKNOWN();
    return { accepted: true, requestId };
  }
}

function clipMessageText(value: unknown, max = 6000): string {
  if (typeof value !== "string") return "";
  const chars = Array.from(value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\p{Cf}]/gu, " "));
  return (chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("")).trim();
}

function sanitizeDetail(runtime: SessionRuntime, raw: Record<string, unknown>): RuntimeSessionDetail {
  const project = row(raw.project);
  const session = row(raw.session);
  if (!project || !isRuntimeId(project.id) || !session || !isRuntimeId(session.id) ||
      typeof session.state !== "string" || !states.has(session.state)) {
    throw OFFLINE();
  }
  const safeProjectTitle = typeof project.title === "string" && !/[/\\\uD800-\uDFFF]/u.test(project.title)
    ? label(project.title, "未命名项目") : "未命名项目";
  const rawMessages = Array.isArray(raw.messages) ? raw.messages.slice(-RUNTIME_DETAIL_LIMIT) : [];
  const messages: RuntimeSessionMessage[] = [];
  for (const item of rawMessages) {
    const m = row(item);
    if (!m || typeof m.id !== "string" || (m.role !== "user" && m.role !== "assistant" && m.role !== "tool" && m.role !== "system")) continue;
    const text = clipMessageText(m.text, 6000);
    if (!text) continue;
    messages.push({
      id: m.id.slice(0, 128),
      role: m.role,
      text,
      ...(typeof m.ts === "number" && Number.isSafeInteger(m.ts) && m.ts > 0 ? { ts: m.ts } : {}),
      ...(typeof m.toolName === "string" && m.toolName ? { toolName: label(m.toolName, "tool") } : {}),
      ...(typeof m.isError === "boolean" ? { isError: m.isError } : {}),
    });
  }
  const rawQuestions = Array.isArray(raw.pendingQuestions) ? raw.pendingQuestions.slice(0, 16) : [];
  const pendingQuestions: RuntimePendingQuestion[] = [];
  for (const item of rawQuestions) {
    const qWrap = row(item);
    if (!qWrap || typeof qWrap.callId !== "string" || !qWrap.callId ||
        (qWrap.state !== "open" && qWrap.state !== "continued" && qWrap.state !== "readonly") ||
        !Array.isArray(qWrap.questions)) continue;
    const questions: RuntimeQuestionItem[] = [];
    for (const rq of qWrap.questions.slice(0, 16)) {
      const q = row(rq);
      if (!q || typeof q.id !== "string" || !q.id) continue;
      const question = clipMessageText(q.question, 2000);
      if (!question) continue;
      const options = Array.isArray(q.options)
        ? q.options
          .map(row)
          .filter((o): o is Record<string, unknown> => o !== undefined)
          .slice(0, 32)
          .map((o) => ({
            label: clipMessageText(o.label, 400),
            ...(typeof o.description === "string" && o.description ? { description: clipMessageText(o.description, 1000) } : {}),
          }))
          .filter((o) => Boolean(o.label))
        : undefined;
      questions.push({
        id: q.id.slice(0, 128),
        ...(typeof q.header === "string" && q.header ? { header: clipMessageText(q.header, 200) } : {}),
        question,
        ...(typeof q.detail === "string" && q.detail ? { detail: clipMessageText(q.detail, 4000) } : {}),
        ...(options?.length ? { options } : {}),
        ...(q.multiSelect === true ? { multiSelect: true } : {}),
      });
    }
    if (questions.length) {
      pendingQuestions.push({
        callId: qWrap.callId.slice(0, 128),
        state: runtime === "antigravity" ? "readonly" : qWrap.state,
        questions,
      });
    }
  }
  const updatedAt = typeof session.updatedAt === "number" && Number.isSafeInteger(session.updatedAt) && session.updatedAt > 0
    ? session.updatedAt : undefined;
  return {
    runtime,
    project: { id: project.id, title: safeProjectTitle },
    session: {
      id: session.id,
      title: label(session.title, "未命名会话"),
      state: session.state as RuntimeSession["state"],
      canSend: runtime !== "antigravity" && session.canSend === true,
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    },
    messages,
    pendingQuestions,
    ...(typeof raw.readOnlyReason === "string" && raw.readOnlyReason ? { readOnlyReason: clipMessageText(raw.readOnlyReason, 400) } : {}),
  };
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
    this.loading = Promise.all(RUNTIMES.flatMap((runtime) => {
      const adapter = this.adapters[runtime];
      if (!adapter) return [];
      return [Promise.resolve().then(() => adapter.list()).then((ps) => ({ runtime, online: true, projects: projects(runtime, ps) }))
        .catch(() => ({ runtime, online: false, projects: [] as RuntimeProject[] }))];
    })).then((rs) => ({ runtimes: rs.map(({ runtime, online }) => ({ runtime, online })), projects: rs.flatMap((r) => r.projects) }))
      .finally(() => { this.loading = undefined; });
    return this.loading;
  }
  get hasDirectory(): boolean { return this.adapters.dsh instanceof DshRuntime; }
  get hasTaskEvents(): boolean {
    return Object.values(this.adapters).some((adapter) => typeof adapter?.taskEvents === "function");
  }

  async taskEvents(): Promise<RuntimeTaskEvent[]> {
    const lists = await Promise.all(
      Object.values(this.adapters)
        .filter((adapter): adapter is RuntimeAdapter => typeof adapter?.taskEvents === "function")
        .map((adapter) => Promise.resolve().then(() => adapter.taskEvents!()).catch(() => [] as RuntimeTaskEvent[])),
    );
    return lists.flat().slice(-RUNTIME_TASK_EVENTS_LIMIT);
  }

  browse(input: unknown): Promise<DshDirectoryReply> {
    const req = directoryRequest(input);
    const runtime = req.runtime ?? "dsh";
    const adapter = this.adapters[runtime];
    if (!adapter || typeof adapter.browse !== "function") {
      throw new RuntimeError("unsupported", "这台电脑没有配置所选运行时的会话目录。");
    }
    return Promise.resolve().then(() => adapter.browse!(req)).then((reply) => directoryReply(reply, req));
  }

  async detail(input: unknown): Promise<RuntimeSessionDetail> {
    const p = exact(input, ["runtime", "projectId", "sessionId", "limit"]);
    const runtime = runtimeOf(p.runtime);
    if (!runtime || !isRuntimeId(p.projectId) || !isRuntimeId(p.sessionId) ||
        (p.limit !== undefined && (typeof p.limit !== "number" || !Number.isSafeInteger(p.limit) || p.limit < 1 || p.limit > RUNTIME_DETAIL_LIMIT))) {
      throw INVALID();
    }
    const adapter = this.adapters[runtime];
    if (!adapter) throw OFFLINE();
    if (typeof adapter.detail !== "function") {
      throw new RuntimeError("unsupported", "当前运行时暂不支持读取会话详情。");
    }
    const raw = await adapter.detail(p.projectId, p.sessionId, p.limit);
    return sanitizeDetail(runtime, raw as unknown as Record<string, unknown>);
  }

  async send(input: unknown): Promise<RuntimeSessionReceipt> {
    const p = exact(input, ["runtime", "projectId", "sessionId", "requestId", "input"]);
    const runtime = runtimeOf(p.runtime);
    if (!runtime || !isRuntimeId(p.projectId) || !isRuntimeId(p.sessionId) ||
      !isRuntimeRequestId(p.requestId) || typeof p.input !== "string" || p.input.length > RUNTIME_SESSION_TEXT_LIMIT || /[\uD800-\uDFFF]/u.test(p.input) || !p.input.trim() || p.input.includes("\0")) throw INVALID();
    if (runtime === "antigravity") throw new RuntimeError("forbidden", "Antigravity 会话当前仅支持查看，不支持从手机发送消息。");
    const adapter = this.adapters[runtime];
    if (!adapter) throw OFFLINE();
    // Canonicalize public request IDs and exclude extra input fields from the fence.
    const target: RuntimeSessionSend = { runtime, projectId: p.projectId, sessionId: p.sessionId, requestId: p.requestId.toLowerCase(), text: p.input };
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

  async answer(input: unknown): Promise<RuntimeSessionReceipt> {
    const p = exact(input, ["runtime", "projectId", "sessionId", "requestId", "callId", "answers"]);
    const runtime = runtimeOf(p.runtime);
    if (!runtime || !isRuntimeId(p.projectId) || !isRuntimeId(p.sessionId) || !isRuntimeRequestId(p.requestId) ||
        typeof p.callId !== "string" || !p.callId.length || p.callId.length > 128 || !Array.isArray(p.answers) || p.answers.length === 0 || p.answers.length > 16) {
      throw INVALID();
    }
    if (runtime === "antigravity") throw new RuntimeError("forbidden", "Antigravity 会话当前仅支持查看，不支持从手机回答问题。");
    const answers = p.answers.map((raw) => {
      const a = exact(raw, ["id", "selected", "custom"]);
      if (typeof a.id !== "string" || !a.id.length || a.id.length > 128 || !Array.isArray(a.selected) || a.selected.length > 32 ||
          !a.selected.every((s) => typeof s === "string" && s.length > 0 && s.length <= 512) ||
          (a.custom !== undefined && (typeof a.custom !== "string" || a.custom.length > 2000 || /[\0\uD800-\uDFFF]/u.test(a.custom)))) {
        throw INVALID();
      }
      return {
        id: a.id,
        selected: a.selected as string[],
        ...(typeof a.custom === "string" && a.custom.trim() ? { custom: a.custom } : {}),
      };
    });
    const adapter = this.adapters[runtime];
    if (!adapter) throw OFFLINE();
    if (typeof adapter.answer !== "function") {
      throw new RuntimeError("unsupported", "当前运行时不支持从手机直接提交选择。");
    }
    const target: RuntimeSessionAnswer = {
      runtime,
      projectId: p.projectId,
      sessionId: p.sessionId,
      requestId: p.requestId.toLowerCase(),
      callId: p.callId,
      answers,
    };
    if (this.sent >= MAX_CLAIMS) throw new RuntimeError("unsupported", "本次电脑端运行已达操作上限。");
    const digest = createHash("sha256").update(JSON.stringify(["answer", this.viewerId, target.runtime, target.projectId, target.sessionId, target.callId, target.answers])).digest("hex");
    let old: RuntimeSessionReceipt | undefined;
    try { old = this.ledger.claim(target.requestId, digest); }
    catch (e) { if (e instanceof RuntimeError) throw e; throw OFFLINE(); }
    if (old) return old;
    this.sent++;
    let result: RuntimeSessionReceipt;
    try { result = await adapter.answer(target); }
    catch (e) {
      if (e instanceof RuntimeError) throw e;
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
    const cfg = exact(readPrivate(path, MAX_CONFIG), ["viewerId", "dsh", "codex", "codexLocal", "antigravity"]);
    if (!isRuntimeId(cfg.viewerId)) throw INVALID();
    if (cfg.codex !== undefined && cfg.codexLocal !== undefined) throw INVALID();
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
    if (cfg.codexLocal !== undefined) {
      const c = exact(cfg.codexLocal, ["codexHome", "codexBin", "enableSend"]);
      if (typeof c.codexHome !== "string" || (c.codexBin !== undefined && typeof c.codexBin !== "string") ||
          (c.enableSend !== undefined && typeof c.enableSend !== "boolean")) throw INVALID();
      adapters.codex = new CodexLocalRuntime({ codexHome: c.codexHome, codexBin: c.codexBin, enableSend: c.enableSend === true });
    }
    if (cfg.antigravity !== undefined) {
      const a = exact(cfg.antigravity, ["brainDir"]);
      if (typeof a.brainDir !== "string") throw INVALID();
      adapters.antigravity = new AntigravityRuntime({ brainDir: a.brainDir });
    }
    if (!Object.keys(adapters).length) throw INVALID();
    return new RuntimeSessions(cfg.viewerId, adapters, join(dirname(path), "runtime-dispatch"));
  } catch {
    throw new RuntimeError("bad_request", "电脑端会话连接配置无效：请检查专用目录权限、允许的手机及连接器设置。");
  }
}
