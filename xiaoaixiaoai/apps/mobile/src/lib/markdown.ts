/**
 * CommonMark only treats `**` / `*` as emphasis when the delimiter is "flanking". Next to CJK
 * punctuation that fails, e.g. `疑问。**结果` or `说**「引号」**`: the stars stay literal.
 * We pair delimiters per line and, only where a pair would otherwise not parse, slip a hair
 * space (U+200A, whitespace to markdown-it, almost invisible) on the outer side of the marker.
 * Fenced code blocks and inline code spans are left untouched.
 */
const HAIR = " ";
const PUNCT = /[\p{P}\p{S}]/u;
const SPACE = /\s/u;

function isPunct(ch: string | undefined) {
  return !!ch && PUNCT.test(ch);
}
function isSpace(ch: string | undefined) {
  return !ch || SPACE.test(ch);
}

function fixRuns(seg: string, marker: "**" | "*"): string {
  // Delimiter positions (exact run length = marker length).
  const spots: number[] = [];
  for (let i = 0; i < seg.length; i++) {
    if (seg[i] !== "*") continue;
    let j = i;
    while (seg[j] === "*") j++;
    if (j - i === marker.length) {
      const prev = seg[i - 1];
      const next = seg[j];
      // A delimiter with spaces on both sides (or "* " list bullets) is not emphasis.
      if (!(isSpace(prev) && isSpace(next))) spots.push(i);
    }
    i = j - 1;
  }
  if (spots.length < 2) return seg;
  const len = marker.length;
  let out = "";
  let last = 0;
  for (let k = 0; k + 1 < spots.length; k += 2) {
    const o = spots[k]!;
    const c = spots[k + 1]!;
    out += seg.slice(last, o);
    // Opener: needs (next not punct) or (prev is space/punct).
    const oPrev = seg[o - 1];
    const oNext = seg[o + len];
    out += isPunct(oNext) && !isSpace(oPrev) && !isPunct(oPrev) ? HAIR + marker : marker;
    out += seg.slice(o + len, c);
    // Closer: needs (prev not punct) or (next is space/punct).
    const cPrev = seg[c - 1];
    const cNext = seg[c + len];
    out += isPunct(cPrev) && !isSpace(cNext) && !isPunct(cNext) ? marker + HAIR : marker;
    last = c + len;
  }
  return out + seg.slice(last);
}

function fixLine(line: string): string {
  // Keep inline code spans (`...`) verbatim.
  const parts = line.split(/(`+[^`]*`+)/);
  return parts.map((part, i) => (i % 2 === 1 ? part : fixRuns(fixRuns(part, "**"), "*"))).join("");
}

export function fixCjkEmphasis(md: string): string {
  if (!md.includes("*")) return md;
  let fence: string | null = null;
  return md
    .split("\n")
    .map((line) => {
      const m = line.match(/^\s*(`{3,}|~{3,})/);
      if (m) {
        const tick = m[1]!;
        if (!fence) fence = tick;
        else if (tick.startsWith(fence[0]!) && tick.length >= fence.length) fence = null;
        return line;
      }
      if (fence) return line;
      return fixLine(line);
    })
    .join("\n");
}

/**
 * True when the text has a bullet or numbered list. A bubble that sizes itself to its
 * content measures each wrapped list line as one line on Android, so the text runs out
 * under the bubble; bubbles with lists get a set width instead.
 */
export function hasList(md: string): boolean {
  return /^ {0,3}(?:[-*+]|\d{1,3}[.)]) +\S/m.test(md);
}
