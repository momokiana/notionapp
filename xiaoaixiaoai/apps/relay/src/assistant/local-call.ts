/**
 * Real-time voice call backed by the user's own local Windows GPU host
 * (FunASR Paraformer + GPT-SoVITS v2ProPlus) bridged over hostd WebSocket RPCs.
 * Speaks the exact same WebSocket event & PCM protocol as MOSS-Live / OpenAI Realtime.
 */
import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import type { LiveRelayEvent, Notice } from "@xiaoaixiaoai/protocol";
import type { Assistant } from "./assistant.ts";
import { claimCall, releaseCall } from "./calls.ts";
import { clip } from "./speech.ts";

export interface LocalLiveConfig {
  provider: "local";
  model: string;
  speed?: number;
  hostId?: string;
}

const INPUT_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 48_000;
/** 40 ms at 16 kHz mono PCM16LE = 640 samples = 1280 bytes. */
const VAD_FRAME_BYTES = 1280;
const VAD_START_RMS = 0.010;
const VAD_STOP_RMS = 0.006;
const VAD_START_FRAMES = 3;
const VAD_STOP_FRAMES = 19; // ~760 ms silence hang-time
const VAD_MAX_FRAMES = 500; // 20 s max single utterance
const VAD_PREROLL_FRAMES = 6; // 240 ms pre-roll
const MIN_SPEECH_BYTES = 3200; // >= 100 ms speech required to call ASR

const asBuffer = (d: RawData): Buffer => (Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d));

function frameRms(buf: Buffer): number {
  const samples = Math.floor(buf.length / 2);
  if (samples <= 0) return 0;
  let sumSq = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const s = buf.readInt16LE(i) / 32768;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples);
}

/** Splits an assistant reply into short speakable clauses so TTS streams smoothly sentence-by-sentence. */
export function splitSpeakableSentences(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const rawParts = clean.split(/([。！？!?；;\n]+)/);
  const combined: string[] = [];
  for (let i = 0; i < rawParts.length; i += 2) {
    const body = rawParts[i]?.trim() ?? "";
    const delim = rawParts[i + 1]?.trim() ?? "";
    const piece = `${body}${delim}`.trim();
    if (!piece) continue;
    if (combined.length > 0 && Array.from(combined[combined.length - 1]!).length < 6) {
      combined[combined.length - 1] = `${combined[combined.length - 1]}${piece}`;
    } else {
      combined.push(piece);
    }
  }
  if (combined.length > 1 && Array.from(combined[combined.length - 1]!).length < 4) {
    const tail = combined.pop()!;
    combined[combined.length - 1] = `${combined[combined.length - 1]}${tail}`;
  }
  return combined.length ? combined : [clean];
}

export class LocalVoiceCall {
  private readonly id = randomUUID().slice(0, 8);
  private readonly phone: WebSocket;
  private readonly deviceId: string;
  private readonly cfg: LocalLiveConfig;
  private readonly assistant: Assistant;
  private readonly log: (m: string) => void;
  private readonly hostId: string | undefined;
  private readonly detach: () => void;

  private ready = false;
  private ended = false;
  private micEnabled = true;
  private turnSeq = 0;
  private turnChain: Promise<void> = Promise.resolve();

  // Streaming VAD state over 40 ms 16 kHz mono frames.
  private residual: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private preroll: Buffer[] = [];
  private speechChunks: Buffer[] = [];
  private speechBytes = 0;
  private speechFrames = 0;
  private hitFrames = 0;
  private silenceFrames = 0;
  private userSpeaking = false;

  // Active turn / barge-in cancellation & phone playback tracking.
  private epoch = 0;
  private activeAbort: AbortController | null = null;
  private activeVoiceReqId: string | null = null;
  private activeRunId: string | null = null;
  private activeTurnId: string | null = null;
  private activeText = "";
  private activeAudible = false;
  private activeVoiceLineTurnId: string | null = null;
  private activeVoiceLineRecorded = false;
  private activeTotalChunks = 0;
  private activePlayedChunks = 0;
  private activeSentMs = 0;
  private activeStreamingDone = false;
  private playbackTimer: NodeJS.Timeout | null = null;
  private pendingNotices: string[] = [];

