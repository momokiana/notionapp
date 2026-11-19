#!/usr/bin/env node
import { createServer } from "node:net";
import { existsSync, rmSync } from "node:fs";
import { hostname, platform } from "node:os";
import { parseArgs } from "node:util";
import { WebSocket } from "ws";
import { createInterface } from "node:readline/promises";
import QRCode from "qrcode";
import { parsePairInput, parsePairLink } from "@xiaoaixiaoai/protocol";
import type { Agent, Device, JoinClaim, JoinTicket, LogEntry, PairCode, PairResponse, RpcMethod, ServerFrame } from "@xiaoaixiaoai/protocol";
import { CONFIG_PATH, CONTROL_SOCKET, loadConfig, saveConfig, type HostConfig } from "./config.ts";
import { Host, HOSTD_VERSION } from "./host.ts";
import { loadRuntimeSessions } from "./runtime-sessions.ts";
import { localRelayProxy } from "./relay-proxy.ts";
import { IS_WINDOWS } from "./platform.ts";
import { lineSplitter } from "./util.ts";
import { SERVICE_HELP, control as controlAt, serviceCommand } from "./winservice.ts";
import { updateCommand, updateHelpText, versionCommand, watchForUpdates } from "@xiaoaixiaoai/update";

const HELP = `xiaoaixiaoai ${HOSTD_VERSION} — put this computer's herdr agents in your pocket

Setup
  up [<invite link>] [--server <url>] [--code <CODE>] [--name <name>]
        One step: register this computer, then keep it online. With an invite link
        (https://<server>/p/<CODE>) or --server + --code it registers directly;
        with only --server it shows a QR for an already connected phone to scan and
        approve. On a new relay, use the setup code the relay printed at startup.
        Later, plain \`up\` is enough.
  login [<invite link>] [--server <url>] [--code <CODE>] [--name <name>]
        Register only (same options). POCKET_ADMIN_TOKEN, when set, also registers directly.
  run [--read-only] [--allow <deviceId,...>] [--runtime-config <absolute-path>] [--runtime-only]
      [--relay-proxy http://127.0.0.1:<port>]
        Keep this computer online. Opt in to explicitly selected DSH/Codex/Antigravity sessions using a private local config.
        With --runtime-only, do not read or expose Herdr terminals or Uniflo history.
        --relay-proxy explicitly uses a trusted local HTTP CONNECT proxy for an HTTPS relay (Node 24.5+).
  pair  (alias: invite)
        Show a one-time QR + code that adds a phone (scan it) or another computer.
  status    Show login and connection state.
${SERVICE_HELP}

Updates
${updateHelpText()}

Look and talk (works with any computer on the relay)
  devices                     List paired devices.
  agents [--all]              List agents on every online computer (--all: include shells).
  read <device>/<agent> [--lines N]
  send <device>/<agent> <text...>
  keys <device>/<agent> <key...>     e.g. enter, esc, up, ctrl+c, y

<device> is a device name or id; <agent> is a local id such as t42.

Logs (what the relay, the computers and the phones recorded)
  logs [--since 1h] [--device <name|id>] [--kind <kind>] [--level warn|error]
       [--source relay|host|viewer] [--text <words>] [--limit N] [--follow] [--json]
        kinds: assistant (turns, tools), action, rpc, guard, live, wake, model,
        device, settings, or what a computer/phone reported (hostd, rpc, link, js, ...).
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "login":
      return login(rest);
    case "up":
      return up(rest);
    case "invite":
      return pair(rest);
    case "run":
      return runDaemon(rest);
    case "pair":
      return pair(rest);
    case "status":
      return status();
    case "service":
      return serviceCommand(rest);
    case "devices":
      return devices();
    case "agents":
      return agents(rest);
    case "read":
    case "send":
    case "keys":
      return talk(cmd, rest);
    case "logs":
      return logs(rest);
    case "version":
      return versionCommand(rest, { service: "host", bin: "xiaoaixiaoai" });
    case "update":
      return updateCommand(rest, { service: "host", bin: "xiaoaixiaoai" });
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return;
    case "-V":
    case "--version":
      console.log(HOSTD_VERSION);
      return;
    default:
      fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** An invite link (https://<server>/p/<CODE>, or the app's herdrpocket:// form) given as an argument or as --code. */
function inviteFrom(positional: string | undefined, code: string | undefined): { server: string; code: string } | undefined {
  const text = positional ?? (code && code.includes("://") ? code : undefined);
  if (!text) return undefined;
  const link = parsePairLink(text);
  if (!link) fail(`not an invite link: ${text}\nIt looks like https://xiaoaixiaoai.example.com/p/MEOW-4821.`);
  return link;
}

