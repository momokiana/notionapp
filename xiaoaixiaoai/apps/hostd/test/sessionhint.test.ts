import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeStatus, type Agent, type ConvEvent } from "@xiaoaixiaoai/protocol";
import { SessionHints, argvSessionId, firstJsonObject } from "../src/sessionhint.ts";
import { UnifloAdapter, type UnifloSession } from "../src/uniflo.ts";
import { HcAdapter, endsInPanel } from "../src/hc.ts";
import { InputWaits } from "../src/waiting.ts";

const SID = "cb7116cf-1b2a-4c3d-8e9f-0a1b2c3d4e5f";

test("a registry file with a stray brace after the object still parses", () => {
  assert.deepEqual(firstJsonObject(`{"pid":1,"sessionId":"${SID}","name":"a}b"}}`), { pid: 1, sessionId: SID, name: "a}b" });
  assert.deepEqual(firstJsonObject('{"a":{"b":1}}'), { a: { b: 1 } });
  assert.equal(firstJsonObject("not json"), undefined);
  assert.equal(firstJsonObject('{"a":'), undefined);
});

test("a session id named on the command line is found", () => {
  assert.equal(argvSessionId(["claude", "--permission-mode", "bypassPermissions", "--resume", SID]), SID);
  assert.equal(argvSessionId(["omp", "--resume=01a1afa9-5390-7000-8000-000000000000"]), "01a1afa9-5390-7000-8000-000000000000");
  assert.equal(argvSessionId(["codex", "resume", SID]), SID);
  assert.equal(argvSessionId(["claude", "--session-id", SID]), SID);
  assert.equal(argvSessionId(["/u/.bun/bin/claude", "attach", "fb266ac5"]), "fb266ac5");
  assert.equal(argvSessionId(["claude", "-p", "attach", "fb266ac5"]), undefined, "only as the subcommand");
  // A bare --resume opens a picker: nothing to match on.
  assert.equal(argvSessionId(["claude", "--resume"]), undefined);
  assert.equal(argvSessionId(["claude", "--model", "opus"]), undefined);
  assert.equal(argvSessionId(undefined), undefined);
});

