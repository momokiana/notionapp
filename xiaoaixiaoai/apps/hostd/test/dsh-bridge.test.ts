import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import {
  DSH_ARCHIVE, DSH_DIRECTORY_PAGE_SIZE, DSH_DIRECTORY_SEARCH_LIMIT, DSH_UNFILED,
  type DshDirectoryReply, type DshDirectoryRequest,
} from "../../../packages/protocol/src/index.ts";

const entry = new URL("../integrations/dsh/index.mjs", import.meta.url);
const requestId = "00000000-0000-4000-8000-000000000001";
const input = { projectId: "second", sessionId: "live", requestId, text: "  synthetic\n小爱  " };
const json = { "content-type": "application/json" };
const unix = process.geteuid !== undefined;
const fixtureTest = (name: string, run: (t: TestContext) => Promise<void>) => test(name, { skip: !unix, timeout: 15_000 }, run);

type Dispose = () => Promise<void>;
type Prompt = { sessionId: string; requestId: string; mode: string; content: Array<{ type: string; text: string }> };
const { default: bridge } = await import(entry.href) as {
  default: { inject: string[]; apply: (ctx: ReturnType<typeof fixture>["ctx"], config: unknown) => Promise<Dispose> };
};

function summary(sessionId: string, title: string, fields = {}) {
  return {
    sessionId, updatedAt: 1, agentAvailable: true, running: false, blank: false, formatStatus: "current",
    cwd: "/private/cwd", projections: { kind: "sequenced", asOfSeq: 1, values: {
      title, workingDirectory: "/private/dir", inbox: { "next-turn": ["private prompt"], "next-step": [] },
      body: "private transcript",
    } },
    ...fields,
  };
}
function agent(id: string, status = "idle", origin?: string) {
  return { id, status, session: { id, header: { id, origin, cwd: "/private/cwd" } } };
}
function fixture() {
  const live = new Map([
    ["live", agent("live", "running")], ["locked", agent("locked")], ["archived", agent("archived")],
    ["child", agent("child", "idle", "subagent")], ["owned-child", agent("owned-child")], ["fork", agent("fork")],
  ]);
  const items = [
    summary("locked", "Another session"), summary("cold", "Cold title", { agentAvailable: false }),
    summary("outside-session", "Invisible"), summary("child", "Subagent", { origin: "subagent", parentSessionId: "live" }),
    summary("migrating", "Old session", { agentAvailable: false, formatStatus: "migration-required" }),
    summary("live", "Running\n title", { running: true }), summary("owned-child", "Owned subagent"),
    summary("archived", "Archived"), summary("fork", "/private/title-is-a-path", { parentSessionId: "live" }),
  ];
  const workspaces = new Map([
    ["first", { id: "first", title: "/private/workspace-title", sessionIds: ["fork", "locked"] }],
    ["outside", { id: "outside", title: "Invisible", sessionIds: ["outside-session"] }],
    ["second", { id: "second", title: "Selected", sessionIds: ["cold", "live", "missing", "archived", "child", "owned-child", "migrating"] }],
  ]);
  const archived = ["archived"];
  const prompts: Prompt[] = [];
  const control = {
    async list(_signal: AbortSignal): Promise<unknown> { return { items }; },
    async prompt(_signal: AbortSignal): Promise<unknown> { return { accepted: true, secret: "private detail" }; },
  };
  const ctx = {
    workspaceRegistry: { get: (id: string) => workspaces.get(id), list: () => [...workspaces.values()], archivedSessionIds: archived },
    agents: { get: (id: string) => live.get(id), roots: () => [...live.values()].filter((a) => a.id !== "owned-child") },
    sessionController: {
      list(params: object, signal: AbortSignal) {
        assert.deepEqual(params, {});
        assert.ok(signal instanceof AbortSignal);
        return control.list(signal);
      },
      prompt(params: Prompt, signal: AbortSignal) {
        assert.equal(signal.aborted, false);
        prompts.push(params);
        return control.prompt(signal);
      },
    },
  };
  return { ctx, live, items, workspaces, archived, prompts, control };
}

type Reply = { status: number | undefined; body: unknown; headers: Record<string, unknown> };
function exchange(socketPath: string, method: string, path: string, body?: Buffer | string, headers = {}) {
  return new Promise<Reply>((resolve, reject) => {
    const req = request({ socketPath, method, path, agent: false, headers, signal: AbortSignal.timeout(10_000) }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString()), headers: res.headers }); }
        catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function setup(t: TestContext, scope: { workspaceIds?: string[]; workspaceScope?: "all" } = { workspaceIds: ["second", "first"] }) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "xax-dsh-"));
  const socketPath = join(dir, "bridge.sock");
  const fake = fixture();
  const config = {
    socketPath, ...scope,
    sendAllowlist: ["live", "cold", "archived", "child", "owned-child", "locked"].map((sessionId) => ({ workspaceId: "second", sessionId })),
  };
  let close: Dispose | undefined;
  t.after(async () => {
    await close?.();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    ...fake, dir, socketPath, config,
    start: async (more = {}) => { close = await bridge.apply(fake.ctx, { ...config, ...more }); return close; },
    catalog: () => exchange(socketPath, "GET", "/v1/catalog"),
    browse: (query: unknown) => exchange(socketPath, "POST", "/v2/browse", JSON.stringify(query), json),
    send: (more = {}) => exchange(socketPath, "POST", "/v1/send", JSON.stringify({ ...input, ...more }), json),
  };
}

