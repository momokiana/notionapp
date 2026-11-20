import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AntigravityRuntime } from "../src/antigravity-runtime.ts";
import { RuntimeError } from "../src/runtime-sessions.ts";

function setupAntigravityFixture(t: TestContext) {
  const brainDir = mkdtempSync(join(tmpdir(), "xa-ag-"));
  t.after(() => rmSync(brainDir, { recursive: true, force: true }));

  const writeTranscript = (id: string, lines: unknown[], options?: { lock?: boolean; mtimeMs?: number }) => {
    const dir = join(brainDir, id);
    const logs = join(dir, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const path = join(logs, "transcript.jsonl");
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    if (options?.lock) writeFileSync(join(dir, ".lock"), "");
    if (options?.mtimeMs) {
      const d = new Date(options.mtimeMs);
      utimesSync(path, d, d);
    }
  };

  const oldMs = Date.now() - 300_000;
  writeTranscript("ag-session-attn-1", [
    {
      type: "SYSTEM_MESSAGE",
      content: "<user_information>\nActive Workspaces:\n- /work/repo-ag-one\nCommand Working Directory: /work/repo-ag-one\n</user_information>",
    },
    {
      type: "USER_INPUT",
      created_at: "2026-11-19T13:00:00.000Z",
      content: "<USER_REQUEST>\n帮我设计自动更新方案\n</USER_REQUEST>",
    },
    {
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-19T13:00:10.000Z",
      content: "请确认以下发布策略。",
      tool_calls: [
        {
          name: "default_api:ask_question",
          args: {
            questions: [
              {
                question: "优先使用哪个下载地址？",
                options: ["已配对中转站", "GitHub Releases"],
                is_multi_select: false,
              },
            ],
          },
        },
      ],
    },
  ], { mtimeMs: oldMs });

  writeTranscript("ag-session-idle-2", [
    {
      type: "SYSTEM_MESSAGE",
      content: "<user_information>\nActive Workspaces:\n- /work/repo-ag-one\n</user_information>",
    },
    {
      type: "USER_INPUT",
      created_at: "2026-11-19T13:01:00.000Z",
      content: "<USER_REQUEST>\n实现更新模块\n</USER_REQUEST>",
    },
    {
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "需要先确认选项。",
      tool_calls: [{ name: "ask_question", args: { questions: [{ question: "旧问题", options: ["A", "B"] }] } }],
    },
    {
      type: "USER_INPUT",
      created_at: "2026-11-19T13:02:00.000Z",
      content: "<USER_REQUEST>\n选 A\n</USER_REQUEST>",
    },
    {
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-19T13:02:05.000Z",
      content: "已按 A 方案完成。",
    },
  ], { mtimeMs: oldMs - 10_000 });

  writeTranscript("ag-session-run-3", [
    {
      type: "SYSTEM_MESSAGE",
      content: "<user_information>\nActive Workspaces:\n- /work/repo-ag-two\n</user_information>",
    },
    {
      type: "USER_INPUT",
      content: "<USER_REQUEST>\n正在执行扫描\n</USER_REQUEST>",
    },
  ], { lock: true });

  return { brainDir };
}

test("AntigravityRuntime discovers workspaces, classifies attention/idle/running states, and exposes read-only detail", async (t) => {
  const { brainDir } = setupAntigravityFixture(t);
  const rt = new AntigravityRuntime({ brainDir });

  const projects = await rt.list();
  assert.equal(projects.length, 2);
  const one = projects.find((p) => p.title === "repo-ag-one");
  const two = projects.find((p) => p.title === "repo-ag-two");
  assert.ok(one);
  assert.ok(two);
  assert.equal(one.runtime, "antigravity");

  const attnSession = one.sessions.find((s) => s.id === "ag-session-attn-1");
  const idleSession = one.sessions.find((s) => s.id === "ag-session-idle-2");
  assert.equal(attnSession?.state, "attention");
  assert.equal(attnSession?.canSend, false);
  assert.equal(attnSession?.title, "帮我设计自动更新方案");
  assert.equal(idleSession?.state, "idle");
  assert.equal(idleSession?.canSend, false);
  assert.equal(two.sessions[0]?.state, "running");
  assert.equal(two.sessions[0]?.canSend, false);

  const browsed = await rt.browse({ view: "sessions", projectId: one.id, search: "更新" });
  assert.equal(browsed.view, "sessions");
  assert.equal(browsed.entries.length, 2);

  const detail = await rt.detail(one.id, "ag-session-attn-1", 30);
  assert.equal(detail.runtime, "antigravity");
  assert.equal(detail.session.state, "attention");
  assert.equal(detail.session.canSend, false);
  assert.ok(detail.readOnlyReason);
  assert.equal(detail.pendingQuestions.length, 1);
  assert.equal(detail.pendingQuestions[0]!.state, "readonly");
  assert.equal(detail.pendingQuestions[0]!.questions[0]!.question, "优先使用哪个下载地址？");
  assert.deepEqual(detail.pendingQuestions[0]!.questions[0]!.options, [{ label: "已配对中转站" }, { label: "GitHub Releases" }]);
  assert.deepEqual(detail.messages.map((m) => m.role), ["user", "tool", "assistant"]);
  assert.equal(detail.messages[1]!.toolName, "ask_question");

  const idleDetail = await rt.detail(one.id, "ag-session-idle-2", 30);
  assert.equal(idleDetail.pendingQuestions.length, 0);

  await assert.rejects(
    () => rt.send({ runtime: "antigravity", projectId: one.id, sessionId: "ag-session-attn-1", requestId: randomUUID(), text: "try" }),
    (err: unknown) => err instanceof RuntimeError && err.code === "forbidden",
  );
});

test("AntigravityRuntime reads conversation_summaries.db workspaces/titles, skips subagents & <CONTEXT_SUMMARY>, and caps >20 projects", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { RuntimeSessions } = await import("../src/runtime-sessions.ts");
  const root = mkdtempSync(join(tmpdir(), "xa-ag-db-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const brainDir = join(root, "brain");
  mkdirSync(brainDir, { recursive: true });
  const dbPath = join(root, "conversation_summaries.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT "",
      workspace_uris TEXT NOT NULL DEFAULT "[]",
      status TEXT NOT NULL DEFAULT "",
      parent_conversation_id TEXT NOT NULL DEFAULT "",
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      killed NUMERIC NOT NULL DEFAULT false,
      last_modified_time DATETIME NOT NULL DEFAULT ""
    );
  `);
  const ins = db.prepare(`
    INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, status, parent_conversation_id, nesting_depth, killed, last_modified_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const writeAg = (id: string, steps: unknown[], ageMs = 0) => {
    const logs = join(brainDir, id, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const tp = join(logs, "transcript.jsonl");
    writeFileSync(tp, `${steps.map((s) => JSON.stringify(s)).join("\n")}\n`);
    if (ageMs) {
      const d = new Date(Date.now() - ageMs);
      utimesSync(tp, d, d);
    }
  };

  // Primary session with encoded Windows file URI, running DB status, and <CONTEXT_SUMMARY> synthetic input.
  writeAg("ag-main-db-1", [
    { type: "USER_INPUT", content: "<CONTEXT_SUMMARY>\nSynthetic compacted summary\n</CONTEXT_SUMMARY>" },
    { type: "USER_INPUT", content: "<USER_REQUEST>\n真正的用户输入\n</USER_REQUEST>" },
    { type: "PLANNER_RESPONSE", status: "DONE", content: "处理完成。" },
  ], 1000);
  ins.run("ag-main-db-1", "真实摘要标题", '["file:///d%3A/Work/MyProject/notionapp-public"]', "CASCADE_RUN_STATUS_RUNNING", "", 0, 0, "2026-11-20T01:00:00Z");

  // Subagents & killed sessions that must be skipped.
  writeAg("ag-sub-depth-1", [{ type: "USER_INPUT", content: "<USER_REQUEST>sub1</USER_REQUEST>" }], 500);
  ins.run("ag-sub-depth-1", "", '["file:///d%3A/Work/MyProject/notionapp-public"]', "CASCADE_RUN_STATUS_IDLE", "", 1, 0, "2026-11-20T01:01:00Z");

  writeAg("ag-sub-parent-2", [{ type: "USER_INPUT", content: "<USER_REQUEST>sub2</USER_REQUEST>" }], 600);
  ins.run("ag-sub-parent-2", "", '["file:///d%3A/Work/MyProject/notionapp-public"]', "CASCADE_RUN_STATUS_IDLE", "ag-main-db-1", 0, 0, "2026-11-20T01:01:00Z");

  writeAg("ag-killed-3", [{ type: "USER_INPUT", content: "<USER_REQUEST>killed</USER_REQUEST>" }], 700);
  ins.run("ag-killed-3", "Killed Conv", '["file:///d%3A/Work/MyProject/notionapp-public"]', "CASCADE_RUN_STATUS_IDLE", "", 0, 1, "2026-11-20T01:01:00Z");

  // 22 extra distinct workspaces so list() must cap at 20 projects cleanly.
  for (let i = 1; i <= 22; i++) {
    const id = `ag-extra-${i}`;
    writeAg(id, [{ type: "USER_INPUT", content: `<USER_REQUEST>task ${i}</USER_REQUEST>` }], 10_000 + i * 100);
    ins.run(id, `工程任务 ${i}`, JSON.stringify([`file:///work/proj-${i}`]), "CASCADE_RUN_STATUS_IDLE", "", 0, 0, "2026-11-20T00:00:00Z");
  }
  db.close();

  const rt = new AntigravityRuntime({ brainDir });
  const rs = new RuntimeSessions("viewer", { antigravity: rt }, join(root, "ledger"));
  const catalog = await rs.list();
  assert.equal(catalog.projects.length, 20);

  const mainProj = catalog.projects.find((p) => p.title === "notionapp-public");
  assert.ok(mainProj);
  assert.equal(mainProj.sessions.length, 1);
  assert.equal(mainProj.sessions[0]!.id, "ag-main-db-1");
  assert.equal(mainProj.sessions[0]!.title, "真实摘要标题");
  assert.equal(mainProj.sessions[0]!.state, "running");

  const detail = await rt.detail(mainProj.id, "ag-main-db-1", 20);
  assert.equal(detail.session.state, "running");
  assert.deepEqual(detail.messages.map((m) => m.text), ["真正的用户输入", "处理完成。"]);
});

test("AntigravityRuntime supports opt-in ACP send, structured answer formatting, active-turn state, and task events", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "xa-ag-send-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const storeRoot = join(root, "antigravity-store");
  const brainDir = join(storeRoot, "brain");
  const workDir = join(root, "repo-writable");
  const missingDir = join(root, "repo-missing");
  mkdirSync(brainDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const oldMs = Date.now() - 300_000;
  const writeSession = (id: string, workspacePath: string, steps: unknown[], opts?: { lock?: boolean }) => {
    const dir = join(brainDir, id);
    const logs = join(dir, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const tp = join(logs, "transcript.jsonl");
    const sysStep = {
      type: "SYSTEM_MESSAGE",
      content: `<user_information>\nActive Workspaces:\n- ${workspacePath}\nCommand Working Directory: ${workspacePath}\n</user_information>`,
    };
    writeFileSync(tp, `${[sysStep, ...steps].map((s) => JSON.stringify(s)).join("\n")}\n`);
    if (opts?.lock) writeFileSync(join(dir, ".lock"), "");
    const d = new Date(oldMs);
    utimesSync(tp, d, d);
  };

  writeSession("ag-write-attn-1", workDir, [
    { type: "USER_INPUT", content: "<USER_REQUEST>\n需要确认选项\n</USER_REQUEST>" },
    {
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "请选择目标。",
      tool_calls: [{ name: "ask_question", args: { questions: [{ question: "发到哪？", options: ["测试环境", "生产环境"] }] } }],
    },
  ]);
  writeSession("ag-write-idle-2", workDir, [
    { type: "USER_INPUT", content: "<USER_REQUEST>\n空闲可续跑\n</USER_REQUEST>" },
    { type: "PLANNER_RESPONSE", status: "DONE", content: "完成。" },
  ]);
  writeSession("ag-write-lock-3", workDir, [
    { type: "USER_INPUT", content: "<USER_REQUEST>\n锁定中\n</USER_REQUEST>" },
  ], { lock: true });
  writeSession("ag-missing-cwd-4", missingDir, [
    { type: "USER_INPUT", content: "<USER_REQUEST>\n目录不存在\n</USER_REQUEST>" },
    { type: "PLANNER_RESPONSE", status: "DONE", content: "结束。" },
  ]);

  const recordPath = join(root, "acp-records.jsonl");
  const mockAgy = join(root, "mock-agy.mjs");
  writeFileSync(mockAgy, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ rpc: msg }) + "\\n");
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
  } else if (msg.method === "session/resume") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId } }) + "\\n");
  } else if (msg.method === "session/prompt") {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "收到" } } },
      }) + "\\n");
    }, 30);
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }) + "\\n");
    }, 90);
  } else if (msg.method === "session/close") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
  }
});
`);

  const rt = new AntigravityRuntime({ brainDir, agyBin: mockAgy, enableSend: true });
  t.after(() => rt.close());
  assert.equal(rt.sendEnabled, true);

  const projects = await rt.list();
  const writableProj = projects.find((p) => p.title === "repo-writable")!;
  const missingProj = projects.find((p) => p.title === "repo-missing")!;
  assert.ok(writableProj);
  assert.ok(missingProj);

  assert.equal(writableProj.sessions.find((s) => s.id === "ag-write-attn-1")?.canSend, true);
  assert.equal(writableProj.sessions.find((s) => s.id === "ag-write-idle-2")?.canSend, true);
  assert.equal(writableProj.sessions.find((s) => s.id === "ag-write-lock-3")?.canSend, false);
  assert.equal(missingProj.sessions.find((s) => s.id === "ag-missing-cwd-4")?.canSend, false);

  const attnDetail = await rt.detail(writableProj.id, "ag-write-attn-1", 20);
  assert.equal(attnDetail.session.canSend, true);
  assert.equal(attnDetail.readOnlyReason, undefined);
  assert.equal(attnDetail.pendingQuestions[0]!.state, "open");

  const reqId = randomUUID();
  const receipt = await rt.answer({
    runtime: "antigravity",
    projectId: writableProj.id,
    sessionId: "ag-write-attn-1",
    requestId: reqId,
    callId: attnDetail.pendingQuestions[0]!.callId,
    answers: [{ id: "q1", selected: ["测试环境"], custom: "先走灰度" }],
  });
  assert.deepEqual(receipt, { accepted: true, requestId: reqId });

  // While the turn is active, session reports running/non-sendable and concurrent sends reject with not_found.
  const activeDetail = await rt.detail(writableProj.id, "ag-write-attn-1", 20);
  assert.equal(activeDetail.session.state, "running");
  assert.equal(activeDetail.session.canSend, false);
  await assert.rejects(
    () => rt.send({ runtime: "antigravity", projectId: writableProj.id, sessionId: "ag-write-attn-1", requestId: randomUUID(), text: "concurrent" }),
    (err: unknown) => err instanceof RuntimeError && err.code === "not_found",
  );

  for (let i = 0; i < 40; i++) {
    if (rt.taskEvents().some((e) => e.requestId === reqId && e.kind === "completed")) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const kinds = rt.taskEvents().filter((e) => e.requestId === reqId).map((e) => e.kind);
  assert.deepEqual(kinds, ["progress", "completed"]);

  const records = readFileSync(recordPath, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(records[0]!.argv, ["acp", "--app-data-dir", "antigravity-store", "--stdio"]);
  const resumeCall = records.find((r) => (r.rpc as { method?: string } | undefined)?.method === "session/resume")?.rpc as { params: { sessionId: string; cwd: string } };
  assert.equal(resumeCall.params.sessionId, "ag-write-attn-1");
  const promptCall = records.find((r) => (r.rpc as { method?: string } | undefined)?.method === "session/prompt")?.rpc as { params: { prompt: Array<{ text: string }> } };
  assert.equal(promptCall.params.prompt[0]!.text, "测试环境（补充：先走灰度）");
});

test("AntigravityRuntime supports knownFolders, create (session/new), and interrupt (session/cancel)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "xa-ag-create-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const brainDir = join(root, "antigravity-store", "brain");
  const workDir = join(root, "repo-new");
  mkdirSync(brainDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const seedDir = join(brainDir, "ag-seed-1", ".system_generated", "logs");
  mkdirSync(seedDir, { recursive: true });
  writeFileSync(
    join(seedDir, "transcript.jsonl"),
    [
      JSON.stringify({ type: "SYSTEM_MESSAGE", content: `Active Workspaces:\n- ${workDir}\n</user_information>` }),
      JSON.stringify({ type: "USER_INPUT", content: "<USER_REQUEST>\n种子会话\n</USER_REQUEST>" }),
      JSON.stringify({ type: "PLANNER_RESPONSE", status: "DONE", content: "好。" }),
    ].join("\n") + "\n",
  );

  const recordPath = join(root, "acp-create.jsonl");
  const counterPath = join(root, "acp-seq.txt");
  writeFileSync(counterPath, "0");
  const mockAgy = join(root, "mock-agy-create.mjs");
  writeFileSync(mockAgy, `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(msg) + "\\n");
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
  } else if (msg.method === "session/new") {
    const next = Number(readFileSync(${JSON.stringify(counterPath)}, "utf8").trim() || "0") + 1;
    writeFileSync(${JSON.stringify(counterPath)}, String(next));
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "ag-created-" + next } }) + "\\n");
  } else if (msg.method === "session/close") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
  } else if (msg.method === "session/cancel") {
    // Wait briefly then acknowledge prompt cancellation cleanly.
  }
});
`);

  const rt = new AntigravityRuntime({ brainDir, agyBin: mockAgy, enableSend: true });
  t.after(() => rt.close());

  const folders = rt.knownFolders();
  assert.equal(folders.length, 1);
  assert.equal(folders[0]!.path, workDir);

  const reqId = randomUUID();
  const created = await rt.create({ cwd: workDir, task: "验证 ACP 新建与取消", requestId: reqId });
  assert.equal(created.sessionId, "ag-created-1");
  assert.equal(created.state, "running");

  const projects = await rt.list();
  const listed = projects.flatMap((p) => p.sessions).find((s) => s.id === "ag-created-1");
  assert.equal(listed?.state, "running");
  assert.equal((await rt.detail(created.projectId, created.sessionId, 20)).messages[0]?.text, "验证 ACP 新建与取消");

  const cancelled = await rt.interrupt(created.projectId, created.sessionId);
  assert.equal(cancelled.interrupted, true);
  assert.equal((await rt.detail(created.projectId, created.sessionId, 20)).session.state, "idle");
  assert.ok(rt.taskEvents().some((e) => e.requestId === reqId && e.kind === "stopped"));

  const idleCreated = await rt.create({ cwd: workDir });
  assert.equal(idleCreated.sessionId, "ag-created-2");
  assert.equal(idleCreated.state, "idle");

  const rpcs = readFileSync(recordPath, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> });
  assert.ok(rpcs.some((r) => r.method === "session/new"));
  assert.ok(rpcs.some((r) => r.method === "session/cancel" && r.params?.sessionId === "ag-created-1"));
});

test("AntigravityRuntime rolls active child subagents up to idle parent and exposes children/detail", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { RuntimeSessions } = await import("../src/runtime-sessions.ts");
  const root = mkdtempSync(join(tmpdir(), "xa-ag-subrun-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const brainDir = join(root, "brain");
  mkdirSync(brainDir, { recursive: true });
  const dbPath = join(root, "conversation_summaries.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT "",
      workspace_uris TEXT NOT NULL DEFAULT "[]",
      status TEXT NOT NULL DEFAULT "",
      parent_conversation_id TEXT NOT NULL DEFAULT "",
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      not_fully_idle NUMERIC NOT NULL DEFAULT false,
      killed NUMERIC NOT NULL DEFAULT false,
      last_modified_time DATETIME NOT NULL DEFAULT ""
    );
  `);
  const ins = db.prepare(`
    INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, status, parent_conversation_id, nesting_depth, not_fully_idle, killed, last_modified_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const writeAg = (id: string, steps: unknown[], opts?: { lock?: boolean }) => {
    const base = join(brainDir, id);
    const logs = join(base, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "transcript.jsonl"), `${steps.map((s) => JSON.stringify(s)).join("\n")}\n`);
    if (opts?.lock) writeFileSync(join(base, ".lock"), "");
  };

  writeAg("ag-parent-idle", [
    { type: "USER_INPUT", content: "<USER_REQUEST>\n帮我巡检全部测试\n</USER_REQUEST>" },
    { type: "PLANNER_RESPONSE", status: "DONE", content: "已派出子智能体在后台运行。" },
  ]);
  ins.run("ag-parent-idle", "主任务", '["file:///work/sub-repo"]', "CASCADE_RUN_STATUS_IDLE", "", 0, 1, 0, "2026-11-20T12:00:00Z");

  writeAg("ag-child-running", [
    { type: "USER_INPUT", content: "<USER_REQUEST>\n运行完整回归测试\n</USER_REQUEST>" },
  ], { lock: true });
  ins.run("ag-child-running", "", '["file:///work/sub-repo"]', "CASCADE_RUN_STATUS_RUNNING", "ag-parent-idle", 1, 1, 0, "2026-11-20T12:01:00Z");

  writeAg("ag-child-done", [
    { type: "USER_INPUT", content: "<USER_REQUEST>\n检查依赖\n</USER_REQUEST>" },
    { type: "PLANNER_RESPONSE", status: "DONE", content: "完成" },
  ]);
  ins.run("ag-child-done", "依赖检查", '["file:///work/sub-repo"]', "CASCADE_RUN_STATUS_IDLE", "ag-parent-idle", 1, 0, 0, "2026-11-20T11:59:00Z");
  db.close();

  const rt = new AntigravityRuntime({ brainDir });
  const rs = new RuntimeSessions("viewer", { antigravity: rt }, join(root, "dispatch"), { publishAgents: true });
  const entries = await rs.unifiedEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.session.id, "ag-parent-idle");
  assert.equal(entries[0]!.session.state, "idle");
  assert.equal(entries[0]!.session.subagents, 2);
  assert.equal(entries[0]!.session.subagentsWorking, 1);

  const kids = await rs.children({ runtime: "antigravity", projectId: entries[0]!.projectId, sessionId: "ag-parent-idle" });
  assert.equal(kids.length, 2);
  assert.equal(kids[0]!.status, "working");
  assert.equal(kids[0]!.title, "运行完整回归测试");
  assert.equal(await rs.descends("antigravity", "ag-child-running", "ag-parent-idle"), true);
  assert.equal(await rs.descends("antigravity", "ag-other", "ag-parent-idle"), false);

  const childDetail = await rt.detail(entries[0]!.projectId, "ag-child-running", 20);
  assert.equal(childDetail.session.canSend, false);
  assert.equal(childDetail.messages[0]?.text, "运行完整回归测试");
});