  constructor(phone: WebSocket, deviceId: string, cfg: LocalLiveConfig, assistant: Assistant, log: (m: string) => void) {
    this.phone = phone;
    this.deviceId = deviceId;
    this.cfg = cfg;
    this.assistant = assistant;
    this.log = log;

    claimCall(this);
    const host = assistant.findVoiceHost(cfg.hostId);
    this.hostId = host?.id;
    this.detach = assistant.attachVoice({ notice: (n) => this.onNotice(n) });

    phone.on("message", (data, binary) => this.onPhoneMessage(data, binary));
    phone.on("close", () => this.stop("手机断开了"));
    phone.on("error", () => this.stop("手机断开了"));

    if (!host) {
      this.fail("电脑未在线或未开启本地语音服务。");
      return;
    }

    this.toPhone({ action: "media.output.configured", data: { sample_rate: OUTPUT_SAMPLE_RATE, channels: 1 } });
    this.toPhone({ action: "relay.state", data: { state: "connecting" } });
    void this.warmup(host.id);
  }

  private toPhone(msg: LiveRelayEvent | { action: string; data?: unknown }): void {
    if (this.phone.readyState === WebSocket.OPEN) {
      this.phone.send(JSON.stringify(msg));
    }
  }

  private async warmup(hostId: string): Promise<void> {
    try {
      await this.assistant.callVoiceHost(hostId, "voice.warmup", {}, 90_000);
      if (this.ended) return;
      this.ready = true;
      this.toPhone({ action: "relay.state", data: { state: "ready" } });
    } catch (e) {
      this.fail(`本地语音启动失败：${clip((e as Error).message, 80)}`);
    }
  }

  private onPhoneMessage(data: RawData, binary: boolean): void {
    if (this.ended) return;
    if (binary) {
      if (!this.ready || !this.micEnabled) return;
      this.feedAudio(asBuffer(data));
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.action === "relay.hangup") {
      this.stop("挂断了");
      return;
    }
    if (msg.action === "ping") {
      this.toPhone({ action: "pong", data: { ...(typeof msg.timestamp === "number" ? { timestamp: msg.timestamp } : {}) } });
      return;
    }
    if (msg.action === "playback.chunk.completed") {
      const runId = typeof msg.run_id === "string" ? msg.run_id : "";
      if (runId && runId === this.activeRunId) {
        this.activePlayedChunks++;
      }
      return;
    }
    if (msg.action === "playback.completed" || msg.action === "playback.stopped") {
      const runId = typeof msg.run_id === "string" ? msg.run_id : "";
      if (runId && runId === this.activeRunId) {
        this.finishPlayback(runId, msg.action === "playback.stopped");
      }
      return;
    }
    if (msg.action === "mic_state" && typeof msg.enabled === "boolean") {
      this.micEnabled = msg.enabled;
      if (!this.micEnabled) {
        if (this.userSpeaking) this.finishSpeech();
        else {
          this.hitFrames = 0;
          this.preroll = [];
          this.residual = Buffer.alloc(0);
        }
      }
    }
  }

  private feedAudio(chunk: Buffer): void {
    const combined = this.residual.length ? Buffer.concat([this.residual, chunk]) : chunk;
    let offset = 0;
    while (offset + VAD_FRAME_BYTES <= combined.length) {
      const frame = combined.subarray(offset, offset + VAD_FRAME_BYTES);
      offset += VAD_FRAME_BYTES;
      this.processVadFrame(Buffer.from(frame));
    }
    this.residual = offset < combined.length ? Buffer.from(combined.subarray(offset)) : Buffer.alloc(0);
  }

