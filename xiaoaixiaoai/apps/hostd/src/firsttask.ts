/**
 * The first task for a program that takes none on its command line (kimi,
 * droid, qwen...): typed in once the program is up. "Up" means the screen shows
 * something and has stopped changing for a moment, or the desktop app knows the
 * program and reports it idle. A program that opens on a question (trust this
 * folder? log in? y/n) gets nothing typed: the Enter after the task would
 * answer that question for the person.
 */
import { base } from "./util.ts";
import { programName } from "./platform.ts";
import { HcAdapter, type HcTerminal } from "./hc.ts";

export interface TypeTaskDeps {
  /** The terminal as the desktop app lists it now (undefined until it shows up). */
  terminal(): Promise<HcTerminal | undefined>;
  /** Its visible screen as plain text. */
  screen(): Promise<string>;
  /** Pastes the text and presses Enter. */
  type(text: string): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface TypeTaskOptions {
  /** Give up after this long (the agent stays open, idle). */
  timeoutMs?: number;
  /** Never type before this long after the start: programs draw a splash first. */
  minMs?: number;
  /** The screen stays the same this long: the program waits for input. */
  stableMs?: number;
  pollMs?: number;
}

export type TypeTaskResult = { ok: true; waitedMs: number; how: "status" | "screen" } | { ok: false; waitedMs: number; reason: string };

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "tcsh", "nu", "login", "pwsh", "powershell"]);

/** A screen asking the person something; Enter there would answer it. */
export const QUESTION =
  /trust (this|the) (folder|directory|workspace|files)|do you trust|信任|\(y\/n\)|\[y\/n\]|yes,? (i trust|proceed|continue)|\blog ?in\b|\bsign ?in\b|登录|api key|authenticat|press enter to continue|按回车继续|select (a|an|your) (model|theme|provider|login)/i;

/** Still starting up: a spinner or progress keeps the screen changing, these words say it outright. */
export const LOADING = /loading|starting up|\bstarting\b|initiali[sz]ing|connecting|please wait|正在启动|启动中|加载中|正在加载|初始化中/i;

/** Screen text compared for "has it stopped changing": only blank space is ignored. */
function still(text: string): string {
  return text.replace(/\s+/g, "");
}

function tailLines(text: string, n: number): string {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-n).join("\n");
}

/** The last line with something on it, for telling the person what the program shows. */
function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const q = lines.find((l) => QUESTION.test(l)) ?? lines.pop() ?? "";
  return Array.from(q).length > 80 ? `${Array.from(q).slice(0, 80).join("")}…` : q;
}

export async function typeFirstTask(task: string, d: TypeTaskDeps, o: TypeTaskOptions = {}): Promise<TypeTaskResult> {
  const timeoutMs = o.timeoutMs ?? 45_000;
  const minMs = o.minMs ?? 1500;
  const stableMs = o.stableMs ?? 1500;
  const pollMs = o.pollMs ?? 700;
  const t0 = d.now();
  let last = "";
  let sameSince = t0;
  let why = "它一直没准备好";
  for (;;) {
    const waited = d.now() - t0;
    if (waited > timeoutMs) return { ok: false, waitedMs: waited, reason: `等了 ${Math.round(timeoutMs / 1000)} 秒，${why}，任务没打进去` };
    const t = await d.terminal().catch(() => undefined);
    if (t?.state === "finished") return { ok: false, waitedMs: waited, reason: "程序一启动就退出了，任务没打进去" };
    let text = "";
    if (t) {
      try {
        text = await d.screen();
      } catch {
        text = "";
      }
    }
    const now = d.now();
    const shape = still(text);
    if (shape !== last) {
      last = shape;
      sameSince = now;
    }
    const fg = programName(base(t?.foreground?.argv?.[0])).replace(/^-/, "").toLowerCase();
    const known = !!t?.status?.app;
    const status = t ? HcAdapter.status(t) : undefined;
    const settled = now - sameSince >= stableMs;
    if (!t) why = "新终端一直没出现";
    else if (fg && SHELLS.has(fg)) why = "终端里只有 shell，程序没起来";
    else if (!shape) why = "屏幕一直是空的";
    else if (QUESTION.test(text)) {
      // A question that stays: say what it asks instead of waiting it out.
      if (settled || (known && status === "blocked")) return { ok: false, waitedMs: now - t0, reason: `它一开就在问：「${lastLine(text)}」，任务没打进去（回车会替你答了它）` };
      why = `它停在一个提问上：「${lastLine(text)}」`;
    } else if (known && status === "blocked") {
      return { ok: false, waitedMs: now - t0, reason: `它一开就停在确认提示上：「${lastLine(text)}」，任务没打进去` };
    } else if (known && status === "working") why = "它一直在忙着启动";
    else if (LOADING.test(tailLines(text, 3))) why = `它一直在启动：「${lastLine(tailLines(text, 3))}」`;
    else if (now - t0 >= minMs && ((known && (status === "idle" || status === "done")) || settled)) {
      try {
        await d.type(task);
      } catch (e) {
        return { ok: false, waitedMs: d.now() - t0, reason: `打字的时候出错了：${(e as Error).message}` };
      }
      return { ok: true, waitedMs: d.now() - t0, how: known && (status === "idle" || status === "done") ? "status" : "screen" };
    } else why = "屏幕一直在变";
    await d.sleep(pollMs);
  }
}
