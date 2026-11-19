import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { Agent, ConvEvent } from "@xiaoaixiaoai/protocol";
import { InputWaits } from "../src/waiting.ts";
import { LogBuffer, levelOf } from "../src/logbuf.ts";
import { Host } from "../src/host.ts";

const agent = (status: Agent["status"], more: Partial<Agent> = {}): Agent => ({
  key: "d/hc:t1",
  deviceId: "d",
  source: "hc",
  localId: "t1",
  harness: "claude-code",
  status,
  isShell: false,
  updatedAt: 0,
  ...more,
});
const said = (text: string, ts: number): ConvEvent => ({ id: `e${ts}`, session: "claude:s", ts, kind: "user_message", text });

test("text typed into a busy agent waits until its conversation shows it", async () => {
  const w = new InputWaits();
  w.add("d/hc:t1", "q1", "测试完了再提交，别直接推", 1000);
  w.add("d/hc:t1", "q2", "顺便看下 lint", 1100);
  const [a] = w.decorate([agent("working", { sessionKey: "claude:s" })]);
  assert.equal(a!.queued, 2);
  assert.equal(a!.queuedText, "测试完了再提交，别直接推");
  assert.equal(a!.queuedSince, 1000);
  // Its conversation has only the older message so far.
  assert.equal(await w.settle([agent("working", { sessionKey: "claude:s" })], async () => [said("先跑一遍测试", 500)], 2000), false);
  // The program took the first one (Claude Code adds it as a user message).
  assert.equal(await w.settle([agent("working", { sessionKey: "claude:s" })], async () => [said("测试完了再提交， 别直接推", 5000)], 6000), true);
  assert.deepEqual(w.list("d/hc:t1").map((x) => x.id), ["q2"]);
  assert.equal(w.decorate([agent("working")])[0]!.queued, 1);
});

test("without a conversation: stopped then working again means taken; stopped long enough means gone", async () => {
  const w = new InputWaits({ idleGraceMs: 1000 });
  const none = async () => [];
  w.add("d/hc:t1", "q1", "继续", 0);
  assert.equal(await w.settle([agent("done")], none, 100), false);
  // Back at work: it took what was waiting.
  assert.equal(await w.settle([agent("working")], none, 200), true);
  assert.equal(w.size, 0);

  w.add("d/hc:t1", "q2", "继续", 300);
  await w.settle([agent("idle")], none, 400);
  assert.equal(w.size, 1);
  assert.equal(await w.settle([agent("idle")], none, 1500), true);
  assert.equal(w.size, 0);

  // A closed agent leaves nothing behind; a blocked one keeps waiting.
  w.add("d/hc:t1", "q3", "继续", 2000);
  await w.settle([agent("blocked")], none, 60_000);
  assert.equal(w.size, 1);
  assert.equal(await w.settle([], none, 60_001), true);
  assert.equal(w.size, 0);
});

test("the log ring keeps the newest lines, redacts tokens and guesses levels", () => {
  const b = new LogBuffer(3);
  for (let i = 0; i < 5; i++) b.push("info", "hostd", `line ${i}`);
  b.push("warn", "rpc", "send failed Bearer abcdefghijkl0123 hp_abcdefghijklmnop", { url: "wss://x/v1/ws?token=hp_abcdefghijklmnop", text: "x".repeat(400) });
  assert.equal(b.size, 3);
  assert.equal(b.dropped, 3);
  const out = b.take(10);
  assert.deepEqual(out.map((e) => e.msg).slice(0, 2), ["line 3", "line 4"]);
  assert.equal(out[2]!.msg, "send failed Bearer *** hp_***");
  assert.equal(out[2]!.data!.url, "wss://x/v1/ws?token=***");
  assert.ok(String(out[2]!.data!.text).length <= 301);
  assert.equal(levelOf("relay answered 502"), "info");
  assert.equal(levelOf("disconnected, retrying in 2s"), "warn");
  assert.equal(levelOf("agent.create failed: error spawning"), "error");
});

test("terminal.send to a working agent says it waits, the agent carries it, and the relay gets the log line", async () => {
  const frames: any[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (d) => frames.push(JSON.parse(d.toString())))));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const h = new Host({ config: { server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "t", deviceId: "d", name: "test" }, log: () => {} });
  // Nothing reaches a real terminal in this test.
  const typed: string[] = [];
  h.hc.send = async (_address: string, text: string) => {
    typed.push(text);
  };
  const busy = agent("working", { title: "迁移脚本" });
  h.agents = [busy];
  (h as unknown as { collect: () => Agent[] }).collect = () => h.waits.decorate([busy]);
  try {
    (h as unknown as { connect(): void }).connect();
    for (let i = 0; i < 100 && !h.connected; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(h.connected);
    await (h as unknown as { handleRpc(f: unknown): Promise<void> }).handleRpc({ type: "rpc", id: "r1", from: "relay", method: "terminal.send", params: { agent: "d/hc:t1", text: "测试完了再提交" } });
    await new Promise((r) => setTimeout(r, 400));
    const result = frames.find((f) => f.type === "rpc_result" && f.id === "r1");
    assert.deepEqual({ ...result.result, queueId: undefined }, { ok: true, queueId: undefined, position: 0, agentStatus: "working", waiting: true });
    assert.deepEqual(typed, ["测试完了再提交"]);
    const published = frames.filter((f) => f.type === "agents").pop();
    assert.equal(published.agents[0].queued, 1);
    assert.equal(published.agents[0].queuedText, "测试完了再提交");
    h.flushLogs();
    await new Promise((r) => setTimeout(r, 100));
    const lines = frames.filter((f) => f.type === "log").flatMap((f) => f.entries);
    const sent = lines.find((e: any) => e.kind === "rpc" && /^terminal\.send from assistant ok/.test(e.msg));
    assert.ok(sent, JSON.stringify(lines));
    assert.equal(sent.data.text, "测试完了再提交");
    assert.equal(sent.data["result.waiting"], true);
    // A failing call is a warning with its reason.
    await (h as unknown as { handleRpc(f: unknown): Promise<void> }).handleRpc({ type: "rpc", id: "r2", from: "relay", method: "agent.create", params: { launcher: "claude" } });
    h.flushLogs();
    await new Promise((r) => setTimeout(r, 100));
    const failed = frames.filter((f) => f.type === "log").flatMap((f) => f.entries).find((e: any) => /^agent\.create from assistant failed/.test(e.msg));
    assert.equal(failed.level, "warn");
    assert.equal(failed.data.launcher, "claude");
  } finally {
    h.stop();
    for (const c of wss.clients) c.terminate();
    wss.close();
    server.closeAllConnections();
    server.close();
  }
});
