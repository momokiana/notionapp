import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeProject } from "@xiaoaixiaoai/protocol";
import { loadRuntimeSessions, RuntimeError, RuntimeSessions, type RuntimeAdapter } from "../src/runtime-sessions.ts";

const title = "同名项目";
const demo: RuntimeProject[] = [{ runtime: "dsh", id: "dsh-project", title, sessions: [{ id: "session-one", title: "测试会话", state: "idle", canSend: true }] }];
const folder = () => mkdtempSync(join(realpathSync(tmpdir()), "xa-runtime-"));
const receipt = (requestId: string) => ({ accepted: true as const, requestId, receiptId: "receipt-one" });
const has = (code: string) => (e: unknown) => e instanceof RuntimeError && e.code === code;
const message = () => ({ runtime: "dsh", projectId: "dsh-project", sessionId: "session-one", requestId: randomUUID(), input: "仅发往合成会话" });

test("catalog exports bounded metadata only and keeps same-name providers separate", async (t) => {
  const dir = folder(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const v = new RuntimeSessions("viewer", {
    dsh: { list: async () => [{ ...demo[0]!, path: "/private/local", sessions: [{ ...demo[0]!.sessions[0]!, preview: "PRIVATE_BODY", cwd: "/private/tree" }] }], send: async () => assert.fail("read must not send") },
    codex: { list: async () => [{ ...demo[0]!, runtime: "codex", id: "codex-project" }], send: async () => assert.fail("read must not send") },
  }, join(dir, "dispatch"));
  const data = await v.list();
  assert.deepEqual(data.runtimes, [{ runtime: "dsh", online: true }, { runtime: "codex", online: true }]);
  assert.deepEqual(data.projects, [...demo, { ...demo[0]!, runtime: "codex", id: "codex-project" }]);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_BODY|private\/local|private\/tree/);
});

test("the same accepted request never sends twice, even with a new host instance", async (t) => {
  const dir = folder(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = join(dir, "dispatch");
  let sent = 0;
  const a: RuntimeAdapter = { list: async () => demo, send: async (arg) => {
    sent++;
    assert.equal(arg.sessionId, "session-one");
    assert.equal(arg.text, "仅发往合成会话");
    return receipt(arg.requestId);
  } };
  const r = new RuntimeSessions("viewer", { dsh: a }, ledger);
  const input = message();
  assert.deepEqual(await r.send(input), receipt(input.requestId));
  const restarted = new RuntimeSessions("viewer", { dsh: a }, ledger);
  assert.deepEqual(await restarted.send(input), receipt(input.requestId));
  await assert.rejects(restarted.send({ ...input, sessionId: "different" }), has("bad_request"));
  await assert.rejects(restarted.send({ ...input, input: "changed task" }), has("bad_request"));
  await assert.rejects(restarted.send({ ...input, command: "not a supported input" }), has("bad_request"));
  assert.equal(sent, 1);
  const entries = readdirSync(ledger).map((name) => readFileSync(join(ledger, name), "utf8")).join("\n");
  assert.doesNotMatch(entries, /合成会话|session-one|dsh-project|viewer/);
});

test("an uncertain write stays fenced across a new process; no auto retry", async (t) => {
  const dir = folder(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let writes = 0;
  const adapter: RuntimeAdapter = { list: async () => demo, send: async () => { writes++; throw new Error("sensitive backend error"); } };
  const input = message();
  const runtime = () => new RuntimeSessions("viewer", { dsh: adapter }, join(dir, "dispatch"));
  await assert.rejects(runtime().send(input), has("outcome_unknown"));
  await assert.rejects(runtime().send(input), has("outcome_unknown"));
  assert.equal(writes, 1);
});

test("the host preserves a profile bridge's exact unfiled and dormant send grants", { skip: process.platform !== "linux" }, async (t) => {
  const dir = folder();
  const socketPath = join(dir, "dsh.sock");
  const entries = [
    { project: { id: "dsh:unfiled", title: "Unfiled" }, session: { id: "live", title: "Live", state: "idle", canSend: true }, archived: false },
    { project: { id: "p", title: "Project" }, session: { id: "saved", title: "Saved", state: "inactive", canSend: true }, archived: false },
    { project: { id: "dsh:archive", title: "Archived" }, session: { id: "archive", title: "Archived", state: "inactive", canSend: true }, archived: true },
    { project: { id: "p", title: "Project" }, session: { id: "unknown", title: "Unknown", state: "unknown", canSend: true }, archived: false },
  ];
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ view: "exact", scope: "profile", entries }));
  });
  t.after(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({ viewerId: "phone-one", dsh: { socketPath } }), { mode: 0o600 });
  const view = loadRuntimeSessions(cfg)!;
  const result = await view.browse({ view: "exact", sessionIds: entries.map((e) => e.session.id) });
  assert.equal(result.view, "exact");
  assert.deepEqual(result.entries.map((e) => e.session.canSend), [true, true, false, false]);
});

test("configuration is opt-in and rejects public addresses, missing scope and Unix-readable files", (t) => {
  const dir = folder(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = join(dir, "config.json");
  assert.equal(loadRuntimeSessions(undefined), undefined);
  writeFileSync(p, JSON.stringify({ viewerId: "" }), { mode: 0o600 });
  assert.throws(() => loadRuntimeSessions(p), has("bad_request"));
  const token = join(dir, "token");
  writeFileSync(token, "test-token-012345678901234567890123456789", { mode: 0o600 });
  const args = { viewerId: "phone-one", codex: { url: "ws://192.0.2.20:4500", tokenFile: token, threads: [{ id: "thread-test", projectId: "p", projectTitle: "演示" }] } };
  writeFileSync(p, JSON.stringify(args));
  assert.throws(() => loadRuntimeSessions(p), has("bad_request"));
  args.codex.url = "ws://127.0.0.1:9";
  writeFileSync(p, JSON.stringify(args));
  assert.equal(loadRuntimeSessions(p)?.viewerId, "phone-one");
  if (process.getuid) {
    chmodSync(token, 0o644);
    assert.throws(() => loadRuntimeSessions(p), has("bad_request"));
  }
});
