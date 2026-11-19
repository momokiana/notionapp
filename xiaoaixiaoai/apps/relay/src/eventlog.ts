/**
 * The relay's event log: one SQLite row per event (relay's own, plus what
 * phones and computers upload), and one readable journal line for each event
 * the relay itself records. Rows are redacted and clipped before they are
 * stored; tokens and keys never reach the table or the journal.
 */
import type { Device, LogEntry, LogLevel } from "@xiaoaixiaoai/protocol";
import type { EventQuery, EventRow, Store } from "./store.ts";

export interface EventInput {
  kind: string;
  msg: string;
  level?: LogLevel;
  data?: Record<string, unknown>;
  /** Device the event is from or about. */
  device?: string;
}

export interface EventLogOptions {
  /** One readable line per relay event (systemd journal). */
  journal?: (line: string) => void;
  deviceName?: (id: string) => string | undefined;
  retentionMs?: number;
  maxRows?: number;
  now?: () => number;
}

export const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const RETENTION_MS = 14 * 86_400_000;
const MAX_ROWS = 200_000;
const MSG_MAX = 500;
const DATA_MAX = 2000;
const VALUE_MAX = 300;
const BATCH_MAX = 200;
/** Lines one device may upload per window; the rest of a flood is dropped with one note. */
const CLIENT_BUDGET = 3000;
const CLIENT_WINDOW_MS = 10 * 60_000;
const PRUNE_EVERY = 500;

/** Removes anything shaped like a credential. */
export function redact(s: string): string {
  return s
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    .replace(/\bhp_[A-Za-z0-9_-]{8,}/g, "hp_***")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/([?&](?:token|key|api_key|apikey|secret|password)=)[^&\s"']+/gi, "$1***")
    .replace(/("?\b(?:token|apiKey|api_key|secret|password|authorization|adminToken)"?\s*[:=]\s*"?)[^"\s,}]{6,}/gi, "$1***");
}

export function clipText(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length > n ? `${chars.slice(0, n).join("")}…` : s;
}

/** Strings clipped, nesting flattened to JSON, the whole capped; null when empty. */
function packData(data: Record<string, unknown> | undefined): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (typeof v === "string") out[k] = clipText(v, VALUE_MAX);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else out[k] = clipText(JSON.stringify(v) ?? "", VALUE_MAX);
  }
  if (!Object.keys(out).length) return undefined;
  let json = redact(JSON.stringify(out));
  if (json.length > DATA_MAX) json = JSON.stringify({ clipped: json.slice(0, DATA_MAX) });
  return json;
}

/** `30s`, `15m`, `1h`, `2d`, or epoch ms. */
export function parseSince(v: string | null | undefined, now: number): number | undefined {
  if (!v) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(v.trim());
  if (m) return now - Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!.toLowerCase() as "s"]!;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/** Levels at or above `min`. */
export function levelsFrom(min: string | null | undefined): LogLevel[] | undefined {
  const i = LEVELS.indexOf((min ?? "") as LogLevel);
  return i > 0 ? LEVELS.slice(i) : undefined;
}

export class EventLog {
  private store: Store;
  private opts: EventLogOptions;
  private sincePrune = 0;
  private budgets = new Map<string, { n: number; since: number; noted: boolean }>();

