// SPDX-License-Identifier: AGPL-3.0-only
// Fresh local DB and synthetic WebSockets only: no hostd, runtime sockets, or device profiles.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import {
  isRuntimeRequestId,
  RUNTIME_TASK_EVENTS_LIMIT,
  type Notice,
  type NotifyFrame,
  type PairResponse,
  type RuntimeTaskEvent,
  type ServerFrame,
} from "@xiaoaixiaoai/protocol";
import { Relay } from "../src/server.ts";
import { RUNTIME_TASK_MAX_NONTERMINAL, RUNTIME_TASK_TTL_MS } from "../src/runtime-task-notices.ts";

type Frame = ServerFrame | NotifyFrame;
type Of<T extends Frame["type"]> = Extract<Frame, { type: T }>;
const INPUT = "SYNTHETIC_INPUT_NEVER_STORED";
const PROJECT = "Fixture-Project.Exact";
const SESSION = "fixture:Session.Exact";
const event = (requestId: string, kind: RuntimeTaskEvent["kind"]): RuntimeTaskEvent => ({ eventId: randomUUID(), requestId, kind });
const receipt = (requestId: string) => ({ result: { accepted: true, requestId } });
const sendParams = (requestId: string = randomUUID()) => ({ runtime: "dsh" as const, projectId: PROJECT, sessionId: SESSION, input: INPUT, requestId });

class Wire {
  readonly frames: Frame[] = [];
  private readonly changed = new Set<() => void>();
  closed: number | undefined;
  readonly ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => { this.frames.push(JSON.parse(data.toString())); this.update(); });
    ws.on("close", (code) => { this.closed = code; this.update(); });
    ws.on("error", () => {});
  }

  private update(): void { for (const f of this.changed) f(); }

  private until<T>(read: () => T | undefined, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const value = read();
        if (value === undefined) return;
        clearTimeout(timer);
        this.changed.delete(check);
        resolve(value);
      };
      const timer = setTimeout(() => { this.changed.delete(check); reject(new Error(`missing loopback ${label}`)); }, 2500);
      this.changed.add(check);
      check();
    });
  }

  frame<T extends Frame["type"]>(type: T, match: (value: Of<T>) => boolean = () => true): Promise<Of<T>> {
    return this.until(() => this.frames.find((f): f is Of<T> => f.type === type && match(f as Of<T>)), type);
  }

  closeCode(): Promise<number> { return this.until(() => this.closed, "close"); }
  send(value: unknown): void { this.ws.send(JSON.stringify(value)); }
  notices(): Notice[] { return this.frames.flatMap((f) => f.type === "notice" ? [f.notice] : []); }

  /** WebSocket ping/pong orders even negative assertions without sleeping. */
  fence(): Promise<void> {
    return new Promise((resolve, reject) => {
      const marker = randomUUID();
      const onPong = (data: Buffer) => {
        if (data.toString() !== marker) return;
        clearTimeout(timer);
        this.ws.off("pong", onPong);
        resolve();
      };
      const timer = setTimeout(() => { this.ws.off("pong", onPong); reject(new Error("missing loopback pong")); }, 2500);
      this.ws.on("pong", onPong);
      this.ws.ping(marker);
    });
  }
}

