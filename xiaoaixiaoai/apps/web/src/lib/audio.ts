import { toWsUrl } from "./relay-ws";

/** Convert Float32 [-1, 1] at sourceRate to 16 kHz mono PCM16LE bytes. */
export function downsampleToPcm16k(input: Float32Array, sourceRate: number, targetRate = 16_000): Int16Array {
  if (sourceRate === targetRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]!));
      out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    }
    return out;
  }
  const ratio = sourceRate / targetRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += input[j]!;
      count++;
    }
    const sample = count > 0 ? sum / count : input[start] ?? 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }
  return out;
}

export function pcm16ToFloat32(pcmBytes: Uint8Array): Float32Array {
  const sampleCount = Math.floor(pcmBytes.byteLength / 2);
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, sampleCount * 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function rmsLevel(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i]! / 32768;
    sum += s * s;
  }
  return Math.min(1, Math.sqrt(sum / pcm.length) * 4);
}

/**
 * Gapless PCM16LE stream player powered by Web Audio API.
 * Used both for chat TTS (`assistant_speech`) and live voice calls (`/v1/assistant/live`).
 */
export class PcmStreamPlayer {
  private ctx: AudioContext | null = null;
  private nextTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private currentTag: string | null = null;
  private sampleRate = 48_000;
  private pendingDone = false;
  private onDrained?: (tag: string) => void;

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  unlock(): void {
    this.ensureContext();
  }

  start(tag: string, sampleRate = 48_000, onDrained?: (tag: string) => void): void {
    this.stop();
    this.currentTag = tag;
    this.sampleRate = sampleRate > 0 ? sampleRate : 48_000;
    this.pendingDone = false;
    this.onDrained = onDrained;
    const ctx = this.ensureContext();
    this.nextTime = ctx.currentTime + 0.03;
  }

  feedBytes(tag: string, pcmBytes: Uint8Array, onEnded?: () => void): void {
    if (this.currentTag !== tag) return;
    if (pcmBytes.byteLength < 2) return;
    const ctx = this.ensureContext();
    const floats = pcm16ToFloat32(pcmBytes);
    const buf = ctx.createBuffer(1, floats.length, this.sampleRate);
    buf.getChannelData(0).set(floats);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    const startAt = Math.max(now + 0.015, this.nextTime);
    this.nextTime = startAt + buf.duration;
    this.activeSources.add(src);
    src.onended = () => {
      this.activeSources.delete(src);
      onEnded?.();
      if (this.currentTag === tag && this.pendingDone && this.activeSources.size === 0) {
        const cb = this.onDrained;
        this.currentTag = null;
        this.pendingDone = false;
        cb?.(tag);
      }
    };
    src.start(startAt);
  }

  finish(tag: string): void {
    if (this.currentTag !== tag) return;
    this.pendingDone = true;
    if (this.activeSources.size === 0) {
      const cb = this.onDrained;
      this.currentTag = null;
      this.pendingDone = false;
      cb?.(tag);
    }
  }

  stop(onlyTag?: string | null): void {
    if (onlyTag && this.currentTag && this.currentTag !== onlyTag) return;
    this.currentTag = null;
    this.pendingDone = false;
    for (const src of this.activeSources) {
      src.onended = null;
      try {
        src.stop();
      } catch {}
    }
    this.activeSources.clear();
    if (this.ctx && this.ctx.state !== "closed") {
      this.nextTime = this.ctx.currentTime;
    }
  }
}

/** One-shot push-to-talk recorder capturing 16 kHz mono PCM16LE for `/v1/assistant/voice`. */
export class VoiceNoteRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Int16Array[] = [];
  private totalSamples = 0;
  private startedAt = 0;

  async start(onLevel: (level: number) => void): Promise<void> {
    this.cancel();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前浏览器不支持麦克风采集（请确认使用 HTTPS 或 localhost）");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    this.stream = stream;
    this.ctx = ctx;
    this.source = source;
    this.processor = processor;
    this.chunks = [];
    this.totalSamples = 0;
    this.startedAt = Date.now();

    processor.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      const pcm = downsampleToPcm16k(input, ctx.sampleRate, 16_000);
      this.chunks.push(pcm);
      this.totalSamples += pcm.length;
      onLevel(rmsLevel(pcm));
    };
    source.connect(processor);
    processor.connect(ctx.destination);
  }

  stop(): { audioBase64: string; sampleRate: number; durationMs: number } {
    const durationMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const merged = new Int16Array(this.totalSamples);
    let offset = 0;
    for (const c of this.chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    this.cleanup();
    const bytes = new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
    return { audioBase64: bytesToBase64(bytes), sampleRate: 16_000, durationMs };
  }

  cancel(): void {
    this.cleanup();
  }

  private cleanup(): void {
    try { this.processor?.disconnect(); } catch {}
    try { this.source?.disconnect(); } catch {}
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { void this.ctx?.close(); } catch {}
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
    this.chunks = [];
    this.totalSamples = 0;
    this.startedAt = 0;
  }
}

