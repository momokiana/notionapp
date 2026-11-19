import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import type { RuntimeSessionSend } from "@xiaoaixiaoai/protocol";
import { CodexRuntime, CodexRuntimeError, type CodexRuntimeErrorCode } from "../src/codex-runtime.ts";

const TOKEN = "synthetic-loopback-token";
const THREAD = "thr_synthetic";
const OUTSIDE = "thr_other_unlisted";
const PROJECT = "project_test";
const WRITE = { id: THREAD, projectId: PROJECT, projectTitle: "Synthetic project", canSend: true };
const INPUT: RuntimeSessionSend = {
  runtime: "codex", projectId: PROJECT, sessionId: THREAD,
  requestId: "00000000-0000-4000-8000-000000000001", text: " synthetic prompt\n保持原文 ",
};

interface Frame { method?: string; id?: string | number; params?: Record<string, unknown> }
interface FixtureOptions {
  loaded?: string[];
  auth?: boolean;
  status?: unknown;
  onFrame?: (f: Frame, socket: WebSocket, reply: (result: unknown) => void) => boolean | void;
}

async function fixture(t: TestContext, opts: FixtureOptions = {}) {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const frames: Array<Frame & { connection: number }> = [];
  const headers: Array<string | undefined> = [];
  const seen = new EventEmitter();
  let opened = 0;
  http.on("upgrade", (request, socket, head) => {
    headers.push(request.headers.authorization);
    if (opts.auth !== false && request.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (peer) => {
      const connection = ++opened;
      let initialized = false;
      peer.on("message", (wire) => {
        const frame: Frame = JSON.parse(wire.toString());
        const { method, id, params } = frame;
        frames.push({ ...frame, connection });
        seen.emit(method ?? "response");
        const reply = (result: unknown) => peer.send(JSON.stringify({ id, result }));
        if (opts.onFrame?.(frame, peer, reply)) return;
        switch (method) {
          case "initialize":
            assert.equal(initialized, false);
            assert.equal(typeof id, "number");
            reply({ userAgent: "synthetic-app-server", platformFamily: "windows", platformOs: "windows" });
            break;
          case "initialized":
            assert.equal(id, undefined);
            initialized = true;
            break;
          case "thread/loaded/list":
            assert.equal(initialized, true);
            reply({ data: opts.loaded ?? [THREAD, OUTSIDE], nextCursor: null });
            break;
          case "thread/read":
            assert.equal(initialized, true);
            reply({ thread: {
              id: params?.threadId, name: "  Synthetic\nthread ", status: opts.status ?? { type: "idle" }, turns: [],
              preview: "private synthetic first prompt", cwd: "/synthetic/private", path: "synthetic-session.jsonl",
            } });
            break;
          case "turn/start":
            assert.equal(initialized, true);
            reply({ turn: { id: "turn_synthetic", status: "inProgress", items: [], error: null } });
            break;
          default:
            // Keep any unexpected method/response in the transcript for exact assertions below.
            break;
        }
      });
    });
  });
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await Promise.all([
      new Promise<void>((resolve) => wss.close(() => resolve())),
      new Promise<void>((resolve) => http.close(() => resolve())),
    ]);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    url, headers, frames,
    methods: () => frames.map((frame) => frame.method),
    runtime: (threads: ConstructorParameters<typeof CodexRuntime>[0]["threads"] = [WRITE], token = TOKEN) => {
      const runtime = new CodexRuntime({ url, token, threads });
      t.after(() => runtime.close());
      return runtime;
    },
    async waitFor(method: string) {
      if (frames.some((frame) => frame.method === method)) return;
      await once(seen, method);
    },
  };
}

const rejectCode = (code: CodexRuntimeErrorCode) => (error: unknown): boolean =>
  error instanceof CodexRuntimeError && error.code === code;
const PREFLIGHT = ["initialize", "initialized", "thread/loaded/list", "thread/read"];

