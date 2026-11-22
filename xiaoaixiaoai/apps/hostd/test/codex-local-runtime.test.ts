import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CodexLocalRuntime } from "../src/codex-local-runtime.ts";
import { RuntimeError, RuntimeSessions } from "../src/runtime-sessions.ts";

function setupCodexFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "xa-codex-local-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const codexHome = join(dir, "codex-home");
  const cwd = join(dir, "repo-alpha");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const rolloutIdle = join(codexHome, "rollout-idle.jsonl");
  // Add >2.5 MiB prefix noise so we verify bounded tail parsing without loading from start.
  const padLine = JSON.stringify({ type: "event_msg", payload: { type: "agent_reasoning", text: "x".repeat(4000) } });
  const tailLines = [
    JSON.stringify({ type: "turn_context", timestamp: "2026-11-19T11:59:59.000Z", payload: { model: "gpt-6.2-sol", collaboration_mode: { settings: { model: "gpt-6.2-sol", reasoning_effort: "high" } } } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-11-19T12:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context><cwd>/tmp</cwd></environment_context>" }] } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-11-19T12:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "请检查发布脚本" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }] } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-11-19T12:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "已完成发布脚本检查。" }] } }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-11-19T12:00:02.500Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 12000, output_tokens: 500, total_tokens: 12500 },
          model_context_window: 400000,
        },
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 25, window_minutes: 10080, resets_at: 1795301903 },
          secondary: null,
          credits: { has_credits: true, unlimited: false, balance: "1234.5678" },
        },
      },
    }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
  ];
  writeFileSync(rolloutIdle, `${Array(650).fill(padLine).join("\n")}\n${tailLines.join("\n")}\n`);

  const rolloutRunning = join(codexHome, "rollout-running.jsonl");
  writeFileSync(rolloutRunning, `${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`);

  const dbPath = join(codexHome, "state_5.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      cwd TEXT,
      title TEXT,
      name TEXT,
      first_user_message TEXT,
      archived INTEGER DEFAULT 0,
      updated_at INTEGER,
      updated_at_ms INTEGER,
      thread_source TEXT
    );
  `);
  const nowSec = Math.trunc(Date.now() / 1000);
  const insert = db.prepare(`
    INSERT INTO threads (id, rollout_path, cwd, title, name, first_user_message, archived, updated_at, updated_at_ms, thread_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run("thread-codex-idle-1", rolloutIdle, cwd, "发布检查", null, "请检查发布脚本", 0, nowSec, nowSec * 1000, "user");
  insert.run("thread-codex-run-2", rolloutRunning, cwd, "构建任务", "进行中任务", "构建 APK", 0, nowSec - 10, (nowSec - 10) * 1000, null);
  insert.run("thread-codex-arch-3", rolloutIdle, cwd, "已归档会话", null, "旧任务", 1, nowSec - 20, (nowSec - 20) * 1000, "user");
  insert.run("thread-codex-sub-4", rolloutIdle, cwd, "子代理线程", null, "ignored", 0, nowSec - 30, (nowSec - 30) * 1000, "subagent");
  db.close();

  const logPath = join(dir, "fake-codex-log.json");
  const fakeCodex = join(dir, "fake-codex.mjs");
  writeFileSync(fakeCodex, `
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const modeFile = ${JSON.stringify(join(dir, "fake-mode.txt"))};
let mode = "ok";
try { const { readFileSync } = await import("node:fs"); mode = readFileSync(modeFile, "utf8").trim() || "ok"; } catch {}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake-codex" } } }) + "\\n");
    return;
  }
  if (msg.method === "account/rateLimits/read") {
    if (mode === "quota-error") {
      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "not authenticated" } }) + "\\n");
      return;
    }
    if (mode === "quota-weekly-only") {
      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1795301903 },
            secondary: null,
            credits: { hasCredits: false, unlimited: false, balance: "0" },
            planType: "pro",
            rateLimitReachedType: "rate_limit_reached",
          },
        },
      }) + "\\n");
      return;
    }
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: {
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: 1795301903 },
            secondary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 1795070000 },
            credits: { hasCredits: false, unlimited: false, balance: "0" },
            planType: "pro",
          },
        },
      },
    }) + "\\n");
    return;
  }
  if (msg.method === "thread/resume") {
    if (msg.params.excludeTurns !== true) {
      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "missing excludeTurns" } }) + "\\n");
      return;
    }
    if (mode === "mismatch") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: msg.params.threadId }, cwd: ${JSON.stringify(dir)} } }) + "\\n");
      return;
    }
    if (mode === "approval-before-turn") {
      process.stdout.write(JSON.stringify({ id: "srv-req-1", method: "item/commandExecution/requestApproval", params: {} }) + "\\n");
      return;
    }
    const cwdOut = mode === "verbatim-cwd" ? ${JSON.stringify("\\\\?\\")} + msg.params.cwd : msg.params.cwd;
    process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: msg.params.threadId }, cwd: cwdOut } }) + "\\n");
    return;
  }
  if (msg.method === "thread/start") {
    appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method: msg.method, cwd: msg.params.cwd }) + "\\n");
    process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-codex-created-9", path: "" } } }) + "\\n");
    return;
  }
  if (msg.method === "turn/interrupt") {
    appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method: msg.method, ...msg.params }) + "\\n");
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params.threadId, turn: { id: msg.params.turnId, status: "interrupted" } } }) + "\\n");
    return;
  }
  if (msg.method === "turn/start") {
    appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(msg.params) + "\\n");
    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-codex-1" } } }) + "\\n");
    if (mode === "slow-turn") return;
    if (mode === "attention-after-start") {
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ id: "srv-req-2", method: "item/tool/requestUserInput", params: {} }) + "\\n");
      }, 25);
      return;
    }
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params.threadId, turnId: "turn-codex-1" } }) + "\\n");
    }, 20);
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params.threadId, turn: { id: "turn-codex-1", status: "completed" } } }) + "\\n");
    }, 45);
  }
});
`);
  const setMode = (mode: string) => writeFileSync(join(dir, "fake-mode.txt"), mode);
  setMode("ok");
  return { dir, codexHome, cwd, fakeCodex, logPath, setMode };
}