const LOGIN_OPTIONS = { server: { type: "string" }, code: { type: "string" }, name: { type: "string" } } as const;

async function login(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: LOGIN_OPTIONS });
  const invite = inviteFrom(positionals[0], values.code);
  // Logging in again on the same relay hands over the old token, so the relay replaces
  // this computer's registration instead of adding a second one.
  const previous = loadConfig();
  const server = normalizeServer(values.server) ?? normalizeServer(invite?.server) ?? previous?.server;
  if (!server) fail("--server <your relay address> is required the first time, e.g. --server xiaoaixiaoai.example.com");
  const name = values.name ?? hostname().replace(/\.local$/, "");
  const prevToken = previous?.server === server ? previous.token : undefined;
  let code = invite?.code ?? values.code;
  const admin = process.env.POCKET_ADMIN_TOKEN;
  if (!code && admin) {
    code = (await http<PairCode>(server, "/v1/pair/codes", { token: admin, body: { kind: "host", ttlSec: 120 } })).code;
  }
  // A relay with no devices has nobody to approve a scan: the first device uses its setup code.
  if (!code && (await deviceCount(server)) === 0) code = await askSetupCode(server);
  const r = code
    ? await http<PairResponse>(server, "/v1/pair", { token: prevToken, body: { code, name, kind: "host", platform: platform() } })
    : await joinByScan(server, name, prevToken);
  const cfg: HostConfig = { server, token: r.token, deviceId: r.device.id, name: r.device.name };
  saveConfig(cfg);
  // Fallback for a relay that predates takeover on re-pairing.
  if (previous && previous.server === server && previous.deviceId && previous.deviceId !== cfg.deviceId) {
    await http(server, `/v1/devices/${encodeURIComponent(previous.deviceId)}`, { token: cfg.token, method: "DELETE" }).catch(() => undefined);
  }
  console.log(`✓ "${cfg.name}" is registered (${cfg.deviceId}). Token saved to ${CONFIG_PATH}`);
  if (process.argv[2] !== "up") console.log("  Next: `xiaoaixiaoai run` to bring it online, `xiaoaixiaoai pair` to invite a phone or another computer.");
}

/** Accepts "xiaoaixiaoai.example.com" as well as a full URL. */
function normalizeServer(input: string | undefined): string | undefined {
  const s = input?.trim().replace(/\/+$/, "");
  if (!s) return undefined;
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

/** Devices on the relay; null when it cannot be asked. */
async function deviceCount(server: string): Promise<number | null> {
  try {
    return (await http<{ devices?: number }>(server, "/v1/health", {})).devices ?? null;
  } catch {
    return null;
  }
}

/** The relay is brand new: ask for the one-time setup code it printed at startup. */
async function askSetupCode(server: string): Promise<string> {
  const hint = [
    "This relay has no devices yet, so there is no phone to approve this computer.",
    "Use the one-time setup code the relay printed when it started",
    "(on the relay machine, `node apps/relay/src/bootstrap.ts` shows it again).",
  ].join("\n");
  if (!process.stdin.isTTY) fail(`${hint}\n\n  xiaoaixiaoai up --server ${server} --code <CODE>`);
  console.log(`\n${hint}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question("  Setup code (or the setup link): ")).trim();
      if (!answer) fail("no code given.");
      const parsed = parsePairInput(answer);
      if (parsed) return parsed.code;
      console.log("  That does not look like a code. It looks like MEOW-482193.");
    }
  } finally {
    rl.close();
  }
}

/** Short links make small QR codes with big, easy-to-scan squares. */
function terminalQr(text: string): Promise<string> {
  return QRCode.toString(text, { type: "terminal", small: true, errorCorrectionLevel: "L" });
}

/** Ask the relay to let this computer in; a phone that is already connected scans the QR and approves. */
async function joinByScan(server: string, name: string, prevToken?: string): Promise<PairResponse> {
  const t = await http<JoinTicket>(server, "/v1/join", { token: prevToken, body: { name, kind: "host", platform: platform() } });
  console.log(`\n  Scan this with a phone that is already connected: the 小爱小爱 app`);
  console.log(`  (设备 → 扫一扫) or the camera. Then tap 允许加入 to let "${name}" in.\n`);
  console.log(await terminalQr(t.link));
  console.log(`  ${t.link}`);
  console.log(`  Waiting for approval… (expires in ${Math.round((t.expiresAt - Date.now()) / 60000)} min, Ctrl+C to cancel)\n`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    let c: JoinClaim;
    try {
      c = await http<JoinClaim>(server, `/v1/join/${t.id}/claim`, { body: { secret: t.secret } });
    } catch (e) {
      // 404: expired or already collected. Anything else (network blip): keep waiting.
      if (Date.now() > t.expiresAt || /过期/.test((e as Error).message)) fail("the request expired before anyone approved it. Run the command again.");
      continue;
    }
    if (c.status === "denied") fail("the request was declined on the phone.");
    if (c.status === "approved") return { device: c.device, token: c.token };
  }
}

async function up(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ...LOGIN_OPTIONS, "read-only": { type: "boolean", default: false }, allow: { type: "string" } },
  });
  const cfg = loadConfig();
  const invite = inviteFrom(positionals[0], values.code);
  const server = normalizeServer(values.server) ?? normalizeServer(invite?.server);
  if (!cfg || (server && server !== cfg.server)) {
    await login([
      ...(positionals[0] ? [positionals[0]] : []),
      ...(values.server ? ["--server", values.server] : []),
      ...(values.name ? ["--name", values.name] : []),
      ...(values.code ? ["--code", values.code] : []),
    ]);
  } else if (values.code || invite) {
    console.log(`Already registered as "${cfg.name}" on ${cfg.server}; the invite was not used. \`xiaoaixiaoai login <link>\` registers again.`);
  }
  return runDaemon([...(values["read-only"] ? ["--read-only"] : []), ...(values.allow ? ["--allow", values.allow] : [])]);
}

