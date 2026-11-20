import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { lineSplitter } from "./util.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const WORKER_READY_TIMEOUT_MS = 20_000;
const WARMUP_TIMEOUT_MS = 90_000;
const TRANSCRIBE_TIMEOUT_MS = 60_000;
const SYNTHESIZE_TIMEOUT_MS = 90_000;
const OUTPUT_SAMPLE_RATE = 48_000;

export interface LocalVoiceOptions {
  pythonBin: string;
  gptSovitsDir: string;
  sovitsWeightsPath: string;
  gptWeightsPath: string;
  refAudioPath: string;
  refText: string;
  refLang?: string;
  textLang?: string;
  device?: string;
  idleTimeoutMs?: number;
  workerScript?: string;
  asrModel?: string;
  vadModel?: string;
  puncModel?: string;
  enable?: boolean;
}

interface QueuedTask {
  id: string;
  cmd: "warmup" | "transcribe" | "synthesize";
  requestId?: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
  cancelled: boolean;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

const DEFAULT_WORKER_SCRIPT = fileURLToPath(new URL("../integrations/local-voice/worker.py", import.meta.url));

/** Manages the on-demand Python GPU worker for local ASR + GPT-SoVITS TTS. */
export class LocalVoiceBridge {
  private readonly options: LocalVoiceOptions;
  private readonly workerScript: string;
  private readonly idleTimeoutMs: number;
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private readyPromise: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private queue: QueuedTask[] = [];
  private activeTask: QueuedTask | null = null;
  private activeRpcReject: ((err: Error) => void) | null = null;
  private pendingRpc = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private cancelledIds = new Set<string>();
  private processing = false;
  private closed = false;

  constructor(options: LocalVoiceOptions) {
    this.options = options;
    this.workerScript = options.workerScript ?? DEFAULT_WORKER_SCRIPT;
    this.idleTimeoutMs =
      typeof options.idleTimeoutMs === "number" && Number.isFinite(options.idleTimeoutMs) && options.idleTimeoutMs >= 0
        ? options.idleTimeoutMs
        : DEFAULT_IDLE_TIMEOUT_MS;
  }

  get enabled(): boolean {
    if (this.closed || this.options.enable === false) return false;
    if (!this.options.pythonBin || !existsSync(this.options.pythonBin)) return false;
    if (/\.(?:mjs|js|cjs)$/i.test(this.options.pythonBin)) return true;
    return existsSync(this.workerScript);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleKill(): void {
    this.clearIdleTimer();
    if (this.closed || !this.child || this.activeTask || this.queue.length > 0 || this.idleTimeoutMs === 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.activeTask && this.queue.length === 0) {
        this.killWorker();
      }
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private killWorker(): void {
    this.clearIdleTimer();
    const child = this.child;
    this.child = null;
    this.readyPromise = null;
    for (const [id, p] of this.pendingRpc) {
      clearTimeout(p.timer);
      p.reject(new Error("local-voice worker stopped"));
      this.pendingRpc.delete(id);
    }
    this.activeRpcReject = null;
    if (child) {
      try { child.stdin.end(); } catch {}
      const killer = setTimeout(() => {
        try { child.kill(); } catch {}
      }, 250);
      killer.unref?.();
    }
  }

  private ensureWorker(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("local-voice bridge closed"));
    if (this.child && this.readyPromise) return this.readyPromise;
    if (!this.enabled) return Promise.reject(new Error("本地语音工作进程未配置或缺少运行文件。"));

    const configJson = JSON.stringify({
      gptSovitsDir: this.options.gptSovitsDir,
      sovitsWeightsPath: this.options.sovitsWeightsPath,
      gptWeightsPath: this.options.gptWeightsPath,
      refAudioPath: this.options.refAudioPath,
      refText: this.options.refText,
      refLang: this.options.refLang ?? "zh",
      textLang: this.options.textLang ?? "zh",
      device: this.options.device ?? "cuda",
      ...(this.options.asrModel ? { asrModel: this.options.asrModel } : {}),
      ...(this.options.vadModel ? { vadModel: this.options.vadModel } : {}),
      ...(this.options.puncModel ? { puncModel: this.options.puncModel } : {}),
    });

    const isNode = /\.(?:mjs|js|cjs)$/i.test(this.options.pythonBin);
    const cmd = isNode ? process.execPath : this.options.pythonBin;
    const args = isNode ? [this.options.pythonBin] : ["-u", this.workerScript];
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", LOCAL_VOICE_CONFIG_JSON: configJson },
    });
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {});
    this.child = child;

    const ready = new Promise<void>((resolveReady, rejectReady) => {
      let settledReady = false;
      const readyTimer = setTimeout(() => {
        if (settledReady) return;
        settledReady = true;
        rejectReady(new Error("local-voice worker ready timeout"));
        if (this.child === child) this.killWorker();
      }, WORKER_READY_TIMEOUT_MS);
      readyTimer.unref?.();

      const finishReady = (err?: Error) => {
        if (settledReady) return;
        settledReady = true;
        clearTimeout(readyTimer);
        if (err) rejectReady(err);
        else resolveReady();
      };

      child.stdout.on("data", lineSplitter((line) => {
        let packet: Record<string, unknown>;
        try { packet = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        if (packet.type === "ready") {
          finishReady();
          return;
        }
        const id = packet.id;
        if (typeof id === "string" && this.pendingRpc.has(id)) {
          const entry = this.pendingRpc.get(id)!;
          this.pendingRpc.delete(id);
          clearTimeout(entry.timer);
          if (packet.ok === false) {
            entry.reject(new Error(typeof packet.error === "string" ? packet.error : "local-voice worker failed"));
          } else {
            entry.resolve(packet);
          }
        }
      }));

      child.on("error", (err) => {
        finishReady(err);
        if (this.child === child) this.killWorker();
      });

      child.on("exit", () => {
        finishReady(new Error("local-voice worker exited"));
        if (this.child === child) this.killWorker();
      });
    });

    this.readyPromise = ready;
    return ready;
  }

