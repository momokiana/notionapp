/**
 * Shaping what the assistant says: length limits, filler filters, the
 * "line / notes" hand-over to the voice and the wake-up verdict. No model, no
 * state. Design: docs/design/assistant-persona-harness.md (4.2, 4.6, 4.7).
 */
import type { NoticeVerdict } from "@xiaoaixiaoai/protocol";
import { timeZone, zonedParts } from "./timezone.ts";

export const MAX_SAY = 90;
export const MAX_KEEP = 600;
export const MAX_WAKE_SAY = 85;
export const MAX_WAKE_DETAILS = 420;

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function clip(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length > n ? `${chars.slice(0, n).join("")}…` : s;
}

/** The app speaks without emoji; models sometimes add them anyway. */
export function noEmoji(s: string): string {
  return s.replace(/( ?)[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]+( ?)/gu, (_m, a: string, b: string) => (a && b ? " " : "")).trim();
}

export function stripMd(s: string): string {
  return s.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>|]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

const OPENER = /^(好的|好嘞|收到|没问题|明白了?|了解了?)[，,！!。]\s*/;
const CLOSERS = [/还有(什么|其他|别的)[^。？]{0,12}吗？?$/, /随时(叫|找|喊|告诉)我[^。]{0,6}。?$/, /希望[^。]{0,12}(帮助|有用)。?$/];
const SENTENCE_END = "。！？!?";

/**
 * Drops an opening acknowledgement word and a closing service sentence. The
 * list is short on purpose: anything that could hit real content stays out.
 */
export function filterTalk(text: string): string {
  const original = text.trim();
  let t = original.replace(OPENER, "");
  for (let i = 0; i < 2; i++) {
    const body = t.trimEnd();
    let cut = -1;
    // The last sentence starts after the previous sentence end or line break.
    for (let k = body.length - 2; k >= 0; k--) {
      if (SENTENCE_END.includes(body[k]!) || body[k] === "\n") {
        cut = k;
        break;
      }
    }
    const last = body.slice(cut + 1).trim();
    const hit = CLOSERS.map((r) => r.exec(last)).find((m) => m !== null);
    if (!last || !hit) break;
    if (cut >= 0) {
      t = body.slice(0, cut + 1).trimEnd();
      continue;
    }
    // A single sentence: only a service clause after a comma goes ("改好了，希望对你有帮助。").
    const before = last.slice(0, hit.index).trimEnd();
    if (before.length > 1 && /[，,]$/.test(before)) t = `${before.slice(0, -1)}。`;
    break;
  }
  return t.trim() || original;
}

/** One spoken line: no markdown marks, no emoji, no line breaks. */
export function speakable(s: string): string {
  return oneLine(noEmoji(stripMd(s).replace(/^\s*[-•·]\s+/gm, "")));
}

/** Cuts at the last sentence end within `max` characters; the rest is returned, not dropped. */
export function cutAtSentence(s: string, max: number): [string, string] {
  const chars = Array.from(s);
  if (chars.length <= max) return [s, ""];
  const head = chars.slice(0, max);
  let at = -1;
  for (let i = head.length - 1; i > 0; i--) {
    if (SENTENCE_END.includes(head[i]!) || head[i] === "；" || head[i] === ";") {
      at = i;
      break;
    }
  }
  if (at < 0) {
    for (let i = head.length - 1; i > 0; i--) {
      if (head[i] === "，" || head[i] === ",") {
        at = i;
        break;
      }
    }
  }
  if (at < 0) return [`${head.join("")}…`, chars.slice(max).join("").trim()];
  return [chars.slice(0, at + 1).join("").trim(), chars.slice(at + 1).join("").trim()];
}

function capBlock(s: string, max: number): string {
  const t = s
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .join("\n");
  return clip(noEmoji(t), max);
}

/** Splits at the first line that is exactly `---`. */
function atSeparator(raw: string): [string, string] {
  const lines = raw.replace(/\r/g, "").split("\n");
  const i = lines.findIndex((l) => l.trim() === "---");
  return i < 0 ? [raw, ""] : [lines.slice(0, i).join("\n"), lines.slice(i + 1).join("\n")];
}

/**
 * The backend's answer during a call: `say` is spoken as is, `keep` goes to the
 * voice silently so it can answer follow-ups without another round.
 */
export function splitScript(raw: string, maxSay = MAX_SAY, maxKeep = MAX_KEEP): { say: string; keep: string } {
  let [line, notes] = atSeparator(raw);
  if (!line.trim() && notes.trim()) {
    const rest = notes.split("\n").filter((l) => l.trim());
    line = rest.shift() ?? "";
    notes = rest.join("\n");
  }
  const [say, over] = cutAtSentence(filterTalk(speakable(line)), maxSay);
  const keep = capBlock([over, notes].filter((x) => x.trim()).join("\n"), maxKeep);
  return { say, keep };
}

export type WakeVerdict = NoticeVerdict | "skip";

