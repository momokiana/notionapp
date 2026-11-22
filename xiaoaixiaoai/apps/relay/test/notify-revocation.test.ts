// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic-only: fresh temporary DB, loopback port 0, scripted LLM, no hostd/discovery.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Relay } from "../src/server.ts";
import type { Llm } from "../src/assistant/llm.ts";

type Frame = { type: string; notice?: { id: string; ts: number; body: string }; [key: string]: unknown };
type Device = { device: { id: string }; token: string };
const fakeLlm: Llm = async (req) => {
  const last = req.messages.at(-1)?.content;
  const answered = Array.isArray(last) && last.some((b) => b.type === "tool_result");
  return {
    content: answered
      ? [{ type: "text", text: "synthetic reminder recorded" }]
      : [{ type: "tool_use", id: "synthetic-reminder-call", name: "set_reminder", input: { text: typeof last === "string" ? last : "synthetic", in_minutes: 0.001 } }],
    stopReason: answered ? "end_turn" : "tool_use",
    model: "synthetic-no-network",
  };
};

class Sock {
  frames: Frame[] = [];
  closed: number | null = null;
  private listeners = new Set<() => void>();
  readonly ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => { this.frames.push(JSON.parse(raw.toString()) as Frame); for (const f of this.listeners) f(); });
    ws.on("close", (code) => { this.closed = code; for (const f of this.listeners) f(); });
    ws.on("error", () => {});
  }
  private until<T>(pick: () => T | undefined, ms: number): Promise<T | undefined> {
    const ready = pick();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const finish = (v: T | undefined) => { clearTimeout(timer); this.listeners.delete(check); resolve(v); };
      const check = () => { const v = pick(); if (v !== undefined) finish(v); };
      const timer = setTimeout(() => finish(undefined), ms);
      this.listeners.add(check);
      check();
    });
  }
  async frame(pred: (f: Frame) => boolean): Promise<Frame> {
    const f = await this.until(() => this.frames.find(pred), 1500);
    assert.ok(f, "synthetic loopback frame not received");
    return f;
  }
  closeCode(ms = 750) { return this.until(() => this.closed ?? undefined, ms); }
  leaked(marker: string) { return this.frames.some((f) => f.type === "notice" && f.notice?.body.includes(marker)); }
}

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "chat014-notify-fixture-"));
  const relay = new Relay({ dbPath: join(dir, "relay.db"), llm: fakeLlm, assistantConfirm: "never", assistantTiming: { reminderTickMs: 5, promptEpoch: 0 }, log: () => {} });
  const port = await relay.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  const a = relay.store.createDevice({ name: "synthetic-a", kind: "viewer" });
  const b = relay.store.createDevice({ name: "synthetic-b", kind: "viewer" });
  const sockets: Sock[] = [];
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await relay.close(); } };
  t.after(async () => { for (const s of sockets) s.ws.terminate(); await stop(); rmSync(dir, { recursive: true, force: true }); });
  const api = async (path: string, token: string, body?: unknown, method = body ? "POST" : "GET") => {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json() as any };
  };
  const open = async (device: Device, path = "/v1/notify") => {
    const ws = new WebSocket(base.replace("http", "ws") + path, { headers: { Authorization: `Bearer ${device.token}` } });
    const sock = new Sock(ws); sockets.push(sock);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    await sock.frame((f) => f.type === (path.startsWith("/v1/notify") ? "hello" : "welcome"));
    return sock;
  };
  const remind = async (marker: string, observer: Sock) => {
    assert.equal((await api("/v1/assistant/messages", b.token, { text: marker })).status, 200);
    return observer.frame((f) => f.type === "notice" && !!f.notice?.body.includes(marker));
  };
  const denied = (token?: string) => new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/v1/notify", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    sockets.push(new Sock(ws));
    const timer = setTimeout(() => { ws.terminate(); reject(Error("synthetic auth rejection timed out")); }, 1500);
    ws.on("unexpected-response", (_req, res) => { clearTimeout(timer); res.resume(); ws.terminate(); resolve(res.statusCode!); });
    ws.once("open", () => { clearTimeout(timer); ws.terminate(); reject(Error("unexpected admitted notification socket")); });
  });
  return { relay, a, b, api, open, remind, denied, stop };
}

test("delete revokes every notify socket of A while B still receives real reminder notices", async (t) => {
  const f = await fixture(t);
  const main = await f.open(f.a, "/v1/ws"), a1 = await f.open(f.a), a2 = await f.open(f.a), b = await f.open(f.b);
  await f.remind("before-delete", b);
  await a1.frame((x) => x.type === "notice" && !!x.notice?.body.includes("before-delete"));
  await a2.frame((x) => x.type === "notice" && !!x.notice?.body.includes("before-delete"));
  const closed = [main.closeCode(), a1.closeCode(), a2.closeCode()];
  assert.equal((await f.api(`/v1/devices/${f.a.device.id}`, f.b.token, undefined, "DELETE")).status, 200);
  await f.remind("after-delete", b);
  const codes = await Promise.all(closed);
  const leaks = [a1, a2].filter((s) => s.leaked("after-delete")).length;
  assert.deepEqual(codes, [4001, 4001, 4001], `revoked A notify sockets leaked_after_notice=${leaks}`);
  assert.equal(leaks, 0);
  assert.equal(b.ws.readyState, WebSocket.OPEN);
  assert.equal(await f.denied(f.a.token), 401);
});

