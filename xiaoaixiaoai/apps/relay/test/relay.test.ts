import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { pairLink, parseJoinLink, parsePairInput, type Agent, type ServerFrame } from "@xiaoaixiaoai/protocol";
import { Relay } from "../src/server.ts";

const ADMIN = "admin-token-for-tests-0123456789";
let relay: Relay;
let base: string;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "pocket-relay-"));
  relay = new Relay({ dbPath: join(dir, "t.db"), adminToken: ADMIN, rpcTimeoutMs: 1500, log: () => {} });
  const port = await relay.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  // (token on /v1/pair = the device's previous registration)
  const res = await fetch(base + path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function pair(kind: "host" | "viewer", name: string) {
  const code = await api("/v1/pair/codes", { token: ADMIN, body: { kind } });
  assert.equal(code.status, 200);
  const r = await api("/v1/pair", { body: { code: code.json.code, name, kind } });
  assert.equal(r.status, 200);
  return r.json as { token: string; device: { id: string } };
}

class Client {
  frames: ServerFrame[] = [];
  private waiters: Array<{ pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }> = [];
  ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString()) as ServerFrame;
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => (w.pred(f) ? (w.resolve(f), false) : true));
    });
  }
  static open(token: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/v1/ws?token=${encodeURIComponent(token)}`);
      const c = new Client(ws);
      ws.once("open", () => resolve(c));
      ws.once("error", reject);
    });
  }
  next<T extends ServerFrame["type"]>(type: T, pred: (f: Extract<ServerFrame, { type: T }>) => boolean = () => true) {
    const hit = this.frames.find((f) => f.type === type && pred(f as any));
    if (hit) {
      this.frames.splice(this.frames.indexOf(hit), 1);
      return Promise.resolve(hit as Extract<ServerFrame, { type: T }>);
    }
    return new Promise<Extract<ServerFrame, { type: T }>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 3000);
      this.waiters.push({
        pred: (f) => f.type === type && pred(f as any),
        resolve: (f) => {
          clearTimeout(t);
          this.frames.splice(this.frames.indexOf(f), 1);
          resolve(f as any);
        },
      });
    });
  }
  send(f: unknown) {
    this.ws.send(JSON.stringify(f));
  }
  close() {
    this.ws.close();
  }
}

test("health is public", async () => {
  const r = await api("/v1/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test("minting pair codes needs a token", async () => {
  assert.equal((await api("/v1/pair/codes", { body: {} })).status, 401);
  assert.equal((await api("/v1/pair/codes", { token: "nope", body: {} })).status, 401);
});

test("pair codes are single use and kind-bound", async () => {
  const code = (await api("/v1/pair/codes", { token: ADMIN, body: { kind: "viewer" } })).json.code;
  assert.match(code, /^[A-Z]{4}-\d{4}$/);
  const wrongKind = await api("/v1/pair", { body: { code, name: "x", kind: "host" } });
  assert.equal(wrongKind.status, 400);
  assert.match(wrongKind.json.error.message, /给手机用的/);
  // The wrong kind of device does not burn the code: the right one can still use it.
  const again = await api("/v1/pair", { body: { code, name: "x", kind: "viewer" } });
  assert.equal(again.status, 200);

  const code2 = (await api("/v1/pair/codes", { token: ADMIN, body: {} })).json.code;
  const ok = await api("/v1/pair", { body: { code: code2.toLowerCase(), name: "phone", kind: "viewer" } });
  assert.equal(ok.status, 200);
  assert.match(ok.json.token, /^hp_/);
  const reuse = await api("/v1/pair", { body: { code: code2, name: "phone2", kind: "viewer" } });
  assert.equal(reuse.status, 401);
});

test("a taken device name gets a number so devices stay tellable apart", async () => {
  const a = await pair("viewer", "same phone");
  const b = await pair("viewer", "same phone");
  const names = (await api("/v1/devices", { token: a.token })).json.devices.map((d: { name: string }) => d.name);
  assert.ok(names.includes("same phone") && names.includes("same phone 2"));
  assert.notEqual(a.device.id, b.device.id);
});

test("pairing again with the old token replaces the old registration", async () => {
  const old = await pair("viewer", "returning phone");
  const code = (await api("/v1/pair/codes", { token: ADMIN, body: { kind: "viewer" } })).json.code;
  const next = await api("/v1/pair", { token: old.token, body: { code, name: "returning phone", kind: "viewer" } });
  assert.equal(next.status, 200);
  assert.equal(next.json.device.name, "returning phone");
  assert.equal((await api("/v1/devices", { token: old.token })).status, 401);
  const list = (await api("/v1/devices", { token: next.json.token })).json.devices as Array<{ id: string; name: string }>;
  assert.equal(list.filter((d) => d.name.startsWith("returning phone")).length, 1);
  // A bad code must not cost the device its current registration.
  const bad = await api("/v1/pair", { token: next.json.token, body: { code: "NOPE-0000", name: "x", kind: "viewer" } });
  assert.equal(bad.status, 401);
  assert.equal((await api("/v1/devices", { token: next.json.token })).status, 200);
});

test("a new device can join by having a paired device approve its request", async () => {
  const phone = await pair("viewer", "approver");
  const ask = await api("/v1/join", { body: { name: "new mac", kind: "host", platform: "darwin" } });
  assert.equal(ask.status, 200);
  assert.deepEqual(parseJoinLink(ask.json.link), { server: base, id: ask.json.id });
  const claim = () => api(`/v1/join/${ask.json.id}/claim`, { body: { secret: ask.json.secret } });
  assert.deepEqual((await claim()).json, { status: "pending" });
  // The QR alone (id without the secret) collects nothing, and approving needs a paired device.
  assert.equal((await api(`/v1/join/${ask.json.id}/claim`, { body: { secret: "wrong" } })).status, 404);
  assert.equal((await api(`/v1/join/${ask.json.id}/approve`, { method: "POST" })).status, 401);
  const seen = await api(`/v1/join/${ask.json.id}`, { token: phone.token });
  assert.equal(seen.json.name, "new mac");
  assert.equal(seen.json.secret, undefined);
  const ok = await api(`/v1/join/${ask.json.id}/approve`, { method: "POST", token: phone.token });
  assert.equal(ok.status, 200);
  const got = (await claim()).json;
  assert.equal(got.status, "approved");
  assert.match(got.token, /^hp_/);
  assert.equal((await api("/v1/devices", { token: got.token })).status, 200);
  // Collected once.
  assert.equal((await claim()).status, 404);

  const ask2 = await api("/v1/join", { body: { name: "stranger", kind: "viewer" } });
  assert.equal((await api(`/v1/join/${ask2.json.id}/deny`, { method: "POST", token: phone.token })).status, 200);
  assert.deepEqual((await api(`/v1/join/${ask2.json.id}/claim`, { body: { secret: ask2.json.secret } })).json, { status: "denied" });
  assert.equal((await api(`/v1/join/${ask2.json.id}/approve`, { method: "POST", token: phone.token })).status, 404);
});

test("pair input accepts a link, server + code, or a bare code", () => {
  assert.deepEqual(parsePairInput(pairLink("https://x.dev/pocket", "MEOW-0042")), { server: "https://x.dev/pocket", code: "MEOW-0042" });
  assert.deepEqual(parsePairInput("  meow-0042 "), { code: "MEOW-0042" });
  assert.deepEqual(parsePairInput("meow0042"), { code: "MEOW-0042" });
  assert.deepEqual(parsePairInput("x.dev/pocket BAAA-1234"), { server: "x.dev/pocket", code: "BAAA-1234" });
  assert.equal(parsePairInput("hello world"), null);
  assert.equal(parsePairInput("https://x.dev/pocket"), null);
  assert.equal(parsePairInput(""), null);
});

test("websocket rejects missing, bad and admin tokens", async () => {
  for (const t of ["", "bad", ADMIN]) {
    await assert.rejects(Client.open(t));
  }
});

test("hosts publish agents, viewers see them, rpc round-trips", async () => {
  const host = await pair("host", "MacBook");
  const phone = await pair("viewer", "iPhone");
  const h = await Client.open(host.token);
  const p = await Client.open(phone.token);
  await h.next("welcome");
  await p.next("snapshot");

  h.send({ type: "hello", version: 1, platform: "darwin", sources: ["hc"] });
  const agent: Partial<Agent> = {
    key: "spoofed/hc:t1",
    deviceId: "spoofed",
    source: "hc",
    localId: "t1",
    harness: "claude-code",
    status: "working",
    isShell: false,
    updatedAt: 1,
  };
  h.send({ type: "agents", agents: [agent] });
  const seen = await p.next("agents", (f) => f.deviceId === host.device.id);
  assert.equal(seen.agents.length, 1);
  // The relay rewrites ownership: a host can't publish agents for another device.
  assert.equal(seen.agents[0]!.deviceId, host.device.id);
  assert.equal(seen.agents[0]!.key, `${host.device.id}/hc:t1`);

  // Viewer may not publish agents.
  p.send({ type: "agents", agents: [agent] });
  const err = await p.next("error");
  assert.equal(err.error.code, "forbidden");

  // RPC phone -> host -> phone.
  p.send({ type: "rpc", id: "c1", to: host.device.id, method: "terminal.read", params: { agent: "t1" } });
  const fwd = await h.next("rpc");
  assert.equal(fwd.from, phone.device.id);
  assert.equal(fwd.method, "terminal.read");
  assert.notEqual(fwd.id, "c1", "relay uses its own call ids");
  // Another party can't answer a call that wasn't sent to it.
  p.send({ type: "rpc_result", id: fwd.id, result: { text: "forged" } });
  h.send({ type: "rpc_result", id: fwd.id, result: { text: "hello" } });
  const res = await p.next("rpc_result", (f) => f.id === "c1");
  assert.deepEqual(res.result, { text: "hello" });

  // Calling a viewer is not allowed; calling an unknown device reports offline.
  h.send({ type: "rpc", id: "c2", to: phone.device.id, method: "agents.list", params: {} });
  assert.equal((await h.next("rpc_result", (f) => f.id === "c2")).error?.code, "forbidden");
  p.send({ type: "rpc", id: "c3", to: "nobody", method: "agents.list", params: {} });
  assert.equal((await p.next("rpc_result", (f) => f.id === "c3")).error?.code, "offline");

  // Unanswered calls time out.
  p.send({ type: "rpc", id: "c4", to: host.device.id, method: "agents.list", params: {} });
  await h.next("rpc");
  assert.equal((await p.next("rpc_result", (f) => f.id === "c4")).error?.code, "timeout");

  // agent.create may outlast the usual timeout while the host types the first task in.
  p.send({ type: "rpc", id: "c5", to: host.device.id, method: "agent.create", params: { launcher: "kimi", task: "hi" } });
  const slow = await h.next("rpc", (f) => f.method === "agent.create");
  await new Promise((r) => setTimeout(r, 1800));
  h.send({ type: "rpc_result", id: slow.id, result: { agent: "x", space: "s", terminal: "t", task: "typed" } });
  assert.equal(((await p.next("rpc_result", (f) => f.id === "c5")).result as { task?: string })?.task, "typed");

  // Host going offline clears its agents for viewers.
  h.close();
  const cleared = await p.next("agents", (f) => f.deviceId === host.device.id && f.agents.length === 0);
  assert.equal(cleared.agents.length, 0);
  const off = await p.next("device", (f) => f.device.id === host.device.id && !f.device.online);
  assert.equal(off.device.online, false);
  p.close();
});

test("stream subscriptions stay between caller and target host", async () => {
  const host = await pair("host", "stream host");
  const phone = await pair("viewer", "stream phone");
  const h = await Client.open(host.token);
  const p = await Client.open(phone.token);
  await h.next("snapshot");
  await p.next("snapshot");
  p.send({ type: "stream_subscribe", id: "s1", to: host.device.id, stream: "terminal", params: { agent: "t1" } });
  const sub = await h.next("stream_subscribe");
  assert.equal(sub.from, phone.device.id);
  assert.equal(sub.id, "s1");
  h.send({ type: "stream_open", id: sub.id, result: { kind: "terminal" } });
  assert.deepEqual((await p.next("stream_open", (f) => f.id === "s1")).result, { kind: "terminal" });
  h.send({ type: "stream_event", id: sub.id, event: { kind: "terminal", screen: { text: "live" } } });
  assert.deepEqual((await p.next("stream_event", (f) => f.id === "s1")).event, { kind: "terminal", screen: { text: "live" } });
  p.send({ type: "stream_unsubscribe", id: "s1", to: host.device.id });
  assert.equal((await h.next("stream_unsubscribe")).from, phone.device.id);
  h.close();
  p.close();
});

test("a phone that reconnects gets its streams back; the host stops the old ones", async () => {
  const host = await pair("host", "resub host");
  const phone = await pair("viewer", "resub phone");
  const h = await Client.open(host.token);
  const p1 = await Client.open(phone.token);
  await h.next("snapshot");
  await p1.next("snapshot");
  p1.send({ type: "stream_subscribe", id: "r1", to: host.device.id, stream: "terminal", params: { agent: "t1" } });
  h.send({ type: "stream_open", id: (await h.next("stream_subscribe")).id, result: { kind: "terminal" } });
  await p1.next("stream_open", (f) => f.id === "r1");
  // A new socket of the same phone replaces the old one before its close is seen (mobile networks).
  const p2 = await Client.open(phone.token);
  await p2.next("snapshot");
  assert.equal((await h.next("stream_unsubscribe", (f) => f.id === "r1")).from, phone.device.id);
  p2.send({ type: "stream_subscribe", id: "r1", to: host.device.id, stream: "terminal", params: { agent: "t1" } });
  h.send({ type: "stream_open", id: (await h.next("stream_subscribe", (f) => f.id === "r1")).id, result: { kind: "terminal" } });
  assert.equal((await p2.next("stream_open", (f) => f.id === "r1")).error, undefined);
  h.send({ type: "stream_event", id: "r1", event: { kind: "terminal", screen: { text: "again" } } });
  assert.deepEqual((await p2.next("stream_event", (f) => f.id === "r1")).event, { kind: "terminal", screen: { text: "again" } });
  // The host going away ends the phone's stream, so it can subscribe again once it is back.
  h.close();
  assert.equal((await p2.next("stream_open", (f) => f.id === "r1" && !!f.error)).error?.code, "offline");
  p1.close();
  p2.close();
});

test("host-to-host calls work (joint debugging)", async () => {
  const a = await pair("host", "A");
  const b = await pair("host", "B");
  const ca = await Client.open(a.token);
  const cb = await Client.open(b.token);
  await ca.next("snapshot");
  await cb.next("snapshot");
  ca.send({ type: "rpc", id: "x", to: b.device.id, method: "terminal.send", params: { agent: "t2", text: "hi" } });
  const fwd = await cb.next("rpc");
  assert.equal(fwd.from, a.device.id);
  cb.send({ type: "rpc_result", id: fwd.id, result: { ok: true } });
  assert.deepEqual((await ca.next("rpc_result", (f) => f.id === "x")).result, { ok: true });
  ca.close();
  cb.close();
});

test("revoking a device closes its socket and invalidates the token", async () => {
  const phone = await pair("viewer", "old phone");
  const other = await pair("viewer", "new phone");
  const c = await Client.open(phone.token);
  await c.next("snapshot");
  const closed = new Promise<number>((r) => c.ws.once("close", (code) => r(code)));
  const del = await api(`/v1/devices/${phone.device.id}`, { method: "DELETE", token: other.token });
  assert.equal(del.status, 200);
  assert.equal(await closed, 4001);
  assert.equal((await api("/v1/devices", { token: phone.token })).status, 401);
  await assert.rejects(Client.open(phone.token));
});

test("desktop web bundle is served at /app/ with SPA fallback and traversal protection", async (t) => {
  const webRoot = mkdtempSync(join(tmpdir(), "pocket-web-"));
  const relayDir = mkdtempSync(join(tmpdir(), "pocket-web-relay-"));
  t.after(() => {
    rmSync(webRoot, { recursive: true, force: true });
    rmSync(relayDir, { recursive: true, force: true });
  });
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>WebDesktop</title>");
  writeFileSync(join(webRoot, "assets", "app.js"), "console.log('ok');");
  writeFileSync(join(relayDir, "secret.txt"), "top-secret");

  const webRelay = new Relay({ dbPath: join(relayDir, "w.db"), adminToken: ADMIN, webDir: webRoot, log: () => {} });
  const port = await webRelay.listen(0, "127.0.0.1");
  t.after(async () => {
    await webRelay.close();
  });
  const webBase = `http://127.0.0.1:${port}`;

  const redir = await fetch(`${webBase}/app`, { redirect: "manual" });
  assert.equal(redir.status, 302);
  assert.equal(redir.headers.get("location"), "app/");

  const idx = await fetch(`${webBase}/app/`);
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await idx.text(), /WebDesktop/);

  const js = await fetch(`${webBase}/app/assets/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);
  assert.equal(await js.text(), "console.log('ok');");

  const spa = await fetch(`${webBase}/app/ledger/2026`);
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /WebDesktop/);

  const missAsset = await fetch(`${webBase}/app/assets/missing.js`);
  assert.equal(missAsset.status, 404);

  const traversal = await fetch(`${webBase}/app/%2e%2e/secret.txt`);
  assert.notEqual(traversal.status, 200);
});
