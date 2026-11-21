/**
 * Acting at once (the default), honest results, finding agents by spoken names,
 * the "ask first" setting, and the event log. Fake model and fake computers only.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { Agent, AssistantItem, LogEntry, ServerFrame } from "@xiaoaixiaoai/protocol";
import { Relay } from "../src/server.ts";
import type { Llm, LlmRequest, LlmResult } from "../src/assistant/llm.ts";
import { guardClaims, newFacts } from "../src/assistant/guard.ts";
import { foldName, nameScore } from "../src/assistant/lookup.ts";
import { redact } from "../src/eventlog.ts";
import { systemPrompt, voiceInstructions } from "../src/assistant/prompts.ts";

const ADMIN = "admin-token-for-actions-tests-0123456789";
let relay: Relay;
let base: string;
let dir: string;
let moss: WebSocketServer;
let mossPort: number;

let script: (req: LlmRequest) => LlmResult | Promise<LlmResult> = () => text("好");
const seen: LlmRequest[] = [];
const llm: Llm = async (req) => {
  seen.push(req);
  return String(req.system).includes("# 现在：你被叫醒了") ? text("不用说") : script(req);
};
function text(t: string): LlmResult {
  return { content: [{ type: "text", text: t }], stopReason: "end_turn", model: "test" };
}
function call(name: string, input: unknown): LlmResult {
  return { content: [{ type: "tool_use", id: `c${Math.random().toString(36).slice(2, 7)}`, name, input }], stopReason: "tool_use", model: "test" };
}
function toolResults(req: LlmRequest): string[] {
  const last = req.messages[req.messages.length - 1]!;
  return Array.isArray(last.content) ? last.content.filter((b) => b.type === "tool_result").map((b) => (b as { content: string }).content) : [];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "pocket-actions-"));
  moss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => moss.once("listening", () => r()));
  mossPort = (moss.address() as { port: number }).port;
  relay = new Relay({
    dbPath: join(dir, "t.db"),
    adminToken: ADMIN,
    rpcTimeoutMs: 1500,
    log: () => {},
    llm,
    live: { url: `ws://127.0.0.1:${mossPort}/v1/realtime`, apiKey: "moss-test-key", model: "moss-live-1.0", refreshGapMs: 0 },
    assistantTiming: { blockedDelayMs: 30, doneDelayMs: 30, noticeGapMs: 0, reminderTickMs: 20, wakeTimeoutMs: 300, blockedWakeTimeoutMs: 300, promptEpoch: 0 },
  });
  base = `http://127.0.0.1:${await relay.listen(0, "127.0.0.1")}`;
});

after(async () => {
  await relay.close();
  await new Promise<void>((r) => moss.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function api(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const raw = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { status: res.status, json, raw, type: res.headers.get("content-type") ?? "" };
}

async function pair(kind: "host" | "viewer", name: string) {
  const code = (await api("/v1/pair/codes", { token: ADMIN, body: { kind } })).json.code;
  return (await api("/v1/pair", { body: { code, name, kind } })).json as { token: string; device: { id: string } };
}

class Sock {
  frames: any[] = [];
  private waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void }> = [];
  ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (d, isBinary) => {
      if (isBinary) return;
      const f = JSON.parse(d.toString());
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => (w.pred(f) ? (w.resolve(f), false) : true));
    });
  }
  static open(path: string, token: string): Promise<Sock> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}${path}?token=${encodeURIComponent(token)}`);
      const s = new Sock(ws);
      ws.once("open", () => resolve(s));
      ws.once("error", reject);
    });
  }
  next(pred: (f: any) => boolean, ms = 3000): Promise<any> {
    const hit = this.frames.find(pred);
    if (hit) {
      this.frames.splice(this.frames.indexOf(hit), 1);
      return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      this.waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(t);
          this.frames.splice(this.frames.indexOf(f), 1);
          resolve(f);
        },
      });
    });
  }
  send(f: unknown) {
    this.ws.send(JSON.stringify(f));
  }
}

function agent(localId: string, status: Agent["status"], title: string, more: Partial<Agent> = {}): Partial<Agent> {
  return { localId, source: "hc", harness: "claude-code", status, title, isShell: false, updatedAt: Date.now(), sessionKey: `claude:${localId}`, ...more };
}

async function fakeHost(name: string, answer?: (method: string, params: any) => unknown) {
  const host = await pair("host", name);
  const h = await Sock.open("/v1/ws", host.token);
  await h.next((f) => f.type === "welcome");
  const calls: Array<{ method: string; params: any; from: string }> = [];
  h.ws.on("message", (d) => {
    const f = JSON.parse(d.toString()) as ServerFrame;
    if (f.type !== "rpc") return;
    calls.push({ method: f.method, params: f.params, from: f.from });
    const own = answer?.(f.method, f.params) as { rpcError?: { code: string; message: string } } | undefined;
    if (own !== undefined) {
      h.send(own.rpcError ? { type: "rpc_result", id: f.id, error: own.rpcError } : { type: "rpc_result", id: f.id, result: own });
      return;
    }
    h.send({ type: "rpc_result", id: f.id, result: f.method === "terminal.send" ? { ok: true, position: 0, agentStatus: "idle", waiting: false } : { ok: true } });
  });
  const publish = async (agents: Array<Partial<Agent>>) => {
    h.send({ type: "agents", agents });
    await sleep(40);
  };
  return { host, h, calls, publish };
}

/** One typed turn: the model makes these calls in order, then says `finally`; returns each tool result. */
async function turn(phone: { token: string }, viewer: Sock, said: string, steps: Array<[string, unknown]>, finally_ = "好"): Promise<string[]> {
  const got: string[] = [];
  let i = 0;
  script = (req) => {
    const results = toolResults(req);
    if (results.length) got.push(results[0]!);
    return i < steps.length ? call(steps[i]![0], steps[i++]![1]) : text(finally_);
  };
  await api("/v1/assistant/messages", { token: phone.token, body: { text: said } });
  await viewer.next((f) => f.type === "assistant_busy" && f.busy === false, 4000);
  return got;
}

