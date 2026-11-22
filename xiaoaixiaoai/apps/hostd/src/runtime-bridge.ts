import type {
  Agent,
  AgentStatus,
  ConvEvent,
  RuntimeQuestionAnswerItem,
  RuntimeQuestionItem,
  RuntimeSessionDetail,
  SessionHit,
} from "@xiaoaixiaoai/protocol";
import { encodeRuntimeSessionKey, type UnifiedRuntimeEntry } from "./runtime-sessions.ts";

export interface RuntimeAgentState {
  status: AgentStatus;
  since: number;
  turn: number;
  seenTurn: number;
  subagentsWorking?: number;
}

/** Tracks monotonic stringified numeric `pos` values and stable timestamps for runtime session messages. */
export class RuntimeEventSeqTracker {
  private readonly seqBySession = new Map<string, { nextPos: number; byId: Map<string, { pos: string; ts: number }> }>();

  toConvEvents(sessionKey: string, detail: RuntimeSessionDetail, fallbackTs = Date.now()): ConvEvent[] {
    let seq = this.seqBySession.get(sessionKey);
    if (!seq) {
      seq = { nextPos: 0, byId: new Map() };
      this.seqBySession.set(sessionKey, seq);
    }
    const baseTs = detail.session.updatedAt ?? fallbackTs;
    const events: ConvEvent[] = [];
    for (let i = 0; i < detail.messages.length; i++) {
      const msg = detail.messages[i]!;
      const assign = (keyId: string): { pos: string; ts: number } => {
        const hit = seq!.byId.get(keyId);
        if (hit) return hit;
        const entry = {
          pos: String(++seq!.nextPos),
          ts: msg.ts ?? Math.max(1, baseTs - (detail.messages.length - i) * 1000),
        };
        seq!.byId.set(keyId, entry);
        if (seq!.byId.size > 4000) seq!.byId.delete(seq!.byId.keys().next().value!);
        return entry;
      };
      if (msg.role === "user") {
        const meta = assign(msg.id);
        events.push({ id: msg.id, session: sessionKey, ts: meta.ts, pos: meta.pos, kind: "user_message", text: msg.text });
      } else if (msg.role === "assistant") {
        const meta = assign(msg.id);
        events.push({ id: msg.id, session: sessionKey, ts: meta.ts, pos: meta.pos, kind: "assistant_message", text: msg.text });
      } else if (msg.role === "tool") {
        const callMeta = assign(`${msg.id}:call`);
        const resMeta = assign(`${msg.id}:res`);
        const toolName = msg.toolName ?? "tool";
        const defaultToolLabel = `${toolName}（调用）`;
        const firstLine = (msg.text ?? "").split("\n")[0]?.trim() ?? "";
        const detailSummary = firstLine && firstLine !== defaultToolLabel
          ? firstLine.replace(new RegExp(`^${toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[：:]\\s*`), "").trim()
          : "";
        events.push({
          id: `${msg.id}:call`,
          session: sessionKey,
          ts: callMeta.ts,
          pos: callMeta.pos,
          kind: "tool_call",
          call_id: msg.id,
          name: toolName,
          input: detailSummary ? { summary: detailSummary } : {},
        });
        events.push({
          id: `${msg.id}:res`,
          session: sessionKey,
          ts: resMeta.ts,
          pos: resMeta.pos,
          kind: "tool_result",
          call_id: msg.id,
          name: toolName,
          output: msg.text,
          is_error: msg.isError === true,
        });
      } else {
        const meta = assign(msg.id);
        events.push({ id: msg.id, session: sessionKey, ts: meta.ts, pos: meta.pos, kind: "system", text: msg.text });
      }
    }
    return events;
  }

  delete(sessionKey: string): void {
    this.seqBySession.delete(sessionKey);
  }

  clear(): void {
    this.seqBySession.clear();
  }
}

/** Derive unified `Agent` status + turn counters from a runtime session's state transitions. */
export function nextRuntimeState(
  prev: RuntimeAgentState | undefined,
  state: UnifiedRuntimeEntry["session"]["state"],
  now: number,
  updatedAt?: number,
  subagentsWorking = 0,
): RuntimeAgentState {
  const mapped: AgentStatus = state === "attention" ? "blocked" : state === "running" ? "working" : "idle";
  const hasWorkingSubs = subagentsWorking > 0;
  if (!prev) {
    return {
      status: mapped,
      since: updatedAt ?? now,
      turn: mapped === "working" || hasWorkingSubs ? 1 : 0,
      seenTurn: 0,
      subagentsWorking,
    };
  }
  let turn = prev.turn;
  const seenTurn = prev.seenTurn;
  let status: AgentStatus = mapped;
  const wasBusy = prev.status === "working" || (prev.subagentsWorking ?? 0) > 0;
  const nowBusy = mapped === "working" || hasWorkingSubs;
  if (nowBusy && !wasBusy) {
    turn++;
  } else if (mapped === "idle" && (wasBusy || prev.status === "done")) {
    if (wasBusy && turn === 0) turn = 1;
    status = seenTurn >= turn ? "idle" : "done";
  }
  const prevEff: AgentStatus = prev.status === "blocked" ? "blocked" : (prev.subagentsWorking ?? 0) > 0 ? "working" : prev.status;
  const nextEff: AgentStatus = status === "blocked" ? "blocked" : hasWorkingSubs ? "working" : status;
  return {
    status,
    since: nextEff === prevEff ? prev.since : now,
    turn,
    seenTurn,
    subagentsWorking,
  };
}

