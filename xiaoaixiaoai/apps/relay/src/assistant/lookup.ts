/**
 * Finding what the person means by a name: an agent, a space, a computer.
 * Names arrive through speech recognition ("黑的演示端那边" is the space
 * "herdr演示端"), so both sides are folded the same way: program names
 * spelled by ear become their real names, filler words go, then case, spaces,
 * symbols and 中文数字 fold away (normName).
 */
import type { Agent } from "@xiaoaixiaoai/protocol";
import { normName } from "./speech.ts";

/** How speech recognition writes program names. Applied before anything else. */
const ALIASES: Array<[RegExp, string]> = [
  [/黑德|黑的|黑得|嘿德|赫德尔|赫尔德|赫德|黑刀|herder|header|hurdle|hertr|her\s*dr/gi, "herdr"],
  // Longer names first: "扣德巴迪" must not become codex, "克拉克" is not crush.
  [/扣得巴迪|扣德巴迪|扣的巴迪|寇德巴迪|扣巴迪|code\s*buddy/gi, "codebuddy"],
  [/克劳德|克劳得|克老德|可劳德|克拉克|克劳的|cloud\s*code|claude\s*code/gi, "claude"],
  [/扣德克斯|扣得克斯|寇德克斯|扣的克斯|扣得x|code\s*x|kodex|codecs/gi, "codex"],
  [/扣德儿|扣得儿|扣的儿|酷德|q\s*der/gi, "qoder"],
  [/欧姆皮|o\s*m\s*p\b/gi, "omp"],
  [/欧喷扣德|欧喷扣的|open\s*code/gi, "opencode"],
  [/杰米尼|吉米尼|哲米尼|杰米奈|双子座/gi, "gemini"],
  [/基米|吉米|kimi\s*code|key\s*me/gi, "kimi"],
  [/卓德|卓伊德|德罗伊德|朵伊德|droyd/gi, "droid"],
  [/通义千问|千问|q\s*wen|queen\s*code/gi, "qwen"],
  [/扣派勒特|扣派洛特|靠派洛特|科派洛特|co\s*pilot|副驾驶/gi, "copilot"],
  [/科瑟|柯瑟|克瑟|cursor\s*agent/gi, "cursor"],
  [/安普|阿姆普/gi, "amp"],
  [/克拉什|克鲁什|crash/gi, "crush"],
  [/古斯/gi, "goose"],
  [/艾德|爱德|a\s*der\b/gi, "aider"],
  [/爱弗洛|爱\s*flow|i\s+flow|心流/gi, "iflow"],
  [/克莱恩|克莱因|c\s+line/gi, "cline"],
  [/基洛|kilo\s*code/gi, "kilo"],
  [/赫尔墨斯|爱马仕/gi, "hermes"],
  [/优尼弗洛|尤尼弗洛/gi, "uniflo"],
];

/** Words around a name that say nothing about which one. Longest first. */
const FILLER = /那边的|这边的|那边|这边|那个|这个|那里|这里|里面的|里面|上面的|上面|那位|那台|这台|那一个|空间里|空间|标签页|标签|终端|窗口|会话|agent|session|一下|的|里|上/gi;

/** A name folded for comparing: aliases, filler, then normName. */
export function foldName(s: string): string {
  let t = s;
  for (const [re, to] of ALIASES) t = t.replace(re, to);
  const stripped = normName(t.replace(FILLER, ""));
  // A name made only of filler ("那个") keeps what it had.
  return stripped || normName(t);
}

const HARNESS_WORDS: Record<string, string[]> = {
  "claude-code": ["claude", "claudecode"],
  claude: ["claude", "claudecode"],
  codex: ["codex"],
  omp: ["omp"],
  opencode: ["opencode"],
  gemini: ["gemini"],
  hermes: ["hermes"],
  pi: ["pi"],
  kilo: ["kilo"],
};

