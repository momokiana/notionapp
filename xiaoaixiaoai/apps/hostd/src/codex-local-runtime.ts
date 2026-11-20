import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Readable, Writable } from "node:stream";
import {
  DSH_DIRECTORY_PAGE_SIZE,
  DSH_DIRECTORY_SEARCH_LIMIT,
  RUNTIME_DETAIL_LIMIT,
  isRuntimeId,
  type DshDirectoryEntry,
  type DshDirectoryProject,
  type DshDirectoryReply,
  type DshDirectoryRequest,
  type RuntimeProject,
  type RuntimeSession,
  type RuntimeSessionDetail,
  type RuntimeSessionMessage,
  type RuntimeSessionReceipt,
  type RuntimeSessionSend,
  type RuntimeSessionState,
  type RuntimeTaskEvent,
} from "@xiaoaixiaoai/protocol";
import { VERSION } from "@xiaoaixiaoai/update";
import { localAppData, onPath } from "./platform.ts";
import { RuntimeError } from "./runtime-sessions.ts";
import { lineSplitter } from "./util.ts";

const THREAD_LIST_LIMIT = 80;
const STATUS_TAIL_BYTES = 64 * 1024;
const DETAIL_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_TEXT = 6000;
const MAX_DETAIL_BYTES = 460 * 1024;
const RECENT_ACTIVE_WINDOW_MS = 15 * 60_000;
const MAX_CONCURRENT_TURNS = 2;
const BACKGROUND_TURN_TIMEOUT_MS = 10 * 60_000;
const TASK_EVENT_LIMIT = 128;
const TASK_EVENT_TTL_MS = 15 * 60_000;

export interface CodexLocalRuntimeOptions {
  codexHome: string;
  codexBin?: string;
  enableSend?: boolean;
}

interface ThreadRow {
  id: string;
  rollout_path: string;
  cwd: string;
  title: string;
  name: string | null;
  first_user_message: string;
  archived: number;
  updated_at: number;
  updated_at_ms: number | null;
}

interface ActiveTurn {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  attention: boolean;
  timer: NodeJS.Timeout;
}

const INJECTED_USER_PREFIXES = [
  /^<environment_context>/i,
  /^<permissions instructions>/i,
  /^<collaboration_mode>/i,
  /^<instructions>/i,
  /^<user_instructions>/i,
  /^<skill>/i,
  /^# AGENTS\.md instructions/i,
];

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

function projectForCwd(cwd: string | null | undefined): { id: string; title: string } {
  const raw = typeof cwd === "string" ? cwd.trim().replace(/[\\/]+$/, "") : "";
  if (!raw) return { id: "cxp_default", title: "Codex" };
  const hash = createHash("sha256").update(raw.toLowerCase()).digest("hex").slice(0, 12);
  const leaf = basename(raw).replace(/[:/\\]/g, "").trim();
  return { id: `cxp_${hash}`, title: cleanLabel(leaf, "Codex") };
}

/** Read at most `maxBytes` from the end of a potentially huge (>1.8 GB) rollout file, never whole-file. */
function readTailLines(filePath: string, maxBytes: number): string[] {
  if (!filePath || !existsSync(filePath)) return [];
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= 0) return [];
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    let offset = 0;
    while (offset < len) {
      const n = readSync(fd, buf, offset, len - offset, start + offset);
      if (n <= 0) break;
      offset += n;
    }
    let text = buf.subarray(0, offset).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return text.split(/\r?\n/).filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

function findDbPath(codexHome: string): string | undefined {
  if (!existsSync(codexHome)) return undefined;
  const preferred = join(codexHome, "state_5.sqlite");
  if (existsSync(preferred)) return preferred;
  const candidates = readdirSync(codexHome)
    .map((name) => ({ name, m: /^state_(\d+)\.sqlite$/.exec(name) }))
    .filter((entry): entry is { name: string; m: RegExpExecArray } => entry.m !== null)
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1]));
  return candidates.length ? join(codexHome, candidates[0]!.name) : undefined;
}