async function openCall(token: string) {
  const upstream = new Promise<Sock>((resolve) => moss.once("connection", (ws) => resolve(new Sock(ws))));
  const phone = await Sock.open("/v1/assistant/live", token);
  const up = await upstream;
  await up.next((f) => f.action === "attach_session");
  up.send({ action: "session_attached", data: { session_id: "s1", memory_scope: "session", delegation: "client" } });
  await up.next((f) => f.action === "session.update");
  up.send({ action: "session.updated", data: { error: "", tools: [] } });
  await phone.next((f) => f.action === "relay.state" && f.data.state === "ready");
  return { phone, up };
}

/** The agents of the 2026-11-14 10:09 call, named as the desktop app showed them. */
const MORNING = [
  agent("t77", "working", "语音助理功能", { where: "herdr演示端 / 1", cwd: "/home/me/code/xiaoaixiaoai" }),
  agent("t5", "idle", "测试任务", { where: "测试 / 1", cwd: "/home/me/code/sandbox" }),
  agent("t9", "idle", "herdr core 重构", { where: "herdr / 2", harness: "codex", cwd: "/home/me/code/herdr" }),
];

test("names the way speech recognition writes them find the agent; a miss offers the closest ones", async () => {
  assert.equal(foldName("黑的演示端那边"), foldName("herdr演示端"));
  assert.equal(foldName("黑德演示端"), foldName("herdr演示端"));
  assert.equal(foldName("克劳德"), "claude");
  assert.equal(foldName("扣德克斯那个"), "codex");
  assert.ok(nameScore(foldName("黑的演示端那边"), ["herdr演示端"]) === 100);
  assert.ok(nameScore(foldName("herdr演示端的克劳德"), ["herdr演示端", "claude"]) >= 90);

  const { host, publish } = await fakeHost("MacBook");
  await publish(MORNING);
  const id = host.device.id;
  assert.equal(relay.assistant.resolveAgent("黑的演示端那边").key, `${id}/hc:t77`);
  assert.equal(relay.assistant.resolveAgent("赫德演示端").key, `${id}/hc:t77`);
  assert.equal(relay.assistant.resolveAgent("扣德克斯那个").key, `${id}/hc:t9`);
  assert.equal(relay.assistant.resolveAgent("MacBook/t5").key, `${id}/hc:t5`);
  // Nothing close: the error lists real candidates instead of a bare "not found".
  assert.throws(() => relay.assistant.resolveAgent("支付回调"), (e: Error) => /最接近的几个/.test(e.message) && /hc:t/.test(e.message));
  await publish([]);
});

