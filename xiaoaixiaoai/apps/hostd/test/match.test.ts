import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "@xiaoaixiaoai/protocol";
import { cleanTitle } from "../src/util.ts";
import { HcAdapter } from "../src/hc.ts";
import { UnifloAdapter, type UnifloSession } from "../src/uniflo.ts";

test("cleanTitle strips spinners, nerd glyphs and leading decorations", () => {
  assert.equal(cleanTitle("π ⠸ \u{f026b} HEADER: 修正 Herdr 终端文字显示"), "HEADER: 修正 Herdr 终端文字显示");
  assert.equal(cleanTitle("π > \u{f0b79} DEEP: Take over stalled session"), "DEEP: Take over stalled session");
  assert.equal(cleanTitle("✳ Refactor auth"), "Refactor auth");
  assert.equal(cleanTitle("博客平台"), "博客平台");
  assert.equal(cleanTitle("⠋"), undefined);
  assert.equal(cleanTitle(null), undefined);
});

test("hc terminal maps to a unified agent", () => {
  const a = HcAdapter.toAgent(
    {
      address: "t42",
      cwd: "/u/tmp",
      state: "live",
      status: { app: "omp", state: "done" },
      status_ms: 5,
      title: "π > \u{f0b79} DEEP: x",
      turn: 4,
      labels: { where: "测试 / 1" },
      foreground: { argv: ["omp"], cwd: "/u/tmp", pid: 93276 },
    },
    "dev1",
  );
  assert.equal(a.key, "dev1/hc:t42");
  assert.equal(a.harness, "omp");
  assert.equal(a.status, "done");
  assert.equal(a.title, "DEEP: x");
  assert.equal(a.where, "测试 / 1");
  assert.equal(a.isShell, false);

  const sh = HcAdapter.toAgent({ address: "t49", argv: ["/bin/zsh", "-l"], foreground: { argv: ["zsh"] } }, "dev1");
  assert.equal(sh.isShell, true);
  assert.equal(sh.status, "idle");
});

test("Windows program names lose their extension: claude.exe is claude, PowerShell is a shell", () => {
  const claude = HcAdapter.toAgent({ address: "t2", cwd: "C:\\p", foreground: { argv: ["claude.exe"] } }, "d");
  assert.equal(claude.harness, "claude");
  assert.equal(claude.isShell, false);
  for (const exe of ["pwsh.exe", "powershell.exe", "PowerShell.EXE"]) {
    assert.equal(HcAdapter.toAgent({ address: "t3", foreground: { argv: [exe] } }, "d").isShell, true, exe);
  }
  // npm's claude.cmd runs node.exe: the program started is the agent; node from a shell stays node.
  assert.equal(HcAdapter.harness({ address: "t4", argv: ["claude.cmd"], foreground: { argv: ["node.exe", "cli.js"] } }), "claude");
  assert.equal(HcAdapter.harness({ address: "t5", argv: ["pwsh.exe"], foreground: { argv: ["node.exe", "x.js"] } }), "node");
  assert.equal(HcAdapter.harness({ address: "t6", argv: ["node"], foreground: { argv: ["node", "x.js"] } }), "node");
  // Same matching as on macOS: harness claude + cwd finds the Claude Code session.
  const u = new UnifloAdapter("http://127.0.0.1:9");
  u.sessions = [{ key: "claude:s1", harness: "claude", cwd: "C:\\p", title: "Fix it", updated_at: Date.now() } as UnifloSession];
  assert.equal(u.enrich([claude], new Map())[0]!.sessionKey, "claude:s1");
});