async function fixture(t: TestContext, legacyNotice?: Notice) {
  const dir = mkdtempSync(join(tmpdir(), "xa-runtime-notices-"));
  const dbPath = join(dir, "relay.db");
  if (legacyNotice) {
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE assistant_notices (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL)");
    db.prepare("INSERT INTO assistant_notices VALUES (?, ?, ?)").run(legacyNotice.id, legacyNotice.ts, JSON.stringify(legacyNotice));
    db.close();
  }
  const sockets = new Set<WebSocket>();
  const logs: string[] = [];
  let relay: Relay | undefined;
  let base = "";
  const start = async () => {
    relay = new Relay({ dbPath, rpcTimeoutMs: 8000, log: (line) => logs.push(line) });
    base = `http://127.0.0.1:${await relay.listen(0, "127.0.0.1")}`;
  };
  const stop = async () => {
    for (const ws of sockets) ws.terminate();
    sockets.clear();
    const current = relay;
    relay = undefined;
    await current?.close();
  };
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true }); });
  await start();
  const api = (device: PairResponse, path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const open = async (device: PairResponse, path = "/v1/ws") => {
    const ws = new WebSocket(base.replace("http:", "ws:") + path, { headers: { authorization: `Bearer ${device.token}` } });
    sockets.add(ws);
    const wire = new Wire(ws);
    await wire.frame(path.startsWith("/v1/notify") ? "hello" : "welcome");
    return wire;
  };
  return {
    get relay() { return relay!; },
    start, stop, logs, api, open,
    register: (kind: "viewer" | "host", name: string) => relay!.store.createDevice({ kind, name }),
    notify: (device: PairResponse, since?: number) => open(device, `/v1/notify${since === undefined ? "" : `?since=${since}`}`),
    async replace(device: PairResponse) {
      const code = await api(device, "/v1/pair/codes", "POST", { kind: device.device.kind });
      assert.equal(code.status, 200);
      const result = await api(device, "/v1/pair", "POST", { code: (await code.json()).code, kind: device.device.kind, name: device.device.name });
      assert.equal(result.status, 200);
      return await result.json() as PairResponse;
    },
    tables() {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return Object.fromEntries(["runtime_task_claims", "runtime_tasks", "runtime_task_events"].map((name) => [name, db.prepare(`SELECT * FROM ${name}`).all()]));
      } finally { db.close(); }
    },
  };
}

async function dispatch(caller: Wire, host: Wire, to: PairResponse, params: unknown, from?: string) {
  const id = randomUUID();
  const start = host.frames.length;
  caller.send({ type: "rpc", id, to: to.device.id, from, method: "runtimeSessions.send", params });
  // The host sees a new relay-generated ID, not the ID from the caller's envelope.
  const forwarded = await host.frame("rpc", (f) => host.frames.indexOf(f) >= start);
  assert.notEqual(forwarded.id, id);
  const reply = (payload: object) => ({ type: "rpc_result", id: forwarded.id, ...payload });
  return {
    forwarded, reply,
    async finish(payload: object) {
      host.send(reply(payload));
      return await caller.frame("rpc_result", (f) => f.id === id);
    },
  };
}

async function upload(wire: Wire, e: RuntimeTaskEvent, ack: boolean, frame: unknown = { type: "runtime_task_event", event: e }) {
  const start = wire.frames.length;
  wire.send(frame);
  await wire.fence();
  assert.deepEqual(wire.frames.slice(start).filter((f) => f.type === "runtime_task_ack"), ack ? [{ type: "runtime_task_ack", eventId: e.eventId }] : []);
}

