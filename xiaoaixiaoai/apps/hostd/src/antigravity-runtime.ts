import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Readable, Writable } from "node:stream";
import {
  DSH_DIRECTORY_PAGE_SIZE,
  DSH_DIRECTORY_SEARCH_LIMIT,
  RUNTIME_DETAIL_LIMIT,
  RUNTIME_TASK_EVENTS_LIMIT,
  isRuntimeId,
  type DshDirectoryEntry,
  type DshDirectoryProject,
  type DshDirectoryReply,
  type DshDirectoryRequest,
  type RuntimePendingQuestion,
  type RuntimeProject,
  type RuntimeQuestionItem,
  type RuntimeSession,
  type RuntimeSessionAnswer,
  type RuntimeSessionDetail,
  type RuntimeSessionMessage,
  type RuntimeSessionReceipt,
  type RuntimeSessionSend,
  type RuntimeSessionState,
  type RuntimeTaskEvent,
} from "@xiaoaixiaoai/protocol";
import { localAppData, onPath } from "./platform.ts";
import { RuntimeError } from "./runtime-sessions.ts";
import { lineSplitter } from "./util.ts";

const SCAN_SESSION_LIMIT = 60;
const HEAD_BYTES = 128 * 1024;
const SUMMARY_TAIL_BYTES = 256 * 1024;
const DETAIL_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_TEXT = 6000;
const MAX_DETAIL_BYTES = 460 * 1024;
const RECENT_RUNNING_WINDOW_MS = 90_000;
const MAX_CONCURRENT_TURNS = 3;
const BACKGROUND_TURN_TIMEOUT_MS = 15 * 60_000;
const RECENT_CREATED_TTL_MS = 10 * 60_000;
const TASK_EVENT_TTL_MS = 10 * 60_000;
const TASK_EVENT_LIMIT = RUNTIME_TASK_EVENTS_LIMIT;
const READ_ONLY_REASON = "Antigravity 桌面会话暂不支持外部注入消息，可在手机端实时查看对话消息与待选问题。";
const RUNNING_REASON = "该 Antigravity 会话正在运行中，请等待当前轮结束后再发送。";
const MISSING_CWD_REASON = "该 Antigravity 会话关联的工作目录在当前电脑不存在，暂不支持继续发送。";

export interface AntigravityRuntimeOptions {
  brainDir: string;
  summaryDbPath?: string;
  agyBin?: string;
  enableSend?: boolean;
}

interface ActiveTurn {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  projectId: string;
  attention: boolean;
  timer: NodeJS.Timeout;
  notify: (method: string, params: unknown) => void;
  emitTerminal: (kind: "completed" | "stopped") => void;
}

interface SummaryRow {
  conversation_id: string;
  title: string;
  workspace_uris: string;
  status: string;
  parent_conversation_id: string;
  nesting_depth: number;
  killed: number;
}

interface ParsedStep {
  type?: string;
  source?: string;
  status?: string;
  content?: string;
  created_at?: string;
  tool_calls?: Array<{ name?: unknown; args?: unknown }>;
}

interface WorkspaceMeta {
  id: string;
  title: string;
  cwd?: string;
}

interface BrainMeta {
  sessionId: string;
  transcriptPath: string;
  hasLock: boolean;
  mtimeMs: number;
  dbStatus?: string;
  project: { id: string; title: string };
  cwd?: string;
  title: string;
  state: RuntimeSessionState;
}

function cleanText(value: unknown, max = MAX_MESSAGE_TEXT): string {
  if (typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value)) return "";
  const sanitized = value.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\p{Cf}]/gu, " ").trim();
  if (!sanitized) return "";
  const chars = Array.from(sanitized);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : sanitized;
}

function cleanLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value)) return fallback;
  const label = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (!label) return fallback;
  const chars = Array.from(label);
  return (chars.length > 120 ? `${chars.slice(0, 119).join("")}…` : label) || fallback;
}

function readWindowLines(filePath: string, offset: number, maxBytes: number, fromHead: boolean): string[] {
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= 0) return [];
    const start = fromHead ? offset : Math.max(0, size - maxBytes);
    const len = fromHead ? Math.min(maxBytes, Math.max(0, size - start)) : size - start;
    if (len <= 0) return [];
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    let text = buf.subarray(0, read).toString("utf8");
    if (!fromHead && start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    } else if (fromHead && start + read < size) {
      const nl = text.lastIndexOf("\n");
      text = nl >= 0 ? text.slice(0, nl) : "";
    }
    return text.split(/\r?\n/).filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

function parseStep(line: string): ParsedStep | null {
  try {
    const o = JSON.parse(line);
    return o && typeof o === "object" && !Array.isArray(o) ? o as ParsedStep : null;
  } catch { return null; }
}

function extractUserRequest(content: unknown): string {
  if (typeof content !== "string") return "";
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(content);
  if (match) return cleanText(match[1]!, MAX_MESSAGE_TEXT);
  if (/<CONTEXT_SUMMARY>|<SYSTEM_MESSAGE>/i.test(content)) return "";
  return cleanText(content.replace(/<[^>]+>/g, " "), MAX_MESSAGE_TEXT);
}

