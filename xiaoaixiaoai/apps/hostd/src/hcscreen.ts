import { spawn, type ChildProcess } from "node:child_process";
import { defaultHcBin } from "./platform.ts";
import { Screen } from "./vt.ts";

/** Frame kinds of `hc connect` in framed mode (herdr-app src/hc.rs). */
const DATA = 0;
const CREDIT = 1;
const CLOSE = 2;
const HEADER = 9;

function encode(channel: number, kind: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(HEADER);
  h.writeUInt32LE(channel, 0);
  h[4] = kind;
  h.writeUInt32LE(payload.length, 5);
  return Buffer.concat([h, payload]);
}

export interface ScreenSnapshot {
  /** Screen (and history above it) with SGR colors; one line per row. */
  ansi: string;
  text: string;
  cols: number;
  rows: number;
}

/** One paint of a watched terminal: the `ansi` of a snapshot as its lines. */
export interface ScreenLines {
  lines: string[];
  /** Plain text of the same rows, only when the watch asked for it. */
  text?: string;
  cols: number;
  rows: number;
}

/**
 * Colored screen snapshots from herdr-core. Keeps one framed `hc connect`
 * open; each snapshot attaches as a watch-only observer (never types or
 * resizes), replays the paint into a screen model, then detaches.
 */
const WATCH_MIN_INTERVAL_MS = 100;

export class HcScreens {
  private hcBin: string;
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private replies = new Map<number, (msg: any) => void>();
  private streams = new Map<number, (kind: number, payload: Buffer) => void>();
  private early = new Map<number, Array<[number, Buffer]>>();

