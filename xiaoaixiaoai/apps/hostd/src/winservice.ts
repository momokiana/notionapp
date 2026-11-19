// The Windows background service. Windows has no launchd or systemd --user, so:
//
//   HKCU\...\Run "XiaoAiXiaoAi"  ->  wscript <root>\bin\hostd-start.js   (at logon, no window)
//     -> xiaoaixiaoai service run   a small supervisor, listening on its own named pipe
//       -> xiaoaixiaoai run         the daemon; started again whenever it exits
//
// It runs in the person's own session (agents keep their credentials) and needs no admin
// rights. wscript is used only because it starts a console program without a window:
// a Run entry or a scheduled task pointing straight at node.exe opens a console window.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROL_SOCKET, SERVICE_SOCKET } from "./config.ts";
import { IS_WINDOWS, stateDir } from "./platform.ts";
import { lineSplitter } from "./util.ts";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "XiaoAiXiaoAi";
export const SERVICE_LOG = join(stateDir(), "hostd.log");
const LOG_MAX = 10 * 1024 * 1024;

export const SERVICE_HELP = `  service install [--read-only] [--allow <deviceId,...>] [--runtime-only --runtime-config <path>] [--relay-proxy <url>]
        Windows: start xiaoaixiaoai hidden at logon and keep it running (no admin needed).
  service start | stop | restart | status | remove`;

/** The install this code runs from (scripts/install-host.ps1 layout), if any. */
export function installRoot(appRoot = fileURLToPath(new URL("../../..", import.meta.url))): string | undefined {
  return /^(.+?)[\\/]+releases[\\/]+[^\\/]+[\\/]*$/.exec(appRoot)?.[1];
}

/** The CLI the service should run: the install's `current` copy, so updates take effect on restart. */
function currentCli(): string {
  const root = installRoot();
  const cli = root && join(root, "current", "apps", "hostd", "src", "cli.ts");
  return cli && existsSync(cli) ? cli : process.argv[1]!;
}

const launcherPath = (root: string) => join(root, "bin", "hostd-start.js");

/**
 * The logon launcher: JScript run by wscript, saved as UTF-16 so paths with any
 * characters survive. `args` are passed on to `xiaoaixiaoai run`.
 */
export function launcherScript(node: string, cli: string, args: string[]): string {
  const q = (s: string) => `"${s.replace(/"/g, "")}"`;
  const command = [q(node), "--no-warnings", q(cli), "service", "run", ...args.map(q)].join(" ");
  return [
    "// Written by `xiaoaixiaoai service install`: starts 小爱小爱 at logon without a window.",
    "// Remove with `xiaoaixiaoai service remove`.",
    'var shell = new ActiveXObject("WScript.Shell");',
    'shell.CurrentDirectory = shell.ExpandEnvironmentStrings("%USERPROFILE%");',
    `shell.Run(${JSON.stringify(command)}, 0, false);`,
    "",
  ].join("\r\n");
}

function wscript(): string {
  return join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
}

/** The Run entry's command line for a launcher. */
export function runEntry(launcher: string): string {
  return `"${wscript()}" //B //Nologo //E:JScript "${launcher}"`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function serviceCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (!IS_WINDOWS && sub !== "run") {
    fail("`xiaoaixiaoai service` is for Windows. On macOS and Linux, scripts/install-host.sh sets up launchd or systemd --user.");
  }
  switch (sub) {
    case "run":
      return supervise(rest);
    case "install":
      return install(rest);
    case "start":
      return start();
    case "stop":
      return stop();
    case "restart":
      return restart();
    case "status":
      return status();
    case "remove":
      return remove();
    default:
      fail(`usage:\n${SERVICE_HELP}`);
  }
}

