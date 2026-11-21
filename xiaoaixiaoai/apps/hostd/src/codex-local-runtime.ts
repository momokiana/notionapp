import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
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
  type ModelQuota,
  type QuotaWindow,
  type RuntimeProject,
  type RuntimeSession,
  type RuntimeSessionDetail,
  type RuntimeSessionMessage,
  type RuntimeSessionReceipt,
  type RuntimeSessionSend,
  type RuntimeSessionState,
  type RuntimeTaskEvent,
  type SubSession,
} from "@xiaoaixiaoai/protocol";
import { VERSION } from "@xiaoaixiaoai/update";
import { localAppData, onPath } from "./platform.ts";
import { RuntimeError } from "./runtime-sessions.ts";
import { lineSplitter } from "./util.ts";

const THREAD_LIST_LIMIT = 80;
const STATUS_TAIL_BYTES = 64 * 1024;
const DETAIL_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_TEXT = 32_000;
const MAX_DETAIL_BYTES = 460 * 1024;
const RECENT_ACTIVE_WINDOW_MS = 15 * 60_000;
const MAX_CONCURRENT_TURNS = 2;
const BACKGROUND_TURN_TIMEOUT_MS = 30 * 60_000;
const RECENT_CREATED_TTL_MS = 10 * 60_000;
const TASK_EVENT_LIMIT = 128;
const TASK_EVENT_TTL_MS = 15 * 60_000;
const ACCOUNT_QUOTA_TTL_MS = 60_000;
const ACCOUNT_QUOTA_ERROR_TTL_MS = 20_000;
const ACCOUNT_QUOTA_STALE_MAX_MS = 5 * 60_000;
const ACCOUNT_QUOTA_TIMEOUT_MS = 8_000;

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
  source?: string | null;
  thread_source?: string | null;
  attached_thread_parent_id?: string | null;
  agent_nickname?: string | null;
  agent_role?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
}

interface RolloutMeta {
  model?: string;
  contextTokens?: number;
  contextLimit?: number;
}

interface ActiveTurn {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  projectId: string;
  turnId: string;
  attention: boolean;
  timer: NodeJS.Timeout;
  rpc: (method: string, params: unknown, timeoutMs: number) => Promise<Record<string, unknown> | undefined>;
  emitTerminal: (kind: "completed" | "stopped") => void;
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

function threadExtraSelect(db: DatabaseSync): string {
  const cols = new Set((db.prepare(`PRAGMA table_info(threads)`).all() as Array<{ name?: string }>).map((c) => c.name));
  const extras = ["source", "thread_source", "attached_thread_parent_id", "agent_nickname", "agent_role", "model", "reasoning_effort"].filter((c) => cols.has(c));
  return extras.length ? `, ${extras.join(", ")}` : "";
}

function parseParentThreadId(row: ThreadRow): string | undefined {
  if (typeof row.attached_thread_parent_id === "string" && row.attached_thread_parent_id.trim()) {
    return row.attached_thread_parent_id.trim();
  }
  if (typeof row.source !== "string" || !row.source.trim().startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(row.source) as Record<string, unknown>;
    const sub = parsed?.subagent && typeof parsed.subagent === "object" ? (parsed.subagent as Record<string, unknown>) : undefined;
    const spawn = sub?.thread_spawn && typeof sub.thread_spawn === "object" ? (sub.thread_spawn as Record<string, unknown>) : undefined;
    const pid = typeof spawn?.parent_thread_id === "string" ? spawn.parent_thread_id.trim() : typeof sub?.parent_thread_id === "string" ? sub.parent_thread_id.trim() : "";
    return pid && pid !== row.id ? pid : undefined;
  } catch {
    return undefined;
  }
}

function queryThreads(dbPath: string, limit: number): ThreadRow[] {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const extra = threadExtraSelect(db);
    return db.prepare(`
      SELECT id, rollout_path, cwd, title, name, first_user_message, archived, updated_at, updated_at_ms${extra}
      FROM threads
      WHERE (thread_source IS NULL OR thread_source = 'user')
      ORDER BY COALESCE(archived, 0) ASC, COALESCE(updated_at_ms, updated_at * 1000) DESC
      LIMIT ?
    `).all(limit) as unknown as ThreadRow[];
  } finally {
    db.close();
  }
}