test("CodexLocalRuntime lists, browses, and extracts bounded tail detail without subagent threads", async (t) => {
  const fx = setupCodexFixture(t);
  const rt = new CodexLocalRuntime({ codexHome: fx.codexHome, codexBin: fx.fakeCodex, enableSend: true });
  t.after(() => rt.close());

  const projects = await rt.list();
  assert.equal(projects.length, 1);
  assert.equal(projects[0]!.runtime, "codex");
  assert.equal(projects[0]!.title, "repo-alpha");
  assert.deepEqual(projects[0]!.sessions.map((s) => s.id), ["thread-codex-idle-1", "thread-codex-run-2", "thread-codex-arch-3"]);
  assert.equal(projects[0]!.sessions[0]!.state, "idle");
  assert.equal(projects[0]!.sessions[0]!.canSend, true);
  assert.equal(projects[0]!.sessions[0]!.model, "gpt-6.2-sol");
  assert.equal(projects[0]!.sessions[0]!.contextTokens, 12500);
  assert.equal(projects[0]!.sessions[0]!.contextLimit, 400000);
  assert.equal(projects[0]!.sessions[0]!.modelQuota?.available, true);
  assert.equal(projects[0]!.sessions[0]!.modelQuota?.primary?.remainingPercent, 65);
  assert.equal(projects[0]!.sessions[0]!.modelQuota?.primary?.label, "5小时");
  assert.equal(projects[0]!.sessions[0]!.modelQuota?.secondary?.remainingPercent, 20);
  assert.equal(projects[0]!.sessions[0]!.modelQuota?.secondary?.label, "每周");
  assert.equal(projects[0]!.sessions[0]!.modelQuota?.balance, undefined);
  assert.equal(projects[0]!.sessions[0]!.modelQuota?.plan, "pro");
  assert.equal(projects[0]!.sessions[1]!.state, "running");
  assert.equal(projects[0]!.sessions[1]!.canSend, false);
  assert.equal(projects[0]!.sessions[2]!.state, "inactive");
  assert.equal(projects[0]!.sessions[2]!.canSend, false);

  const browsedProjects = await rt.browse({ view: "projects" });
  assert.equal(browsedProjects.view, "projects");
  assert.equal(browsedProjects.projects.length, 1);

  const exact = await rt.browse({ view: "exact", sessionIds: ["thread-codex-idle-1", "thread-codex-sub-4"] });
  assert.equal(exact.view, "exact");
  assert.equal(exact.entries.length, 1);
  assert.equal(exact.entries[0]!.session.id, "thread-codex-idle-1");

  const detail = await rt.detail(projects[0]!.id, "thread-codex-idle-1", 20);
  assert.equal(detail.runtime, "codex");
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[0]!.role, "user");
  assert.match(detail.messages[0]!.text, /请检查发布脚本/);
  assert.match(detail.messages[0]!.text, /\[图片\]/);
  assert.equal(detail.messages[1]!.role, "assistant");
  assert.equal(detail.messages[1]!.text, "已完成发布脚本检查。");

  // RuntimeSessions browse & unifiedEntries handle archived Codex threads keeping their workspace project ID.
  const rs = new RuntimeSessions("viewer", { codex: rt }, join(fx.dir, "dispatch"), { publishAgents: true });
  const browsedSessions = await rs.browse({ runtime: "codex", view: "sessions" });
  assert.equal(browsedSessions.view, "sessions");
  assert.equal(browsedSessions.entries.length, 3);
  const unified = await rs.unifiedEntries();
  assert.deepEqual(unified.map((u) => u.session.id).sort(), ["thread-codex-idle-1", "thread-codex-run-2"]);
});