test("lists exact allowed IDs and projects only, without previews or history", async (t) => {
  const fake = await fixture(t, { loaded: [THREAD, "thr_view_only", OUTSIDE] });
  const runtime = fake.runtime([WRITE, { id: "thr_view_only", projectId: "project_view", projectTitle: "View only" }]);
  const projects = await runtime.list();
  assert.deepEqual(projects, [
    { runtime: "codex", id: PROJECT, title: "Synthetic project", sessions: [
      { id: THREAD, title: "Synthetic thread", state: "idle", canSend: true },
    ] },
    { runtime: "codex", id: "project_view", title: "View only", sessions: [
      { id: "thr_view_only", title: "Synthetic thread", state: "idle", canSend: false },
    ] },
  ]);
  assert.deepEqual(fake.headers, [undefined, `Bearer ${TOKEN}`]);
  assert.deepEqual(fake.methods(), [...PREFLIGHT, "thread/read"]);
  assert.deepEqual(fake.frames.slice(3).map((f) => f.params), [
    { threadId: THREAD, includeTurns: false }, { threadId: "thr_view_only", includeTurns: false },
  ]);
  assert.ok(fake.frames.every((f) => f.connection === 1), "all RPCs use the same authenticated connection");
});

test("starts one exact text-only turn, uses numeric JSON-RPC IDs, never answers server requests", async (t) => {
  const fake = await fixture(t, {
    onFrame(f, peer) {
      if (f.method === "initialize") {
        peer.send(JSON.stringify({ id: f.id, method: "item/permissions/requestApproval", params: { threadId: OUTSIDE } }));
      }
      if (f.method === "turn/start") {
        // The numeric server request ID collides with ours. A stringified response ID is a different ID.
        peer.send(JSON.stringify({ id: f.id, method: "item/commandExecution/requestApproval", params: { threadId: THREAD } }));
        peer.send(JSON.stringify({ id: "synthetic-elicitation", method: "item/tool/requestUserInput", params: { threadId: THREAD } }));
        peer.send(JSON.stringify({ id: String(f.id), result: { turn: { id: "turn_wrong_type", status: "inProgress" } } }));
      }
    },
  });
  assert.deepEqual(await fake.runtime().send(INPUT), {
    accepted: true, requestId: INPUT.requestId, receiptId: "turn_synthetic",
  });
  assert.deepEqual(fake.headers, [undefined, `Bearer ${TOKEN}`]);
  assert.deepEqual(fake.methods(), [...PREFLIGHT, "turn/start"]);
  assert.deepEqual(fake.frames.map((f) => f.id), [1, undefined, 2, 3, 4]);
  assert.ok(fake.frames.every((f) => f.connection === 1));
  assert.deepEqual(fake.frames[0]?.params, { clientInfo: { name: "xiaoaixiaoai_hostd", title: "小爱小爱", version: "0.1.0" } });
  assert.deepEqual(fake.frames[1]?.params, {});
  assert.deepEqual(fake.frames[2]?.params, {});
  assert.deepEqual(fake.frames[3]?.params, { threadId: THREAD, includeTurns: false });
  assert.deepEqual(fake.frames[4]?.params, { threadId: THREAD, input: [{ type: "text", text: INPUT.text }] });
});

test("unlisted, wrong project, read-only, and non-text input are rejected with no endpoint access", async (t) => {
  const fake = await fixture(t);
  const runtime = fake.runtime();
  await assert.rejects(runtime.send({ ...INPUT, sessionId: OUTSIDE }), rejectCode("thread_not_allowed"));
  await assert.rejects(runtime.send({ ...INPUT, projectId: "other_project" }), rejectCode("thread_not_allowed"));
  for (const injected of [{ approvalPolicy: "never" }, { sandbox: "danger-full-access" }, { toolOutput: {} }, { files: ["synthetic"] }]) {
    const extra = { ...INPUT, ...injected };
    await assert.rejects(runtime.send(extra), rejectCode("invalid_input"));
  }
  const readOnly = fake.runtime([{ id: THREAD, projectId: PROJECT, projectTitle: "Synthetic project" }]);
  await assert.rejects(readOnly.send(INPUT), rejectCode("read_only"));
  assert.deepEqual(fake.headers, []);
  assert.deepEqual(fake.methods(), []);
});

