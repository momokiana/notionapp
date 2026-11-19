/**
 * What the terminal view shows, kept between paints so each paint costs only
 * what changed: lines keep an id while they scroll (React keys), and each
 * distinct line is parsed once (its row object stays the same, so a memoized
 * row does not render again).
 */
import { applyRows, diffRows, type RowsChange, type TerminalRowsEvent } from "@xiaoaixiaoai/protocol";
import { parseAnsiLine, runColors, sgrKey, type Sgr } from "./ansi";

export interface ShownRun {
  text: string;
  fg: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Every character is double-width. */
  wide?: boolean;
}

export interface ShownRow {
  runs: ShownRun[];
  /** Width in cells. */
  cells: number;
  /** Nothing visible: no text and no background. */
  blank: boolean;
}

export interface ScreenView {
  rows: { id: number; row: ShownRow }[];
  /** Widest row, in cells. */
  widest: number;
  cols?: number;
  height?: number;
}

interface Parsed {
  row: ShownRow;
  end: Sgr;
  endKey: string;
}

function parse(line: string, start: Sgr): Parsed {
  const { line: l, end } = parseAnsiLine(line, start);
  const runs = l.runs.map((r): ShownRun => {
    const c = runColors(r);
    return { text: r.text, fg: c.fg, bg: c.bg, bold: r.bold || undefined, italic: r.italic || undefined, underline: r.underline || undefined, wide: r.wide };
  });
  return { row: { runs, cells: l.cells, blank: l.runs.every((r) => !r.text.trim() && !r.bg) }, end, endKey: sgrKey(end) };
}

/** Distinct lines kept parsed: several screens' worth (history is at most 600 lines). */
const CACHE_LINES = 3000;

/** Parsed lines by start style and text. Two generations, so lines still on screen survive a turnover. */
class LineCache {
  private cur = new Map<string, Parsed>();
  private old = new Map<string, Parsed>();

  get(line: string, start: Sgr, startKey: string): Parsed {
    const key = startKey ? `${startKey}\u0000${line}` : line;
    let hit = this.cur.get(key);
    if (hit) return hit;
    hit = this.old.get(key) ?? parse(line, start);
    this.cur.set(key, hit);
    if (this.cur.size > CACHE_LINES) {
      this.old = this.cur;
      this.cur = new Map();
    }
    return hit;
  }
}

const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]/g;

export class TermScreen {
  private lines: string[] = [];
  private ids: number[] = [];
  private nextId = 1;
  /** The rows stream's own lines (its events apply to these), null until its first event. */
  private stream: string[] | null = null;
  private seq = 0;
  /** `lines` are the stream's lines, so its next change applies to them directly. */
  private fromStream = false;
  private cache = new LineCache();
  cols?: number;
  height?: number;

  /** A `terminal_rows` event. False when one was missed: subscribe again for a whole screen. */
  rows(e: TerminalRowsEvent): boolean {
    const whole = Array.isArray(e.lines);
    if (!whole && (this.stream === null || e.seq !== this.seq + 1)) return false;
    this.seq = e.seq;
    this.stream = applyRows(this.stream ?? [], e);
    this.change(this.fromStream && !whole ? e : diffRows(this.lines, this.stream));
    this.fromStream = true;
    this.size(e.cols, e.rows);
    return true;
  }

  /** A whole screen: an older host's `terminal` event, or a `terminal.read` result. */
  screen(s: { ansi?: string; text?: string; cols?: number; rows?: number }): void {
    this.restart();
    this.change(diffRows(this.lines, (s.ansi ?? s.text ?? "").split("\n")));
    this.size(s.cols, s.rows);
  }

  /** A new subscription: what it sends starts from a whole screen. */
  restart(): void {
    this.stream = null;
    this.seq = 0;
    this.fromStream = false;
  }

  private size(cols?: number, rows?: number): void {
    if (cols) this.cols = cols;
    if (rows) this.height = rows;
  }

  /** Applies a change in its shift + set form; moved lines keep their ids. */
  private change(d: RowsChange): void {
    const shift = Math.max(0, d.shift ?? 0);
    this.lines = applyRows(this.lines, d);
    const ids = this.ids.slice(shift);
    while (ids.length < this.lines.length) ids.push(this.nextId++);
    ids.length = this.lines.length;
    this.ids = ids;
  }

  /** Rows to draw; trailing blank lines are left out, as before. */
  view(): ScreenView {
    const rows: ScreenView["rows"] = [];
    let start: Sgr = {};
    let startKey = "";
    let widest = 0;
    for (let i = 0; i < this.lines.length; i++) {
      const p = this.cache.get(this.lines[i]!, start, startKey);
      rows.push({ id: this.ids[i]!, row: p.row });
      if (p.row.cells > widest) widest = p.row.cells;
      start = p.end;
      startKey = p.endKey;
    }
    while (rows.length && rows[rows.length - 1]!.row.blank) rows.pop();
    return { rows, widest, cols: this.cols, height: this.height };
  }

  /** The screen as plain text, for copying. */
  plain(): string {
    return this.lines
      .map((l) => l.replace(ESCAPES, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\s+$/, ""))
      .join("\n")
      .replace(/\s+$/, "");
  }
}
