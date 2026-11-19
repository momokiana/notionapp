import { test } from "node:test";
import assert from "node:assert/strict";
import type { HcTerminal } from "../src/hc.ts";
import { Host } from "../src/host.ts";
import { LOADING, QUESTION, typeFirstTask, type TypeTaskDeps } from "../src/firsttask.ts";

/** A program starting in a terminal, on a clock the test moves; nothing real is touched. */
function fake(screenAt: (ms: number) => string, more: { terminal?: (ms: number) => HcTerminal | undefined } = {}) {
  let clock = 0;
  const typed: Array<{ text: string; at: number }> = [];
  const deps: TypeTaskDeps = {
    terminal: async () => (more.terminal ? more.terminal(clock) : { address: "t9", state: "live", foreground: { argv: ["/Users/me/.local/bin/kimi"] } }),
    screen: async () => screenAt(clock),
    type: async (text) => {
      typed.push({ text, at: clock });
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return { deps, typed };
}

test("a program the desktop app does not know gets its task once its screen has settled", async () => {
  // A splash that says it is loading for 3 s, then the input box.
  const { deps, typed } = fake((ms) => (ms < 3000 ? `Kimi Code\n${"⠋⠙⠹"[Math.floor(ms / 1000) % 3]} Loading MCP servers` : "Kimi Code\n> \n? for shortcuts"));
  const r = await typeFirstTask("看下 README 里的安装步骤", deps, { pollMs: 500 });
  assert.equal(r.ok, true);
  assert.deepEqual(typed.map((t) => t.text), ["看下 README 里的安装步骤"]);
  assert.ok(typed[0]!.at >= 3000 + 1500, `typed at ${typed[0]!.at}`);
  assert.equal(r.ok && r.how, "screen");
});

test("a known program reported idle gets it as soon as it has drawn something", async () => {
  const { deps, typed } = fake((ms) => `opencode ${ms}`, {
    terminal: (ms) => ({ address: "t9", state: "live", status: { app: "opencode", state: ms < 2000 ? "working" : "idle" } }),
  });
  const r = await typeFirstTask("修一下 lint", deps, { pollMs: 500 });
  assert.equal(r.ok && r.how, "status");
  assert.ok(typed[0]!.at >= 2000 && typed[0]!.at < 3000);
});

test("a program that opens on a question gets nothing typed, and says what it asks", async () => {
  const { deps, typed } = fake(() => "Droid\nDo you trust the files in this folder?\n> Yes, proceed\n  No, exit");
  const r = await typeFirstTask("跑一遍测试", deps, { pollMs: 500 });
  assert.equal(r.ok, false);
  assert.deepEqual(typed, []);
  assert.match(!r.ok ? r.reason : "", /它一开就在问：「.*trust.*」，任务没打进去/);
  assert.ok(QUESTION.test("Please log in to continue"));
  assert.ok(QUESTION.test("是否信任此文件夹"));
  assert.ok(!QUESTION.test("Logging enabled. Type your request"));
  assert.ok(LOADING.test("⠙ Loading MCP servers") && !LOADING.test("Tips for getting started"));
});

test("a program that quits, never shows up, or leaves only a shell: no task, a reason, and the wait ends", async () => {
  const quit = fake(() => "", { terminal: () => ({ address: "t9", state: "finished" }) });
  const r1 = await typeFirstTask("x", quit.deps);
  assert.equal(r1.ok, false);
  assert.match(!r1.ok ? r1.reason : "", /一启动就退出了/);

  const missing = fake(() => "", { terminal: () => undefined });
  const r2 = await typeFirstTask("x", missing.deps, { timeoutMs: 5000, pollMs: 500 });
  assert.match(!r2.ok ? r2.reason : "", /等了 5 秒，新终端一直没出现，任务没打进去/);

  const shell = fake(() => "me@mac ~ % ", { terminal: () => ({ address: "t9", state: "live", foreground: { argv: ["-zsh"] } }) });
  const r3 = await typeFirstTask("x", shell.deps, { timeoutMs: 5000, pollMs: 500 });
  assert.match(!r3.ok ? r3.reason : "", /终端里只有 shell，程序没起来/);
  assert.deepEqual([...quit.typed, ...missing.typed, ...shell.typed], []);
});

test("agent.create: a task for a program that takes none at start is typed in once it is up; the answer and the log say so", async () => {
  const h = new Host({ config: { server: "http://127.0.0.1:9", token: "t", deviceId: "d", name: "test" }, log: () => {} });
  // Everything that would reach the real desktop app or a terminal is a stand-in.
  const x = h as unknown as {
    sources: string[];
    launchersCache: unknown;
    refreshNames(): Promise<void>;
    handlers: Record<string, (p: unknown, from: string) => Promise<any>>;
    logs: { take(n: number): Array<{ level: string; kind: string; msg: string; data?: Record<string, unknown> }> };
  };
  x.sources = ["hc"];
  x.launchersCache = {
    at: Date.now(),
    list: Promise.resolve([
      { id: "claude", label: "Claude Code", takesTask: true },
      { id: "kimi", label: "Kimi Code", takesTask: false },
      { id: "shell", label: "终端", takesTask: false },
    ]),
  };
  x.refreshNames = async () => {};
  const created: Array<Record<string, unknown>> = [];
  h.app.create = async (o) => {
    created.push(o);
    return { space: "w1", tab: "b1", terminal: "t9" };
  };
  h.hc.list = async () => {};
  h.hc.terminals.set("t9", { address: "t9", state: "live", foreground: { argv: ["kimi"] } });
  let screen = "Kimi Code\n⠋ Loading";
  setTimeout(() => (screen = "Kimi Code\n> "), 150);
  h.hc.read = async () => ({ text: screen });
  const typed: string[] = [];
  h.hc.send = async (_t: string, text: string) => {
    typed.push(text);
  };
  h.firstTaskOptions = { minMs: 50, stableMs: 100, pollMs: 20, timeoutMs: 2000 };

  const r = await x.handlers["agent.create"]!({ launcher: "kimi", folder: "~", task: "看下 README" }, "relay");
  assert.deepEqual(r, { agent: "d/hc:t9", space: "w1", terminal: "t9", task: "typed" });
  assert.equal(created[0]!.task, undefined, "not handed to the program's command line");
  assert.deepEqual(typed, ["看下 README"]);
  const line = x.logs.take(50).find((e) => e.kind === "create");
  assert.match(line!.msg, /^first task typed into kimi t9 after \d+ms \(screen\)$/);

  // A question on screen: nothing typed, the reason comes back.
  screen = "Do you trust the files in this folder?\n> Yes";
  typed.length = 0;
  const q = await x.handlers["agent.create"]!({ launcher: "kimi", folder: "~", task: "看下 README" }, "relay");
  assert.equal(q.task, "failed");
  assert.match(q.taskNote, /它一开就在问：「Do you trust the files in this folder\?」/);
  assert.deepEqual(typed, []);
  assert.equal(x.logs.take(50).find((e) => e.kind === "create")!.level, "warn");

  // Claude Code takes it at start, as before; spaces.list says this host types tasks in.
  const c = await x.handlers["agent.create"]!({ launcher: "claude", folder: "~", task: "跑测试" }, "relay");
  assert.equal(c.task, "started");
  assert.equal(created.at(-1)!.task, "跑测试");
  h.app.spaces = async () => [];
  const offer = await x.handlers["spaces.list"]!({}, "relay");
  assert.equal(offer.typesTask, true);
  assert.deepEqual(offer.launchers.map((l: { id: string }) => l.id), ["claude", "kimi", "shell"]);
  h.stop();
});