function projectFromPath(rawPath: string): WorkspaceMeta | undefined {
  const cleaned = rawPath.trim().replace(/[\\/]+$/, "");
  if (!cleaned || /^none$/i.test(cleaned)) return undefined;
  const cwd = normalize(cleaned.endsWith(":") ? `${cleaned}\\` : cleaned);
  const canonical = cleaned.replace(/\\/g, "/").toLowerCase();
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  const leaf = cleaned.split(/[\\/]+/).filter(Boolean).pop() ?? "";
  return { id: `agp_${hash}`, title: cleanLabel(leaf, "Antigravity"), cwd };
}

function workspaceFromUris(rawUris: unknown): WorkspaceMeta | undefined {
  let uris: unknown = rawUris;
  if (typeof rawUris === "string") {
    const trimmed = rawUris.trim();
    if (!trimmed) return undefined;
    try { uris = JSON.parse(trimmed); } catch { return undefined; }
  }
  if (!Array.isArray(uris)) return undefined;
  for (const item of uris) {
    if (typeof item !== "string" || !item.trim()) continue;
    let decoded = item.trim();
    try { decoded = decodeURIComponent(decoded); } catch { /* keep raw if malformed escape */ }
    if (!/^file:\/\//i.test(decoded)) continue;
    const fsPath = decoded.replace(/^file:\/\//i, "").replace(/^\/([A-Za-z]:)/, "$1");
    const proj = projectFromPath(fsPath);
    if (proj) return proj;
  }
  return undefined;
}

function workspaceFromSystem(content: string): WorkspaceMeta | undefined {
  const block = /Active Workspaces:\s*([\s\S]*?)(?:Command Working Directory:|App Data Directory:|<\/user_information>)/i.exec(content);
  if (!block) return undefined;
  for (const line of block[1]!.split(/\r?\n/)) {
    const m = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const proj = projectFromPath(m[1]!);
    if (proj) return proj;
  }
  return undefined;
}

function resolveAgyBinary(explicit?: string): string | undefined {
  if (explicit?.trim()) {
    const path = explicit.trim();
    return existsSync(path) ? path : undefined;
  }
  if (process.platform === "win32") {
    const candidate = join(localAppData(), "agy", "bin", "agy.exe");
    if (existsSync(candidate)) return candidate;
    return onPath("agy");
  }
  const unixDefault = join(homedir(), ".local", "bin", "agy");
  if (existsSync(unixDefault)) return unixDefault;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const candidate = join(trimmed, "agy");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* ignore inaccessible PATH entry */ }
  }
  return undefined;
}

function formatAnswerValue(selected: readonly string[], custom?: string): string {
  const sel = selected.map((s) => s.trim()).filter(Boolean).join("、");
  const cus = custom?.trim() ?? "";
  if (sel && cus) return `${sel}（补充：${cus}）`;
  return sel || cus;
}