async function readDirectory<V extends DshDirectoryRequest["view"]>(
  f: Awaited<ReturnType<typeof setup>>, query: DshDirectoryRequest & { view: V },
): Promise<Extract<DshDirectoryReply, { view: V }>> {
  const { status, body, headers } = await f.browse(query);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(headers["cache-control"], "no-store");
  assert.equal((body as DshDirectoryReply).view, query.view);
  return body as Extract<DshDirectoryReply, { view: V }>;
}

fixtureTest("catalog is opt-in, bounded, ordered, and projects only metadata", async (t) => {
  const f = await setup(t);
  const close = await f.start();
  assert.equal((await lstat(f.dir)).mode & 0o7777, 0o700);
  assert.equal((await lstat(f.socketPath)).uid, process.geteuid!());
  assert.equal((await lstat(f.socketPath)).mode & 0o7777, 0o600);
  const observed = await f.catalog();
  assert.equal(observed.status, 200);
  assert.equal(observed.headers["cache-control"], "no-store");
  assert.deepEqual(observed.body, { projects: [
    { id: "second", title: "Selected", sessions: [
      { id: "cold", title: "Cold title", state: "inactive", canSend: false },
      { id: "live", title: "Running title", state: "running", canSend: false },
      { id: "migrating", title: "Old session", state: "attention", canSend: false },
    ] },
    { id: "first", title: "工作区 first", sessions: [
      { id: "fork", title: "会话 fork", state: "idle", canSend: false },
      { id: "locked", title: "Another session", state: "idle", canSend: false },
    ] },
  ] });
  assert.deepEqual((await f.send()).body, { error: "not_allowed" });
  assert.equal(f.prompts.length, 0);
  await close();
  await assert.rejects(lstat(f.socketPath), { code: "ENOENT" });
});

fixtureTest("20 configured projects share a 100-row catalog budget", async (t) => {
  const f = await setup(t);
  const workspaceIds = Array.from({ length: 20 }, (_, i) => `p-${i}`);
  for (const id of workspaceIds) {
    const sessionIds = Array.from({ length: 12 }, (_, i) => `${id}-s-${i}`);
    f.workspaces.set(id, { id, title: id, sessionIds });
    f.items.push(...sessionIds.map((sid) => summary(sid, sid, { agentAvailable: false })));
  }
  await f.start({ workspaceIds, sendAllowlist: [] });
  const result = (await f.catalog()).body as { projects: Array<{ id: string; sessions: unknown[] }> };
  assert.deepEqual(result.projects.map((p) => p.id), workspaceIds);
  assert.equal(result.projects.flatMap((p) => p.sessions).length, 100);
  assert.equal(result.projects[8]?.sessions.length, 4);
  assert.equal(result.projects[9]?.sessions.length, 0);
});

fixtureTest("profile browse pages the whole registry by stable ID and searches only display metadata", async (t) => {
  const f = await setup(t, { workspaceScope: "all" });
  const bulk = Array.from({ length: 36 }, (_, i) => {
    const id = `project-${String(i).padStart(2, "0")}`;
    return { id, title: `Fixture project ${i}`, sessionIds: Array.from({ length: 4 }, (_, j) => `${id}-session-${j}`) };
  });
  const last = bulk.at(-1)!;
  const needleId = last.sessionIds.at(-1)!;
  for (const project of [...bulk].reverse()) {
    f.workspaces.set(project.id, project);
    for (const id of [...project.sessionIds].reverse()) {
      f.items.push(summary(id, id === needleId ? "  Late\n directory\t match  " : "Common session", { agentAvailable: false }));
    }
  }
  f.workspaces.set("empty", { id: "empty", title: "Empty fixture project", sessionIds: [] });
  await f.start();
  const legacy = await f.catalog();
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.body, { projects: [] });

  const projectIds = [...f.workspaces.keys(), DSH_ARCHIVE, DSH_UNFILED].sort();
  const projects = await readDirectory(f, { view: "projects" });
  assert.equal(projects.scope, "profile");
  assert.deepEqual(projects.projects.map((p) => p.id), projectIds.slice(0, DSH_DIRECTORY_PAGE_SIZE));
  assert.equal(projects.next, projectIds[DSH_DIRECTORY_PAGE_SIZE - 1]);
  const more = await readDirectory(f, { view: "projects", after: projects.next! });
  assert.equal(more.scope, "profile");
  assert.deepEqual(more.projects.map((p) => p.id), projectIds.slice(DSH_DIRECTORY_PAGE_SIZE));
  assert.equal(more.next, undefined);
  for (const project of [...projects.projects, ...more.projects]) {
    assert.deepEqual(Object.keys(project).sort(), ["id", "title"]);
  }

  const expectedIds = ["archived", "cold", "fork", "live", "locked", "migrating", "outside-session", ...bulk.flatMap((p) => p.sessionIds)].sort();
  let after: string | undefined;
  for (let offset = 0; offset < expectedIds.length; offset += DSH_DIRECTORY_PAGE_SIZE) {
    const result = await readDirectory(f, { view: "sessions", ...(after === undefined ? {} : { after }) });
    const expected = expectedIds.slice(offset, offset + DSH_DIRECTORY_PAGE_SIZE);
    assert.equal(result.scope, "profile");
    assert.deepEqual(result.entries.map((entry) => entry.session.id), expected);
    assert.equal(result.next, offset + DSH_DIRECTORY_PAGE_SIZE < expectedIds.length ? expected.at(-1) : undefined);
    after = result.next;
    if (offset === 0) {
      // A removed cursor must not cause a restart, error, or skipped successor.
      const index = f.items.findIndex((row) => row.sessionId === after);
      assert.notEqual(index, -1);
      f.items.splice(index, 1);
    }
  }

  const byProject = await readDirectory(f, { view: "sessions", projectId: last.id });
  assert.deepEqual(byProject.entries.map((entry) => entry.session.id), last.sessionIds);
  assert.equal(byProject.next, undefined);
  for (const search of ["directory match", needleId]) {
    assert.deepEqual(await readDirectory(f, { view: "sessions", search }), {
      view: "sessions", scope: "profile", entries: [{
        project: { id: last.id, title: last.title },
        session: { id: needleId, title: "Late directory match", state: "inactive", canSend: false }, archived: false,
      }],
    });
  }
  for (const search of ["second", "Selected"]) {
    const byProjectMetadata = await readDirectory(f, { view: "sessions", search });
    assert.deepEqual(byProjectMetadata.entries.map((entry) => entry.session.id), ["cold", "live", "migrating"]);
  }
  for (const search of ["/private/cwd", "/private/dir", "private transcript", "private prompt", "title-is-a-path", "workspace-title"]) {
    assert.deepEqual((await readDirectory(f, { view: "sessions", search })).entries, [], search);
  }
  assert.deepEqual(f.prompts, []);
});