export type LiveCallStatus = "idle" | "connecting" | "ready" | "ended";
export type LiveCallPhase = "connecting" | "speaking" | "thinking" | "muted" | "listening" | "idle";

export interface LiveCallLine {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
}

export interface LiveCallSnapshot {
  status: LiveCallStatus;
  phase: LiveCallPhase;
  muted: boolean;
  level: number;
  startedAt: number | null;
  message: string | null;
  task: { id: string; title: string } | null;
  lines: LiveCallLine[];
}

interface AudioRef {
  chunkId: string;
  runId: string;
  turnId: string;
}

/** Full-duplex real-time voice call over `/v1/assistant/live` using Web Audio API. */
export class WebLiveCall {
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private micCtx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private player = new PcmStreamPlayer();
  private contexts: AudioRef[] = [];
  private activeRunId: string | null = null;
  private activeTurnId = "";
  private activeSampleRate = 48_000;
  private residual = new Uint8Array(0);
  private muted = false;
  private ready = false;
  private speaking = false;
  private listening = false;
  private waiting = false;
  private ended = false;
  private startedAt: number | null = null;
  private message: string | null = null;
  private task: { id: string; title: string } | null = null;
  private lines: LiveCallLine[] = [];
  private level = 0;
  private readonly onChange: (snap: LiveCallSnapshot) => void;

  constructor(onChange: (snap: LiveCallSnapshot) => void) {
    this.onChange = onChange;
  }

  private emit(statusOverride?: LiveCallStatus): void {
    const status: LiveCallStatus = statusOverride ?? (this.ended ? "ended" : this.ready ? "ready" : "connecting");
    const phase: LiveCallPhase =
      status === "connecting"
        ? "connecting"
        : this.speaking
          ? "speaking"
          : this.task || this.waiting
            ? "thinking"
            : this.muted
              ? "muted"
              : this.listening
                ? "listening"
                : "idle";
    this.onChange({
      status,
      phase,
      muted: this.muted,
      level: this.level,
      startedAt: this.startedAt,
      message: this.message,
      task: this.task,
      lines: this.lines.slice(-24),
    });
  }

  private upsertLine(line: LiveCallLine): void {
    const idx = this.lines.findIndex((x) => x.id === line.id);
    if (idx >= 0) {
      const next = this.lines.slice();
      next[idx] = line;
      this.lines = next;
    } else {
      this.lines = [...this.lines, line].slice(-24);
    }
  }

