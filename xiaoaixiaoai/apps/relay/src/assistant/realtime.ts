/**
 * A voice call through a service that speaks the OpenAI Realtime protocol
 * (OpenAI, Azure OpenAI; the "beta" dialect for services still on the older
 * event names). The phone is not told: it keeps the MOSS-Live-shaped events and
 * audio formats it already handles, and this file translates both ways.
 *
 * Phone side: 16 kHz mono PCM16 microphone in; 48 kHz mono PCM16 speech out,
 * each binary frame after a `response.audio.context`; playback receipts back.
 * Upstream: base64 PCM16 at the service's rate (24 kHz for OpenAI) in JSON events.
 * Tasks the voice hands over arrive as calls of one function tool and are done
 * by the text assistant, like MOSS-Live delegations.
 *
 * Protocol: https://platform.openai.com/docs/guides/realtime (GA interface).
 */
import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import type { LiveRelayEvent, Notice } from "@xiaoaixiaoai/protocol";
import type { Assistant } from "./assistant.ts";
import { claimCall, releaseCall } from "./calls.ts";
import { personaPrompt, voiceInstructions } from "./prompts.ts";
import { clip } from "./speech.ts";

export interface RealtimeConfig {
  provider: "openai-realtime";
  /** e.g. wss://api.openai.com/v1/realtime; `model` is added as a query parameter unless the URL has one. */
  url: string;
  apiKey: string;
  model: string;
  /** `api-key` header (Azure) instead of `Authorization: Bearer`. */
  auth?: "bearer" | "api-key";
  voice?: string;
  /** Speaking rate (GA only), 0.25–1.5. */
  speed?: number;
  /** `ga`: the current OpenAI interface. `beta`: flat session fields and `response.audio.*` events. */
  dialect?: "ga" | "beta";
  /** Speech-to-text model for the person's captions; none means no captions of what they said. */
  transcribeModel?: string;
  language?: string;
  vad?: "server_vad" | "semantic_vad";
  /** Sample rates the service takes and gives (24 kHz for OpenAI). */
  inputRate?: number;
  outputRate?: number;
  /** Least time between two refreshes of the voice's instructions. */
  refreshGapMs?: number;
}

const PHONE_MIC_RATE = 16_000;
const PHONE_SPEAKER_RATE = 48_000;
const ATTACH_TIMEOUT_MS = 15_000;
const REFRESH_GAP_MS = 5000;
const MAX_INSTRUCTIONS = 16_000;
/** After the person stops, the service starts its own answer: a notice waits this long so the two do not collide. */
const AFTER_SPEECH_MS = 1500;
/** Speech counts as heard this long after its audio's length at the latest, receipt or not. */
const PLAYBACK_SLACK_MS = 1500;
/** An answer whose end was never announced must not hold everything back for good. */
const ACTIVE_MAX_MS = 60_000;
const CREATE_MAX_MS = 10_000;
const TOOL = "ask_backend";

const ASK_TOOL = {
  type: "function",
  name: TOOL,
  description: "交给后台：查 agent 的具体情况（在干什么、说了什么、为什么卡住），或替我动手（给 agent 发消息、按键、开新 agent、建空间、改名、定提醒、取消提醒）。",
  parameters: {
    type: "object",
    properties: { objective: { type: "string", description: "我的原话，带上正在说的是哪个 agent" } },
    required: ["objective"],
  },
};

/** How the rules' "hand it to the backend" works on this protocol. */
const BRIDGE = `【后台怎么交】
下面说的“交给后台”，就是调用 ${TOOL} 工具：objective 写我的原话，带上正在说的是哪个 agent。调用前可以短短应一声。
工具返回里“台词”那句，就是回来的那句话；“备查”不出声，我追问时才用。
系统消息里的【要告诉我的事】，现在就主动说，一句话，说过就不再提。`;

const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const asBuffer = (d: RawData): Buffer => (Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d));

/** Linear resampler for mono PCM16 little-endian that keeps its place between chunks. */
export class Resampler {
  private step: number;
  private same: boolean;
  private pos = 0;
  private prev: number | null = null;
  private odd: Buffer | null = null;