test("re-pairing the same viewer closes old notify siblings, not the replacement or B", async (t) => {
  const f = await fixture(t);
  const a1 = await f.open(f.a), a2 = await f.open(f.a), b = await f.open(f.b);
  const closed = [a1.closeCode(), a2.closeCode()];
  const code = await f.api("/v1/pair/codes", f.b.token, { kind: "viewer" });
  assert.equal(code.status, 200);
  const next = await f.api("/v1/pair", f.a.token, { code: code.json.code, name: "synthetic-a", kind: "viewer" });
  assert.equal(next.status, 200);
  const replacement = await f.open(next.json as Device);
  await f.remind("after-re-pair", b);
  await replacement.frame((x) => x.type === "notice" && !!x.notice?.body.includes("after-re-pair"));
  assert.deepEqual(await Promise.all(closed), [4001, 4001]);
  assert.equal(a1.leaked("after-re-pair") || a2.leaked("after-re-pair"), false);
  assert.equal(await f.denied(f.a.token), 401);
});

test("approved join replacement also revokes the old viewer notification channel", async (t) => {
  const f = await fixture(t);
  const a = await f.open(f.a), b = await f.open(f.b);
  const closed = a.closeCode();
  const ticket = await f.api("/v1/join", f.a.token, { name: "synthetic-a", kind: "viewer" });
  assert.equal(ticket.status, 200);
  assert.equal((await f.api(`/v1/join/${ticket.json.id}/approve`, f.b.token, {})).status, 200);
  const claim = await f.api(`/v1/join/${ticket.json.id}/claim`, "", { secret: ticket.json.secret });
  assert.equal(claim.status, 200);
  const replacement = await f.open(claim.json as Device);
  await f.remind("after-join", b);
  await replacement.frame((x) => x.type === "notice" && !!x.notice?.body.includes("after-join"));
  assert.equal(await closed, 4001);
  assert.equal(a.leaked("after-join"), false);
});

test("replacing a main socket or closing one notify sibling does not revoke valid subscribers", async (t) => {
  const f = await fixture(t);
  const main = await f.open(f.a, "/v1/ws"), a1 = await f.open(f.a), a2 = await f.open(f.a), b = await f.open(f.b);
  const closed = main.closeCode();
  await f.open(f.a, "/v1/ws");
  assert.equal(await closed, 4000);
  a1.ws.close();
  assert.equal(await a1.closeCode(), 1005);
  await f.remind("still-valid", b);
  await a2.frame((x) => x.type === "notice" && !!x.notice?.body.includes("still-valid"));
  assert.equal(a2.ws.readyState, WebSocket.OPEN);
});

test("notification admission rejects missing, invalid, host and revoked device credentials", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.denied(), 401);
  assert.equal(await f.denied("synthetic-invalid"), 401);
  const host = f.relay.store.createDevice({ name: "synthetic-host-no-daemon", kind: "host" });
  assert.equal(await f.denied(host.token), 403);
  assert.equal((await f.api(`/v1/devices/${f.a.device.id}`, f.b.token, undefined, "DELETE")).status, 200);
  assert.equal(await f.denied(f.a.token), 401);
});

test("valid since replay keeps the original hello/notice wire shape without subscriber identity", async (t) => {
  const f = await fixture(t);
  const b = await f.open(f.b);
  const original = await f.remind("replay-original", b);
  const a = await f.open(f.a, `/v1/notify?since=${original.notice!.ts - 1}`);
  const replay = await a.frame((x) => x.type === "notice" && x.notice?.id === original.notice!.id);
  assert.deepEqual(replay, original);
  assert.deepEqual(Object.keys(replay).sort(), ["notice", "type"]);
  const hello = await a.frame((x) => x.type === "hello");
  assert.deepEqual(Object.keys(hello).sort(), ["ts", "type"]);
});

test("notify socket responds to app-level ping with pong and stays open", async (t) => {
  const f = await fixture(t);
  const a = await f.open(f.a);
  a.ws.send(JSON.stringify({ type: "ping" }));
  const pong = await a.frame((x) => x.type === "pong");
  assert.equal(typeof pong.ts, "number");
  assert.equal(a.ws.readyState, WebSocket.OPEN);
});

test("relay shutdown still reclaims all current notification sockets", async (t) => {
  const f = await fixture(t);
  const sockets = [await f.open(f.a), await f.open(f.a), await f.open(f.b)];
  const closed = sockets.map((s) => s.closeCode());
  await f.stop();
  assert.ok((await Promise.all(closed)).every((code) => code !== undefined));
});