  private processVadFrame(frame: Buffer): void {
    const rms = frameRms(frame);
    if (!this.userSpeaking) {
      this.preroll.push(frame);
      if (this.preroll.length > VAD_PREROLL_FRAMES) this.preroll.shift();
      if (rms >= VAD_START_RMS) {
        this.hitFrames++;
        if (this.hitFrames >= VAD_START_FRAMES) {
          this.startSpeech();
        }
      } else {
        this.hitFrames = 0;
      }
      return;
    }

    this.speechChunks.push(frame);
    this.speechBytes += frame.length;
    this.speechFrames++;
    if (rms < VAD_STOP_RMS) this.silenceFrames++;
    else this.silenceFrames = 0;

    if (this.silenceFrames >= VAD_STOP_FRAMES || this.speechFrames >= VAD_MAX_FRAMES) {
      this.finishSpeech();
    }
  }

  private startSpeech(): void {
    this.userSpeaking = true;
    this.hitFrames = 0;
    this.silenceFrames = 0;
    this.speechFrames = this.preroll.length;
    this.speechChunks = this.preroll.slice();
    this.speechBytes = this.speechChunks.reduce((n, b) => n + b.length, 0);
    this.preroll = [];
    this.turnSeq++;

    this.interruptActiveTurn();
    this.log(`local-call: speech start turn=${this.turnSeq} dev=${this.deviceId}`);
    this.toPhone({ action: "input.speech.started", data: { turn: this.turnSeq } });
  }

  private finishSpeech(): void {
    if (!this.userSpeaking) return;
    const pcm = Buffer.concat(this.speechChunks);
    const turnNum = this.turnSeq;
    this.userSpeaking = false;
    this.speechChunks = [];
    this.speechBytes = 0;
    this.speechFrames = 0;
    this.silenceFrames = 0;
    this.toPhone({ action: "input.speech.stopped", data: { turn: turnNum } });

    if (pcm.length < MIN_SPEECH_BYTES) {
      this.toPhone({ action: "input.transcript.done", data: { text: "", turn: turnNum } });
      this.drainPendingNotice();
      return;
    }
    const myEpoch = ++this.epoch;
    this.turnChain = this.turnChain
      .then(() => this.handleUtterance(turnNum, pcm, myEpoch))
      .catch((e) => {
        if (!this.ended) this.log(`local-call: turn error ${(e as Error).message}`);
      });
  }

  private clearPlaybackTimer(): void {
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
  }

  private recordSpokenLine(text: string, interrupted: boolean): void {
    if (this.activeVoiceLineRecorded || !this.activeVoiceLineTurnId) return;
    const clean = text.trim();
    if (!clean) return;
    this.activeVoiceLineRecorded = true;
    this.assistant.voiceLine("assistant", interrupted ? `${clean}…` : clean, this.activeVoiceLineTurnId);
  }

  private estimateSpokenPrefix(): string {
    const full = this.activeText.trim();
    if (!full) return "";
    if (this.activeTotalChunks <= 0 || this.activePlayedChunks >= this.activeTotalChunks) return full;
    if (this.activePlayedChunks <= 0) {
      // At least a short opening phrase may already be heard while chunk 0 is mid-play.
      const chars = Array.from(full);
      return chars.slice(0, Math.max(1, Math.min(chars.length, Math.ceil(chars.length * 0.25)))).join("");
    }
    const ratio = Math.min(1, this.activePlayedChunks / this.activeTotalChunks);
    const chars = Array.from(full);
    return chars.slice(0, Math.max(1, Math.round(chars.length * ratio))).join("");
  }

  private finishPlayback(runId: string, stopped: boolean): void {
    if (runId !== this.activeRunId) return;
    this.clearPlaybackTimer();
    if (!stopped && this.activeAudible) {
      this.recordSpokenLine(this.activeText, false);
    }
    this.activeRunId = null;
    this.activeTurnId = null;
    this.activeText = "";
    this.activeAudible = false;
    this.activeVoiceLineTurnId = null;
    this.activeVoiceLineRecorded = false;
    this.activeTotalChunks = 0;
    this.activePlayedChunks = 0;
    this.activeSentMs = 0;
    this.activeStreamingDone = false;
    this.drainPendingNotice();
  }