for (const scope of ["profile", "selected"] as const) {
  fixtureTest(`${scope} browse applies the same visibility to direct and paged lookups`, async (t) => {
    const f = await setup(t, scope === "profile" ? { workspaceScope: "all" } : undefined);
    f.live.set("unfiled-root", agent("unfiled-root"));
    f.items.push(
      summary("unfiled-root", "Unfiled fixture"),
      summary("cold-child", "Private cold subagent", { agentAvailable: false, origin: "subagent", parentSessionId: "live" }),
      summary("ambiguous", "Private duplicate A"), summary("ambiguous", "Private duplicate B"),
      summary("broken", "Private malformed row", { formatStatus: "unsupported" }),
      summary("bad id", "Private invalid ID"),
    );
    f.workspaces.get("second")!.sessionIds.push("cold-child", "ambiguous", "broken", "bad id");
    await f.start({ enableSend: true });

    const isProfile = scope === "profile";
    const projects = await readDirectory(f, { view: "projects" });
    assert.equal(projects.scope, scope);
    assert.deepEqual(projects.projects.map((p) => p.id).sort(), isProfile ?
      [DSH_ARCHIVE, DSH_UNFILED, "first", "outside", "second"].sort() : ["first", "second"]);

    const sessionIds = [
      "outside-session", "unfiled-root", "archived", "live", "fork", "child", "cold-child", "owned-child", "missing", "ambiguous", "broken",
    ];
    const exact = await readDirectory(f, { view: "exact", sessionIds });
    assert.equal(exact.scope, scope);
    assert.equal(Object.hasOwn(exact, "next"), false);
    assert.deepEqual(exact.entries.map((item) => item.session.id).sort(), isProfile ?
      ["archived", "fork", "live", "outside-session", "unfiled-root"] : ["fork", "live"]);
    const byId = new Map(exact.entries.map((item) => [item.session.id, item]));
    assert.deepEqual(byId.get("fork"), {
      project: { id: "first", title: "工作区 first" },
      session: { id: "fork", title: "会话 fork", state: "idle", canSend: false }, archived: false,
    });
    assert.equal(byId.get("live")?.session.canSend, true);
    for (const [projectId, sessionId, archived] of [
      [DSH_ARCHIVE, "archived", true], [DSH_UNFILED, "unfiled-root", false], ["outside", "outside-session", false],
    ] as const) {
      const listing = await readDirectory(f, { view: "sessions", projectId });
      assert.equal(listing.scope, scope);
      if (!isProfile) {
        assert.deepEqual(listing.entries, []);
        assert.deepEqual((await readDirectory(f, { view: "sessions", search: sessionId })).entries, []);
        continue;
      }
      const item = byId.get(sessionId)!;
      assert.deepEqual(listing.entries, [item]);
      assert.equal(item.project.id, projectId);
      assert.equal(item.archived, archived);
      assert.equal(item.session.canSend, false);
    }
    const paged = await readDirectory(f, { view: "sessions" });
    assert.deepEqual(paged.entries.map((item) => item.session.id), isProfile ?
      ["archived", "cold", "fork", "live", "locked", "migrating", "outside-session", "unfiled-root"] :
      ["cold", "fork", "live", "locked", "migrating"]);
    assert.doesNotMatch(JSON.stringify([projects, exact, paged]), /\/private|private prompt|private transcript|Private duplicate|Private invalid ID|Private malformed row/);
    assert.deepEqual(f.prompts, []);
    assert.equal((await f.send({ sessionId: "archived" })).status, 404);
    assert.equal((await f.send({ projectId: DSH_UNFILED, sessionId: "unfiled-root" })).status, 403);
    assert.deepEqual(f.prompts, []);
  });
}

