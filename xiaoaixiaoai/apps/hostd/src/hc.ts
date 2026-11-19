import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { SHELL_HARNESSES, normalizeStatus, type Agent, type AgentStatus } from "@xiaoaixiaoai/protocol";
import { base, cleanTitle, debounce, lineSplitter, run } from "./util.ts";
import { HcScreens, type ScreenLines } from "./hcscreen.ts";
import { defaultHcBin, programName } from "./platform.ts";

/** Subset of a herdr-core (`hc`) terminal object we rely on. */
export interface HcTerminal {
  address: string;
  argv?: string[];
  cwd?: string | null;
  state?: string; // live | finished
  status?: { app?: string; state?: string; msg?: string } | null;
  status_ms?: number | null;
  title?: string | null;
  turn?: number;
  name?: string | null;
  labels?: Record<string, string>;
  foreground?: { argv?: string[]; cwd?: string; pid?: number } | null;
  created_ms?: number;
  cols?: number;
  rows?: number;
}

/**
 * True when the bottom of a screen is a panel's footer ("Esc to cancel",
 * "Enter to confirm · Esc to exit"…), i.e. typed text would go into the panel.
 */
export function endsInPanel(screen: string): boolean {
  const tail = screen.split("\n").map((l) => l.trim()).filter(Boolean).slice(-4);
  return tail.some((l) => /\besc\b[^\n]{0,12}?\bto (cancel|close|exit|go back|dismiss)\b/i.test(l));
}

/** Space and tab names by id, as the desktop app (`herdr-app ls`) shows them. */
export interface AppNames {
  spaces: Map<string, string>;
  tabs: Map<string, string>;
}

/** Interpreters an agent program runs inside; their name says nothing about the agent. */
const RUNTIMES = new Set(["node", "bun", "deno", "python", "python3", "py", "cmd", "npx"]);

const KEY_ALIASES: Record<string, string> = {
  enter: "enter",
  return: "enter",
  esc: "esc",
  escape: "esc",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  tab: "tab",
  "shift+tab": "shift+tab",
  backspace: "backspace",
  space: "space",
  "ctrl+c": "ctrl+c",
  "ctrl+d": "ctrl+d",
  "ctrl+l": "ctrl+l",
};

/**
 * Bridges the herdr GUI runtime (herdr-core). Keeps one `hc connect` JSON-RPC
 * session open for live events and the full terminal list; uses the `hc` CLI
 * for read/send/keys.
 */
export class HcAdapter extends EventEmitter {
  terminals = new Map<string, HcTerminal>();
  version: string | undefined;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private waiting = new Map<number, (msg: any) => void>();
  private stopped = false;
  private backoff = 1000;
  private resync = debounce(() => void this.list(), 400);
  private titleFlush = debounce(() => this.emit("change"), 1500);
  private timer: NodeJS.Timeout | null = null;
  /** Last line from the subscription; herdr-core sends a heartbeat every 15 s. */
  private lastLine = 0;

  private hcBin: string;

  constructor(hcBin = defaultHcBin()) {
    super();
    this.hcBin = hcBin;
  }

