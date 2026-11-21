import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  DSH_ARCHIVE, DSH_UNFILED, DSH_DIRECTORY_PAGE_SIZE, DSH_DIRECTORY_SEARCH_LIMIT,
  isRuntimeId, isRuntimeRequestId, RUNTIME_DETAIL_LIMIT, RUNTIME_SESSION_TEXT_LIMIT,
  RUNTIME_TASK_EVENTS_LIMIT, RUNTIME_TASK_EVENT_KINDS,
  type DshDirectoryProject, type DshDirectoryReply, type DshDirectoryRequest,
  type LaunchOption, type ModelQuota, type QuotaWindow, type RpcErrorCode, type RuntimeCatalog, type RuntimePendingQuestion, type RuntimeProject, type RuntimeQuestionItem,
  type RuntimeSession, type RuntimeSessionAnswer, type RuntimeSessionDetail, type RuntimeSessionMessage,
  type RuntimeSessionReceipt, type RuntimeSessionSend, type RuntimeTaskEvent, type SessionRuntime, type SpaceInfo, type SubSession,
} from "@xiaoaixiaoai/protocol";
import { AntigravityRuntime } from "./antigravity-runtime.ts";
import { CodexLocalRuntime } from "./codex-local-runtime.ts";
import { CodexRuntime, CodexRuntimeError } from "./codex-runtime.ts";
import { LocalVoiceBridge, type LocalVoiceOptions } from "./local-voice.ts";

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

export interface RuntimeKnownFolder {
  id: string;
  title: string;
  path?: string;
  updatedAt?: number;
}

export interface RuntimeCreateInput {
  cwd?: string;
  projectId?: string;
  task?: string;
  requestId?: string;
}

export interface RuntimeCreatedSession {
  projectId: string;
  projectTitle?: string;
  sessionId: string;
  title: string;
  cwd?: string;
  state: RuntimeSession["state"];
  receiptId?: string;
}

export interface RuntimeAdapter {
  readonly sendEnabled?: boolean;
  list(): Promise<RuntimeProject[]>;
  send(input: RuntimeSessionSend): Promise<RuntimeSessionReceipt>;
  browse?(input: DshDirectoryRequest): Promise<DshDirectoryReply>;
  detail?(projectId: string, sessionId: string, limit?: number): Promise<RuntimeSessionDetail>;
  answer?(input: RuntimeSessionAnswer): Promise<RuntimeSessionReceipt>;
  taskEvents?(): Promise<RuntimeTaskEvent[]> | RuntimeTaskEvent[];
  knownFolders?(): Promise<RuntimeKnownFolder[]> | RuntimeKnownFolder[];
  create?(input: RuntimeCreateInput): Promise<RuntimeCreatedSession>;
  interrupt?(projectId: string, sessionId: string): Promise<{ interrupted: boolean }>;
  children?(sessionId: string): Array<Omit<SubSession, "key"> & { sessionId: string }> | Promise<Array<Omit<SubSession, "key"> & { sessionId: string }>>;
  descends?(sessionId: string, rootSessionId: string): boolean | Promise<boolean>;
  close?(): void;
}

export interface UnifiedRuntimeEntry {
  runtime: SessionRuntime;
  projectId: string;
  projectTitle: string;
  session: RuntimeSession;
  sendConfigured: boolean;
}

/** Encode a runtime target into an unambiguous `Agent.localId` (`~` is excluded from `isRuntimeId`). */
export function encodeRuntimeLocalId(runtime: SessionRuntime, projectId: string, sessionId: string): string {
  return `${runtime}~${projectId}~${sessionId}`;
}

/** Encode a runtime target into an unambiguous `Agent.sessionKey` / `SessionInfo.key`. */
export function encodeRuntimeSessionKey(runtime: SessionRuntime, projectId: string, sessionId: string): string {
  return `runtime~${runtime}~${projectId}~${sessionId}`;
}