test("only the originating viewer's native sockets receive static notices, with durable dedup and terminal ordering", async (t) => {
  const f = await fixture(t);
  const owner = f.register("viewer", "fixture-owner");
  const peer = f.register("viewer", "fixture-peer");
  const computer = f.register("host", "fixture-computer");
  const main = await f.open(owner), peerMain = await f.open(peer), host = await f.open(computer);
  const native = await f.notify(owner), sibling = await f.notify(owner), outsider = await f.notify(peer);
  assert.equal((await host.frame("welcome")).runtimeTaskNotices, true);
  assert.equal((await main.frame("welcome")).runtimeTaskNotices, true);
  const requestId = randomUUID();
  const p = sendParams(requestId.toUpperCase());
  const call = await dispatch(main, host, computer, p, peer.device.id);
  assert.equal(call.forwarded.from, owner.device.id);
  assert.deepEqual(call.forwarded.params, p);
  const progress = { ...event(requestId.toUpperCase(), "progress"), eventId: randomUUID().toUpperCase() };
  await upload(host, progress, false);
  const result = { accepted: true, requestId, receiptId: "fixture-receipt" };
  assert.deepEqual((await call.finish({ result })).result, result);
  await upload(host, progress, true);
  await upload(host, { ...progress, eventId: progress.eventId.toLowerCase() }, true);
  await upload(host, { ...progress, kind: "attention" }, false); // Same event ID, conflicting meaning.
  await upload(host, event(requestId, "attention"), true);
  const completed = event(requestId, "completed");
  await upload(host, completed, true);
  await upload(host, event(requestId, "progress"), false);
  await upload(host, event(requestId, "stopped"), false);
  await upload(host, completed, true);

  const later = sendParams();
  await (await dispatch(main, host, computer, later)).finish(receipt(later.requestId));
  await upload(host, event(later.requestId, "stopped"), true);
  await Promise.all([main.fence(), peerMain.fence(), native.fence(), sibling.fence(), outsider.fence()]);
  const notices = native.notices();
  assert.deepEqual(sibling.notices(), notices);
  assert.deepEqual(outsider.notices(), []);
  assert.deepEqual(notices.map((n) => [n.kind, n.verdict]), [["progress", undefined], ["blocked", "decide"], ["done", undefined], ["done", "stopped"]]);
  assert.match(notices[0]!.body, /观察到.+执行步骤/);
  assert.match(notices[2]!.title, /此轮已结束/);
  assert.match(notices[2]!.body, /此轮已结束/);
  assert.equal(new Set(notices.map((n) => n.id)).size, 4);
  for (const [i, n] of notices.entries()) {
    assert.ok(isRuntimeRequestId(n.id));
    assert.deepEqual(n.runtimeTask, { hostId: computer.device.id, projectId: PROJECT, sessionId: SESSION, requestId: i === 3 ? later.requestId : requestId });
    assert.ok(![PROJECT, SESSION, INPUT, requestId].some((v) => n.title.includes(v) || n.body.includes(v)));
  }
  assert.ok([...main.frames, ...peerMain.frames].every((x) => x.type !== "notice" && x.type !== "assistant_item"));
  const history = await (await f.api(owner, "/v1/assistant")).json();
  assert.deepEqual(history.items, []);
  const ordinaryLogs = await (await f.api(peer, "/v1/logs")).text();
  assert.doesNotMatch(`${ordinaryLogs}${f.logs.join("\n")}`, /runtime_task|runtimeTask|SYNTHETIC_INPUT|Fixture-Project|Session\.Exact|此轮已结束/);
  assert.ok(!JSON.stringify(f.tables()).includes(INPUT));
});

test("a real matching receipt must come from the routed host socket for a viewer's valid DSH send", async (t) => {
  const f = await fixture(t);
  const owner = f.register("viewer", "fixture-viewer");
  const computer = f.register("host", "fixture-target");
  const charlatan = f.register("host", "fixture-other-host");
  const main = await f.open(owner), fake = await f.open(charlatan);
  let host = await f.open(computer);
  const p = sendParams();
  const call = await dispatch(main, host, computer, p);
  const spoof = call.reply(receipt(p.requestId));
  fake.send(spoof);
  main.send(spoof);
  await Promise.all([fake.fence(), main.fence()]);
  const valid = event(p.requestId, "progress");
  await upload(host, valid, false);
  await call.finish(receipt(p.requestId));
  await upload(fake, valid, false);
  await upload(main, valid, false);
  await upload(host, valid, false, { type: "runtime_task_event", event: valid, viewerId: owner.device.id });
  await upload(host, valid, false, { type: "runtime_task_event", event: { ...valid, recipient: owner.device.id, text: INPUT } });
  await upload(host, valid, false, { type: "runtime_task_event", event: { ...valid, kind: "success" } });
  await upload(host, valid, false, { type: "runtime_task_event", event: { ...valid, eventId: "invalid" } });
  const start = host.frames.length;
  host.ws.send(`${" ".repeat(1024)}${JSON.stringify({ type: "runtime_task_event", event: valid })}`);
  await host.fence();
  assert.ok(host.frames.slice(start).every((x) => x.type !== "runtime_task_ack"));
  await upload(host, valid, true);

  const old = host;
  const oldRequest = sendParams();
  const stale = await dispatch(main, old, computer, oldRequest);
  host = await f.open(computer);
  assert.equal(await old.closeCode(), 4000);
  host.send(stale.reply(receipt(oldRequest.requestId)));
  await upload(host, event(oldRequest.requestId, "progress"), false);
  await upload(host, event(p.requestId, "attention"), true); // A confirmed task survives a normal host reconnect.

  for (const [modify, response] of [
    [{ runtime: "codex" }, receipt],
    [{ projectId: "p".repeat(97) }, receipt],
    [{ sessionId: "not/a/session" }, receipt],
    [{ requestId: "not-a-uuid" }, receipt],
    [{}, () => receipt(randomUUID())],
    [{}, (requestId: string) => ({ result: { accepted: false, requestId } })],
    [{}, (requestId: string) => ({ ...receipt(requestId), error: { code: "forbidden", message: INPUT } })],
  ] as const) {
    const original = sendParams();
    await (await dispatch(main, host, computer, { ...original, ...modify })).finish(response(original.requestId));
    await upload(host, event(original.requestId, "progress"), false);
  }
  const other = sendParams();
  const hostCall = await dispatch(fake, host, computer, other, owner.device.id);
  assert.equal(hostCall.forwarded.from, charlatan.device.id);
  await hostCall.finish(receipt(other.requestId));
  await upload(host, event(other.requestId, "progress"), false);
  const relayParams = sendParams();
  const relayCall = f.relay.callHost(computer.device.id, "runtimeSessions.send", relayParams);
  const forwarded = await host.frame("rpc", (x) => x.from === "relay");
  host.send({ type: "rpc_result", id: forwarded.id, ...receipt(relayParams.requestId) });
  await relayCall;
  await upload(host, event(relayParams.requestId, "progress"), false);
  assert.equal(f.tables().runtime_tasks!.length, 1);
  assert.ok(!f.logs.join("\n").includes(INPUT));
});