async function install(args: string[]): Promise<void> {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--allow" || args[i] === "--runtime-config" || args[i] === "--relay-proxy") && args[i + 1]) i++;
    else if (args[i] !== "--read-only" && args[i] !== "--runtime-only") fail(`unknown option for service install: ${args[i]}`);
  }
  const root = installRoot();
  if (!root) fail("this copy was not installed by scripts/install-host.ps1; run that first (docs/deploy/host.md).");
  const launcher = launcherPath(root);
  mkdirSync(dirname(launcher), { recursive: true });
  const cli = join(root, "current", "apps", "hostd", "src", "cli.ts");
  writeFileSync(launcher, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(launcherScript(process.execPath, cli, args), "utf16le")]));
  const r = spawnSync("reg", ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", runEntry(launcher), "/f"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) fail(`could not add the logon entry: ${(r.stderr || r.error?.message || "").trim()}`);
  console.log("✓ xiaoaixiaoai starts at logon (no window)");
  await restart();
}

async function remove(): Promise<void> {
  await stop();
  spawnSync("reg", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"], { windowsHide: true });
  const root = installRoot();
  if (root) rmSync(launcherPath(root), { force: true });
  console.log("✓ removed: xiaoaixiaoai no longer starts at logon");
}

async function start(): Promise<void> {
  if (await ask({ op: "status" }).catch(() => null)) return void console.log("xiaoaixiaoai service is already running");
  const root = installRoot();
  const launcher = root && launcherPath(root);
  if (!launcher || !existsSync(launcher)) fail("the service is not installed: run `xiaoaixiaoai service install`");
  launch(launcher);
  const up = await waitFor(async () => !!(await ask({ op: "status" }).catch(() => null)), 10_000);
  console.log(up ? `✓ xiaoaixiaoai service started · log ${SERVICE_LOG}` : `the service did not answer yet; see ${SERVICE_LOG}`);
}

async function stop(): Promise<void> {
  const r = await ask({ op: "stop" }).catch(() => null);
  if (!r) return void console.log("xiaoaixiaoai service is not running");
  await waitFor(async () => !(await ask({ op: "status" }).catch(() => null)), 15_000);
  console.log("✓ xiaoaixiaoai service stopped");
}

/** Restart the running service on the install's current copy, or start it. */
async function restart(): Promise<void> {
  const r = await ask({ op: "restart" }).catch(() => null);
  if (!r) return start();
  // The old supervisor stops the daemon, closes its pipe and starts the launcher again.
  const back = await waitFor(async () => {
    const s = await ask({ op: "status" }).catch(() => null);
    return !!s && s.pid !== r.pid;
  }, 30_000);
  console.log(back ? `✓ xiaoaixiaoai service restarted · log ${SERVICE_LOG}` : `the service did not come back yet; see ${SERVICE_LOG}`);
  if (!back) process.exitCode = 1;
}

async function status(): Promise<void> {
  const root = installRoot();
  const registered = spawnSync("reg", ["query", RUN_KEY, "/v", RUN_VALUE], { windowsHide: true }).status === 0;
  console.log(`logon    ${registered && root && existsSync(launcherPath(root)) ? "starts at logon" : "not set up (xiaoaixiaoai service install)"}`);
  const s = await ask({ op: "status" }).catch(() => null);
  if (!s) return void console.log("service  not running");
  console.log(`service  running (pid ${s.pid}) · daemon ${s.child ? `pid ${s.child}` : "restarting"} · ${s.restarts} restarts`);
  console.log(`log      ${SERVICE_LOG}`);
}

function launch(launcher: string): void {
  spawn(wscript(), ["//B", "//Nologo", "//E:JScript", launcher], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

async function supervise(daemonArgs: string[]): Promise<void> {
  const log = (line: string) => writeLog(`[service] ${line}`);
  const server = await listenOnce(SERVICE_SOCKET);
  if (!server) return; // another supervisor runs
  let child: ChildProcess | null = null;
  let stopping = false;
  let restarts = 0;
  let timer: NodeJS.Timeout | null = null;
  let delay = 2_000;
  const since = Date.now();

  const startDaemon = () => {
    timer = null;
    const began = Date.now();
    const c = spawn(process.execPath, ["--no-warnings", currentCli(), "run", ...daemonArgs], {
      cwd: homedir(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, XIAOAIXIAOAI_SERVICE: "1" },
    });
    child = c;
    c.stdout!.on("data", lineSplitter(writeLog));
    c.stderr!.on("data", lineSplitter(writeLog));
    c.on("error", (e) => log(`could not start xiaoaixiaoai: ${e.message}`));
    c.on("exit", (code, signal) => {
      if (child === c) child = null;
      if (stopping) return;
      // Quick exits (not set up, already running in a terminal) back off up to a minute.
      delay = Date.now() - began < 30_000 ? Math.min(delay * 2, 60_000) : 2_000;
      restarts++;
      log(`xiaoaixiaoai exited (${signal ?? `code ${code}`}); starting it again in ${Math.round(delay / 1000)} s`);
      timer = setTimeout(startDaemon, delay);
    });
  };

  const stopDaemon = async () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    const c = child;
    if (!c || c.exitCode !== null) return;
    const gone = new Promise<void>((resolve) => c.once("exit", () => resolve()));
    // Ask first, so the relay hears a clean goodbye; then end it.
    await control(CONTROL_SOCKET, { op: "exit" }, 3_000).catch(() => null);
    const t = setTimeout(() => c.kill(), 5_000);
    await gone;
    clearTimeout(t);
  };

  server.on("connection", (sock) => {
    sock.on("error", () => {});
    sock.on(
      "data",
      lineSplitter(async (line) => {
        let req: { op?: string };
        try {
          req = JSON.parse(line);
        } catch {
          return;
        }
        if (req.op === "status") {
          sock.end(`${JSON.stringify({ ok: true, pid: process.pid, child: child?.pid ?? null, restarts, since })}\n`);
        } else if (req.op === "stop" || req.op === "restart") {
          sock.end(`${JSON.stringify({ ok: true, pid: process.pid })}\n`);
          log(req.op === "stop" ? "stopping" : "restarting on the current version");
          await stopDaemon();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          if (req.op === "restart") {
            const root = installRoot();
            const launcher = root && launcherPath(root);
            if (launcher && existsSync(launcher)) launch(launcher);
            else spawn(process.execPath, ["--no-warnings", currentCli(), "service", "run", ...daemonArgs], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
          }
          process.exit(0);
        } else sock.end(`${JSON.stringify({ ok: false, error: "unknown op" })}\n`);
      }),
    );
  });

  log(`started (pid ${process.pid})`);
  startDaemon();
  await new Promise(() => {}); // runs until stop/restart
}

/** Listen on the pipe; undefined when another live supervisor holds it. */
async function listenOnce(address: string): Promise<Server | undefined> {
  for (let i = 0; i < 20; i++) {
    const server = createServer();
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      server.once("error", resolve);
      server.listen(address, () => resolve(null));
    });
    if (!err) return server;
    if (err.code !== "EADDRINUSE") throw err;
    if (await control(address, { op: "status" }, 3_000).catch(() => null)) return undefined;
    if (!IS_WINDOWS) rmSync(address, { force: true }); // a socket file left by a crash
    // The previous supervisor is still closing its pipe.
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`could not listen on ${address}`);
}

function writeLog(line: string): void {
  try {
    mkdirSync(dirname(SERVICE_LOG), { recursive: true });
    if (existsSync(SERVICE_LOG) && statSync(SERVICE_LOG).size > LOG_MAX) renameSync(SERVICE_LOG, `${SERVICE_LOG}.1`);
    appendFileSync(SERVICE_LOG, `${stamp()} ${line}\n`);
  } catch {
    /* a full disk must not stop the service */
  }
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------

/** One request on a control pipe or socket, one JSON line back. */
export function control(address: string, req: unknown, timeoutMs = 40_000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!IS_WINDOWS && !existsSync(address)) return reject(new Error("no daemon"));
    const sock = connect(address);
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error("daemon timeout"));
    }, timeoutMs);
    sock.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    sock.on(
      "data",
      lineSplitter((line) => {
        clearTimeout(t);
        try {
          resolve(JSON.parse(line));
        } catch (e) {
          reject(e);
        }
        sock.end();
      }),
    );
    sock.write(`${JSON.stringify(req)}\n`);
  });
}

const ask = (req: unknown) => control(SERVICE_SOCKET, req, 10_000);

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