/** Parse either `localId` (`<runtime>~<projectId>~<sessionId>`) or `sessionKey` (`runtime~...`). */
export function parseRuntimeTarget(value: string): { runtime: SessionRuntime; projectId: string; sessionId: string } | null {
  if (typeof value !== "string" || !value) return null;
  const raw = value.startsWith("runtime~") ? value.slice("runtime~".length) : value;
  const parts = raw.split("~");
  if (parts.length !== 3) return null;
  const runtime = runtimeOf(parts[0]);
  if (!runtime || !isRuntimeId(parts[1]) || !isRuntimeId(parts[2])) return null;
  return { runtime, projectId: parts[1], sessionId: parts[2] };
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

function sanitizeQuotaWindow(raw: unknown): QuotaWindow | undefined {
  const w = row(raw);
  if (!w || typeof w.remainingPercent !== "number" || !Number.isFinite(w.remainingPercent)) return undefined;
  const remainingPercent = Math.max(0, Math.min(100, Math.round(w.remainingPercent * 10) / 10));
  return {
    remainingPercent,
    ...(typeof w.windowMinutes === "number" && Number.isSafeInteger(w.windowMinutes) && w.windowMinutes > 0 ? { windowMinutes: w.windowMinutes } : {}),
    ...(typeof w.resetsAt === "number" && Number.isSafeInteger(w.resetsAt) && w.resetsAt > 0 ? { resetsAt: w.resetsAt } : {}),
    ...(typeof w.label === "string" && w.label.trim() ? { label: label(w.label, "") } : {}),
  };
}

function sanitizeModelQuota(raw: unknown): ModelQuota | undefined {
  const q = row(raw);
  if (!q || typeof q.available !== "boolean") return undefined;
  const primary = sanitizeQuotaWindow(q.primary);
  const secondary = sanitizeQuotaWindow(q.secondary);
  const balance = typeof q.balance === "string" && q.balance.trim() ? label(q.balance, "").slice(0, 32) : undefined;
  const plan = typeof q.plan === "string" && q.plan.trim() ? label(q.plan, "").slice(0, 60) : undefined;
  const updatedAt = typeof q.updatedAt === "number" && Number.isSafeInteger(q.updatedAt) && q.updatedAt > 0 ? q.updatedAt : undefined;
  const note = typeof q.note === "string" && q.note.trim() ? label(q.note, "").slice(0, 120) : undefined;
  if (!q.available && !note && !plan) return undefined;
  if (q.available && !primary && !secondary && !balance) return undefined;
  return {
    available: q.available,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(balance ? { balance } : {}),
    ...(plan ? { plan } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(note ? { note } : {}),
  };
}

function sessionTelemetry(raw: Record<string, unknown>): Pick<RuntimeSession, "model" | "contextTokens" | "contextLimit" | "modelQuota"> {
  const model = typeof raw.model === "string" && raw.model.trim() ? label(raw.model, "").slice(0, 80) : undefined;
  const contextTokens = typeof raw.contextTokens === "number" && Number.isSafeInteger(raw.contextTokens) && raw.contextTokens >= 0 ? raw.contextTokens : undefined;
  const contextLimit = typeof raw.contextLimit === "number" && Number.isSafeInteger(raw.contextLimit) && raw.contextLimit > 0 ? raw.contextLimit : undefined;
  const modelQuota = sanitizeModelQuota(raw.modelQuota);
  return {
    ...(model ? { model } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(contextLimit !== undefined ? { contextLimit } : {}),
    ...(modelQuota ? { modelQuota } : {}),
  };
}

function subagentCounts(raw: Record<string, unknown>): { subagents?: number; subagentsWorking?: number } {
  const out: { subagents?: number; subagentsWorking?: number } = {};
  if (typeof raw.subagents === "number" && Number.isSafeInteger(raw.subagents) && raw.subagents >= 0) {
    out.subagents = raw.subagents;
  }
  if (typeof raw.subagentsWorking === "number" && Number.isSafeInteger(raw.subagentsWorking) && raw.subagentsWorking >= 0) {
    out.subagentsWorking = raw.subagentsWorking;
  }
  return out;
}

/** Never accept paths, history, prompts, or executable values returned by a bridge. */
function projects(runtime: SessionRuntime, value: unknown, allowAntigravitySend = false): RuntimeProject[] {
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
        canSend: (runtime !== "antigravity" || allowAntigravitySend) && s.canSend === true,
        ...sessionTelemetry(s),
        ...(typeof s.updatedAt === "number" && Number.isSafeInteger(s.updatedAt) && s.updatedAt > 0 ? { updatedAt: s.updatedAt } : {}),
        ...subagentCounts(s),
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

function directoryReply(value: unknown, input: DshDirectoryRequest, allowAntigravitySend = false): DshDirectoryReply {
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
    const entryRuntime = runtimeOf(item?.runtime) ?? project.runtime ?? replyRuntime;
    const isDsh = entryRuntime === undefined || entryRuntime === "dsh";
    if (!s || typeof s.state !== "string" || !states.has(s.state) || typeof item?.archived !== "boolean" ||
        seen.has(sessionName.id) || (isDsh ? item.archived !== (project.id === DSH_ARCHIVE) : project.id === DSH_ARCHIVE) ||
        (scope === "selected" && (item.archived || project.id === DSH_UNFILED))) throw OFFLINE();
    seen.add(sessionName.id);
    const state = item.archived ? "inactive" : s.state as RuntimeSession["state"];
    const canSend = !item.archived && s.canSend === true && (entryRuntime !== "antigravity" || allowAntigravitySend) && (
      state === "idle" || state === "running" || state === "attention" || (scope === "profile" && entryRuntime !== "codex" && state === "inactive")
    );
    const updatedAt = typeof s.updatedAt === "number" && Number.isSafeInteger(s.updatedAt) && s.updatedAt > 0 ? s.updatedAt : undefined;
    return {
      ...(item.runtime !== undefined ? { runtime: item.runtime as SessionRuntime } : {}),
      project,
      session: { id: sessionName.id, title: sessionName.title, state, canSend, ...sessionTelemetry(s), ...(updatedAt !== undefined ? { updatedAt } : {}), ...subagentCounts(s) },
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

export class DshRuntime implements RuntimeAdapter {
  private readonly socket: string;
  constructor(socket: string) {
    if (process.platform !== "linux" || !isAbsolute(socket) || normalize(socket) !== socket || Buffer.byteLength(socket) > 103 || /[\x00-\x1f]/.test(socket)) throw INVALID();
    this.socket = socket;
  }

  private exchange(path: "/v1/catalog" | "/v1/send" | "/v2/browse" | "/v3/task-events" | "/v4/detail" | "/v4/answer" | "/v5/create" | "/v5/cancel", body?: string): Promise<unknown> {
    const mutating = path === "/v1/send" || path === "/v4/answer" || path === "/v5/create" || path === "/v5/cancel";
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
          const isV5 = path === "/v5/create" || path === "/v5/cancel";
          if (isV5 && res.statusCode === 501) {
            res.resume();
            reject(new RuntimeError("unsupported", "请更新这台电脑的 DSH 连接插件。"));
            return;
          }
          if (isV5 && res.statusCode === 404) {
            const errChunks: Buffer[] = [];
            let errLen = 0;
            res.on("data", (c: Buffer) => {
              if (errLen < 1024) { errChunks.push(c); errLen += c.length; }
            });
            res.on("end", () => {
              try {
                const parsed = JSON.parse(Buffer.concat(errChunks).toString("utf8")) as { error?: string };
                if (parsed?.error === "route_not_found") {
                  reject(new RuntimeError("unsupported", "请更新这台电脑的 DSH 连接插件。"));
                  return;
                }
              } catch {}
              reject(new RuntimeError("not_found", "目标不在线、问题已过期或不在允许的项目中。"));
            });
            return;
          }
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
    const { runtime: _ignoredRuntime, ...wireInput } = input;
    try { return directoryReply(await this.exchange("/v2/browse", JSON.stringify(wireInput)), input); }
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

  async knownFolders(): Promise<RuntimeKnownFolder[]> {
    const reply = await this.browse({ runtime: "dsh", view: "projects" });
    if (reply.view !== "projects") return [];
    return reply.projects
      .filter((p) => p.id !== DSH_UNFILED && p.id !== DSH_ARCHIVE)
      .map((p) => ({ id: p.id, title: p.title }));
  }

  async create({ projectId, cwd, task, requestId }: RuntimeCreateInput): Promise<RuntimeCreatedSession> {
    const result = row(await this.exchange("/v5/create", JSON.stringify({
      ...(projectId ? { projectId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(task ? { task } : {}),
      ...(requestId ? { requestId } : {}),
    })));
    if (!result || !isRuntimeId(result.projectId) || !isRuntimeId(result.sessionId)) throw UNKNOWN();
    const stateStr = typeof result.state === "string" && states.has(result.state) ? (result.state as RuntimeSession["state"]) : (task ? "running" : "idle");
    const projectTitle = typeof result.projectTitle === "string" && result.projectTitle.trim() ? label(result.projectTitle, "DSH") : undefined;
    return {
      projectId: result.projectId,
      ...(projectTitle ? { projectTitle } : {}),
      sessionId: result.sessionId,
      title: label(task || projectTitle, `DSH ${result.sessionId.slice(0, 8)}`),
      state: stateStr,
      ...(isRuntimeId(result.receiptId) ? { receiptId: result.receiptId } : {}),
    };
  }

  async interrupt(projectId: string, sessionId: string): Promise<{ interrupted: boolean }> {
    const result = row(await this.exchange("/v5/cancel", JSON.stringify({ projectId, sessionId })));
    if (!result || typeof result.interrupted !== "boolean") throw UNKNOWN();
    return { interrupted: result.interrupted };
  }
}

function clipMessageText(value: unknown, max = 6000): string {
  if (typeof value !== "string") return "";
  const chars = Array.from(value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\p{Cf}]/gu, " "));
  return (chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("")).trim();
}

function sanitizeDetail(runtime: SessionRuntime, raw: Record<string, unknown>, allowAntigravitySend = false): RuntimeSessionDetail {
  const project = row(raw.project);
  const session = row(raw.session);
  if (!project || !isRuntimeId(project.id) || !session || !isRuntimeId(session.id) ||
      typeof session.state !== "string" || !states.has(session.state)) {
    throw OFFLINE();
  }
  const safeProjectTitle = typeof project.title === "string" && !/[/\\\uD800-\uDFFF]/u.test(project.title)
    ? label(project.title, "未命名项目") : "未命名项目";
  const canSend = (runtime !== "antigravity" || allowAntigravitySend) && session.canSend === true;
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
        state: runtime === "antigravity" && !canSend ? "readonly" : qWrap.state,
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
      canSend,
      ...sessionTelemetry(session),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...subagentCounts(session),
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
  readonly publishAgents: boolean;
  readonly allowAssistant: boolean;
  readonly localVoice?: LocalVoiceBridge;
  private readonly adapters: Partial<Record<SessionRuntime, RuntimeAdapter>>;
  constructor(
    viewerId: string,
    adapters: Partial<Record<SessionRuntime, RuntimeAdapter>>,
    ledgerDir: string,
    options: { publishAgents?: boolean; allowAssistant?: boolean; localVoice?: LocalVoiceBridge } = {},
  ) {
    this.viewerId = viewerId;
    this.adapters = { ...adapters };
    this.ledger = new DispatchLedger(ledgerDir);
    this.publishAgents = options.publishAgents === true;
    this.allowAssistant = options.allowAssistant === true;
    this.localVoice = options.localVoice;
  }

  /** Collect non-archived sessions across configured runtimes, prioritized by live state and recency. */
  async unifiedEntries(): Promise<UnifiedRuntimeEntry[]> {
    const rankState: Record<RuntimeSession["state"], number> = {
      attention: 0,
      running: 1,
      idle: 2,
      unknown: 3,
      inactive: 4,
    };
    const perRuntime = await Promise.all(
      RUNTIMES.map(async (runtime): Promise<UnifiedRuntimeEntry[]> => {
        const adapter = this.adapters[runtime];
        if (!adapter) return [];
        const collected: UnifiedRuntimeEntry[] = [];
        try {
          if (typeof adapter.browse === "function") {
            let after: string | undefined;
            for (let pageIndex = 0; pageIndex < 6; pageIndex++) {
              const page = await this.browse({ runtime, view: "sessions", ...(after ? { after } : {}) });
              if (page.view !== "sessions") break;
              for (const entry of page.entries) {
                if (entry.archived || entry.project.id === DSH_ARCHIVE) continue;
                const s = entry.session;
                const allowRtSend = runtime !== "antigravity" || adapter.sendEnabled === true;
                const sendConfigured =
                  allowRtSend &&
                  (s.canSend || ((runtime === "codex" || runtime === "antigravity") && adapter.sendEnabled === true && (s.state === "running" || s.state === "attention")));
                collected.push({
                  runtime,
                  projectId: entry.project.id,
                  projectTitle: entry.project.title,
                  session: s,
                  sendConfigured,
                });
              }
              if (!page.next) break;
              after = page.next;
            }
          } else {
            const allowRtSend = runtime !== "antigravity" || adapter.sendEnabled === true;
            const list = projects(runtime, await adapter.list(), allowRtSend);
            for (const project of list) {
              for (const s of project.sessions) {
                const sendConfigured =
                  allowRtSend &&
                  (s.canSend || ((runtime === "codex" || runtime === "antigravity") && adapter.sendEnabled === true && (s.state === "running" || s.state === "attention")));
                collected.push({
                  runtime,
                  projectId: project.id,
                  projectTitle: project.title,
                  session: s,
                  sendConfigured,
                });
              }
            }
          }
        } catch {
          return [];
        }
        const effRank = (e: UnifiedRuntimeEntry) =>
          (e.session.state === "idle" && (e.session.subagentsWorking ?? 0) > 0) ? rankState.running : rankState[e.session.state];
        collected.sort((a, b) =>
          (effRank(a) - effRank(b)) ||
          ((b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0)));
        return collected.slice(0, 80);
      }),
    );
    return perRuntime.flat();
  }
  list(): Promise<RuntimeCatalog> {
    if (this.loading) return this.loading;
    this.loading = Promise.all(RUNTIMES.flatMap((runtime) => {
      const adapter = this.adapters[runtime];
      if (!adapter) return [];
      const allowRtSend = runtime !== "antigravity" || adapter.sendEnabled === true;
      return [Promise.resolve().then(() => adapter.list()).then((ps) => ({ runtime, online: true, projects: projects(runtime, ps, allowRtSend) }))
        .catch(() => ({ runtime, online: false, projects: [] as RuntimeProject[] }))];
    })).then((rs) => ({ runtimes: rs.map(({ runtime, online }) => ({ runtime, online })), projects: rs.flatMap((r) => r.projects) }))
      .finally(() => { this.loading = undefined; });
    return this.loading;
  }
  get hasDirectory(): boolean { return this.adapters.dsh instanceof DshRuntime; }
  get hasCreate(): boolean {
    return RUNTIMES.some((runtime) => {
      const adapter = this.adapters[runtime];
      return adapter !== undefined && typeof adapter.create === "function" && (runtime === "dsh" || adapter.sendEnabled === true);
    });
  }
  get hasTaskEvents(): boolean {
    return Object.values(this.adapters).some((adapter) => typeof adapter?.taskEvents === "function");
  }

  async createOptions(): Promise<{ launchers: LaunchOption[]; spaces: SpaceInfo[]; folders: string[] }> {
    const LAUNCHER_META: Record<SessionRuntime, LaunchOption> = {
      dsh: { id: "dsh", label: "DSH", takesTask: true },
      codex: { id: "codex", label: "Codex", takesTask: true },
      antigravity: { id: "antigravity", label: "Antigravity（反重力）", takesTask: true },
    };
    const launchers: LaunchOption[] = [];
    const spacesMap = new Map<string, SpaceInfo>();
    const foldersSet = new Set<string>();
    await Promise.all(
      RUNTIMES.map(async (runtime) => {
        const adapter = this.adapters[runtime];
        if (!adapter || typeof adapter.create !== "function" || (runtime !== "dsh" && adapter.sendEnabled !== true)) return;
        launchers.push(LAUNCHER_META[runtime]);
        if (typeof adapter.knownFolders !== "function") return;
        let known: RuntimeKnownFolder[] = [];
        try { known = await adapter.knownFolders(); } catch { known = []; }
        for (const f of known) {
          if (!spacesMap.has(f.id)) {
            spacesMap.set(f.id, { id: f.id, name: f.title, ...(f.path ? { folder: f.path } : {}), tabs: 0, terminals: 0 });
          }
          if (f.path) foldersSet.add(f.path);
        }
      }),
    );
    launchers.sort((a, b) => RUNTIMES.indexOf(a.id as SessionRuntime) - RUNTIMES.indexOf(b.id as SessionRuntime));
    return { launchers, spaces: [...spacesMap.values()], folders: [...foldersSet] };
  }

  async createSession(input: { runtime: SessionRuntime; projectId?: string; cwd?: string; task?: string }): Promise<RuntimeCreatedSession & { runtime: SessionRuntime }> {
    const adapter = this.adapters[input.runtime];
    if (!adapter) throw OFFLINE();
    if (typeof adapter.create !== "function" || (input.runtime !== "dsh" && adapter.sendEnabled !== true)) {
      throw new RuntimeError("forbidden", "当前运行时未开放远程新建会话。");
    }
    let cleanTask: string | undefined;
    if (typeof input.task === "string") {
      if (input.task.length > RUNTIME_SESSION_TEXT_LIMIT || /[\uD800-\uDFFF]/u.test(input.task) || input.task.includes("\0")) throw INVALID();
      cleanTask = input.task.trim() || undefined;
    }
    let resolvedCwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : undefined;
    if (resolvedCwd === "~") resolvedCwd = homedir();
    if (input.runtime !== "dsh" && !resolvedCwd && input.projectId && typeof adapter.knownFolders === "function") {
      try {
        const known = await adapter.knownFolders();
        resolvedCwd = known.find((f) => f.id === input.projectId)?.path;
      } catch {}
    }
    if (input.runtime !== "dsh" && !resolvedCwd) resolvedCwd = homedir();
    const requestId = randomUUID().toLowerCase();
    try {
      const created = await adapter.create({
        ...(input.projectId && isRuntimeId(input.projectId) ? { projectId: input.projectId } : {}),
        ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
        ...(cleanTask ? { task: cleanTask } : {}),
        requestId,
      });
      return { ...created, runtime: input.runtime };
    } catch (e) {
      if (e instanceof RuntimeError) throw e;
      throw UNKNOWN();
    }
  }

  async interrupt(target: { runtime: SessionRuntime; projectId: string; sessionId: string }): Promise<{ interrupted: boolean }> {
    if (!isRuntimeId(target.projectId) || !isRuntimeId(target.sessionId)) throw INVALID();
    const adapter = this.adapters[target.runtime];
    if (!adapter) throw OFFLINE();
    if (target.runtime === "antigravity" && adapter.sendEnabled !== true) {
      throw new RuntimeError("forbidden", "Antigravity 会话未开启控制授权。");
    }
    if (typeof adapter.interrupt !== "function") {
      throw new RuntimeError("unsupported", "当前运行时暂不支持远程停止运行中的任务。");
    }
    try {
      return await adapter.interrupt(target.projectId, target.sessionId);
    } catch (e) {
      if (e instanceof RuntimeError) throw e;
      throw UNKNOWN();
    }
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
    const allowAg = runtime === "antigravity" && adapter.sendEnabled === true;
    return Promise.resolve().then(() => adapter.browse!(req)).then((reply) => directoryReply(reply, req, allowAg));
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
    return sanitizeDetail(runtime, raw as unknown as Record<string, unknown>, runtime === "antigravity" && adapter.sendEnabled === true);
  }

  async children(input: { runtime: SessionRuntime; projectId: string; sessionId: string; sub?: string }): Promise<SubSession[]> {
    const adapter = this.adapters[input.runtime];
    if (!adapter || typeof adapter.children !== "function") return [];
    let querySessionId = input.sessionId;
    if (input.sub) {
      const parsed = parseRuntimeTarget(input.sub);
      if (!parsed || parsed.runtime !== input.runtime) return [];
      const allowed = await this.descends(input.runtime, parsed.sessionId, input.sessionId);
      if (!allowed) return [];
      querySessionId = parsed.sessionId;
    }
    const raw = await adapter.children(querySessionId);
    return raw.map((c) => ({
      key: encodeRuntimeSessionKey(input.runtime, input.projectId, c.sessionId),
      parent: encodeRuntimeSessionKey(input.runtime, input.projectId, c.parent),
      ...(c.parentCall ? { parentCall: c.parentCall } : {}),
      harness: c.harness,
      ...(c.title ? { title: c.title } : {}),
      ...(c.preview ? { preview: c.preview } : {}),
      ...(c.model ? { model: c.model } : {}),
      status: c.status,
      ...(c.statusSince !== undefined ? { statusSince: c.statusSince } : {}),
      ...(c.startedAt !== undefined ? { startedAt: c.startedAt } : {}),
      updatedAt: c.updatedAt,
      ...(c.costUsd !== undefined ? { costUsd: c.costUsd } : {}),
      children: c.children,
    }));
  }

  async descends(runtime: SessionRuntime, sessionId: string, rootSessionId: string): Promise<boolean> {
    if (sessionId === rootSessionId) return true;
    const adapter = this.adapters[runtime];
    if (!adapter || typeof adapter.descends !== "function") return false;
    return await adapter.descends(sessionId, rootSessionId);
  }

  async send(input: unknown): Promise<RuntimeSessionReceipt> {
    const p = exact(input, ["runtime", "projectId", "sessionId", "requestId", "input"]);
    const runtime = runtimeOf(p.runtime);
    if (!runtime || !isRuntimeId(p.projectId) || !isRuntimeId(p.sessionId) ||
      !isRuntimeRequestId(p.requestId) || typeof p.input !== "string" || p.input.length > RUNTIME_SESSION_TEXT_LIMIT || /[\uD800-\uDFFF]/u.test(p.input) || !p.input.trim() || p.input.includes("\0")) throw INVALID();
    if (runtime === "antigravity" && this.adapters.antigravity?.sendEnabled !== true) throw new RuntimeError("forbidden", "Antigravity 会话当前仅支持查看，不支持从手机发送消息。");
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
    if (runtime === "antigravity" && this.adapters.antigravity?.sendEnabled !== true) throw new RuntimeError("forbidden", "Antigravity 会话当前仅支持查看，不支持从手机回答问题。");
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
  close() {
    for (const adapter of Object.values(this.adapters)) adapter.close?.();
    this.localVoice?.close();
  }
}

/** Explicit local config only. Never search DSH/Codex history, sockets or auth files. */
export function loadRuntimeSessions(path: string | undefined): RuntimeSessions | undefined {
  if (path === undefined) return undefined;
  try {
    const cfg = exact(readPrivate(path, MAX_CONFIG), ["viewerId", "dsh", "codex", "codexLocal", "antigravity", "publishAgents", "allowAssistant", "localVoice"]);
    if (!isRuntimeId(cfg.viewerId)) throw INVALID();
    if (cfg.publishAgents !== undefined && typeof cfg.publishAgents !== "boolean") throw INVALID();
    if (cfg.allowAssistant !== undefined && typeof cfg.allowAssistant !== "boolean") throw INVALID();
    if (cfg.codex !== undefined && cfg.codexLocal !== undefined) throw INVALID();
    const adapters: Partial<Record<SessionRuntime, RuntimeAdapter>> = {};
    let localVoice: LocalVoiceBridge | undefined;
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
      const a = exact(cfg.antigravity, ["brainDir", "agyBin", "enableSend"]);
      if (typeof a.brainDir !== "string" || (a.agyBin !== undefined && typeof a.agyBin !== "string") ||
          (a.enableSend !== undefined && typeof a.enableSend !== "boolean")) throw INVALID();
      adapters.antigravity = new AntigravityRuntime({ brainDir: a.brainDir, agyBin: a.agyBin, enableSend: a.enableSend === true });
    }
    if (cfg.localVoice !== undefined) {
      const lv = exact(cfg.localVoice, [
        "pythonBin", "gptSovitsDir", "sovitsWeightsPath", "gptWeightsPath",
        "refAudioPath", "refText", "refLang", "textLang", "idleTimeoutMs",
        "device", "workerScript", "enable", "asrModel", "vadModel", "puncModel",
      ]);
      const optStr = (v: unknown) => v === undefined || typeof v === "string";
      if (typeof lv.pythonBin !== "string" || typeof lv.gptSovitsDir !== "string" ||
          typeof lv.sovitsWeightsPath !== "string" || typeof lv.gptWeightsPath !== "string" ||
          typeof lv.refAudioPath !== "string" || typeof lv.refText !== "string" ||
          !optStr(lv.refLang) || !optStr(lv.textLang) || !optStr(lv.device) ||
          !optStr(lv.workerScript) || !optStr(lv.asrModel) || !optStr(lv.vadModel) || !optStr(lv.puncModel) ||
          (lv.enable !== undefined && typeof lv.enable !== "boolean") ||
          (lv.idleTimeoutMs !== undefined && (typeof lv.idleTimeoutMs !== "number" || !Number.isFinite(lv.idleTimeoutMs) || lv.idleTimeoutMs < 0))) {
        throw INVALID();
      }
      if (lv.enable !== false) {
        const voiceOpts: LocalVoiceOptions = {
          pythonBin: lv.pythonBin,
          gptSovitsDir: lv.gptSovitsDir,
          sovitsWeightsPath: lv.sovitsWeightsPath,
          gptWeightsPath: lv.gptWeightsPath,
          refAudioPath: lv.refAudioPath,
          refText: lv.refText,
          ...(typeof lv.refLang === "string" ? { refLang: lv.refLang } : {}),
          ...(typeof lv.textLang === "string" ? { textLang: lv.textLang } : {}),
          ...(typeof lv.device === "string" ? { device: lv.device } : {}),
          ...(typeof lv.idleTimeoutMs === "number" ? { idleTimeoutMs: lv.idleTimeoutMs } : {}),
          ...(typeof lv.workerScript === "string" ? { workerScript: lv.workerScript } : {}),
          ...(typeof lv.asrModel === "string" ? { asrModel: lv.asrModel } : {}),
          ...(typeof lv.vadModel === "string" ? { vadModel: lv.vadModel } : {}),
          ...(typeof lv.puncModel === "string" ? { puncModel: lv.puncModel } : {}),
          enable: true,
        };
        localVoice = new LocalVoiceBridge(voiceOpts);
      }
    }
    if (!Object.keys(adapters).length && !localVoice) throw INVALID();
    return new RuntimeSessions(cfg.viewerId, adapters, join(dirname(path), "runtime-dispatch"), {
      publishAgents: cfg.publishAgents === true,
      allowAssistant: cfg.allowAssistant === true,
      ...(localVoice ? { localVoice } : {}),
    });
  } catch {
    throw new RuntimeError("bad_request", "电脑端会话连接配置无效：请检查专用目录权限、允许的手机及连接器设置。");
  }
}
