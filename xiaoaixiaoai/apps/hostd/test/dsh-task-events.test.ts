import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import {
  DSH_ARCHIVE, DSH_UNFILED, RUNTIME_TASK_EVENTS_LIMIT, isRuntimeRequestId,
  type DshDirectoryEntry, type RuntimeTaskEvent,
} from "../../../packages/protocol/src/index.ts";

const entry = new URL("../integrations/dsh/index.mjs", import.meta.url);
const eventModule = new URL("../integrations/dsh/task-events.mjs", import.meta.url);
const uuid = (n: number) => `abcd0000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const profile = { workspaceScope: "all", enableSend: true, sendScope: "profile" };
const dshPackage = process.env.DSH_TEST_PACKAGE;
const unix = process.geteuid !== undefined;
const fixtureTest = (name: string, run: (t: TestContext) => Promise<void>) => test(name, { skip: !unix, timeout: 15_000 }, run);

type Dispose = () => void | Promise<void>;
type Listener = (...args: unknown[]) => void;
type Prompt = { sessionId: string; requestId: string; mode: string; content: Array<{ type: string; text: string }> };
type Track = { accept(): void; discard(): void };
type Observer = { track(id: string, agent: object, session: object): Track | undefined; read(): RuntimeTaskEvent[]; close(): void };
const { createTaskEvents } = await import(eventModule.href) as { createTaskEvents(ctx: object): Observer | undefined };
const { default: bridge } = await import(entry.href) as { default: { apply(ctx: object, config: object): Promise<Dispose> } };

function eventBus() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on(name: string, listener: Listener) {
      let set = listeners.get(name);
      if (!set) listeners.set(name, set = new Set());
      set.add(listener);
      return () => set.delete(listener);
    },
    emit(name: string, ...args: unknown[]) {
      for (const listener of listeners.get(name) ?? []) listener(...args);
    },
    listenerCount() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); },
  };
}

function agent(id: string, origin?: string) {
  return { id, status: "running", session: { id, header: { id, origin } } };
}

function fixture(observe = true) {
  const bus = eventBus();
  const live = new Map(
    [agent("first"), agent("second"), agent("unfiled"), agent("archived"), agent("ambiguous"), agent("child", "subagent"), agent("owned-child")]
      .map((a) => [a.id, a]),
  );
  const workspaces = new Map([
    ["alpha", { id: "alpha", sessionIds: ["first", "archived", "cold", "child", "owned-child", "ambiguous"] }],
    ["beta", { id: "beta", sessionIds: ["second", "ambiguous"] }],
  ]);
  const archived = ["archived"];
  const items = [...live.keys(), "cold"].map((sessionId) => ({
    sessionId, origin: live.get(sessionId)?.session.header.origin, formatStatus: "current", agentAvailable: live.has(sessionId), running: live.has(sessionId),
  }));
  const prompts: Prompt[] = [];
  const control = {
    async list(): Promise<unknown> { return { items }; },
    async prompt(_p: Prompt, _signal: AbortSignal): Promise<unknown> { return { accepted: true }; },
  };
  const services = {
    workspaceRegistry: { get: (id: string) => workspaces.get(id), list: () => [...workspaces.values()], archivedSessionIds: archived },
    agents: { get: (id: string) => live.get(id), roots: () => [...live.values()].filter((a) => a.id !== "owned-child") },
    sessionController: {
      list: () => control.list(),
      prompt(p: Prompt, signal: AbortSignal) { prompts.push(p); return control.prompt(p, signal); },
    },
  };
  return { bus, live, workspaces, archived, items, control, prompts, services, ctx: { ...services, ...(observe ? { on: bus.on } : {}) } };
}

async function setup(t: TestContext, observe = true) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "xax-events-"));
  const socketPath = join(dir, "bridge.sock");
  const f = fixture(observe);
  let close: Dispose | undefined;
  t.after(async () => { await close?.(); await rm(dir, { recursive: true, force: true }); });
  function exchange(path: string, body?: string, method = "POST", signal = AbortSignal.timeout(8_000)) {
    return new Promise<{ status: number | undefined; body: unknown; noStore: boolean }>((resolve, reject) => {
      const req = request({ socketPath, path, method, agent: false, signal, headers: { "content-type": "application/json" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), noStore: res.headers["cache-control"] === "no-store" }); }
          catch (error) { reject(error); }
        });
      });
      req.on("error", reject);
      req.end(body);
    });
  }
  return {
    ...f, dir, socketPath, exchange,
    async start(config: object = profile) { close = await bridge.apply(f.ctx, { socketPath, ...config }); return close; },
    send: (overrides: object = {}, signal?: AbortSignal) => exchange("/v1/send", JSON.stringify({
      projectId: "alpha", sessionId: "first", requestId: uuid(1), text: "Synthetic private prompt", ...overrides,
    }), "POST", signal),
    events: async () => {
      const result = await exchange("/v3/task-events", "{}");
      assert.equal(result.status, 200);
      assert.equal(result.noStore, true);
      return (result.body as { events: RuntimeTaskEvent[] }).events;
    },
  };
}

function claim(bus: ReturnType<typeof eventBus>, agent: object, rpcId: string, turn = 3, kind = "user") {
  bus.emit("agent/inbox/claimed", { agent, message: { source: { kind, rpcId }, content: "Synthetic private prompt" }, turn });
}
const sessionEvent = (bus: ReturnType<typeof eventBus>, session: object, type: string, data: object) =>
  bus.emit("session/event", session, { type, data });
const step = (bus: ReturnType<typeof eventBus>, session: object, turn = 3, step = 1) => sessionEvent(bus, session, "step/end", { turn, step });
const end = (bus: ReturnType<typeof eventBus>, session: object, kind = "completed", turn = 3) =>
  sessionEvent(bus, session, "turn/end", { turn, reason: { kind, error: "Synthetic private reason" } });

function shape(events: RuntimeTaskEvent[]) {
  const seen = new Set();
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ["eventId", "kind", "requestId"]);
    assert.ok(isRuntimeRequestId(event.eventId));
    assert.ok(isRuntimeRequestId(event.requestId));
    assert.equal(event.requestId, event.requestId.toLowerCase());
    assert.equal(seen.has(event.eventId), false);
    seen.add(event.eventId);
  }
  return events.map(({ requestId, kind }) => [requestId, kind]);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

fixtureTest("profile sending is explicit, permits eligible roots across projects and checks unfiled", async (t) => {
  const f = await setup(t);
  for (const bad of [
    { ...profile, sendAllowlist: [] }, { ...profile, sendAllowlist: undefined }, { ...profile, enableSend: false },
    { workspaceScope: "all", sendScope: "profile" }, { workspaceIds: ["alpha"], enableSend: true, sendScope: "profile" },
    { ...profile, sendScope: "all" }, { ...profile, sendScope: undefined },
  ]) await assert.rejects(f.start(bad), /Invalid DSH bridge configuration/);
  assert.equal(f.bus.listenerCount(), 0);
  const empty = await f.start({ workspaceScope: "all", enableSend: true });
  assert.equal((await f.send()).status, 403);
  assert.deepEqual(await f.events(), []);
  assert.equal(f.bus.listenerCount(), 0);
  await empty();
  await f.start();
  const browsed = await f.exchange("/v2/browse", '{"view":"sessions"}');
  assert.equal(browsed.status, 200);
  const entries = (browsed.body as { entries: DshDirectoryEntry[] }).entries;
  assert.deepEqual(entries.filter(({ session }) => session.canSend).map(({ project, session }) => [project.id, session.id]), [
    ["alpha", "first"], ["beta", "second"], [DSH_UNFILED, "unfiled"],
  ]);
  for (const [projectId, sessionId, status] of [
    ["beta", "first", 404], ["missing", "first", 404], ["alpha", "cold", 409], ["alpha", "archived", 404],
    ["alpha", "ambiguous", 409], ["alpha", "child", 409], ["alpha", "owned-child", 409],
    [DSH_ARCHIVE, "archived", 403], [DSH_UNFILED, "second", 409],
  ] as const) assert.equal((await f.send({ projectId, sessionId })).status, status, `${projectId}/${sessionId}`);
  assert.equal(f.prompts.length, 0);
  for (const [i, target] of [{}, { projectId: "beta", sessionId: "second" }, { projectId: DSH_UNFILED, sessionId: "unfiled" }].entries()) {
    const requestId = uuid(i + 1);
    const reply = await f.send({ ...target, requestId: requestId.toUpperCase() });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { accepted: true, requestId });
  }
  assert.deepEqual(f.prompts.map(({ sessionId, requestId, mode }) => [sessionId, requestId, mode]), [
    ["first", uuid(1), "queue"], ["second", uuid(2), "queue"], ["unfiled", uuid(3), "queue"],
  ]);
});

fixtureTest("profile sends recheck both real membership and unfiled absence on the same live Session", async (t) => {
  const f = await setup(t);
  await f.start();
  const alpha = f.workspaces.get("alpha")!;
  const beta = f.workspaces.get("beta")!;
  const live = f.live.get("unfiled")!;
  const session = live.session;
  const cases = [
    { target: {}, mutate: () => f.workspaces.set("alpha", { ...alpha }), reset: () => f.workspaces.set("alpha", alpha) },
    // Making another project claim "first" without removing it from alpha also fails closed.
    { target: {}, mutate: () => beta.sessionIds.unshift("first"), reset: () => beta.sessionIds.shift() },
    { target: { projectId: DSH_UNFILED, sessionId: "unfiled" }, mutate: () => alpha.sessionIds.unshift("unfiled"), reset: () => alpha.sessionIds.shift() },
    { target: { projectId: DSH_UNFILED, sessionId: "unfiled" }, mutate: () => f.archived.unshift("unfiled"), reset: () => f.archived.shift() },
    { target: { projectId: DSH_UNFILED, sessionId: "unfiled" }, mutate: () => f.live.set("unfiled", agent("unfiled")), reset: () => f.live.set("unfiled", live) },
    { target: { projectId: DSH_UNFILED, sessionId: "unfiled" }, mutate: () => { live.session = { ...session }; }, reset: () => { live.session = session; } },
  ];
  for (const { target, mutate, reset } of cases) {
    f.control.list = async () => { await Promise.resolve(); mutate(); return { items: f.items }; };
    const reply = await f.send(target);
    assert.ok(reply.status === 404 || reply.status === 409, JSON.stringify(reply));
    reset();
  }
  assert.deepEqual(f.prompts, []);
  assert.deepEqual(await f.events(), []);
});

fixtureTest("explicit profile option resumes an exact existing session only when a send is confirmed", async (t) => {
  const f = await setup(t);
  const resumed: string[] = [];
  const controller = Object.assign(f.services.sessionController, {
    async resolveAgent(id: string) {
      resumed.push(id);
      const a = agent(id);
      f.live.set(id, a);
      return { agent: a };
    },
  });
  await assert.rejects(f.start({ workspaceScope: "all", resumeExisting: true }), /Invalid DSH bridge configuration/);
  await f.start({ ...profile, resumeExisting: true });
  const result = await f.exchange("/v2/browse", '{"view":"exact","sessionIds":["cold","archived"]}');
  assert.deepEqual((result.body as { entries: DshDirectoryEntry[] }).entries.map((e) => [e.session.id, e.session.state, e.session.canSend]), [
    ["cold", "inactive", true], ["archived", "inactive", false],
  ]);
  assert.deepEqual(resumed, []);
  assert.equal((await f.send({ projectId: "alpha", sessionId: "absent" })).status, 404);
  assert.equal((await f.send({ projectId: "beta", sessionId: "cold" })).status, 404);
  const current = f.items.find((entry) => entry.sessionId === "cold")!;
  current.formatStatus = "migration-required";
  assert.equal((await f.send({ sessionId: "cold" })).status, 409);
  assert.deepEqual(resumed, []);
  current.formatStatus = "current";
  const call = await f.send({ sessionId: "cold" });
  assert.equal(call.status, 200);
  assert.deepEqual(resumed, ["cold"]);
  assert.deepEqual(f.prompts.map(({ sessionId, mode }) => [sessionId, mode]), [["cold", "queue"]]);
  // Disallow delivery if membership changes during native activation.
  f.live.delete("cold");
  const resolve = controller.resolveAgent;
  controller.resolveAgent = async (id) => { const out = await resolve(id); f.archived.push(id); return out; };
  assert.equal((await f.send({ sessionId: "cold", requestId: uuid(2) })).status, 404);
  assert.equal(f.prompts.length, 1);
});

fixtureTest("task-events is a strict POST route and optional when no Cordis event API is present", async (t) => {
  const f = await setup(t, false);
  const close = await f.start({ workspaceIds: ["alpha"], enableSend: true, sendAllowlist: [{ workspaceId: "alpha", sessionId: "first" }] });
  assert.equal((await f.exchange("/v3/task-events", undefined, "GET")).status, 405);
  assert.equal((await f.exchange("/v3/task-events?extra", "{}")).status, 404);
  for (const body of ["", "{", "null", "[]", "true", '{"more":1}', '{"__proto__":{}}']) {
    assert.equal((await f.exchange("/v3/task-events", body)).status, 400, body);
  }
  assert.equal((await f.send()).status, 200);
  assert.deepEqual(await f.events(), []);
  await close();
});

fixtureTest("only the exact claimed request, Session and turn produce stable post-receipt observations", async (t) => {
  const f = await setup(t);
  const close = await f.start({ workspaceIds: ["alpha"], enableSend: true, sendAllowlist: [{ workspaceId: "alpha", sessionId: "first" }] });
  const live = f.live.get("first")!;
  const sameId = agent(live.id);
  const requestId = uuid(0xabc);
  const arrived = deferred<void>();
  const receipt = deferred<unknown>();
  f.control.prompt = async (params) => {
    assert.deepEqual(params, { requestId, sessionId: "first", mode: "queue", content: [{ type: "text", text: "Synthetic private prompt" }] });
    step(f.bus, live.session);
    claim(f.bus, live, requestId, 3, "tool");
    claim(f.bus, live, requestId.toUpperCase());
    claim(f.bus, live, uuid(0xabd));
    claim(f.bus, { ...live }, requestId); // Even a different Agent over the same Session does not claim it.
    claim(f.bus, sameId, requestId);
    end(f.bus, live.session);
    claim(f.bus, live, requestId);
    step(f.bus, sameId.session);
    end(f.bus, live.session, "completed", 4);
    step(f.bus, live.session, 4);
    sessionEvent(f.bus, live.session, "step/start", { turn: 3, step: 1 });
    sessionEvent(f.bus, live.session, "tool/call", { turn: 3, step: 1, arguments: "Synthetic private tool arguments" });
    step(f.bus, live.session);
    step(f.bus, live.session, 3, 2);
    end(f.bus, live.session);
    end(f.bus, live.session, "error");
    arrived.resolve();
    return receipt.promise;
  };
  const sending = f.send({ requestId: requestId.toUpperCase() });
  await arrived.promise;
  assert.deepEqual(await f.events(), []);
  receipt.resolve({ accepted: true, text: "Synthetic private receipt" });
  assert.deepEqual((await sending).body, { accepted: true, requestId });
  const events = await f.events();
  assert.deepEqual(shape(events), [[requestId, "progress"], [requestId, "completed"]]);
  assert.deepEqual(await f.events(), events);
  await close();
  assert.equal(f.bus.listenerCount(), 0);
  await assert.rejects(lstat(f.socketPath), { code: "ENOENT" });
});

fixtureTest("rejection, native errors and late acceptance after caller abort never expose staged observations", async (t) => {
  const f = await setup(t);
  await f.start();
  const live = f.live.get("first")!;
  function emit(p: Prompt) { claim(f.bus, live, p.requestId); step(f.bus, live.session); end(f.bus, live.session, "blocked"); }
  f.control.prompt = async (p) => { emit(p); return { accepted: "true" }; };
  assert.deepEqual((await f.send()).body, { error: "unavailable" });
  f.control.prompt = async (p) => { emit(p); throw new Error("Synthetic private native error"); };
  assert.deepEqual((await f.send({ requestId: uuid(2) })).body, { error: "unavailable" });
  const arrived = deferred<AbortSignal>();
  const receipt = deferred<unknown>();
  f.control.prompt = async (p, signal) => { emit(p); arrived.resolve(signal); return receipt.promise; };
  const client = new AbortController();
  const denied = assert.rejects(f.send({ requestId: uuid(3) }, client.signal), { name: "AbortError" });
  const signal = await arrived.promise;
  const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  client.abort();
  await denied;
  await aborted;
  receipt.resolve({ accepted: true });
  assert.deepEqual(await f.events(), []);
});

fixtureTest("queue discard and disposal stop only the correlated Agent or Session work", async (t) => {
  const f = await setup(t);
  await f.start();
  const live = f.live.get("first")!;
  const other = f.live.get("second")!;
  const replacement = agent(live.id);
  const discard = (agent: object, rpcId: string, kind = "user") => f.bus.emit("agent/inbox/discarded", { agent, message: { source: { kind, rpcId } } });
  f.control.prompt = async ({ requestId }) => {
    if (requestId === uuid(1)) discard(live, requestId); // Synchronous, before the receipt.
    return { accepted: true };
  };
  for (const n of [1, 2, 3]) assert.equal((await f.send({ requestId: uuid(n) })).status, 200);
  assert.equal((await f.send({ projectId: "beta", sessionId: "second", requestId: uuid(4) })).status, 200);
  discard(replacement, uuid(2));
  discard(live, uuid(2), "tool");
  f.bus.emit("agent/disposed", { agent: replacement });
  f.bus.emit("session/disposed", replacement.session);
  assert.deepEqual(shape(await f.events()), [[uuid(1), "stopped"]]);
  claim(f.bus, live, uuid(2));
  f.bus.emit("session/disposed", live.session);
  f.bus.emit("agent/disposed", { agent: live });
  f.bus.emit("agent/disposed", { agent: other });
  assert.deepEqual(shape(await f.events()), [1, 2, 3, 4].map((n) => [uuid(n), "stopped"]));
});

test("approval dwell is canceled only by its matching audit decision or by turn end", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const bus = eventBus();
  const observer = createTaskEvents(bus)!;
  t.after(() => observer.close());
  const live = agent("first");
  const unrelated = agent("first");
  const ask = (id: string) => sessionEvent(bus, live.session, "approval/asked", { id, toolName: "Synthetic private tool", reason: "Synthetic private reason" });
  const decide = (id: string, a = live) => sessionEvent(bus, a.session, "approval/decided", { id, outcome: "cancelled" });
  const pending = observer.track(uuid(1), live, live.session)!;
  ask("never-claimed");
  claim(bus, live, uuid(1));
  ask("quick");
  t.mock.timers.tick(500);
  decide("quick");
  t.mock.timers.tick(1_000);
  pending.accept();
  assert.deepEqual(observer.read(), []); // Neither the unclaimed ask nor the decided ask survived.
  ask("dwell");
  decide("another-approval");
  decide("dwell", unrelated);
  t.mock.timers.tick(749);
  assert.deepEqual(observer.read(), []);
  t.mock.timers.tick(1);
  assert.deepEqual(shape(observer.read()), [[uuid(1), "attention"]]);
  ask("another-long-approval");
  t.mock.timers.tick(1_000);
  end(bus, live.session, "max-tokens");
  const staged = observer.track(uuid(2), live, live.session)!;
  claim(bus, live, uuid(2), 4);
  ask("before-receipt");
  t.mock.timers.tick(750);
  const seen = observer.read();
  assert.deepEqual(shape(seen), [[uuid(1), "attention"], [uuid(1), "stopped"]]);
  staged.accept();
  end(bus, live.session, "completed", 4);
  observer.track(uuid(3), live, live.session)!.accept();
  claim(bus, live, uuid(3), 5);
  ask("ending");
  end(bus, live.session, "completed", 5);
  t.mock.timers.tick(1_000);
  assert.deepEqual(shape(observer.read()), [
    [uuid(1), "attention"], [uuid(1), "stopped"], [uuid(2), "attention"], [uuid(2), "completed"], [uuid(3), "completed"],
  ]);
});

test("an actual DSH question call prompts attention, not unrelated or already answered tools", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const bus = eventBus();
  const observer = createTaskEvents(bus)!;
  t.after(() => observer.close());
  const a = agent("decision-session");
  const id = uuid(9);
  observer.track(id, a, a.session)!.accept();
  claim(bus, a, id, 3);
  const ask = (callId: string, turn = 3, name = "ask_user_question") =>
    sessionEvent(bus, a.session, "tool/call", { turn, step: 2, name, callId, arguments: "SECRET_QUESTION" });
  ask("different-turn", 2);
  ask("other-tool", 3, "arbitrary_tool");
  ask("quick-answer");
  sessionEvent(bus, a.session, "tool/result", { turn: 3, step: 2, message: { toolCallId: "quick-answer", content: "SECRET_ANSWER" } });
  t.mock.timers.tick(750);
  assert.deepEqual(observer.read(), []);
  ask("waiting-question");
  sessionEvent(bus, a.session, "approval/decided", { id: "waiting-question", outcome: "allowed-once" });
  t.mock.timers.tick(750);
  assert.deepEqual(shape(observer.read()), [[id, "attention"]]);
});

test("unofficial reuse of a request UUID suppresses ambiguous staged observations", (t) => {
  const bus = eventBus();
  const observer = createTaskEvents(bus)!;
  t.after(() => observer.close());
  const live = agent("first");
  const id = uuid(1);
  const pending = observer.track(id, live, live.session)!;
  claim(bus, live, id);
  step(bus, live.session);
  assert.equal(observer.track(id, live, live.session), undefined);
  pending.accept();
  end(bus, live.session);
  claim(bus, live, id, 4);
  end(bus, live.session, "completed", 4);
  assert.deepEqual(observer.read(), []);
});

test("task and observation limits evict stale work without consuming reads", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const bus = eventBus();
  const observer = createTaskEvents(bus)!;
  t.after(() => observer.close());
  const live = agent("first");
  observer.track(uuid(0), live, live.session)!.accept();
  for (let i = 1; i <= 300; i++) {
    observer.track(uuid(i), live, live.session)!.accept();
    claim(bus, live, uuid(i), i);
    end(bus, live.session, "completed", i);
  }
  const last = observer.read();
  assert.equal(last.length, RUNTIME_TASK_EVENTS_LIMIT);
  assert.deepEqual(shape(last), Array.from({ length: RUNTIME_TASK_EVENTS_LIMIT }, (_, i) => [uuid(301 - RUNTIME_TASK_EVENTS_LIMIT + i), "completed"]));
  claim(bus, live, uuid(0));
  end(bus, live.session);
  assert.deepEqual(observer.read(), last);
  t.mock.timers.tick(15 * 60_000);
  assert.deepEqual(observer.read(), []);
  observer.track(uuid(301), live, live.session)!.accept();
  t.mock.timers.tick(60 * 60_000);
  claim(bus, live, uuid(301));
  end(bus, live.session);
  assert.deepEqual(observer.read(), []);
});

test("installed Cordis Loader uses scoped receiver and exact positional event arguments", {
  skip: !unix || !dshPackage, timeout: 15_000,
}, async (t) => {
  const f = await setup(t, false);
  const manifest = JSON.parse(await readFile(dshPackage!, "utf8")) as { name: string; version: string };
  assert.equal(manifest.name, "@deepseek-ai/dsh");
  assert.equal(manifest.version, "0.2.1-rc.3");
  const resolve = createRequire(dshPackage!).resolve;
  const installed = (name: string) => import(pathToFileURL(resolve(name)).href);
  type Context = {
    fiber: { dispose(): Promise<void> };
    plugin(plugin: unknown, config: object): PromiseLike<unknown>;
    provide(name: string, service: unknown): Dispose;
    get(name: string): { create(row: object): Promise<unknown>; await(): Promise<void> };
    emit(receiver: object, name: string, ...args: unknown[]): void;
    events: { dispatch(mode: string, args: unknown[]): Listener[] };
  };
  const { Context } = await installed("@deepseek-ai/cordis") as { Context: new () => Context };
  const { default: Loader } = await installed("@deepseek-ai/cordis-plugin-loader");
  const { createScope, scopeTarget } = await installed("@deepseek-ai/dsh-scope") as {
    createScope(ctx: Context, key: object): { ctx: Context };
    scopeTarget(subject: object, key: object): object;
  };
  const root = new Context();
  try {
    await root.plugin(Loader, { baseUrl: pathToFileURL(f.dir + "/").href });
    const loader = root.get("loader");
    await loader.create({ id: "bridge", name: entry.href, config: { ...profile, socketPath: f.socketPath } });
    for (const [name, service] of Object.entries(f.services)) root.provide(name, service);
    await loader.await();
    const live = f.live.get("first")!;
    const key = {};
    const scoped = createScope(root, key).ctx;
    const target = scopeTarget(live, key);
    const announce = (session: object, type: string, data: object) => {
      const event = { type, data };
      // Session observers receive the post-commit dispatch snapshot, with the
      // exact Session and event as positional args, not the routing-only carrier.
      for (const listener of scoped.events.dispatch("emit", [scopeTarget(session, key), "session/event", session, event])) listener(session, event);
    };
    f.control.prompt = async ({ requestId }) => {
      scoped.emit(target, "agent/inbox/claimed", { agent: live, message: { source: { kind: "user", rpcId: requestId } }, turn: 1 });
      announce({ ...live.session }, "turn/end", { turn: 1, reason: { kind: "completed" } });
      announce(live.session, "step/end", { turn: 1, step: 1 });
      announce(live.session, "turn/end", { turn: 1, reason: { kind: "completed" } });
      return { accepted: true };
    };
    assert.equal((await f.send()).status, 200);
    assert.deepEqual(shape(await f.events()), [[uuid(1), "progress"], [uuid(1), "completed"]]);
  } finally {
    await root.fiber.dispose();
  }
  await assert.rejects(lstat(f.socketPath), { code: "ENOENT" });
});
