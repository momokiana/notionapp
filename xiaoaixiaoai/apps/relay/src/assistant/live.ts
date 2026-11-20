/**
 * A voice call: the phone streams microphone PCM to the relay, the relay keeps
 * the MOSS-Live connection (the API key never leaves the server), and every
 * task MOSS-Live hands to "the backend" is done by the text assistant.
 *
 * MOSS-Live protocol: https://platform.mosi.cn/docs/reference/moss-live
 * Other voice services speaking the OpenAI Realtime protocol: realtime.ts. The
 * phone sees the same events either way.
 */
import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import { LIVE_CLIENT_ACTIONS, type LiveRelayEvent, type Notice } from "@xiaoaixiaoai/protocol";
import type { Assistant } from "./assistant.ts";
import { claimCall, releaseCall } from "./calls.ts";
import { LocalVoiceCall, type LocalLiveConfig } from "./local-call.ts";
import { personaPrompt, voiceInstructions } from "./prompts.ts";
import { RealtimeCall, type RealtimeConfig } from "./realtime.ts";
import { clip } from "./speech.ts";
import { timeZone } from "./timezone.ts";

export { endAllCalls } from "./calls.ts";

/** The voice service a call goes through. */
export type LiveConfig = MossLiveConfig | RealtimeConfig | LocalLiveConfig;

/** Opens a call on whichever voice service is configured. */
export function startCall(phone: WebSocket, deviceId: string, cfg: LiveConfig, assistant: Assistant, log: (m: string) => void): void {
  if (cfg.provider === "local") new LocalVoiceCall(phone, deviceId, cfg, assistant, log);
  else if (cfg.provider === "openai-realtime") new RealtimeCall(phone, deviceId, cfg, assistant, log);
  else new LiveCall(phone, deviceId, cfg, assistant, log);
}

export interface MossLiveConfig {
  provider?: "moss-live";
  url: string;
  apiKey: string;
  model: string;
  /** Voice id for change_voice; the model's default voice when unset. */
  voice?: string;
  /** Speaking rate, 0.5–1.5 (1 is normal). */
  speed?: number;
  /** Least time between two refreshes of the voice's instructions. */
  refreshGapMs?: number;
}

/** Upstream events the phone needs for captions and playback. */
const TO_PHONE = new Set([
  "input.speech.started",
  "input.speech.stopped",
  "input.transcript.updated",
  "input.transcript.done",
  "input.transcript.revised",
  "output.transcript.updated",
  "output.transcript.done",
  "response.audio.started",
  "response.audio.context",
  "response.audio.done",
  "response.audio.stop",
  "response.ended",
  "response.interrupted",
  "media.output.configured",
  "session.closing",
]);
const FROM_PHONE = new Set<string>(LIVE_CLIENT_ACTIONS);
const ATTACH_TIMEOUT_MS = 15_000;
const REFRESH_GAP_MS = 5000;
/** Default downlink: 48 kHz mono PCM16, 96 bytes a millisecond. */
const BYTES_PER_MS = 96;
/** MOSS-Live rejects instructions longer than this (characters). */
const MAX_INSTRUCTIONS = 16_000;

const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const byteLength = (d: RawData): number => (Array.isArray(d) ? d.reduce((n, b) => n + b.length, 0) : d instanceof ArrayBuffer ? d.byteLength : d.length);

/**
 * Rebuilds a phone message with only the fields MOSS-Live accepts; null when it
 * cannot be made valid. Upstream answers anything else with invalid_public_request.
 */
export function cleanPhoneMessage(msg: Record<string, unknown>, turnOf: (runId: string) => string | undefined): Record<string, unknown> | null {
  const action = msg.action;
  if (typeof action !== "string" || !FROM_PHONE.has(action)) return null;
  switch (action) {
    case "mic_state":
      return typeof msg.enabled === "boolean" ? { action, enabled: msg.enabled } : null;
    case "ping":
      return typeof msg.timestamp === "number" ? { action, timestamp: msg.timestamp } : { action };
  }
  // playback.*: run_id and turn_id are required strings; fill turn_id from the run when the phone missed it.
  if (!str(msg.run_id)) return null;
  const turn = str(msg.turn_id) ? msg.turn_id : turnOf(msg.run_id);
  if (!str(turn)) return null;
  const out: Record<string, unknown> = { action, run_id: msg.run_id, turn_id: turn };
  if (action === "playback.chunk.completed") {
    if (!str(msg.chunk_id)) return null;
    out.chunk_id = msg.chunk_id;
  }
  if (action === "playback.stopped") {
    if (typeof msg.played_audio_ms === "number" && Number.isFinite(msg.played_audio_ms) && msg.played_audio_ms >= 0) out.played_audio_ms = Math.round(msg.played_audio_ms);
    if (str(msg.reason)) out.reason = msg.reason;
  }
  return out;
}

