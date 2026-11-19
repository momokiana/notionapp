import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { Notice } from "@xiaoaixiaoai/protocol";
import { Relay } from "../src/server.ts";
import { Resampler } from "../src/assistant/realtime.ts";
import type { Llm, LlmRequest, LlmResult } from "../src/assistant/llm.ts";

const ADMIN = "admin-token-for-tests-0123456789";
let relay: Relay;
let base: string;
let dir: string;
/** Plays an OpenAI Realtime service. */
let rt: WebSocketServer;
const asked: LlmRequest[] = [];
let script: (req: LlmRequest) => LlmResult = () => text("好");
const llm: Llm = async (req) => {
  asked.push(req);
  return script(req);
};
const text = (t: string): LlmResult => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", model: "test" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "pocket-realtime-"));
  rt = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => rt.once("listening", () => r()));
  const port = (rt.address() as { port: number }).port;
  relay = new Relay({
    dbPath: join(dir, "t.db"),
    adminToken: ADMIN,
    log: process.env.POCKET_TEST_LOG ? (m: string) => console.error(m) : () => {},
    llm,
    live: {
      provider: "openai-realtime",
      url: `ws://127.0.0.1:${port}/v1/realtime`,
      apiKey: "rt-test-key",
      model: "gpt-realtime",
      voice: "marin",
      transcribeModel: "gpt-4o-mini-transcribe",
      language: "zh",
      refreshGapMs: 0,
    },
  });
  base = `http://127.0.0.1:${await relay.listen(0, "127.0.0.1")}`;
});

after(async () => {
  await relay.close();
  await new Promise<void>((r) => rt.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function api(path: string, init: { token?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: init.body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return (await res.json()) as any;
}

async function pair(kind: "host" | "viewer", name: string) {
  const code = (await api("/v1/pair/codes", { token: ADMIN, body: { kind } })).code;
  return (await api("/v1/pair", { body: { code, name, kind } })) as { token: string };
}

/** Collects JSON frames (and binary ones); `next` waits for a match and takes it out. */
class Sock {
  frames: any[] = [];
  binary: Buffer[] = [];
  private waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void }> = [];
  ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (d, isBinary) => {
      if (isBinary) {
        this.binary.push(d as Buffer);
        return;
      }
      const f = JSON.parse(d.toString());
      const w = this.waiters.find((x) => x.pred(f));
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(f);
      } else this.frames.push(f);
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
    // Made here so a timeout points at the step that waited.
    const err = new Error(`timeout waiting for ${pred.toString().slice(0, 120)}`);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(err), ms);
      this.waiters.push({ pred, resolve: (f) => (clearTimeout(t), resolve(f)) });
    });
  }
  send(f: unknown) {
    this.ws.send(JSON.stringify(f));
  }
}

const pcm = (samples: number, value: number) => {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(value, i * 2);
  return b;
};
const samplesOf = (b: Buffer) => Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));

test("resampler: rates in, rates out, a continuous stream across chunks", () => {
  const up = new Resampler(16_000, 24_000);
  const first = up.push(pcm(320, 1000));
  const second = up.push(pcm(320, 1000));
  // 20 ms in, 20 ms out (one sample waits for the next chunk to be interpolated).
  assert.equal(first.length / 2, 479);
  assert.equal(second.length / 2, 480);
  assert.ok(samplesOf(Buffer.concat([first, second])).every((s) => s === 1000));
  // A ramp stays a ramp: 0, 100, 200 at 24 kHz becomes 0, 50, 100, 150 ... at 48 kHz.
  const ramp = Buffer.alloc(6);
  [0, 100, 200].forEach((v, i) => ramp.writeInt16LE(v, i * 2));
  assert.deepEqual(samplesOf(new Resampler(24_000, 48_000).push(ramp)), [0, 50, 100, 150]);
  // An odd byte waits for its other half.
  const odd = new Resampler(24_000, 24_000);
  assert.equal(odd.push(Buffer.from([1, 0, 2])).length, 2);
  assert.deepEqual([...odd.push(Buffer.from([0]))], [2, 0]);
});