test("CodexLocalRuntime dispatches turn via app-server and records background completion events", async (t) => {
  const fx = setupCodexFixture(t);
  const rt = new CodexLocalRuntime({ codexHome: fx.codexHome, codexBin: fx.fakeCodex, enableSend: true });
  t.after(() => rt.close());

  const [project] = await rt.list();
  const reqId = randomUUID();
  const receipt = await rt.send({ runtime: "codex", projectId: project!.id, sessionId: "thread-codex-idle-1", requestId: reqId, text: "继续完成发布检查" });
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.requestId, reqId);
  assert.equal(receipt.receiptId, "turn-codex-1");

  // While the background turn is running, browse shows running / non-sendable.
  const during = await rt.browse({ view: "exact", sessionIds: ["thread-codex-idle-1"] });
  assert.equal(during.view, "exact");
  assert.equal(during.entries[0]!.session.state, "running");
  assert.equal(during.entries[0]!.session.canSend, false);

  for (let i = 0; i < 20; i++) {
    if (rt.taskEvents().some((e) => e.requestId === reqId && e.kind === "completed")) break;
    await delay(20);
  }
  const kinds = rt.taskEvents().filter((e) => e.requestId === reqId).map((e) => e.kind);
  assert.deepEqual(kinds, ["progress", "completed"]);

  const logged = JSON.parse(readFileSync(fx.logPath, "utf8").trim());
  assert.equal(logged.threadId, "thread-codex-idle-1");
  assert.equal(logged.input[0].text, "继续完成发布检查");
});