/** Format recent messages and pending questions as plain text for `terminal.read` fallback callers. */
export function formatRuntimeTerminalText(agent: Agent, detail: RuntimeSessionDetail): string {
  const header = `[${agent.harness.toUpperCase()}] ${detail.project.title} · ${detail.session.title}`;
  const lines: string[] = [header, ""];
  for (const m of detail.messages.slice(-20)) {
    const tag = m.role === "user" ? "[用户]" : m.role === "assistant" ? "[回复]" : m.role === "tool" ? `[工具${m.toolName ? `:${m.toolName}` : ""}]` : "[系统]";
    lines.push(`${tag} ${m.text}`);
  }
  if (!detail.messages.length) lines.push("（暂无历史消息）");
  if (detail.pendingQuestions.length) {
    lines.push("", "[待回答问题]");
    for (const pq of detail.pendingQuestions) {
      for (const q of pq.questions) {
        lines.push(`- ${q.question}${q.multiSelect ? "（可多选）" : ""}`);
        if (q.options?.length) {
          q.options.forEach((opt, i) => {
            lines.push(`  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`);
          });
        }
      }
    }
  }
  if (detail.session.canSend === false) {
    lines.push("", `[只读] ${detail.readOnlyReason ?? "当前会话仅支持查看消息记录。"}`);
  }
  return lines.join("\n").trim();
}

/** Match a single-question reply text against structured options or fall back to a custom response. */
export function matchQuestionAnswer(question: RuntimeQuestionItem, rawText: string): RuntimeQuestionAnswerItem {
  const trimmed = rawText.trim();
  const options = question.options ?? [];
  if (options.length) {
    if (/^[1-9]\d*$/.test(trimmed)) {
      const idx = Number(trimmed) - 1;
      if (idx >= 0 && idx < options.length) {
        return { id: question.id, selected: [options[idx]!.label] };
      }
    }
    const lower = trimmed.toLowerCase();
    const hit = options.find((opt) => opt.label.trim().toLowerCase() === lower);
    if (hit) {
      return { id: question.id, selected: [hit.label] };
    }
  }
  return { id: question.id, selected: [], custom: trimmed };
}

const RUNTIME_SEARCH_ALIASES: Array<[RegExp, string]> = [
  [/反重力|安提格拉维蒂|anti\s*gravity/gi, "antigravity"],
  [/扣德克斯|扣得克斯|寇德克斯|code\s*x/gi, "codex"],
  [/深度求索|deep\s*seek\s*harness|deep\s*seek/gi, "dsh"],
];

export function normalizeRuntimeSearchQuery(raw: string): string {
  let out = raw;
  for (const [re, to] of RUNTIME_SEARCH_ALIASES) out = out.replace(re, to);
  return out.normalize("NFKC").toLowerCase().trim();
}

export interface ParsedRuntimeQuery {
  harness?: string;
  workingOnly: boolean;
  folder?: string;
  terms: string[];
}

export function parseRuntimeSearchQuery(raw: string | undefined): ParsedRuntimeQuery {
  if (!raw?.trim()) return { workingOnly: false, terms: [] };
  const normalized = normalizeRuntimeSearchQuery(raw);
  let harness: string | undefined;
  let workingOnly = false;
  let folder: string | undefined;
  const terms: string[] = [];
  for (const token of normalized.split(/\s+/).filter(Boolean)) {
    if (token.startsWith("h:") && token.length > 2) harness = token.slice(2);
    else if (token === "s:work") workingOnly = true;
    else if (token.startsWith("in:") && token.length > 3) folder = token.slice(3);
    else if (!token.startsWith("since:")) terms.push(token);
  }
  return { harness, workingOnly, folder, terms };
}