fixtureTest("exact follow tracks a moved session without transferring its write grant", async (t) => {
  const f = await setup(t, { workspaceScope: "all" });
  const grant = { workspaceId: "second", sessionId: "live" };
  const follow = () => readDirectory(f, { view: "exact", sessionIds: ["live"] });
  for (const config of [{ sendAllowlist: [grant] }, { enableSend: true, sendAllowlist: [] }]) {
    const close = await f.start(config);
    const { entries } = await follow();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.session.canSend, false);
    assert.equal((await f.send()).status, 403);
    await close();
  }
  await f.start({ enableSend: true, sendAllowlist: [grant] });
  assert.deepEqual(await follow(), {
    view: "exact", scope: "profile", entries: [{
      project: { id: "second", title: "Selected" },
      session: { id: "live", title: "Running title", state: "running", canSend: true }, archived: false,
    }],
  });
  assert.equal((await f.send({ projectId: "first", sessionId: "locked" })).status, 403);
  assert.equal((await f.send({ sessionId: "cold" })).status, 403);
  assert.deepEqual(f.prompts, []);
  assert.deepEqual((await f.send()).body, { accepted: true, requestId });
  assert.deepEqual(f.prompts, [{ sessionId: "live", requestId, mode: "queue", content: [{ type: "text", text: input.text }] }]);

  const previous = f.workspaces.get("second")!;
  previous.sessionIds = previous.sessionIds.filter((id) => id !== "live");
  f.workspaces.get("outside")!.sessionIds.push("live");
  assert.deepEqual(await follow(), {
    view: "exact", scope: "profile", entries: [{
      project: { id: "outside", title: "Invisible" },
      session: { id: "live", title: "Running title", state: "running", canSend: false }, archived: false,
    }],
  });
  assert.deepEqual((await readDirectory(f, { view: "sessions", projectId: "second", search: "live" })).entries, []);
  assert.equal((await f.send()).status, 404);
  assert.equal((await f.send({ projectId: "outside" })).status, 403);
  assert.equal(f.prompts.length, 1);
});

fixtureTest("only explicitly allowlisted live Agent receives one plain queued prompt", async (t) => {
  const f = await setup(t);
  await f.start({ enableSend: true });
  const result = (await f.catalog()).body as { projects: Array<{ sessions: Array<{ id: string; canSend: boolean }> }> };
  assert.deepEqual(result.projects.flatMap((p) => p.sessions.filter((s) => s.canSend).map((s) => s.id)), ["live"]);
  for (const [target, code] of [
    [{ projectId: "first", sessionId: "locked" }, 403], [{ projectId: "outside" }, 403],
    [{ sessionId: "cold" }, 409], [{ sessionId: "archived" }, 404], [{ sessionId: "locked" }, 404],
    [{ sessionId: "child" }, 409], [{ sessionId: "owned-child" }, 409],
  ] as const) assert.equal((await f.send(target)).status, code);
  assert.equal(f.prompts.length, 0);
  let finish!: (value: unknown) => void;
  let started!: () => void;
  const waiting = new Promise<void>((ok) => { started = ok; });
  f.control.prompt = () => new Promise((ok) => { finish = ok; started(); });
  const sending = f.send();
  await waiting;
  assert.deepEqual(f.prompts, [{ sessionId: "live", requestId, mode: "queue", content: [{ type: "text", text: input.text }] }]);
  assert.equal(await Promise.race([sending, delay(20, "pending")]), "pending");
  finish({ accepted: true, extra: "never forward" });
  const observed = await sending;
  assert.equal(observed.status, 200);
  assert.deepEqual(observed.body, { accepted: true, requestId });
  f.control.prompt = async () => ({ accepted: "true" });
  assert.deepEqual((await f.send()).body, { error: "unavailable" });
  f.control.prompt = async () => { throw new Error("/private/error with private prompt"); };
  assert.deepEqual((await f.send()).body, { error: "unavailable" });
});

fixtureTest("scope is rechecked after async discovery, including exact live and workspace identities", async (t) => {
  const f = await setup(t);
  await f.start({ enableSend: true });
  const initialWorkspace = f.workspaces.get("second")!;
  const initialAgent = f.live.get("live")!;
  for (const mutate of [
    () => { initialWorkspace.sessionIds = []; },
    () => { f.archived.push("live"); },
    () => { f.live.delete("live"); },
    () => { f.live.set("live", agent("live")); },
    () => { f.workspaces.set("second", { ...initialWorkspace }); },
  ]) {
    const membership = initialWorkspace.sessionIds;
    f.control.list = async () => { await delay(1); mutate(); return { items: f.items }; };
    assert.ok([404, 409].includes((await f.send()).status!));
    assert.equal(f.prompts.length, 0);
    f.workspaces.set("second", initialWorkspace);
    initialWorkspace.sessionIds = membership;
    f.live.set("live", initialAgent);
    f.archived.splice(1);
  }
  f.control.list = async () => ({ items: f.items.filter((row) => row.sessionId !== "live") });
  assert.equal((await f.send()).status, 409);
  f.control.list = async () => ({ items: [...f.items, summary("live", "Duplicate")] });
  assert.equal((await f.send()).status, 409);
  assert.equal(f.prompts.length, 0);
});