export class LiveCall {
  private upstream: WebSocket;
  private ended = false;
  private ready = false;
  /** Unique per call: transcript lines of two calls must never share an id (turn numbers restart at 1). */
  private id = randomUUID().slice(0, 8);
  private tasks = new Map<string, AbortController>();
  /** run_id -> turn_id as announced upstream; playback receipts need both. */
  private turns = new Map<string, string>();
  /** Runs the person cut off: their full text arrives later and must not replace what was heard. */
  private cut = new Set<string>();
  /** Sentences that arrived while nothing could carry them: the voice says them on its next turn. */
  private pending: string[] = [];
  /** configuring -> armed (setup accepted) -> speaking (the next answer) -> cleared once said. */
  private noticeState: "idle" | "configuring" | "armed" | "speaking" = "idle";
  private noticeRun = "";
  /** When the answer being said started; 0 when nothing is being said. */
  private speakingSince = 0;
  /** The service is still making that answer. */
  private answering = false;
  /** The answer whose audio the phone has not finished playing ("" when none): it is still being heard. */
  private playingRun = "";
  /** Length (ms) of each chunk sent to the phone and not yet receipted, and how much of each run the receipts cover. */
  private chunkMs = new Map<string, number>();
  private nextChunk = "";
  private receiptedMs = new Map<string, number>();
  private recent = "";
  private lastInstructions = "";
  private lastPush = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshWaiting = false;
  private lastSay = 0;
  private dropped = 0;
  private detach: () => void;
  private keepalive: NodeJS.Timeout;
  private attachTimer: NodeJS.Timeout;
  private phone: WebSocket;
  private deviceId: string;
  private cfg: MossLiveConfig;
  private assistant: Assistant;
  private log: (m: string) => void;

  constructor(phone: WebSocket, deviceId: string, cfg: MossLiveConfig, assistant: Assistant, log: (m: string) => void) {
    this.phone = phone;
    this.deviceId = deviceId;
    this.cfg = cfg;
    this.assistant = assistant;
    this.log = log;
    // MOSS-Live allows one open session per account: a new call replaces the old one.
    claimCall(this);
    this.toPhone({ action: "relay.state", data: { state: "connecting" } });
    const url = new URL(cfg.url);
    url.searchParams.set("model", cfg.model);
    url.searchParams.set("user", `xiaoaixiaoai-${deviceId}`);
    this.upstream = new WebSocket(url, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      // PCM hardly compresses, and every frame would wait for zlib on the thread pool behind the hosts' screens.
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: ATTACH_TIMEOUT_MS,
      maxPayload: 16 * 1024 * 1024,
    });
    this.attachTimer = setTimeout(() => this.fail("语音服务没有及时响应"), ATTACH_TIMEOUT_MS + 5000);
    this.keepalive = setInterval(() => this.up({ action: "ping", timestamp: Date.now() }), 25_000);
    this.detach = assistant.attachVoice({ notice: (n) => this.notice(n), board: () => this.refresh() });

    this.upstream.on("open", () => this.up({ action: "attach_session", memory_scope: "session", delegation: { type: "client" } }));
    this.upstream.on("message", (data, binary) => {
      if (binary) {
        if (this.nextChunk) {
          this.chunkMs.set(this.nextChunk, byteLength(data) / BYTES_PER_MS);
          if (this.chunkMs.size > 2000) this.chunkMs.delete(this.chunkMs.keys().next().value!);
          this.nextChunk = "";
        }
        if (phone.readyState === WebSocket.OPEN) phone.send(data, { binary: true });
        return;
      }
      let msg: { action?: string; data?: any };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onUpstream(msg);
    });
    this.upstream.on("unexpected-response", (_req, res) => {
      this.fail(res.statusCode === 401 || res.statusCode === 403 ? "语音服务的密钥无效" : res.statusCode === 429 ? "语音服务现在太忙，稍后再试" : `语音服务拒绝了连接（${res.statusCode}）`);
    });
    this.upstream.on("close", (code) => this.stop(code === 1013 ? "语音服务现在满了，过一会儿再试" : "语音服务断开了"));
    this.upstream.on("error", () => this.fail("连不上语音服务"));