test("by default an action runs at once and the answer reports what really happened, including a message queued behind a busy agent", async () => {
  const { host, calls, publish } = await fakeHost("Mac Q", (method) => (method === "terminal.send" ? { ok: true, position: 0, agentStatus: "working", waiting: true } : undefined));
  await publish([agent("t1", "working", "迁移脚本", { where: "迁移 / 1", queued: 1, queuedText: "先跑测试" })]);
  const phone = await pair("viewer", "Phone Q");
  const viewer = await Sock.open("/v1/ws", phone.token);
  await viewer.next((f) => f.type === "snapshot");
  assert.equal((await api("/v1/assistant/settings", { token: phone.token })).json.confirm, "never");

  const [result] = await turn(phone, viewer, "跟迁移那边说测试完了再提交", [["send_to_agent", { agent: "迁移那边", text: "测试完了再提交" }]], "发了，它正忙着，这一轮完了才会看到。");
  // Sent at once, from the relay, with the person's words.
  const sends = calls.filter((c) => c.method === "terminal.send");
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.params.agent, `${host.device.id}/hc:t1`);
  assert.equal(sends[0]!.params.text, "测试完了再提交");
  assert.match(result!, /^办了：给「迁移脚本」发送：测试完了再提交。结果：发了，它正在忙这一轮，消息先排在它的输入框里，这一轮完了才会处理（它前面还排着 1 条）/);
  assert.match(result!, /它还没有回复：不要说它回了什么/);
  // The card shows the outcome; nothing waits for a button.
  const items = (await api("/v1/assistant", { token: phone.token })).json.items as AssistantItem[];
  const card = items.filter((i) => i.action).pop()!;
  assert.equal(card.action!.state, "done");
  assert.match(card.action!.result!, /排在它的输入框里/);
  // The board the model reads says what is waiting in the agent's input.
  assert.match(String(seen[seen.length - 1]!.system), /输入框里排着 1 条没处理/);
  await publish([]);
});

test("the 10:09 call: delivered and answered are never claimed without a send and a read behind them", async () => {
  const { host, calls, publish } = await fakeHost("Mac M", (method) => (method === "terminal.send" ? { ok: true, position: 0, agentStatus: "working", waiting: true } : undefined));
  await publish(MORNING);
  const phone = await pair("viewer", "Phone M");
  const viewer = await Sock.open("/v1/ws", phone.token);
  await viewer.next((f) => f.type === "snapshot");
  const fabricated = "递过去了，那边回话说创建空间、起终端派活、监控、查花费这些都有。";

  // In a call: no confirmation; the target is found from "黑的演示端那边"; the invented reply is dropped.
  const { phone: callSock, up } = await openCall(phone.token);
  script = (req) => (toolResults(req).length ? text(fabricated) : call("send_to_agent", { agent: "黑的演示端那边", text: "目前这些是缺陷：不能新建 Claude Code" }));
  up.send({ action: "session.delegation.created", data: { delegation: { id: "d1", type: "task" }, purpose: "task", objective: "跟黑的演示端那边说一下目前这些是缺陷", context: [] } });
  const said = await up.next((f) => f.action === "session.commentary.append" && f.delegation_id === "d1" && f.status === "completed");
  assert.equal(calls.filter((c) => c.method === "terminal.send").length, 1);
  assert.equal(calls[0]!.params.agent, `${host.device.id}/hc:t77`);
  assert.doesNotMatch(said.content, /回话|那边说|都有/);
  assert.match(said.content, /发过去了/);
  callSock.send({ action: "relay.hangup" });
  await callSock.next((f) => f.action === "relay.state" && f.data.state === "closed");

  // With "ask first" on in a typed chat: the send waits, and "递过去了" becomes the truth.
  await api("/v1/assistant/settings", { token: phone.token, body: { confirm: "always" } });
  try {
    await viewer.next((f) => f.type === "assistant_reset");
    script = (req) => (toolResults(req).length ? text(fabricated) : call("send_to_agent", { agent: "黑德演示端", text: "目前这些是缺陷" }));
    await api("/v1/assistant/messages", { token: phone.token, body: { text: "跟黑德演示端说目前这些是缺陷" } });
    await viewer.next((f) => f.type === "assistant_busy" && f.busy === false, 4000);
    const items = (await api("/v1/assistant", { token: phone.token })).json.items as AssistantItem[];
    const answer = items.filter((i) => i.role === "assistant" && !i.action).pop()!;
    assert.equal(answer.text, "还没发，等你点头：要发吗？");
    assert.equal(calls.filter((c) => c.method === "terminal.send").length, 1);
    assert.equal(items.filter((i) => i.action?.state === "pending").length, 1);
  } finally {
    await api("/v1/assistant/settings", { token: phone.token, body: { confirm: "never" } });
  }

  // Both corrections are in the log, with what was said and what replaced it.
  const guards = (await api("/v1/logs?kind=guard&since=1h", { token: ADMIN })).json.entries as LogEntry[];
  assert.ok(guards.some((g) => /call: replaced a claim \(reply\)/.test(g.msg)));
  assert.ok(guards.some((g) => /text: replaced a claim \(reply,delivery\)/.test(g.msg)));
  await publish([]);
});

