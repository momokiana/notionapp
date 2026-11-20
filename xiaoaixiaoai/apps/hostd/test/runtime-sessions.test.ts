import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeProject } from "@xiaoaixiaoai/protocol";
import { encodeRuntimeLocalId, encodeRuntimeSessionKey, loadRuntimeSessions, parseRuntimeTarget, RuntimeError, RuntimeSessions, type RuntimeAdapter } from "../src/runtime-sessions.ts";
import { extractSearchHit, matchQuestionAnswer, nextRuntimeState, parseRuntimeSearchQuery, RuntimeEventSeqTracker } from "../src/runtime-bridge.ts";

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

test("RuntimeSessions routes detail, idempotent answer, Antigravity read-only fences, and multi-runtime adapters", async (t) => {
  const dir = folder(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = join(dir, "dispatch");
  let answerCalls = 0;
  const dshAdapter: RuntimeAdapter = {
    list: async () => demo,
    send: async (arg) => receipt(arg.requestId),
    detail: async (projectId, sessionId) => ({
      runtime: "dsh",
      project: { id: projectId, title: "同工程" },
      session: { id: sessionId, title: "需要决策", state: "attention", canSend: true },
      messages: [{ id: "m1", role: "assistant", text: "请选择" }],
      pendingQuestions: [{ callId: "q-call-1", state: "open", questions: [{ id: "q1", question: "继续？", options: [{ label: "是" }], multiSelect: false }] }],
    }),
    answer: async (arg) => {
      answerCalls++;
      return receipt(arg.requestId);
    },
  };
  const agAdapter: RuntimeAdapter = {
    list: async () => [{ runtime: "antigravity", id: "ag-p1", title: "AG 工程", sessions: [{ id: "ag-s1", title: "AG 只读", state: "attention", canSend: true }] }],
    browse: async () => ({
      runtime: "antigravity",
      view: "sessions",
      scope: "profile",
      entries: [{ runtime: "antigravity", project: { runtime: "antigravity", id: "ag-p1", title: "AG 工程" }, session: { id: "ag-s1", title: "AG 只读", state: "attention", canSend: true }, archived: false }],
    }),
    detail: async () => ({
      runtime: "antigravity",
      project: { id: "ag-p1", title: "AG 工程" },
      session: { id: "ag-s1", title: "AG 只读", state: "attention", canSend: true },
      messages: [{ id: "a1", role: "user", text: "hi" }],
      pendingQuestions: [{ callId: "ag-call-1", state: "open", questions: [{ id: "q1", question: "选项" }] }],
    }),
    send: async () => assert.fail("antigravity send must be blocked before adapter"),
    answer: async () => assert.fail("antigravity answer must be blocked before adapter"),
  };

  const rs = new RuntimeSessions("viewer", { dsh: dshAdapter, antigravity: agAdapter }, ledger);
  const dshDetail = await rs.detail({ runtime: "dsh", projectId: "dsh-project", sessionId: "session-one", limit: 20 });
  assert.equal(dshDetail.pendingQuestions.length, 1);

  const reqId = randomUUID();
  const ansPayload = { runtime: "dsh", projectId: "dsh-project", sessionId: "session-one", requestId: reqId, callId: "q-call-1", answers: [{ id: "q1", selected: ["是"] }] };
  assert.deepEqual(await rs.answer(ansPayload), receipt(reqId));
  assert.deepEqual(await rs.answer(ansPayload), receipt(reqId));
  assert.equal(answerCalls, 1);

  // Antigravity is always forced read-only even if a test adapter sets canSend: true.
  const browsed = await rs.browse({ runtime: "antigravity", view: "sessions" });
  assert.equal(browsed.view, "sessions");
  assert.equal(browsed.entries[0]!.session.canSend, false);
  const agDetail = await rs.detail({ runtime: "antigravity", projectId: "ag-p1", sessionId: "ag-s1" });
  assert.equal(agDetail.session.canSend, false);
  assert.equal(agDetail.pendingQuestions[0]!.state, "readonly");
  await assert.rejects(rs.send({ runtime: "antigravity", projectId: "ag-p1", sessionId: "ag-s1", requestId: randomUUID(), input: "nope" }), has("forbidden"));
  await assert.rejects(rs.answer({ runtime: "antigravity", projectId: "ag-p1", sessionId: "ag-s1", requestId: randomUUID(), callId: "ag-call-1", answers: [{ id: "q1", selected: ["x"] }] }), has("forbidden"));
});

test("runtime bridge helpers encode targets, convert events cleanly, and parse assistant search queries", async (t) => {
  const dir = folder(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const localId = encodeRuntimeLocalId("antigravity", "ag:proj", "conv-1");
  const sessionKey = encodeRuntimeSessionKey("antigravity", "ag:proj", "conv-1");
  assert.deepEqual(parseRuntimeTarget(localId), { runtime: "antigravity", projectId: "ag:proj", sessionId: "conv-1" });
  assert.deepEqual(parseRuntimeTarget(sessionKey), { runtime: "antigravity", projectId: "ag:proj", sessionId: "conv-1" });
  assert.equal(parseRuntimeTarget("bad"), null);

  let s = nextRuntimeState(undefined, "running", 1000);
  assert.equal(s.status, "working");
  assert.equal(s.turn, 1);
  s = nextRuntimeState(s, "idle", 2000);
  assert.equal(s.status, "done");
  assert.equal(s.turn, 1);

  // Idle main + running subagents stays continuously working until subagents reach 0, then flips done.
  let sub = nextRuntimeState(undefined, "idle", 1000, undefined, 2);
  assert.equal(sub.status, "idle");
  assert.equal(sub.since, 1000);
  assert.equal(sub.turn, 1);
  assert.equal(sub.subagentsWorking, 2);
  sub = nextRuntimeState(sub, "idle", 5000, undefined, 1);
  assert.equal(sub.since, 1000);
  sub = nextRuntimeState(sub, "idle", 9000, undefined, 0);
  assert.equal(sub.status, "done");
  assert.equal(sub.since, 9000);

  const tracker = new RuntimeEventSeqTracker();
  const detail = {
    runtime: "dsh" as const,
    project: { id: "p1", title: "gamesuperagent" },
    session: { id: "s1", title: "测试", state: "idle" as const, canSend: true, updatedAt: 5000 },
    messages: [
      { id: "m1", role: "user" as const, text: "hi" },
      { id: "m2", role: "tool" as const, text: "ok", toolName: "bash" },
      { id: "m3", role: "assistant" as const, text: "完成" },
    ],
    pendingQuestions: [],
  };
  const events = tracker.toConvEvents(sessionKey, detail, 5000);
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((e) => e.pos), ["1", "2", "3", "4"]);

  assert.deepEqual(matchQuestionAnswer({ id: "q1", question: "选哪个", options: [{ label: "方案A" }, { label: "方案B" }] }, "2"), { id: "q1", selected: ["方案B"] });
  assert.deepEqual(matchQuestionAnswer({ id: "q1", question: "选哪个", options: [{ label: "方案A" }] }, "补充说明"), { id: "q1", selected: [], custom: "补充说明" });

  const q = parseRuntimeSearchQuery("反重力 gamesuperagent");
  assert.deepEqual(q.terms, ["antigravity", "gamesuperagent"]);
  const hit = extractSearchHit({ runtime: "antigravity", projectId: "ag-1", projectTitle: "gamesuperagent", session: { id: "c1", title: "计划", state: "idle", canSend: false, updatedAt: 9000 }, sendConfigured: false }, undefined, q);
  assert.ok(hit);
  assert.equal(extractSearchHit({ runtime: "codex", projectId: "cx-1", projectTitle: "gamesuperagent", session: { id: "c2", title: "计划", state: "idle", canSend: true, updatedAt: 9000 }, sendConfigured: true }, undefined, q), null);

  const cfgPath = join(dir, "runtime.json");
  const mockAgy = join(dir, "agy.mjs");
  writeFileSync(mockAgy, "// mock");
  writeFileSync(cfgPath, JSON.stringify({ viewerId: "v1", antigravity: { brainDir: dir, agyBin: mockAgy, enableSend: true }, publishAgents: true, allowAssistant: true }), { mode: 0o600 });
  const loaded = loadRuntimeSessions(cfgPath)!;
  assert.equal(loaded.publishAgents, true);
  assert.equal(loaded.allowAssistant, true);

  let agSendCalls = 0;
  let agAnswerCalls = 0;
  const writableAg: RuntimeAdapter = {
    sendEnabled: true,
    list: async () => [{ runtime: "antigravity", id: "ag-p1", title: "AG 工程", sessions: [{ id: "ag-s1", title: "AG 可写", state: "attention", canSend: true }] }],
    browse: async () => ({
      runtime: "antigravity",
      view: "sessions",
      scope: "profile",
      entries: [{ runtime: "antigravity", project: { runtime: "antigravity", id: "ag-p1", title: "AG 工程" }, session: { id: "ag-s1", title: "AG 可写", state: "attention", canSend: true }, archived: false }],
    }),
    detail: async () => ({
      runtime: "antigravity",
      project: { id: "ag-p1", title: "AG 工程" },
      session: { id: "ag-s1", title: "AG 可写", state: "attention", canSend: true },
      messages: [{ id: "a1", role: "user", text: "hi" }],
      pendingQuestions: [{ callId: "ag-call-1", state: "open", questions: [{ id: "q1", question: "选项" }] }],
    }),
    send: async (arg) => { agSendCalls++; return receipt(arg.requestId); },
    answer: async (arg) => { agAnswerCalls++; return receipt(arg.requestId); },
  };
  const rsWritable = new RuntimeSessions("viewer", { antigravity: writableAg }, join(dir, "dispatch-writable"));
  const writableBrowse = await rsWritable.browse({ runtime: "antigravity", view: "sessions" });
  assert.equal(writableBrowse.view, "sessions");
  assert.equal(writableBrowse.entries[0]!.session.canSend, true);
  const writableDetail = await rsWritable.detail({ runtime: "antigravity", projectId: "ag-p1", sessionId: "ag-s1" });
  assert.equal(writableDetail.session.canSend, true);
  assert.equal(writableDetail.pendingQuestions[0]!.state, "open");
  const sendReq = randomUUID();
  assert.deepEqual(await rsWritable.send({ runtime: "antigravity", projectId: "ag-p1", sessionId: "ag-s1", requestId: sendReq, input: "继续" }), receipt(sendReq));
  assert.deepEqual(await rsWritable.send({ runtime: "antigravity", projectId: "ag-p1", sessionId: "ag-s1", requestId: sendReq, input: "继续" }), receipt(sendReq));
  assert.equal(agSendCalls, 1);
  const ansReq = randomUUID();
  assert.deepEqual(await rsWritable.answer({ runtime: "antigravity", projectId: "ag-p1", sessionId: "ag-s1", requestId: ansReq, callId: "ag-call-1", answers: [{ id: "q1", selected: ["x"] }] }), receipt(ansReq));
  assert.equal(agAnswerCalls, 1);
});