async function pair(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { kind: { type: "string" } } });
  const cfg = needConfig();
  // One invite works for a phone or a computer unless a kind is forced.
  const kind = values.kind === "host" || values.kind === "viewer" ? values.kind : undefined;
  const r = await http<PairCode>(cfg.server, "/v1/pair/codes", { token: cfg.token, body: { kind } });
  const mins = Math.round((r.expiresAt - Date.now()) / 60000);
  console.log(`\n  Invite code:  ${r.code}    (one use, expires in ${mins} min)\n`);
  if (kind !== "host") {
    console.log(await terminalQr(r.link));
    console.log(`  Phone: scan it with the camera or the 小爱小爱 app, or open the link on the phone:`);
    console.log(`  ${r.link}\n`);
  }
  if (kind !== "viewer") console.log(`  Computer:  xiaoaixiaoai up ${r.link}\n`);
}

async function status(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) {
    console.log("not set up. Run `xiaoaixiaoai up --server <url>`.");
    return;
  }
  console.log(`device   ${cfg.name} (${cfg.deviceId})\nserver   ${cfg.server}`);
  try {
    const h = await http<{ version: string; online: number; devices: number }>(cfg.server, "/v1/health", {});
    console.log(`relay    ok · v${h.version} · ${h.online}/${h.devices} devices online`);
  } catch (e) {
    console.log(`relay    unreachable: ${(e as Error).message}`);
  }
  const daemon = await control({ op: "state" }).catch(() => null);
  console.log(`daemon   ${daemon ? (daemon.connected ? "running, connected" : "running, reconnecting") : "not running"}`);
  if (daemon) console.log(`sources  ${daemon.sources.join(", ") || "none"} · ${daemon.local} local agents`);
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