test("the guard leaves true sentences alone", () => {
  const facts = newFacts();
  assert.deepEqual(guardClaims("六个在跑，最急的是支付回调。", facts), { text: "六个在跑，最急的是支付回调。", fixed: [] });
  facts.actions.push({ kind: "send", state: "done", seq: ++facts.seq });
  assert.equal(guardClaims("发了，它还没回，回了我叫你。", facts).text, "发了，它还没回，回了我叫你。");
  // Read after sending: what it answered is real.
  facts.reads.push({ agent: "x", seq: ++facts.seq });
  assert.equal(guardClaims("发了，它回复说马上改。", facts).text, "发了，它回复说马上改。");
  const failed = newFacts();
  failed.actions.push({ kind: "send", state: "failed", result: "这台电脑现在不在线", seq: 1 });
  assert.equal(guardClaims("已经发过去了。", failed).text, "没发成：这台电脑现在不在线。");
  // Conditional future send and explicit negations must stay intact when pending confirmation.
  const pending = newFacts();
  pending.actions.push({ kind: "send", state: "pending", seq: 1 });
  const conditional = "消息已经写好了，你点确认后我就发出去，发完我会盯着它的回复。";
  assert.deepEqual(guardClaims(conditional, pending), { text: conditional, fixed: [] });
  const negated = "**Checking 那条大概率没发过去。**";
  assert.deepEqual(guardClaims(negated, pending), { text: negated, fixed: [] });
});

test("prompts: acting at once by default, asking only when chosen, and never inventing replies", () => {
  const direct = systemPrompt("小羊", "text", "");
  const ask = systemPrompt("小羊", "text", "", { confirm: true });
  assert.match(direct, /直接调用工具去做，不用再问我/);
  assert.doesNotMatch(direct, /动手之前先问我/);
  assert.match(ask, /动手之前先问我/);
  assert.match(ask, /点确认就发/);
  // A call never asks, whatever the setting.
  assert.doesNotMatch(systemPrompt("小羊", "call", "", { confirm: true }), /动手之前先问我/);
  for (const p of [direct, ask]) {
    assert.match(p, /别的 agent 回了什么，只有你用 read_agent 读到了才能说/);
    assert.match(p, /“黑的”“黑德”是 herdr/);
    assert.match(p, /read_logs/);
  }
  assert.match(voiceInstructions({ board: "", pending: [], recent: "" }), /结果回来之前，不说办好了、发过去了，更不替别的 agent 说它回了什么/);
});