test("CodexLocalRuntime enforces send authorization, cwd verification, and interactive attention handling", async (t) => {
  const fx = setupCodexFixture(t);
  const ro = new CodexLocalRuntime({ codexHome: fx.codexHome, codexBin: fx.fakeCodex, enableSend: false });
  t.after(() => ro.close());
  const [project] = await ro.list();
  assert.equal(project!.sessions[0]!.canSend, false);
  await assert.rejects(() => ro.send({ runtime: "codex", projectId: project!.id, sessionId: "thread-codex-idle-1", requestId: randomUUID(), text: "hi" }), (err: unknown) => err instanceof RuntimeError && err.code === "forbidden");

  const rt = new CodexLocalRuntime({ codexHome: fx.codexHome, codexBin: fx.fakeCodex, enableSend: true });
  t.after(() => rt.close());

  fx.setMode("mismatch");
  await assert.rejects(() => rt.send({ runtime: "codex", projectId: project!.id, sessionId: "thread-codex-idle-1", requestId: randomUUID(), text: "hi" }), (err: unknown) => err instanceof RuntimeError && err.code === "not_found");

  fx.setMode("attention-after-start");
  const reqId = randomUUID();
  await rt.send({ runtime: "codex", projectId: project!.id, sessionId: "thread-codex-idle-1", requestId: reqId, text: "trigger attention" });
  for (let i = 0; i < 20; i++) {
    if (rt.taskEvents().some((e) => e.requestId === reqId && e.kind === "stopped")) break;
    await delay(20);
  }
  const kinds = rt.taskEvents().filter((e) => e.requestId === reqId).map((e) => e.kind);
  assert.deepEqual(kinds, ["attention", "stopped"]);
});

test("CodexLocalRuntime accepts verbatim \\\\?\\ cwd on thread/resume and caps >20 projects for RuntimeSessions", async (t) => {
  const { RuntimeSessions } = await import("../src/runtime-sessions.ts");
  const fx = setupCodexFixture(t);
  fx.setMode("verbatim-cwd");
  const rt = new CodexLocalRuntime({ codexHome: fx.codexHome, codexBin: fx.fakeCodex, enableSend: true });
  t.after(() => rt.close());

  const [proj] = await rt.list();
  const reqId = randomUUID();
  const receipt = await rt.send({ runtime: "codex", projectId: proj!.id, sessionId: "thread-codex-idle-1", requestId: reqId, text: "verbatim path check" });
  assert.equal(receipt.accepted, true);

  // Add 23 distinct project directories into a fresh sqlite DB and verify list() caps cleanly at 20.
  const capDir = mkdtempSync(join(tmpdir(), "xa-codex-cap-"));
  t.after(() => rmSync(capDir, { recursive: true, force: true }));
  const capHome = join(capDir, "codex-home");
  mkdirSync(capHome, { recursive: true });
  const rollout = join(capHome, "rollout-cap.jsonl");
  writeFileSync(rollout, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })}\n`);
  const db = new DatabaseSync(join(capHome, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, name TEXT, first_user_message TEXT, archived INTEGER DEFAULT 0, updated_at INTEGER, updated_at_ms INTEGER, thread_source TEXT);`);
  const ins = db.prepare(`INSERT INTO threads (id, rollout_path, cwd, title, name, first_user_message, archived, updated_at, updated_at_ms, thread_source) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'user')`);
  const baseSec = Math.trunc(Date.now() / 1000);
  for (let i = 1; i <= 23; i++) {
    const p = join(capDir, `proj-${i}`);
    mkdirSync(p, { recursive: true });
    ins.run(`thread-cap-${i}`, rollout, p, `Project ${i}`, null, `msg ${i}`, baseSec - i, (baseSec - i) * 1000);
  }
  db.close();

  const capRt = new CodexLocalRuntime({ codexHome: capHome, enableSend: false });
  t.after(() => capRt.close());
  const rs = new RuntimeSessions("viewer", { codex: capRt }, join(capDir, "ledger"));
  const list = await rs.list();
  assert.equal(list.projects.length, 20);
});

