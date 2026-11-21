import type { Agent, ModelQuota, QuotaWindow } from "@xiaoaixiaoai/protocol";

/** Last part of a path; Windows computers send `C:\...` paths. */
export function basename(path?: string | null): string {
  if (!path) return "";
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function shortPath(path?: string | null): string {
  if (!path) return "";
  return path.replace(/^\/(Users|home)\/[^/]+/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+/i, "~");
}

export function relTime(ts?: number | null, now = Date.now()): string {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "刚刚";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString();
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * When something fires, the way people say it: `rel` counts down ("25 分钟后"),
 * `abs` names the day and clock ("今天 18:30", "明天 09:30", "11月20日 周五 09:00").
 */
export function dueTime(dueAt: number, now: number): { rel: string; abs: string } {
  const d = new Date(dueAt);
  const n = new Date(now);
  const days = Math.round((startOfDay(dueAt) - startOfDay(now)) / 86_400_000);
  const day =
    days === 0
      ? "今天"
      : days === 1
        ? "明天"
        : days === 2
          ? "后天"
          : days === -1
            ? "昨天"
            : `${d.getFullYear() !== n.getFullYear() ? `${d.getFullYear()}年` : ""}${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
  const abs = `${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const left = dueAt - now;
  // Past due only until the relay's next reminder tick fires it.
  if (left <= 0) return { rel: "到点了", abs };
  if (left < 60_000) return { rel: "不到 1 分钟", abs };
  const mins = Math.ceil(left / 60_000);
  if (mins < 60) return { rel: `${mins} 分钟后`, abs };
  if (mins < 180) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return { rel: m ? `${h} 小时 ${m} 分钟后` : `${h} 小时后`, abs };
  }
  if (mins < 24 * 60) return { rel: `${Math.round(mins / 60)} 小时后`, abs };
  return { rel: `${Math.round(mins / (24 * 60))} 天后`, abs };
}

export function agentTitle(a: Agent): string {
  return a.title?.trim() || a.preview?.trim() || basename(a.cwd) || a.localId;
}

export function agentSubtitle(a: Agent): string {
  const bits = [a.where, basename(a.cwd), a.turn ? `第 ${a.turn} 轮` : null].filter(Boolean);
  return Array.from(new Set(bits)).join(" · ");
}

export function money(usd?: number): string | null {
  if (usd == null) return null;
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export function compactNum(n?: number): string | null {
  if (n == null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return "夜深啦";
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

/** herdr "space": first segment of `where` ("测试 / 1" -> "测试"; herdr TUI: workspace_id). */
export function agentSpace(a: Agent): string | null {
  const head = a.where?.split(" / ")[0]?.trim();
  return head || null;
}

/** The rest of `where` after the space (tab / pane), if any. */
export function agentTab(a: Agent): string | null {
  const rest = a.where?.split(" / ").slice(1).join(" / ").trim();
  return rest || null;
}

/** Stable small hash for picking colours. */
export function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type QuotaTone = "ok" | "warn" | "low" | "muted";

export function quotaChip(q?: ModelQuota | null): { text: string; tone: QuotaTone } | null {
  if (!q) return null;
  if (!q.available) return { text: "配额未公开", tone: "muted" };
  const w = q.primary ?? q.secondary;
  if (w) {
    const pct = Math.max(0, Math.min(100, Math.round(w.remainingPercent)));
    const prefix = w.label ? `${w.label}余` : "余";
    const tone: QuotaTone = pct <= 15 ? "low" : pct <= 40 ? "warn" : "ok";
    return { text: `${prefix} ${pct}%`, tone };
  }
  if (q.balance) return { text: `余额 ${q.balance}`, tone: "ok" };
  return null;
}

export function quotaWindowText(w: QuotaWindow, now = Date.now()): string {
  const pct = Math.max(0, Math.min(100, Math.round(w.remainingPercent)));
  const reset = w.resetsAt && w.resetsAt > now ? ` · ${dueTime(w.resetsAt, now).abs} 重置` : "";
  return `${w.label ? `${w.label}窗口 ` : ""}剩余 ${pct}%${reset}`;
}