  constructor(from: number, to: number) {
    this.step = from / to;
    this.same = from === to;
  }

  push(chunk: Buffer): Buffer {
    let buf = this.odd ? Buffer.concat([this.odd, chunk]) : chunk;
    this.odd = null;
    if (buf.length % 2) {
      this.odd = Buffer.from(buf.subarray(buf.length - 1));
      buf = buf.subarray(0, buf.length - 1);
    }
    if (this.same || !buf.length) return buf;
    const off = this.prev === null ? 0 : 1;
    const len = (buf.length >> 1) + off;
    const at = (k: number) => (k < off ? this.prev! : buf.readInt16LE((k - off) * 2));
    const max = Math.max(0, Math.ceil((len - 1 - this.pos) / this.step));
    const out = Buffer.alloc(max * 2);
    let t = this.pos;
    let w = 0;
    while (t < len - 1 && w < max) {
      const i = Math.floor(t);
      const a = at(i);
      out.writeInt16LE(Math.round(a + (at(i + 1) - a) * (t - i)), w * 2);
      w++;
      t += this.step;
    }
    this.prev = at(len - 1);
    this.pos = t - (len - 1);
    return w === max ? out : out.subarray(0, w * 2);
  }
}

/** One spoken answer (an assistant audio item upstream): the phone's run. */
interface Run {
  id: string;
  turn: string;
  response: string;
  /** When its first audio reached the phone. */
  startedAt: number;
  /** Audio length received so far. */
  ms: number;
  text: string;
  chunks: number;
  audible: boolean;
  audioDone: boolean;
  /** The phone played all of it. */
  played: boolean;
  /** Cut off: the phone was told to stop playing it. */
  stopped: boolean;
  /** The cut was reported upstream and to the phone. */
  settled: boolean;
  out: Resampler;
}

export class RealtimeCall {
  private upstream: WebSocket;
  private ended = false;
  private ready = false;
  /** Unique per call: transcript lines of two calls must never share an id (turn numbers restart at 1). */
  private id = randomUUID().slice(0, 8);
  private ga: boolean;
  private outRate: number;
  private mic: Resampler;
  private turn = 0;
  private turnOf = new Map<string, number>();
  private heard = new Map<string, string>();
  private runs = new Map<string, Run>();
  /** The answer being generated upstream, and since when. */
  private active: string | null = null;
  private activeSince = 0;
  /** response.create sent and not yet answered by response.created. */
  private creating = false;
  private creatingSince = 0;
  private createQueued = false;
  private userSpeaking = false;
  private speechStoppedAt = 0;
  private tasks = new Map<string, AbortController>();
  private seenCalls = new Set<string>();
  /** Notices to bring up as soon as nobody is speaking. */
  private pending: Array<{ line: string; details?: string }> = [];
  /** The last few lines of this call, for tasks handed to the backend. */
  private recent: Array<{ role: string; content: string }> = [];
  private recentText = "";
  private lastInstructions = "";
  private lastPush = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshWaiting = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private detach: () => void;
  private keepalive: NodeJS.Timeout;
  private attachTimer: NodeJS.Timeout;
  private phone: WebSocket;
  private deviceId: string;
  private cfg: RealtimeConfig;
  private assistant: Assistant;
  private log: (m: string) => void;

