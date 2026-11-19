import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { HERDR_COMMANDS, type HerdrCommand, type LaunchOption, type SpaceInfo } from "@xiaoaixiaoai/protocol";
import type { AppNames } from "./hc.ts";
import { IS_WINDOWS, onPath, programName, windowsBins } from "./platform.ts";
import { base, run } from "./util.ts";

/**
 * Programs the phone may start. The phone picks an id, never a command line,
 * so a viewer token cannot run arbitrary programs on this computer.
 */
export const LAUNCHERS: Array<LaunchOption & { argv: string[] }> = [
  { id: "claude", label: "Claude Code", argv: ["claude"], takesTask: true },
  { id: "codex", label: "Codex", argv: ["codex"], takesTask: true },
  { id: "omp", label: "omp", argv: ["omp"], takesTask: true },
  { id: "opencode", label: "OpenCode", argv: ["opencode"], takesTask: false },
  { id: "gemini", label: "Gemini CLI", argv: ["gemini"], takesTask: false },
  { id: "pi", label: "pi", argv: ["pi"], takesTask: true },
  { id: "kilo", label: "Kilo", argv: ["kilo"], takesTask: false },
  { id: "hermes", label: "Hermes", argv: ["hermes"], takesTask: false },
  // Offered only where installed. Without `takesTask` the first task is sent as a message once it's up.
  { id: "kimi", label: "Kimi Code", argv: ["kimi"], takesTask: false },
  { id: "cursor-agent", label: "Cursor Agent", argv: ["cursor-agent"], takesTask: false },
  { id: "droid", label: "Droid", argv: ["droid"], takesTask: false },
  { id: "codebuddy", label: "CodeBuddy", argv: ["codebuddy"], takesTask: false },
  { id: "qoder", label: "Qoder", argv: ["qoder"], takesTask: false },
  { id: "qwen", label: "Qwen Code", argv: ["qwen"], takesTask: false },
  { id: "copilot", label: "Copilot CLI", argv: ["copilot"], takesTask: false },
  { id: "amp", label: "Amp", argv: ["amp"], takesTask: false },
  { id: "crush", label: "Crush", argv: ["crush"], takesTask: false },
  { id: "goose", label: "Goose", argv: ["goose"], takesTask: false },
  { id: "aider", label: "Aider", argv: ["aider"], takesTask: false },
  { id: "iflow", label: "iFlow", argv: ["iflow"], takesTask: false },
  { id: "cline", label: "Cline", argv: ["cline"], takesTask: false },
  { id: "shell", label: "终端", argv: [], takesTask: false },
];

/** Where each program was last found: launching by full path works whatever PATH the desktop app has. */
const programPaths = new Map<string, string>();

