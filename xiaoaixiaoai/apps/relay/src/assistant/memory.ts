import { randomUUID } from "node:crypto";
import {
  MEMORY_CATEGORIES,
  type AssistantMemoryItem,
  type AssistantPersonaConfig,
  type MemoryCategory,
} from "@xiaoaixiaoai/protocol";
import type { Store } from "../store.ts";

const VALID_CATEGORIES = new Set<MemoryCategory>(MEMORY_CATEGORIES.map((c) => c.id));
const MAX_MEMORIES = 500;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/gu;

function cleanContent(raw: unknown, max = 400): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw.replace(/\r\n?/g, "\n").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(cleaned);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : cleaned;
}

function normalizeSlot(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return s || undefined;
}

export function normalizeCategory(raw: unknown, fallback: MemoryCategory = "note"): MemoryCategory {
  if (typeof raw === "string" && VALID_CATEGORIES.has(raw as MemoryCategory)) return raw as MemoryCategory;
  return fallback;
}

function categoryLabel(category: MemoryCategory): string {
  return MEMORY_CATEGORIES.find((c) => c.id === category)?.label ?? category;
}

/** Extracts normalized CJK 2-grams + single Han chars and ASCII words/digits for bilingual recall. */
function searchTokens(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_.-]{2,32}/g)) out.add(m[0]);
  const hanRuns = lower.match(/\p{Script=Han}+/gu) ?? [];
  for (const run of hanRuns) {
    const chars = Array.from(run);
    for (let i = 0; i < chars.length; i++) {
      if (chars.length <= 2) out.add(chars[i]!);
      if (i + 1 < chars.length) out.add(`${chars[i]!}${chars[i + 1]!}`);
    }
  }
  return out;
}

export interface RememberInput {
  category?: unknown;
  slotKey?: unknown;
  content: unknown;
  importance?: unknown;
  pinned?: unknown;
  expiresAt?: unknown;
  ttlDays?: unknown;
  source?: AssistantMemoryItem["source"];
}

export class MemoryService {
  private store: Store;
  private now: () => number;

  constructor(store: Store, now = () => Date.now()) {
    this.store = store;
    this.now = now;
  }

  private prune(): void {
    this.store.pruneExpiredMemories(this.now());
  }

  private all(): AssistantMemoryItem[] {
    this.prune();
    return this.store.listMemories();
  }