function bigrams(s: string): string[] {
  const c = Array.from(s);
  if (c.length < 2) return c;
  const out: string[] = [];
  for (let i = 0; i < c.length - 1; i++) out.push(c[i]! + c[i + 1]!);
  return out;
}

/** Dice coefficient over character pairs: 1 is the same, 0 shares nothing. */
function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = bigrams(a);
  const y = bigrams(b);
  const pool = new Map<string, number>();
  for (const g of y) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of x) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      hit++;
      pool.set(g, n - 1);
    }
  }
  return (2 * hit) / (x.length + y.length);
}

/**
 * How well the folded `needle` names something called `values` (0–100):
 * 100 one of them exactly; 90 the needle is made of them ("herdr演示端的克劳德"
 * = space + program); less when the needle is part of a longer name; the rest
 * by shared character pairs (misheard names).
 */
export function nameScore(needle: string, values: Array<string | undefined>): number {
  if (!needle) return 0;
  const vals = [...new Set(values.filter((v): v is string => !!v).map(foldName).filter((v) => v.length > 0))];
  let best = 0;
  const covered = new Array<boolean>(Array.from(needle).length).fill(false);
  const chars = Array.from(needle);
  for (const v of vals) {
    if (v === needle) return 100;
    const vc = Array.from(v);
    if (vc.length >= 2 && needle.includes(v)) {
      // Mark every place it occurs: "黑的演示端" covered by space and nothing else left over.
      const idx = needle.indexOf(v);
      const start = Array.from(needle.slice(0, idx)).length;
      for (let i = start; i < start + vc.length && i < covered.length; i++) covered[i] = true;
    }
    if (chars.length >= 2 && v.includes(needle)) best = Math.max(best, 50 + 40 * (chars.length / vc.length));
    best = Math.max(best, 60 * dice(needle, v));
  }
  const coverage = covered.filter(Boolean).length / chars.length;
  if (coverage >= 0.999) best = Math.max(best, 90);
  else if (coverage > 0) best = Math.max(best, 30 + 50 * coverage);
  return Math.round(best);
}

/** Everything a person may call an agent by. */
export function agentNames(a: Agent, handle: string | undefined, deviceName: string): Array<string | undefined> {
  const [space, ...tabParts] = (a.where ?? "").split(" / ");
  const tab = tabParts.join(" / ").trim();
  const folder = a.cwd?.split("/").filter(Boolean).pop();
  return [
    handle,
    a.name,
    a.title,
    a.preview ? a.preview.slice(0, 40) : undefined,
    space?.trim(),
    tab && !/^\d+$/.test(tab) ? tab : undefined,
    space && tab ? `${space} ${tab}` : undefined,
    folder,
    a.harness,
    ...(HARNESS_WORDS[a.harness] ?? []),
    deviceName,
  ];
}

export interface Scored<T> {
  item: T;
  score: number;
}

/** Items ranked by how well `ref` names them, best first; zero scores left out. */
export function rank<T>(ref: string, items: T[], names: (item: T) => Array<string | undefined>): Array<Scored<T>> {
  const needle = foldName(ref);
  return items
    .map((item) => ({ item, score: nameScore(needle, names(item)) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Below this nothing is taken as meant; the closest ones are offered instead. */
export const MATCH_MIN = 45;
/** Within this of the best, two are equally likely. */
const TIE = 6;

/**
 * The one item `ref` names, or why not: `none` (closest offered) or
 * `several` (all equally likely).
 */
export function pickOne<T>(ref: string, items: T[], names: (item: T) => Array<string | undefined>): { hit: T } | { none: Array<Scored<T>> } | { several: Array<Scored<T>> } {
  const ranked = rank(ref, items, names);
  const best = ranked[0];
  if (!best || best.score < MATCH_MIN) return { none: ranked.slice(0, 5) };
  const top = ranked.filter((s) => s.score >= best.score - TIE);
  if (top.length === 1) return { hit: best.item };
  return { several: top };
}
