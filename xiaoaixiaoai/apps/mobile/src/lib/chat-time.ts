function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** True when a time separator should appear between consecutive chronological messages. */
export function shouldShowTimeDivider(prevTs: number | undefined, currTs: number): boolean {
  if (!currTs) return false;
  if (!prevTs) return true;
  if (dayKey(prevTs) !== dayKey(currTs)) return true;
  return Math.abs(currTs - prevTs) >= 30 * 60_000;
}

/** WeChat-style relative day header (今天 HH:MM / 昨天 HH:MM / M月D日 HH:MM). */
export function formatChatGapLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const today = new Date(now);
  const todayKey = dayKey(now);
  const yesterdayKey = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime());
  const k = dayKey(ts);
  if (k === todayKey) return `今天 ${clock}`;
  if (k === yesterdayKey) return `昨天 ${clock}`;
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
}