  private drainPendingNotice(): void {
    if (this.ended || this.userSpeaking || this.activeAbort || this.activeRunId || !this.pendingNotices.length) return;
    const nextLine = this.pendingNotices.shift()!;
    const noticeEpoch = ++this.epoch;
    this.turnChain = this.turnChain.then(() => this.speakNotice(nextLine, noticeEpoch)).catch(() => {});
  }

  private interruptActiveTurn(): void {
    this.epoch++;
    if (!this.activeAbort && !this.activeRunId) return;
    const runId = this.activeRunId;
    const turnId = this.activeTurnId ?? String(this.turnSeq);
    const voiceReqId = this.activeVoiceReqId;
    const wasAudible = this.activeAudible;
    const partialText = wasAudible ? this.estimateSpokenPrefix() : "";
    if (wasAudible && partialText) {
      this.recordSpokenLine(partialText, true);
    }
    this.clearPlaybackTimer();
    this.activeAbort?.abort();
    this.activeAbort = null;
    this.activeRunId = null;
    this.activeTurnId = null;
    this.activeVoiceReqId = null;
    this.activeText = "";
    this.activeAudible = false;
    this.activeVoiceLineTurnId = null;
    this.activeVoiceLineRecorded = false;
    this.activeTotalChunks = 0;
    this.activePlayedChunks = 0;
    this.activeSentMs = 0;
    this.activeStreamingDone = false;

    if (runId) {
      this.toPhone({ action: "response.audio.stop", data: { run_id: runId, turn_id: turnId, reason: "interrupted" } });
      if (wasAudible) {
        this.toPhone({ action: "response.interrupted", data: { run_id: runId, turn_id: turnId, text: partialText } });
      }
    }
    if (this.hostId && voiceReqId) {
      void this.assistant.callVoiceHost(this.hostId, "voice.cancel", { requestId: voiceReqId }, 5_000).catch(() => {});
    }
  }