function queryThreadById(dbPath: string, threadId: string, includeSubagent = false): ThreadRow | undefined {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const extra = threadExtraSelect(db);
    const whereUser = includeSubagent ? "" : " AND (thread_source IS NULL OR thread_source = 'user')";
    return db.prepare(`
      SELECT id, rollout_path, cwd, title, name, first_user_message, archived, updated_at, updated_at_ms${extra}
      FROM threads
      WHERE id = ?${whereUser}
      LIMIT 1
    `).get(threadId) as unknown as ThreadRow | undefined;
  } finally {
    db.close();
  }
}

function querySubagentRows(dbPath: string): ThreadRow[] {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const extra = threadExtraSelect(db);
    if (!extra.includes("source") && !extra.includes("attached_thread_parent_id")) return [];
    return db.prepare(`
      SELECT id, rollout_path, cwd, title, name, first_user_message, archived, updated_at, updated_at_ms${extra}
      FROM threads
      WHERE thread_source IS NOT NULL AND thread_source != 'user' AND COALESCE(archived, 0) = 0
      ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC
      LIMIT 200
    `).all() as unknown as ThreadRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function formatWindowLabel(minutes: number): string {
  if (minutes === 10080) return "每周";
  if (minutes >= 1440) {
    const days = Math.round(minutes / 1440);
    return `${days}天`;
  }
  if (minutes >= 60) {
    const hours = Math.round(minutes / 60);
    return `${hours}小时`;
  }
  return `${minutes}分钟`;
}

function parseQuotaWindow(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const rawUsed = typeof r.usedPercent === "number" ? r.usedPercent : r.used_percent;
  const used = typeof rawUsed === "number" && Number.isFinite(rawUsed) ? rawUsed : undefined;
  if (used === undefined) return undefined;
  const remainingPercent = Math.max(0, Math.min(100, Math.round((100 - used) * 10) / 10));
  const rawMins = typeof r.windowDurationMins === "number" ? r.windowDurationMins : r.window_minutes;
  const windowMinutes = typeof rawMins === "number" && Number.isSafeInteger(rawMins) && rawMins > 0
    ? rawMins
    : undefined;
  const rawReset = typeof r.resetsAt === "number" ? r.resetsAt : r.resets_at;
  const resetsAt = typeof rawReset === "number" && Number.isFinite(rawReset) && rawReset > 0
    ? Math.trunc(rawReset >= 1e12 ? rawReset : rawReset * 1000)
    : undefined;
  return {
    remainingPercent,
    ...(windowMinutes !== undefined ? { windowMinutes, label: formatWindowLabel(windowMinutes) } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function parseAccountRateLimits(raw: unknown, updatedAt?: number): ModelQuota | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const root = raw as Record<string, unknown>;
  const byId = root.rateLimitsByLimitId && typeof root.rateLimitsByLimitId === "object"
    ? root.rateLimitsByLimitId as Record<string, unknown>
    : undefined;
  const snapObj = (byId?.codex && typeof byId.codex === "object" ? byId.codex : undefined)
    ?? (root.rateLimits && typeof root.rateLimits === "object" ? root.rateLimits : undefined)
    ?? (byId ? Object.values(byId).find((v) => v && typeof v === "object") : undefined)
    ?? root;
  if (!snapObj || typeof snapObj !== "object") return undefined;
  const rl = snapObj as Record<string, unknown>;

  const windows = [parseQuotaWindow(rl.primary), parseQuotaWindow(rl.secondary)]
    .filter((w): w is QuotaWindow => w !== undefined);
  if (windows.length === 2 && windows[0]!.windowMinutes !== undefined && windows[1]!.windowMinutes !== undefined) {
    windows.sort((a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity));
  }
  const primary = windows[0];
  const secondary = windows[1];

  const credits = rl.credits && typeof rl.credits === "object" ? rl.credits as Record<string, unknown> : undefined;
  const hasCredits = credits?.hasCredits === true || credits?.has_credits === true;
  let balance: string | undefined;
  if (hasCredits && credits?.unlimited !== true && credits?.balance !== undefined && credits?.balance !== null) {
    const num = Number(credits.balance);
    if (Number.isFinite(num) && num > 0) balance = num >= 100 ? num.toFixed(0) : num.toFixed(2);
    else if (typeof credits.balance === "string" && credits.balance.trim() && credits.balance.trim() !== "0") {
      balance = credits.balance.trim().slice(0, 32);
    }
  }
  const rawPlan = typeof rl.planType === "string" ? rl.planType : typeof rl.plan_type === "string" ? rl.plan_type : "";
  const plan = rawPlan.trim() ? cleanLabel(rawPlan, "") : undefined;

  const hasShortWindow = windows.some((w) => w.windowMinutes !== undefined && w.windowMinutes <= 360);
  const hasWeeklyWindow = windows.some((w) => w.windowMinutes !== undefined && w.windowMinutes >= 1440);
  const noteParts: string[] = [];
  if (hasWeeklyWindow && !hasShortWindow) noteParts.push("当前账号未返回5小时窗口");
  else if (hasShortWindow && !hasWeeklyWindow) noteParts.push("当前账号未返回每周窗口");
  const reached = typeof rl.rateLimitReachedType === "string" && rl.rateLimitReachedType.trim() ? rl.rateLimitReachedType.trim() : "";
  if (reached) noteParts.push("已达限额");
  const note = noteParts.length ? noteParts.join(" · ") : undefined;

  if (!primary && !secondary && !balance) {
    return {
      available: false,
      ...(plan ? { plan } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      note: "Codex 账号未返回窗口限额数据",
    };
  }
  return {
    available: true,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(balance ? { balance } : {}),
    ...(plan ? { plan } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(note ? { note } : {}),
  };
}

function extractRolloutMeta(rolloutPath: string): RolloutMeta {
  const meta: RolloutMeta = {};
  const lines = readTailLines(rolloutPath, STATUS_TAIL_BYTES);
  for (let i = lines.length - 1; i >= 0; i--) {
    let record: Record<string, unknown>;
    try { record = JSON.parse(lines[i]!) as Record<string, unknown>; } catch { continue; }
    const p = record.payload && typeof record.payload === "object" ? record.payload as Record<string, unknown> : undefined;
    if (!p) continue;
    if (record.type === "turn_context" && !meta.model) {
      const collab = p.collaboration_mode && typeof p.collaboration_mode === "object" ? p.collaboration_mode as Record<string, unknown> : undefined;
      const settings = collab?.settings && typeof collab.settings === "object" ? collab.settings as Record<string, unknown> : undefined;
      const rawModel = typeof p.model === "string" ? p.model : typeof settings?.model === "string" ? settings.model : "";
      if (rawModel.trim()) meta.model = cleanLabel(rawModel, "");
    } else if (record.type === "event_msg" && p.type === "token_count") {
      if (meta.contextTokens === undefined || meta.contextLimit === undefined) {
        const info = p.info && typeof p.info === "object" ? p.info as Record<string, unknown> : undefined;
        const lastUsage = info?.last_token_usage && typeof info.last_token_usage === "object" ? info.last_token_usage as Record<string, unknown> : undefined;
        const tot = typeof lastUsage?.total_tokens === "number" && Number.isSafeInteger(lastUsage.total_tokens) && lastUsage.total_tokens >= 0
          ? lastUsage.total_tokens
          : typeof lastUsage?.input_tokens === "number" && Number.isSafeInteger(lastUsage.input_tokens) && lastUsage.input_tokens >= 0
            ? lastUsage.input_tokens
            : undefined;
        const lim = typeof info?.model_context_window === "number" && Number.isSafeInteger(info.model_context_window) && info.model_context_window > 0
          ? info.model_context_window
          : undefined;
        if (tot !== undefined && meta.contextTokens === undefined) meta.contextTokens = tot;
        if (lim !== undefined && meta.contextLimit === undefined) meta.contextLimit = lim;
      }
    }
    if (meta.model && meta.contextTokens !== undefined && meta.contextLimit !== undefined) break;
  }
  return meta;
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

function normalizeCwd(p: string): string {
  const raw = p.replace(/^\\\\\?\\/, "");
  try { return realpathSync(raw).toLowerCase(); } catch { return resolve(raw).toLowerCase(); }
}

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
    const roaming = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    for (const candidate of [
      join(roaming, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
      join(roaming, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-arm64", "vendor", "aarch64-pc-windows-msvc", "bin", "codex.exe"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    return onPath("codex");
  }
  return onPath("codex");
}

function spawnCodexAppServer(exe: string, cwd: string, codexHome?: string): ChildProcessByStdio<Writable, Readable, Readable> {
  const env = codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env;
  const opts = { cwd, env, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], windowsHide: true };
  if (/\.(?:mjs|js|cjs)$/i.test(exe)) {
    return spawn(process.execPath, [exe, "app-server", "--listen", "stdio://"], opts);
  }
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(exe)) {
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", exe, "app-server", "--listen", "stdio://"], opts);
  }
  if (process.platform === "win32" && /\.ps1$/i.test(exe)) {
    return spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", exe, "app-server", "--listen", "stdio://"], opts);
  }
  return spawn(exe, ["app-server", "--listen", "stdio://"], opts);
}

export class CodexLocalRuntime {
  private readonly codexHome: string;
  private readonly codexBin?: string;
  private readonly enableSend: boolean;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly recentCreated = new Map<string, { row: ThreadRow; expiresAt: number }>();
  private readonly rolloutCache = new Map<string, { mtimeMs: number; size: number; meta: RolloutMeta }>();
  private readonly events: Array<{ event: RuntimeTaskEvent; expiresAt: number }> = [];
  private accountQuota?: ModelQuota;
  private accountQuotaFetchedAt = 0;
  private accountQuotaCheckedAt = 0;
  private accountQuotaInFlight?: Promise<ModelQuota | undefined>;
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

  private pruneRecentCreated(): void {
    const now = Date.now();
    for (const [id, entry] of this.recentCreated) {
      if (entry.expiresAt <= now) this.recentCreated.delete(id);
    }
  }

  private listRows(limit: number): ThreadRow[] {
    this.pruneRecentCreated();
    const dbPath = findDbPath(this.codexHome);
    const dbRows = dbPath ? queryThreads(dbPath, limit).filter((r) => isRuntimeId(r.id)) : [];
    if (this.recentCreated.size === 0) return dbRows;
    const seen = new Set(dbRows.map((r) => r.id));
    const extras: ThreadRow[] = [];
    for (const [id, entry] of this.recentCreated) {
      if (seen.has(id)) this.recentCreated.delete(id);
      else extras.push(entry.row);
    }
    if (extras.length === 0) return dbRows;
    const rowTs = (r: ThreadRow) => (typeof r.updated_at_ms === "number" && r.updated_at_ms > 0 ? r.updated_at_ms : r.updated_at * 1000);
    return [...extras, ...dbRows].sort((a, b) => rowTs(b) - rowTs(a)).slice(0, limit);
  }

  private findRow(sessionId: string, includeSubagent = false): ThreadRow | undefined {
    this.pruneRecentCreated();
    const dbPath = findDbPath(this.codexHome);
    const dbRow = dbPath ? queryThreadById(dbPath, sessionId, includeSubagent) : undefined;
    if (dbRow && isRuntimeId(dbRow.id)) {
      this.recentCreated.delete(sessionId);
      return dbRow;
    }
    return this.recentCreated.get(sessionId)?.row;
  }

  private subagentIndex() {
    const dbPath = findDbPath(this.codexHome);
    const rows = dbPath ? querySubagentRows(dbPath).filter((r) => isRuntimeId(r.id)) : [];
    const parentOf = new Map<string, string>();
    const childrenByParent = new Map<string, Array<{ row: ThreadRow; working: boolean }>>();
    const countsByParent = new Map<string, [number, number]>();
    for (const r of rows) {
      const pid = parseParentThreadId(r);
      if (pid) parentOf.set(r.id, pid);
    }
    for (const r of rows) {
      const pid = parentOf.get(r.id);
      if (!pid) continue;
      const working = probeState(r, this.activeTurns.get(r.id)) === "running";
      const list = childrenByParent.get(pid) ?? [];
      list.push({ row: r, working });
      childrenByParent.set(pid, list);
      const direct = countsByParent.get(pid) ?? [0, 0];
      direct[0]++;
      countsByParent.set(pid, direct);
      if (working) {
        let anc: string | undefined = pid;
        const seen = new Set<string>([r.id]);
        for (let depth = 0; anc && depth < 12 && !seen.has(anc); depth++) {
          seen.add(anc);
          const ac = countsByParent.get(anc) ?? [0, 0];
          ac[1]++;
          countsByParent.set(anc, ac);
          anc = parentOf.get(anc);
        }
      }
    }
    return { parentOf, childrenByParent, countsByParent };
  }

  knownFolders(): Array<{ id: string; title: string; path: string; updatedAt?: number }> {
    const seen = new Map<string, { id: string; title: string; path: string; updatedAt?: number }>();
    for (const row of this.listRows(THREAD_LIST_LIMIT)) {
      if (!row.cwd || !existsSync(row.cwd)) continue;
      const key = normalizeCwd(row.cwd);
      const updatedAt = typeof row.updated_at_ms === "number" && row.updated_at_ms > 0
        ? row.updated_at_ms
        : typeof row.updated_at === "number" && row.updated_at > 0
          ? row.updated_at * 1000
          : undefined;
      const project = projectForCwd(row.cwd);
      const prev = seen.get(key);
      if (!prev || ((updatedAt ?? 0) > (prev.updatedAt ?? 0))) {
        seen.set(key, { id: project.id, title: project.title, path: row.cwd, ...(updatedAt !== undefined ? { updatedAt } : {}) });
      }
    }
    return [...seen.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  private readRolloutMeta(rolloutPath: string): RolloutMeta {
    if (!rolloutPath) return {};
    try {
      if (!existsSync(rolloutPath)) return {};
      const st = statSync(rolloutPath);
      const cached = this.rolloutCache.get(rolloutPath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.meta;
      const meta = extractRolloutMeta(rolloutPath);
      if (this.rolloutCache.size > 200) this.rolloutCache.clear();
      this.rolloutCache.set(rolloutPath, { mtimeMs: st.mtimeMs, size: st.size, meta });
      return meta;
    } catch {
      return {};
    }
  }

  private async readAccountQuota(force = false): Promise<ModelQuota | undefined> {
    if (this.closed) return this.accountQuota;
    const now = Date.now();
    const ttl = this.accountQuota?.available ? ACCOUNT_QUOTA_TTL_MS : ACCOUNT_QUOTA_ERROR_TTL_MS;
    if (!force && this.accountQuotaCheckedAt > 0 && now - this.accountQuotaCheckedAt < ttl) {
      return this.accountQuota;
    }
    if (this.accountQuotaInFlight) return this.accountQuotaInFlight;

    const run = (async (): Promise<ModelQuota | undefined> => {
      const exe = resolveCodexBinary(this.codexBin);
      const checkedAt = Date.now();
      if (!exe) {
        this.accountQuotaCheckedAt = checkedAt;
        this.accountQuota = { available: false, updatedAt: checkedAt, note: "未在本机找到 Codex CLI，无法查询账号实时额度" };
        return this.accountQuota;
      }
      const cwd = existsSync(this.codexHome) ? this.codexHome : homedir();
      let server: Awaited<ReturnType<CodexLocalRuntime["openAppServer"]>> | undefined;
      try {
        server = await this.openAppServer(cwd);
        const res = await server.rpc("account/rateLimits/read", {}, ACCOUNT_QUOTA_TIMEOUT_MS);
        const fetchedAt = Date.now();
        const parsed = parseAccountRateLimits(res, fetchedAt);
        this.accountQuotaCheckedAt = fetchedAt;
        if (parsed) {
          this.accountQuota = parsed;
          if (parsed.available) this.accountQuotaFetchedAt = fetchedAt;
          return this.accountQuota;
        }
        this.accountQuota = { available: false, updatedAt: fetchedAt, note: "Codex 账号未返回窗口限额数据" };
        return this.accountQuota;
      } catch {
        const failedAt = Date.now();
        this.accountQuotaCheckedAt = failedAt;
        if (this.accountQuota?.available && this.accountQuotaFetchedAt > 0 && failedAt - this.accountQuotaFetchedAt <= ACCOUNT_QUOTA_STALE_MAX_MS) {
          return this.accountQuota;
        }
        this.accountQuota = { available: false, updatedAt: failedAt, note: "Codex 账号实时额度查询失败" };
        return this.accountQuota;
      } finally {
        server?.abort();
      }
    })();

    this.accountQuotaInFlight = run;
    try {
      return await run;
    } finally {
      if (this.accountQuotaInFlight === run) this.accountQuotaInFlight = undefined;
    }
  }

  private toEntry(row: ThreadRow, counts?: [number, number], readOnlyChild = false, accountQuota?: ModelQuota): { project: DshDirectoryProject; session: RuntimeSession; archived: boolean } {
    const project = projectForCwd(row.cwd);
    const archived = row.archived === 1;
    const state = probeState(row, this.activeTurns.get(row.id));
    const updatedAt = typeof row.updated_at_ms === "number" && row.updated_at_ms > 0
      ? row.updated_at_ms
      : typeof row.updated_at === "number" && row.updated_at > 0
        ? row.updated_at * 1000
        : undefined;
    const rawTitle = cleanLabel(row.name || row.agent_nickname || row.title || row.first_user_message, `Codex ${row.id.slice(-8)}`);
    const meta = this.readRolloutMeta(row.rollout_path);
    const baseModel = typeof row.model === "string" && row.model.trim() ? cleanLabel(row.model, "") : meta.model;
    const model = baseModel
      ? (typeof row.reasoning_effort === "string" && row.reasoning_effort.trim() && !baseModel.includes("(")
        ? `${baseModel} (${row.reasoning_effort.trim()})`
        : baseModel)
      : undefined;
    const quota = accountQuota;
    return {
      project: { runtime: "codex", id: project.id, title: project.title },
      archived,
      session: {
        id: row.id,
        title: rawTitle,
        state,
        canSend: !readOnlyChild && this.enableSend && !archived && state !== "running" && state !== "attention" && !!row.cwd && existsSync(row.cwd),
        ...(model ? { model } : {}),
        ...(meta.contextTokens !== undefined ? { contextTokens: meta.contextTokens } : {}),
        ...(meta.contextLimit !== undefined ? { contextLimit: meta.contextLimit } : {}),
        ...(quota ? { modelQuota: quota } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        ...(counts?.[0] ? { subagents: counts[0], subagentsWorking: counts[1] } : {}),
      },
    };
  }

  async list(): Promise<RuntimeProject[]> {
    const rows = this.listRows(THREAD_LIST_LIMIT);
    if (!rows.length) return [];
    const accountQuota = await this.readAccountQuota();
    const { countsByParent } = this.subagentIndex();
    const grouped = new Map<string, RuntimeProject>();
    let sessionCount = 0;
    for (const row of rows) {
      if (sessionCount >= 100) break;
      const entry = this.toEntry(row, countsByParent.get(row.id), false, accountQuota);
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
    const rows = this.listRows(input.view === "exact" ? 200 : THREAD_LIST_LIMIT);
    const accountQuota = await this.readAccountQuota();
    const { countsByParent } = this.subagentIndex();
    const items = rows.map((row) => this.toEntry(row, countsByParent.get(row.id), false, accountQuota));
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

  children(parentSessionId: string): Array<Omit<SubSession, "key"> & { sessionId: string }> {
    if (!isRuntimeId(parentSessionId)) return [];
    const { childrenByParent, countsByParent } = this.subagentIndex();
    const list = childrenByParent.get(parentSessionId) ?? [];
    return list
      .map(({ row, working }) => {
        const subCounts = countsByParent.get(row.id);
        const effWorking = working || (subCounts?.[1] ?? 0) > 0;
        const updatedAt = typeof row.updated_at_ms === "number" && row.updated_at_ms > 0
          ? row.updated_at_ms
          : typeof row.updated_at === "number" && row.updated_at > 0
            ? row.updated_at * 1000
            : Date.now();
        const title = cleanLabel(
          [row.agent_nickname, row.agent_role ? `(${row.agent_role})` : ""].filter(Boolean).join(" ") || row.name || row.title || row.first_user_message,
          `Codex 子线程 ${row.id.slice(-8)}`,
        );
        const preview = cleanLabel(row.first_user_message || row.title, "");
        return {
          sessionId: row.id,
          parent: parentSessionId,
          harness: "codex",
          title,
          ...(preview && preview !== title ? { preview } : {}),
          status: (effWorking ? "working" : "idle") as SubSession["status"],
          updatedAt,
          children: subCounts?.[0] ?? 0,
        };
      })
      .sort((a, b) => Number(b.status === "working") - Number(a.status === "working") || b.updatedAt - a.updatedAt);
  }

  descends(sessionId: string, rootSessionId: string): boolean {
    if (!isRuntimeId(sessionId) || !isRuntimeId(rootSessionId)) return false;
    const { parentOf } = this.subagentIndex();
    let cur: string | undefined = sessionId;
    const seen = new Set<string>();
    for (let i = 0; cur && i < 12 && !seen.has(cur); i++) {
      if (cur === rootSessionId) return true;
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    return false;
  }

  async detail(projectId: string, sessionId: string, limit = 60): Promise<RuntimeSessionDetail> {
    const row = this.findRow(sessionId, true);
    if (!row || !isRuntimeId(row.id)) throw new RuntimeError("not_found", "未找到对应的本地 Codex 会话。");
    const isChild = Boolean(parseParentThreadId(row) || (row.thread_source != null && row.thread_source !== "user"));
    const accountQuota = await this.readAccountQuota();
    const { countsByParent } = this.subagentIndex();
    const entry = this.toEntry(row, countsByParent.get(row.id), isChild, accountQuota);
    if (entry.project.id !== projectId) throw new RuntimeError("not_found", "该 Codex 会话不属于所选项目。");
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 60, 1), RUNTIME_DETAIL_LIMIT);
    let messages = row.rollout_path && existsSync(row.rollout_path) ? parseRolloutMessages(row.rollout_path, boundedLimit) : [];
    if (messages.length === 0 && row.first_user_message) {
      messages = [{ id: `cx-init-${row.id}`, role: "user", text: cleanText(row.first_user_message, MAX_MESSAGE_TEXT) || row.first_user_message }];
    }
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

  private async openAppServer(cwd: string) {
    const exe = resolveCodexBinary(this.codexBin);
    if (!exe) throw new RuntimeError("unsupported", "未在本机找到 Codex Desktop 可执行程序。");
    const child = spawnCodexAppServer(exe, cwd, this.codexHome);

    let nextRpcId = 1;
    let handoffDone = false;
    let emittedProgress = false;
    let emittedTerminal = false;
    let boundProjectId = "";
    let boundSessionId = "";
    let boundTurnId = "";
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

    child.stdout.on("data", lineSplitter((line) => {
      let packet: Record<string, unknown>;
      try { packet = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      const id = packet.id;
      const method = packet.method;
      if (typeof method === "string") {
        // Server-initiated interactive approval / user input request cannot complete unattended.
        if (typeof id === "number" || typeof id === "string") {
          const tracked = boundSessionId ? this.activeTurns.get(boundSessionId) : undefined;
          if (tracked) tracked.attention = true;
          if (handoffDone && !emittedTerminal) {
            if (boundRequestId) this.pushTaskEvent(boundRequestId, "attention");
            emitTerminal("stopped");
          } else {
            failPendingRpc(new RuntimeError("not_found", "Codex 请求人工交互确认，请在桌面窗口查看。"));
            cleanupChild();
          }
          return;
        }
        if (method === "account/rateLimits/updated") {
          const now = Date.now();
          const parsed = parseAccountRateLimits(packet.params, now);
          if (parsed) {
            this.accountQuota = parsed;
            this.accountQuotaCheckedAt = now;
            if (parsed.available) this.accountQuotaFetchedAt = now;
          }
          return;
        }
        if (handoffDone && method === "item/completed" && !emittedProgress && boundRequestId) {
          emittedProgress = true;
          this.pushTaskEvent(boundRequestId, "progress");
        } else if (handoffDone && method === "turn/completed") {
          const p = packet.params && typeof packet.params === "object" ? packet.params as Record<string, unknown> : undefined;
          const turn = p?.turn && typeof p.turn === "object" ? p.turn as Record<string, unknown> : undefined;
          if (p?.threadId === boundSessionId && (!boundTurnId || turn?.id === boundTurnId)) {
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

    await rpc("initialize", { clientInfo: { name: "xiaoaixiaoai_hostd", title: "小爱小爱", version: VERSION } }, 15_000);
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

    return {
      rpc,
      bindTurn: (projectId: string, sessionId: string, turnId: string, requestId?: string) => {
        boundProjectId = projectId;
        boundSessionId = sessionId;
        boundTurnId = turnId;
        boundRequestId = requestId;
        handoffDone = true;
        const timer = setTimeout(() => emitTerminal("stopped"), BACKGROUND_TURN_TIMEOUT_MS);
        timer.unref();
        this.activeTurns.set(sessionId, { child, projectId: boundProjectId, turnId: boundTurnId, attention: false, timer, rpc, emitTerminal });
      },
      abort: () => {
        failPendingRpc(new Error("aborted"));
        cleanupChild();
      },
    };
  }

  async send({ projectId, sessionId, requestId, text }: RuntimeSessionSend): Promise<RuntimeSessionReceipt> {
    if (this.closed) throw new RuntimeError("offline", "Codex 本地连接器已停止。");
    if (!this.enableSend) throw new RuntimeError("forbidden", "本地 Codex 会话未开启发送授权。");
    const row = this.findRow(sessionId);
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

    const server = await this.openAppServer(row.cwd);
    let settledTurn = false;
    try {
      let resumed: Record<string, unknown> | undefined;
      try {
        resumed = await server.rpc("thread/resume", { threadId: sessionId, cwd: row.cwd, excludeTurns: true }, 20_000);
      } catch {
        throw new RuntimeError("not_found", "该 Codex 会话正被桌面窗口占用或暂时无法续跑。");
      }
      const resumedThread = resumed?.thread && typeof resumed.thread === "object" ? resumed.thread as Record<string, unknown> : undefined;
      const resumedCwd = typeof resumed?.cwd === "string" ? resumed.cwd : "";
      if (resumedThread?.id !== sessionId || !resumedCwd || normalizeCwd(resumedCwd) !== normalizeCwd(row.cwd)) {
        throw new RuntimeError("not_found", "Codex 会话工作目录或身份不一致，未发送。");
      }

      const started = await server.rpc("turn/start", { threadId: sessionId, input: [{ type: "text", text }] }, 20_000);
      const startedTurn = started?.turn && typeof started.turn === "object" ? started.turn as Record<string, unknown> : undefined;
      const activeTurnId = typeof startedTurn?.id === "string" ? startedTurn.id : "";
      if (!activeTurnId) throw new RuntimeError("outcome_unknown", "未收到 Codex 轮次确认，请在原会话核对。");

      settledTurn = true;
      server.bindTurn(projectId, sessionId, activeTurnId, requestId);
      return { accepted: true, requestId, ...(isRuntimeId(activeTurnId) ? { receiptId: activeTurnId } : {}) };
    } finally {
      if (!settledTurn) server.abort();
    }
  }

  async create(input: {
    cwd?: string;
    projectId?: string;
    task?: string;
    requestId?: string;
  }): Promise<{ projectId: string; sessionId: string; title: string; cwd: string; state: RuntimeSessionState; receiptId?: string }> {
    if (this.closed) throw new RuntimeError("offline", "Codex 本地连接器已停止。");
    if (!this.enableSend) throw new RuntimeError("forbidden", "本地 Codex 会话未开启发送授权。");
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
      throw new RuntimeError("offline", "后台 Codex 任务数已达上限，请等待现有任务完成后再试。");
    }

    const server = await this.openAppServer(resolvedCwd);
    let keepRunning = false;
    try {
      const startedThreadRes = await server.rpc("thread/start", { cwd: resolvedCwd }, 20_000);
      const thread = startedThreadRes?.thread && typeof startedThreadRes.thread === "object"
        ? startedThreadRes.thread as Record<string, unknown>
        : undefined;
      const threadId = typeof thread?.id === "string" ? thread.id : "";
      if (!isRuntimeId(threadId)) throw new RuntimeError("outcome_unknown", "未收到有效的 Codex 会话标识。");

      const project = projectForCwd(resolvedCwd);
      const nowMs = Date.now();
      const title = cleanLabel(task || basename(resolvedCwd), `Codex ${threadId.slice(-8)}`);
      const row: ThreadRow = {
        id: threadId,
        rollout_path: typeof thread?.path === "string" ? thread.path : "",
        cwd: resolvedCwd,
        title,
        name: null,
        first_user_message: task || "",
        archived: 0,
        updated_at: Math.floor(nowMs / 1000),
        updated_at_ms: nowMs,
      };
      this.recentCreated.set(threadId, { row, expiresAt: nowMs + RECENT_CREATED_TTL_MS });

      if (!task) {
        return { projectId: project.id, sessionId: threadId, title, cwd: resolvedCwd, state: "idle" };
      }

      const started = await server.rpc("turn/start", { threadId, input: [{ type: "text", text: task }] }, 20_000);
      const startedTurn = started?.turn && typeof started.turn === "object" ? started.turn as Record<string, unknown> : undefined;
      const activeTurnId = typeof startedTurn?.id === "string" ? startedTurn.id : "";
      if (!activeTurnId) throw new RuntimeError("outcome_unknown", "已创建 Codex 会话，但未收到首条任务轮次确认。");

      keepRunning = true;
      server.bindTurn(project.id, threadId, activeTurnId, input.requestId);
      return {
        projectId: project.id,
        sessionId: threadId,
        title,
        cwd: resolvedCwd,
        state: "running",
        ...(isRuntimeId(activeTurnId) ? { receiptId: activeTurnId } : {}),
      };
    } finally {
      if (!keepRunning) server.abort();
    }
  }

  async interrupt(projectId: string, sessionId: string): Promise<{ interrupted: boolean }> {
    if (this.closed) throw new RuntimeError("offline", "Codex 本地连接器已停止。");
    const tracked = this.activeTurns.get(sessionId);
    if (tracked && tracked.projectId === projectId) {
      try {
        await tracked.rpc("turn/interrupt", { threadId: sessionId, turnId: tracked.turnId }, 5_000);
      } catch {
        // Fall through to terminal cleanup so a hung child is still stopped cleanly.
      } finally {
        tracked.emitTerminal("stopped");
      }
      return { interrupted: true };
    }
    const row = this.findRow(sessionId);
    if (!row || !isRuntimeId(row.id) || projectForCwd(row.cwd).id !== projectId) {
      throw new RuntimeError("not_found", "未找到对应的本地 Codex 会话。");
    }
    if (probeState(row) === "running") {
      throw new RuntimeError("unsupported", "该会话正在 Codex 桌面端运行，请在桌面端停止。");
    }
    return { interrupted: false };
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
    this.accountQuotaInFlight = undefined;
  }
}
