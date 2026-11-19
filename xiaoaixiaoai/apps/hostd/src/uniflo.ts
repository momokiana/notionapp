import type { Agent, ConvEvent, SessionHit, SessionInfo, SubSession, UsageRow } from "@xiaoaixiaoai/protocol";
import { cleanTitle } from "./util.ts";

/** Subset of Uniflo schema v1 `Session` (crates/uniflo-schema/src/lib.rs). */
export interface UnifloSession {
  key: string;
  harness: string;
  title?: string;
  cwd?: string;
  model?: string;
  preview?: string;
  updated_at: number;
  status: "idle" | "work";
  pid?: number;
  parent?: string;
  parent_call?: string;
  started_at?: number;
  status_since?: number;
  usage?: { cost_usd?: number; last_context_tokens?: number; context_limit?: number; steps?: number };
}

const plain = (s: string | undefined, max: number): string | undefined =>
  s ? s.replace(/<\/?[\w-]+[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || undefined : undefined;

function toInfo(s: UnifloSession): SessionInfo {
  return {
    key: s.key,
    harness: s.harness,
    title: cleanTitle(s.title),
    cwd: s.cwd,
    model: s.model,
    preview: plain(s.preview, 200),
    status: s.status === "work" ? "working" : "idle",
    startedAt: s.started_at,
    updatedAt: s.updated_at,
    costUsd: s.usage?.cost_usd,
    steps: s.usage?.steps,
    parent: s.parent,
  };
}

function toUsage(r: Record<string, unknown>): UsageRow {
  const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : 0);
  return {
    key: String(r.key ?? ""),
    label: String(r.label ?? r.key ?? ""),
    sessions: n("sessions"),
    steps: n("steps"),
    prompts: n("prompts"),
    input: n("input"),
    output: n("output"),
    cacheRead: n("cache_read"),
    cacheWrite: n("cache_write"),
    costUsd: n("cost_usd"),
  };
}

/** Harness-injected blocks (skill routers, reminders, hooks) that are not part of the conversation. */
const INJECTED_TAG =
  /<(skill-recommendation|system-reminder|system|user-prompt-submit-hook|command-(?:name|message|args)|local-command-stdout|context|instructions)\b[^>]*>[\s\S]*?<\/\1>/g;

/** One readable line for an injected block, e.g. `推荐技能 docs`. */
export function summarizeInjected(text: string, subtype?: string): string {
  const skill = /<skill-recommendation\b[^>]*\bname="([^"]+)"/.exec(text);
  if (skill) return `推荐技能 ${skill[1]}`;
  if (/<system-reminder\b/.test(text)) return "系统提醒";
  const tag = /^\s*<([\w-]+)/.exec(text);
  if (tag) return tag[1]!;
  const sub = subtype?.split(".").pop();
  const line = text.trim().split("\n")[0] ?? "";
  return sub ? `${sub}${line ? ` · ${line.slice(0, 40)}` : ""}` : line.slice(0, 60) || "系统消息";
}

/**
 * Separates what the person wrote and the agent said from what the harness injected.
 * Injected content is kept (folded) so nothing is lost; usage ticks are dropped.
 */
export function cleanEvent<E extends ConvEvent & Record<string, unknown>>(e: E): E | null {
  if (e.kind === "usage") return null;
  if (e.kind === "system") {
    const text = typeof e.text === "string" ? e.text.trim() : "";
    if (!text) return null;
    return { ...e, text, summary: summarizeInjected(text, e.subtype as string | undefined) };
  }
  if (e.kind === "user_message" && typeof e.text === "string") {
    if (e.synthetic) return { ...e, kind: "system", subtype: "synthetic", summary: summarizeInjected(e.text, "自动插入") } as E;
    const blocks = e.text.match(INJECTED_TAG);
    if (!blocks) return e;
    const text = e.text.replace(INJECTED_TAG, "").replace(/\n{3,}/g, "\n\n").trim();
    const injected = blocks.join("\n\n");
    if (!text) return { ...e, kind: "system", text: injected, summary: summarizeInjected(injected) } as E;
    return { ...e, text, injected };
  }
  return e;
}