test("relaying: the agent gets the distilled message, the card keeps who, where and the person's own words, and the wake-up judges against those words", async () => {
  const SPOKEN = "嗯……你跟博客那边说一下，就是他刚才那个图片上传的问题，先别管样式了，先把上传修好，哦对，别动数据库，修完跑一下测试再提交。";
  const SENT = "先把图片上传修好，样式先不管。别动数据库。修完跑一下测试再提交。";
  const { host, calls, publish } = await fakeHost("Mac R", (method) =>
    method === "session.events"
      ? {
          sessionKey: "claude:t3",
          more: false,
          events: [
            { id: "1", session: "claude:t3", ts: 1, kind: "user_message", text: SENT },
            { id: "2", session: "claude:t3", ts: 2, kind: "assistant_message", text: "上传修好了，测试通过，已提交。" },
          ],
        }
      : undefined,
  );
  const blog = (status: Agent["status"]) => agent("t3", status, "Fix image upload in the blog editor", { where: "博客平台 / 1", cwd: "/home/me/code/blog" });
  await publish([blog("idle")]);
  const phone = await pair("viewer", "Phone R");
  const viewer = await Sock.open("/v1/ws", phone.token);
  await viewer.next((f) => f.type === "snapshot");

  // The rules are where the model writes the message: the prompt and the tool.
  const prompt = systemPrompt("小羊", "text", "");
  assert.match(prompt, /传话。/);
  assert.match(prompt, /去掉口头禅、犹豫、我改口之前的说法/);
  assert.match(prompt, /一个不丢、一字不改/);
  assert.match(prompt, /不加我没说的要求/);
  assert.match(prompt, /就一字不动地发/);
  assert.match(prompt, /先用半句话问我，别猜着发/);
  assert.doesNotMatch(prompt, /不替我润色/);
  assert.doesNotMatch(systemPrompt("小羊", "text", "", { confirm: true }), /不替我润色/);

  // Words that are already the message leave no second copy.
  await turn(phone, viewer, "跟博客那边说：先别动", [["send_to_agent", { agent: "博客那边", text: "先别动", said: " 先别动 " }]], "发了。");
  let items = (await api("/v1/assistant", { token: phone.token })).json.items as AssistantItem[];
  assert.equal(items.filter((i) => i.action).pop()!.action!.said, undefined);
  const tool = seen[seen.length - 1]!.tools.find((t) => t.name === "send_to_agent")!;
  assert.doesNotMatch(tool.description, /不润色/);
  assert.match(tool.description, /不是把我的话原样搬过去/);
  assert.ok((tool.input_schema as { properties: Record<string, unknown> }).properties.said);

  // The model says a few words before it sends: its answer still lands after the card, as it does after a restart.
  let round = 0;
  script = (req) => {
    if (round++) return text("发了。");
    req.onText?.("好，我跟它说。");
    return { content: [{ type: "text", text: "好，我跟它说。" }, { type: "tool_use", id: "cs1", name: "send_to_agent", input: { agent: "博客那边", text: SENT, said: SPOKEN } }], stopReason: "tool_use", model: "test" };
  };
  await api("/v1/assistant/messages", { token: phone.token, body: { text: SPOKEN } });
  await viewer.next((f) => f.type === "assistant_busy" && f.busy === false, 4000);
  const sends = calls.filter((c) => c.method === "terminal.send");
  assert.equal(sends.length, 2);
  assert.equal(sends[1]!.params.text, SENT);
  items = (await api("/v1/assistant", { token: phone.token })).json.items as AssistantItem[];
  const cardAt = items.findLastIndex((i) => i.action);
  const replyAt = items.findLastIndex((i) => i.role === "assistant" && !i.action);
  assert.equal(items[replyAt]!.text, "发了。");
  assert.ok(replyAt > cardAt, "the answer comes after the card it reports on");
  assert.deepEqual(items[replyAt]!.steps, ["给「博客平台」发了消息"]);
  const card = items[cardAt]!.action!;
  assert.equal(card.state, "done");
  assert.equal(card.text, SENT);
  assert.equal(card.said, SPOKEN);
  // Named the way the answer names it, on the computer it is on.
  assert.equal(card.agentName, "博客平台");
  assert.equal(card.agentTitle, "Fix image upload in the blog editor");
  assert.equal(card.deviceName, "Mac R");
  assert.equal(card.device, host.device.id);
  const logged = (await api("/v1/logs?kind=action&since=1h", { token: ADMIN })).json.entries as LogEntry[];
  assert.ok(logged.some((l) => /send done/.test(l.msg) && JSON.stringify(l.data ?? {}).includes("别动数据库")));

  // Its turn ends: the look compares what it did with what the person said, not only with the message.
  const before = seen.length;
  await publish([blog("working")]);
  await publish([blog("done")]);
  let woken: LlmRequest | undefined;
  for (let i = 0; i < 50 && !woken; i++) {
    await sleep(20);
    woken = seen.slice(before).find((r) => String(r.system).includes("# 现在：你被叫醒了"));
  }
  const material = String(woken!.messages[0]!.content);
  assert.match(material, new RegExp(`我让它做的：\\n${SENT}`));
  assert.match(material, /我交代时的原话（你整理成上面那条发给它的）：\n嗯……你跟博客那边说一下/);
  assert.match(String(woken!.system), /材料里有“我交代时的原话”的，以那段为准/);
  await publish([]);
});