fixtureTest("rejects noncanonical routes and unsafe request shapes before any prompt", async (t) => {
  const f = await setup(t);
  await f.start({ enableSend: true });
  assert.equal((await exchange(f.socketPath, "GET", "/v1/catalog?extra=true")).status, 404);
  assert.equal((await exchange(f.socketPath, "GET", "/v1/history")).status, 404);
  assert.equal((await exchange(f.socketPath, "POST", "/v1/catalog", "x")).status, 405);
  assert.equal((await exchange(f.socketPath, "GET", "/v1/send")).status, 405);
  assert.equal((await exchange(f.socketPath, "POST", "/v1/send", "{}", { "content-type": "text/plain" })).status, 415);
  assert.equal((await exchange(f.socketPath, "POST", "/v1/send", "{", json)).status, 400);
  assert.equal((await exchange(f.socketPath, "POST", "/v1/send", Buffer.from([0xff]), json)).status, 400);
  assert.equal((await exchange(f.socketPath, "POST", "/v1/send", "x".repeat(33_000), json)).status, 413);
  assert.equal((await exchange(f.socketPath, "POST", "/v1/send", "x".repeat(33_000), { ...json, "transfer-encoding": "chunked" })).status, 413);
  for (const fields of [{ mode: "steer" }, { requestId: "not-uuid" }, { text: " " }, { text: "\0" }, { text: "x".repeat(4001) }]) {
    assert.equal((await f.send(fields)).status, 400);
  }
  assert.equal(f.prompts.length, 0);
});

fixtureTest("browse requires strict JSON and validates each view's fields", async (t) => {
  const f = await setup(t);
  await f.start();
  assert.equal((await exchange(f.socketPath, "GET", "/v2/browse")).status, 405);
  assert.equal((await exchange(f.socketPath, "POST", "/v2/browse?extra=true", "{}", json)).status, 404);
  assert.equal((await exchange(f.socketPath, "POST", "/v2/browse", '{"view":"projects"}', { "content-type": "text/plain" })).status, 415);
  for (const body of ["{", Buffer.from([0xff])]) {
    assert.equal((await exchange(f.socketPath, "POST", "/v2/browse", body, json)).status, 400);
  }
  const sessionIds = ["live", ...Array.from({ length: DSH_DIRECTORY_PAGE_SIZE - 1 }, (_, i) => `missing-${i}`)];
  for (const query of [
    null, [], { view: "unknown" },
    { view: "projects", projectId: "second" }, { view: "projects", after: "bad id" },
    { view: "sessions", projectId: null }, { view: "sessions", sessionIds: ["live"] },
    { view: "sessions", search: 12 }, { view: "sessions", search: "x".repeat(DSH_DIRECTORY_SEARCH_LIMIT + 1) },
    { view: "exact" }, { view: "exact", sessionIds: [] }, { view: "exact", sessionIds: ["bad id"] },
    { view: "exact", sessionIds: ["live", "live"] }, { view: "exact", sessionIds: [...sessionIds, "overflow"] },
    { view: "exact", sessionIds: ["live"], after: "live" },
  ]) {
    const result = await f.browse(query);
    assert.equal(result.status, 400, JSON.stringify(query));
    assert.deepEqual(result.body, { error: "invalid_request" });
  }
  const exact = await readDirectory(f, { view: "exact", sessionIds });
  assert.deepEqual(exact.entries.map((item) => item.session.id), ["live"]);
  assert.equal(Object.hasOwn(exact, "next"), false);
  assert.deepEqual(f.prompts, []);
});

fixtureTest("refuses loose or symlinked directories, occupied sockets, and non-explicit config", async (t) => {
  const f = await setup(t);
  const noScope = await setup(t, {});
  await assert.rejects(noScope.start(), /Invalid DSH bridge configuration/);
  await assert.rejects(noScope.start({ workspaceScope: "*" }), /Invalid DSH bridge configuration/);
  for (const overrides of [
    { workspaceScope: "all" }, { workspaceIds: [] }, { workspaceIds: ["*"] }, { workspaceIds: ["second", "second"] },
    { workspaceIds: Array.from({ length: 21 }, (_, i) => `p-${i}`), sendAllowlist: [] },
    { enableSend: "true" }, { sendAllowlist: [{ workspaceId: "outside", sessionId: "outside-session" }] },
    { socketPath: "\0abstract" }, { socketPath: "relative.sock" },
  ]) await assert.rejects(f.start(overrides), /Invalid DSH bridge configuration/);
  await chmod(f.dir, 0o750);
  await assert.rejects(f.start(), /DSH bridge cannot start/);
  await chmod(f.dir, 0o700);
  const actual = join(f.dir, "actual");
  const alias = join(f.dir, "alias");
  await mkdir(actual, { mode: 0o700 });
  await symlink(actual, alias);
  await assert.rejects(f.start({ socketPath: join(alias, "bridge.sock") }), /DSH bridge cannot start/);
  await chmod(f.dir, 0o777);
  await assert.rejects(f.start({ socketPath: join(actual, "bridge.sock") }), /DSH bridge cannot start/);
  await chmod(f.dir, 0o700);
  await writeFile(f.socketPath, "keep me");
  await assert.rejects(f.start(), /DSH bridge cannot start/);
  assert.equal(await readFile(f.socketPath, "utf8"), "keep me");
  await rm(f.socketPath);
  const other = createServer();
  await new Promise<void>((ok, fail) => { other.once("error", fail); other.listen(f.socketPath, ok); });
  try {
    const before = await lstat(f.socketPath);
    await assert.rejects(f.start(), /DSH bridge cannot start/);
    assert.equal((await lstat(f.socketPath)).ino, before.ino);
  } finally {
    await new Promise<void>((ok) => { other.close(() => ok()); });
  }
  // Move the test socket out of Node's normal close cleanup to leave a stale inode.
  const orphanSource = join(f.dir, "orphan.sock");
  await new Promise<void>((ok) => { other.listen(orphanSource, ok); });
  await rename(orphanSource, f.socketPath);
  await new Promise<void>((ok) => { other.close(() => ok()); });
  const stale = await lstat(f.socketPath);
  assert.ok(stale.isSocket());
  await assert.rejects(f.start(), /DSH bridge cannot start/);
  assert.equal((await lstat(f.socketPath)).ino, stale.ino);
});