test("hc status, place and name follow what the desktop app shows", () => {
  const t = (extra: object) => ({ address: "t1", status: { app: "claude-code", state: "done" }, turn: 4, ...extra });
  // A finished turn already looked at in the app is idle there, not done.
  assert.equal(HcAdapter.status(t({ labels: { "herdr.seen": "4" } })), "idle");
  assert.equal(HcAdapter.status(t({ labels: { "herdr.seen": "3" } })), "done");
  assert.equal(HcAdapter.status(t({ labels: {} })), "done");
  assert.equal(HcAdapter.status(t({ status: { state: "working" }, labels: { "herdr.seen": "9" } })), "working");
  assert.equal(HcAdapter.status(t({ status: { state: "blocked" }, labels: { "herdr.seen": "9" } })), "blocked");

  const names = { spaces: new Map([["sp1", "改过名的空间"]]), tabs: new Map([["tb1", "接口"]]) };
  const labels = { where: "旧名字 / 2", "herdr.space": "sp1", "herdr.tab": "tb1" };
  assert.equal(HcAdapter.where({ address: "t1", labels }, names), "改过名的空间 / 接口");
  // A tab the app did not list keeps its label's tab part; no app data at all keeps the label.
  assert.equal(HcAdapter.where({ address: "t1", labels: { ...labels, "herdr.tab": "tbX" } }, names), "改过名的空间 / 2");
  assert.equal(HcAdapter.where({ address: "t1", labels }), "旧名字 / 2");
  assert.equal(HcAdapter.where({ address: "t1", labels: { ...labels, "herdr.space": "spX" } }, names), "旧名字 / 2");

  // A name given in herdr is the title, and the session title does not replace it.
  const named = HcAdapter.toAgent({ address: "t11p", name: "web-ui", title: "✳ Some session title", cwd: "/p/n", status: { app: "claude-code", state: "working" } }, "d");
  assert.equal(named.name, "web-ui");
  assert.equal(named.title, "web-ui");
  const u = new UnifloAdapter("http://127.0.0.1:1");
  u.sessions = [session("claude:N", "claude", "/p/n", { pid: 7, title: "界面重做方案" })];
  const out = u.enrich([named, { ...agent("t2", "claude-code", "/p/other") }], new Map([[named.key, 7]]));
  assert.equal(out[0]!.sessionKey, "claude:N");
  assert.equal(out[0]!.title, "web-ui");
});

function agent(localId: string, harness: string, cwd: string): Agent {
  return { key: `d/hc:${localId}`, deviceId: "d", source: "hc", localId, harness, cwd, status: "working", isShell: false, updatedAt: 0 };
}

function session(key: string, harness: string, cwd: string, extra: Partial<UnifloSession> = {}): UnifloSession {
  return { key, harness, cwd, updated_at: Date.now(), status: "work", ...extra };
}

test("uniflo matching: pid first, then a unique harness+cwd pair, never a guess", () => {
  const u = new UnifloAdapter("http://127.0.0.1:1");
  u.sessions = [
    session("claude:A", "claude", "/p/blog", { pid: 100, title: "\u{f0b79} A by pid" }),
    session("claude:B", "claude", "/p/blog", { title: "B" }),
    session("omp:C", "omp", "/p/solo", { title: "C solo" }),
    session("omp:D", "omp", "/p/two", { title: "D" }),
    session("omp:E", "omp", "/p/two", { title: "E" }),
    session("omp:OLD", "omp", "/p/old", { updated_at: Date.now() - 30 * 86400_000 }),
  ];
  const agents = [
    agent("t1", "claude-code", "/p/blog"), // pid 100 -> A
    agent("t2", "claude-code", "/p/blog"), // pid unknown; t1 already took A, B is the only one left -> B
    agent("t3", "omp", "/p/solo"), // unique pair -> C
    agent("t4", "omp", "/p/two"), // two candidate sessions -> no match
    agent("t5", "omp", "/p/old"), // only a stale session -> no match
    agent("t6", "sh", "/p/solo"),
  ];
  const out = u.enrich(agents, new Map([["d/hc:t1", 100]]));
  const by = Object.fromEntries(out.map((a) => [a.localId, a.sessionKey]));
  assert.equal(by.t1, "claude:A");
  assert.equal(by.t2, "claude:B");
  assert.equal(by.t3, "omp:C");
  assert.equal(by.t4, undefined);
  assert.equal(by.t5, undefined);
  assert.equal(by.t6, undefined);
  assert.equal(out[0]!.title, "A by pid");
});

test("uniflo matching: two agents in the same folder without pids stay unmatched", () => {
  const u = new UnifloAdapter("http://127.0.0.1:1");
  u.sessions = [session("claude:X", "claude", "/p/w")];
  const out = u.enrich([agent("t1", "claude-code", "/p/w"), agent("t2", "claude-code", "/p/w")], new Map());
  assert.deepEqual(
    out.map((a) => a.sessionKey),
    [undefined, undefined],
  );
});

