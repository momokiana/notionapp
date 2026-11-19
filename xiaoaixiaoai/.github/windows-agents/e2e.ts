// CI on windows-latest: a Windows computer with herdr, as the phone sees it.
//
// The workflow installs herdr-core (hc). This script starts a relay on this machine,
// installs 小爱小爱 from the release bundle with scripts/install-host.ps1 (registered
// with a pair code, running as the hidden logon service), pairs a stand-in phone and
// drives agents through the relay with the same RPCs the app sends. The agent is
// fake-agent.mjs, also installed as `claude.cmd` so it can be started from the "phone";
// as `claude` it keeps a Claude Code transcript, which Uniflo (installed by the workflow)
// serves as the conversation the phone shows.
//
//   node --no-warnings .github/windows-agents/e2e.ts <xiaoaixiaoai-x.y.z.tar.gz>

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const WebSocket = createRequire(join(repo, "apps", "hostd", "package.json"))("ws");

const bundle = process.argv[2];
if (!bundle || !existsSync(bundle)) {
  console.error("usage: node e2e.ts <xiaoaixiaoai-x.y.z.tar.gz>");
  process.exit(2);
}

// Under the home folder: the runner's %TEMP% is an 8.3 short path (RUNNER~1).
const work = join(homedir(), "hp-e2e");
const project = join(work, "project");
rmSync(work, { recursive: true, force: true });
mkdirSync(project, { recursive: true });
const PORT = 7431;
const server = `http://127.0.0.1:${PORT}`;
const UNIFLO = "http://127.0.0.1:7311";
const admin = randomBytes(24).toString("hex");
const root = join(process.env.LOCALAPPDATA!, "Programs", "xiaoaixiaoai");
const fake = join(here, "fake-agent.mjs");
// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const ok = (what: string) => console.log(`ok - ${what}`);
function check(cond: unknown, what: string, detail = ""): void {
  if (!cond) throw new Error(`FAILED: ${what}${detail ? `\n${detail}` : ""}`);
  ok(what);
}