test("new space, new agent named by program name, costs per space, and the log answers 'where did it get stuck'", async () => {
  const spacesList = {
    spaces: [{ id: "sp1", name: "测试", tabs: 1, terminals: 1 }],
    launchers: [
      { id: "claude", label: "Claude Code", takesTask: true },
      { id: "opencode", label: "OpenCode", takesTask: false },
      { id: "shell", label: "终端", takesTask: false },
    ],
    folders: [],
    canCreate: true,
  };
  let failCreate = false;
  const { host, calls, publish } = await fakeHost("Mac C", (method) => {
    if (method === "spaces.list") return spacesList;
    if (method === "agent.create") return failCreate ? { rpcError: { code: "unsupported", message: "桌面 herdr 没有打开，先在电脑上打开它" } } : { agent: "x/hc:t40", space: "sp1", terminal: "t40" };
    return undefined;
  });
  await publish([
    agent("t1", "working", "接口文档", { where: "文档 / 1", costUsd: 1.25, contextTokens: 50_000, contextLimit: 200_000 }),
    agent("t2", "idle", "接口示例", { where: "文档 / 2", costUsd: 0.75 }),
    agent("t3", "working", "迁移", { where: "测试 / 1", costUsd: 3 }),
  ]);
  const phone = await pair("viewer", "Phone C");
  const viewer = await Sock.open("/v1/ws", phone.token);
  await viewer.next((f) => f.type === "snapshot");

  const [created] = await turn(phone, viewer, "在测试空间里开个克劳德，让它把测试跑一遍", [["create_agent", { device: "Mac C", launcher: "克劳德", space: "测试", task: "把测试跑一遍" }]]);
  assert.deepEqual(calls.filter((c) => c.method === "agent.create")[0]!.params, { launcher: "claude", space: "sp1", task: "把测试跑一遍" });
  assert.match(created!, /^办了：在「Mac C」的空间「测试」里开一个 Claude Code，任务：把测试跑一遍。结果：开好了，任务随启动一起交给它了/);

  const [space] = await turn(phone, viewer, "新建一个叫发布的空间", [["create_space", { device: "Mac C", name: "发布" }]]);
  assert.deepEqual(calls.filter((c) => c.method === "agent.create")[1]!.params, { launcher: "shell", spaceName: "发布" });
  assert.match(space!, /新建空间「发布」/);

  // A computer whose hostd cannot type tasks in yet: the task is not sent, and the answer says so.
  const [noTask] = await turn(phone, viewer, "开个 opencode 让它看日志", [["create_agent", { device: "Mac C", launcher: "OpenCode", task: "看日志" }]]);
  assert.match(noTask!, /OpenCode 启动时不能带任务，这台电脑的 hostd 也还不会替它打进去（要更新），任务没交给它/);
  assert.equal(calls.filter((c) => c.method === "agent.create").at(-1)!.params.task, undefined);

  const [costs] = await turn(phone, viewer, "哪个空间最费钱", [["costs", {}]]);
  assert.match(costs!, /开着的 3 个 agent 合计 \$5\.00/);
  assert.match(costs!, /Mac C \/ 测试 \| \$3\.00 \| 1 个 agent/);
  assert.match(costs!, /Mac C \/ 文档 \| \$2\.00 \| 2 个 agent \| 最贵：.+\$1\.25/);
  const [perAgent] = await turn(phone, viewer, "接口文档上下文快满了吗", [["costs", { group_by: "agent", space: "文档" }]]);
  assert.match(perAgent!, /上下文 50k\/200k（25%）/);

  // A failure is reported as it is, and the log says where it got stuck.
  failCreate = true;
  const [failed] = await turn(phone, viewer, "再开一个克劳德", [["create_agent", { device: "Mac C", launcher: "claude", space: "测试" }]]);
  assert.match(failed!, /^没办成：.+原因：桌面 herdr 没有打开，先在电脑上打开它/);
  const [logs] = await turn(phone, viewer, "刚才卡在哪一步", [["read_logs", { kind: "action", since: "10m" }]]);
  assert.match(logs!, /WARN relay\/Mac C action: create failed \d+ms: 在「Mac C」.+-> 桌面 herdr 没有打开/);
  const rpc = (await api(`/v1/logs?kind=rpc&device=Mac%20C`, { token: ADMIN })).json.entries as LogEntry[];
  assert.ok(rpc.some((e) => /^agent\.create assistant -> Mac C ok/.test(e.msg) && e.data?.launcher === "claude"));
  assert.ok(rpc.some((e) => /^agent\.create assistant -> Mac C unsupported: 桌面 herdr 没有打开/.test(e.msg)));
  void host;
  await publish([]);
});

