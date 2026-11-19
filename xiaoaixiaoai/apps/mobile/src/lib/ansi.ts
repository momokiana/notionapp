/**
 * Tiny ANSI renderer model for terminal snapshots.
 * Handles SGR (16 / 256 / truecolour, bold, dim, italic, underline, inverse) and drops every
 * other escape (cursor moves, OSC titles/links, charset switches). Output is lines of styled runs,
 * with wide (CJK / fullwidth) characters split into their own runs so the renderer can give them
 * exactly two cells.
 */

export interface Sgr {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface Run extends Sgr {
  text: string;
  /** Every character in this run is double-width. */
  wide?: boolean;
}

export interface TermLine {
  runs: Run[];
  /** Width in cells. */
  cells: number;
}

/** Dark terminal palette (normal 0-7, bright 8-15); every colour is ≥4.5:1 on `TERM_BG`. */
export const TERM_BG = "#17131F";
export const TERM_FG = "#EDE6F3";
export const ANSI16 = [
  "#8A8198", "#FF7A8A", "#7FD9A8", "#F2CF79", "#8FB3FF", "#D9A2F5", "#7FD3DE", "#D9D2E2",
  "#A69DB4", "#FF9DAA", "#A3EBC2", "#FFE39E", "#B2CBFF", "#E8C1FA", "#A6E7EF", "#FFFFFF",
];

function hex(n: number) {
  return n.toString(16).padStart(2, "0");
}

export function color256(n: number): string {
  if (n < 16) return ANSI16[n]!;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `#${hex(v)}${hex(v)}${hex(v)}`;
  }
  const i = n - 16;
  const step = [0, 95, 135, 175, 215, 255];
  return `#${hex(step[Math.floor(i / 36) % 6]!)}${hex(step[Math.floor(i / 6) % 6]!)}${hex(step[i % 6]!)}`;
}

/** East Asian Wide / Fullwidth (and emoji presentation) code points take two cells. */
export function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function applySgr(st: Sgr, params: number[], raw: string[]): Sgr {
  const s = { ...st };
  if (params.length === 0) return {};
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    // Colon sub-params (38:2::r:g:b) arrive as one raw token; expand them.
    if ((p === 38 || p === 48 || p === 58) && raw[i]?.includes(":")) {
      const sub = raw[i]!.split(":").map((x) => Number(x) || 0);
      const c = sub[1] === 5 ? color256(sub[2] ?? 0) : sub[1] === 2 ? `#${hex(sub[sub.length - 3] ?? 0)}${hex(sub[sub.length - 2] ?? 0)}${hex(sub[sub.length - 1] ?? 0)}` : undefined;
      if (p === 38) s.fg = c;
      else if (p === 48) s.bg = c;
      continue;
    }
    if (p === 0) {
      for (const k of Object.keys(s) as Array<keyof Sgr>) delete s[k];
    } else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 7) s.inverse = true;
    else if (p === 22) {
      s.bold = false;
      s.dim = false;
    } else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 27) s.inverse = false;
    else if (p >= 30 && p <= 37) s.fg = ANSI16[p - 30];
    else if (p === 39) delete s.fg;
    else if (p >= 40 && p <= 47) s.bg = ANSI16[p - 40];
    else if (p === 49) delete s.bg;
    else if (p >= 90 && p <= 97) s.fg = ANSI16[p - 90 + 8];
    else if (p >= 100 && p <= 107) s.bg = ANSI16[p - 100 + 8];
    else if (p === 38 || p === 48 || p === 58) {
      let c: string | undefined;
      if (params[i + 1] === 5) {
        c = color256(params[i + 2] ?? 0);
        i += 2;
      } else if (params[i + 1] === 2) {
        c = `#${hex(params[i + 2] ?? 0)}${hex(params[i + 3] ?? 0)}${hex(params[i + 4] ?? 0)}`;
        i += 4;
      }
      if (p === 38) s.fg = c;
      else if (p === 48) s.bg = c;
    }
  }
  return s;
}

function sameStyle(a: Sgr, b: Sgr) {
  return a.fg === b.fg && a.bg === b.bg && !!a.bold === !!b.bold && !!a.dim === !!b.dim && !!a.italic === !!b.italic && !!a.underline === !!b.underline && !!a.inverse === !!b.inverse;
}

/** Parse a snapshot (with or without escapes) into styled lines; trailing blank lines are trimmed. */
export function parseAnsi(input: string): TermLine[] {
  const { lines } = parseLines(input, {});
  while (lines.length > 1 && lines[lines.length - 1]!.runs.every((r) => !r.text.trim() && !r.bg)) lines.pop();
  return lines;
}

/** One line, starting in style `start` (the previous line's `end`); `end` is the style it leaves on. */
export function parseAnsiLine(line: string, start: Sgr = {}): { line: TermLine; end: Sgr } {
  const r = parseLines(line, start);
  return { line: r.lines[0] ?? { runs: [], cells: 0 }, end: r.end };
}