/** Polls `fn` until it gives something truthy; `detail` says what it saw when it never did. */
async function until<T>(what: string, fn: () => Promise<T>, o: { ms?: number; detail?: () => Promise<string> } = {}): Promise<NonNullable<T>> {
  const end = Date.now() + (o.ms ?? 30_000);
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) {
        ok(what);
        return v as NonNullable<T>;
      }
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) {
      const seen = o.detail ? await o.detail().catch((e) => String(e)) : "";
      throw new Error(`FAILED: ${what}${last ? `\nlast error: ${(last as Error).message}` : ""}${seen ? `\n--- saw:\n${seen}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

async function http(path: string, o: { token?: string; body?: unknown } = {}): Promise<any> {
  const res = await fetch(server + path, {
    method: o.body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${JSON.stringify(j)}`);
  return j;
}

function hc(...args: string[]) {
  return spawnSync("hc", args, { encoding: "utf8", windowsHide: true, timeout: 60_000 });
}

/** The installed CLI, run by its own Node (the .cmd shim is covered by windows-install-test.ps1). */
function hp(...args: string[]) {
  return spawnSync(join(root, "node", "node.exe"), ["--no-warnings", join(root, "current", "apps", "hostd", "src", "cli.ts"), ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 90_000,
    env: { ...process.env, XIAOAIXIAOAI_UPDATE_CHECK: "0" },
  });
}

const relayOut: string[] = [];
const relay = spawn(process.execPath, ["--no-warnings", join(repo, "apps", "relay", "src", "cli.ts"), "start"], {
  env: {
    ...process.env,
    POCKET_PORT: String(PORT),
    POCKET_HOST: "127.0.0.1",
    POCKET_DB: join(work, "relay.db"),
    POCKET_ADMIN_TOKEN: admin,
    XIAOAIXIAOAI_UPDATE_CHECK: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
relay.stdout!.on("data", (d) => relayOut.push(String(d)));
relay.stderr!.on("data", (d) => relayOut.push(String(d)));

let ws: any;
const started: string[] = [];
let uniflo: ChildProcess | undefined;
const unifloOut: string[] = [];
const getJson = async (url: string): Promise<any> => (await fetch(url)).json();

async function main(): Promise<void> {
  const v = hc("--version");
  check(v.status === 0, `herdr-core is installed (${(v.stdout || v.stderr).trim()})`, v.stderr);
  hc("server", "start");
  const st = hc("server", "status");
  check(st.status === 0, "the herdr-core server runs", st.stdout + st.stderr);

  await until("the relay listens", async () => relayOut.join("").includes("listening on"));

  // Uniflo first: the service looks for it when it starts.
  const uv = spawnSync("uniflo", ["--version"], { encoding: "utf8", windowsHide: true });
  check(uv.status === 0, `Uniflo is installed (${(uv.stdout || uv.stderr).trim()})`, uv.stderr);
  uniflo = spawn("uniflo", ["daemon", "--foreground", "--no-update-check", "--no-price-sync"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  uniflo.stdout!.on("data", (d) => unifloOut.push(String(d)));
  uniflo.stderr!.on("data", (d) => unifloOut.push(String(d)));
  await until("the Uniflo daemon answers", async () => (await getJson(`${UNIFLO}/v1/health`))?.ok === true);

  // An agent program the phone may start: found as %USERPROFILE%\.local\bin\claude.cmd.
  const bin = join(homedir(), ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude.cmd"), `@echo off\r\nset FAKE_CLAUDE=1\r\n"${process.execPath}" "${fake}" %*\r\n`);

  // The computer: installed and registered as a person would, with an invite code.
  const hostCode = (await http("/v1/pair/codes", { token: admin, body: { kind: "host" } })).code as string;
  const install = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(repo, "scripts", "install-host.ps1"), "-From", bundle!, "-Server", server, "-Code", hostCode, "-Name", "win-ci"],
    { stdio: "inherit", windowsHide: true, timeout: 300_000 },
  );
  check(install.status === 0, "install-host.ps1 installs, registers with the invite code and starts the service");

  // The phone.
  const viewerCode = (await http("/v1/pair/codes", { token: admin, body: { kind: "viewer" } })).code as string;
  const phone = await http("/v1/pair", { body: { code: viewerCode, name: "ci phone", kind: "viewer", platform: "android" } });
  const token = phone.token as string;
  const host = await until("the Windows computer is online on the relay", async () => (await http("/v1/devices", { token })).devices.find((d: any) => d.name === "win-ci" && d.online), {
    ms: 60_000,
  });
  check(host.platform === "win32", "it reports itself as Windows", JSON.stringify(host));

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/ws`, { headers: { Authorization: `Bearer ${token}` } });
  const pending = new Map<string, (f: any) => void>();
  let snapshot = false;
  ws.on("message", (data: Buffer) => {
    const f = JSON.parse(String(data));
    if (f.type === "snapshot") snapshot = true;
    if (f.type === "rpc_result") pending.get(f.id)?.(f);
  });
  await until("the phone connects", async () => snapshot);
  let n = 0;
  const rpc = (method: string, params: unknown = {}, timeoutMs = 60_000): Promise<any> =>
    new Promise((resolveCall, rejectCall) => {
      const id = `e2e${++n}`;
      const t = setTimeout(() => {
        pending.delete(id);
        rejectCall(new Error(`${method}: no answer in ${timeoutMs / 1000} s`));
      }, timeoutMs);
      pending.set(id, (f) => {
        clearTimeout(t);
        pending.delete(id);
        if (f.error) rejectCall(new Error(`${method}: ${f.error.code}: ${f.error.message}`));
        else resolveCall(f.result);
      });
      ws.send(JSON.stringify({ type: "rpc", id, to: host.id, method, params }));
    });
  const screen = async (agent: string): Promise<string> => (await rpc("terminal.read", { agent, lines: 120 })).text as string;
  const count = (text: string, s: string) => text.split(s).length - 1;

  const info = await rpc("host.info");
  check(info.platform === "win32" && info.sources.includes("hc"), "host.info: Windows, with herdr-core as a source", JSON.stringify(info));
  check(info.sources.includes("uniflo"), "host.info: Uniflo is a source too", JSON.stringify(info));

  // 1. An agent someone started at the computer.
  const run = hc("run", "--bg", "--no-parent", "--no-notify", "--json", "--name", "ci-manual", "--cwd", project, "--", process.execPath, fake);
  check(run.status === 0, "hc run starts a program", run.stdout + run.stderr);
  const manual = JSON.parse(run.stdout.trim().split("\n").pop()!).address as string;
  started.push(manual);
  const key = await until(
    "the phone sees it in the agent list",
    async () => ((await rpc("agents.list", { includeShells: true })).agents as any[]).find((a) => a.localId === manual)?.key as string | undefined,
    { detail: async () => JSON.stringify((await rpc("agents.list", { includeShells: true })).agents.map((a: any) => [a.key, a.harness, a.status])) },
  );
  await until("terminal.read shows its screen", async () => (await screen(key)).includes("fake agent ready, in: project"), { detail: () => screen(key) });

  await rpc("terminal.send", { agent: key, text: "hello from the phone" });
  await until("terminal.send types a line into it", async () => (await screen(key)).includes("got: hello from the phone"), { detail: () => screen(key) });

  const escBefore = count(await screen(key), "got key: esc");
  await rpc("terminal.keys", { agent: key, keys: ["esc"] });
  await until("terminal.keys presses Esc", async () => count(await screen(key), "got key: esc") > escBefore, { detail: () => screen(key) });

  const put = await rpc("terminal.put", { agent: key, files: [{ name: "ci shot.png", mime: "image/png", data: PNG }] });
  const landed = put.paths?.[0] as string | undefined;
  check(landed && /^[A-Za-z]:\\/.test(landed) && existsSync(landed) && readFileSync(landed).equals(Buffer.from(PNG, "base64")), "terminal.put lands the picture on this computer", JSON.stringify(put));

  const intr = await rpc("terminal.interrupt", { agent: key }, 30_000);
  check(intr.ok === true, "terminal.interrupt answers", JSON.stringify(intr));

  // 2. Agents started from the phone: herdr on Windows has no desktop app, so `hc run`.
  const spaces = await rpc("spaces.list");
  const ids = (spaces.launchers as any[]).map((l) => l.id);
  check(spaces.canCreate === true && ids.includes("claude") && ids.includes("shell"), "spaces.list: agents can be started here; claude.cmd is found", JSON.stringify(spaces));

  const made = await rpc("agent.create", { launcher: "claude", folder: project, task: "first task from the phone" }, 120_000);
  started.push(made.terminal);
  check(made.task === "typed", "agent.create starts claude.cmd in the chosen folder and types the first task", JSON.stringify(made));
  await until(
    "the new agent runs in that folder and got the task",
    async () => {
      const s = await screen(made.agent);
      return s.includes("fake agent ready, in: project") && s.includes("got: first task from the phone");
    },
    { detail: () => screen(made.agent) },
  );

  const sh = await rpc("agent.create", { launcher: "shell", folder: project }, 60_000);
  started.push(sh.terminal);
  await until("the new shell shows a prompt", async () => (await screen(sh.agent)).includes(">"), { detail: () => screen(sh.agent) });
  await rpc("terminal.send", { agent: sh.agent, text: "echo hp-shell-ok" });
  await until("a shell started from the phone runs commands", async () => /^\s*hp-shell-ok\s*$/m.test(await screen(sh.agent)), { detail: () => screen(sh.agent) });

  // What herdr-core reports here and what the phone makes of it (for reading a failure below).
  // The terminal list as the service reads it (`hc connect`, terminal.list), not `hc ls`.
  const listed = spawnSync("hc", ["connect"], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "terminal.list", params: {} })}\n`,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  for (const line of (listed.stdout || "").split("\n")) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    for (const t of m.id === 1 ? (m.result?.terminals ?? []) : []) {
      if (started.includes(t.address)) console.log(`# hc ${t.address}: ${JSON.stringify({ argv: t.argv, foreground: t.foreground, status: t.status })}`);
    }
  }
  const agentList = async () => (await rpc("agents.list", { includeShells: true })).agents as any[];
  for (const a of await agentList()) console.log(`# agent ${a.localId}: harness=${a.harness} isShell=${a.isShell} cwd=${a.cwd} session=${a.sessionKey ?? "-"}`);

  // 3. Its conversation, as the phone's chat view reads it.
  const sessionKey = await until("the phone finds the new agent's conversation (Uniflo)", async () => (await agentList()).find((a) => a.key === made.agent)?.sessionKey as string | undefined, {
    ms: 90_000,
    detail: async () => {
      const a = (await agentList()).find((x) => x.key === made.agent);
      const sessions = ((await getJson(`${UNIFLO}/v1/sessions?limit=10`)) as any[]).map((x) => ({ key: x.key, harness: x.harness, cwd: x.cwd }));
      return JSON.stringify({ agent: a && { harness: a.harness, cwd: a.cwd, isShell: a.isShell }, sessions }, null, 1);
    },
  });
  const conversation = async () => {
    const r = await rpc("session.events", { agent: made.agent, limit: 40 });
    return { key: r.sessionKey as string | null, text: JSON.stringify(r.events) };
  };
  const conv = await conversation();
  check(conv.key === sessionKey && conv.text.includes("done: first task from the phone"), "session.events shows the first task and the reply", conv.text.slice(0, 1500));
  await rpc("terminal.send", { agent: made.agent, text: "second message" });
  await until("a message sent from the phone shows up in the conversation", async () => (await conversation()).text.includes("done: second message"), {
    ms: 60_000,
    detail: async () => (await conversation()).text.slice(0, 1500),
  });

  // 4. The computer's own CLI, through the service's named pipe and the relay.
  const list = hp("agents", "--all");
  check(list.status === 0 && list.stdout.includes(manual) && list.stdout.includes(made.terminal), "xiaoaixiaoai agents (on the computer) lists them", list.stdout + list.stderr);
  // Its own agents are read with hc; xiaoaixiaoai read is for other computers' agents.
  const read = hp("read", `win-ci/${manual}`);
  check(read.status !== 0 && /that is this computer/.test(read.stdout + read.stderr), "xiaoaixiaoai read points to hc for this computer's own agents", read.stdout + read.stderr);

  // 5. Ending one from the phone.
  await rpc("terminal.kill", { agent: made.agent }, 30_000);
  await until("terminal.kill ends it", async () => {
    const r = hc("ls", "--json");
    const live = JSON.parse(r.stdout || "[]");
    return !(Array.isArray(live) ? live : (live.terminals ?? [])).some((t: any) => t.address === made.terminal);
  });
}

let code = 0;
try {
  await main();
  console.log("\nall Windows agent checks passed");
} catch (e) {
  code = 1;
  console.error(`\n${(e as Error).message}`);
  const log = join(process.env.LOCALAPPDATA!, "xiaoaixiaoai", "hostd.log");
  if (existsSync(log)) console.error(`\n--- ${log}\n${readFileSync(log, "utf8").split("\n").slice(-80).join("\n")}`);
  console.error(`\n--- relay\n${relayOut.join("").split("\n").slice(-60).join("\n")}`);
  if (unifloOut.length) console.error(`\n--- uniflo\n${unifloOut.join("").split("\n").slice(-30).join("\n")}`);
} finally {
  ws?.close();
  for (const t of started) hc("kill", t);
  hp("service", "remove");
  relay.kill();
  uniflo?.kill();
}
process.exit(code);