test("CodexLocalRuntime supports knownFolders, create (thread/start + turn/start), and interrupt (turn/interrupt)", async (t) => {
  const fx = setupCodexFixture(t);
  fx.setMode("slow-turn");
  const rt = new CodexLocalRuntime({ codexHome: fx.codexHome, codexBin: fx.fakeCodex, enableSend: true });
  t.after(() => rt.close());

  const folders = rt.knownFolders();
  assert.equal(folders.length, 1);
  assert.equal(folders[0]!.path, fx.cwd);

  const reqId = randomUUID();
  const created = await rt.create({ cwd: fx.cwd, task: "先检查新模块测试", requestId: reqId });
  assert.equal(created.sessionId, "thread-codex-created-9");
  assert.equal(created.state, "running");

  const projects = await rt.list();
  const createdEntry = projects.flatMap((p) => p.sessions).find((s) => s.id === "thread-codex-created-9");
  assert.equal(createdEntry?.state, "running");
  assert.equal(createdEntry?.canSend, false);

  const detail = await rt.detail(created.projectId, created.sessionId, 20);
  assert.equal(detail.messages[0]?.text, "先检查新模块测试");

  const stopped = await rt.interrupt(created.projectId, created.sessionId);
  assert.equal(stopped.interrupted, true);
  assert.equal((await rt.detail(created.projectId, created.sessionId, 20)).session.state, "idle");
  assert.ok(rt.taskEvents().some((e) => e.requestId === reqId && e.kind === "stopped"));

  const idleCreated = await rt.create({ cwd: fx.cwd });
  assert.equal(idleCreated.state, "idle");

  const logged = readFileSync(fx.logPath, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.ok(logged.some((r) => r.method === "thread/start"));
  assert.ok(logged.some((r) => r.method === "turn/interrupt" && r.threadId === "thread-codex-created-9" && r.turnId === "turn-codex-1"));
});

test("CodexLocalRuntime counts active subagent threads on idle parent threads and exposes children/detail", async (t) => {
  const { RuntimeSessions } = await import("../src/runtime-sessions.ts");
  const dir = mkdtempSync(join(tmpdir(), "xa-codex-sub-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const codexHome = join(dir, "codex-home");
  const cwd = join(dir, "repo-sub");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const parentRollout = join(codexHome, "rollout-parent.jsonl");
  writeFileSync(parentRollout, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })}\n`);
  const subRollout = join(codexHome, "rollout-sub.jsonl");
  writeFileSync(
    subRollout,
    `${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n` +
      `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "审查 API 更改" }] } })}\n`,
  );

  const db = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      cwd TEXT,
      title TEXT,
      name TEXT,
      first_user_message TEXT,
      archived INTEGER DEFAULT 0,
      updated_at INTEGER,
      updated_at_ms INTEGER,
      thread_source TEXT,
      source TEXT,
      attached_thread_parent_id TEXT,
      agent_nickname TEXT,
      agent_role TEXT
    );
  `);
  const nowSec = Math.trunc(Date.now() / 1000);
  const ins = db.prepare(`
    INSERT INTO threads (id, rollout_path, cwd, title, name, first_user_message, archived, updated_at, updated_at_ms, thread_source, source, attached_thread_parent_id, agent_nickname, agent_role)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
  `);
  ins.run("thread-parent-1", parentRollout, cwd, "主开发任务", null, "开始开发", nowSec - 10, (nowSec - 10) * 1000, "user", "cli", null, null, null);
  ins.run(
    "thread-child-1",
    subRollout,
    cwd,
    "Subagent task",
    null,
    "审查 API 更改",
    nowSec,
    nowSec * 1000,
    "subagent",
    JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "thread-parent-1", depth: 1 } } }),
    null,
    "Noether",
    "reviewer",
  );
  db.close();

  const rt = new CodexLocalRuntime({ codexHome, enableSend: true });
  t.after(() => rt.close());
  const rs = new RuntimeSessions("viewer", { codex: rt }, join(dir, "dispatch"), { publishAgents: true });
  const entries = await rs.unifiedEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.session.id, "thread-parent-1");
  assert.equal(entries[0]!.session.state, "idle");
  assert.equal(entries[0]!.session.subagents, 1);
  assert.equal(entries[0]!.session.subagentsWorking, 1);

  const kids = await rs.children({ runtime: "codex", projectId: entries[0]!.projectId, sessionId: "thread-parent-1" });
  assert.equal(kids.length, 1);
  assert.equal(kids[0]!.status, "working");
  assert.equal(kids[0]!.title, "Noether (reviewer)");
  assert.equal(await rs.descends("codex", "thread-child-1", "thread-parent-1"), true);

  const childDetail = await rt.detail(entries[0]!.projectId, "thread-child-1", 20);
  assert.equal(childDetail.session.canSend, false);
  assert.equal(childDetail.messages[0]?.text, "审查 API 更改");
});

