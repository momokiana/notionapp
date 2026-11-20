import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import type { ServerFrame } from "@xiaoaixiaoai/protocol";
import { Relay } from "../src/server.ts";
import { chatSpeechSentences } from "../src/assistant/assistant.ts";
import type { Llm, LlmRequest, LlmResult } from "../src/assistant/llm.ts";

const ADMIN = "dual-track-test-admin-token-0123456789";

class Sock {
  ws: WebSocket;
  frames: ServerFrame[] = [];
  private waiters: Array<{ pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString()) as ServerFrame;
      const i = this.waiters.findIndex((w) => w.pred(f));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(f);
      else this.frames.push(f);
    });
  }

  static async open(base: string, token: string): Promise<Sock> {
    const ws = new WebSocket(`${base.replace("http", "ws")}/v1/ws?token=${encodeURIComponent(token)}`);
    const s = new Sock(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return s;
  }

  next<T extends ServerFrame = ServerFrame>(pred: (f: ServerFrame) => boolean, ms = 4000): Promise<T> {
    const hit = this.frames.find(pred);
    if (hit) {
      this.frames.splice(this.frames.indexOf(hit), 1);
      return Promise.resolve(hit as T);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`timeout waiting frame; saw: ${this.frames.map((x) => x.type).join(",")}`)),
        ms,
      );
      this.waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(t);
          resolve(f as T);
        },
      });
    });
  }

  close() {
    this.ws.close();
  }
}

test("chatSpeechSentences strips markdown/code/urls and splits sentences cleanly", () => {
  const sentences = chatSpeechSentences(
    "第一句看这里。详情看 https://example.com/a/b ，然后执行：\n```ts\nconst x = 1;\n```\n第二句也跑通了！",
  );
  assert.ok(sentences.length >= 2);
  const joined = sentences.join(" ");
  assert.ok(!joined.includes("```"));
  assert.ok(!joined.includes("https://"));
  assert.ok(joined.includes("代码写在消息里了"));
});