  constructor(phone: WebSocket, deviceId: string, cfg: RealtimeConfig, assistant: Assistant, log: (m: string) => void) {
    this.phone = phone;
    this.deviceId = deviceId;
    this.cfg = cfg;
    this.assistant = assistant;
    this.log = log;
    this.ga = cfg.dialect !== "beta";
    this.outRate = cfg.outputRate ?? 24_000;
    this.mic = new Resampler(PHONE_MIC_RATE, cfg.inputRate ?? 24_000);
    claimCall(this);
    this.toPhone({ action: "relay.state", data: { state: "connecting" } });
    const url = new URL(cfg.url);
    if (!url.searchParams.has("model")) url.searchParams.set("model", cfg.model);
    this.upstream = new WebSocket(url, {
      headers: cfg.auth === "api-key" ? { "api-key": cfg.apiKey } : { Authorization: `Bearer ${cfg.apiKey}` },
      // Audio frames would wait for zlib on the thread pool behind the hosts' screens; server-to-server bandwidth is cheap.
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: ATTACH_TIMEOUT_MS,
      maxPayload: 16 * 1024 * 1024,
    });
    this.attachTimer = setTimeout(() => this.fail("语音服务没有及时响应"), ATTACH_TIMEOUT_MS + 5000);
    this.keepalive = setInterval(() => {
      if (this.upstream.readyState === WebSocket.OPEN) this.upstream.ping();
    }, 25_000);
    this.detach = assistant.attachVoice({ notice: (n) => this.notice(n), board: () => this.refresh() });

    this.upstream.on("open", () => this.configure());
    this.upstream.on("message", (data, binary) => {
      if (binary) return;
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg && typeof msg === "object") this.onUpstream(msg);
    });
    this.upstream.on("unexpected-response", (_req, res) => {
      this.fail(res.statusCode === 401 || res.statusCode === 403 ? "语音服务的密钥无效" : res.statusCode === 429 ? "语音服务现在太忙，稍后再试" : `语音服务拒绝了连接（${res.statusCode}）`);
    });
    this.upstream.on("close", () => this.stop("语音服务断开了"));
    this.upstream.on("error", () => this.fail("连不上语音服务"));

    phone.on("message", (data, binary) => {
      if (binary) {
        if (!this.ready || this.upstream.readyState !== WebSocket.OPEN) return;
        const pcm = this.mic.push(asBuffer(data));
        if (pcm.length) this.up({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (msg.action) {
        case "relay.hangup":
          this.stop("挂断了");
          return;
        case "playback.completed": {
          const r = this.runs.get(String(msg.run_id));
          if (r) r.played = true;
          this.idleSoon();
          return;
        }
        case "playback.stopped":
          this.settle(String(msg.run_id), msg.played_audio_ms);
          return;
        // mic_state, ping and chunk receipts: the service needs none of them.
      }
    });
    phone.on("close", () => this.stop("手机断开了"));
    phone.on("error", () => this.stop("手机断开了"));
  }

  private up(msg: Record<string, unknown>): void {
    if (this.upstream.readyState === WebSocket.OPEN) this.upstream.send(JSON.stringify(msg));
  }

  private toPhone(msg: LiveRelayEvent | { action: string; data?: unknown }): void {
    if (this.phone.readyState === WebSocket.OPEN) this.phone.send(JSON.stringify(msg));
  }

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------

  private instructions(): string {
    const text = [personaPrompt(this.assistant.name, this.assistant.persona), BRIDGE, voiceInstructions({ board: this.assistant.voiceBoard(), pending: [], recent: this.recentText })].join("\n\n");
    return Array.from(text).slice(0, MAX_INSTRUCTIONS).join("");
  }

  /** First setup: who it is, how it hears and speaks, the one tool it can call. */
  private configure(): void {
    const c = this.cfg;
    this.recentText = this.assistant.recentForVoice();
    this.lastInstructions = this.instructions();
    this.lastPush = Date.now();
    const vad = c.vad ?? "server_vad";
    const session = this.ga
      ? {
          type: "realtime",
          instructions: this.lastInstructions,
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcm", rate: c.inputRate ?? 24_000 },
              turn_detection: { type: vad, create_response: true, interrupt_response: true },
              ...(c.transcribeModel ? { transcription: { model: c.transcribeModel, ...(c.language ? { language: c.language } : {}) } } : {}),
            },
            output: {
              format: { type: "audio/pcm", rate: this.outRate },
              ...(c.voice ? { voice: c.voice } : {}),
              ...(c.speed && c.speed !== 1 ? { speed: Math.min(1.5, Math.max(0.25, c.speed)) } : {}),
            },
          },
          tools: [ASK_TOOL],
          tool_choice: "auto",
        }
      : {
          modalities: ["text", "audio"],
          instructions: this.lastInstructions,
          ...(c.voice ? { voice: c.voice } : {}),
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          ...(c.transcribeModel ? { input_audio_transcription: { model: c.transcribeModel } } : {}),
          turn_detection: { type: vad },
          tools: [ASK_TOOL],
          tool_choice: "auto",
        };
    this.up({ type: "session.update", session });
  }