function queryThreads(dbPath: string, limit: number): ThreadRow[] {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    return db.prepare(`
      SELECT id, rollout_path, cwd, title, name, first_user_message, archived, updated_at, updated_at_ms
      FROM threads
      WHERE (thread_source IS NULL OR thread_source = 'user')
      ORDER BY COALESCE(archived, 0) ASC, COALESCE(updated_at_ms, updated_at * 1000) DESC
      LIMIT ?
    `).all(limit) as unknown as ThreadRow[];
  } finally {
    db.close();
  }
}

function queryThreadById(dbPath: string, threadId: string): ThreadRow | undefined {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    return db.prepare(`
      SELECT id, rollout_path, cwd, title, name, first_user_message, archived, updated_at, updated_at_ms
      FROM threads
      WHERE id = ? AND (thread_source IS NULL OR thread_source = 'user')
      LIMIT 1
    `).get(threadId) as unknown as ThreadRow | undefined;
  } finally {
    db.close();
  }
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}

function probeState(row: ThreadRow, active?: ActiveTurn): RuntimeSessionState {
  if (active) return active.attention ? "attention" : "running";
  if (row.archived) return "inactive";
  try {
    if (row.rollout_path && existsSync(row.rollout_path)) {
      const st = statSync(row.rollout_path);
      if (Date.now() - st.mtimeMs <= RECENT_ACTIVE_WINDOW_MS) {
        const lines = readTailLines(row.rollout_path, STATUS_TAIL_BYTES);
        for (let i = lines.length - 1; i >= 0; i--) {
          let parsed: Record<string, unknown>;
          try { parsed = JSON.parse(lines[i]!) as Record<string, unknown>; } catch { continue; }
          if (parsed.type === "event_msg" && parsed.payload && typeof parsed.payload === "object") {
            const kind = (parsed.payload as Record<string, unknown>).type;
            if (kind === "task_started") return "running";
            if (kind === "task_complete" || kind === "turn_aborted") return "idle";
          }
        }
      }
    }
  } catch { /* fallback to idle if file cannot be probed */ }
  return "idle";
}

function parseRolloutMessages(rolloutPath: string, limit: number): RuntimeSessionMessage[] {
  const lines = readTailLines(rolloutPath, DETAIL_TAIL_BYTES);
  const messages: RuntimeSessionMessage[] = [];
  for (let i = 0; i < lines.length; i++) {
    let record: Record<string, unknown>;
    try { record = JSON.parse(lines[i]!) as Record<string, unknown>; } catch { continue; }
    if (record.type !== "response_item" || !record.payload || typeof record.payload !== "object") continue;
    const p = record.payload as Record<string, unknown>;
    const ts = parseTimestamp(record.timestamp);
    const idPrefix = typeof record.ordinal === "number" ? String(record.ordinal) : String(i);
    if (p.type === "message") {
      if (p.role === "user" && Array.isArray(p.content)) {
        const parts: string[] = [];
        for (const item of p.content) {
          if (!item || typeof item !== "object") continue;
          const block = item as Record<string, unknown>;
          if (block.type === "input_text" && typeof block.text === "string") {
            const trimmed = block.text.trim();
            if (trimmed && !INJECTED_USER_PREFIXES.some((re) => re.test(trimmed))) {
              const clean = cleanText(trimmed, MAX_MESSAGE_TEXT);
              if (clean) parts.push(clean);
            }
          } else if (block.type === "input_image") {
            parts.push("[图片]");
          }
        }
        const text = cleanText(parts.join("\n"), MAX_MESSAGE_TEXT);
        if (text) messages.push({ id: `cx-u-${idPrefix}`, role: "user", text, ...(ts !== undefined ? { ts } : {}) });
      } else if (p.role === "assistant" && Array.isArray(p.content)) {
        const parts: string[] = [];
        for (const item of p.content) {
          if (!item || typeof item !== "object") continue;
          const block = item as Record<string, unknown>;
          if (block.type === "output_text" && typeof block.text === "string") {
            const clean = cleanText(block.text, MAX_MESSAGE_TEXT);
            if (clean) parts.push(clean);
          }
        }
        const text = cleanText(parts.join("\n"), MAX_MESSAGE_TEXT);
        if (text) messages.push({ id: `cx-a-${idPrefix}`, role: "assistant", text, ...(ts !== undefined ? { ts } : {}) });
      }
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const toolName = cleanLabel(p.name, "tool");
      messages.push({ id: `cx-t-${idPrefix}`, role: "tool", text: `${toolName}（调用）`, ...(ts !== undefined ? { ts } : {}), toolName, isError: false });
    }
  }
  return messages.slice(-limit);
}