  async available(): Promise<boolean> {
    try {
      this.version = (await run(this.hcBin, ["--version"], { timeoutMs: 10_000 })).trim().split(/\s+/).pop();
      return true;
    } catch {
      return false;
    }
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.timer = setInterval(() => {
      // A subscription that went quiet (no heartbeat) is reopened; its snapshot resyncs everything.
      if (this.child && this.lastLine && Date.now() - this.lastLine > 45_000) this.child.kill();
      void this.list();
    }, 20_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.child?.kill();
    this.screens.stop();
  }

  private connect(): void {
    const child = spawn(this.hcBin, ["connect"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.lastLine = Date.now();
    child.stdout!.on(
      "data",
      lineSplitter((line) => this.onLine(line)),
    );
    child.stderr!.on("data", () => {});
    child.on("exit", () => {
      this.child = null;
      for (const r of this.waiting.values()) r({ error: { message: "hc connect exited" } });
      this.waiting.clear();
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
    child.on("error", () => {});
    void this.request("events.subscribe", {}).then((r) => {
      if (r?.result?.terminals) {
        this.backoff = 1000;
        this.setAll(r.result.terminals);
      } else {
        void this.list();
      }
    });
  }

  private request(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.resolve({ error: { message: "not connected" } });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ error: { message: "timeout" } });
      }, timeoutMs);
      this.waiting.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private onLine(line: string): void {
    this.lastLine = Date.now();
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.waiting.has(msg.id)) {
      this.waiting.get(msg.id)!(msg);
      this.waiting.delete(msg.id);
      return;
    }
    if (msg.method === "event") {
      const p = msg.params ?? {};
      const t = typeof p.terminal === "string" ? this.terminals.get(p.terminal) : undefined;
      if (p.type === "title" && t) {
        // Spinner frames arrive many times per second; only the human part matters.
        const before = cleanTitle(t.title);
        t.title = p.data?.title ?? t.title;
        if (cleanTitle(t.title) !== before) this.titleFlush();
        return;
      }
      if (p.type === "status" && t && p.data && "status" in p.data) {
        const next = p.data.status ?? null;
        // A finished turn waits for the list: the event comes before the new turn
        // number, and with the old one the turn would read as already seen (idle).
        if (next?.state !== "done") {
          // Applied at once: the phone must not wait for a full list. Only a change
          // of state matters; the status message changes every few seconds.
          const before = HcAdapter.status(t);
          const noteBefore = HcAdapter.note(t);
          t.status = next;
          if (HcAdapter.status(t) === before) {
            // Same state; a new error or question still has to reach the phone.
            if (HcAdapter.note(t) !== noteBefore) this.emit("change");
            return;
          }
          t.status_ms = Date.now();
          this.emit("change");
        }
      }
      this.resync();
    } else if (msg.method === "missed") {
      const fresh = msg.params?.terminals;
      if (Array.isArray(fresh)) this.setAll(fresh);
      else this.resync();
    }
  }

  /**
   * The full list, over a connection of its own: once a connection has
   * subscribed to events, herdr-core answers nothing else on it (hc 0.1.21), so
   * asking there only ever timed out and left the list as it was at startup.
   */
  async list(): Promise<void> {
    const r = await this.oneShot("terminal.list", {});
    if (r?.result?.terminals) this.setAll(r.result.terminals);
  }

  /** One request on a short-lived `hc connect`. */
  private oneShot(method: string, params: unknown, timeoutMs = 10_000): Promise<any> {
    return new Promise((resolve) => {
      let done = false;
      const child = spawn(this.hcBin, ["connect"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      const finish = (v: any) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        child.kill();
        resolve(v);
      };
      const t = setTimeout(() => finish({ error: { message: "timeout" } }), timeoutMs);
      child.stdout!.on(
        "data",
        lineSplitter((line) => {
          try {
            const msg = JSON.parse(line);
            if (msg.id === 1) finish(msg);
          } catch {
            /* not ours */
          }
        }),
      );
      child.on("error", (e) => finish({ error: { message: e.message } }));
      child.on("exit", () => finish({ error: { message: "hc connect exited" } }));
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
    });
  }

  private setAll(list: HcTerminal[]): void {
    this.terminals = new Map(list.filter((t) => t.state !== "finished").map((t) => [t.address, t]));
    this.emit("change");
  }

  /** Program running in the terminal, e.g. claude-code, omp, sh (on Windows without `.exe`). */
  static harness(t: HcTerminal): string {
    if (t.status?.app) return t.status.app;
    const fg = programName(base(t.foreground?.argv?.[0]));
    const launched = programName(base(t.argv?.[0]));
    // An agent installed by npm on Windows (claude.cmd) runs as node.exe, which is what the
    // foreground shows; the program is the one the terminal was started with. A runtime
    // started from a shell stays what it is.
    const plain = (p: string) => RUNTIMES.has(p.toLowerCase()) || SHELL_HARNESSES.has(p.toLowerCase());
    if (launched && fg && RUNTIMES.has(fg.toLowerCase()) && !plain(launched)) return launched;
    return fg || launched || "terminal";
  }

  /**
   * Status as the desktop app shows it: a finished turn the person has already
   * looked at in the app (`herdr.seen` label >= turn) reads as idle, not done.
   */
  static status(t: HcTerminal): AgentStatus {
    if (!t.status) return "idle";
    const s = normalizeStatus(t.status.state);
    if (s !== "done") return s;
    const seen = Number(t.labels?.["herdr.seen"]);
    return Number.isFinite(seen) && typeof t.turn === "number" && seen >= t.turn ? "idle" : "done";
  }

  /** What the program says while it waits for a person (an error or a question), clipped. */
  static note(t: HcTerminal): string | undefined {
    if (HcAdapter.status(t) !== "blocked") return undefined;
    const msg = t.status?.msg?.replace(/\s+/g, " ").trim();
    return msg ? (msg.length > 300 ? `${msg.slice(0, 300)}…` : msg) : undefined;
  }

  /** "space / tab" with the names the desktop app shows now (renames included). */
  static where(t: HcTerminal, names?: AppNames): string | undefined {
    const label = t.labels?.where;
    const space = names?.spaces.get(t.labels?.["herdr.space"] ?? "");
    if (!space) return label;
    const tab = names?.tabs.get(t.labels?.["herdr.tab"] ?? "") ?? label?.split(" / ").slice(1).join(" / ");
    return tab ? `${space} / ${tab}` : space;
  }

  static toAgent(t: HcTerminal, deviceId: string, names?: AppNames): Agent {
    const harness = HcAdapter.harness(t);
    const name = t.name?.trim() || undefined;
    return {
      key: `${deviceId}/hc:${t.address}`,
      deviceId,
      source: "hc",
      localId: t.address,
      harness,
      title: name ?? cleanTitle(t.title),
      name,
      where: HcAdapter.where(t, names),
      cwd: t.foreground?.cwd ?? t.cwd ?? undefined,
      status: HcAdapter.status(t),
      statusSince: t.status_ms ?? undefined,
      statusNote: HcAdapter.note(t),
      errored: ["error", "failed"].includes(t.status?.state?.toLowerCase() ?? "") || undefined,
      turn: t.turn,
      isShell: !t.status && SHELL_HARNESSES.has(harness.toLowerCase()),
      updatedAt: t.status_ms ?? t.created_ms ?? Date.now(),
    };
  }

  private screens = new HcScreens();

  /**
   * Starts a program (empty argv: the shell) in a new terminal of hc's own, in `cwd`, and
   * returns its address. For computers without the desktop app; it belongs to no space.
   */
  async spawnTerminal(argv: string[], cwd: string): Promise<string> {
    const out = await run(this.hcBin, ["run", "--bg", "--no-parent", "--no-notify", "--json", "--cwd", cwd, ...(argv.length ? ["--", ...argv] : [])], {
      timeoutMs: 30_000,
    });
    const line = out.trim().split("\n").pop() ?? "";
    let address: unknown;
    try {
      address = (JSON.parse(line) as { address?: unknown }).address;
    } catch {
      /* reported below */
    }
    if (typeof address !== "string" || !address) throw new Error(`hc run 没有返回新终端：${out.trim().slice(0, 200)}`);
    return address;
  }

  async read(
    address: string,
    lines = 200,
  ): Promise<{ text: string; ansi?: string; cols?: number; rows?: number; how?: string; complete?: boolean }> {
    try {
      const s = await this.screens.snapshot(address, lines);
      return { text: s.text, ansi: s.ansi, cols: s.cols, rows: s.rows, how: "screen", complete: true };
    } catch {
      /* finished terminals cannot be attached: fall back to the plain read */
    }
    const out = await run(this.hcBin, ["read", address, "--json", "--lines", String(lines)]);
    const r = JSON.parse(out) as { text?: string; how?: string; complete?: boolean };
    return { text: r.text ?? "", how: r.how, complete: r.complete };
  }

  async watch(address: string, history: number, onUpdate: (s: ScreenLines) => void, onError: (e: Error) => void, opts: { text?: boolean } = {}): Promise<() => void> {
    try {
      return await this.screens.watch(address, history, onUpdate, onError, opts);
    } catch (e) {
      onError(e as Error);
      throw e;
    }
  }

  async send(address: string, text: string, enter = true): Promise<void> {
    if (enter) {
      // A panel (Claude Code's /status, /config, /model…) swallows pasted text
      // and the message is lost. An idle program showing one gets Esc first.
      if (await this.panelOpen(address)) {
        await run(this.hcBin, ["keys", address, "esc"]);
        await new Promise((r) => setTimeout(r, 300));
        if (await this.panelOpen(address)) throw new Error("它开着一个面板，消息没送进去：先在终端里按 Esc 关掉再发");
      }
      await run(this.hcBin, ["send", address, text]);
    } else {
      // Typing without Enter: one key per character keeps it literal.
      await run(this.hcBin, ["keys", address, ...[...text].map((c) => (c === " " ? "space" : c))]);
    }
  }

  /**
   * True when an idle program shows a panel that Esc closes. Only idle/done:
   * a blocked program's dialog (a permission question) is the person's to answer.
   */
  private async panelOpen(address: string): Promise<boolean> {
    const t = this.terminals.get(address);
    if (!t?.status || !["idle", "done"].includes(normalizeStatus(t.status.state))) return false;
    try {
      const s = await this.screens.snapshot(address, 0);
      return endsInPanel(s.text);
    } catch {
      return false;
    }
  }

  /** Presses the program's stop key and says what happened (hc watches for an effect). */
  async interrupt(address: string): Promise<string> {
    const out = await run(this.hcBin, ["interrupt", address, "--json", "--timeout", "5"], { timeoutMs: 20_000 });
    try {
      const r = JSON.parse(out) as Record<string, unknown>;
      const said = [r.outcome, r.result, r.message, r.status, r.state].find((v) => typeof v === "string" && v);
      return typeof said === "string" ? said : out.trim().slice(0, 300);
    } catch {
      return out.trim().slice(0, 300);
    }
  }

  /** Ends the terminal's program (hangup, then escalate). */
  async kill(address: string): Promise<void> {
    await run(this.hcBin, ["kill", address], { timeoutMs: 20_000 });
  }

  /** Sets labels on a terminal; herdr keeps what every client shares (seen, pin) there. */
  async label(address: string, labels: Record<string, string>): Promise<void> {
    await run(this.hcBin, ["label", address, ...Object.entries(labels).map(([k, v]) => `${k}=${v}`)], { timeoutMs: 10_000 });
  }

  /** Types raw text at once (see HcScreens.input); the terminal keeps its size. */
  async input(address: string, data: string): Promise<void> {
    const t = this.terminals.get(address);
    await this.screens.input(address, data, t?.cols || 80, t?.rows || 24);
  }

  async keys(address: string, keys: string[]): Promise<void> {
    const mapped = keys.map((k) => KEY_ALIASES[k.toLowerCase()] ?? (k.length === 1 ? k : null));
    if (mapped.some((k) => k === null)) throw new Error(`unknown key in ${JSON.stringify(keys)}`);
    await run(this.hcBin, ["keys", address, ...(mapped as string[])]);
  }

  /**
   * Copies a local file beside the terminal (`hc put`; herdr-core keeps it in
   * its own per-terminal folder, renaming on a clash) and returns where it landed.
   */
  async put(address: string, file: string): Promise<string> {
    const out = await run(this.hcBin, ["put", "--json", address, file], { timeoutMs: 30_000 });
    let path: unknown;
    try {
      path = (JSON.parse(out) as { path?: unknown }).path;
    } catch {
      path = undefined;
    }
    if (typeof path !== "string" || !path) throw new Error(`hc put said no path: ${out.trim().slice(0, 200)}`);
    return path;
  }
}