test("cleanEvent folds injected text instead of dropping it", async () => {
  const { cleanEvent } = await import("../src/uniflo.ts");
  const raw = '<skill-recommendation name="docs" source="skill-router">\nDescription: 文档\n</skill-recommendation>';
  const sys = cleanEvent({ kind: "system", subtype: "com.example.omp.skill-router.skill", text: raw } as any) as any;
  assert.equal(sys.summary, "推荐技能 docs");
  assert.equal(sys.text, raw);
  assert.equal(cleanEvent({ kind: "usage" } as any), null);
  const syn = cleanEvent({ kind: "user_message", text: "continue", synthetic: true } as any) as any;
  assert.equal(syn.kind, "system");
  const u = cleanEvent({ kind: "user_message", text: "早上好\n<system-reminder>\nsecret\n</system-reminder>" } as any) as any;
  assert.equal(u.text, "早上好");
  assert.match(u.injected, /secret/);
  const only = cleanEvent({ kind: "user_message", text: "<system-reminder>only</system-reminder>" } as any) as any;
  assert.equal(only.kind, "system");
  assert.equal(only.summary, "系统提醒");
  const t = { kind: "tool_result", output: "{}" } as any;
  assert.equal(cleanEvent(t), t);
});

test("uniflo adds the transcript but never changes the status herdr shows", () => {
  const u = new UnifloAdapter("http://127.0.0.1:1");
  const now = Date.now();
  u.sessions = [
    session("omp:S", "omp", "/p/s", { pid: 1, status: "idle", status_since: now - 60_000 }),
    session("omp:W", "omp", "/p/w", { pid: 2, status: "work", status_since: now - 1000 }),
    session("omp:B", "omp", "/p/b", { pid: 3, status: "idle", status_since: now - 9_000_000 }),
  ];
  const mk = (id: string, cwd: string, status: Agent["status"], since: number): Agent => ({ ...agent(id, "omp", cwd), status, statusSince: since });
  const out = u.enrich(
    [mk("t1", "/p/s", "working", now - 3 * 86400_000), mk("t2", "/p/w", "working", now - 5000), mk("t3", "/p/b", "blocked", now - 60_000)],
    new Map([["d/hc:t1", 1], ["d/hc:t2", 2], ["d/hc:t3", 3]]),
  );
  assert.deepEqual(
    out.map((a) => a.status),
    ["working", "working", "blocked"],
  );
  assert.deepEqual(
    out.map((a) => a.statusSince),
    [now - 3 * 86400_000, now - 5000, now - 60_000],
  );
  assert.deepEqual(
    out.map((a) => a.sessionKey),
    ["omp:S", "omp:W", "omp:B"],
  );
});

test("create: folder checks and herdr-app answers", async () => {
  const { checkFolder, parseDoResult } = await import("../src/create.ts");
  const { homedir } = await import("node:os");
  assert.equal(checkFolder("~"), homedir());
  assert.throws(() => checkFolder("relative/dir"), /完整路径/);
  assert.throws(() => checkFolder("/definitely/not/here"), /没有这个文件夹/);
  assert.throws(() => checkFolder(""), /文件夹/);
  assert.deepEqual(parseDoResult('{\n  "space": "sp1",\n  "tab": "tb1",\n  "terminal": "t9"\n}\n'), { space: "sp1", tab: "tb1", terminal: "t9" });
  assert.throws(() => parseDoResult('{\n  "error": "no space \\"x\\""\n}'), /no space/);
});