test("replyMode defaults: text when voice disabled, voice when voice enabled", async () => {
  const silentRelay = new Relay({ dbPath: ":memory:", adminToken: ADMIN, log: () => {}, assistant: { targets: [] } });
  try {
    const port = await silentRelay.listen(0, "127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${port}/v1/assistant`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    const state = (await res.json()) as Record<string, any>;
    assert.equal(state.voice, false);
    assert.equal(state.settings?.replyMode, undefined);
  } finally {
    await silentRelay.close();
  }
});

let dir: string;
let relay: Relay;
let base: string;
let llmMode: "plain" | "tool_to_text" | "tool_to_voice" = "plain";
let llmText = "已收到，两个会话都在运行。";
const voiceCalls: Array<{ method: string; params: Record<string, any> }> = [];
let synthDelayMs = 0;

const llm: Llm = async (req: LlmRequest): Promise<LlmResult> => {
  const hasToolResult = req.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
  );
  if (!hasToolResult && llmMode === "tool_to_text") {
    return {
      content: [{ type: "tool_use", id: "call-1", name: "set_reply_mode", input: { mode: "text" } }],
      stopReason: "tool_use",
      model: "test",
    };
  }
  if (!hasToolResult && llmMode === "tool_to_voice") {
    return {
      content: [{ type: "tool_use", id: "call-2", name: "set_reply_mode", input: { mode: "voice" } }],
      stopReason: "tool_use",
      model: "test",
    };
  }
  return {
    content: [{ type: "text", text: llmText }],
    stopReason: "end_turn",
    model: "test",
  };
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "pocket-dual-track-"));
  relay = new Relay({
    dbPath: join(dir, "t.db"),
    adminToken: ADMIN,
    rpcTimeoutMs: 3000,
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
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function pair(kind: "host" | "viewer", name: string) {
  const code = (await api("/v1/pair/codes", { token: ADMIN, body: { kind } })).json.code as string;
  return (await api("/v1/pair", { body: { code, name, kind } })).json as { token: string; device: { id: string } };
}

test("dual-track chat, mode switching (tool & fallback & API), push-to-talk, replay and stop", async () => {
  const host = await pair("host", "WinGPU");
  const phone = await pair("viewer", "Phone");
  const hs = await Sock.open(base, host.token);
  hs.ws.send(JSON.stringify({ type: "hello", version: 1, platform: "win32", sources: ["local-voice"] }));
  await hs.next((f) => f.type === "welcome");

  hs.ws.on("message", async (raw) => {
    const f = JSON.parse(raw.toString()) as ServerFrame;
    if (f.type !== "rpc") return;
    voiceCalls.push({ method: f.method, params: f.params as Record<string, any> });
    if (f.method === "voice.warmup") {
      hs.ws.send(JSON.stringify({ type: "rpc_result", id: f.id, result: { ready: true } }));
      return;
    }
    if (f.method === "voice.synthesize") {
      if (synthDelayMs > 0) await delay(synthDelayMs);
      const chunk = Buffer.alloc(480, 7).toString("base64");
      hs.ws.send(
        JSON.stringify({ type: "rpc_result", id: f.id, result: { sampleRate: 48000, chunksBase64: [chunk] } }),
      );
      return;
    }
    if (f.method === "voice.transcribe") {
      hs.ws.send(JSON.stringify({ type: "rpc_result", id: f.id, result: { text: "帮我看一下现在谁在忙" } }));
      return;
    }
    if (f.method === "voice.cancel") {
      hs.ws.send(JSON.stringify({ type: "rpc_result", id: f.id, result: { cancelled: true } }));
      return;
    }
    if (f.method === "voice.release") {
      hs.ws.send(JSON.stringify({ type: "rpc_result", id: f.id, result: { released: true } }));
    }
  });

  const vs = await Sock.open(base, phone.token);
  await vs.next((f) => f.type === "snapshot");

  // Default replyMode is "voice" when relay has live voice enabled.
  const initState = await api("/v1/assistant", { token: phone.token });
  assert.equal(initState.json.voice, true);
  assert.equal(initState.json.settings.replyMode, "voice");

  // 1. Normal text chat in dual-track mode streams assistant_item (spoken: true) + assistant_speech frames.
  llmMode = "plain";
  llmText = "目前两个会话都在运行。没有卡住的。";
  await api("/v1/assistant/messages", { token: phone.token, body: { text: "现在怎么样" } });
  const aItem = await vs.next<Extract<ServerFrame, { type: "assistant_item" }>>(
    (f) => f.type === "assistant_item" && f.item.role === "assistant" && !f.item.error && f.item.spoken === true,
  );
  assert.equal(aItem.item.text, llmText);

  const spStart = await vs.next<Extract<ServerFrame, { type: "assistant_speech" }>>(
    (f) => f.type === "assistant_speech" && f.itemId === aItem.item.id && f.phase === "start",
  );
  await vs.next(
    (f) =>
      f.type === "assistant_speech" &&
      f.utteranceId === spStart.utteranceId &&
      f.phase === "chunk" &&
      typeof f.pcmBase64 === "string" &&
      f.sampleRate === 48000,
  );
  await vs.next((f) => f.type === "assistant_speech" && f.utteranceId === spStart.utteranceId && f.phase === "done");

  // 2. Switching via set_reply_mode tool to "text" suppresses speech and calls voice.release.
  voiceCalls.length = 0;
  llmMode = "tool_to_text";
  llmText = "接下来只发文字气泡。";
  await api("/v1/assistant/messages", { token: phone.token, body: { text: "切到纯文字" } });
  await vs.next((f) => f.type === "assistant_reset");
  const quietItem = await vs.next<Extract<ServerFrame, { type: "assistant_item" }>>(
    (f) => f.type === "assistant_item" && f.item.role === "assistant" && f.item.text === llmText,
  );
  assert.equal(quietItem.item.spoken, undefined);
  assert.equal((await api("/v1/assistant", { token: phone.token })).json.settings.replyMode, "text");
  assert.ok(voiceCalls.some((c) => c.method === "voice.release"));
  assert.equal(voiceCalls.some((c) => c.method === "voice.synthesize"), false);

  // 3. Per-bubble manual replay works even while replyMode is "text", and stop cancels mid-stream.
  synthDelayMs = 150;
  llmText = "第一句先停在这里。第二句等会被停掉。";
  const manual = await api("/v1/assistant/speak", {
    token: phone.token,
    body: { itemId: quietItem.item.id, text: llmText },
  });
  assert.equal(manual.status, 200);
  const manualStart = await vs.next<Extract<ServerFrame, { type: "assistant_speech" }>>(
    (f) => f.type === "assistant_speech" && f.utteranceId === manual.json.utteranceId && f.phase === "start",
  );
  await api("/v1/assistant/speak/stop", { token: phone.token, body: {} });
  await vs.next(
    (f) => f.type === "assistant_speech" && f.utteranceId === manualStart.utteranceId && f.phase === "stop",
  );
  await delay(20);
  assert.ok(voiceCalls.some((c) => c.method === "voice.cancel"));
  synthDelayMs = 0;

  // 4. Switching back via set_reply_mode tool to "voice" speaks that turn right away.
  voiceCalls.length = 0;
  llmMode = "tool_to_voice";
  llmText = "好，现在切回语音加文字双轨了。";
  await api("/v1/assistant/messages", { token: phone.token, body: { text: "切回语音" } });
  await vs.next((f) => f.type === "assistant_reset");
  const backVoiceItem = await vs.next<Extract<ServerFrame, { type: "assistant_item" }>>(
    (f) => f.type === "assistant_item" && f.item.role === "assistant" && f.item.text === llmText && f.item.spoken === true,
  );
  await vs.next(
    (f) => f.type === "assistant_speech" && f.itemId === backVoiceItem.item.id && f.phase === "done",
  );

  // 5. Deterministic fallback regex switches mode even if LLM didn't invoke set_reply_mode.
  llmMode = "plain";
  voiceCalls.length = 0;
  llmText = "之后只打字回你。";
  await api("/v1/assistant/messages", { token: phone.token, body: { text: "接下来用文字" } });
  await vs.next((f) => f.type === "assistant_reset");
  const fbTextItem = await vs.next<Extract<ServerFrame, { type: "assistant_item" }>>(
    (f) => f.type === "assistant_item" && f.item.role === "assistant" && f.item.text === llmText,
  );
  assert.equal(fbTextItem.item.spoken, undefined);
  assert.equal((await api("/v1/assistant", { token: phone.token })).json.settings.replyMode, "text");

  // Deterministic fallback regex back to voice:
  voiceCalls.length = 0;
  llmText = "好呀，接下来用语音回你。";
  await api("/v1/assistant/messages", { token: phone.token, body: { text: "接下来用语音" } });
  await vs.next((f) => f.type === "assistant_reset");
  const fbVoiceItem = await vs.next<Extract<ServerFrame, { type: "assistant_item" }>>(
    (f) => f.type === "assistant_item" && f.item.role === "assistant" && f.item.text === llmText && f.item.spoken === true,
  );
  await vs.next((f) => f.type === "assistant_speech" && f.itemId === fbVoiceItem.item.id && f.phase === "done");

  // 6. Push-to-talk POST /v1/assistant/voice transcribes, creates user item via="voice", and replies in dual-track.
  llmText = "现在没有会话在忙呢。";
  const pttRes = await api("/v1/assistant/voice", {
    token: phone.token,
    body: { audioBase64: Buffer.alloc(1600, 1).toString("base64"), sampleRate: 16000 },
  });
  assert.equal(pttRes.status, 200);
  assert.equal(pttRes.json.text, "帮我看一下现在谁在忙");
  assert.equal(pttRes.json.item.via, "voice");
  const pttReply = await vs.next<Extract<ServerFrame, { type: "assistant_item" }>>(
    (f) => f.type === "assistant_item" && f.item.role === "assistant" && f.item.text === llmText && f.item.spoken === true,
  );
  await vs.next((f) => f.type === "assistant_speech" && f.itemId === pttReply.item.id && f.phase === "done");

  hs.close();
  vs.close();
});
