/**
 * A small ring of this computer's own log lines, uploaded to the relay in
 * batches (`log` frames) so the person running the relay can see what went
 * wrong here. Never tokens: lines are redacted before they are kept.
 */
import type { ClientLogEntry, LogLevel } from "@xiaoaixiaoai/protocol";

export function redactLine(s: string): string {
  return s
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    .replace(/\bhp_[A-Za-z0-9_-]{8,}/g, "hp_***")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s"']+/gi, "$1***");
}

export function clipChars(s: string, n: number): string {
  const c = Array.from(s);
  return c.length > n ? `${c.slice(0, n).join("")}…` : s;
}

/** Level of a plain log line, from its words. */
export function levelOf(line: string): LogLevel {
  if (/\b(error|exception|crash)\b|失败|出错/i.test(line)) return "error";
  if (/\b(fail(ed|ure)?|rejected|refused|timeout|stopped answering|retrying|disconnected|revoked|removed|✗)\b/i.test(line)) return "warn";
  return "info";
}

export class LogBuffer {
  private items: ClientLogEntry[] = [];
  private max: number;
  dropped = 0;

  constructor(max = 500) {
    this.max = max;
  }

  get size(): number {
    return this.items.length;
  }

  push(level: LogLevel, kind: string, msg: string, data?: Record<string, unknown>): void {
    let packed: Record<string, unknown> | undefined;
    if (data) {
      packed = {};
      for (const [k, v] of Object.entries(data)) if (v !== undefined) packed[k] = typeof v === "string" ? clipChars(redactLine(v), 300) : v;
    }
    this.items.push({ ts: Date.now(), level, kind, msg: clipChars(redactLine(msg.replace(/\s+/g, " ").trim()), 500), data: packed });
    if (this.items.length > this.max) {
      this.dropped += this.items.length - this.max;
      this.items.splice(0, this.items.length - this.max);
    }
  }

  /** The oldest `n` lines, removed from the ring. */
  take(n = 200): ClientLogEntry[] {
    return this.items.splice(0, n);
  }

  /** Puts lines back in front (a send that could not go out). */
  putBack(entries: ClientLogEntry[]): void {
    this.items.unshift(...entries);
    if (this.items.length > this.max) this.items.splice(this.max);
  }
}