  private async handleUtterance(turnNum: number, pcm: Buffer, myEpoch: number): Promise<void> {
    if (this.ended || !this.hostId || myEpoch !== this.epoch) return;
    const ac = new AbortController();
    const runId = randomUUID();
    const turnKey = String(turnNum);
    const voiceLineTurnId = `${this.id}-${turnNum}`;
    const asrReqId = randomUUID().toLowerCase();
    this.clearPlaybackTimer();
    this.activeAbort = ac;
    this.activeRunId = runId;
    this.activeTurnId = turnKey;
    this.activeVoiceReqId = asrReqId;
    this.activeText = "";
    this.activeAudible = false;
    this.activeVoiceLineTurnId = voiceLineTurnId;
    this.activeVoiceLineRecorded = false;
    this.activeTotalChunks = 0;
    this.activePlayedChunks = 0;
    this.activeSentMs = 0;
    this.activeStreamingDone = false;

    let taskId: string | null = null;
    let lastStep = "";
    try {
      const asr = await this.assistant.callVoiceHost(
        this.hostId,
        "voice.transcribe",
        { requestId: asrReqId, audioBase64: pcm.toString("base64"), sampleRate: INPUT_SAMPLE_RATE },
        60_000,
      );
      if (this.ended || ac.signal.aborted || myEpoch !== this.epoch || asr.cancelled) return;

      const userText = asr.text.trim();
      this.toPhone({ action: "input.transcript.done", data: { text: userText, turn: turnNum } });
      if (!userText) return;

      const reply = await this.assistant.speakTurn(userText, {
        turnId: voiceLineTurnId,
        signal: ac.signal,
        deferRecord: true,
        onStep: (step) => {
          if (this.ended || ac.signal.aborted || myEpoch !== this.epoch) return;
          taskId ??= randomUUID();
          lastStep = step;
          this.toPhone({ action: "relay.task", data: { id: taskId, title: step, status: "running" } });
        },
      });
      if (taskId) {
        this.toPhone({ action: "relay.task", data: { id: taskId, title: lastStep || "好了", status: "done" } });
        taskId = null;
      }
      if (this.ended || ac.signal.aborted || myEpoch !== this.epoch || !reply.trim()) return;

      await this.speakReply(reply.trim(), runId, turnKey, ac.signal, myEpoch);
      if (!this.ended && !ac.signal.aborted && myEpoch === this.epoch) {
        this.toPhone({ action: "response.ended", data: { run_id: runId, turn_id: turnKey, status: "completed" } });
        if (!this.activeAudible) {
          this.recordSpokenLine(reply.trim(), false);
        }
      }
    } catch (e) {
      if (taskId) {
        this.toPhone({ action: "relay.task", data: { id: taskId, title: lastStep || "没成", status: "failed" } });
      }
      if (!this.ended && !ac.signal.aborted && myEpoch === this.epoch) {
        this.log(`local-call: error ${(e as Error).message}`);
        this.toPhone({ action: "error", data: { error: { code: "local_voice_failed" } } });
      }
    } finally {
      if (this.activeAbort === ac) {
        this.activeAbort = null;
        this.activeVoiceReqId = null;
        if (this.activeRunId === runId && this.activeAudible && !this.ended && !ac.signal.aborted && myEpoch === this.epoch) {
          // Keep run armed for barge-in until phone sends `playback.completed` (or estimated playback duration + slack).
          this.activeStreamingDone = true;
          const waitMs = Math.min(60_000, Math.max(1500, Math.ceil(this.activeSentMs) + 1500));
          this.clearPlaybackTimer();
          this.playbackTimer = setTimeout(() => this.finishPlayback(runId, false), waitMs);
        } else if (this.activeRunId === runId) {
          this.finishPlayback(runId, ac.signal.aborted);
        }
      }
      this.drainPendingNotice();
    }
  }

  private async speakReply(text: string, runId: string, turnKey: string, signal: AbortSignal, myEpoch: number): Promise<void> {
    if (!this.hostId) return;
    const sentences = splitSpeakableSentences(text);
    let chunkSeq = 0;
    let audioStarted = false;
    let spokenSoFar = "";

    for (const sentence of sentences) {
      if (this.ended || signal.aborted || myEpoch !== this.epoch) return;
      const ttsReqId = randomUUID().toLowerCase();
      this.activeVoiceReqId = ttsReqId;

      const res = await this.assistant.callVoiceHost(
        this.hostId,
        "voice.synthesize",
        {
          requestId: ttsReqId,
          text: sentence,
          ...(typeof this.cfg.speed === "number" ? { speed: this.cfg.speed } : {}),
        },
        90_000,
      );
      if (this.ended || signal.aborted || myEpoch !== this.epoch || res.cancelled) return;

      spokenSoFar = spokenSoFar ? `${spokenSoFar}${sentence}` : sentence;
      this.activeText = spokenSoFar;
      if (!audioStarted && res.chunksBase64.length > 0) {
        audioStarted = true;
        this.activeAudible = true;
        this.toPhone({ action: "response.audio.started", data: { run_id: runId, turn_id: turnKey } });
      }
      this.toPhone({ action: "output.transcript.updated", data: { text: spokenSoFar, run_id: runId, turn_id: turnKey } });

      const rate = typeof res.sampleRate === "number" && res.sampleRate > 0 ? res.sampleRate : OUTPUT_SAMPLE_RATE;
      for (const b64 of res.chunksBase64) {
        if (this.ended || signal.aborted || myEpoch !== this.epoch || this.phone.readyState !== WebSocket.OPEN) return;
        const pcmBuf = Buffer.from(b64, "base64");
        this.activeTotalChunks++;
        this.activeSentMs += (pcmBuf.length / 2 / rate) * 1000;
        this.toPhone({ action: "response.audio.context", data: { chunk_id: `${runId}-${chunkSeq++}`, run_id: runId, turn_id: turnKey } });
        this.phone.send(pcmBuf, { binary: true });
      }
    }

    if (this.ended || signal.aborted || myEpoch !== this.epoch) return;
    this.toPhone({ action: "output.transcript.done", data: { text, run_id: runId, turn_id: turnKey } });
    if (audioStarted) {
      this.toPhone({ action: "response.audio.done", data: { run_id: runId, turn_id: turnKey } });
    }
  }