test("active, waiting, notLoaded, unknown and unlisted-in-memory threads cannot mutate", async (t) => {
  const checks: Array<{ status: unknown; code: CodexRuntimeErrorCode; methods: string[]; loaded?: string[] }> = [
    { status: { type: "active", activeFlags: [] }, code: "thread_busy", methods: PREFLIGHT },
    { status: { type: "active", activeFlags: ["waitingOnApproval"] }, code: "thread_busy", methods: PREFLIGHT },
    { status: { type: "notLoaded" }, code: "thread_not_loaded", methods: PREFLIGHT },
    { status: { type: "idle" }, code: "thread_not_loaded", methods: PREFLIGHT.slice(0, 3), loaded: [OUTSIDE] },
    { status: { type: "unexpectedStatus" }, code: "thread_state_unverified", methods: PREFLIGHT },
    { status: "idle", code: "thread_state_unverified", methods: PREFLIGHT },
  ];
  for (const check of checks) {
    const fake = await fixture(t, check);
    await assert.rejects(fake.runtime().send(INPUT), rejectCode(check.code));
    assert.deepEqual(fake.methods(), check.methods);
  }
});

test("validates returned thread identity and vetoes evidence of a status change during preflight", async (t) => {
  const mismatch = await fixture(t, {
    onFrame(f, _peer, reply) {
      if (f.method !== "thread/read") return;
      reply({ thread: { id: OUTSIDE, status: { type: "idle" } } });
      return true;
    },
  });
  await assert.rejects(mismatch.runtime().send(INPUT), rejectCode("protocol_error"));
  assert.deepEqual(mismatch.methods(), PREFLIGHT);

  const changed = await fixture(t, {
    onFrame(f, peer) {
      if (f.method === "thread/read") peer.send(JSON.stringify({ method: "thread/closed", params: { threadId: THREAD } }));
    },
  });
  await assert.rejects(changed.runtime().send(INPUT), rejectCode("thread_not_loaded"));
  assert.deepEqual(changed.methods(), PREFLIGHT);
});

test("does not use an idle response when the same-wire liveness proof aged out", { timeout: 6_000 }, async (t) => {
  const fake = await fixture(t, {
    onFrame(f, _peer, reply) {
      if (f.method !== "thread/read") return;
      const delay = setTimeout(() => reply({ thread: { id: THREAD, status: { type: "idle" } } }), 2_050);
      t.after(() => clearTimeout(delay));
      return true;
    },
  });
  await assert.rejects(fake.runtime().send(INPUT), rejectCode("thread_state_unverified"));
  assert.deepEqual(fake.methods(), PREFLIGHT);
});

test("rejects nonliteral, nonloopback, path/query and insecure auth setup before RPC", async (t) => {
  for (const url of [
    "ws://localhost:1234", "ws://127.1:1234", "ws://2130706433:1234", "ws://127.000.000.001:1234",
    "ws://[::1]:1234", "ws://192.0.2.1:1234", "ws://user@127.0.0.1:1234", "ws://127.0.0.1:1234/path",
    "ws://127.0.0.1:1234/?token=embedded", "ws://127.0.0.1:1234/#fragment", "ws://127.0.0.1:1234\n",
    "ws://127.0.0.1:65536", "wss://127.0.0.1:1234",
  ]) assert.throws(() => new CodexRuntime({ url, token: TOKEN, threads: [WRITE] }), rejectCode("invalid_config"));
  const open = await fixture(t, { auth: false });
  for (const token of ["", "synthetic\r\nInjected: yes", "synthetic\n", "synthetic unsafe"]) {
    assert.throws(() => open.runtime([WRITE], token), rejectCode("invalid_config"));
  }
  await assert.rejects(open.runtime().list(), rejectCode("auth_failed"));
  assert.deepEqual(open.headers, [undefined]);
  assert.deepEqual(open.methods(), []);
  const auth = await fixture(t);
  await assert.rejects(auth.runtime([WRITE], "wrong-synthetic-token").send(INPUT), rejectCode("auth_failed"));
  assert.deepEqual(auth.headers, [undefined, "Bearer wrong-synthetic-token"]);
  assert.deepEqual(auth.methods(), []);
});