async function runDaemon(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { "read-only": { type: "boolean", default: false }, allow: { type: "string" }, "runtime-config": { type: "string" }, "runtime-only": { type: "boolean", default: false }, "relay-proxy": { type: "string" } },
  });
  if (values["runtime-only"] && !values["runtime-config"]) fail("--runtime-only requires --runtime-config");
  const cfg = needConfig();
  const host = new Host({
    config: cfg,
    readOnly: values["read-only"],
    allow: values.allow?.split(",").map((s) => s.trim()).filter(Boolean),
    runtimeSessions: loadRuntimeSessions(values["runtime-config"]),
    runtimeOnly: values["runtime-only"],
    relayAgent: localRelayProxy(values["relay-proxy"], cfg.server),
  });

  // A Unix socket file outlives a crash; a Windows named pipe goes with its process.
  if (IS_WINDOWS || existsSync(CONTROL_SOCKET)) {
    const alive = await control({ op: "state" }).catch(() => null);
    if (alive) fail("xiaoaixiaoai is already running on this computer.");
    if (!IS_WINDOWS) rmSync(CONTROL_SOCKET, { force: true });
  }
  const server = createServer((sock) => {
    sock.on(
      "data",
      lineSplitter(async (line) => {
        let req: any;
        try {
          req = JSON.parse(line);
        } catch {
          return;
        }
        let res: unknown;
        try {
          if (req.op === "state") {
            const agents = [...host.remoteAgents.values()].flat();
            res = {
              ok: true,
              deviceId: host.deviceId,
              connected: host.connected,
              sources: host.sources,
              local: host.agents.length,
              devices: [...host.devices.values()],
              agents,
            };
          } else if (req.op === "call") {
            res = { ok: true, result: await host.call(req.to, req.method, req.params) };
          } else if (req.op === "exit") {
            // The Windows service stops the daemon this way (there is no SIGTERM there).
            res = { ok: true };
            setTimeout(() => shutdown(), 50);
          } else res = { ok: false, error: "unknown op" };
        } catch (e) {
          res = { ok: false, error: (e as Error).message };
        }
        sock.end(`${JSON.stringify(res)}\n`);
      }),
    );
    sock.on("error", () => {});
  });
  server.listen(CONTROL_SOCKET);

  await host.start();
  watchForUpdates((m) => console.log(`[hostd] ${m}`), "xiaoaixiaoai update");
  const shutdown = () => {
    host.stop();
    server.close();
    if (!IS_WINDOWS) rmSync(CONTROL_SOCKET, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Look and talk
// ---------------------------------------------------------------------------

interface State {
  deviceId: string;
  devices: Device[];
  agents: Agent[];
}

async function devices(): Promise<void> {
  const cfg = needConfig();
  const r = await http<{ devices: Device[] }>(cfg.server, "/v1/devices", { token: cfg.token });
  for (const d of r.devices) {
    const me = d.id === cfg.deviceId ? " (this computer)" : "";
    console.log(
      `${d.online ? "●" : "○"} ${d.name}${me}  ${d.kind} · ${d.platform ?? "?"} · ${d.id}${d.online ? "" : ` · last seen ${ago(d.lastSeenAt)}`}`,
    );
  }
}

async function agents(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { all: { type: "boolean", default: false } } });
  const s = await state();
  const byDevice = new Map<string, Agent[]>();
  for (const a of s.agents) if (values.all || !a.isShell) byDevice.set(a.deviceId, [...(byDevice.get(a.deviceId) ?? []), a]);
  if (!byDevice.size) console.log("no agents online.");
  const icon = { working: "◐", blocked: "!", done: "✓", idle: "·", unknown: "?" } as const;
  for (const [id, list] of byDevice) {
    const d = s.devices.find((x) => x.id === id);
    console.log(`\n${d?.name ?? id}${id === s.deviceId ? " (this computer)" : ""}`);
    for (const a of list) {
      console.log(`  ${icon[a.status]} ${a.localId.padEnd(5)} ${a.harness.padEnd(12)} ${a.title ?? a.preview ?? ""}`.slice(0, 120));
    }
  }
}

async function logs(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: "string", default: "1h" },
      device: { type: "string" },
      kind: { type: "string" },
      level: { type: "string" },
      source: { type: "string" },
      text: { type: "string" },
      limit: { type: "string", default: "200" },
      follow: { type: "boolean", short: "f", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const cfg = needConfig();
  const query = (after?: number) => {
    const q = new URLSearchParams();
    if (after) q.set("after", String(after));
    else q.set("since", values.since!);
    for (const k of ["device", "kind", "level", "source", "text"] as const) if (values[k]) q.set(k, values[k]!);
    q.set("limit", after ? "1000" : values.limit!);
    return `/v1/logs?${q}`;
  };
  const print = (e: LogEntry) => {
    if (values.json) {
      console.log(JSON.stringify(e));
      return;
    }
    const t = new Date(e.ts).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const who = e.source === "relay" ? "relay" : `${e.source}/${e.deviceName ?? e.device ?? "?"}`;
    const data = e.data ? `  ${Object.entries(e.data).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")}` : "";
    console.log(`${t} ${e.level.toUpperCase().padEnd(5)} ${who} ${e.kind}: ${e.msg}${data}`);
  };
  let { entries } = await http<{ entries: LogEntry[] }>(cfg.server, query(), { token: cfg.token });
  for (const e of entries) print(e);
  if (!values.follow) {
    if (!entries.length) console.error(`no log lines since ${values.since}.`);
    return;
  }
  let last = entries.length ? entries[entries.length - 1]!.id : 0;
  if (!last) {
    // Nothing yet: follow from the newest line there is.
    const newest = await http<{ entries: LogEntry[] }>(cfg.server, "/v1/logs?since=14d&limit=1", { token: cfg.token });
    last = newest.entries[0]?.id ?? 0;
  }
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      ({ entries } = await http<{ entries: LogEntry[] }>(cfg.server, query(last), { token: cfg.token }));
    } catch (e) {
      console.error(`(${e instanceof Error ? e.message : String(e)}; retrying)`);
      continue;
    }
    for (const e of entries) print(e);
    if (entries.length) last = entries[entries.length - 1]!.id;
  }
}