test("an OpenAI Realtime voice call: same phone events as MOSS-Live, tasks through the tool, cut-offs truncated, notices spoken", async () => {
  const phone = await pair("viewer", "Pixel 9");
  const viewer = await Sock.open("/v1/ws", phone.token);
  await viewer.next((f) => f.type === "snapshot");
  const health = await api("/v1/health");
  assert.equal(health.voice, "openai-realtime");
  assert.ok(!JSON.stringify(health).includes("rt-test-key"));

  // Connect and set up.
  const upstream = new Promise<{ sock: Sock; auth?: string; url: string }>((resolve) =>
    rt.once("connection", (ws, req) => resolve({ sock: new Sock(ws), auth: req.headers.authorization, url: req.url ?? "" })),
  );
  const call = await Sock.open("/v1/assistant/live", phone.token);
  const up = await upstream;
  assert.equal(up.auth, "Bearer rt-test-key");
  assert.match(up.url, /^\/v1\/realtime\?model=gpt-realtime$/);
  const setup = await up.sock.next((f) => f.type === "session.update");
  const s = setup.session;
  assert.equal(s.type, "realtime");
  assert.deepEqual(s.output_modalities, ["audio"]);
  assert.deepEqual(s.audio.input.format, { type: "audio/pcm", rate: 24000 });
  assert.deepEqual(s.audio.input.transcription, { model: "gpt-4o-mini-transcribe", language: "zh" });
  assert.deepEqual(s.audio.input.turn_detection, { type: "server_vad", create_response: true, interrupt_response: true });
  assert.deepEqual(s.audio.output, { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" });
  assert.deepEqual(
    s.tools.map((t: any) => [t.type, t.name, t.parameters.required]),
    [["function", "ask_backend", ["objective"]]],
  );
  assert.match(s.instructions, /^你叫/);
  assert.match(s.instructions, /【后台怎么交】[\s\S]*ask_backend[\s\S]*【你怎么干活】/);
  assert.doesNotMatch(s.instructions, /主人[^、]/);
  // Nothing from the phone goes up before the session is set.
  call.ws.send(pcm(320, 7));
  await sleep(30);
  assert.ok(!up.sock.frames.some((f) => f.type === "input_audio_buffer.append"));
  up.sock.send({ type: "session.created", session: {} });
  up.sock.send({ type: "session.updated", session: {} });
  await call.next((f) => f.action === "relay.state" && f.data.state === "ready");

  // Microphone: 16 kHz from the phone, 24 kHz base64 upstream.
  call.ws.send(pcm(320, 1000));
  call.ws.send(pcm(320, 1000));
  const a1 = Buffer.from((await up.sock.next((f) => f.type === "input_audio_buffer.append")).audio, "base64");
  const a2 = Buffer.from((await up.sock.next((f) => f.type === "input_audio_buffer.append")).audio, "base64");
  assert.equal(a1.length + a2.length, (479 + 480) * 2);
  assert.ok(samplesOf(a1).every((x) => x === 1000));
  // Phone-only controls stay on the relay.
  call.send({ action: "mic_state", enabled: true });
  call.send({ action: "ping", timestamp: 1 });

  // The person speaks: captions grow, the finished sentence joins the thread.
  up.sock.send({ type: "input_audio_buffer.speech_started", item_id: "u1", audio_start_ms: 0 });
  await call.next((f) => f.action === "input.speech.started");
  up.sock.send({ type: "conversation.item.input_audio_transcription.delta", item_id: "u1", delta: "上线" });
  assert.equal((await call.next((f) => f.action === "input.transcript.updated")).data.text, "上线");
  up.sock.send({ type: "conversation.item.input_audio_transcription.delta", item_id: "u1", delta: "检查怎么样了" });
  assert.equal((await call.next((f) => f.action === "input.transcript.updated")).data.text, "上线检查怎么样了");
  up.sock.send({ type: "input_audio_buffer.speech_stopped", item_id: "u1", audio_end_ms: 900 });
  await call.next((f) => f.action === "input.speech.stopped");
  up.sock.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", content_index: 0, transcript: "上线检查怎么样了" });
  assert.deepEqual((await call.next((f) => f.action === "input.transcript.done")).data, { text: "上线检查怎么样了", turn: 1 });
  await viewer.next((f) => f.type === "assistant_item" && f.item.via === "voice" && f.item.role === "user" && f.item.text === "上线检查怎么样了");

  // The answer: "我看看" out loud, and a task for the backend.
  script = () => text("好的，上线检查在等你确认。\n---\n上线检查：等了 2 分钟，想执行一条删除命令");
  up.sock.send({ type: "response.created", response: { id: "resp1", status: "in_progress" } });
  up.sock.send({ type: "response.output_audio.delta", response_id: "resp1", item_id: "a1", output_index: 0, content_index: 0, delta: pcm(240, 500).toString("base64") });
  assert.deepEqual((await call.next((f) => f.action === "response.audio.started")).data, { run_id: "a1", turn_id: "1" });
  assert.deepEqual((await call.next((f) => f.action === "response.audio.context")).data, { chunk_id: "a1-0", run_id: "a1", turn_id: "1" });
  await sleep(30);
  // 10 ms at 24 kHz becomes 10 ms at 48 kHz (less the sample kept for the next chunk).
  assert.equal(call.binary.length, 1);
  assert.equal(call.binary[0]!.length / 2, 478);
  assert.ok(samplesOf(call.binary[0]!).every((x) => x === 500));
  up.sock.send({ type: "response.output_audio_transcript.delta", response_id: "resp1", item_id: "a1", delta: "我看看" });
  assert.deepEqual((await call.next((f) => f.action === "output.transcript.updated")).data, { text: "我看看", run_id: "a1", turn_id: "1" });
  up.sock.send({
    type: "response.function_call_arguments.done",
    response_id: "resp1",
    item_id: "fc1",
    output_index: 1,
    call_id: "call_1",
    name: "ask_backend",
    arguments: JSON.stringify({ objective: "看看上线检查的状态" }),
  });
  assert.deepEqual((await call.next((f) => f.action === "relay.task" && f.data.status === "running")).data, { id: "call_1", title: "看看上线检查的状态", status: "running" });
  const output = await up.sock.next((f) => f.type === "conversation.item.create" && f.item.type === "function_call_output");
  assert.equal(output.item.call_id, "call_1");
  assert.equal(output.item.output, "台词：上线检查在等你确认。\n备查（不出声，我追问时再用）：上线检查：等了 2 分钟，想执行一条删除命令");
  await call.next((f) => f.action === "relay.task" && f.data.status === "done");
  // The same call reported twice (arguments.done and output_item.done) is one task.
  up.sock.send({ type: "response.output_item.done", response_id: "resp1", item: { type: "function_call", call_id: "call_1", name: "ask_backend", arguments: "{}" } });
  // The task went to the text assistant as a call task, with what was just said.
  const ask = asked[asked.length - 1]!;
  assert.match(String(ask.system), /# 现在：通话中/);
  const said = ask.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
  assert.match(said, /看看上线检查的状态[\s\S]*我：上线检查怎么样了/);
  // resp1 is still open: the answer to the task waits for it.
  up.sock.send({ type: "response.output_audio.done", response_id: "resp1", item_id: "a1" });
  assert.deepEqual((await call.next((f) => f.action === "response.audio.done")).data, { run_id: "a1", turn_id: "1" });
  up.sock.send({ type: "response.output_audio_transcript.done", response_id: "resp1", item_id: "a1", transcript: "我看看。" });
  assert.equal((await call.next((f) => f.action === "output.transcript.done")).data.text, "我看看。");
  await viewer.next((f) => f.type === "assistant_item" && f.item.via === "voice" && f.item.text === "我看看。");
  await sleep(40);
  assert.ok(!up.sock.frames.some((f) => f.type === "response.create"));
  up.sock.send({ type: "response.done", response: { id: "resp1", status: "completed" } });
  assert.equal((await call.next((f) => f.action === "response.ended")).data.run_id, "a1");
  await up.sock.next((f) => f.type === "response.create");
  call.send({ action: "playback.completed", run_id: "a1", turn_id: "1" });

  // The result is spoken; the person cuts in halfway.
  up.sock.send({ type: "response.created", response: { id: "resp2", status: "in_progress" } });
  up.sock.send({ type: "response.output_audio.delta", response_id: "resp2", item_id: "a2", delta: pcm(24_000, 300).toString("base64") });
  up.sock.send({ type: "response.output_audio_transcript.delta", response_id: "resp2", item_id: "a2", delta: "它在等你确认，是一条删除命令。" });
  await call.next((f) => f.action === "response.audio.started" && f.data.run_id === "a2");
  await call.next((f) => f.action === "output.transcript.updated" && f.data.run_id === "a2");
  up.sock.send({ type: "input_audio_buffer.speech_started", item_id: "u2", audio_start_ms: 3000 });
  assert.deepEqual((await call.next((f) => f.action === "response.audio.stop")).data, { run_id: "a2", turn_id: "1", reason: "interrupted" });
  // What the phone does on response.audio.stop: stop and say how much was heard.
  call.send({ action: "playback.stopped", run_id: "a2", turn_id: "1", played_audio_ms: 500, reason: "interrupted" });
  assert.deepEqual(await up.sock.next((f) => f.type === "conversation.item.truncate"), { type: "conversation.item.truncate", item_id: "a2", content_index: 0, audio_end_ms: 500 });
  assert.deepEqual((await call.next((f) => f.action === "response.interrupted")).data, { run_id: "a2", turn_id: "1", text: "它在等你确认，是" });
  await viewer.next((f) => f.type === "assistant_item" && f.item.via === "voice" && f.item.text === "它在等你确认，是…");
  // Its full text arrives later and must not replace what was heard; audio after the cut is dropped.
  const before = call.binary.length;
  up.sock.send({ type: "response.output_audio.delta", response_id: "resp2", item_id: "a2", delta: pcm(240, 300).toString("base64") });
  up.sock.send({ type: "response.output_audio_transcript.done", response_id: "resp2", item_id: "a2", transcript: "它在等你确认，是一条删除命令。" });
  up.sock.send({ type: "response.done", response: { id: "resp2", status: "cancelled" } });
  assert.equal((await call.next((f) => f.action === "response.ended")).data.status, "cancelled");
  await sleep(40);
  assert.equal(call.binary.length, before);
  assert.ok(!call.frames.some((f) => f.action === "output.transcript.done" || (f.action === "response.audio.done" && f.data.run_id === "a2")));
  assert.ok(!viewer.frames.some((f) => f.type === "assistant_item" && f.item.text === "它在等你确认，是一条删除命令。"));

  // A notice while nobody speaks is said right away, as a system message and a new answer.
  up.sock.send({ type: "input_audio_buffer.speech_stopped", item_id: "u2", audio_end_ms: 3600 });
  await call.next((f) => f.action === "input.speech.stopped");
  up.sock.frames = [];
  const notice: Omit<Notice, "id" | "ts"> = { kind: "done", title: "跑完了", body: "迁移脚本跑完了，测试全过。", details: "迁移：12 个文件" };
  await (relay.assistant as unknown as { emit(n: Omit<Notice, "id" | "ts">): Promise<void> }).emit(notice);
  assert.equal((await call.next((f) => f.action === "relay.notice")).data.line, "对了，迁移脚本跑完了，测试全过。");
  const sys = await up.sock.next((f) => f.type === "conversation.item.create" && f.item.type === "message", 4000);
  assert.equal(sys.item.role, "system");
  assert.equal(sys.item.content[0].type, "input_text");
  assert.equal(sys.item.content[0].text, "【要告诉我的事】\n对了，迁移脚本跑完了，测试全过。\n备查（不出声，我追问时再用）：迁移：12 个文件");
  await up.sock.next((f) => f.type === "response.create");
  up.sock.send({ type: "response.created", response: { id: "resp3", status: "in_progress" } });
  up.sock.send({ type: "response.done", response: { id: "resp3", status: "completed" } });
  await call.next((f) => f.action === "response.ended" && f.data.run_id === "resp3");

  // One that comes while the person talks waits for them, and still goes out when no answer follows.
  up.sock.send({ type: "input_audio_buffer.speech_started", item_id: "u3" });
  await call.next((f) => f.action === "input.speech.started" && f.data.turn === 3);
  await (relay.assistant as unknown as { emit(n: Omit<Notice, "id" | "ts">): Promise<void> }).emit({ kind: "blocked", title: "等你", body: "上线检查在等你。" });
  assert.equal((await call.next((f) => f.action === "relay.notice")).data.how, "next");
  await sleep(100);
  assert.ok(!up.sock.frames.some((f) => f.type === "conversation.item.create" && f.item.type === "message"));
  up.sock.send({ type: "input_audio_buffer.speech_stopped", item_id: "u3" });
  const later = await up.sock.next((f) => f.type === "conversation.item.create" && f.item.type === "message", 4000);
  assert.equal(later.item.content[0].text, "【要告诉我的事】\n对了，上线检查在等你。");

  // Upstream errors the person can act on reach the phone; requests the relay got wrong do not.
  up.sock.send({ type: "error", error: { type: "invalid_request_error", code: "item_truncate_invalid_audio_end_ms", message: "x" } });
  up.sock.send({ type: "error", error: { type: "server_error", code: "server_error", message: "boom" } });
  assert.deepEqual((await call.next((f) => f.action === "error")).data, { error: { code: "server_error" } });

  call.send({ action: "relay.hangup" });
  await call.next((f) => f.action === "relay.state" && f.data.state === "closed");
});

test("a setup the service refuses ends the call with a reason", async () => {
  const phone = await pair("viewer", "Pixel 8");
  const upstream = new Promise<Sock>((resolve) => rt.once("connection", (ws) => resolve(new Sock(ws))));
  const call = await Sock.open("/v1/assistant/live", phone.token);
  const up = await upstream;
  await up.next((f) => f.type === "session.update");
  up.send({ type: "error", error: { type: "invalid_request_error", code: "invalid_value", message: "bad voice" } });
  const err = await call.next((f) => f.action === "relay.state" && f.data.state === "error");
  assert.equal(err.data.message, "语音会话配置失败（invalid_value）");
});