test("Claude Code's live session comes from its registry file, for that pid only", () => {
  const home = mkdtempSync(join(tmpdir(), "hp-hint-"));
  try {
    mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
    writeFileSync(join(home, ".claude", "sessions", "4242.json"), `{"pid":4242,"sessionId":"${SID}","cwd":"/w"}}`);
    writeFileSync(join(home, ".claude", "sessions", "77.json"), `{"pid":78,"sessionId":"${SID}"}`);
    const h = new SessionHints(home);
    // The registry wins over --resume: /clear starts a new session in the same process.
    assert.equal(h.key("claude", ["claude", "--resume", "11111111-2222-3333-4444-555555555555"], 4242), `claude:${SID}`);
    assert.equal(h.key("claude", ["claude", "--resume", "11111111-2222-3333-4444-555555555555"], 9999), "claude:11111111-2222-3333-4444-555555555555");
    assert.equal(h.key("claude", ["claude"], 77), undefined, "a reused pid's old file is ignored");
    assert.equal(h.key("omp", ["omp", "--resume", SID], 4242), `omp:${SID}`);
    assert.equal(h.key(undefined, ["claude", "--resume", SID], 4242), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const agent = (key: string, more: Partial<Agent> = {}): Agent => ({
  key,
  deviceId: "d",
  source: "hc",
  localId: key.split(":")[1]!,
  harness: "claude-code",
  cwd: "/w/app",
  status: "idle",
  isShell: false,
  updatedAt: 0,
  ...more,
});
const session = (key: string, more: Partial<UnifloSession> = {}): UnifloSession => ({
  key,
  harness: "claude",
  cwd: "/w/app",
  title: key,
  updated_at: Date.now(),
  status: "idle",
  ...more,
});

test("an agent's named session is used even when it is too old for the recent list", async () => {
  const u = new UnifloAdapter("http://127.0.0.1:1");
  const old = session(`claude:${SID}`, { updated_at: Date.now() - 30 * 86400_000, title: "旧会话" });
  u.sessions = [session("claude:recent-1"), session("claude:recent-2")];
  let fetched = 0;
  (u as unknown as { get: (p: string) => Promise<unknown> }).get = async (p) => {
    fetched++;
    if (p === `/v1/sessions/${encodeURIComponent(old.key)}`) return old;
    throw new Error("404");
  };
  let changed = 0;
  (u as unknown as { onChange: () => void }).onChange = () => changed++;
  const agents = [agent("d/hc:t1"), agent("d/hc:t2"), agent("d/hc:t3")];
  const hints = new Map([["d/hc:t1", old.key], ["d/hc:t3", "claude:missing-session"]]);

  // First pass: not known yet, fetched in the background; nothing is guessed meanwhile.
  assert.equal(u.enrich(agents, new Map(), hints)[0]!.sessionKey, undefined);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(changed, 1);
  const out = u.enrich(agents, new Map(), hints);
  assert.equal(out[0]!.sessionKey, old.key);
  assert.equal(out[0]!.title, "旧会话");
  assert.equal(out[2]!.sessionKey, undefined);
  // Not found: not asked again on every pass.
  const before = fetched;
  u.enrich(agents, new Map(), hints);
  assert.equal(fetched, before);
});

test("a short id from `claude attach` resolves to the one session it starts", async () => {
  const u = new UnifloAdapter("http://127.0.0.1:1");
  u.sessions = [session("claude:recent-1")];
  const full = session("claude:fb266ac5-0000-4000-8000-000000000001", { title: "后台会话" });
  (u as unknown as { get: (p: string) => Promise<unknown> }).get = async (p) => {
    if (p.startsWith("/v1/sessions?")) return [full, session("omp:01a0d9aa-0000-7000-8000-000000000000", { harness: "omp" })];
    throw new Error("404");
  };
  (u as unknown as { onChange: () => void }).onChange = () => {};
  const hints = new Map([["d/hc:t1", "claude:fb266ac5"]]);
  u.enrich([agent("d/hc:t1")], new Map(), hints);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(u.enrich([agent("d/hc:t1")], new Map(), hints)[0]!.sessionKey, full.key);
});

test("an error state reads as waiting for a person, with what the program said", () => {
  assert.equal(normalizeStatus("error"), "blocked");
  const t = {
    address: "t9",
    status: { app: "claude-code", state: "error", msg: "There's an issue with the selected model.  Run /model." },
    foreground: { argv: ["claude"] },
  };
  const a = HcAdapter.toAgent(t, "d");
  assert.equal(a.status, "blocked");
  assert.equal(a.statusNote, "There's an issue with the selected model. Run /model.");
  assert.equal(a.errored, true);
  assert.equal(HcAdapter.toAgent({ ...t, status: { app: "claude-code", state: "blocked" } }, "d").errored, undefined);
  assert.equal(HcAdapter.toAgent({ ...t, status: { app: "claude-code", state: "idle", msg: "x" } }, "d").statusNote, undefined);
});

test("a panel's footer at the bottom of the screen is recognised", () => {
  const status = ["❯ ", "   Settings  Status   Config", "   Version:   2.1.325", "   Model:     opus", "   Esc to cancel", "", ""].join("\n");
  assert.equal(endsInPanel(status), true);
  assert.equal(endsInPanel("  Select model\n  1. Opus\n  Enter to confirm · Esc to exit\n"), true);
  // The idle prompt and a working turn are not panels.
  assert.equal(endsInPanel("❯ \n─────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n"), false);
  assert.equal(endsInPanel("✢ Kneading… (esc to interrupt)\n❯ \n"), false);
  assert.equal(endsInPanel("old panel\nEsc to cancel\n" + "line\n".repeat(6)), false, "only the bottom counts");
});

test("text that left the screen was taken in the middle of a turn", async () => {
  const w = new InputWaits({ landMs: 1000 });
  w.add("d/hc:t1", "q1", "顺便把 lint 也跑一下", 0);
  const busy = [agent("d/hc:t1", { status: "working" })];
  const none = async (): Promise<ConvEvent[]> => [];
  // Still in the input box: waits.
  assert.equal(await w.settle(busy, none, 5000, async () => "❯ 顺便把 lint 也跑一下\n"), false);
  assert.equal(w.list("d/hc:t1").length, 1);
  // Too early to judge by absence (the send queue may not have typed it yet).
  const early = new InputWaits({ landMs: 1000 });
  early.add("d/hc:t1", "q1", "顺便把 lint 也跑一下", 4500);
  assert.equal(await early.settle(busy, none, 5000, async () => "❯ \n"), false);
  // A long paste shows as a placeholder: its absence proves nothing.
  assert.equal(await w.settle(busy, none, 6000, async () => "❯ [Pasted text #1 +12 lines]\n"), false);
  // Gone from the screen: taken.
  assert.equal(await w.settle(busy, none, 7000, async () => "⏺ Running tests…\n❯ \n"), true);
  assert.equal(w.list("d/hc:t1").length, 0);
});

test("harness icons from Uniflo are passed on only when they are plain shapes", async () => {
  const { safeIconSvg } = await import("../src/uniflo.ts");
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><title>W</title><path fill-rule="evenodd" d="M1 1h22v22H1z"/></svg>';
  assert.equal(safeIconSvg(`<?xml version="1.0"?>\n${ok}\n`), ok);
  assert.equal(safeIconSvg('<svg><script>alert(1)</script></svg>'), undefined);
  assert.equal(safeIconSvg('<svg><path onload="x()" d="M0 0"/></svg>'), undefined);
  assert.equal(safeIconSvg('<svg><image href="https://example.com/a.png"/></svg>'), undefined);
  assert.equal(safeIconSvg('<svg><path style="fill:url(#g)" d="M0 0"/></svg>'), undefined);
  assert.equal(safeIconSvg('<svg><foreignObject/></svg>'), undefined);
  assert.equal(safeIconSvg("<html></html>"), undefined);
  assert.equal(safeIconSvg(`<svg>${"<path d=\"M0 0\"/>".repeat(6000)}</svg>`), undefined, "too big");

  // Fetched once per id; a 404 is remembered, odd ids are never asked for.
  const seen: string[] = [];
  const server = (await import("node:http")).createServer((req, res) => {
    seen.push(req.url ?? "");
    if (req.url === "/v1/harnesses/workbuddy/icon.svg") return res.end(ok);
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const u = new UnifloAdapter(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    assert.deepEqual(await u.icons(["workbuddy", "nope", "../etc", "workbuddy"]), { workbuddy: ok });
    assert.deepEqual(await u.icons(["workbuddy", "nope"]), { workbuddy: ok });
    assert.deepEqual(seen.sort(), ["/v1/harnesses/nope/icon.svg", "/v1/harnesses/workbuddy/icon.svg"]);
  } finally {
    server.close();
  }
});

test("a waiting message with pictures previews its words and a count, not the paths", () => {
  const w = new InputWaits();
  w.add("d/hc:t1", "q1", "看下这个报错\n/u/.local/state/herdr-core/default/files/t1/shot-1.jpg\n/u/.local/state/herdr-core/default/files/t1/shot-2.png", 0);
  assert.equal(w.decorate([agent("d/hc:t1", { status: "working" })])[0]!.queuedText, "看下这个报错 · 图片 ×2");
  const only = new InputWaits();
  only.add("d/hc:t1", "q1", "/u/files/t1/a.webp", 0);
  assert.equal(only.decorate([agent("d/hc:t1", { status: "working" })])[0]!.queuedText, "图片 ×1");
  const plain = new InputWaits();
  plain.add("d/hc:t1", "q1", "改一下 src/a.png 的尺寸", 0);
  assert.equal(plain.decorate([agent("d/hc:t1", { status: "working" })])[0]!.queuedText, "改一下 src/a.png 的尺寸");
});