test("restart resumes host acks and merges private replay with the assistant's existing time cursor", async (t) => {
  const assistant = (ts: number): Notice => ({ id: randomUUID(), ts, kind: "reminder", title: "Fixture reminder", body: "Synthetic assistant notice" });
  const first = assistant(Date.now() - 100);
  const f = await fixture(t, first); // Pre-existing assistant schema, then CREATE IF NOT EXISTS migration.
  const owner = f.register("viewer", "fixture-owner");
  const peer = f.register("viewer", "fixture-peer");
  const computer = f.register("host", "fixture-host");
  const main = await f.open(owner), peerMain = await f.open(peer);
  let host = await f.open(computer);
  const p = sendParams();
  await (await dispatch(main, host, computer, p)).finish(receipt(p.requestId));
  const replay = { ...p, requestId: p.requestId.toUpperCase(), projectId: "spoofed-project", sessionId: "spoofed-session" };
  await (await dispatch(peerMain, host, computer, replay, owner.device.id)).finish(receipt(p.requestId));
  const progress = event(p.requestId, "progress");
  await upload(host, progress, true);
  const [saved] = f.relay.store.runtimeTaskNoticesSince(owner.device.id, first.ts, Date.now());
  assert.ok(saved);
  assert.deepEqual(saved.runtimeTask, { hostId: computer.device.id, projectId: PROJECT, sessionId: SESSION, requestId: p.requestId });
  const last = assistant(saved.ts + 1);
  f.relay.store.putNotice(last.id, last.ts, last);

  await f.stop();
  await f.start();
  host = await f.open(computer);
  const native = await f.notify(owner, first.ts - 1), peers = await f.notify(peer, first.ts - 1);
  const sinceRuntime = await f.notify(owner, saved.ts);
  await upload(host, progress, true);
  await Promise.all([native.fence(), peers.fence(), sinceRuntime.fence()]);
  assert.deepEqual(native.notices(), [first, saved, last]);
  assert.deepEqual(peers.notices(), [first, last]);
  assert.deepEqual(sinceRuntime.notices(), [last]);
  await upload(host, event(p.requestId, "completed"), true);
  const ending = await native.frame("notice", (x) => x.notice.kind === "done");
  assert.deepEqual(ending.notice.runtimeTask, saved.runtimeTask);
  assert.deepEqual(f.relay.assistant.state().items, []);
});