  /** Something the voice answers from changed: pushed at most once per gap, never while anyone is speaking. */
  private refresh(): void {
    if (!this.ready || this.ended) return;
    if (this.speaking) {
      this.refreshWaiting = true;
      return;
    }
    if (this.refreshTimer) return;
    const wait = Math.max(0, (this.cfg.refreshGapMs ?? REFRESH_GAP_MS) - (Date.now() - this.lastPush));
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.ended) return;
      if (this.speaking) {
        this.refreshWaiting = true;
        return;
      }
      const next = this.instructions();
      if (next === this.lastInstructions) return;
      this.lastInstructions = next;
      this.lastPush = Date.now();
      this.up({ type: "session.update", session: this.ga ? { type: "realtime", instructions: next } : { instructions: next } });
    }, wait);
  }

  private isPlaying(r: Run, now = Date.now()): boolean {
    return r.audible && !r.played && !r.stopped && now < r.startedAt + r.ms + PLAYBACK_SLACK_MS;
  }

  /** An answer is asked for or being made upstream; one whose end never came stops counting after a while. */
  private generating(): boolean {
    if (this.active && Date.now() - this.activeSince > ACTIVE_MAX_MS) this.active = null;
    if (this.creating && Date.now() - this.creatingSince > CREATE_MAX_MS) this.creating = false;
    return !!this.active || this.creating;
  }

  /** An answer is being made or is still coming out of the phone. */
  private get speaking(): boolean {
    if (this.generating()) return true;
    const now = Date.now();
    for (const r of this.runs.values()) if (this.isPlaying(r, now)) return true;
    return false;
  }

  /** Checks again once the phone should have finished playing; then held-back work goes out. */
  private idleSoon(): void {
    if (this.ended) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const now = Date.now();
    let until = 0;
    if (!this.generating()) for (const r of this.runs.values()) if (this.isPlaying(r, now)) until = Math.max(until, r.startedAt + r.ms + PLAYBACK_SLACK_MS);
    if (until > now) {
      this.idleIn(until - now + 5);
      return;
    }
    if (this.speaking || this.userSpeaking) return;
    if (this.refreshWaiting) {
      this.refreshWaiting = false;
      this.refresh();
    }
    this.speakPending();
  }

  private idleIn(ms: number): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.idleSoon(), ms);
  }

  /** Asks for an answer; one at a time, the next waits for the current one to end. */
  private respond(): void {
    if (this.generating()) {
      this.createQueued = true;
      return;
    }
    this.creating = true;
    this.creatingSince = Date.now();
    this.up({ type: "response.create" });
  }

  // ---------------------------------------------------------------------------
  // Upstream events
  // ---------------------------------------------------------------------------

  private onUpstream(d: Record<string, any>): void {
    switch (d.type) {
      case "session.updated":
        if (!this.ready) {
          clearTimeout(this.attachTimer);
          this.ready = true;
          this.toPhone({ action: "relay.state", data: { state: "ready" } });
        }
        return;
      case "input_audio_buffer.speech_started": {
        this.userSpeaking = true;
        this.turn++;
        if (str(d.item_id)) this.cap(this.turnOf, 200).set(d.item_id, this.turn);
        // The person talks over the answer: the phone stops it now and says how much was heard.
        const now = Date.now();
        for (const r of this.runs.values()) {
          if (!this.isPlaying(r, now)) continue;
          r.stopped = true;
          this.toPhone({ action: "response.audio.stop", data: { run_id: r.id, turn_id: r.turn, reason: "interrupted" } });
        }
        // GA turn detection cancels the answer by itself; the beta settings do not ask for that.
        if (!this.ga && this.active) this.up({ type: "response.cancel" });
        this.toPhone({ action: "input.speech.started", data: { turn: this.turn } });
        return;
      }
      case "input_audio_buffer.speech_stopped":
        this.userSpeaking = false;
        this.speechStoppedAt = Date.now();
        // Held-back work goes out after the answer to this, or after a pause when no answer comes.
        if (this.pending.length || this.refreshWaiting) this.idleIn(AFTER_SPEECH_MS + 5);
        this.toPhone({ action: "input.speech.stopped", data: { turn: this.turn } });
        return;
      case "conversation.item.input_audio_transcription.delta": {
        if (!str(d.item_id) || typeof d.delta !== "string") return;
        const text = (this.heard.get(d.item_id) ?? "") + d.delta;
        this.cap(this.heard, 20).set(d.item_id, text);
        if (text.trim()) this.toPhone({ action: "input.transcript.updated", data: { text, turn: this.turnOf.get(d.item_id) ?? this.turn } });
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const text = typeof d.transcript === "string" ? d.transcript.trim() : "";
        const turn = (str(d.item_id) ? this.turnOf.get(d.item_id) : undefined) ?? this.turn;
        if (str(d.item_id)) this.heard.delete(d.item_id);
        this.toPhone({ action: "input.transcript.done", data: { text, turn } });
        if (text) {
          this.assistant.voiceLine("user", text, `${this.id}-${turn}`);
          this.remember("user", text);
        }
        return;
      }
      case "conversation.item.input_audio_transcription.failed":
        this.log(`realtime: transcription failed ${String(d.error?.code ?? d.error?.message ?? "").slice(0, 80)}`);
        return;
      case "response.created":
        this.active = str(d.response?.id) ? d.response.id : "?";
        this.activeSince = Date.now();
        this.creating = false;
        return;
      case "response.output_audio.delta":
      case "response.audio.delta":
        this.audio(d);
        return;
      case "response.output_audio.done":
      case "response.audio.done": {
        const r = str(d.item_id) ? this.runs.get(d.item_id) : undefined;
        if (r) this.audioDone(r);
        return;
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        if (!str(d.item_id) || typeof d.delta !== "string") return;
        const r = this.run(d.item_id, d.response_id);
        r.text += d.delta;
        if (!r.stopped && r.text.trim()) this.toPhone({ action: "output.transcript.updated", data: { text: r.text, run_id: r.id, turn_id: r.turn } });
        return;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        if (!str(d.item_id)) return;
        const r = this.run(d.item_id, d.response_id);
        if (typeof d.transcript === "string") r.text = d.transcript;
        // A cut-off answer keeps what was heard (settle), not what was meant.
        if (r.stopped || !r.text.trim()) return;
        this.toPhone({ action: "output.transcript.done", data: { text: r.text, run_id: r.id, turn_id: r.turn } });
        this.assistant.voiceLine("assistant", r.text, `${this.id}-${r.id}`);
        this.remember("assistant", r.text);
        return;
      }
      case "response.function_call_arguments.done":
        this.delegation(d.call_id, d.name, d.arguments);
        return;
      case "response.output_item.done":
        if (d.item?.type === "function_call") this.delegation(d.item.call_id, d.item.name, d.item.arguments);
        return;
      case "response.done":
      case "response.cancelled": {
        const resp = d.response ?? {};
        const id: string = str(resp.id) ? resp.id : (this.active ?? "");
        this.active = null;
        let last: Run | undefined;
        for (const r of this.runs.values()) {
          if (r.response !== id) continue;
          last = r;
          // Cancelled before its audio was closed: the phone still needs the end to drain.
          this.audioDone(r);
        }
        if (resp.status === "failed") this.log(`realtime: answer failed ${String(resp.status_details?.error?.code ?? resp.status_details?.reason ?? "").slice(0, 80)}`);
        this.toPhone({ action: "response.ended", data: { run_id: last?.id ?? id, turn_id: last?.turn ?? String(this.turn), status: resp.status ?? (d.type === "response.cancelled" ? "cancelled" : "completed") } });
        if (this.createQueued) {
          this.createQueued = false;
          this.respond();
        }
        this.idleSoon();
        return;
      }
      case "error": {
        const err = d.error ?? {};
        const code = str(err.code) ? err.code : str(err.type) ? err.type : "error";
        this.log(`realtime: upstream error ${code}${str(err.message) ? `: ${clip(err.message.split(this.cfg.apiKey).join("[redacted]"), 160)}` : ""}`);
        if (!this.ready) {
          this.fail(`语音会话配置失败（${code}）`);
          return;
        }
        if (code === "conversation_already_has_active_response") {
          this.creating = false;
          this.createQueued = true;
          return;
        }
        // A rejected request is the relay's problem, not something the person can act on.
        if (err.type !== "invalid_request_error") this.toPhone({ action: "error", data: { error: { code } } });
        return;
      }
    }
  }

  private cap<K, V>(m: Map<K, V>, max: number): Map<K, V> {
    while (m.size >= max) m.delete(m.keys().next().value!);
    return m;
  }

  private run(itemId: string, responseId: unknown): Run {
    let r = this.runs.get(itemId);
    if (!r) {
      r = {
        id: itemId,
        turn: String(this.turn),
        response: str(responseId) ? responseId : (this.active ?? ""),
        startedAt: 0,
        ms: 0,
        text: "",
        chunks: 0,
        audible: false,
        audioDone: false,
        played: false,
        stopped: false,
        settled: false,
        out: new Resampler(this.outRate, PHONE_SPEAKER_RATE),
      };
      this.cap(this.runs, 50).set(itemId, r);
    }
    return r;
  }

  private audio(d: Record<string, any>): void {
    if (!str(d.item_id) || typeof d.delta !== "string") return;
    const r = this.run(d.item_id, d.response_id);
    if (r.stopped) return;
    if (!r.audible) {
      r.audible = true;
      r.startedAt = Date.now();
      this.toPhone({ action: "response.audio.started", data: { run_id: r.id, turn_id: r.turn } });
    }
    const pcm = Buffer.from(d.delta, "base64");
    r.ms += (pcm.length / 2 / this.outRate) * 1000;
    const out = r.out.push(pcm);
    if (!out.length) return;
    this.toPhone({ action: "response.audio.context", data: { chunk_id: `${r.id}-${r.chunks++}`, run_id: r.id, turn_id: r.turn } });
    if (this.phone.readyState === WebSocket.OPEN) this.phone.send(out, { binary: true });
  }

  private audioDone(r: Run): void {
    if (r.audioDone) return;
    r.audioDone = true;
    if (r.audible && !r.stopped) this.toPhone({ action: "response.audio.done", data: { run_id: r.id, turn_id: r.turn } });
  }

  /** The phone stopped a cut-off answer: the service forgets what was not heard, the captions keep what was. */
  private settle(runId: string, playedMs: unknown): void {
    const r = this.runs.get(runId);
    if (!r || r.settled) return;
    r.settled = true;
    r.stopped = true;
    const heardMs = Math.max(0, Math.min(r.ms, typeof playedMs === "number" && Number.isFinite(playedMs) ? playedMs : r.ms));
    if (this.ga && r.ms > 0) this.up({ type: "conversation.item.truncate", item_id: r.id, content_index: 0, audio_end_ms: Math.floor(heardMs) });
    // The service gives no text for part of an answer: take the same share of the words as of the audio.
    const chars = Array.from(r.text);
    const heard = r.ms > 0 ? chars.slice(0, Math.round((chars.length * heardMs) / r.ms)).join("").trim() : "";
    this.toPhone({ action: "response.interrupted", data: { run_id: r.id, turn_id: r.turn, text: heard } });
    if (heard) {
      this.assistant.voiceLine("assistant", `${heard}…`, `${this.id}-${r.id}`);
      this.remember("assistant", `${heard}…`);
    }
    this.idleSoon();
  }

  private remember(role: "user" | "assistant", content: string): void {
    this.recent = [...this.recent, { role, content: clip(content, 200) }].slice(-6);
  }

  // ---------------------------------------------------------------------------
  // Tasks and notices
  // ---------------------------------------------------------------------------

  private delegation(callId: unknown, name: unknown, args: unknown): void {
    if (!str(callId) || this.seenCalls.has(callId)) return;
    if (this.seenCalls.size >= 200) this.seenCalls.delete(this.seenCalls.values().next().value!);
    this.seenCalls.add(callId);
    if (str(name) && name !== TOOL) {
      this.toolOutput(callId, `没有 ${name} 这个工具，要查或要办的事都用 ${TOOL}。`);
      return;
    }
    let objective = "";
    try {
      const a = JSON.parse(typeof args === "string" && args.trim() ? args : "{}");
      if (typeof a?.objective === "string") objective = a.objective;
    } catch {
      /* answered below */
    }
    if (!objective.trim()) {
      this.toolOutput(callId, "objective 是空的：把我的原话写进 objective 再调用。");
      return;
    }
    const ac = new AbortController();
    this.tasks.set(callId, ac);
    const title = clip(objective.replace(/\s+/g, " ").trim(), 40);
    this.toPhone({ action: "relay.task", data: { id: callId, title, status: "running" } });
    this.assistant
      .delegate(objective, this.recent.slice(), ac.signal)
      .then((script) => {
        if (ac.signal.aborted) return;
        this.tasks.delete(callId);
        const lines = [`台词：${clip((script.say || "好了。").trim(), 1990)}`];
        const notes = [script.keep.trim(), ...this.pending.map((p) => p.details?.trim() ?? "")].filter(Boolean);
        if (notes.length) lines.push(`备查（不出声，我追问时再用）：${clip(notes.join("\n"), 1990)}`);
        // Notices that came in meanwhile ride along with the answer.
        if (this.pending.length) lines.push(`说完台词再告诉我：${this.pending.map((p) => p.line).join(" ")}`);
        this.pending = [];
        this.toolOutput(callId, lines.join("\n"));
        this.toPhone({ action: "relay.task", data: { id: callId, title, status: "done" } });
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        this.log(`realtime: delegation failed ${(e as Error).message}`);
        this.tasks.delete(callId);
        this.toolOutput(callId, "台词：没查成，后台没回我。你再说一遍我重查。");
        this.toPhone({ action: "relay.task", data: { id: callId, title, status: "failed" } });
      })
      .finally(() => this.tasks.delete(callId));
  }

  private toolOutput(callId: string, output: string): void {
    this.up({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
    this.respond();
  }

  /**
   * A proactive notice while the call is open. Unlike MOSS-Live this protocol
   * can be asked to speak: when nobody is talking the line goes out at once as a
   * system message and a new answer; otherwise it waits until the current answer
   * has been heard, or rides along with a running task's result.
   */
  private notice(n: Notice): void {
    if (!this.ready || this.ended) return;
    // A reminder at a time is the person's own sentence; anything else is news the assistant brings up.
    const line = n.body.startsWith("到点了") ? n.body : `对了，${n.body}`;
    this.pending = [...this.pending, { line, details: n.details }].slice(-3);
    const now = this.tasks.size > 0 || (!this.speaking && !this.userSpeaking && Date.now() - this.speechStoppedAt >= AFTER_SPEECH_MS);
    this.toPhone({ action: "relay.notice", data: { id: n.id, line, how: now ? "now" : "next" } });
    this.speakPending();
  }

  private speakPending(): void {
    if (!this.pending.length || !this.ready || this.ended || this.tasks.size) return;
    if (this.speaking || this.userSpeaking) return;
    const wait = this.speechStoppedAt + AFTER_SPEECH_MS - Date.now();
    if (wait > 0) {
      this.idleIn(wait + 5);
      return;
    }
    const said = this.pending;
    this.pending = [];
    const details = said.map((p) => p.details?.trim() ?? "").filter(Boolean);
    const text = ["【要告诉我的事】", ...said.map((p) => p.line), ...(details.length ? [`备查（不出声，我追问时再用）：${clip(details.join("\n"), 1990)}`] : [])].join("\n");
    this.up({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
    this.respond();
  }

  private fail(message: string): void {
    if (this.ended) return;
    this.toPhone({ action: "relay.state", data: { state: "error", message } });
    this.stop(message);
  }

  stop(why: string): void {
    if (this.ended) return;
    this.ended = true;
    releaseCall(this);
    clearTimeout(this.attachTimer);
    clearInterval(this.keepalive);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.detach();
    for (const ac of this.tasks.values()) ac.abort();
    this.tasks.clear();
    this.toPhone({ action: "relay.state", data: { state: "closed", message: why } });
    try {
      this.phone.close(1000, "call ended");
    } catch {
      /* already gone */
    }
    this.upstream.terminate();
    this.log(`realtime: call ended (${why}) ${this.deviceId}`);
  }
}