  constructor(hcBin = defaultHcBin()) {
    this.hcBin = hcBin;
  }

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const child = spawn(this.hcBin, ["connect"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      this.child = child;
      let framed = false;
      child.stdout!.on("data", (d: Buffer) => {
        this.buf = Buffer.concat([this.buf, d]);
        if (!framed) {
          const nl = this.buf.indexOf(10);
          if (nl < 0) return;
          const hello = JSON.parse(this.buf.subarray(0, nl).toString());
          this.buf = this.buf.subarray(nl + 1);
          if (hello.error) {
            reject(new Error(hello.error.message ?? "hc refused hello"));
            child.kill();
            return;
          }
          framed = true;
          resolve();
        }
        this.drain();
      });
      const lost = () => {
        this.child = null;
        this.ready = null;
        this.buf = Buffer.alloc(0);
        for (const r of this.replies.values()) r({ error: { message: "lost hc" } });
        this.replies.clear();
        for (const s of this.streams.values()) s(CLOSE, Buffer.alloc(0));
        this.streams.clear();
        this.early.clear();
        if (!framed) reject(new Error("hc connect exited"));
      };
      child.on("exit", lost);
      child.on("error", lost);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "hello", params: { framed: true } })}\n`);
    });
    return this.ready;
  }

  private drain(): void {
    while (this.buf.length >= HEADER) {
      const channel = this.buf.readUInt32LE(0);
      const kind = this.buf[4]!;
      const len = this.buf.readUInt32LE(5);
      if (this.buf.length < HEADER + len) return;
      const payload = this.buf.subarray(HEADER, HEADER + len);
      this.buf = this.buf.subarray(HEADER + len);
      if (channel === 0) {
        let msg: any;
        try {
          msg = JSON.parse(payload.toString());
        } catch {
          continue;
        }
        const r = typeof msg.id === "number" ? this.replies.get(msg.id) : undefined;
        if (r) {
          this.replies.delete(msg.id);
          r(msg);
        }
        continue;
      }
      const s = this.streams.get(channel);
      if (s) s(kind, Buffer.from(payload));
      else this.early.set(channel, [...(this.early.get(channel) ?? []), [kind, Buffer.from(payload)]]);
    }
  }

  private send(channel: number, kind: number, payload: Buffer): void {
    this.child?.stdin?.write(encode(channel, kind, payload));
  }

  private async call(method: string, params: unknown, timeoutMs = 8000): Promise<any> {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.replies.delete(id);
        reject(new Error(`${method}: no reply from hc`));
      }, timeoutMs);
      this.replies.set(id, (msg) => {
        clearTimeout(t);
        if (msg.error) reject(new Error(msg.error.message ?? `${method} failed`));
        else resolve(msg.result);
      });
      this.send(0, DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    });
  }

  /**
   * Attaches as an observer, waits until the paint settles (quietMs without
   * new bytes, at most maxMs), and returns the rendered screen.
   */
  async snapshot(terminal: string, history = 200, quietMs = 60, maxMs = 1500): Promise<ScreenSnapshot> {
    // Observers see the terminal at its own size; cols/rows here are only required fields.
    const r = await this.call("terminal.attach", { terminal, cols: 80, rows: 24, history, observe: true });
    const channel: number = r.channel;
    const cols: number = r.terminal?.cols ?? 80;
    const rows: number = r.terminal?.rows ?? 24;
    const screen = new Screen(cols, rows, history);
    const decoder = new TextDecoder("utf-8");

    await new Promise<void>((resolve) => {
      let quiet: NodeJS.Timeout | undefined;
      const done = () => {
        clearTimeout(quiet);
        clearTimeout(cap);
        this.streams.delete(channel);
        resolve();
      };
      const cap = setTimeout(done, maxMs);
      const onFrame = (kind: number, payload: Buffer) => {
        if (kind === CLOSE) return done();
        if (kind !== DATA) return;
        screen.write(decoder.decode(payload, { stream: true }));
        clearTimeout(quiet);
        quiet = setTimeout(done, quietMs);
      };
      this.streams.set(channel, onFrame);
      for (const [kind, p] of this.early.get(channel) ?? []) onFrame(kind, p);
      this.early.delete(channel);
      const credit = Buffer.alloc(4);
      credit.writeUInt32LE(8 * 1024 * 1024);
      this.send(channel, CREDIT, credit);
      quiet = setTimeout(done, Math.max(quietMs, 600)); // first paint may take a moment
    });
    this.send(channel, CLOSE, Buffer.alloc(0));
    return { ansi: screen.toAnsi(history), text: screen.toText(history), cols, rows };
  }

  /**
   * Keep one observer attached and emit coalesced screen paints. The returned
   * stop function closes that observer; it is safe to call more than once.
   */
  async watch(
    terminal: string,
    history: number,
    onUpdate: (paint: ScreenLines) => void,
    onError: (error: Error) => void,
    opts: { text?: boolean } = {},
  ): Promise<() => void> {
    const r = await this.call("terminal.attach", { terminal, cols: 80, rows: 24, history, observe: true });
    const channel: number = r.channel;
    const cols: number = r.terminal?.cols ?? 80;
    const rows: number = r.terminal?.rows ?? 24;
    const screen = new Screen(cols, rows, history);
    const decoder = new TextDecoder("utf-8");
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let lastAt = 0;
    let last: string[] | undefined;
    const emit = () => {
      timer = undefined;
      if (stopped) return;
      const lines = screen.ansiLines(history);
      // Spinners and cursor blinks repaint without changing what is shown.
      if (last && last.length === lines.length && lines.every((l, i) => l === last![i])) return;
      last = lines;
      lastAt = Date.now();
      onUpdate({ lines, text: opts.text === false ? undefined : screen.toText(history), cols, rows });
    };
    const finish = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      this.streams.delete(channel);
      this.send(channel, CLOSE, Buffer.alloc(0));
    };
    const onFrame = (kind: number, payload: Buffer) => {
      if (stopped) return;
      if (kind === CLOSE) {
        finish();
        return;
      }
      if (kind !== DATA) return;
      screen.write(decoder.decode(payload, { stream: true }));
      // First paint goes out at once; after that at most ~10 frames a second.
      if (!timer) timer = setTimeout(emit, Math.max(40, WATCH_MIN_INTERVAL_MS - (Date.now() - lastAt)));
    };
    this.streams.set(channel, onFrame);
    for (const [kind, p] of this.early.get(channel) ?? []) onFrame(kind, p);
    this.early.delete(channel);
    const credit = Buffer.alloc(4);
    credit.writeUInt32LE(32 * 1024 * 1024);
    this.send(channel, CREDIT, credit);
    // Caller can stop synchronously even while the initial frame is arriving.
    return finish;
  }

  private inputs = new Map<string, { channel: Promise<number>; timer?: NodeJS.Timeout }>();

  /**
   * Types into a terminal the way the person at it would: raw bytes on an
   * attached (not observing) stream, so text of any script arrives at once and
   * in order. The stream is opened at the terminal's own size, so nothing is
   * resized, and closed after a quiet while.
   */
  async input(terminal: string, data: string, cols: number, rows: number): Promise<void> {
    let s = this.inputs.get(terminal);
    if (!s) {
      const channel = this.call("terminal.attach", { terminal, cols, rows, observe: false, resumed: true }).then((r) => {
        const ch: number = r.channel;
        // What it paints is not needed here; keep it flowing and drop it.
        this.streams.set(ch, (kind) => {
          if (kind !== CLOSE) return;
          this.streams.delete(ch);
          if (this.inputs.get(terminal)?.channel === channel) this.inputs.delete(terminal);
        });
        this.early.delete(ch);
        const credit = Buffer.alloc(4);
        credit.writeUInt32LE(64 * 1024 * 1024);
        this.send(ch, CREDIT, credit);
        return ch;
      });
      s = { channel };
      this.inputs.set(terminal, s);
      channel.catch(() => {
        if (this.inputs.get(terminal)?.channel === channel) this.inputs.delete(terminal);
      });
    }
    const entry = s;
    const ch = await entry.channel;
    this.send(ch, DATA, Buffer.from(data, "utf8"));
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.inputs.get(terminal) !== entry) return;
      this.inputs.delete(terminal);
      this.streams.delete(ch);
      this.send(ch, CLOSE, Buffer.alloc(0));
    }, 20_000);
  }

  stop(): void {
    for (const s of this.inputs.values()) clearTimeout(s.timer);
    this.inputs.clear();
    this.child?.kill();
  }
}