test("any installed program can be started by its spoken name; its task is typed in once it is up, and the answer says what really happened", async () => {
  for (const [said, meant] of [
    ["克拉克", "claude"],
    ["扣德克斯", "codex"],
    ["基米", "kimi"],
    ["卓德", "droid"],
    ["扣得巴迪", "codebuddy"],
    ["千问", "qwen"],
    ["科瑟", "cursor"],
    ["Cursor Agent", "cursor"],
    ["吉米尼", "gemini"],
  ] as const) assert.equal(foldName(said), meant, said);

  const mac = {
    spaces: [{ id: "sp1", name: "测试", tabs: 1, terminals: 1 }],
    launchers: [
      { id: "claude", label: "Claude Code", takesTask: true },
      { id: "codex", label: "Codex", takesTask: true },
      { id: "kimi", label: "Kimi Code", takesTask: false },
      { id: "droid", label: "Droid", takesTask: false },
      { id: "codebuddy", label: "CodeBuddy", takesTask: false },
      { id: "cursor-agent", label: "Cursor Agent", takesTask: false },
      { id: "shell", label: "终端", takesTask: false },
    ],
    folders: ["~/code/pocket-demo"],
    canCreate: true,
    typesTask: true,
  };
  const { calls } = await fakeHost("Mac K", (method, params) => {
    if (method === "spaces.list") return mac;
    if (method !== "agent.create") return undefined;
    const made = { agent: "x/hc:t70", space: "sp9", terminal: "t70" };
    if (!params.task) return made;
    if (params.launcher === "droid") return { ...made, task: "failed", taskNote: "它一开就在问：「Do you trust the files in this folder?」，任务没打进去（回车会替你答了它）" };
    return { ...made, task: params.launcher === "claude" || params.launcher === "codex" ? "started" : "typed" };
  });
  await fakeHost("Linux K", (method) =>
    method === "spaces.list"
      ? { spaces: [], launchers: [{ id: "codex", label: "Codex", takesTask: true }, { id: "qwen", label: "Qwen Code", takesTask: false }, { id: "shell", label: "终端", takesTask: false }], folders: [], canCreate: true, typesTask: true }
      : undefined,
  );
  const phone = await pair("viewer", "Phone K");
  const viewer = await Sock.open("/v1/ws", phone.token);
  await viewer.next((f) => f.type === "snapshot");

  // "What can I start?" without naming a computer: every computer that is on, one block each.
  const [all] = await turn(phone, viewer, "能建哪些 agent", [["list_launchers", {}]]);
  assert.match(all!, /【Mac K】可以新建\n装了 6 个 agent 程序：claude（Claude Code，启动时带任务）、codex（Codex，启动时带任务）、kimi（Kimi Code，开好后把任务打进去）、droid（Droid，开好后把任务打进去）、codebuddy（CodeBuddy，开好后把任务打进去）、cursor-agent（Cursor Agent，开好后把任务打进去）；另外能开普通终端/);
  assert.match(all!, /【Linux K】可以新建\n装了 2 个 agent 程序：codex（Codex，启动时带任务）、qwen（Qwen Code，开好后把任务打进去）/);

  // Kimi takes no task at start: the computer types it in, and only that counts as handed over.
  const [kimi] = await turn(phone, viewer, "在 Mac K 上开个基米，让它看下 README", [["create_agent", { device: "Mac K", launcher: "基米", task: "看下 README" }]]);
  assert.deepEqual(calls.filter((c) => c.method === "agent.create").at(-1)!.params, { launcher: "kimi", task: "看下 README" });
  assert.match(kimi!, /^办了：在「Mac K」新建一个空间，开一个 Kimi Code，任务：看下 README（等它启动好后打进去）。结果：开好了，等它启动好后把任务打进去了（它还没回复）/);

  // Droid opened on a question: the agent is there, the task is not, and the answer says why.
  const [droid] = await turn(phone, viewer, "开个卓德跑测试", [["create_agent", { device: "Mac K", launcher: "卓德", task: "跑测试", space: "测试" }]]);
  assert.equal(calls.filter((c) => c.method === "agent.create").at(-1)!.params.launcher, "droid");
  assert.match(droid!, /结果：开好了，但任务没交给它：它一开就在问：「Do you trust the files in this folder\?」.+它现在空着，没在做这件事/);
  const logged = (await api(`/v1/logs?kind=action&device=Mac%20K`, { token: ADMIN })).json.entries as LogEntry[];
  assert.ok(logged.some((e) => /create done .+-> 开好了，但任务没交给它：它一开就在问/.test(e.msg)));

  // Spoken names reach programs that start empty, too; the shell never gets a task.
  const [cursor] = await turn(phone, viewer, "开个科瑟", [["create_agent", { device: "Mac K", launcher: "科瑟" }]]);
  assert.equal(calls.filter((c) => c.method === "agent.create").at(-1)!.params.launcher, "cursor-agent");
  assert.match(cursor!, /结果：开好了$|结果：开好了。/);
  const [shell] = await turn(phone, viewer, "开个终端跑 ls", [["create_agent", { device: "Mac K", launcher: "shell", task: "ls" }]]);
  assert.equal(calls.filter((c) => c.method === "agent.create").at(-1)!.params.task, undefined);
  assert.match(shell!, /普通终端不接任务，任务没交给它/);
});

test("ask-first setting: phones read and change it, computers cannot, calls ignore it", async () => {
  const phone = await pair("viewer", "Phone S");
  const viewer = await Sock.open("/v1/ws", phone.token);
  await viewer.next((f) => f.type === "snapshot");
  const { host } = await fakeHost("Mac S");
  assert.deepEqual((await api("/v1/assistant/settings", { token: phone.token })).json, { name: "爱弥斯", confirm: "never", default: "never" });
  assert.equal((await api("/v1/assistant/settings", { token: host.token })).status, 401);
  assert.equal((await api("/v1/assistant/settings", { token: phone.token, body: { confirm: "sometimes" } })).status, 400);
  assert.deepEqual((await api("/v1/assistant/settings", { token: phone.token, body: { confirm: "always" } })).json, { name: "爱弥斯", confirm: "always" });
  await viewer.next((f) => f.type === "assistant_reset");
  assert.equal((await api("/v1/assistant", { token: phone.token })).json.settings.confirm, "always");
  // Saying it works too.
  await turn(phone, viewer, "以后不用问我，直接做", [["set_ask_first", { ask: false }]]);
  assert.equal((await api("/v1/assistant", { token: phone.token })).json.settings.confirm, "never");
  const changes = (await api("/v1/logs?kind=settings", { token: ADMIN })).json.entries as LogEntry[];
  assert.deepEqual(changes.slice(-2).map((e) => e.msg), ["ask before acting: never -> always (by Phone S)", "ask before acting: always -> never (by assistant)"]);
});