fixtureTest("client disconnect and plugin dispose abort outstanding calls and teardown the socket", async (t) => {
  const f = await setup(t);
  const close = await f.start({ enableSend: true });
  let started!: (signal: AbortSignal) => void;
  let waiting = new Promise<AbortSignal>((ok) => { started = ok; });
  f.control.list = (signal) => new Promise((_ok, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    started(signal);
  });
  const client = request({ socketPath: f.socketPath, path: "/v1/catalog", agent: false });
  client.on("error", () => {});
  client.end();
  const signal = await waiting;
  const aborted = new Promise<void>((ok) => { signal.addEventListener("abort", () => ok(), { once: true }); });
  client.destroy();
  await aborted;
  waiting = new Promise<AbortSignal>((ok) => { started = ok; });
  const disconnected = assert.rejects(f.send());
  const sendSignal = await waiting;
  await close();
  await disconnected;
  assert.equal(sendSignal.aborted, true);
  await assert.rejects(lstat(f.socketPath), { code: "ENOENT" });
  assert.equal(f.prompts.length, 0);
});

fixtureTest("bounds simultaneously open connections and aborts a slow service", async (t) => {
  const f = await setup(t);
  await f.start();
  const held = Array.from({ length: 8 }, () => createConnection(f.socketPath));
  t.after(() => { for (const sock of held) sock.destroy(); });
  await Promise.all(held.map((sock) => new Promise<void>((ok, fail) => { sock.once("error", fail); sock.once("connect", ok); })));
  await assert.rejects(f.catalog());
  await Promise.all(held.map((sock) => new Promise<void>((ok) => { sock.once("close", () => ok()); sock.destroy(); })));
  let serviceSignal: AbortSignal | undefined;
  f.control.list = (signal) => new Promise((_ok, reject) => {
    serviceSignal = signal;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const observed = await f.catalog();
  assert.equal(observed.status, 504);
  assert.deepEqual(observed.body, { error: "timeout" });
  assert.ok(serviceSignal?.aborted);
});

fixtureTest("aborted upstream work continues to consume the bounded work budget until it settles", async (t) => {
  const f = await setup(t);
  await f.start();
  const finish: Array<() => void> = [];
  let arrived!: (signal: AbortSignal) => void;
  f.control.list = (signal) => new Promise((ok) => { finish.push(() => ok({ items: f.items })); arrived(signal); });
  try {
    for (let i = 0; i < 8; i++) {
      const waiting = new Promise<AbortSignal>((ok) => { arrived = ok; });
      const req = request({ socketPath: f.socketPath, path: "/v1/catalog", agent: false });
      req.on("error", () => {});
      req.end();
      const signal = await waiting;
      const aborted = new Promise<void>((ok) => { signal.addEventListener("abort", () => ok(), { once: true }); });
      req.destroy();
      await aborted;
    }
    const observed = await f.catalog();
    assert.equal(observed.status, 503);
    assert.deepEqual(observed.body, { error: "unavailable" });
    assert.equal(finish.length, 8);
  } finally {
    for (const release of finish) release();
  }
  f.control.list = async () => ({ items: f.items });
  assert.equal((await f.catalog()).status, 200);
});

const dshPackage = process.env.DSH_TEST_PACKAGE;
test("installed Cordis Loader activates and disposes the file-URL plugin with synthetic services", {
  skip: !unix || !dshPackage, timeout: 15_000,
}, async (t) => {
  const f = await setup(t);
  const manifest = JSON.parse(await readFile(dshPackage!, "utf8")) as { name: string; version: string };
  assert.equal(manifest.name, "@deepseek-ai/dsh");
  assert.equal(manifest.version, "0.2.1-rc.3");
  const resolveFromDsh = createRequire(dshPackage!).resolve;
  const installed = (name: string) => import(pathToFileURL(resolveFromDsh(name)).href);
  const { Context } = await installed("@deepseek-ai/cordis") as { Context: new () => {
    fiber: { dispose(): Promise<void> };
    plugin(plugin: unknown, config?: unknown): PromiseLike<unknown>;
    provide(name: string, service: unknown): Dispose;
    get(name: string): { create(row: object): Promise<unknown>; await(): Promise<void> };
  } };
  const { default: Loader } = await installed("@deepseek-ai/cordis-plugin-loader");
  const root = new Context();
  try {
    await root.plugin(Loader, { baseUrl: pathToFileURL(f.dir + "/").href });
    const loader = root.get("loader");
    await loader.create({ id: "bridge", name: entry.href, config: { ...f.config, enableSend: true } });
    await assert.rejects(lstat(f.socketPath), { code: "ENOENT" });
    let unmountWorkspace!: Dispose;
    for (const name of bridge.inject as Array<keyof typeof f.ctx>) {
      const unmount = root.provide(name, f.ctx[name]);
      if (name === "workspaceRegistry") unmountWorkspace = unmount;
    }
    await loader.await();
    assert.equal((await f.catalog()).status, 200);
    assert.deepEqual((await f.send()).body, { accepted: true, requestId });
    await unmountWorkspace();
    await assert.rejects(lstat(f.socketPath), { code: "ENOENT" });
  } finally {
    await root.fiber.dispose();
  }
});

test("POST /v4/detail inspects cold and live sessions with bounded events and pending questions", async (t) => {
  const f = await setup(t);
  const inspected: string[] = [];
  const ctx = f.ctx as Record<string, unknown>;
  (ctx.sessionController as Record<string, unknown>).inspect = async (sessionId: string, signal: AbortSignal) => {
    assert.equal(signal.aborted, false);
    inspected.push(sessionId);
    return {
      events: [
        { type: "user/message", seq: 1, time: 1000, data: { source: { kind: "user" }, content: [{ type: "text", text: "检查冷会话详情" }] } },
        { type: "tool/call", seq: 2, time: 1500, data: { callId: "t-1", name: "read_file" } },
        { type: "tool/result", seq: 3, time: 1600, data: { message: { toolCallId: "t-1", isError: false } } },
        {
          type: "tool/ptc-dispatch",
          seq: 4,
          time: 1800,
          data: {
            name: "ask_user_question",
            subCallId: "cont-cold-1",
            content: [{ type: "text", text: JSON.stringify({ pending: true }) }],
            arguments: { questions: [{ id: "q1", question: "是否继续部署？", options: [{ label: "是" }, { label: "否" }], multiSelect: false }] },
          },
        },
        { type: "assistant/message", seq: 5, time: 2000, data: { message: { content: [{ type: "text", text: "等待你的选择。" }] } } },
      ],
    };
  };
  await f.start({ enableSend: true });

  const res = await exchange(f.socketPath, "POST", "/v4/detail", JSON.stringify({ projectId: "second", sessionId: "cold", limit: 20 }), json);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(inspected, ["cold"]);
  const body = res.body as { project: { id: string }; session: { id: string; state: string; canSend: boolean }; messages: Array<{ role: string; text: string }>; pendingQuestions: Array<{ callId: string; state: string }> };
  assert.equal(body.project.id, "second");
  assert.equal(body.session.id, "cold");
  assert.equal(body.session.canSend, false);
  assert.deepEqual(body.messages.map((m) => m.role), ["user", "tool", "assistant"]);
  assert.equal(body.messages[1]!.text, "read_file（完成）");
  assert.equal(body.pendingQuestions.length, 1);
  assert.equal(body.pendingQuestions[0]!.callId, "cont-cold-1");
  // Cold session with enableSend=true & resumeExisting=false is read-only, so pendingQuestions stays readonly.
  assert.equal(body.pendingQuestions[0]!.state, "readonly");

  // Live session with canSend=true exposes continued state so mobile can answer it.
  const liveRes = await exchange(f.socketPath, "POST", "/v4/detail", JSON.stringify({ projectId: "second", sessionId: "live", limit: 20 }), json);
  assert.equal(liveRes.status, 200, JSON.stringify(liveRes.body));
  const liveBody = liveRes.body as { pendingQuestions: Array<{ callId: string; state: string }> };
  assert.equal(liveBody.pendingQuestions[0]!.callId, "cont-cold-1");
  assert.equal(liveBody.pendingQuestions[0]!.state, "continued");
});

test("POST /v4/answer coordinates desktop vs mobile NO_PROVIDER waterfall and background continued answers", async (t) => {
  const f = await setup(t);
  let hook: ((req: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined;
  const answeredCalls: Array<{ callId: string; clean: unknown }> = [];
  const ctx = f.ctx as Record<string, unknown>;
  ctx.on = (ev: string, fn: (req: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
    if (ev === "user-questions/request") hook = fn;
    return () => { if (hook === fn) hook = undefined; };
  };
  (ctx.sessionController as Record<string, unknown>).inspect = async () => ({ events: [] });
  ctx.get = (name: string) => {
    if (name === "userQuestions") {
      return {
        answer: (targetAgent: unknown, callId: string, clean: unknown) => {
          assert.equal(targetAgent, f.live.get("live"));
          answeredCalls.push({ callId, clean });
          return true;
        },
      };
    }
    if (name === "sessionProjections") {
      return {
        stateOf: () => ({
          questions: {
            active: [{
              callId: "cont-bg-1",
              state: "continued",
              questions: [{ id: "q1", question: "后台继续吗？", options: [{ label: "确认" }, { label: "放弃" }], multiSelect: false }],
            }],
          },
        }),
      };
    }
    return undefined;
  };
  await f.start({ enableSend: true });
  assert.ok(hook);

  // 1) Desktop wins race
  const desktopWin = hook!(
    { agent: f.live.get("live"), questions: [{ id: "q1", question: "桌面还是手机？", options: [{ label: "桌面" }, { label: "手机" }] }], wait: { callId: "fg-win-1" } },
    async () => {
      await delay(25);
      return { answers: [{ id: "q1", selected: ["桌面"] }] };
    },
  );
  const duringFg = await exchange(f.socketPath, "POST", "/v2/browse", JSON.stringify({ view: "exact", sessionIds: ["live"] }), json);
  assert.equal((duringFg.body as { entries: Array<{ session: { state: string } }> }).entries[0]!.session.state, "attention");
  assert.deepEqual(await desktopWin, { answers: [{ id: "q1", selected: ["桌面"] }] });

  // 2) NO_PROVIDER triggers mobile answer path
  const mobileRace = hook!(
    { agent: f.live.get("live"), questions: [{ id: "q1", question: "选择构建模式", options: [{ label: "Debug" }, { label: "Release" }] }], wait: { callId: "fg-mob-2" } },
    async () => { throw Object.assign(new Error("no desktop ui"), { code: "NO_PROVIDER" }); },
  );
  await delay(15);
  const fgDetail = await exchange(f.socketPath, "POST", "/v4/detail", JSON.stringify({ projectId: "second", sessionId: "live", limit: 20 }), json);
  assert.equal((fgDetail.body as { pendingQuestions: Array<{ callId: string; state: string }> }).pendingQuestions[0]!.callId, "fg-mob-2");
  assert.equal((fgDetail.body as { pendingQuestions: Array<{ state: string }> }).pendingQuestions[0]!.state, "open");

  const ansReq1 = "22222222-2222-4222-8222-222222222222";
  const fgAns = await exchange(
    f.socketPath,
    "POST",
    "/v4/answer",
    JSON.stringify({ projectId: "second", sessionId: "live", requestId: ansReq1, callId: "fg-mob-2", answers: [{ id: "q1", selected: ["Release"] }] }),
    json,
  );
  assert.equal(fgAns.status, 200, JSON.stringify(fgAns.body));
  assert.deepEqual(await mobileRace, { answers: [{ id: "q1", selected: ["Release"] }] });

  // 3) Background continued question dispatches via userQuestions.answer
  const ansReq2 = "33333333-3333-4333-8333-333333333333";
  const bgAns = await exchange(
    f.socketPath,
    "POST",
    "/v4/answer",
    JSON.stringify({ projectId: "second", sessionId: "live", requestId: ansReq2, callId: "cont-bg-1", answers: [{ id: "q1", selected: ["确认"] }] }),
    json,
  );
  assert.equal(bgAns.status, 200, JSON.stringify(bgAns.body));
  assert.deepEqual(answeredCalls, [{ callId: "cont-bg-1", clean: { answers: [{ id: "q1", selected: ["确认"] }] } }]);
});

fixtureTest("/v5/create and /v5/cancel create sessions and interrupt active agents through RuntimeSessions", async (t) => {
  const { DshRuntime, RuntimeSessions } = await import("../src/runtime-sessions.ts");
  const f = await setup(t, { workspaceScope: "all" });
  const createdCalls: Array<Record<string, unknown>> = [];
  const cancelledCalls: Array<Record<string, unknown>> = [];
  (f.ctx.sessionController as Record<string, unknown>).create = async (params: Record<string, unknown>) => {
    createdCalls.push(params);
    const id = `created-${createdCalls.length}`;
    const ws = f.workspaces.get("second")!;
    ws.sessionIds = [...ws.sessionIds, id];
    f.items.push(summary(id, "New DSH session"));
    f.live.set(id, agent(id, "idle"));
    return { sessionId: id };
  };
  (f.ctx.sessionController as Record<string, unknown>).cancel = async (params: Record<string, unknown>) => {
    cancelledCalls.push(params);
    return { accepted: true };
  };
  delete (f.config as Record<string, unknown>).sendAllowlist;
  await f.start({ enableSend: true, sendScope: "profile" });

  const rs = new RuntimeSessions("viewer", { dsh: new DshRuntime(f.socketPath) }, join(f.dir, "dispatch"), { publishAgents: true });
  t.after(() => rs.close());
  assert.equal(rs.hasCreate, true);

  const opts = await rs.createOptions();
  assert.equal(opts.launchers[0]?.id, "dsh");
  assert.ok(opts.spaces.some((s) => s.id === "second"));

  const created = await rs.createSession({ runtime: "dsh", projectId: "second", task: "启动后开始巡检" });
  assert.equal(created.sessionId, "created-1");
  assert.equal(created.projectId, "second");
  assert.equal(created.state, "running");
  assert.deepEqual(createdCalls, [{ workspaceId: "second" }]);
  assert.equal(f.prompts.at(-1)?.sessionId, "created-1");
  assert.equal(f.prompts.at(-1)?.content[0]?.text, "启动后开始巡检");

  const interrupted = await rs.interrupt({ runtime: "dsh", projectId: "second", sessionId: "live" });
  assert.deepEqual(interrupted, { interrupted: true });
  assert.deepEqual(cancelledCalls, [{ sessionId: "live" }]);
});
