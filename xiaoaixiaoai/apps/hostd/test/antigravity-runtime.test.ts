import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