/** Folders that installers add to PATH in shell rc files, which a login-only shell never reads. */
function commonBins(): string[] {
  const h = homedir();
  return [
    `${h}/.bun/bin`,
    `${h}/.local/bin`,
    `${h}/.npm-global/bin`,
    `${h}/.volta/bin`,
    `${h}/.cargo/bin`,
    `${h}/.deno/bin`,
    `${h}/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(process.env.PATH ?? "").split(":").filter(Boolean),
  ];
}

function executable(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Finds programs the way the person's own terminal does. A service started by
 * launchd/systemd has a bare PATH, and a login shell (`-l`) skips ~/.zshrc,
 * where e.g. bun puts ~/.bun/bin (claude, codex, gemini...): so ask an
 * interactive login shell, then look in the usual install folders as well.
 */
export async function findPrograms(names: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (IS_WINDOWS) {
    // A service started at logon has the person's full PATH; npm, bun and other installers' folders cover the rest.
    const extra = windowsBins();
    for (const name of names) {
      const hit = onPath(name, process.env, true, extra);
      if (hit) found.set(name, hit);
    }
    return found;
  }
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const out = await run(shell, ["-lic", `for c in ${names.join(" ")}; do p=$(command -v "$c" 2>/dev/null) && echo "@@$c=$p"; done; true`], {
      timeoutMs: 15_000,
      input: "",
      env: { ...process.env, TERM: "dumb" },
    });
    for (const line of out.split("\n")) {
      const m = /^@@([\w.-]+)=(\/.+)$/.exec(line.trim());
      if (m && names.includes(m[1]!) && executable(m[2]!)) found.set(m[1]!, m[2]!);
    }
  } catch {
    /* rc files that hang or fail: the folder scan below still works */
  }
  for (const name of names) {
    if (found.has(name)) continue;
    const hit = commonBins().map((d) => `${d}/${name}`).find(executable);
    if (hit) found.set(name, hit);
  }
  return found;
}

/** argv with its program as the full path found here, so it starts whatever PATH the service has. */
export function withProgramPath(argv: string[]): string[] {
  return argv.length ? [programPaths.get(argv[0]!) ?? argv[0]!, ...argv.slice(1)] : argv;
}

/** What a launcher runs (empty: the computer's own shell). */
export function launcherArgv(id: string): string[] {
  const l = LAUNCHERS.find((x) => x.id === id);
  if (!l) throw new Error("不支持启动这个程序");
  return withProgramPath(l.argv);
}

/** Which launchers exist here (the shell is always there). */
export async function installedLaunchers(): Promise<LaunchOption[]> {
  const names = LAUNCHERS.filter((l) => l.argv.length).map((l) => l.argv[0]!);
  const found = await findPrograms(names);
  programPaths.clear();
  for (const [k, v] of found) programPaths.set(k, v);
  return LAUNCHERS.filter((l) => !l.argv.length || found.has(l.argv[0]!)).map(({ argv: _argv, ...o }) => o);
}

/** `~`-expanded absolute folder that exists, or an error message. */
export function checkFolder(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("请选一个文件夹");
  let p = raw.trim();
  if (p === "~" || p.startsWith("~/") || (IS_WINDOWS && p.startsWith("~\\"))) p = homedir() + p.slice(1);
  if (!isAbsolute(p)) throw new Error("文件夹要写完整路径，比如 ~/work_file/项目");
  p = resolve(p);
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`这台电脑上没有这个文件夹：${raw}`);
  return p;
}

export interface AppLs {
  spaces: Array<{
    id: string;
    name: string;
    folder?: string;
    machine?: string | null;
    active?: boolean;
    tabs?: Array<{
      id?: string;
      name?: string;
      active?: boolean;
      settled?: boolean;
      terminals?: Array<{ terminal?: string; pane?: string; status?: string | null; app?: string | null; name?: string | null }>;
    }>;
  }>;
}

/**
 * The desktop herdr app is not installed on this computer: herdr-core alone, as on Windows
 * (where herdr has no desktop app) or a server. Terminals are then started with `hc run`.
 */
export class NoDesktopApp extends Error {
  constructor() {
    super("这台电脑上没有桌面 herdr");
  }
}

const notInstalled = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** The desktop herdr app (`herdr-app`), driven through its own commands. */
export class HerdrApp {
  private bin: string;

  constructor(bin = process.env.HERDR_APP_BIN ?? "herdr-app") {
    this.bin = bin;
  }

  /** The window's spaces, tabs and terminals; throws when the window is not open. */
  async ls(): Promise<AppLs> {
    const out = await run(this.bin, ["ls"], { timeoutMs: 8000 }).catch((e: unknown) => {
      throw notInstalled(e) ? new NoDesktopApp() : e;
    });
    const ls = JSON.parse(out) as AppLs;
    if (!Array.isArray(ls?.spaces)) throw new Error("herdr-app ls: no spaces");
    return ls;
  }

  /** Space and tab names by id as the window shows them; throws when the window is not open. */
  async names(): Promise<AppNames> {
    const names: AppNames = { spaces: new Map(), tabs: new Map() };
    for (const s of (await this.ls()).spaces) {
      if (s.id && s.name) names.spaces.set(s.id, s.name);
      for (const t of s.tabs ?? []) if (t.id && t.name) names.tabs.set(t.id, t.name);
    }
    return names;
  }

  /** Spaces of this computer in the open window; throws when the window is not open. */
  async spaces(): Promise<SpaceInfo[]> {
    const ls = await this.ls();
    return ls.spaces
      .filter((s) => !s.machine)
      .map((s) => ({
        id: s.id,
        name: s.name,
        folder: s.folder,
        tabs: s.tabs?.length ?? 0,
        terminals: (s.tabs ?? []).reduce((n, t) => n + (t.terminals?.length ?? 0), 0),
      }));
  }

  /**
   * New space (`space` absent) or new tab in a space, with the chosen program
   * and its first message. Returns the new terminal address.
   */
  async create(o: { space?: string; spaceName?: string; tabName?: string; folder?: string; launcher: string; task?: string }): Promise<{
    space: string;
    tab: string;
    terminal: string;
  }> {
    const argv = launcherArgv(o.launcher);
    const task = o.task?.trim();
    return this.open({ ...o, argv, task: task && argv.length ? task : undefined });
  }

  /** New tab in `space`, or a new space, running `argv` (empty: a shell). Callers decide what may run. */
  async open(o: { space?: string; spaceName?: string; tabName?: string; folder?: string; argv: string[]; task?: string }): Promise<{
    space: string;
    tab: string;
    terminal: string;
  }> {
    const args: Record<string, unknown> = {};
    if (o.argv.length) args.argv = o.argv;
    if (o.task) args.task = o.task;
    if (o.folder) args.folder = o.folder;
    let cmd: string;
    if (o.space) {
      cmd = "tab.new";
      args.space = o.space;
      if (o.tabName?.trim()) args.name = o.tabName.trim();
    } else {
      cmd = "space.new";
      args.machine = ""; // this computer, not the focused space's machine
      if (o.spaceName?.trim()) args.name = o.spaceName.trim();
      if (o.tabName?.trim()) args.tab = o.tabName.trim();
    }
    const out = await doCommand(this.bin, cmd, args);
    const r = parseDoResult(out);
    if (!r.terminal) throw new Error(`桌面 herdr 没有返回新终端：${out.trim().slice(0, 200)}`);
    return r;
  }

  /** Runs one checked command (see `herdrCommandArgs`) and returns what the app answered. */
  async command(command: HerdrCommand, args: Record<string, unknown>): Promise<unknown> {
    return parseDo(await doCommand(this.bin, command, args));
  }
}

const ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/**
 * Checks a `herdr.command` request against `HERDR_COMMANDS` and turns it into
 * the app's own arguments. Only listed commands and arguments pass; a program
 * is named by launcher id (`installed`), never by a command line.
 */
export function herdrCommandArgs(command: unknown, raw: unknown, installed: string[]): { command: HerdrCommand; args: Record<string, unknown> } {
  if (typeof command !== "string" || !Object.hasOwn(HERDR_COMMANDS, command)) throw new Error("不支持这个 herdr 命令");
  const cmd = command as HerdrCommand;
  const allowed: readonly string[] = HERDR_COMMANDS[cmd].args;
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    if (!allowed.includes(k)) throw new Error(`${cmd} 不接受参数 ${k}`);
    switch (k) {
      case "id":
      case "pane":
      case "terminal":
        if (typeof v !== "string" || !ID.test(v)) throw new Error(`${k} 要填 id`);
        out[k] = v;
        break;
      case "name":
        if (typeof v !== "string" || v.length > 60) throw new Error("名字要在 60 个字以内");
        out.name = v.trim();
        break;
      case "index": {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error("index 要是从 1 开始的整数");
        out.index = n;
        break;
      }
      case "direction":
        if (v !== "right" && v !== "down") throw new Error("direction 只能是 right 或 down");
        out.direction = v;
        break;
      case "place":
        if (v !== "tab" && v !== "right" && v !== "down") throw new Error("place 只能是 tab、right 或 down");
        out.place = v;
        break;
      case "pinned":
        if (typeof v !== "boolean") throw new Error("pinned 要是 true 或 false");
        out.pinned = v;
        break;
      case "launcher": {
        const l = LAUNCHERS.find((x) => x.id === v);
        if (!l || !installed.includes(l.id)) throw new Error("这台电脑上没有这个程序");
        if (l.argv.length) out.argv = l.argv;
        break;
      }
    }
  }
  const optional = cmd === "pane.split" ? ["launcher"] : cmd === "terminal.keep" ? ["place"] : cmd === "pane.focus" ? ["pane", "terminal"] : [];
  for (const k of allowed) if (!optional.includes(k) && !(k in out)) throw new Error(`${cmd} 需要参数 ${k}`);
  if (cmd === "pane.focus" && !("pane" in out) && !("terminal" in out)) throw new Error("pane.focus 需要 pane 或 terminal");
  // The person already confirmed on the phone: no second question on the desktop.
  if (cmd === "space.close" || cmd === "tab.close") out.confirmed = true;
  return { command: cmd, args: out };
}

/** A resume command Uniflo gives is run only when it starts one of the known programs. */
export function resumeArgv(argv: unknown, installed: string[]): string[] {
  if (!Array.isArray(argv) || !argv.length || argv.length > 12 || !argv.every((a) => typeof a === "string" && a.length > 0 && a.length <= 300)) {
    throw new Error("这个会话没有可用的续跑命令");
  }
  const program = programName(base(argv[0] as string));
  const l = LAUNCHERS.find((x) => x.argv[0] === program);
  if (!l || !installed.includes(l.id)) throw new Error(`这台电脑上不能从手机启动 ${program}`);
  return [l.argv[0]!, ...(argv.slice(1) as string[])];
}

/** Runs `herdr-app do`; its answer (also an error) is JSON on stdout. */
function doCommand(bin: string, cmd: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, ["do", cmd, JSON.stringify(args)], { timeout: 20_000, encoding: "utf8", windowsHide: true }, (err, stdout, stderr) => {
      if (stdout.trim() || !err) return resolve(stdout);
      if (notInstalled(err)) return reject(new NoDesktopApp());
      const msg = String(stderr || err?.message || "").trim();
      reject(new Error(/no herdr window|no window|not running/i.test(msg) ? "桌面 herdr 没有打开，先在电脑上打开它" : `桌面 herdr：${msg.slice(0, 200)}`));
    });
  });
}

/** `herdr-app do` prints the command's JSON result (possibly after other lines). */
export function parseDoResult(out: string): { space: string; tab: string; terminal: string } {
  const lines = out.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const chunk = lines.slice(i).join("\n");
    try {
      const v = JSON.parse(chunk);
      if (v && typeof v.error === "string") throw new DoError(v.error);
      const r = v?.result ?? v;
      if (r && typeof r.terminal === "string") return { space: String(r.space ?? ""), tab: String(r.tab ?? ""), terminal: r.terminal };
    } catch (e) {
      if (e instanceof DoError) throw new Error(`桌面 herdr：${e.message}`);
      /* keep looking upward */
    }
  }
  throw new Error(`桌面 herdr 的回复看不懂：${out.trim().slice(0, 200)}`);
}

class DoError extends Error {}

/** Any command's answer: its JSON result (null when it printed nothing); an `error` answer throws. */
export function parseDo(out: string): unknown {
  const lines = out.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let v: unknown;
    try {
      v = JSON.parse(lines.slice(i).join("\n"));
    } catch {
      continue;
    }
    if (v && typeof v === "object") {
      const o = v as { error?: unknown; result?: unknown };
      if (typeof o.error === "string") throw new Error(`桌面 herdr：${o.error}`);
      if ("result" in o) return o.result;
    }
    return v;
  }
  return out.trim() ? out.trim().slice(0, 300) : null;
}