  private writeRpc(id: string, cmd: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child || !child.stdin.writable) return Promise.reject(new Error("local-voice worker unavailable"));
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        rejectCall(new Error(`local-voice ${cmd} timeout`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRpc.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
    });
  }

  private cancelledResult(task: QueuedTask): unknown {
    if (task.cmd === "transcribe") return { text: "", cancelled: true };
    if (task.cmd === "synthesize") return { sampleRate: OUTPUT_SAMPLE_RATE, chunksBase64: [], cancelled: true };
    return { ready: false };
  }

  private enqueue<T>(cmd: QueuedTask["cmd"], payload: Record<string, unknown>, timeoutMs: number, requestId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("local-voice bridge closed"));
    if (requestId && this.cancelledIds.has(requestId)) {
      this.cancelledIds.delete(requestId);
      const dummy = { cmd } as QueuedTask;
      return Promise.resolve(this.cancelledResult(dummy) as T);
    }
    this.clearIdleTimer();
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id: randomUUID(),
        cmd,
        requestId,
        payload,
        timeoutMs,
        cancelled: false,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const task = this.queue.shift()!;
        if (task.cancelled || (task.requestId && this.cancelledIds.has(task.requestId))) {
          if (task.requestId) this.cancelledIds.delete(task.requestId);
          task.resolve(this.cancelledResult(task));
          continue;
        }
        this.activeTask = task;
        try {
          await this.ensureWorker();
          if (task.cancelled || (task.requestId && this.cancelledIds.has(task.requestId))) {
            if (task.requestId) this.cancelledIds.delete(task.requestId);
            task.resolve(this.cancelledResult(task));
            continue;
          }
          const rpcPromise = this.writeRpc(task.id, task.cmd, task.payload, task.timeoutMs);
          const abortPromise = new Promise<never>((_, rejectAbort) => {
            this.activeRpcReject = rejectAbort;
          });
          const res = await Promise.race([rpcPromise, abortPromise]);
          if (task.cmd === "warmup") {
            task.resolve({ ready: true });
          } else if (task.cmd === "transcribe") {
            task.resolve({
              text: typeof res.text === "string" ? res.text : "",
              ...(res.cancelled === true ? { cancelled: true } : {}),
            });
          } else {
            const chunks = Array.isArray(res.chunksBase64) ? res.chunksBase64.filter((c): c is string => typeof c === "string") : [];
            task.resolve({
              sampleRate: typeof res.sampleRate === "number" ? res.sampleRate : OUTPUT_SAMPLE_RATE,
              chunksBase64: chunks,
              ...(res.cancelled === true ? { cancelled: true } : {}),
            });
          }
        } catch (err) {
          if (task.cancelled) task.resolve(this.cancelledResult(task));
          else task.reject(err as Error);
        } finally {
          if (task.requestId) this.cancelledIds.delete(task.requestId);
          this.activeRpcReject = null;
          this.activeTask = null;
        }
      }
    } finally {
      this.processing = false;
      this.scheduleIdleKill();
    }
  }

  async warmup(): Promise<{ ready: boolean }> {
    return this.enqueue("warmup", {}, WARMUP_TIMEOUT_MS);
  }

  async transcribe(input: { requestId: string; audioBase64: string; sampleRate: number }): Promise<{ text: string; cancelled?: boolean }> {
    return this.enqueue(
      "transcribe",
      { requestId: input.requestId, audioBase64: input.audioBase64, sampleRate: input.sampleRate },
      TRANSCRIBE_TIMEOUT_MS,
      input.requestId,
    );
  }

  async synthesize(input: { requestId: string; text: string; speed?: number }): Promise<{ sampleRate: number; chunksBase64: string[]; cancelled?: boolean }> {
    return this.enqueue(
      "synthesize",
      {
        requestId: input.requestId,
        text: input.text,
        ...(typeof input.speed === "number" ? { speed: input.speed } : {}),
      },
      SYNTHESIZE_TIMEOUT_MS,
      input.requestId,
    );
  }

  async cancel(requestId?: string): Promise<{ cancelled: boolean }> {
    let hit = false;
    if (requestId) this.cancelledIds.add(requestId);
    for (const item of this.queue) {
      if (!requestId || item.requestId === requestId) {
        item.cancelled = true;
        hit = true;
      }
    }
    if (this.activeTask && (!requestId || this.activeTask.requestId === requestId)) {
      this.activeTask.cancelled = true;
      hit = true;
      if (this.child && this.child.stdin.writable) {
        try {
          this.child.stdin.write(`${JSON.stringify({ id: randomUUID(), cmd: "cancel", ...(requestId ? { requestId } : {}) })}\n`);
        } catch {}
      }
    }
    return { cancelled: hit };
  }

  async release(): Promise<{ released: boolean }> {
    for (const item of this.queue) item.cancelled = true;
    if (this.activeTask) {
      this.activeTask.cancelled = true;
      this.activeRpcReject?.(new Error("local-voice released"));
    }
    this.cancelledIds.clear();
    this.killWorker();
    return { released: true };
  }

  close(): void {
    this.closed = true;
    for (const item of this.queue.splice(0)) {
      item.reject(new Error("local-voice bridge closed"));
    }
    if (this.activeTask) {
      this.activeTask.cancelled = true;
      this.activeRpcReject?.(new Error("local-voice bridge closed"));
    }
    this.cancelledIds.clear();
    this.killWorker();
  }
}