function readSummaryIndex(brainDir: string, summaryDbPath?: string): Map<string, SummaryRow> | undefined {
  const dbPath = summaryDbPath ?? join(dirname(brainDir), "conversation_summaries.db");
  if (!existsSync(dbPath)) return undefined;
  try {
    const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    try {
      const rows = db.prepare(`
        SELECT conversation_id, title, workspace_uris, status, parent_conversation_id, nesting_depth, killed
        FROM conversation_summaries
      `).all() as unknown as SummaryRow[];
      const map = new Map<string, SummaryRow>();
      for (const row of rows) {
        if (row && typeof row.conversation_id === "string" && row.conversation_id) {
          map.set(row.conversation_id, row);
        }
      }
      return map;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function parseAskQuestionTool(calls: ParsedStep["tool_calls"], prefixId: string): RuntimePendingQuestion | undefined {
  if (!Array.isArray(calls)) return undefined;
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (!call || typeof call.name !== "string") continue;
    if (call.name !== "ask_question" && !call.name.endsWith(":ask_question")) continue;
    const args = call.args && typeof call.args === "object" ? call.args as Record<string, unknown> : undefined;
    const rawQuestions = Array.isArray(args?.questions) ? args.questions : [];
    const questions: RuntimeQuestionItem[] = [];
    for (let qIdx = 0; qIdx < rawQuestions.length && qIdx < 16; qIdx++) {
      const rq = rawQuestions[qIdx];
      if (!rq || typeof rq !== "object") continue;
      const item = rq as Record<string, unknown>;
      const question = cleanText(item.question, 2000);
      if (!question) continue;
      const options = Array.isArray(item.options)
        ? item.options
          .map((opt) => cleanText(opt, 400))
          .filter(Boolean)
          .slice(0, 32)
          .map((optLabel) => ({ label: optLabel }))
        : undefined;
      questions.push({
        id: `q${qIdx + 1}`,
        question,
        ...(options?.length ? { options } : {}),
        ...(item.is_multi_select === true ? { multiSelect: true } : {}),
      });
    }
    if (questions.length) return { callId: `${prefixId}-ask-${i}`, state: "readonly", questions };
  }
  return undefined;
}

function summarizeTail(steps: ParsedStep[], hasLock: boolean, mtimeMs: number): { state: RuntimeSessionState; pendingQuestions: RuntimePendingQuestion[] } {
  const pendingQuestions: RuntimePendingQuestion[] = [];
  let sawPostAskUserInput = false;
  let lastMeaningful: ParsedStep | undefined;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (!lastMeaningful && (s.type === "USER_INPUT" || s.type === "PLANNER_RESPONSE")) lastMeaningful = s;
    if (s.type === "USER_INPUT") {
      sawPostAskUserInput = true;
      break;
    }
    if (s.type === "PLANNER_RESPONSE") {
      const ask = parseAskQuestionTool(s.tool_calls, `ag-${i}`);
      if (ask && !sawPostAskUserInput) {
        pendingQuestions.push(ask);
        return { state: "attention", pendingQuestions };
      }
      break;
    }
  }
  const activeWrite = hasLock || (Date.now() - mtimeMs <= RECENT_RUNNING_WINDOW_MS &&
    lastMeaningful !== undefined && (lastMeaningful.status !== "DONE" || (Array.isArray(lastMeaningful.tool_calls) && lastMeaningful.tool_calls.length > 0)));
  return { state: activeWrite ? "running" : "idle", pendingQuestions: [] };
}

function pageAfter<T extends { id: string }>(items: T[], after?: string): { page: T[]; next?: string } {
  const sorted = items.filter((item) => after === undefined || item.id > after).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const page = sorted.slice(0, DSH_DIRECTORY_PAGE_SIZE);
  return { page, next: sorted.length > DSH_DIRECTORY_PAGE_SIZE ? page.at(-1)?.id : undefined };
}

const searchKey = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

export class AntigravityRuntime {
  private readonly brainDir: string;
  private readonly summaryDbPath?: string;
  private readonly agyBin?: string;
  private readonly enableSend: boolean;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly recentCreated = new Map<string, { meta: BrainMeta; firstMessage?: string; expiresAt: number }>();
  private readonly events: Array<{ event: RuntimeTaskEvent; expiresAt: number }> = [];
  private closed = false;

  constructor(options: AntigravityRuntimeOptions) {
    if (!options || typeof options.brainDir !== "string" || !options.brainDir.trim()) {
      throw new RuntimeError("bad_request", "Antigravity 目录配置无效。");
    }
    this.brainDir = options.brainDir;
    this.summaryDbPath = options.summaryDbPath;
    this.agyBin = options.agyBin;
    this.enableSend = options.enableSend === true;
  }

  get sendEnabled(): boolean {
    return !this.closed && this.enableSend && Boolean(resolveAgyBinary(this.agyBin));
  }

  private resolveState(
    tailState: RuntimeSessionState,
    hasPendingQuestion: boolean,
    hasLock: boolean,
    dbStatus?: string,
    sessionId?: string,
  ): RuntimeSessionState {
    const active = sessionId ? this.activeTurns.get(sessionId) : undefined;
    if (active) return active.attention ? "attention" : "running";
    if (hasPendingQuestion) return "attention";
    if (dbStatus === "CASCADE_RUN_STATUS_RUNNING" || hasLock) return "running";
    if (dbStatus === "CASCADE_RUN_STATUS_IDLE") return "idle";
    return tailState;
  }

  private canSendMeta(meta: BrainMeta, state: RuntimeSessionState): boolean {
    return (
      this.sendEnabled &&
      !meta.hasLock &&
      !this.activeTurns.has(meta.sessionId) &&
      (state === "idle" || state === "attention") &&
      (meta.cwd === undefined || existsSync(meta.cwd))
    );
  }

  private readOnlyReasonFor(meta: BrainMeta, state: RuntimeSessionState): string {
    if (this.sendEnabled && (state === "running" || meta.hasLock || this.activeTurns.has(meta.sessionId))) {
      return RUNNING_REASON;
    }
    if (this.sendEnabled && meta.cwd !== undefined && !existsSync(meta.cwd)) {
      return MISSING_CWD_REASON;
    }
    return READ_ONLY_REASON;
  }

  private pruneRecentCreated(): void {
    const now = Date.now();
    for (const [id, entry] of this.recentCreated) {
      if (entry.expiresAt <= now) this.recentCreated.delete(id);
    }
  }

  knownFolders(): Array<{ id: string; title: string; path: string; updatedAt?: number }> {
    const seen = new Map<string, { id: string; title: string; path: string; updatedAt?: number }>();
    for (const meta of this.scanBrains()) {
      if (!meta.cwd || !existsSync(meta.cwd)) continue;
      const key = (() => {
        try { return realpathSync(meta.cwd).toLowerCase(); } catch { return resolve(meta.cwd).toLowerCase(); }
      })();
      const updatedAt = Math.trunc(meta.mtimeMs);
      const prev = seen.get(key);
      if (!prev || updatedAt > (prev.updatedAt ?? 0)) {
        seen.set(key, { id: meta.project.id, title: meta.project.title, path: meta.cwd, updatedAt });
      }
    }
    return [...seen.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  private scanBrains(): BrainMeta[] {
    this.pruneRecentCreated();
    const out: BrainMeta[] = [];
    if (existsSync(this.brainDir)) {
      const summaryMap = readSummaryIndex(this.brainDir, this.summaryDbPath);
      const candidates: Array<{ sessionId: string; transcriptPath: string; hasLock: boolean; mtimeMs: number; summary?: SummaryRow }> = [];
      for (const ent of readdirSync(this.brainDir, { withFileTypes: true })) {
        if (!ent.isDirectory() || !isRuntimeId(ent.name)) continue;
        const summary = summaryMap?.get(ent.name);
        if (summary && (
          (typeof summary.nesting_depth === "number" && summary.nesting_depth > 0) ||
          (typeof summary.parent_conversation_id === "string" && summary.parent_conversation_id.trim() !== "") ||
          Number(summary.killed) === 1
        )) {
          continue;
        }
        const base = join(this.brainDir, ent.name);
        const transcriptPath = join(base, ".system_generated", "logs", "transcript.jsonl");
        if (!existsSync(transcriptPath)) continue;
        try {
          const st = statSync(transcriptPath);
          if (!st.isFile() || st.size === 0) continue;
          candidates.push({
            sessionId: ent.name,
            transcriptPath,
            hasLock: existsSync(join(base, ".lock")),
            mtimeMs: st.mtimeMs,
            summary,
          });
        } catch { /* skip unreadable directory */ }
      }
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const item of candidates.slice(0, SCAN_SESSION_LIMIT)) {
        try {
          const headSteps = readWindowLines(item.transcriptPath, 0, HEAD_BYTES, true).map(parseStep).filter((s): s is ParsedStep => s !== null);
          let systemWorkspace: WorkspaceMeta | undefined;
          let transcriptTitle = "";
          for (const step of headSteps) {
            if (step.type === "SYSTEM_MESSAGE" && typeof step.content === "string") {
              systemWorkspace = workspaceFromSystem(step.content) ?? systemWorkspace;
            } else if (!transcriptTitle && step.type === "USER_INPUT") {
              transcriptTitle = extractUserRequest(step.content);
            }
          }
          const tailSteps = readWindowLines(item.transcriptPath, 0, SUMMARY_TAIL_BYTES, false).map(parseStep).filter((s): s is ParsedStep => s !== null);
          if (!transcriptTitle) {
            const fallbackUser = tailSteps.find((s) => s.type === "USER_INPUT");
            transcriptTitle = fallbackUser ? extractUserRequest(fallbackUser.content) : "";
          }
          const workspace = workspaceFromUris(item.summary?.workspace_uris) ?? systemWorkspace ?? { id: "agp_default", title: "Antigravity" };
          const project = { id: workspace.id, title: workspace.title };
          const summaryTitle = cleanLabel(item.summary?.title, "");
          const title = summaryTitle || cleanLabel(transcriptTitle, `Antigravity ${item.sessionId.slice(0, 8)}`);
          const tail = summarizeTail(tailSteps, item.hasLock, item.mtimeMs);
          const state = this.resolveState(tail.state, tail.pendingQuestions.length > 0, item.hasLock, item.summary?.status, item.sessionId);
          out.push({
            sessionId: item.sessionId,
            transcriptPath: item.transcriptPath,
            hasLock: item.hasLock,
            mtimeMs: item.mtimeMs,
            dbStatus: item.summary?.status,
            project,
            ...(workspace.cwd ? { cwd: workspace.cwd } : {}),
            title,
            state,
          });
        } catch { /* ignore unreadable transcript */ }
      }
    }
    if (this.recentCreated.size > 0) {
      const seen = new Set(out.map((m) => m.sessionId));
      for (const [id, entry] of this.recentCreated) {
        if (seen.has(id)) {
          this.recentCreated.delete(id);
        } else {
          out.unshift({
            ...entry.meta,
            state: this.resolveState("idle", false, false, undefined, id),
          });
        }
      }
      out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    }
    return out;
  }

  private toSession(meta: BrainMeta): RuntimeSession {
    return {
      id: meta.sessionId,
      title: meta.title,
      state: meta.state,
      canSend: this.canSendMeta(meta, meta.state),
      updatedAt: Math.trunc(meta.mtimeMs),
    };
  }

  async list(): Promise<RuntimeProject[]> {
    const metas = this.scanBrains();
    const grouped = new Map<string, RuntimeProject>();
    let sessionCount = 0;
    for (const meta of metas) {
      if (sessionCount >= 100) break;
      let project = grouped.get(meta.project.id);
      if (!project) {
        if (grouped.size >= 20) continue;
        project = { runtime: "antigravity", id: meta.project.id, title: meta.project.title, sessions: [] };
        grouped.set(meta.project.id, project);
      }
      project.sessions.push(this.toSession(meta));
      sessionCount++;
    }
    return [...grouped.values()];
  }

  async browse(input: DshDirectoryRequest): Promise<DshDirectoryReply> {
    const metas = this.scanBrains();
    if (input.view === "projects") {
      const map = new Map<string, DshDirectoryProject>();
      for (const meta of metas) {
        if (!map.has(meta.project.id)) map.set(meta.project.id, { runtime: "antigravity", id: meta.project.id, title: meta.project.title });
      }
      const { page, next } = pageAfter([...map.values()], input.after);
      return { runtime: "antigravity", view: "projects", scope: "profile", projects: page, ...(next ? { next } : {}) };
    }
    if (input.view === "exact") {
      const wanted = new Set(input.sessionIds);
      const entries: DshDirectoryEntry[] = metas
        .filter((m) => wanted.has(m.sessionId))
        .map((m) => ({ runtime: "antigravity", project: { runtime: "antigravity", ...m.project }, session: this.toSession(m), archived: false }));
      return { runtime: "antigravity", view: "exact", scope: "profile", entries };
    }
    const needle = searchKey((input.search ?? "").slice(0, DSH_DIRECTORY_SEARCH_LIMIT));
    const filtered = metas.filter((m) => {
      if (input.projectId !== undefined && m.project.id !== input.projectId) return false;
      if (!needle) return true;
      return [m.project.title, m.project.id, m.title, m.sessionId].some((s) => searchKey(s).includes(needle));
    });
    const paged = pageAfter(filtered.map((m) => ({ id: m.sessionId, meta: m })), input.after);
    return {
      runtime: "antigravity",
      view: "sessions",
      scope: "profile",
      entries: paged.page.map(({ meta }) => ({ runtime: "antigravity", project: { runtime: "antigravity", ...meta.project }, session: this.toSession(meta), archived: false })),
      ...(paged.next ? { next: paged.next } : {}),
    };
  }

  async detail(projectId: string, sessionId: string, limit = 60): Promise<RuntimeSessionDetail> {
    if (!isRuntimeId(sessionId)) throw new RuntimeError("not_found", "无效的 Antigravity 会话 ID。");
    const metas = this.scanBrains();
    const meta = metas.find((m) => m.sessionId === sessionId);
    if (!meta || meta.project.id !== projectId) throw new RuntimeError("not_found", "未找到对应的 Antigravity 会话。");
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 60, 1), RUNTIME_DETAIL_LIMIT);
    const steps = meta.transcriptPath && existsSync(meta.transcriptPath)
      ? readWindowLines(meta.transcriptPath, 0, DETAIL_TAIL_BYTES, false).map(parseStep).filter((s): s is ParsedStep => s !== null)
      : [];
    const messages: RuntimeSessionMessage[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const parsedTs = typeof step.created_at === "string" ? Date.parse(step.created_at) : NaN;
      const ts = Number.isSafeInteger(parsedTs) && parsedTs > 0 ? parsedTs : undefined;
      if (step.type === "USER_INPUT") {
        const text = extractUserRequest(step.content);
        if (text) messages.push({ id: `ag-u-${i}`, role: "user", text, ...(ts !== undefined ? { ts } : {}) });
      } else if (step.type === "PLANNER_RESPONSE") {
        if (Array.isArray(step.tool_calls)) {
          for (let j = 0; j < step.tool_calls.length; j++) {
            const rawName = step.tool_calls[j]?.name;
            if (typeof rawName !== "string" || !rawName) continue;
            const shortName = rawName.includes(":") ? rawName.split(":").pop()! : rawName;
            const toolName = cleanLabel(shortName, "tool");
            messages.push({ id: `ag-t-${i}-${j}`, role: "tool", text: `${toolName}（调用）`, ...(ts !== undefined ? { ts } : {}), toolName, isError: false });
          }
        }
        const replyText = cleanText(step.content, MAX_MESSAGE_TEXT);
        if (replyText) messages.push({ id: `ag-a-${i}`, role: "assistant", text: replyText, ...(ts !== undefined ? { ts } : {}) });
      }
    }
    const createdFirst = this.recentCreated.get(sessionId)?.firstMessage;
    if (messages.length === 0 && createdFirst) {
      messages.push({ id: `ag-init-${sessionId}`, role: "user", text: cleanText(createdFirst, MAX_MESSAGE_TEXT) || createdFirst });
    }
    const tailSummary = summarizeTail(steps, meta.hasLock, meta.mtimeMs);
    const state = this.resolveState(tailSummary.state, tailSummary.pendingQuestions.length > 0, meta.hasLock, meta.dbStatus, meta.sessionId);
    const canSend = this.canSendMeta(meta, state);
    const pendingQuestions = tailSummary.pendingQuestions.map((pq) => ({
      ...pq,
      state: canSend ? ("open" as const) : ("readonly" as const),
    }));
    const session: RuntimeSession = {
      id: meta.sessionId,
      title: meta.title,
      state,
      canSend,
      updatedAt: Math.trunc(meta.mtimeMs),
    };
    const reply: RuntimeSessionDetail = {
      runtime: "antigravity",
      project: meta.project,
      session,
      messages: messages.slice(-boundedLimit),
      pendingQuestions,
      ...(canSend ? {} : { readOnlyReason: this.readOnlyReasonFor(meta, state) }),
    };
    while (reply.messages.length > 0 && Buffer.byteLength(JSON.stringify(reply), "utf8") > MAX_DETAIL_BYTES) {
      reply.messages.shift();
    }
    return reply;
  }

  private pushTaskEvent(requestId: string, kind: RuntimeTaskEvent["kind"]): void {
    if (this.closed) return;
    const now = Date.now();
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.expiresAt <= now) this.events.splice(i, 1);
    }
    this.events.push({ event: { eventId: randomUUID(), requestId, kind }, expiresAt: now + TASK_EVENT_TTL_MS });
    if (this.events.length > TASK_EVENT_LIMIT) this.events.shift();
  }

  taskEvents(): RuntimeTaskEvent[] {
    const now = Date.now();
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.expiresAt <= now) this.events.splice(i, 1);
    }
    return this.events.map(({ event }) => event);
  }

  private async openAcpServer(cwd: string) {
    const exe = resolveAgyBinary(this.agyBin);
    if (!exe) throw new RuntimeError("unsupported", "未在本机找到 Antigravity CLI (agy) 可执行程序。");

    const resolvedBrain = resolve(this.brainDir);
    const appDataDirName = basename(resolvedBrain).toLowerCase() === "brain" ? basename(dirname(resolvedBrain)) : "antigravity";
    const acpArgs = ["acp", "--app-data-dir", appDataDirName, "--stdio"];
    const spawnOpts = { cwd, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], windowsHide: true };
    const child = /\.(?:mjs|js|cjs)$/i.test(exe)
      ? spawn(process.execPath, [exe, ...acpArgs], spawnOpts)
      : process.platform === "win32" && /\.(?:cmd|bat)$/i.test(exe)
        ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", exe, ...acpArgs], spawnOpts)
        : process.platform === "win32" && /\.ps1$/i.test(exe)
          ? spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", exe, ...acpArgs], spawnOpts)
          : spawn(exe, acpArgs, spawnOpts);
    child.stdin.on("error", () => {});

    let nextRpcId = 1;
    let handoffDone = false;
    let emittedProgress = false;
    let emittedTerminal = false;
    let promptRpcId = -1;
    let boundProjectId = "";
    let boundSessionId = "";
    let boundRequestId: string | undefined;
    const pendingRpc = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

    const cleanupChild = () => {
      if (boundSessionId) {
        const tracked = this.activeTurns.get(boundSessionId);
        if (tracked?.child === child) {
          clearTimeout(tracked.timer);
          this.activeTurns.delete(boundSessionId);
        }
      }
      try { child.stdin.end(); } catch {}
      setTimeout(() => { try { child.kill(); } catch {} }, 400).unref();
    };

    const failPendingRpc = (err: Error) => {
      for (const [id, p] of pendingRpc) {
        clearTimeout(p.timer);
        p.reject(err);
        pendingRpc.delete(id);
      }
    };

    const emitTerminal = (kind: "completed" | "stopped") => {
      if (!handoffDone || emittedTerminal) return;
      emittedTerminal = true;
      if (boundRequestId) this.pushTaskEvent(boundRequestId, kind);
      cleanupChild();
    };

    const writePacket = (payload: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
    };

    child.stdout.on("data", lineSplitter((line) => {
      let packet: Record<string, unknown>;
      try { packet = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      const id = packet.id;
      const method = packet.method;
      if (typeof method === "string") {
        // Server-initiated interactive request (permission / input prompt) cannot resolve unattended.
        if (typeof id === "number" || typeof id === "string") {
          const tracked = boundSessionId ? this.activeTurns.get(boundSessionId) : undefined;
          if (tracked) tracked.attention = true;
          if (handoffDone && !emittedTerminal) {
            try {
              writePacket({ id: nextRpcId++, method: "session/close", params: { sessionId: boundSessionId } });
            } catch {}
            if (boundRequestId) this.pushTaskEvent(boundRequestId, "attention");
            emitTerminal("stopped");
          } else {
            failPendingRpc(new RuntimeError("not_found", "Antigravity 请求人工交互确认，请在桌面窗口查看。"));
            cleanupChild();
          }
          return;
        }
        if (handoffDone && method === "session/update" && !emittedProgress && boundRequestId) {
          const p = packet.params && typeof packet.params === "object" ? packet.params as Record<string, unknown> : undefined;
          const update = p?.update && typeof p.update === "object" ? p.update as Record<string, unknown> : undefined;
          const kind = update?.sessionUpdate;
          if (kind === "agent_message_chunk" || kind === "tool_call" || kind === "tool_call_update") {
            emittedProgress = true;
            this.pushTaskEvent(boundRequestId, "progress");
          }
        }
        return;
      }
      if (typeof id === "number" && id === promptRpcId && handoffDone) {
        try {
          writePacket({ id: nextRpcId++, method: "session/close", params: { sessionId: boundSessionId } });
        } catch {}
        emitTerminal(packet.error !== undefined ? "stopped" : "completed");
        return;
      }
      if (typeof id === "number" && pendingRpc.has(id)) {
        const call = pendingRpc.get(id)!;
        pendingRpc.delete(id);
        clearTimeout(call.timer);
        if (packet.error !== undefined) call.reject(new Error(typeof packet.error === "object" ? JSON.stringify(packet.error) : String(packet.error)));
        else call.resolve(packet.result);
      }
    }));

    child.stderr.on("data", () => {});
    child.on("error", (err) => {
      failPendingRpc(err);
      if (handoffDone && !emittedTerminal) emitTerminal("stopped");
      else cleanupChild();
    });
    child.on("exit", () => {
      failPendingRpc(new Error("agy acp exited"));
      if (handoffDone && !emittedTerminal) emitTerminal("stopped");
      else cleanupChild();
    });

    const rpc = (method: string, params: unknown, timeoutMs: number): Promise<Record<string, unknown> | undefined> =>
      new Promise((resolveCall, rejectCall) => {
        const id = nextRpcId++;
        const timer = setTimeout(() => {
          pendingRpc.delete(id);
          rejectCall(new Error(`timeout:${method}`));
        }, timeoutMs);
        pendingRpc.set(id, {
          resolve: (v) => resolveCall(v && typeof v === "object" ? v as Record<string, unknown> : undefined),
          reject: rejectCall,
          timer,
        });
        writePacket({ id, method, params });
      });

    await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} }, 15_000);

    return {
      rpc,
      notify: (method: string, params: unknown) => writePacket({ method, params }),
      closeSession: (sessionId: string) => {
        try { writePacket({ id: nextRpcId++, method: "session/close", params: { sessionId } }); } catch {}
      },
      sendPrompt: (sessionId: string, promptText: string) => {
        promptRpcId = nextRpcId++;
        writePacket({
          id: promptRpcId,
          method: "session/prompt",
          params: { sessionId, prompt: [{ type: "text", text: promptText }] },
        });
      },
      bindTurn: (projectId: string, sessionId: string, requestId?: string) => {
        boundProjectId = projectId;
        boundSessionId = sessionId;
        boundRequestId = requestId;
        handoffDone = true;
        const timer = setTimeout(() => emitTerminal("stopped"), BACKGROUND_TURN_TIMEOUT_MS);
        timer.unref();
        this.activeTurns.set(sessionId, {
          child,
          projectId: boundProjectId,
          attention: false,
          timer,
          notify: (method, params) => writePacket({ method, params }),
          emitTerminal,
        });
      },
      abort: () => {
        failPendingRpc(new Error("aborted"));
        cleanupChild();
      },
    };
  }

  async send({ projectId, sessionId, requestId, text }: RuntimeSessionSend): Promise<RuntimeSessionReceipt> {
    if (this.closed) throw new RuntimeError("offline", "Antigravity 本地连接器已停止。");
    if (!this.enableSend) throw new RuntimeError("forbidden", READ_ONLY_REASON);
    if (!isRuntimeId(sessionId)) throw new RuntimeError("not_found", "无效的 Antigravity 会话 ID。");
    const meta = this.scanBrains().find((m) => m.sessionId === sessionId);
    if (!meta || meta.project.id !== projectId) throw new RuntimeError("not_found", "未找到对应的 Antigravity 会话。");
    if (meta.cwd !== undefined && !existsSync(meta.cwd)) throw new RuntimeError("not_found", MISSING_CWD_REASON);
    if (this.activeTurns.has(sessionId) || meta.hasLock || meta.state === "running") {
      throw new RuntimeError("not_found", RUNNING_REASON);
    }
    if (this.activeTurns.size >= MAX_CONCURRENT_TURNS) {
      throw new RuntimeError("offline", "后台 Antigravity 任务数已达上限，请等待现有任务完成后再试。");
    }

    const targetCwd = meta.cwd ?? homedir();
    const server = await this.openAcpServer(targetCwd);
    let settledTurn = false;
    try {
      let resumed: Record<string, unknown> | undefined;
      try {
        resumed = await server.rpc("session/resume", { sessionId, cwd: targetCwd, mcpServers: [] }, 20_000);
      } catch {
        throw new RuntimeError("not_found", "该 Antigravity 会话正被占用或暂时无法续接。");
      }
      if (resumed?.sessionId !== sessionId) {
        throw new RuntimeError("not_found", "未确认对应的 Antigravity 会话，未发送。");
      }

      server.sendPrompt(sessionId, text);
      settledTurn = true;
      server.bindTurn(projectId, sessionId, requestId);
      return { accepted: true, requestId };
    } finally {
      if (!settledTurn) server.abort();
    }
  }

  async create(input: {
    cwd?: string;
    projectId?: string;
    task?: string;
    requestId?: string;
  }): Promise<{ projectId: string; sessionId: string; title: string; cwd: string; state: RuntimeSessionState }> {
    if (this.closed) throw new RuntimeError("offline", "Antigravity 本地连接器已停止。");
    if (!this.enableSend) throw new RuntimeError("forbidden", READ_ONLY_REASON);
    let rawCwd = input.cwd?.trim() ?? "";
    if (!rawCwd && input.projectId) {
      rawCwd = this.knownFolders().find((f) => f.id === input.projectId)?.path ?? "";
    }
    if (!rawCwd || !existsSync(rawCwd)) throw new RuntimeError("bad_request", "目标项目目录不存在或不可访问。");
    const resolvedCwd = (() => {
      try { return realpathSync(rawCwd); } catch { return resolve(rawCwd); }
    })();
    const task = input.task?.trim();
    if (task && this.activeTurns.size >= MAX_CONCURRENT_TURNS) {
      throw new RuntimeError("offline", "后台 Antigravity 任务数已达上限，请等待现有任务完成后再试。");
    }

    const server = await this.openAcpServer(resolvedCwd);
    let keepRunning = false;
    try {
      const created = await server.rpc("session/new", { cwd: resolvedCwd, mcpServers: [] }, 20_000);
      const sessionId = typeof created?.sessionId === "string" ? created.sessionId : "";
      if (!isRuntimeId(sessionId)) throw new RuntimeError("outcome_unknown", "未收到有效的 Antigravity 会话标识。");

      const workspace = projectFromPath(resolvedCwd) ?? {
        id: "agp_default",
        title: cleanLabel(basename(resolvedCwd), "Antigravity"),
        cwd: resolvedCwd,
      };
      const nowMs = Date.now();
      const title = cleanLabel(task || workspace.title, `Antigravity ${sessionId.slice(0, 8)}`);
      this.recentCreated.set(sessionId, {
        meta: {
          sessionId,
          transcriptPath: join(this.brainDir, sessionId, ".system_generated", "logs", "transcript.jsonl"),
          hasLock: false,
          mtimeMs: nowMs,
          project: { id: workspace.id, title: workspace.title },
          cwd: resolvedCwd,
          title,
          state: task ? "running" : "idle",
        },
        ...(task ? { firstMessage: task } : {}),
        expiresAt: nowMs + RECENT_CREATED_TTL_MS,
      });

      if (!task) {
        server.closeSession(sessionId);
        return { projectId: workspace.id, sessionId, title, cwd: resolvedCwd, state: "idle" };
      }

      server.sendPrompt(sessionId, task);
      keepRunning = true;
      server.bindTurn(workspace.id, sessionId, input.requestId);
      return { projectId: workspace.id, sessionId, title, cwd: resolvedCwd, state: "running" };
    } finally {
      if (!keepRunning) server.abort();
    }
  }

  async interrupt(projectId: string, sessionId: string): Promise<{ interrupted: boolean }> {
    if (this.closed) throw new RuntimeError("offline", "Antigravity 本地连接器已停止。");
    if (!isRuntimeId(sessionId)) throw new RuntimeError("not_found", "无效的 Antigravity 会话 ID。");
    const tracked = this.activeTurns.get(sessionId);
    if (tracked && tracked.projectId === projectId) {
      try {
        tracked.notify("session/cancel", { sessionId });
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
      tracked.emitTerminal("stopped");
      return { interrupted: true };
    }
    const meta = this.scanBrains().find((m) => m.sessionId === sessionId);
    if (!meta || meta.project.id !== projectId) throw new RuntimeError("not_found", "未找到对应的 Antigravity 会话。");
    if (meta.hasLock || meta.state === "running") {
      throw new RuntimeError("unsupported", "该会话正在 Antigravity 桌面端运行，请在桌面端停止。");
    }
    return { interrupted: false };
  }

  async answer({ projectId, sessionId, requestId, callId, answers }: RuntimeSessionAnswer): Promise<RuntimeSessionReceipt> {
    if (this.closed) throw new RuntimeError("offline", "Antigravity 本地连接器已停止。");
    if (!this.enableSend) throw new RuntimeError("forbidden", READ_ONLY_REASON);
    const current = await this.detail(projectId, sessionId, 20);
    const pq = current.pendingQuestions.find((q) => q.callId === callId && q.state !== "readonly");
    if (!pq) throw new RuntimeError("not_found", "该待回答问题已过期或当前会话不可写。");

    let formattedReply = "";
    if (pq.questions.length === 1) {
      const q = pq.questions[0]!;
      const ans = answers.find((a) => a.id === q.id) ?? answers[0];
      formattedReply = ans ? formatAnswerValue(ans.selected, ans.custom) : "";
    } else {
      const byId = new Map(pq.questions.map((q) => [q.id, q.question]));
      formattedReply = answers
        .map((ans, idx) => {
          const val = formatAnswerValue(ans.selected, ans.custom);
          if (!val) return "";
          const qLabel = byId.get(ans.id) ?? ans.id;
          return `${idx + 1}. ${qLabel}：${val}`;
        })
        .filter(Boolean)
        .join("\n");
    }
    if (!formattedReply) throw new RuntimeError("bad_request", "回答内容不能为空。");
    return this.send({ runtime: "antigravity", projectId, sessionId, requestId, text: formattedReply });
  }

  close(): void {
    this.closed = true;
    for (const [id, entry] of this.activeTurns) {
      clearTimeout(entry.timer);
      try { entry.child.kill(); } catch {}
      this.activeTurns.delete(id);
    }
    this.recentCreated.clear();
    this.events.length = 0;
  }
}