test("logs: phones and computers upload, tokens never stored, filters and following work, the panel needs the admin token", async () => {
  const phone = await pair("viewer", "Phone L");
  const { host, h } = await fakeHost("Mac L");
  const secret = "hp_abcdefghijklmnopqrstuvwxyz0123456789";
  const up = await api("/v1/logs", {
    token: phone.token,
    body: {
      entries: [
        { ts: Date.now(), level: "warn", kind: "link", msg: `socket closed (token ${secret})`, data: { url: `wss://x/v1/ws?token=${secret}`, attempt: 3 } },
        { ts: Date.now(), level: "info", kind: "voice", msg: "call started" },
        { level: "nope", msg: "" },
      ],
    },
  });
  assert.deepEqual(up.json, { stored: 2 });
  h.send({ type: "log", entries: [{ ts: Date.now(), level: "error", kind: "create", msg: "agent.create failed: herdr-app not found", data: { launcher: "claude" } }] });
  await sleep(60);

  assert.equal((await api("/v1/logs")).status, 401);
  const mine = (await api(`/v1/logs?device=${phone.device.id}`, { token: phone.token })).json.entries as LogEntry[];
  assert.deepEqual(mine.map((e) => [e.source, e.kind, e.level]), [["viewer", "link", "warn"], ["viewer", "voice", "info"]]);
  assert.equal(mine[0]!.deviceName, "Phone L");
  assert.ok(!JSON.stringify(mine).includes(secret));
  assert.match(mine[0]!.msg, /hp_\*\*\*/);
  assert.equal(mine[0]!.data!.url, "wss://x/v1/ws?token=***");

  const errors = (await api("/v1/logs?level=error&device=Mac%20L", { token: ADMIN })).json.entries as LogEntry[];
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.source, "host");
  assert.equal(errors[0]!.device, host.device.id);
  assert.equal(((await api("/v1/logs?text=herdr-app", { token: ADMIN })).json.entries as LogEntry[]).length, 1);
  // Device online lines are there; following picks up only what is new.
  const all = (await api("/v1/logs?since=1h&limit=2000", { token: ADMIN })).json.entries as LogEntry[];
  assert.ok(all.some((e) => e.kind === "device" && e.msg === 'online host "Mac L"'));
  const last = all[all.length - 1]!.id;
  await api("/v1/logs", { token: phone.token, body: { entries: [{ ts: Date.now(), level: "info", kind: "update", msg: "checked for updates" }] } });
  const newer = (await api(`/v1/logs?after=${last}`, { token: ADMIN })).json.entries as LogEntry[];
  assert.deepEqual(newer.map((e) => e.msg), ["checked for updates"]);
  // Nothing in the table looks like a credential.
  assert.ok(!JSON.stringify(all).match(/hp_[A-Za-z0-9_-]{10}/));
  assert.equal(redact(`Bearer ${secret} and sk-1234567890abcdef`), "Bearer *** and sk-***");

  // The panel itself is a page; its data needs the admin token.
  const page = await api("/admin");
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.raw, /小爱小爱 控制台/);
  assert.equal((await api("/v1/admin/overview", { token: phone.token })).status, 401);
  const overview = (await api("/v1/admin/overview", { token: ADMIN })).json;
  assert.equal(overview.assistant.confirm, "never");
  assert.ok(overview.devices >= 2);
  assert.ok(overview.last24h.error >= 1);
  assert.ok(!JSON.stringify(overview).includes("moss-test-key"));
});

test("guardClaims allows conditional confirmation phrasing and deduplicates pending fallback prompt", async () => {
  const { guardClaims, newFacts } = await import("../src/assistant/guard.ts");
  const facts = newFacts();
  facts.actions.push({ kind: "send", state: "pending", agent: "a1", title: "Checking", seq: 1 });

  const conditional = "消息已经写好了，还没发。你点确认我就立刻发出去。";
  const kept = guardClaims(conditional, facts);
  assert.equal(kept.fixed.length, 0);
  assert.equal(kept.text, conditional);

  const dup = "消息已经写好了，还没发，等你点确认。已经发过去了。";
  const deduped = guardClaims(dup, facts);
  assert.deepEqual(deduped.fixed, ["delivery"]);
  assert.equal(deduped.text, "消息已经写好了，还没发，等你点确认。");
});
