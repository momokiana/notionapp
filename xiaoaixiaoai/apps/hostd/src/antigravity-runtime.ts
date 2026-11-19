import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  DSH_DIRECTORY_PAGE_SIZE,
  DSH_DIRECTORY_SEARCH_LIMIT,
  RUNTIME_DETAIL_LIMIT,
  isRuntimeId,
  type DshDirectoryEntry,
  type DshDirectoryProject,
  type DshDirectoryReply,
  type DshDirectoryRequest,
  type RuntimePendingQuestion,
  type RuntimeProject,
  type RuntimeQuestionItem,
  type RuntimeSession,
  type RuntimeSessionDetail,
  type RuntimeSessionMessage,
  type RuntimeSessionReceipt,
  type RuntimeSessionSend,
  type RuntimeSessionState,
} from "@xiaoaixiaoai/protocol";
import { RuntimeError } from "./runtime-sessions.ts";

const SCAN_SESSION_LIMIT = 60;
const HEAD_BYTES = 128 * 1024;
const SUMMARY_TAIL_BYTES = 256 * 1024;
const DETAIL_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_TEXT = 6000;
const MAX_DETAIL_BYTES = 460 * 1024;
const RECENT_RUNNING_WINDOW_MS = 90_000;
const READ_ONLY_REASON = "Antigravity 桌面会话暂不支持外部注入消息，可在手机端实时查看对话消息与待选问题。";

export interface AntigravityRuntimeOptions {
  brainDir: string;
}

interface ParsedStep {
  type?: string;
  source?: string;
  status?: string;
  content?: string;
  created_at?: string;
  tool_calls?: Array<{ name?: unknown; args?: unknown }>;
}

interface BrainMeta {
  sessionId: string;
  transcriptPath: string;
  hasLock: boolean;
  mtimeMs: number;
  project: { id: string; title: string };
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
  const body = match ? match[1]! : content.replace(/<[^>]+>/g, " ");
  return cleanText(body, MAX_MESSAGE_TEXT);
}

function workspaceFromSystem(content: string): { id: string; title: string } | undefined {
  const block = /Active Workspaces:\s*([\s\S]*?)(?:Command Working Directory:|App Data Directory:|<\/user_information>)/i.exec(content);
  if (!block) return undefined;
  for (const line of block[1]!.split(/\r?\n/)) {
    const m = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const raw = m[1]!.trim().replace(/[\\/]+$/, "");
    if (!raw || /^none$/i.test(raw)) continue;
    const hash = createHash("sha256").update(raw.toLowerCase()).digest("hex").slice(0, 12);
    const leaf = basename(raw).replace(/[:/\\]/g, "").trim();
    return { id: `agp_${hash}`, title: cleanLabel(leaf, "Antigravity") };
  }
  return undefined;
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

  constructor(options: AntigravityRuntimeOptions) {
    if (!options || typeof options.brainDir !== "string" || !options.brainDir.trim()) {
      throw new RuntimeError("bad_request", "Antigravity 目录配置无效。");
    }
    this.brainDir = options.brainDir;
  }

  private scanBrains(): BrainMeta[] {
    if (!existsSync(this.brainDir)) return [];
    const candidates: Array<{ sessionId: string; transcriptPath: string; hasLock: boolean; mtimeMs: number }> = [];
    for (const ent of readdirSync(this.brainDir, { withFileTypes: true })) {
      if (!ent.isDirectory() || !isRuntimeId(ent.name)) continue;
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
        });
      } catch { /* skip unreadable directory */ }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: BrainMeta[] = [];
    for (const item of candidates.slice(0, SCAN_SESSION_LIMIT)) {
      try {
        const headSteps = readWindowLines(item.transcriptPath, 0, HEAD_BYTES, true).map(parseStep).filter((s): s is ParsedStep => s !== null);
        let project: { id: string; title: string } = { id: "agp_default", title: "Antigravity" };
        let title = "";
        for (const step of headSteps) {
          if (step.type === "SYSTEM_MESSAGE" && typeof step.content === "string") {
            project = workspaceFromSystem(step.content) ?? project;
          } else if (!title && step.type === "USER_INPUT") {
            title = extractUserRequest(step.content);
          }
        }
        const tailSteps = readWindowLines(item.transcriptPath, 0, SUMMARY_TAIL_BYTES, false).map(parseStep).filter((s): s is ParsedStep => s !== null);
        if (!title) {
          const fallbackUser = tailSteps.find((s) => s.type === "USER_INPUT");
          title = fallbackUser ? extractUserRequest(fallbackUser.content) : "";
        }
        const { state } = summarizeTail(tailSteps, item.hasLock, item.mtimeMs);
        out.push({
          ...item,
          project,
          title: cleanLabel(title, `Antigravity ${item.sessionId.slice(0, 8)}`),
          state,
        });
      } catch { /* ignore unreadable transcript */ }
    }
    return out;
  }

  private toSession(meta: BrainMeta): RuntimeSession {
    return {
      id: meta.sessionId,
      title: meta.title,
      state: meta.state,
      canSend: false,
      updatedAt: Math.trunc(meta.mtimeMs),
    };
  }

  async list(): Promise<RuntimeProject[]> {
    const metas = this.scanBrains();
    const grouped = new Map<string, RuntimeProject>();
    for (const meta of metas) {
      let project = grouped.get(meta.project.id);
      if (!project) {
        project = { runtime: "antigravity", id: meta.project.id, title: meta.project.title, sessions: [] };
        grouped.set(meta.project.id, project);
      }
      project.sessions.push(this.toSession(meta));
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
    const steps = readWindowLines(meta.transcriptPath, 0, DETAIL_TAIL_BYTES, false).map(parseStep).filter((s): s is ParsedStep => s !== null);
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
    const tailSummary = summarizeTail(steps, meta.hasLock, meta.mtimeMs);
    const session: RuntimeSession = { ...this.toSession(meta), state: tailSummary.state };
    const reply: RuntimeSessionDetail = {
      runtime: "antigravity",
      project: meta.project,
      session,
      messages: messages.slice(-boundedLimit),
      pendingQuestions: tailSummary.pendingQuestions,
      readOnlyReason: READ_ONLY_REASON,
    };
    while (reply.messages.length > 0 && Buffer.byteLength(JSON.stringify(reply), "utf8") > MAX_DETAIL_BYTES) {
      reply.messages.shift();
    }
    return reply;
  }

  async send(_input: RuntimeSessionSend): Promise<RuntimeSessionReceipt> {
    throw new RuntimeError("forbidden", READ_ONLY_REASON);
  }
}