async function talk(cmd: "read" | "send" | "keys", argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { lines: { type: "string" } },
  });
  const [target, ...words] = positionals;
  if (!target || !target.includes("/")) fail(`usage: xiaoaixiaoai ${cmd} <device>/<agent> ...`);
  const slash = target.lastIndexOf("/");
  const devName = target.slice(0, slash);
  const local = target.slice(slash + 1);
  const s = await state();
  const d = s.devices.find((x) => x.id === devName) ?? s.devices.find((x) => x.name === devName);
  if (!d) fail(`no device "${devName}". Try \`xiaoaixiaoai devices\`.`);
  if (d.id === s.deviceId) fail("that is this computer: use `hc read/send/keys` directly.");
  const agent = `${d.id}/${local.includes(":") ? local : `hc:${local}`}`;
  let method: RpcMethod;
  let params: unknown;
  if (cmd === "read") {
    method = "terminal.read";
    params = { agent, lines: Number(values.lines ?? 80) };
  } else if (cmd === "send") {
    if (!words.length) fail("nothing to send");
    method = "terminal.send";
    params = { agent, text: words.join(" ") };
  } else {
    if (!words.length) fail("give at least one key");
    method = "terminal.keys";
    params = { agent, keys: words };
  }
  const result = (await callRemote(d.id, method, params)) as { text?: string };
  if (cmd === "read") process.stdout.write(`${result.text ?? ""}\n`);
  else console.log("✓ sent");
}

/** Prefer the running daemon (one relay connection per device); otherwise connect directly. */
async function state(): Promise<State> {
  const viaDaemon = await control({ op: "state" }).catch(() => null);
  if (viaDaemon) return viaDaemon as State;
  return withDirect(async (c) => c.state);
}

async function callRemote(to: string, method: RpcMethod, params: unknown): Promise<unknown> {
  const viaDaemon = await control({ op: "state" }).catch(() => null);
  if (viaDaemon) {
    const r = await control({ op: "call", to, method, params });
    if (!r.ok) fail(r.error);
    return r.result;
  }
  return withDirect((c) => c.call(to, method, params));
}

function control(req: unknown): Promise<any> {
  return controlAt(CONTROL_SOCKET, req);
}

/** Short-lived relay connection used when the daemon isn't running. */
async function withDirect<T>(fn: (c: { state: State; call: (to: string, m: RpcMethod, p: unknown) => Promise<unknown> }) => Promise<T>): Promise<T> {
  const cfg = needConfig();
  const ws = new WebSocket(`${cfg.server.replace(/^http/, "ws")}/v1/ws`, { headers: { Authorization: `Bearer ${cfg.token}` } });
  const pending = new Map<string, (f: Extract<ServerFrame, { type: "rpc_result" }>) => void>();
  const st = await new Promise<State>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("relay did not answer")), 15_000);
    let deviceId = cfg.deviceId;
    ws.on("message", (data) => {
      const f = JSON.parse(data.toString()) as ServerFrame;
      if (f.type === "welcome") deviceId = f.device.id;
      if (f.type === "snapshot") {
        clearTimeout(t);
        resolve({ deviceId, devices: f.devices, agents: f.agents });
      }
      if (f.type === "rpc_result") pending.get(f.id)?.(f);
    });
    ws.on("unexpected-response", (_q, res) => reject(new Error(`relay said ${res.statusCode}`)));
    ws.on("error", reject);
  });
  let n = 0;
  try {
    return await fn({
      state: st,
      call: (to, method, params) =>
        new Promise((resolve, reject) => {
          const id = `cli${++n}`;
          pending.set(id, (f) => (f.error ? reject(new Error(`${f.error.code}: ${f.error.message}`)) : resolve(f.result)));
          ws.send(JSON.stringify({ type: "rpc", id, to, method, params }));
        }),
    });
  } finally {
    ws.close();
  }
}

// ---------------------------------------------------------------------------

async function http<T>(server: string, path: string, init: { token?: string; body?: unknown; method?: string }): Promise<T> {
  const res = await fetch(server.replace(/\/+$/, "") + path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
  return json as T;
}

function needConfig(): HostConfig {
  const c = loadConfig();
  if (!c) fail("not set up. Run `xiaoaixiaoai up --server <url>` first.");
  return c;
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