const VERDICTS: Record<string, WakeVerdict> = { 成了: "ok", 要你定: "decide", 没成: "failed", 不用说: "skip" };

/** Splits at line-only `---`, or falls back to inline ` --- ` when a model collapses lines. */
function atWakeSeparator(raw: string): [string, string] {
  const lines = raw.replace(/\r/g, "").split("\n");
  const idx = lines.findIndex((l) => l.trim() === "---");
  if (idx >= 0) return [lines.slice(0, idx).join("\n"), lines.slice(idx + 1).join("\n")];
  const inline = raw.match(/\s+---+(?:\s+|$)/);
  if (!inline || inline.index === undefined) return [raw, ""];
  return [raw.slice(0, inline.index), raw.slice(inline.index + inline[0].length)];
}

/**
 * What the assistant reported after looking at a stopped agent:
 * verdict line, one sentence, `---`, details. Tolerates collapsed headers like
 * `结论 要你定 一句话 ... --- - ...` while mapping unknown first lines to `stopped`.
 */
export function parseWake(raw: string): { verdict: WakeVerdict; say: string; details: string } {
  const [top, below] = atWakeSeparator(noEmoji(raw));
  const lines = top
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length && /^【?结论】?[:：]?$/.test(lines[0]!)) lines.shift();

  let known: WakeVerdict | undefined;
  let sentenceLines = lines;
  if (lines.length) {
    const firstRaw = lines[0]!.replace(/^【?结论】?[:：\s]*/u, "");
    const m = /^【?(成了|要你定|没成|不用说)】?(?:$|[\s\p{P}\p{S}]+([\s\S]*)|((?:哥哥|哥|你|我|这|那|刚|它|喂|哼|哎|呀)[\s\S]*))$/u.exec(firstRaw);
    if (m) {
      known = VERDICTS[m[1]!];
      const tail = (m[2] ?? m[3] ?? "").replace(/^[：:。，,\s]+/, "").trim();
      sentenceLines = tail ? [tail, ...lines.slice(1)] : lines.slice(1);
    }
  }
  while (sentenceLines.length && /^【?(一句话|摘要)】?[:：]?$/.test(sentenceLines[0]!)) {
    sentenceLines.shift();
  }
  const sentence = sentenceLines
    .join(" ")
    .replace(/^(?:【?(一句话|摘要)】?[:：\s]*)+/u, "")
    .trim();
  const [say, over] = cutAtSentence(filterTalk(speakable(sentence)), MAX_WAKE_SAY);

  const belowLines = below
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^【?细节】?[:：]?$/.test(l));
  const detailLines = [over, ...belowLines]
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5);
  return { verdict: known ?? "stopped", say, details: clip(detailLines.join("\n"), MAX_WAKE_DETAILS) };
}

const DIGITS = "零一二三四五六七八九";

/** 0–99 the way it is said: 两 for a lone 2, 十二, 二十, 三十五. */
export function cnNumber(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v > 99) return String(v);
  if (v === 2) return "两";
  if (v < 10) return DIGITS[v]!;
  const tens = Math.floor(v / 10);
  const ones = v % 10;
  return `${tens === 1 ? "" : DIGITS[tens]}十${ones ? DIGITS[ones] : ""}`;
}

/** A rough duration for the ear: 六分钟, 一个半小时, 两天. */
export function spokenFor(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "不到一分钟";
  if (m < 60) return `${cnNumber(m)}分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 >= 30 ? `${cnNumber(h)}个半小时` : `${cnNumber(h)}个小时`;
  return `${cnNumber(Math.floor(h / 24))}天`;
}

const WEEKDAYS = "日一二三四五六";

/** 周五晚上八点二十, in the relay's time zone (POCKET_TIMEZONE) unless another is given. */
export function spokenTime(ts: number, zone = timeZone()): string {
  const { day, hour, minute } = zonedParts(ts, zone);
  const part = hour < 6 ? "凌晨" : hour < 9 ? "早上" : hour < 12 ? "上午" : hour === 12 ? "中午" : hour < 18 ? "下午" : "晚上";
  const h12 = hour % 12 || 12;
  const min = minute === 0 ? "" : minute === 30 ? "半" : minute < 10 ? `零${DIGITS[minute]}` : cnNumber(minute);
  return `周${WEEKDAYS[day]}${part}${cnNumber(h12)}点${min}`;
}

/** 周五 20:21, in the relay's time zone unless another is given. */
export function clockTime(ts: number, zone = timeZone()): string {
  const { day, hour, minute } = zonedParts(ts, zone);
  return `周${WEEKDAYS[day]} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const CN_DIGIT: Record<string, string> = { 零: "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };

/** Names as speech recognition may write them: case, spaces, symbols and 中文数字 folded away. */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[零一二两三四五六七八九]/g, (c) => CN_DIGIT[c]!)
    .replace(/[\s\p{P}\p{S}]/gu, "");
}