export function entryMatchesFilter(entry: UnifiedRuntimeEntry, query: ParsedRuntimeQuery): boolean {
  if (query.harness && entry.runtime !== query.harness) return false;
  if (query.workingOnly && entry.session.state !== "running" && entry.session.state !== "attention") return false;
  const projectLower = entry.projectTitle.normalize("NFKC").toLowerCase();
  if (query.folder && !projectLower.includes(query.folder)) return false;
  if (!query.terms.length) return true;
  const hay = `${entry.runtime} ${projectLower} ${entry.session.title.normalize("NFKC").toLowerCase()} ${entry.session.id.toLowerCase()}`;
  return query.terms.every((t) => hay.includes(t));
}

export function entrySearchPriority(entry: UnifiedRuntimeEntry, query: ParsedRuntimeQuery): number {
  if (query.harness && entry.runtime !== query.harness) return -1;
  if (query.workingOnly && entry.session.state !== "running" && entry.session.state !== "attention") return -1;
  const projectLower = entry.projectTitle.normalize("NFKC").toLowerCase();
  if (query.folder && !projectLower.includes(query.folder)) return -1;
  if (!query.terms.length) return 1;
  const hay = `${entry.runtime} ${projectLower} ${entry.session.title.normalize("NFKC").toLowerCase()} ${entry.session.id.toLowerCase()}`;
  let matched = 0;
  for (const t of query.terms) if (hay.includes(t)) matched++;
  // If user explicitly named another runtime word ("antigravity" / "codex" / "dsh"), skip other runtimes cleanly.
  const runtimeTokens = query.terms.filter((t) => t === "dsh" || t === "codex" || t === "antigravity");
  if (runtimeTokens.length && !runtimeTokens.includes(entry.runtime)) return 0;
  return matched + 1;
}

function clipSnippet(text: string, term: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const idx = term ? flat.toLowerCase().indexOf(term) : -1;
  if (idx < 0) return flat.slice(0, 140);
  const start = Math.max(0, idx - 35);
  const slice = flat.slice(start, start + 140);
  return `${start > 0 ? "…" : ""}${slice}${start + 140 < flat.length ? "…" : ""}`;
}

export function extractSearchHit(entry: UnifiedRuntimeEntry, detail: RuntimeSessionDetail | undefined, query: ParsedRuntimeQuery): SessionHit | null {
  if (query.harness && entry.runtime !== query.harness) return null;
  if (query.workingOnly && entry.session.state !== "running" && entry.session.state !== "attention") return null;
  const projectLower = entry.projectTitle.normalize("NFKC").toLowerCase();
  if (query.folder && !projectLower.includes(query.folder)) return null;

  const hits: SessionHit["hits"] = [];
  const terms = query.terms;
  const sessionKey = encodeRuntimeSessionKey(entry.runtime, entry.projectId, entry.session.id);
  const meta = `${entry.runtime} ${entry.projectTitle} ${entry.session.title}`.normalize("NFKC").toLowerCase();
  const bodyTerms = terms.filter((t) => !meta.includes(t));

  if (detail) {
    const contentTexts: string[] = [];
    for (let i = detail.messages.length - 1; i >= 0 && hits.length < 4; i--) {
      const m = detail.messages[i]!;
      const lower = m.text.normalize("NFKC").toLowerCase();
      contentTexts.push(lower);
      const matchTerms = bodyTerms.length ? bodyTerms : terms;
      const hitTerm = matchTerms.find((t) => lower.includes(t));
      if (hitTerm) {
        hits.push({
          event: m.id,
          kind: m.role === "user" ? "user_message" : m.role === "assistant" ? "assistant_message" : m.role,
          ts: m.ts,
          snippet: clipSnippet(m.text, hitTerm),
        });
      }
    }
    for (const pq of detail.pendingQuestions) {
      if (hits.length >= 4) break;
      for (const q of pq.questions) {
        const text = [q.question, ...(q.options ?? []).map((o) => o.label)].join(" / ");
        const lower = text.normalize("NFKC").toLowerCase();
        contentTexts.push(lower);
        const matchTerms = bodyTerms.length ? bodyTerms : terms;
        const hitTerm = matchTerms.find((t) => lower.includes(t));
        if (hitTerm) {
          hits.push({ event: pq.callId, kind: "question", snippet: clipSnippet(text, hitTerm) });
          break;
        }
      }
    }
    const allHay = `${meta} ${contentTexts.join(" ")}`;
    if (terms.some((t) => !allHay.includes(t))) return null;
  } else if (terms.some((t) => !meta.includes(t))) {
    return null;
  }

  if (!hits.length) {
    hits.push({
      event: entry.session.id,
      kind: "session",
      ts: entry.session.updatedAt,
      snippet: `${entry.projectTitle} · ${entry.session.title}`,
    });
  }
  return {
    session: sessionKey,
    harness: entry.runtime,
    title: entry.session.title,
    cwd: entry.projectTitle,
    updatedAt: entry.session.updatedAt ?? Date.now(),
    hits,
  };
}