  private async speakNotice(line: string, myEpoch: number): Promise<void> {
    if (this.ended || !this.ready || !this.hostId || myEpoch !== this.epoch) return;
    const ac = new AbortController();
    const runId = randomUUID();
    const turnKey = `n-${++this.turnSeq}`;
    this.clearPlaybackTimer();
    this.activeAbort = ac;
    this.activeRunId = runId;
    this.activeTurnId = turnKey;
    this.activeText = "";
    this.activeAudible = false;
    this.activeVoiceLineTurnId = null;
    this.activeVoiceLineRecorded = true;
    this.activeTotalChunks = 0;
    this.activePlayedChunks = 0;
    this.activeSentMs = 0;
    this.activeStreamingDone = false;
    try {
      await this.speakReply(line, runId, turnKey, ac.signal, myEpoch);
      if (!this.ended && !ac.signal.aborted && myEpoch === this.epoch) {
        this.toPhone({ action: "response.ended", data: { run_id: runId, turn_id: turnKey, status: "completed" } });
      }
    } finally {
      if (this.activeAbort === ac) {
        this.activeAbort = null;
        this.activeVoiceReqId = null;
        if (this.activeRunId === runId && this.activeAudible && !this.ended && !ac.signal.aborted && myEpoch === this.epoch) {
          this.activeStreamingDone = true;
          const waitMs = Math.min(60_000, Math.max(1500, Math.ceil(this.activeSentMs) + 1500));
          this.clearPlaybackTimer();
          this.playbackTimer = setTimeout(() => this.finishPlayback(runId, false), waitMs);
        } else if (this.activeRunId === runId) {
          this.finishPlayback(runId, ac.signal.aborted);
        }
      }
      this.drainPendingNotice();
    }
  }

  private onNotice(n: Notice): void {
    if (!this.ready || this.ended) return;
    const line = n.body.startsWith("到点了") ? n.body : `对了，${n.body}`;
    const busy = this.userSpeaking || !!this.activeAbort || !!this.activeRunId;
    this.toPhone({ action: "relay.notice", data: { id: n.id, line, how: busy ? "next" : "now" } });
    if (busy) {
      this.pendingNotices = [...this.pendingNotices, line].slice(-3);
      return;
    }
    const myEpoch = ++this.epoch;
    this.turnChain = this.turnChain.then(() => this.speakNotice(line, myEpoch)).catch(() => {});
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
    this.detach();
    this.epoch++;
    this.clearPlaybackTimer();
    if (this.activeAudible && !this.activeVoiceLineRecorded) {
      this.recordSpokenLine(this.estimateSpokenPrefix(), !this.activeStreamingDone);
    }
    this.activeAbort?.abort();
    this.activeAbort = null;
    this.activeRunId = null;
    this.activeAudible = false;
    this.toPhone({ action: "relay.state", data: { state: "closed", message: why } });
    try {
      this.phone.close(1000, "call ended");
    } catch {}
    if (this.hostId) {
      void this.assistant.callVoiceHost(this.hostId, "voice.release", {}, 10_000).catch(() => {});
    }
    this.log(`local-call: ended (${why}) ${this.deviceId}`);
  }
}