  async start(server: string, token: string): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前浏览器不支持麦克风权限（请使用 HTTPS 或 localhost 访问）");
    }
    this.ended = false;
    this.ready = false;
    this.muted = false;
    this.speaking = false;
    this.listening = false;
    this.waiting = false;
    this.startedAt = null;
    this.message = null;
    this.task = null;
    this.lines = [];
    this.contexts = [];
    this.player.unlock();
    this.emit("connecting");

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const micCtx = new AC();
    const source = micCtx.createMediaStreamSource(stream);
    const processor = micCtx.createScriptProcessor(2048, 1, 1);
    this.stream = stream;
    this.micCtx = micCtx;
    this.source = source;
    this.processor = processor;

    const ws = new WebSocket(toWsUrl(server, `/v1/assistant/live?token=${encodeURIComponent(token)}`));
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    processor.onaudioprocess = (ev) => {
      if (this.ended || !this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const input = ev.inputBuffer.getChannelData(0);
      const pcm = downsampleToPcm16k(input, micCtx.sampleRate, 16_000);
      this.level = this.muted ? 0 : rmsLevel(pcm);
      const bytes = this.muted ? new Uint8Array(pcm.byteLength) : new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      const merged = new Uint8Array(this.residual.length + bytes.length);
      merged.set(this.residual, 0);
      merged.set(bytes, this.residual.length);
      let off = 0;
      const frameSize = 1280; // 40ms @ 16kHz PCM16
      while (off + frameSize <= merged.length) {
        this.ws.send(merged.subarray(off, off + frameSize));
        off += frameSize;
      }
      this.residual = merged.subarray(off);
      this.emit();
    };
    source.connect(processor);
    processor.connect(micCtx.destination);

    ws.onmessage = (ev) => {
      if (this.ended) return;
      if (ev.data instanceof ArrayBuffer) {
        const ref = this.contexts.shift();
        if (!ref) return;
        const pcm = new Uint8Array(ev.data);
        if (this.activeRunId !== ref.runId) {
          this.activeRunId = ref.runId;
          this.activeTurnId = ref.turnId;
          this.player.start(ref.runId, this.activeSampleRate, (doneRun) => {
            if (this.activeRunId === doneRun) {
              this.speaking = false;
              this.sendJson({ action: "playback.completed", run_id: doneRun, turn_id: this.activeTurnId });
              this.emit();
            }
          });
        }
        this.speaking = true;
        this.player.feedBytes(ref.runId, pcm, () => {
          this.sendJson({
            action: "playback.chunk.completed",
            chunk_id: ref.chunkId,
            run_id: ref.runId,
            turn_id: ref.turnId,
          });
        });
        this.emit();
        return;
      }
      if (typeof ev.data !== "string") return;
      let msg: { action?: string; data?: Record<string, unknown> };
      try {
        msg = JSON.parse(ev.data) as { action?: string; data?: Record<string, unknown> };
      } catch {
        return;
      }
      const d = msg.data ?? {};
      switch (msg.action) {
        case "media.output.configured":
          if (typeof d.sample_rate === "number" && d.sample_rate > 0) this.activeSampleRate = d.sample_rate;
          break;
        case "relay.state":
          if (d.state === "ready") {
            this.ready = true;
            this.startedAt = Date.now();
            this.sendJson({ action: "mic_state", enabled: !this.muted });
            this.emit("ready");
          } else if (d.state === "error" || d.state === "closed") {
            this.close(typeof d.message === "string" && d.message ? d.message : "通话结束了");
          }
          break;
        case "input.speech.started":
          this.waiting = false;
          this.listening = true;
          this.emit();
          break;
        case "input.speech.stopped":
          this.listening = false;
          this.emit();
          break;
        case "input.transcript.done": {
          const text = typeof d.text === "string" ? d.text.trim() : "";
          if (text) {
            this.upsertLine({ id: `u:${String(d.turn ?? Date.now())}`, role: "user", text, final: true });
            this.waiting = true;
          }
          this.emit();
          break;
        }
        case "output.transcript.updated":
        case "output.transcript.done": {
          const text = typeof d.text === "string" ? d.text.trim() : "";
          if (text) {
            this.upsertLine({
              id: `a:${String(d.run_id ?? d.turn_id ?? "cur")}`,
              role: "assistant",
              text,
              final: msg.action === "output.transcript.done",
            });
            this.emit();
          }
          break;
        }
        case "response.audio.started":
          this.waiting = false;
          this.speaking = true;
          this.emit();
          break;
        case "response.audio.context":
          this.contexts.push({
            chunkId: String(d.chunk_id ?? ""),
            runId: String(d.run_id ?? ""),
            turnId: String(d.turn_id ?? ""),
          });
          break;
        case "response.audio.done": {
          const runId = String(d.run_id ?? "");
          if (runId && this.activeRunId === runId) {
            this.player.finish(runId);
          }
          break;
        }
        case "response.audio.stop": {
          const runId = String(d.run_id ?? "");
          this.contexts = this.contexts.filter((c) => c.runId !== runId);
          this.player.stop(runId || null);
          this.speaking = false;
          if (runId) {
            this.sendJson({ action: "playback.stopped", run_id: runId, turn_id: String(d.turn_id ?? ""), reason: String(d.reason ?? "interrupted") });
          }
          this.emit();
          break;
        }
        case "response.interrupted": {
          const id = `a:${String(d.run_id ?? d.turn_id ?? "cur")}`;
          const text = typeof d.text === "string" ? d.text.trim() : "";
          if (text) this.upsertLine({ id, role: "assistant", text: `${text}…`, final: true });
          this.speaking = false;
          this.emit();
          break;
        }
        case "response.ended":
          this.waiting = false;
          this.emit();
          break;
        case "relay.task":
          this.task = d.status === "running" ? { id: String(d.id ?? ""), title: String(d.title ?? "处理中") } : null;
          this.emit();
          break;
        case "error": {
          const err = d.error as { code?: string } | undefined;
          this.message = `语音服务提示：${err?.code ?? "未知错误"}`;
          this.emit();
          break;
        }
      }
    };

    ws.onerror = () => {
      if (!this.ended) this.close("语音连接异常");
    };

    ws.onclose = () => {
      if (!this.ended) this.close("通话已结束");
    };
  }

  setMuted(next: boolean): void {
    this.muted = next;
    if (this.ready) this.sendJson({ action: "mic_state", enabled: !next });
    this.emit();
  }

  hangup(): void {
    this.sendJson({ action: "relay.hangup" });
    this.close("已挂断");
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private close(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.ready = false;
    this.speaking = false;
    this.listening = false;
    this.waiting = false;
    this.level = 0;
    this.message = reason;
    this.player.stop();
    try { this.processor?.disconnect(); } catch {}
    try { this.source?.disconnect(); } catch {}
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { void this.micCtx?.close(); } catch {}
    try { this.ws?.close(1000, "bye"); } catch {}
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.micCtx = null;
    this.ws = null;
    this.emit("ended");
  }
}