  list(opts: { category?: unknown; q?: string; limit?: number } = {}): { memories: AssistantMemoryItem[]; total: number } {
    let items = this.all();
    const total = items.length;
    if (typeof opts.category === "string" && VALID_CATEGORIES.has(opts.category as MemoryCategory)) {
      items = items.filter((m) => m.category === opts.category);
    }
    const q = typeof opts.q === "string" ? opts.q.trim() : "";
    if (q) {
      const qTokens = searchTokens(q);
      const plain = q.toLowerCase();
      items = items
        .map((m) => {
          const hay = `${m.content} ${m.slotKey ?? ""} ${categoryLabel(m.category)}`.toLowerCase();
          let score = hay.includes(plain) ? 10 : 0;
          if (qTokens.size) {
            const mTokens = searchTokens(hay);
            for (const tok of qTokens) if (mTokens.has(tok)) score += 2;
          }
          return { item: m, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || Number(!!b.item.pinned) - Number(!!a.item.pinned) || b.item.importance - a.item.importance || b.item.updatedAt - a.item.updatedAt)
        .map((x) => x.item);
    }
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    return { memories: items.slice(0, limit), total };
  }

  remember(input: RememberInput): { item: AssistantMemoryItem; replaced: boolean } {
    const content = cleanContent(input.content, 400);
    if (!content) throw new Error("记忆内容不能为空");
    const category = normalizeCategory(input.category, "note");
    const slotKey = normalizeSlot(input.slotKey);
    const rawImp = Number(input.importance);
    const importance: 1 | 2 | 3 = rawImp >= 3 ? 3 : rawImp <= 1 ? 1 : 2;
    const pinned = input.pinned === true || importance === 3 ? true : input.pinned === false ? false : undefined;
    const t = this.now();
    let expiresAt: number | undefined;
    if (typeof input.expiresAt === "number" && Number.isFinite(input.expiresAt) && input.expiresAt > t) {
      expiresAt = Math.trunc(input.expiresAt);
    } else if (typeof input.ttlDays === "number" && Number.isFinite(input.ttlDays) && input.ttlDays > 0) {
      expiresAt = Math.trunc(t + Math.min(input.ttlDays, 3650) * 86_400_000);
    }
    const source: AssistantMemoryItem["source"] = input.source ?? "assistant";

    this.prune();

    // Slot conflict resolution: updating e.g. preference/coffee replaces the old fact instead of contradicting it.
    if (slotKey) {
      const existing = this.store.findMemoryBySlot(category, slotKey);
      if (existing) {
        const nextPinned = pinned !== undefined ? pinned : Boolean(existing.pinned);
        const nextExpires = expiresAt !== undefined ? expiresAt : undefined;
        const next: AssistantMemoryItem = {
          id: existing.id,
          category: existing.category,
          slotKey,
          content,
          importance: Math.max(importance, existing.importance) as 1 | 2 | 3,
          ...(nextPinned ? { pinned: true } : {}),
          ...(nextExpires !== undefined ? { expiresAt: nextExpires } : {}),
          source,
          createdAt: existing.createdAt,
          updatedAt: t,
        };
        this.store.putMemory(next);
        return { item: next, replaced: true };
      }
    }

    // Deduplicate identical or superseding strings inside the same category.
    const normalized = content.toLowerCase();
    const existingList = this.store.listMemories();
    const dup = existingList.find((m) => {
      if (m.category !== category || m.slotKey) return false;
      const mLower = m.content.toLowerCase();
      return (
        mLower === normalized ||
        (normalized.length >= 8 && mLower.includes(normalized)) ||
        (mLower.length >= 8 && normalized.includes(mLower))
      );
    });
    if (dup) {
      const nextPinned = pinned !== undefined ? pinned : Boolean(dup.pinned);
      const nextExpires = expiresAt !== undefined ? expiresAt : dup.expiresAt;
      const next: AssistantMemoryItem = {
        id: dup.id,
        category: dup.category,
        content: content.length >= dup.content.length ? content : dup.content,
        importance: Math.max(dup.importance, importance) as 1 | 2 | 3,
        ...(nextPinned ? { pinned: true } : {}),
        ...(nextExpires !== undefined ? { expiresAt: nextExpires } : {}),
        source,
        createdAt: dup.createdAt,
        updatedAt: t,
      };
      this.store.putMemory(next);
      return { item: next, replaced: true };
    }

    // Enforce bounded total capacity by evicting lowest-priority unpinned oldest entry.
    if (existingList.length >= MAX_MEMORIES) {
      const victim = [...existingList]
        .filter((m) => !m.pinned)
        .sort((a, b) => a.importance - b.importance || a.updatedAt - b.updatedAt)[0];
      if (victim) this.store.deleteMemory(victim.id);
    }

    const item: AssistantMemoryItem = {
      id: `mem_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      category,
      ...(slotKey ? { slotKey } : {}),
      content,
      importance,
      ...(pinned ? { pinned: true } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      source,
      createdAt: t,
      updatedAt: t,
    };
    this.store.putMemory(item);
    return { item, replaced: false };
  }

  update(
    id: string,
    patch: Partial<{
      category: unknown;
      slotKey: unknown;
      content: unknown;
      importance: unknown;
      pinned: unknown;
      expiresAt: unknown;
    }>,
  ): AssistantMemoryItem {
    const existing = this.store.getMemory(id);
    if (!existing) throw new Error("没有找到这条记忆");
    const category = Object.hasOwn(patch, "category") ? normalizeCategory(patch.category, existing.category) : existing.category;
    const slotKey = Object.hasOwn(patch, "slotKey") ? normalizeSlot(patch.slotKey) : existing.slotKey;
    const content = Object.hasOwn(patch, "content") ? cleanContent(patch.content, 400) : existing.content;
    if (!content) throw new Error("记忆内容不能为空");
    const rawImp = Object.hasOwn(patch, "importance") ? Number(patch.importance) : existing.importance;
    const importance: 1 | 2 | 3 = rawImp >= 3 ? 3 : rawImp <= 1 ? 1 : 2;
    const pinned = Object.hasOwn(patch, "pinned") ? patch.pinned === true : existing.pinned;
    let expiresAt = existing.expiresAt;
    if (Object.hasOwn(patch, "expiresAt")) {
      expiresAt = typeof patch.expiresAt === "number" && Number.isFinite(patch.expiresAt) ? Math.trunc(patch.expiresAt) : undefined;
    }
    if (slotKey && (slotKey !== existing.slotKey || category !== existing.category)) {
      const clash = this.store.findMemoryBySlot(category, slotKey);
      if (clash && clash.id !== existing.id) this.store.deleteMemory(clash.id);
    }
    const next: AssistantMemoryItem = {
      id: existing.id,
      category,
      ...(slotKey ? { slotKey } : {}),
      content,
      importance,
      ...(pinned ? { pinned: true } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      source: existing.source,
      createdAt: existing.createdAt,
      updatedAt: this.now(),
    };
    this.store.putMemory(next);
    return next;
  }

  forget(ref: { id?: string; slotKey?: string; query?: string }): { removed: number; items: AssistantMemoryItem[] } {
    if (ref.id) {
      const item = this.store.getMemory(ref.id);
      if (!item) return { removed: 0, items: [] };
      this.store.deleteMemory(item.id);
      return { removed: 1, items: [item] };
    }
    const items = this.all();
    const slot = normalizeSlot(ref.slotKey);
    if (slot) {
      const hits = items.filter((m) => m.slotKey === slot);
      for (const h of hits) this.store.deleteMemory(h.id);
      return { removed: hits.length, items: hits };
    }
    const q = typeof ref.query === "string" ? ref.query.trim() : "";
    if (!q) return { removed: 0, items: [] };
    const found = this.list({ q, limit: 3 }).memories;
    if (!found.length) return { removed: 0, items: [] };
    // Only auto-remove top match if explicitly matched cleanly; avoid wiping unrelated memories.
    const top = found[0]!;
    this.store.deleteMemory(top.id);
    return { removed: 1, items: [top] };
  }

  clear(): number {
    return this.store.clearMemories();
  }

  /**
   * Builds bounded memory context for prompts:
   * 1. Core / pinned facts always stay active regardless of thread clearing.
   * 2. Remaining memories are ranked by bilingual query overlap + recency + importance.
   */
  buildPromptContext(queryText: string, maxChars = 1600): string {
    const all = this.all();
    if (!all.length) return "";
    const t = this.now();
    const core = all.filter((m) => m.pinned || m.importance === 3).slice(0, 12);
    const coreIds = new Set(core.map((m) => m.id));
    const qTokens = searchTokens(queryText);
    const plainFragments = queryText
      .split(/[\n\r\t，。！？、；：,.!?;:]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length >= 2);

    const pool = all
      .filter((m) => !coreIds.has(m.id))
      .map((m) => {
        const textLower = `${m.content} ${m.slotKey ?? ""}`.toLowerCase();
        let score = 0;
        for (const frag of plainFragments) {
          if (textLower.includes(frag)) score += 10;
        }
        if (qTokens.size) {
          const mTokens = searchTokens(textLower);
          for (const tok of qTokens) if (mTokens.has(tok)) score += 3;
        }
        // Schedules stay top-of-mind even without direct keywords.
        if (m.category === "schedule") score += 2.5;
        const ageDays = Math.max(0, (t - m.updatedAt) / 86_400_000);
        const recency = Math.max(0, 3 - ageDays * 0.12);
        score += recency + m.importance * 1.1;
        return { item: m, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.item);

    const lines: string[] = [];
    let used = 0;
    const pushLine = (line: string) => {
      const len = Array.from(line).length;
      if (used + len > maxChars) return false;
      lines.push(line);
      used += len + 1;
      return true;
    };

    if (core.length) {
      pushLine("【核心档案与永驻记忆】");
      for (const m of core) {
        if (!pushLine(`- [${categoryLabel(m.category)}] ${m.content} (id=${m.id})`)) break;
      }
    }
    if (pool.length) {
      if (lines.length) lines.push("");
      pushLine("【近期与当前话题相关记忆】");
      for (const m of pool) {
        if (!pushLine(`- [${categoryLabel(m.category)}] ${m.content} (id=${m.id})`)) break;
      }
    }
    return lines.join("\n").trim();
  }

  exportMarkdown(profile: AssistantPersonaConfig): string {
    const items = this.all();
    const out: string[] = [
      `# ${profile.name} 的服务器人设与记忆库备份`,
      "",
      `- 对你的称呼：${profile.userCall || "（未设）"}`,
      `- 预设方案：${profile.presetId}`,
      `- 自动记录记忆：${profile.autoMemory ? "开启" : "关闭"}`,
      "",
      "## 人设设定",
      profile.personaText || "（未填写自定义人设）",
      "",
      `## 长期记忆库（共 ${items.length} 条）`,
    ];
    for (const cat of MEMORY_CATEGORIES) {
      const group = items.filter((m) => m.category === cat.id);
      if (!group.length) continue;
      out.push("", `### ${cat.label}`);
      for (const m of group) {
        const flags = [m.pinned ? "置顶" : "", m.slotKey ? `槽位=${m.slotKey}` : ""].filter(Boolean).join(" · ");
        out.push(`- ${m.content}${flags ? ` _(${flags})_` : ""}`);
      }
    }
    return out.join("\n");
  }
}