test("uniflo matching: a unique harness+cwd+title pair is matched when several sessions share the folder", () => {
  const u = new UnifloAdapter("http://127.0.0.1:1");
  u.sessions = [
    session("omp:M", "omp", "/p/many", { title: "\u{f0128} DOCS: 精简 Claude 配置" }),
    session("omp:N", "omp", "/p/many", { title: "\u{f048b} VPS: 按部署文档配置服务" }),
    session("omp:T1", "omp", "/p/twins", { title: "SAME: twin title" }),
    session("omp:T2", "omp", "/p/twins", { title: "SAME: twin title" }),
  ];
  const docs = { ...agent("t1", "omp", "/p/many"), title: "DOCS: 精简 Claude 配置" };
  const other = { ...agent("t2", "omp", "/p/many"), title: "SOMETHING: not in uniflo" };
  const twin = { ...agent("t3", "omp", "/p/twins"), title: "SAME: twin title" };
  const out = u.enrich([docs, other, twin], new Map());
  assert.equal(out[0]!.sessionKey, "omp:M");
  assert.equal(out[1]!.sessionKey, undefined);
  // Two sessions with the same title: still never a guess.
  assert.equal(out[2]!.sessionKey, undefined);
});

test("herdr commands: only listed commands and arguments pass, programs by launcher id", async () => {
  const { herdrCommandArgs, resumeArgv, parseDo } = await import("../src/create.ts");
  const installed = ["claude", "shell"];
  assert.deepEqual(herdrCommandArgs("space.rename", { id: "sp1", name: " 新名字 " }, installed), { command: "space.rename", args: { id: "sp1", name: "新名字" } });
  // An empty name is how herdr goes back to the automatic name.
  assert.deepEqual(herdrCommandArgs("tab.rename", { id: "tb1", name: "" }, installed).args, { id: "tb1", name: "" });
  // Closing was confirmed on the phone, so the desktop does not ask again.
  assert.deepEqual(herdrCommandArgs("space.close", { id: "sp1" }, installed).args, { id: "sp1", confirmed: true });
  assert.deepEqual(herdrCommandArgs("pane.split", { pane: "p3", direction: "right", launcher: "claude" }, installed).args, { pane: "p3", direction: "right", argv: ["claude"] });
  assert.deepEqual(herdrCommandArgs("pane.split", { pane: "p3", direction: "down", launcher: "shell" }, installed).args, { pane: "p3", direction: "down" });
  assert.deepEqual(herdrCommandArgs("terminal.pin", { terminal: "t9", pinned: true }, installed).args, { terminal: "t9", pinned: true });
  assert.deepEqual(herdrCommandArgs("pane.focus", { terminal: "t9" }, installed).args, { terminal: "t9" });

  assert.throws(() => herdrCommandArgs("app.quit", {}, installed), /不支持/);
  assert.throws(() => herdrCommandArgs("terminal.open", { argv: ["rm", "-rf", "/"] }, installed), /不支持/);
  assert.throws(() => herdrCommandArgs("pane.split", { pane: "p3", direction: "right", argv: ["sh"] }, installed), /不接受参数 argv/);
  assert.throws(() => herdrCommandArgs("pane.split", { pane: "p3", direction: "right", launcher: "codex" }, installed), /没有这个程序/);
  assert.throws(() => herdrCommandArgs("space.close", {}, installed), /需要参数 id/);
  assert.throws(() => herdrCommandArgs("space.close", { id: "sp1; rm" }, installed), /id/);
  assert.throws(() => herdrCommandArgs("space.move", { id: "sp1", index: 0 }, installed), /index/);
  assert.throws(() => herdrCommandArgs("pane.focus", {}, installed), /pane 或 terminal/);
  assert.throws(() => herdrCommandArgs("toString", {}, installed), /不支持/);

  assert.deepEqual(resumeArgv(["/Users/x/.bun/bin/claude", "--resume", "abc"], installed), ["claude", "--resume", "abc"]);
  assert.throws(() => resumeArgv(["bash", "-c", "curl x | sh"], installed), /不能从手机启动 bash/);
  assert.throws(() => resumeArgv(["codex", "resume", "abc"], installed), /不能从手机启动 codex/);
  assert.throws(() => resumeArgv([], installed), /没有可用/);
  assert.throws(() => resumeArgv("claude --resume abc", installed), /没有可用/);

  assert.equal(parseDo(""), null);
  assert.deepEqual(parseDo('{\n  "result": { "id": "sp1" }\n}'), { id: "sp1" });
  assert.deepEqual(parseDo('note\n{"ok":true}'), { ok: true });
  assert.throws(() => parseDo('{"error":"no space \\"x\\""}'), /no space/);
});