test("CodexLocalRuntime reports live weekly-only account quota and never falls back to stale rollout snapshots on error", async (t) => {
  const fx = setupCodexFixture(t);

  fx.setMode("quota-weekly-only");
  const rtWeekly = new CodexLocalRuntime({ codexHome: fx.codexHome, codexBin: fx.fakeCodex, enableSend: false });
  t.after(() => rtWeekly.close());
  const [projWeekly] = await rtWeekly.list();
  const qWeekly = projWeekly!.sessions[0]!.modelQuota;
  assert.equal(qWeekly?.available, true);
  assert.equal(qWeekly?.primary?.remainingPercent, 0);
  assert.equal(qWeekly?.primary?.label, "每周");
  assert.equal(qWeekly?.secondary, undefined);
  assert.equal(qWeekly?.balance, undefined);
  assert.match(qWeekly?.note ?? "", /未返回5小时窗口/);
  assert.match(qWeekly?.note ?? "", /已达限额/);

  fx.setMode("quota-error");
  const rtErr = new CodexLocalRuntime({ codexHome: fx.codexHome, codexBin: fx.fakeCodex, enableSend: false });
  t.after(() => rtErr.close());
  const [projErr] = await rtErr.list();
  const qErr = projErr!.sessions[0]!.modelQuota;
  assert.equal(qErr?.available, false);
  assert.equal(qErr?.primary, undefined);
  assert.equal(qErr?.balance, undefined);
});

test("CodexLocalRuntime parses custom_tool_call_output exit codes/stdout and detects running across >64KB output", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xa-codex-out-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const codexHome = join(dir, "codex-home");
  const cwd = join(dir, "repo-out");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const rolloutPath = join(codexHome, "rollout-out.jsonl");
  const bigChunk = "L".repeat(90_000);
  const lines = [
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "response_item", timestamp: "2026-11-22T09:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "运行验证测试" }] } },
    { type: "response_item", timestamp: "2026-11-22T09:00:01.000Z", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: 'tools.exec_command({cmd:"npm test"})' } },
    {
      type: "response_item",
      timestamp: "2026-11-22T09:00:02.000Z",
      payload: {
        type: "custom_tool_call_output",
        call_id: "c1",
        output: [
          { type: "input_text", text: `Script completed\n${bigChunk}\n` },
          { type: "input_text", text: '[{"status":"fulfilled","value":{"exit_code":0,"output":"ALL 99 TESTS PASSED"}}]' },
        ],
      },
    },
  ];
  writeFileSync(rolloutPath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

  const db = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, name TEXT, first_user_message TEXT, archived INTEGER DEFAULT 0, updated_at INTEGER, updated_at_ms INTEGER, source TEXT, thread_source TEXT, attached_thread_parent_id TEXT, agent_nickname TEXT, agent_role TEXT, model TEXT, reasoning_effort TEXT);`);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO threads (id, rollout_path, cwd, title, name, first_user_message, archived, updated_at, updated_at_ms) VALUES (?, ?, ?, ?, NULL, ?, 0, ?, ?)`).run("cx-out-1", rolloutPath, cwd, "验证测试", "运行验证测试", now, now * 1000);
  db.close();

  const rt = new CodexLocalRuntime({ codexHome, enableSend: false });
  t.after(() => rt.close());
  const [proj] = await rt.list();
  assert.ok(proj);
  // >90KB output after task_started must still be detected as running thanks to 512KB probe tail.
  assert.equal(proj.sessions[0]!.state, "running");

  const detail = await rt.detail(proj.id, "cx-out-1", 20);
  const tool = detail.messages.find((m) => m.role === "tool");
  assert.ok(tool);
  assert.equal(tool.isError, false);
  assert.match(tool.text, /exec：npm test/);
  assert.match(tool.text, /exit=0/);
  assert.match(tool.text, /ALL 99 TESTS PASSED/);
});