/** A string naming a style; "" for the default one. */
export function sgrKey(s: Sgr): string {
  const flags = `${s.bold ? "b" : ""}${s.dim ? "d" : ""}${s.italic ? "i" : ""}${s.underline ? "u" : ""}${s.inverse ? "r" : ""}`;
  return s.fg || s.bg || flags ? `${s.fg ?? ""}/${s.bg ?? ""}/${flags}` : "";
}

function parseLines(input: string, start: Sgr): { lines: TermLine[]; end: Sgr } {
  const lines: TermLine[] = [];
  let runs: Run[] = [];
  let cells = 0;
  let st: Sgr = start;

  const push = (text: string, wide: boolean, n: number) => {
    const last = runs[runs.length - 1];
    if (last && !!last.wide === wide && sameStyle(last, st)) last.text += text;
    else runs.push({ ...st, text, wide: wide || undefined });
    cells += wide ? 2 * n : n;
  };
  const endLine = () => {
    // Trailing spaces without a background draw nothing.
    const last = runs[runs.length - 1];
    if (last && !last.bg && !last.inverse) {
      const trimmed = last.text.replace(/ +$/, "");
      cells -= last.text.length - trimmed.length;
      if (trimmed) last.text = trimmed;
      else runs.pop();
    }
    lines.push({ runs, cells });
    runs = [];
    cells = 0;
  };

  const s = input;
  let i = 0;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code >= 0x20 && code < 0x7f) {
      // Plain ASCII: one slice for the whole stretch.
      let j = i + 1;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c < 0x20 || c >= 0x7f) break;
        j++;
      }
      push(s.slice(i, j), false, j - i);
      i = j;
      continue;
    }
    const ch = s[i]!;
    if (ch === "\x1b") {
      const n = s[i + 1];
      if (n === "[") {
        // CSI: params then a final byte 0x40-0x7e.
        let j = i + 2;
        while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++;
        if (s[j] === "m") {
          const body = s.slice(i + 2, j);
          const raw = body.length ? body.split(";") : [];
          st = applySgr(st, raw.map((x) => Number(x.split(":")[0]) || 0), raw);
        }
        i = j + 1;
        continue;
      }
      if (n === "]" || n === "P" || n === "_" || n === "^") {
        // OSC / DCS / APC / PM: up to BEL or ST (ESC \).
        let j = i + 2;
        while (j < s.length && s[j] !== "\x07" && !(s[j] === "\x1b" && s[j + 1] === "\\")) j++;
        i = s[j] === "\x07" ? j + 1 : j + 2;
        continue;
      }
      // Charset designators take one more byte; everything else is ESC + one byte.
      i += n === "(" || n === ")" || n === "*" || n === "+" ? 3 : 2;
      continue;
    }
    if (ch === "\n") {
      endLine();
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\t") {
      const pad = 8 - (cells % 8);
      push(" ".repeat(pad), false, pad);
      i++;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const glyph = String.fromCodePoint(cp);
    i += glyph.length;
    if (cp < 0x20 || cp === 0x7f) continue; // other C0 controls
    if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) {
      // Combining marks / ZWJ / variation selectors: attach without taking a cell.
      const last = runs[runs.length - 1];
      if (last) last.text += glyph;
      continue;
    }
    push(glyph, isWide(cp), 1);
  }
  endLine();
  return { lines, end: st };
}

function rgb(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function lum(h: string) {
  const c = rgb(h).map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
export function contrast(a: string, b: string) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
const readable = new Map<string, string>();
/** Nudge `fg` toward white or black until it reaches 4.5:1 on `bg` (apps sometimes pick unreadable truecolour). */
export function ensureReadable(fg: string, bg: string): string {
  const k = fg + bg;
  const hit = readable.get(k);
  if (hit) return hit;
  let out = fg;
  if (contrast(fg, bg) < 4.5) {
    const target = lum(bg) < 0.2 ? [255, 255, 255] : [0, 0, 0];
    const src = rgb(fg);
    for (let t = 0.1; t <= 1.0001; t += 0.1) {
      const mix = src.map((v, i) => Math.round(v + (target[i]! - v) * t));
      out = `#${mix.map(hex).join("")}`;
      if (contrast(out, bg) >= 4.5) break;
    }
  }
  readable.set(k, out);
  return out;
}

/** Resolve a run's colours on the dark terminal background (inverse swaps them; text kept ≥4.5:1). */
export function runColors(r: Sgr): { fg: string; bg?: string } {
  let fg = r.fg ?? TERM_FG;
  let bg = r.bg;
  if (r.inverse) [fg, bg] = [bg ?? TERM_BG, fg];
  const fgN = /^#[0-9a-fA-F]{6}$/.test(fg) ? fg : TERM_FG;
  const bgN = bg && /^#[0-9a-fA-F]{6}$/.test(bg) ? bg : undefined;
  const base = bgN ?? TERM_BG;
  // Dim: fade toward the background, but never below the 4.5:1 floor.
  const shown = r.dim ? `#${rgb(fgN).map((v, i) => hex(Math.round(v + (rgb(base)[i]! - v) * 0.35))).join("")}` : fgN;
  return { fg: ensureReadable(shown, base), bg: bgN };
}
