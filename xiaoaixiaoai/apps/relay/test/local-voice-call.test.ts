import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import type { ServerFrame } from "@xiaoaixiaoai/protocol";
import { Relay } from "../src/server.ts";
import type { Llm, LlmRequest, LlmResult } from "../src/assistant/llm.ts";

const ADMIN = "local-voice-test-admin-token-0123456789";
let relay: Relay;
let base: string;
let dir: string;
let nextReply = "一切正常，三个项目都在空闲状态。继续吗？";

const llm: Llm = async (_req: LlmRequest): Promise<LlmResult> => ({
  content: [{ type: "text", text: `${nextReply}\n---\n状态正常` }],
  stopReason: "end_turn",
  model: "test",
});

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "pocket-local-voice-"));
  relay = new Relay({
    dbPath: join(dir, "t.db"),
    adminToken: ADMIN,
    rpcTimeoutMs: 2500,
    log: () => {},
    llm,
    assistant: { targets: [] },
    assistantConfirm: "never",
    live: { provider: "local", model: "aemeath-v2proplus", speed: 1.0 },
  });
  const port = await relay.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function pair(kind: "host" | "viewer", name: string) {
  const code = (await api("/v1/pair/codes", { token: ADMIN, body: { kind } })).json.code as string;
  return (await api("/v1/pair", { body: { code, name, kind } })).json as { token: string; device: { id: string } };
}