function pageAfter<T extends { id: string }>(items: T[], after?: string): { page: T[]; next?: string } {
  const sorted = items.filter((item) => after === undefined || item.id > after).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const page = sorted.slice(0, DSH_DIRECTORY_PAGE_SIZE);
  return { page, next: sorted.length > DSH_DIRECTORY_PAGE_SIZE ? page.at(-1)?.id : undefined };
}

const searchKey = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

function resolveCodexBinary(configured?: string): string | undefined {
  if (configured && existsSync(configured)) return configured;
  if (process.platform === "win32") {
    const binRoot = join(localAppData(), "OpenAI", "Codex", "bin");
    if (existsSync(binRoot)) {
      const hits: Array<{ path: string; mtime: number }> = [];
      for (const entry of readdirSync(binRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(binRoot, entry.name, "codex.exe");
        if (!existsSync(candidate)) continue;
        try { hits.push({ path: candidate, mtime: statSync(candidate).mtimeMs }); } catch {}
      }
      if (hits.length) {
        hits.sort((a, b) => b.mtime - a.mtime);
        return hits[0]!.path;
      }
    }
    return onPath("codex");
  }
  return undefined;
}

export class CodexLocalRuntime {
  private readonly codexHome: string;
  private readonly codexBin?: string;
  private readonly enableSend: boolean;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly events: Array<{ event: RuntimeTaskEvent; expiresAt: number }> = [];
  private closed = false;

  constructor(options: CodexLocalRuntimeOptions) {
    if (!options || typeof options.codexHome !== "string" || !options.codexHome.trim()) {
      throw new RuntimeError("bad_request", "Codex 本地目录配置无效。");
    }
    this.codexHome = options.codexHome;
    this.codexBin = options.codexBin;
    this.enableSend = options.enableSend === true;
  }

  get sendEnabled(): boolean {
    return this.enableSend;
  }

  private toEntry(row: ThreadRow): { project: DshDirectoryProject; session: RuntimeSession; archived: boolean } {
    const project = projectForCwd(row.cwd);
    const archived = row.archived === 1;
    const state = probeState(row, this.activeTurns.get(row.id));
    const updatedAt = typeof row.updated_at_ms === "number" && row.updated_at_ms > 0
      ? row.updated_at_ms
      : typeof row.updated_at === "number" && row.updated_at > 0
        ? row.updated_at * 1000
        : undefined;
    const rawTitle = cleanLabel(row.name || row.title || row.first_user_message, `Codex ${row.id.slice(-8)}`);
    return {
      project: { runtime: "codex", id: project.id, title: project.title },
      archived,
      session: {
        id: row.id,
        title: rawTitle,
        state,
        canSend: this.enableSend && !archived && state !== "running" && state !== "attention" && !!row.cwd && existsSync(row.cwd),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      },
    };
  }

  async list(): Promise<RuntimeProject[]> {
    const dbPath = findDbPath(this.codexHome);
    if (!dbPath) return [];
    const rows = queryThreads(dbPath, THREAD_LIST_LIMIT).filter((r) => isRuntimeId(r.id));
    const grouped = new Map<string, RuntimeProject>();
    let sessionCount = 0;
    for (const row of rows) {
      if (sessionCount >= 100) break;
      const entry = this.toEntry(row);
      let project = grouped.get(entry.project.id);
      if (!project) {
        if (grouped.size >= 20) continue;
        project = { runtime: "codex", id: entry.project.id, title: entry.project.title, sessions: [] };
        grouped.set(entry.project.id, project);
      }
      project.sessions.push(entry.session);
      sessionCount++;
    }
    return [...grouped.values()];
  }

  async browse(input: DshDirectoryRequest): Promise<DshDirectoryReply> {
    const dbPath = findDbPath(this.codexHome);
    const rows = dbPath ? queryThreads(dbPath, input.view === "exact" ? 200 : THREAD_LIST_LIMIT).filter((r) => isRuntimeId(r.id)) : [];
    const items = rows.map((row) => this.toEntry(row));
    if (input.view === "projects") {
      const map = new Map<string, DshDirectoryProject>();
      for (const item of items) if (!map.has(item.project.id)) map.set(item.project.id, item.project);
      const { page, next } = pageAfter([...map.values()], input.after);
      return { runtime: "codex", view: "projects", scope: "profile", projects: page, ...(next ? { next } : {}) };
    }
    if (input.view === "exact") {
      const wanted = new Set(input.sessionIds);
      const entries: DshDirectoryEntry[] = items
        .filter((item) => wanted.has(item.session.id))
        .map((item) => ({ runtime: "codex", project: item.project, session: item.session, archived: item.archived }));
      return { runtime: "codex", view: "exact", scope: "profile", entries };
    }
    const needle = searchKey((input.search ?? "").slice(0, DSH_DIRECTORY_SEARCH_LIMIT));
    const matched = items.filter((item) => {
      if (input.projectId !== undefined && item.project.id !== input.projectId) return false;
      if (!needle) return true;
      return [item.project.title, item.project.id, item.session.title, item.session.id].some((s) => searchKey(s).includes(needle));
    });
    const paged = pageAfter(matched.map((m) => ({ id: m.session.id, item: m })), input.after);
    return {
      runtime: "codex",
      view: "sessions",
      scope: "profile",
      entries: paged.page.map(({ item }) => ({ runtime: "codex", project: item.project, session: item.session, archived: item.archived })),
      ...(paged.next ? { next: paged.next } : {}),
    };
  }

  async detail(projectId: string, sessionId: string, limit = 60): Promise<RuntimeSessionDetail> {
    const dbPath = findDbPath(this.codexHome);
    const row = dbPath ? queryThreadById(dbPath, sessionId) : undefined;
    if (!row || !isRuntimeId(row.id)) throw new RuntimeError("not_found", "未找到对应的本地 Codex 会话。");
    const entry = this.toEntry(row);
    if (entry.project.id !== projectId) throw new RuntimeError("not_found", "该 Codex 会话不属于所选项目。");
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 60, 1), RUNTIME_DETAIL_LIMIT);
    const messages = parseRolloutMessages(row.rollout_path, boundedLimit);
    const reply: RuntimeSessionDetail = {
      runtime: "codex",
      project: { id: entry.project.id, title: entry.project.title },
      session: entry.session,
      messages,
      pendingQuestions: [],
      ...(entry.session.canSend ? {} : {
        readOnlyReason: entry.archived
          ? "已归档的 Codex 会话不支持继续发送消息。"
          : entry.session.state === "running"
            ? "该 Codex 会话正在运行中，请等待当前轮结束后再发送。"
            : "该 Codex 会话当前为只读状态。",
      }),
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

  async send({ projectId, sessionId, requestId, text }: RuntimeSessionSend): Promise<RuntimeSessionReceipt> {
    if (this.closed) throw new RuntimeError("offline", "Codex 本地连接器已停止。");
    if (!this.enableSend) throw new RuntimeError("forbidden", "本地 Codex 会话未开启发送授权。");
    const dbPath = findDbPath(this.codexHome);
    const row = dbPath ? queryThreadById(dbPath, sessionId) : undefined;
    if (!row || !isRuntimeId(row.id) || projectForCwd(row.cwd).id !== projectId) {
      throw new RuntimeError("not_found", "未找到对应的本地 Codex 会话。");
    }
    if (row.archived || !row.cwd || !existsSync(row.cwd)) {
      throw new RuntimeError("not_found", "该 Codex 会话已归档或工作目录不可访问。");
    }
    if (this.activeTurns.has(sessionId) || probeState(row) === "running") {
      throw new RuntimeError("not_found", "该 Codex 会话当前正在工作，请稍后再试。");
    }
    if (this.activeTurns.size >= MAX_CONCURRENT_TURNS) {
      throw new RuntimeError("offline", "后台 Codex 任务数已达上限，请等待现有任务完成后再试。");
    }
    const exe = resolveCodexBinary(this.codexBin);
    if (!exe) throw new RuntimeError("unsupported", "未在本机找到 Codex Desktop 可执行程序。");

    const useNode = /\.(?:mjs|js|cjs)$/i.test(exe);
    const child = spawn(useNode ? process.execPath : exe, useNode ? [exe, "app-server", "--listen", "stdio://"] : ["app-server", "--listen", "stdio://"], {
      cwd: row.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let nextRpcId = 1;
    let settledTurn = false;
    let handoffDone = false;
    let emittedProgress = false;
    let emittedTerminal = false;
    let activeTurnId = "";
    const pendingRpc = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

    const cleanupChild = () => {
      const tracked = this.activeTurns.get(sessionId);
      if (tracked?.child === child) {
        clearTimeout(tracked.timer);
        this.activeTurns.delete(sessionId);
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
      this.pushTaskEvent(requestId, kind);
      cleanupChild();
    };

    child.stdout.on("data", lineSplitter((line) => {
      let packet: Record<string, unknown>;
      try { packet = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      const id = packet.id;
      const method = packet.method;
      if (typeof method === "string") {
        // Server-initiated interactive approval / user input request cannot complete unattended.
        if (typeof id === "number" || typeof id === "string") {
          const tracked = this.activeTurns.get(sessionId);
          if (tracked) tracked.attention = true;
          if (handoffDone && !emittedTerminal) {
            this.pushTaskEvent(requestId, "attention");
            emitTerminal("stopped");
          } else {
            failPendingRpc(new RuntimeError("not_found", "Codex 请求人工交互确认，请在桌面窗口查看。"));
            cleanupChild();
          }
          return;
        }
        if (handoffDone && method === "item/completed" && !emittedProgress) {
          emittedProgress = true;
          this.pushTaskEvent(requestId, "progress");
        } else if (handoffDone && method === "turn/completed") {
          const p = packet.params && typeof packet.params === "object" ? packet.params as Record<string, unknown> : undefined;
          const turn = p?.turn && typeof p.turn === "object" ? p.turn as Record<string, unknown> : undefined;
          if (p?.threadId === sessionId && (!activeTurnId || turn?.id === activeTurnId)) {
            emitTerminal(turn?.status === "completed" ? "completed" : "stopped");
          }
        }
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
      failPendingRpc(new Error("codex app-server exited"));
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
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });

    try {
      await rpc("initialize", { clientInfo: { name: "xiaoaixiaoai_hostd", title: "小爱小爱", version: VERSION } }, 15_000);
      child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

      let resumed: Record<string, unknown> | undefined;
      try {
        resumed = await rpc("thread/resume", { threadId: sessionId, cwd: row.cwd, excludeTurns: true }, 20_000);
      } catch {
        throw new RuntimeError("not_found", "该 Codex 会话正被桌面窗口占用或暂时无法续跑。");
      }
      const resumedThread = resumed?.thread && typeof resumed.thread === "object" ? resumed.thread as Record<string, unknown> : undefined;
      const resumedCwd = typeof resumed?.cwd === "string" ? resumed.cwd : "";
      const norm = (p: string) => {
        const raw = p.replace(/^\\\\\?\\/, "");
        try { return realpathSync(raw).toLowerCase(); } catch { return resolve(raw).toLowerCase(); }
      };
      if (resumedThread?.id !== sessionId || !resumedCwd || norm(resumedCwd) !== norm(row.cwd)) {
        throw new RuntimeError("not_found", "Codex 会话工作目录或身份不一致，未发送。");
      }

      const started = await rpc("turn/start", { threadId: sessionId, input: [{ type: "text", text }] }, 20_000);
      const startedTurn = started?.turn && typeof started.turn === "object" ? started.turn as Record<string, unknown> : undefined;
      activeTurnId = typeof startedTurn?.id === "string" ? startedTurn.id : "";
      if (!activeTurnId) throw new RuntimeError("outcome_unknown", "未收到 Codex 轮次确认，请在原会话核对。");

      settledTurn = true;
      handoffDone = true;
      const timer = setTimeout(() => emitTerminal("stopped"), BACKGROUND_TURN_TIMEOUT_MS);
      timer.unref();
      this.activeTurns.set(sessionId, { child, attention: false, timer });
      return { accepted: true, requestId, ...(isRuntimeId(activeTurnId) ? { receiptId: activeTurnId } : {}) };
    } finally {
      if (!settledTurn) {
        failPendingRpc(new Error("aborted"));
        cleanupChild();
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const [id, entry] of this.activeTurns) {
      clearTimeout(entry.timer);
      try { entry.child.kill(); } catch {}
      this.activeTurns.delete(id);
    }
    this.events.length = 0;
  }
}
