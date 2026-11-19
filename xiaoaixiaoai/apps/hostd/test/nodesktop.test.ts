import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { test } from "node:test";
import { NoDesktopApp } from "../src/create.ts";
import { Host } from "../src/host.ts";

type Handlers = Record<string, (p: unknown, from: string) => Promise<any>>;

/** A host on a computer with herdr-core but no desktop app (Windows, a server). */
function headless() {
  const h = new Host({ config: { server: "http://127.0.0.1:9", token: "t", deviceId: "d", name: "test" }, log: () => {} });
  const x = h as unknown as { handlers: Handlers; launchersCache: unknown };
  h.sources = ["hc"];
  x.launchersCache = {
    at: Date.now(),
    list: Promise.resolve([
      { id: "claude", label: "Claude Code", takesTask: true },
      { id: "kimi", label: "Kimi Code", takesTask: false },
      { id: "shell", label: "终端", takesTask: false },
    ]),
  };
  h.firstTaskOptions = { minMs: 0, stableMs: 20, pollMs: 5, timeoutMs: 3000 };
  h.app.ls = async () => {
    throw new NoDesktopApp();
  };
  h.app.create = async () => {
    throw new NoDesktopApp();
  };
  const started: Array<{ argv: string[]; cwd: string }> = [];
  const typed: string[] = [];
  h.hc.spawnTerminal = async (argv, cwd) => {
    started.push({ argv, cwd });
    h.hc.terminals.set("t9", { address: "t9", argv, cwd, state: "live", foreground: { argv } });
    return "t9";
  };
  h.hc.list = async () => {};
  h.hc.read = async () => ({ text: "agent ready\n> ", truncated: false }) as Awaited<ReturnType<typeof h.hc.read>>;
  h.hc.send = async (_address, text) => {
    typed.push(text);
  };
  return { h, call: (m: string, p: unknown) => x.handlers[m]!(p, "phone"), started, typed };
}

test("without the desktop app, new agents can still be made: spaces.list allows it", async () => {
  const { h, call } = headless();
  const r = await call("spaces.list", {});
  assert.equal(r.canCreate, true);
  assert.equal(r.reason, undefined);
  assert.deepEqual(r.spaces, []);
  assert.equal(r.standalone, true, "the phone shows no space choices");
  h.stop();
});

test("agent.create starts the program with hc run in the folder, then types the task", async () => {
  const { h, call, started, typed } = headless();
  // Claude Code takes its task on the command line through the desktop app; `hc run` starts it bare.
  const r = await call("agent.create", { launcher: "claude", folder: homedir(), task: "fix the tests" });
  assert.equal(started.length, 1);
  assert.equal(started[0]!.cwd, homedir());
  assert.match(started[0]!.argv[0]!, /claude/);
  assert.equal(started[0]!.argv.length, 1, "no task on the command line");
  assert.deepEqual([r.agent, r.terminal, r.space, r.task], ["d/hc:t9", "t9", "", "typed"]);
  assert.deepEqual(typed, ["fix the tests"]);
  h.stop();
});

test("agent.create without a folder opens in the home folder; the shell gets no task", async () => {
  const { h, call, started } = headless();
  const r = await call("agent.create", { launcher: "shell", task: "ls" });
  assert.deepEqual(started, [{ argv: [], cwd: homedir() }]);
  assert.equal(r.task, "failed");
  h.stop();
});

test("a closed desktop window is still reported, not worked around", async () => {
  const { h, call, started } = headless();
  h.app.ls = async () => {
    throw new Error("herdr-app ls failed: no herdr window");
  };
  h.app.create = async () => {
    throw new Error("桌面 herdr 没有打开，先在电脑上打开它");
  };
  const r = await call("spaces.list", {});
  assert.equal(r.canCreate, false);
  assert.equal(r.standalone, undefined);
  await assert.rejects(call("agent.create", { launcher: "kimi" }), (e: any) => e.code === "unsupported" && /没有打开/.test(e.message));
  assert.equal(started.length, 0);
  h.stop();
});