class LiveSock {
  ws: WebSocket;
  frames: Array<{ action?: string; data?: any }> = [];
  binary: Buffer[] = [];
  private waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void }> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (d, isBin) => {
      if (isBin) {
        this.binary.push(Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer));
        return;
      }
      const f = JSON.parse(d.toString());
      const i = this.waiters.findIndex((w) => w.pred(f));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(f);
      else this.frames.push(f);
    });
  }

  static async open(path: string, token: string) {
    const ws = new WebSocket(`${base.replace("http", "ws")}${path}?token=${encodeURIComponent(token)}`);
    const s = new LiveSock(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return s;
  }

  next(pred: (f: any) => boolean, ms = 4000): Promise<any> {
    const hit = this.frames.find(pred);
    if (hit) {
      this.frames.splice(this.frames.indexOf(hit), 1);
      return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting frame; saw: ${this.frames.map((x) => x.action).join(",")}`)), ms);
      this.waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(t);
          resolve(f);
        },
      });
    });
  }
}

function makeLoudPcm16k(frames = 8): Buffer {
  // 8 * 1280 bytes = 320 ms at 16 kHz mono PCM16LE
  const buf = Buffer.alloc(frames * 1280);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const sample = Math.round(9000 * Math.sin((i / 2) * 0.25));
    buf.writeInt16LE(sample, i);
  }
  return buf;
}

function makeSilencePcm16k(frames = 22): Buffer {
  return Buffer.alloc(frames * 1280, 0);
}

test("LocalVoiceCall fails cleanly when no local-voice host is online", async () => {
  const viewer = await pair("viewer", "phone-no-host");
  const live = await LiveSock.open("/v1/assistant/live", viewer.token);
  const errState = await live.next((f) => f.action === "relay.state" && f.data?.state === "error");
  assert.match(errState.data.message, /未在线|未开启/);
  await new Promise<void>((r) => (live.ws.readyState === WebSocket.CLOSED ? r() : live.ws.once("close", () => r())));
});

test("LocalVoiceCall bridges warmup, VAD, transcribe, LLM turn, 48kHz audio chunks, barge-in cancel, and voice.release", async () => {
  const hostInfo = await pair("host", "win-gpu");
  const hostWs = new WebSocket(`${base.replace("http", "ws")}/v1/ws?token=${encodeURIComponent(hostInfo.token)}`);
  await new Promise<void>((r) => hostWs.once("open", () => r()));

  const calls: Array<{ method: string; params: Record<string, any>; from: string }> = [];
  let slowSynth = false;

  hostWs.on("message", async (raw) => {
    const f = JSON.parse(raw.toString()) as ServerFrame;
    if (f.type === "welcome") {
      hostWs.send(JSON.stringify({ type: "hello", platform: "win32", sources: ["local-voice"], version: "0.3.0" }));
      return;
    }
    if (f.type !== "rpc") return;
    calls.push({ method: f.method, params: (f.params ?? {}) as Record<string, any>, from: f.from });

    if (f.method === "voice.warmup") {
      hostWs.send(JSON.stringify({ type: "rpc_result", id: f.id, result: { ready: true } }));
      return;
    }
    if (f.method === "voice.transcribe") {
      hostWs.send(JSON.stringify({ type: "rpc_result", id: f.id, result: { text: "现在几个项目在忙" } }));
      return;
    }
    if (f.method === "voice.synthesize") {
      if (slowSynth) await delay(220);
      const chunk = Buffer.alloc(15360, 0x22).toString("base64");
      hostWs.send(JSON.stringify({ type: "rpc_result", id: f.id, result: { sampleRate: 48000, chunksBase64: [chunk] } }));
      return;
    }
    if (f.method === "voice.cancel") {
      hostWs.send(JSON.stringify({ type: "rpc_result", id: f.id, result: { cancelled: true } }));
      return;
    }
    if (f.method === "voice.release") {
      hostWs.send(JSON.stringify({ type: "rpc_result", id: f.id, result: { released: true } }));
    }
  });

  // Give relay a moment to register host hello sources.
  await delay(60);

  const infoRes = await api("/v1/health");
  assert.equal(infoRes.status, 200);
  const viewer = await pair("viewer", "phone-1");
  const live = await LiveSock.open("/v1/assistant/live", viewer.token);

  const cfg = await live.next((f) => f.action === "media.output.configured");
  assert.deepEqual(cfg.data, { sample_rate: 48000, channels: 1 });
  const ready = await live.next((f) => f.action === "relay.state" && f.data?.state === "ready");
  assert.equal(ready.data.state, "ready");
  assert.ok(calls.some((c) => c.method === "voice.warmup" && c.from === "relay"));

  // Turn 1: send loud speech + trailing silence -> verify full roundtrip.
  live.ws.send(makeLoudPcm16k(8), { binary: true });
  live.ws.send(makeSilencePcm16k(22), { binary: true });

  await live.next((f) => f.action === "input.speech.started");
  await live.next((f) => f.action === "input.speech.stopped");
  const inDone = await live.next((f) => f.action === "input.transcript.done");
  assert.equal(inDone.data.text, "现在几个项目在忙");
  const started1 = await live.next((f) => f.action === "response.audio.started");
  const ctx1 = await live.next((f) => f.action === "response.audio.context");
  const outDone = await live.next((f) => f.action === "output.transcript.done");
  assert.equal(outDone.data.text, "一切正常，三个项目都在空闲状态。继续吗？");
  await live.next((f) => f.action === "response.audio.done");
  await live.next((f) => f.action === "response.ended" && f.data?.status === "completed");
  assert.ok(live.binary.some((b) => b.length === 15360));
  // Phone acknowledges playback completion -> assistant records full spoken text.
  live.ws.send(JSON.stringify({ action: "playback.chunk.completed", chunk_id: ctx1.data.chunk_id, run_id: started1.data.run_id, turn_id: started1.data.turn_id }));
  live.ws.send(JSON.stringify({ action: "playback.completed", run_id: started1.data.run_id, turn_id: started1.data.turn_id }));
  await delay(40);
  const thread1 = await api("/v1/assistant", { token: viewer.token });
  assert.ok(
    thread1.json.items.some((it: any) => it.role === "assistant" && it.text === "一切正常，三个项目都在空闲状态。继续吗？"),
    "full reply should be recorded after playback.completed",
  );

  // Turn 2: barge-in AFTER response.audio.done while phone has NOT sent playback.completed yet.
  nextReply = "第一句先告诉你，第二句还没来得及说出口就已经被打断了。";
  live.ws.send(makeLoudPcm16k(8), { binary: true });
  live.ws.send(makeSilencePcm16k(22), { binary: true });
  await live.next((f) => f.action === "input.transcript.done");
  const started2 = await live.next((f) => f.action === "response.audio.started");
  await live.next((f) => f.action === "response.audio.done");
  await live.next((f) => f.action === "response.ended" && f.data?.status === "completed");
  // Phone still playing chunk 0 (no playback.completed sent yet): user interrupts!
  live.ws.send(makeLoudPcm16k(6), { binary: true });
  const stopAfterDone = await live.next((f) => f.action === "response.audio.stop" && f.data?.run_id === started2.data.run_id);
  assert.equal(stopAfterDone.data.reason, "interrupted");
  const interrupted2 = await live.next((f) => f.action === "response.interrupted" && f.data?.run_id === started2.data.run_id);
  assert.ok(typeof interrupted2.data.text === "string" && interrupted2.data.text.length > 0 && interrupted2.data.text.length < nextReply.length);
  // Finish that interrupting utterance with silence, then check thread only kept the interrupted prefix.
  live.ws.send(makeSilencePcm16k(22), { binary: true });
  const started3 = await live.next((f) => f.action === "response.audio.started");
  await live.next((f) => f.action === "response.audio.done");
  live.ws.send(JSON.stringify({ action: "playback.completed", run_id: started3.data.run_id, turn_id: started3.data.turn_id }));
  await delay(40);
  const thread2 = await api("/v1/assistant", { token: viewer.token });
  assert.ok(
    thread2.json.items.some((it: any) => it.role === "assistant" && typeof it.text === "string" && it.text.endsWith("…") && it.text.length < nextReply.length),
    "interrupted reply should record only spoken prefix with ellipsis",
  );

  // Turn 3: barge-in while TTS synthesize is slow.
  slowSynth = true;
  nextReply = "好的，我正在帮你查看所有项目的最新状态，请稍等一下。";
  live.ws.send(makeLoudPcm16k(8), { binary: true });
  live.ws.send(makeSilencePcm16k(22), { binary: true });
  await live.next((f) => f.action === "input.transcript.done");
  await delay(60);
  // Interrupt mid-synthesis with new loud speech.
  live.ws.send(makeLoudPcm16k(6), { binary: true });
  await live.next((f) => f.action === "response.audio.stop" && f.data?.reason === "interrupted");
  await delay(40);
  assert.ok(calls.some((c) => c.method === "voice.cancel" && c.from === "relay"));

  // Hang up -> verify voice.release sent to host.
  live.ws.close(1000, "bye");
  for (let i = 0; i < 30; i++) {
    if (calls.some((c) => c.method === "voice.release")) break;
    await delay(25);
  }
  assert.ok(calls.some((c) => c.method === "voice.release" && c.from === "relay"));
  hostWs.close();
});