  constructor(store: Store, opts: EventLogOptions = {}) {
    this.store = store;
    this.opts = opts;
    this.prune();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** A relay event: stored and written to the journal. */
  record(ev: EventInput): void {
    const level = LEVELS.includes(ev.level as LogLevel) ? ev.level! : "info";
    const msg = clipText(redact(ev.msg.replace(/\s+/g, " ").trim()), MSG_MAX);
    const data = packData(ev.data);
    this.opts.journal?.(this.line({ kind: ev.kind, level, msg, data, device: ev.device }));
    this.write([{ ts: this.now(), source: "relay", device: ev.device, kind: clipKind(ev.kind), level, msg, data }]);
  }

  /** Lines a phone or computer uploaded; returns how many were kept. */
  ingest(device: Device, entries: unknown): number {
    if (!Array.isArray(entries)) return 0;
    const t = this.now();
    let b = this.budgets.get(device.id);
    if (!b || t - b.since > CLIENT_WINDOW_MS) {
      b = { n: 0, since: t, noted: false };
      this.budgets.set(device.id, b);
    }
    const rows: EventRow[] = [];
    for (const raw of entries.slice(0, BATCH_MAX)) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      if (typeof e.msg !== "string" || !e.msg.trim()) continue;
      if (b.n >= CLIENT_BUDGET) {
        if (!b.noted) {
          b.noted = true;
          this.record({ kind: "log", level: "warn", msg: `${device.name} uploaded more than ${CLIENT_BUDGET} lines in 10 minutes; dropping the rest for now`, device: device.id });
        }
        break;
      }
      b.n++;
      const ts = typeof e.ts === "number" && Math.abs(e.ts - t) < 7 * 86_400_000 ? e.ts : t;
      const level = LEVELS.includes(e.level as LogLevel) ? (e.level as LogLevel) : "info";
      const kind = typeof e.kind === "string" && e.kind.trim() ? clipKind(e.kind) : "client";
      const msg = clipText(redact(e.msg.replace(/\s+/g, " ").trim()), MSG_MAX);
      const data = e.data && typeof e.data === "object" && !Array.isArray(e.data) ? packData(e.data as Record<string, unknown>) : undefined;
      rows.push({ ts, source: device.kind, device: device.id, kind, level, msg, data });
      // Trouble on a phone or computer belongs in the journal too.
      if (level === "warn" || level === "error") this.opts.journal?.(this.line({ kind: `${device.kind}.${kind}`, level, msg, data, device: device.id }));
    }
    this.write(rows);
    return rows.length;
  }

  query(q: EventQuery): LogEntry[] {
    return this.store.queryEvents(q).map((r) => {
      let data: Record<string, unknown> | undefined;
      try {
        data = r.data ? (JSON.parse(r.data) as Record<string, unknown>) : undefined;
      } catch {
        data = undefined;
      }
      return {
        id: r.id,
        ts: r.ts,
        source: r.source as LogEntry["source"],
        device: r.device,
        deviceName: r.device ? this.opts.deviceName?.(r.device) : undefined,
        kind: r.kind,
        level: r.level as LogLevel,
        msg: r.msg,
        data,
      };
    });
  }

  private write(rows: EventRow[]): void {
    if (!rows.length) return;
    try {
      this.store.putEvents(rows);
    } catch {
      return; // the store is closing; the journal line already went out
    }
    this.sincePrune += rows.length;
    if (this.sincePrune >= PRUNE_EVERY) this.prune();
  }

  private prune(): void {
    this.sincePrune = 0;
    try {
      this.store.pruneEvents(this.now() - (this.opts.retentionMs ?? RETENTION_MS), this.opts.maxRows ?? MAX_ROWS);
    } catch {
      /* closing */
    }
  }

  private line(e: { kind: string; level: string; msg: string; data?: string; device?: string }): string {
    let extra = "";
    if (e.data) {
      try {
        extra = Object.entries(JSON.parse(e.data) as Record<string, unknown>)
          .map(([k, v]) => `${k}=${clipText(typeof v === "string" ? v.replace(/\s+/g, " ") : JSON.stringify(v), 80)}`)
          .join(" ");
      } catch {
        extra = "";
      }
    }
    const who = e.device ? (this.opts.deviceName?.(e.device) ?? e.device) : "";
    return `${e.kind}${e.level === "info" ? "" : ` ${e.level.toUpperCase()}`}${who ? ` [${who}]` : ""} ${e.msg}${extra ? ` | ${extra}` : ""}`;
  }
}

function clipKind(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40) || "event";
}