test("viewer replacement and host revocation purge private rows without moving an old binding", async (t) => {
  const f = await fixture(t);
  const owner = f.register("viewer", "fixture-owner");
  const computer = f.register("host", "fixture-host");
  const main = await f.open(owner), host = await f.open(computer), native = await f.notify(owner);
  const since = Date.now() - 100;
  const p = sendParams();
  await (await dispatch(main, host, computer, p)).finish(receipt(p.requestId));
  await upload(host, event(p.requestId, "progress"), true);
  await native.frame("notice");
  const late = sendParams();
  const pending = await dispatch(main, host, computer, late);
  const next = await f.replace(owner);
  host.send(pending.reply(receipt(late.requestId)));
  await host.fence();
  assert.notEqual(next.device.id, owner.device.id);
  assert.deepEqual(await Promise.all([main.closeCode(), native.closeCode()]), [4001, 4001]);
  assert.equal(f.tables().runtime_task_events!.length, 0);
  assert.equal(f.tables().runtime_tasks!.length, 0);
  await upload(host, event(p.requestId, "stopped"), false);
  const nextMain = await f.open(next), nextNative = await f.notify(next, since);
  for (const original of [p, late]) {
    await (await dispatch(nextMain, host, computer, original)).finish(receipt(original.requestId));
    await upload(host, event(original.requestId, "completed"), false);
  }
  await nextNative.fence();
  assert.deepEqual(nextNative.notices(), []);

  const fresh = sendParams();
  await (await dispatch(nextMain, host, computer, fresh)).finish(receipt(fresh.requestId));
  await upload(host, event(fresh.requestId, "progress"), true);
  await nextNative.frame("notice");
  assert.equal((await f.api(next, `/v1/devices/${computer.device.id}`, "DELETE")).status, 200);
  assert.equal(await host.closeCode(), 4001);
  assert.ok(Object.values(f.tables()).every((rows) => rows.length === 0));
  const catchup = await f.notify(next, since);
  await catchup.fence();
  assert.deepEqual(catchup.notices(), []);
});

test("bounded per-task events keep room for a terminal notice, and expired bindings cannot be refreshed", async (t) => {
  const f = await fixture(t);
  const owner = f.register("viewer", "fixture-owner");
  const peer = f.register("viewer", "fixture-peer");
  const computer = f.register("host", "fixture-host");
  const main = await f.open(owner), host = await f.open(computer), peerMain = await f.open(peer);
  const p = sendParams();
  await (await dispatch(main, host, computer, p)).finish(receipt(p.requestId));
  for (let i = 0; i < RUNTIME_TASK_MAX_NONTERMINAL; i++) await upload(host, event(p.requestId, "progress"), true);
  await upload(host, event(p.requestId, "attention"), false);
  await upload(host, event(p.requestId, "completed"), true);
  const expired = Date.now() + RUNTIME_TASK_TTL_MS;
  const since = Date.now() - 100;
  assert.deepEqual(f.relay.store.runtimeTaskNoticesSince(owner.device.id, since, expired), []);
  f.relay.store.pruneRuntimeTasks(expired);
  assert.equal(f.tables().runtime_task_events!.length, 0);
  await (await dispatch(peerMain, host, computer, p)).finish(receipt(p.requestId));
  await upload(host, event(p.requestId, "attention"), false);
});

test("host upload rate survives socket replacement; a failed write is never acknowledged", async (t) => {
  const f = await fixture(t);
  const owner = f.register("viewer", "fixture-owner");
  const computer = f.register("host", "fixture-host");
  let host = await f.open(computer);
  const main = await f.open(owner);
  const p = sendParams();
  await (await dispatch(main, host, computer, p)).finish(receipt(p.requestId));
  const progress = event(p.requestId, "progress");
  const failure = t.mock.method(f.relay.store, "recordRuntimeTaskEvent", () => { throw new Error(INPUT); });
  await upload(host, progress, false);
  failure.mock.restore();
  await upload(host, progress, true);
  const unknown = { type: "runtime_task_event", event: event(randomUUID(), "progress") };
  for (let i = 2; i < 2 * RUNTIME_TASK_EVENTS_LIMIT; i++) host.send(unknown);
  await host.fence();
  host = await f.open(computer);
  await upload(host, event(p.requestId, "completed"), false);
  assert.equal(f.tables().runtime_task_events!.length, 1);
  assert.ok(!f.logs.join("\n").includes(INPUT));
});