    phone.on("message", (data, binary) => {
      if (!this.ready || this.upstream.readyState !== WebSocket.OPEN) return;
      if (binary) {
        // 16 kHz mono PCM; audio-only sessions send it without a type prefix.
        this.upstream.send(data, { binary: true });
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.action === "relay.hangup") {
        this.stop("挂断了");
        return;
      }
      const clean = cleanPhoneMessage(msg, (run) => this.turns.get(run));
      if (clean) this.up(this.receipt(clean));
      else if (typeof msg.action === "string" && FROM_PHONE.has(msg.action) && this.dropped++ < 5) this.log(`live: dropped malformed ${msg.action} from phone`);
    });
    phone.on("close", () => this.stop("手机断开了"));
    phone.on("error", () => this.stop("手机断开了"));
  }

  private up(msg: unknown): void {
    if (this.upstream.readyState === WebSocket.OPEN) this.upstream.send(JSON.stringify(msg));
  }

  private toPhone(msg: LiveRelayEvent | { action: string; data?: unknown }): void {
    if (this.phone.readyState === WebSocket.OPEN) this.phone.send(JSON.stringify(msg));
  }

  /**
   * An answer is being made, or the phone is still playing it: the service can
   * be done long before the person has heard the end. One whose end was never
   * announced must not hold refreshes back for good.
   */
  private get speaking(): boolean {
    return this.speakingSince > 0 && (this.answering || this.playingRun !== "") && Date.now() - this.speakingSince < 45_000;
  }

  /**
   * Playback receipts on their way up. The phone reports in playback.stopped
   * all of the answer it played (realtime.ts needs that); MOSS-Live wants only
   * the part of the chunk being played, the chunks before it having been
   * receipted one by one.
   */
  private receipt(msg: Record<string, unknown>): Record<string, unknown> {
    const run = String(msg.run_id);
    switch (msg.action) {
      case "playback.chunk.completed": {
        const ms = this.chunkMs.get(String(msg.chunk_id));
        this.chunkMs.delete(String(msg.chunk_id));
        if (ms !== undefined) {
          this.receiptedMs.set(run, (this.receiptedMs.get(run) ?? 0) + ms);
          if (this.receiptedMs.size > 100) this.receiptedMs.delete(this.receiptedMs.keys().next().value!);
        }
        return msg;
      }
      case "playback.stopped": {
        const before = this.receiptedMs.get(run) ?? 0;
        this.receiptedMs.delete(run);
        this.heard(run);
        if (typeof msg.played_audio_ms !== "number") return msg;
        return { ...msg, played_audio_ms: Math.max(0, Math.round(msg.played_audio_ms - before)) };
      }
      case "playback.completed":
        this.receiptedMs.delete(run);
        this.heard(run);
        return msg;
    }
    return msg;
  }

  /** The phone has played all of a run it is going to play. */
  private heard(run: string): void {
    if (run !== this.playingRun) return;
    this.playingRun = "";
    this.spoke();
  }

  /** Rules, the snapshot, what is waiting to be said and the recent chat: one builder for every refresh (4.3). */
  private instructions(): string {
    return Array.from(
      voiceInstructions({
        board: this.assistant.voiceBoard(),
        pending: this.pending,
        recent: this.recent,
        memories: this.assistant.voiceMemoryContext(),
      }),
    )
      .slice(0, MAX_INSTRUCTIONS)
      .join("");
  }

  /** First setup of the session: who it is, how it works, what it can call. */
  private configure(): void {
    const name = this.assistant.name;
    this.recent = this.assistant.recentForVoice();
    this.lastInstructions = this.instructions();
    this.lastPush = Date.now();
    this.up({
      action: "session.update",
      session: {
        persona: {
          name,
          // Speech recognition often hears the name as a homophone.
          aliases: [...new Set(["助理", "小助理", ...(name === "爱弥斯" ? ["艾弥斯", "爱米斯"] : [])])],
          prompt: personaPrompt(name, this.assistant.persona, this.assistant.userCall),
        },
        instructions: this.lastInstructions,
        tools: [],
      },
    });
  }

  /**
   * Something the voice answers from has changed. Pushed at most once per gap
   * and never while the voice is speaking; only `instructions` is sent, the
   * rest of the session keeps its values.
   */
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
      if (this.pending.length && this.noticeState === "idle") this.noticeState = "configuring";
      this.up({ action: "session.update", session: { instructions: next } });
    }, wait);
  }

  private spoke(): void {
    if (this.speaking) return;
    this.speakingSince = 0;
    if (this.refreshWaiting) {
      this.refreshWaiting = false;
      this.refresh();
    }
  }

  private onUpstream(msg: { action?: string; data?: any }): void {
    const d = msg.data ?? {};
    switch (msg.action) {
      case "session_attached":
        clearTimeout(this.attachTimer);
        if (d.delegation !== "client") this.log("live: delegation not enabled upstream");
        // Local time for "what time is it"; never the location.
        this.up({ action: "client_context.update", context: { time_zone: timeZone() } });
        if (this.cfg.speed && this.cfg.speed !== 1) this.up({ action: "media.output.configure", speed: Math.min(1.5, Math.max(0.5, this.cfg.speed)) });
        if (this.cfg.voice) this.up({ action: "change_voice", voice_name: this.cfg.voice });
        else this.configure();
        return;
      case "voice_changed":
        this.configure();
        return;
      case "session.updated":
        if (d.error) {
          this.log(`live: session.updated error ${String(d.error).slice(0, 120)}`);
          // A failed refresh mid-call keeps the previous setup; only a failed first setup ends the call.
          if (!this.ready) this.fail("语音会话配置失败");
          return;
        }
        if (this.noticeState === "configuring") this.noticeState = "armed";
        if (!this.ready) {
          this.ready = true;
          this.toPhone({ action: "relay.state", data: { state: "ready" } });
        }
        return;
      case "session.delegation.created":
        this.delegation(d);
        return;
      case "session.delegation.cancelled": {
        this.tasks.get(d.delegation_id)?.abort();
        this.tasks.delete(d.delegation_id);
        return;
      }
      case "input.transcript.done":
      case "input.transcript.revised":
        // One line per turn of this call; a revision replaces the first hearing.
        if (typeof d.text === "string") this.assistant.voiceLine("user", d.text, d.turn ? `${this.id}-${String(d.turn)}` : undefined);
        break;
      case "output.transcript.done":
        // One line per answer (run): a turn can hold several ("我看看" and then the result).
        if (typeof d.text === "string" && !this.cut.has(d.run_id)) this.assistant.voiceLine("assistant", d.text, this.lineKey(d));
        if (typeof d.text === "string" && this.lastSay) {
          // 4.11: did the voice say the line as given?
          this.log(`live: said ${Array.from(d.text).length} for a line of ${this.lastSay}`);
          this.lastSay = 0;
        }
        if (this.noticeState === "speaking" && d.run_id === this.noticeRun) {
          // Said once: take the sentences out of the instructions so they are not repeated.
          this.pending = [];
          this.noticeState = "idle";
          this.refresh();
        }
        break;
      case "response.audio.context":
        if (str(d.chunk_id)) this.nextChunk = d.chunk_id;
        break;
      case "response.audio.started":
        this.speakingSince = Date.now();
        this.answering = true;
        if (str(d.run_id)) this.playingRun = d.run_id;
        if (this.noticeState === "armed" && str(d.run_id)) {
          this.noticeState = "speaking";
          this.noticeRun = d.run_id;
        }
        break;
      case "response.ended":
        this.answering = false;
        this.spoke();
        break;
      case "response.interrupted":
        // Why it was cut (the person spoke, or playback timed out or failed): the first thing to look at when calls sound choppy.
        this.log(`live: answer cut${str(d.reason) ? ` (${clip(d.reason, 60)})` : ""}`);
        this.answering = false;
        if (d.run_id === this.playingRun) this.playingRun = "";
        this.spoke();
        if (str(d.run_id)) {
          this.cut.add(d.run_id);
          if (this.cut.size > 100) this.cut.delete(this.cut.values().next().value!);
        }
        if (typeof d.text === "string" && d.text.trim()) this.assistant.voiceLine("assistant", `${d.text}…`, this.lineKey(d));
        break;
      case "error": {
        const code = typeof d.error?.code === "string" ? d.error.code : "error";
        this.log(`live: upstream error ${code}${typeof d.error?.client_event_id === "string" ? ` (${d.error.client_event_id})` : ""}`);
        // A rejected request is the relay's problem, not something the person can act on.
        if (code !== "invalid_public_request" && code !== "unsupported_control") this.toPhone({ action: "error", data: { error: { code } } });
        return;
      }
    }
    if (str(d.run_id) && str(d.turn_id) && !this.turns.has(d.run_id)) {
      this.turns.set(d.run_id, d.turn_id);
      if (this.turns.size > 200) this.turns.delete(this.turns.keys().next().value!);
    }
    if (msg.action && TO_PHONE.has(msg.action)) this.toPhone({ action: msg.action, data: d });
  }

  private lineKey(d: { run_id?: unknown; turn_id?: unknown }): string | undefined {
    const part = str(d.run_id) ? d.run_id : str(d.turn_id) ? d.turn_id : undefined;
    return part ? `${this.id}-${part}` : undefined;
  }

  private delegation(d: any): void {
    const id = d?.delegation?.id;
    const objective = typeof d?.objective === "string" ? d.objective : "";
    if (typeof id !== "string" || !id || this.tasks.has(id) || !objective.trim()) return;
    const ac = new AbortController();
    this.tasks.set(id, ac);
    const title = clip(objective.replace(/\s+/g, " ").trim(), 40);
    this.toPhone({ action: "relay.task", data: { id, title, status: "running" } });
    const context = Array.isArray(d.context) ? d.context.filter((c: any) => typeof c?.role === "string" && typeof c?.content === "string") : [];
    // No progress labels go upstream: they are no use for the answer and tempt the voice to narrate (4.2).
    this.assistant
      .delegate(objective, context, ac.signal)
      .then((script) => {
        if (ac.signal.aborted) return;
        // Facts first, silently; then the line to say.
        if (script.keep) this.append("session.thinking.append", id, script.keep, "in_progress");
        this.lastSay = Array.from(script.say).length;
        this.append("session.commentary.append", id, script.say || "好了。", "completed");
        this.toPhone({ action: "relay.task", data: { id, title, status: "done" } });
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        this.log(`live: delegation failed ${(e as Error).message}`);
        this.append("session.commentary.append", id, "没查成，后台没回我。你再说一遍我重查。", "failed");
        this.toPhone({ action: "relay.task", data: { id, title, status: "failed" } });
      })
      .finally(() => this.tasks.delete(id));
  }

  private append(action: string, delegationId: string, content: string, status: "in_progress" | "completed" | "failed"): void {
    const text = clip(content.trim() || "好了。", 1990);
    this.up({ action, event_id: randomUUID(), delegation_id: delegationId, content: text, status });
  }

  private queue(line: string): void {
    this.pending = [...this.pending, line].slice(-3);
    this.refresh();
  }

  /**
   * A proactive notice while the call is open. MOSS-Live has no "say this
   * now": it only speaks host text inside a running delegation. So the notice
   * rides on a running task when there is one; otherwise it waits in the
   * instructions and the voice brings it up on its next turn. The phone
   * notification is posted either way, and the call screen is told which way
   * it went.
   *
   * Tried against the live service on 2026-11-13 and not usable: a made-up
   * tool call id is refused (`unknown_call_id`); a finished delegation refuses
   * more text (`delegation_terminal`); an async client tool the voice keeps
   * open does get spoken when answered, but the voice opens it only now and
   * then, and while one is open it stops handing questions to the backend.
   */
  private notice(n: Notice): void {
    if (!this.ready) return;
    // A reminder at a time is the person's own sentence; anything else is news the assistant brings up.
    const line = n.body.startsWith("到点了") ? n.body : `对了，${n.body}`;
    const running = [...this.tasks.keys()].pop();
    this.toPhone({ action: "relay.notice", data: { id: n.id, line, how: running ? "now" : "next" } });
    if (running) {
      if (n.details) this.append("session.thinking.append", running, n.details, "in_progress");
      this.append("session.commentary.append", running, line, "in_progress");
      return;
    }
    this.queue(line);
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
    this.log(`live: call ended (${why}) ${this.deviceId}`);
  }
}
