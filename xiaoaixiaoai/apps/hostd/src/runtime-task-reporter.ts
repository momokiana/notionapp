import { RUNTIME_TASK_EVENTS_LIMIT, type RuntimeTaskEvent } from "@xiaoaixiaoai/protocol";

const RETRY_MS = 10_000;

/** Drain the bridge's recent observation window. A reconnect may resend events, never prompts. */
export class RuntimeTaskReporter {
  private pending = new Map<string, number>();
  private reading = false;

  private readonly read: () => Promise<RuntimeTaskEvent[]>;
  private readonly send: (event: RuntimeTaskEvent) => void;
  private readonly current: () => boolean;
  private readonly now: () => number;

  constructor(read: () => Promise<RuntimeTaskEvent[]>, send: (event: RuntimeTaskEvent) => void,
              current: () => boolean, now: () => number = Date.now) {
    this.read = read;
    this.send = send;
    this.current = current;
    this.now = now;
  }

  ack(id: string) {
    if (this.pending.has(id)) this.pending.set(id, Infinity);
  }

  async tick(): Promise<void> {
    if (this.reading || !this.current()) return;
    this.reading = true;
    try {
      const events = await this.read();
      if (!this.current()) return;
      const present = new Set(events.map((e) => e.eventId));
      for (const id of this.pending.keys()) if (!present.has(id)) this.pending.delete(id);
      const now = this.now();
      for (const e of events.slice(0, RUNTIME_TASK_EVENTS_LIMIT)) {
        if (!this.current()) break;
        if ((this.pending.get(e.eventId) ?? -Infinity) > now - RETRY_MS) continue;
        this.pending.set(e.eventId, now);
        this.send(e);
      }
    } catch { /* Bridge unavailable or relay disconnected. Try again on a later poll. */ }
    finally { this.reading = false; }
  }
}