const SVG_TAGS = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "polygon", "polyline", "line", "title"]);

/**
 * A harness icon as the phone may draw it, or undefined: a small SVG made of
 * plain shapes only (no scripts, styles, links, images or event handlers).
 */
export function safeIconSvg(raw: string): string | undefined {
  const svg = raw.replace(/<\?xml[^>]*\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!svg.startsWith("<svg") || !svg.endsWith("</svg>") || svg.length > 65_536) return undefined;
  for (const m of svg.matchAll(/<\/?\s*([A-Za-z][\w:.-]*)/g)) if (!SVG_TAGS.has(m[1]!.toLowerCase())) return undefined;
  if (/<!|\son\w+\s*=|href|url\s*\(|javascript:|data:/i.test(svg)) return undefined;
  return svg;
}

/** herdr/hc program names that Uniflo calls differently; any other name is its own harness id. */
const HARNESS_ALIAS: Record<string, string> = { "claude-code": "claude" };

/** herdr/hc program name -> Uniflo harness id. */
export function harnessId(name: string | undefined): string | undefined {
  return name ? (HARNESS_ALIAS[name] ?? name) : undefined;
}

/**
 * Reads the local Uniflo daemon (read-only) to turn raw terminals into
 * readable conversations: title, model, cost and the event timeline.
 */
export class UnifloAdapter {
  sessions: UnifloSession[] = [];
  /** parent session key -> [all children, working children] from the recent list. */
  childCounts = new Map<string, [number, number]>();
  private base: string;
  private token: string | undefined;
  private timer: NodeJS.Timeout | null = null;
  private onChange: () => void = () => {};
  /** Sessions named by a running agent (see SessionHints) that the recent list doesn't hold. */
  private named = new Map<string, UnifloSession>();
  /** Named keys being fetched, or not found (key -> when to look again). */
  private namedWait = new Map<string, number>();

  constructor(base = process.env.UNIFLO_URL ?? "http://127.0.0.1:7311", token = process.env.UNIFLO_TOKEN) {
    this.base = base.replace(/\/+$/, "");
    this.token = token;
  }

  async available(): Promise<boolean> {
    try {
      const r = await this.get("/v1/health");
      return r?.ok === true;
    } catch {
      return false;
    }
  }

  start(onChange: () => void): void {
    this.onChange = onChange;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 8000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    try {
      // Live agents are recent; 300 newest sessions are plenty to match against.
      const list = (await this.get("/v1/sessions?limit=300")) as UnifloSession[];
      const before = this.sig();
      this.sessions = list.filter((s) => !s.parent);
      this.childCounts = new Map();
      for (const s of list) {
        if (!s.parent) continue;
        const c = this.childCounts.get(s.parent) ?? [0, 0];
        c[0]++;
        if (s.status === "work") c[1]++;
        this.childCounts.set(s.parent, c);
      }
      // Named sessions outside the recent list go stale too: read them again.
      let namedChanged = false;
      for (const [key, old] of [...this.named]) {
        if (this.sessions.some((s) => s.key === old.key)) {
          this.named.delete(key);
          continue;
        }
        try {
          // By its full key: the name may have been a short prefix.
          const s = (await this.get(`/v1/sessions/${encodeURIComponent(old.key)}`)) as UnifloSession;
          if (s.updated_at !== old.updated_at || s.title !== old.title) namedChanged = true;
          this.named.set(key, s);
        } catch {
          /* keep the last copy */
        }
      }
      if (this.sig() !== before || namedChanged) this.onChange();
    } catch {
      /* uniflo is optional */
    }
  }

  private sig(): string {
    const kids = [...this.childCounts].map(([k, [n, w]]) => `${k}=${n}/${w}`).join(",");
    return this.sessions.map((s) => `${s.key}:${s.updated_at}:${s.pid ?? ""}:${s.title ?? ""}`).join("|") + kids;
  }

  private async get(path: string): Promise<any> {
    const res = await fetch(this.base + path, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`uniflo ${path}: ${res.status}`);
    return res.json();
  }

  /** A session named by an agent: from the recent list, the named cache, or fetched now for next time. */
  private namedSession(key: string): UnifloSession | undefined {
    // `claude attach <id>` names a short prefix of the id.
    const short = key.length - key.indexOf(":") - 1 < 32;
    const hit = (x: UnifloSession) => x.key === key || (short && x.key.startsWith(key));
    const s = this.sessions.find(hit) ?? this.named.get(key);
    if (s) return s;
    const wait = this.namedWait.get(key);
    if (wait !== undefined && wait > Date.now()) return undefined;
    // Fetching (or not found): look again in a minute at the earliest.
    this.namedWait.set(key, Date.now() + 60_000);
    const lookup = async (): Promise<UnifloSession | undefined> => {
      try {
        return (await this.get(`/v1/sessions/${encodeURIComponent(key)}`)) as UnifloSession;
      } catch (e) {
        if (!short) throw e;
      }
      const q = new URLSearchParams({ q: key.slice(key.indexOf(":") + 1), limit: "10" });
      const found = ((await this.get(`/v1/sessions?${q}`)) as UnifloSession[]).filter(hit);
      return found.length === 1 ? found[0] : undefined;
    };
    void lookup()
      .then((found) => {
        if (!found || !hit(found)) return;
        this.named.set(key, found);
        this.namedWait.delete(key);
        this.onChange();
      })
      .catch(() => {});
    return undefined;
  }

  /**
   * Attaches the matching Uniflo session to each agent.
   * 0. The session the process names itself (`hints`: its registry file or
   *    `--resume <id>`), even when it is too old for the recent list.
   * 1. Same process id (exact).
   * 2. Otherwise same harness + cwd, but only when exactly one live agent and
   *    one candidate session share that pair — never guess between several.
   * 3. Otherwise same harness + cwd + title (the terminal title a harness sets is
   *    its session title), again only when one agent and one session share it.
   */
  enrich(agents: Agent[], pids: Map<string, number | undefined>, hints: Map<string, string> = new Map()): Agent[] {
    if (!this.sessions.length) return agents;
    const byPid = new Map<number, UnifloSession>();
    for (const s of this.sessions) if (s.pid) byPid.set(s.pid, s);
    const used = new Set<string>();
    const matched = new Map<string, UnifloSession>();

    const wanted = new Set(hints.values());
    for (const k of this.named.keys()) if (!wanted.has(k)) this.named.delete(k);
    for (const a of agents) {
      const key = hints.get(a.key);
      const s = key ? this.namedSession(key) : undefined;
      if (s && !used.has(s.key)) {
        matched.set(a.key, s);
        used.add(s.key);
      }
    }

    for (const a of agents) {
      if (matched.has(a.key)) continue;
      const pid = pids.get(a.key);
      const s = pid ? byPid.get(pid) : undefined;
      if (s) {
        matched.set(a.key, s);
        used.add(s.key);
      }
    }

    const groups = new Map<string, Agent[]>();
    for (const a of agents) {
      if (a.isShell || matched.has(a.key) || !a.cwd) continue;
      const h = harnessId(a.harness);
      if (!h) continue;
      const k = `${h}\u0000${a.cwd}`;
      groups.set(k, [...(groups.get(k) ?? []), a]);
    }
    const weekAgo = Date.now() - 7 * 86400_000;
    for (const [k, group] of groups) {
      if (group.length !== 1) continue;
      const [h, cwd] = k.split("\u0000");
      const cands = this.sessions.filter(
        (s) => s.harness === h && s.cwd === cwd && !used.has(s.key) && s.updated_at > weekAgo,
      );
      if (cands.length !== 1) continue;
      matched.set(group[0]!.key, cands[0]!);
      used.add(cands[0]!.key);
    }

    const sameTitle = (a?: string, b?: string) => !!a && !!b && a.length >= 6 && b.length >= 6 && (a === b || a.startsWith(b) || b.startsWith(a));
    const left = agents.filter((a) => !a.isShell && !matched.has(a.key) && a.cwd && a.title && harnessId(a.harness));
    for (const a of left) {
      const h = harnessId(a.harness);
      if (left.some((b) => b !== a && harnessId(b.harness) === h && b.cwd === a.cwd && sameTitle(b.title, a.title))) continue;
      const cands = this.sessions.filter(
        (s) => s.harness === h && s.cwd === a.cwd && !used.has(s.key) && s.updated_at > weekAgo && sameTitle(cleanTitle(s.title), a.title),
      );
      if (cands.length !== 1) continue;
      matched.set(a.key, cands[0]!);
      used.add(cands[0]!.key);
    }

    return agents.map((a) => {
      const s = matched.get(a.key);
      if (!s) return a;
      const kids = this.childCounts.get(s.key);
      // Status stays exactly what herdr shows (the phone must match the desktop
      // app); the transcript only adds title, preview, model and cost.
      return {
        ...a,
        statusSince: a.statusSince ?? s.status_since,
        sessionKey: s.key,
        // A name given in herdr wins over the session title.
        title: a.name ? a.title : (cleanTitle(s.title) ?? a.title),
        model: s.model,
        preview: s.preview ? s.preview.slice(0, 200) : undefined,
        costUsd: s.usage?.cost_usd,
        contextTokens: s.usage?.last_context_tokens,
        contextLimit: s.usage?.context_limit,
        subagents: kids?.[0],
        subagentsWorking: kids?.[1],
        updatedAt: Math.max(a.updatedAt, s.updated_at),
      };
    });
  }

  /** Harness id -> safe icon SVG, or null when Uniflo has none (it doesn't change while it runs). */
  private iconCache = new Map<string, string | null>();

  /** Icons for these harness ids, from Uniflo (`/v1/harnesses/<id>/icon.svg`); unknown ids are left out. */
  async icons(ids: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    await Promise.all(
      [...new Set(ids)].filter((id) => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)).map(async (id) => {
        if (!this.iconCache.has(id)) {
          try {
            const res = await fetch(`${this.base}/v1/harnesses/${id}/icon.svg`, {
              headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
              signal: AbortSignal.timeout(5000),
            });
            // A 404 is final; a failed request is asked again next time.
            if (res.ok) this.iconCache.set(id, safeIconSvg(await res.text()) ?? null);
            else if (res.status === 404) this.iconCache.set(id, null);
          } catch {
            /* uniflo down: nothing now */
          }
        }
        const svg = this.iconCache.get(id);
        if (svg) out[id] = svg;
      }),
    );
    return out;
  }

  /** Recorded sessions, newest first; subagent sessions only when the filter asks for them (`parent:`). */
  async list(q: string | undefined, limit: number): Promise<SessionInfo[]> {
    const query = new URLSearchParams({ limit: String(Math.min(limit * 4, 200)) });
    if (q?.trim()) query.set("q", q.trim());
    const list = (await this.get(`/v1/sessions?${query}`)) as UnifloSession[];
    const wantKids = /(^|\s)parent:/.test(q ?? "");
    return list
      .filter((s) => wantKids || !s.parent)
      .slice(0, limit)
      .map(toInfo);
  }

  async info(key: string): Promise<SessionInfo> {
    return toInfo((await this.get(`/v1/sessions/${encodeURIComponent(key)}`)) as UnifloSession);
  }

  /** Full-text search over every transcript; snippets come without highlight marks. */
  async search(q: string, limit: number): Promise<{ total: number; results: SessionHit[] }> {
    const query = new URLSearchParams({ q, limit: String(limit) });
    const r = (await this.get(`/v1/search?${query}`)) as {
      total?: number;
      results?: Array<{ session: string; harness: string; title?: string; cwd?: string; updated_at: number; hits?: Array<{ event: string; kind: string; ts?: number; snippet?: string }> }>;
    };
    const results = (r.results ?? []).map((x) => ({
      session: x.session,
      harness: x.harness,
      title: cleanTitle(x.title),
      cwd: x.cwd,
      updatedAt: x.updated_at,
      hits: (x.hits ?? []).slice(0, 3).map((h) => ({ event: h.event, kind: h.kind, ts: h.ts, snippet: (h.snippet ?? "").replace(/[\u0002\u0003]/g, "").replace(/\s+/g, " ").trim().slice(0, 240) })),
    }));
    return { total: r.total ?? results.length, results };
  }

  /** Tokens and cost since `since`, biggest spender first. */
  async usage(since: string | undefined, groupBy: string): Promise<{ since?: number; rows: UsageRow[]; total: UsageRow }> {
    const query = new URLSearchParams({ group_by: groupBy });
    if (since?.trim()) query.set("since", since.trim());
    const r = (await this.get(`/v1/usage?${query}`)) as { since?: number; rows?: Array<Record<string, unknown>>; totals?: Record<string, unknown> };
    const rows = (r.rows ?? []).map(toUsage).sort((a, b) => b.costUsd - a.costUsd);
    return { since: r.since ?? undefined, rows: rows.slice(0, 15), total: toUsage(r.totals ?? {}) };
  }

  /** The command that opens a session again, as Uniflo knows it for that program. */
  async resume(key: string): Promise<{ supported: boolean; argv?: unknown; cwd?: string }> {
    return (await this.get(`/v1/sessions/${encodeURIComponent(key)}/resume`)) as { supported: boolean; argv?: unknown; cwd?: string };
  }

  /** Direct children of a session, newest first. */
  async children(parentKey: string): Promise<SubSession[]> {
    const q = new URLSearchParams({ q: `parent:${parentKey}`, limit: "100" });
    const list = (await this.get(`/v1/sessions?${q}`)) as UnifloSession[];
    return list.map((s) => ({
      key: s.key,
      parent: s.parent ?? parentKey,
      parentCall: s.parent_call,
      harness: s.harness,
      title: cleanTitle(s.title),
      preview: s.preview ? s.preview.replace(/<\/?[\w-]+[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || undefined : undefined,
      model: s.model,
      status: s.status === "work" ? "working" : "idle",
      statusSince: s.status_since,
      startedAt: s.started_at,
      updatedAt: s.updated_at,
      costUsd: s.usage?.cost_usd,
      children: this.childCounts.get(s.key)?.[0] ?? 0,
    }));
  }

  /** True when `key` is `root` or a descendant of it (walks up at most 8 parents). */
  async descends(key: string, root: string): Promise<boolean> {
    let cur: string | undefined = key;
    for (let i = 0; cur && i < 9; i++) {
      if (cur === root) return true;
      const s = (await this.get(`/v1/sessions/${encodeURIComponent(cur)}`)) as UnifloSession;
      cur = s.parent;
    }
    return false;
  }

  async events(
    sessionKey: string,
    limit = 80,
    before?: string,
  ): Promise<{ events: ConvEvent[]; more: boolean; nextBefore: string | null }> {
    const q = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 300)), max_text: "6000" });
    if (before) q.set("before", before);
    const r = await this.get(`/v1/sessions/${encodeURIComponent(sessionKey)}/events?${q}`);
    const events = (r.events ?? []) as Array<ConvEvent & Record<string, unknown>>;
    return {
      events: events
        .map(cleanEvent)
        .filter((e): e is ConvEvent & Record<string, unknown> => e !== null)
        .map((e) => {
          const out = { ...e, pos: e.pos === undefined || e.pos === null ? undefined : String(e.pos) };
          // Tool output can be huge; the phone shows a preview.
          if (e.kind === "tool_result" && typeof e.output === "string" && e.output.length > 4000) {
            return { ...out, output: `${e.output.slice(0, 4000)}\n…`, truncated: true } as ConvEvent;
          }
          return out as ConvEvent;
        }),
      more: r.next_before !== null && r.next_before !== undefined,
      nextBefore: r.next_before === null || r.next_before === undefined ? null : String(r.next_before),
    };
  }
}