test("close aborts preflight and a concurrent send to the same thread never enters another wire", { timeout: 3_000 }, async (t) => {
  const fake = await fixture(t, { onFrame: (f) => f.method === "thread/read" });
  const runtime = fake.runtime();
  const aborted = assert.rejects(runtime.send(INPUT), rejectCode("aborted"));
  await fake.waitFor("thread/read");
  await assert.rejects(runtime.send({ ...INPUT, requestId: "00000000-0000-4000-8000-000000000002" }), rejectCode("thread_busy"));
  runtime.close();
  await aborted;
  await assert.rejects(runtime.list(), rejectCode("aborted"));
  assert.deepEqual(fake.headers, [undefined, `Bearer ${TOKEN}`]);
  assert.deepEqual(fake.methods(), PREFLIGHT);
});

test("pre-dispatch timeout is definite; post-dispatch timeout is ambiguous and fences that thread", { timeout: 3_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const before = await fixture(t, { onFrame: (f) => f.method === "thread/read" });
  const preflightTimedOut = assert.rejects(before.runtime().send(INPUT), rejectCode("timeout"));
  await before.waitFor("thread/read");
  t.mock.timers.tick(8_000);
  await preflightTimedOut;
  assert.deepEqual(before.methods(), PREFLIGHT);

  const after = await fixture(t, { onFrame: (f) => f.method === "turn/start" });
  const runtime = after.runtime();
  const turnTimedOut = assert.rejects(runtime.send(INPUT), rejectCode("turn_acceptance_unknown"));
  await after.waitFor("turn/start");
  t.mock.timers.tick(8_000);
  await turnTimedOut;
  await assert.rejects(runtime.send(INPUT), rejectCode("thread_confirmation_required"));
  assert.deepEqual(after.methods(), [...PREFLIGHT, "turn/start"]);
  assert.equal((await runtime.list())[0]?.sessions[0]?.canSend, false);
  assert.deepEqual(after.methods(), [...PREFLIGHT, "turn/start", ...PREFLIGHT]);
});

test("transport loss, local close and malformed acknowledgement after turn/start cannot claim acceptance", { timeout: 3_000 }, async (t) => {
  for (const end of ["peer_close", "local_close", "bad_reply"] as const) {
    const fake = await fixture(t, {
      onFrame(f, peer, reply) {
        if (f.method !== "turn/start") return;
        if (end === "peer_close") peer.terminate();
        else if (end === "bad_reply") reply({ turn: { id: 123, status: "inProgress" } });
        return true;
      },
    });
    const runtime = fake.runtime();
    const unknown = assert.rejects(runtime.send(INPUT), rejectCode("turn_acceptance_unknown"));
    if (end === "local_close") {
      await fake.waitFor("turn/start");
      runtime.close();
    }
    await unknown;
    assert.deepEqual(fake.methods(), [...PREFLIGHT, "turn/start"]);
  }
});

test("explicit admission rejection is definite and never reflects server content", async (t) => {
  const fake = await fixture(t, {
    onFrame(f, peer) {
      if (f.method !== "turn/start") return;
      peer.send(JSON.stringify({ id: f.id, error: { code: -32001, message: "synthetic private diagnostic", data: { handle: TOKEN } } }));
      return true;
    },
  });
  await assert.rejects(fake.runtime().send(INPUT), (error) => {
    assert.ok(error instanceof CodexRuntimeError);
    assert.equal(error.code, "turn_rejected");
    assert.equal(error.message, "The Codex App Server rejected the turn request.");
    return true;
  });
  assert.deepEqual(fake.methods(), [...PREFLIGHT, "turn/start"]);
});
