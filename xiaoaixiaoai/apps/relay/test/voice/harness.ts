/**
 * Voice smoothness harness. No real voice service: a fake MOSS-Live streams
 * 48 kHz PCM replies through a real relay to a fake phone, with modelled
 * generation burstiness and network jitter. The phone records when each
 * piece of audio reached it; the old and new speaker logic (playout.ts) are
 * then scored on the very same arrivals.
 *
 *   node apps/relay/test/voice/harness.ts            all scenarios, 2 seeds
 *   node apps/relay/test/voice/harness.ts --quick    1 seed, fewer replies
 *   node apps/relay/test/voice/harness.ts --transport   relay forwarding cost only
 *   --save=calls.json, then --score=calls.json   score saved calls again (HARNESS_PLAYOUT overrides settings)
 *
 * Every timing model here is an assumption, written out below; none of it
 * was measured on the real service.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { deflate } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { Relay } from "../../src/server.ts";
import type { Llm } from "../../src/assistant/llm.ts";
import { LINKS, Link, lognormal, rng, uniform } from "./net.ts";
import { DirectPlayer, JitterPlayer, PER_MS, PLAYOUT, type Arrival, type Piece, type Score, run } from "./playout.ts";

// ---------------------------------------------------------------------------
// How the voice service produces audio (assumptions)
// ---------------------------------------------------------------------------

interface GenProfile {
  name: string;
  /** Reply start (the person stopped) -> first audio generated. */
  firstMs: [number, number];
  /** Chunk lengths to pick from. */
  chunkMs: number[];
  /** Generation speed, times real time: log-normal median and sigma, per chunk. */
  speedMedian: number;
  speedSigma: number;
  /** Chance per chunk that generation pauses, and for how long. */
  hiccupP: number;
  hiccupMs: [number, number];
  /** Sentence-at-a-time TTS: each sentence comes as a fast burst after a synthesis wait. */
  sentence?: { lenMs: [number, number]; waitMs: [number, number] };
}

const GEN: Record<string, GenProfile> = {
  /** A speech model streaming a bit faster than it talks, with the odd pause. */
  stream: { name: "stream", firstMs: [350, 700], chunkMs: [40, 60, 80, 100, 120], speedMedian: 1.4, speedSigma: 0.25, hiccupP: 0.03, hiccupMs: [120, 350] },
  /** Barely faster than real time: every slowdown eats the whole cushion. */
  tight: { name: "tight", firstMs: [350, 700], chunkMs: [40, 60, 80, 100, 120], speedMedian: 1.08, speedSigma: 0.18, hiccupP: 0.05, hiccupMs: [100, 300] },
  /** Sent at the speed it is played (a service pacing audio to playback): the network's jitter is all there is. */
  paced: { name: "paced", firstMs: [350, 700], chunkMs: [40, 60, 80], speedMedian: 1.0, speedSigma: 0.04, hiccupP: 0, hiccupMs: [0, 0] },
  /** Classic TTS: whole sentences at 5x real time, a synthesis wait before each. */
  sentences: { name: "sentences", firstMs: [300, 600], chunkMs: [100], speedMedian: 5, speedSigma: 0, hiccupP: 0, hiccupMs: [0, 0], sentence: { lenMs: [1200, 2600], waitMs: [120, 450] } },
};

interface Scenario {
  name: string;
  gen: string;
  link: string;
}

const SCENARIOS: Scenario[] = [
  { name: "stream / wifi", gen: "stream", link: "wifi" },
  { name: "stream / mobile", gen: "stream", link: "mobile" },
  { name: "tight / wifi", gen: "tight", link: "wifi" },
  { name: "tight / mobile", gen: "tight", link: "mobile" },
  { name: "paced / wifi", gen: "paced", link: "wifi" },
  { name: "paced / mobile", gen: "paced", link: "mobile" },
  { name: "sentences / mobile", gen: "sentences", link: "mobile" },
];

interface Planned {
  at: number;
  msg: { action: string; data: Record<string, unknown> } | null;
  pcm?: Buffer;
  chunk?: string;
}

/** Some speech-like PCM: a few partials under a syllable envelope, plus noise. */
function speechPcm(frames: number, r: () => number, phase: number): Buffer {
  const b = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const t = (phase + i) / 48_000;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
    const v = env * (0.5 * Math.sin(2 * Math.PI * 180 * t) + 0.3 * Math.sin(2 * Math.PI * 360 * t) + 0.2 * Math.sin(2 * Math.PI * 900 * t)) + 0.08 * (r() * 2 - 1);
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 9000), i * 2);
  }
  return b;
}

/** The whole call from the service's side: when each event is generated (ms after the call is ready). */
function plan(gen: GenProfile, seed: number, replies: number): { events: Planned[]; endMs: number; interrupted: string } {
  const r = rng(seed);
  const events: Planned[] = [];
  let start = 1500;
  let phase = 0;
  const interruptAt = replies > 4 ? 3 : -1;
  let interrupted = "";
  for (let k = 0; k < replies; k++) {
    const run = `run-${k}`;
    const turn = `turn-${k}`;
    const d = { run_id: run, turn_id: turn };
    const totalMs = uniform(r, 2500, 6000);
    events.push({ at: start - 1300, msg: { action: "input.speech.started", data: {} } });
    events.push({ at: start - 300, msg: { action: "input.speech.stopped", data: {} } });
    events.push({ at: start - 200, msg: { action: "input.transcript.done", data: { text: `第${k + 1}句`, turn: String(k + 1) } } });
    let t = start + uniform(r, gen.firstMs[0], gen.firstMs[1]);
    events.push({ at: t - 1, msg: { action: "response.audio.started", data: d } });
    let made = 0;
    let n = 0;
    let sentenceLeft = gen.sentence ? uniform(r, gen.sentence.lenMs[0], gen.sentence.lenMs[1]) : Infinity;
    const cutAt = k === interruptAt ? 1500 : Infinity;
    while (made < totalMs && made < cutAt) {
      const ms = Math.min(gen.chunkMs[Math.floor(r() * gen.chunkMs.length)]!, Math.ceil(totalMs - made));
      const speed = gen.speedSigma ? Math.max(0.6, Math.min(4, lognormal(r, gen.speedMedian, gen.speedSigma))) : gen.speedMedian;
      t += ms / speed;
      if (gen.hiccupP && r() < gen.hiccupP) t += uniform(r, gen.hiccupMs[0], gen.hiccupMs[1]);
      const frames = Math.round(ms * PER_MS);
      const chunk = `${run}-c${n++}`;
      events.push({ at: t, msg: { action: "response.audio.context", data: { ...d, chunk_id: chunk } } });
      events.push({ at: t, msg: null, pcm: speechPcm(frames, r, phase), chunk });
      phase += frames;
      made += ms;
      if (n % 6 === 0) events.push({ at: t, msg: { action: "output.transcript.updated", data: { ...d, text: "好的".repeat(n / 6) } } });
      if (gen.sentence) {
        sentenceLeft -= ms;
        if (sentenceLeft <= 0) {
          t += uniform(r, gen.sentence.waitMs[0], gen.sentence.waitMs[1]);
          sentenceLeft = uniform(r, gen.sentence.lenMs[0], gen.sentence.lenMs[1]);
        }
      }
    }
    if (k === interruptAt) {
      // The person talks over the reply: the service stops it.
      interrupted = run;
      events.push({ at: t + 1, msg: { action: "input.speech.started", data: {} } });
      events.push({ at: t + 2, msg: { action: "response.audio.stop", data: { ...d, reason: "interrupted" } } });
      events.push({ at: t + 3, msg: { action: "response.interrupted", data: { ...d, text: "好的" } } });
      events.push({ at: t + 4, msg: { action: "response.ended", data: { ...d, status: "aborted" } } });
    } else {
      events.push({ at: t + 1, msg: { action: "response.audio.done", data: d } });
      events.push({ at: t + 2, msg: { action: "output.transcript.done", data: { ...d, text: "好的。" } } });
      events.push({ at: t + 3, msg: { action: "response.ended", data: { ...d, status: "completed" } } });
    }
    // The next question comes after this answer has been heard (not waiting on receipts).
    start = Math.max(t, start + 700 + made) + uniform(r, 1800, 2600);
  }
  events.sort((a, b) => a.at - b.at);
  return { events, endMs: start, interrupted };
}

/** Runs callbacks at non-decreasing times, strictly in the order given (one WebSocket keeps order). */
class Pipe {
  private q: Array<{ at: number; fn: () => void }> = [];
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  push(at: number, fn: () => void): void {
    if (this.closed) return;
    this.q.push({ at, fn });
    if (this.q.length === 1) this.arm();
  }
  private arm(): void {
    if (this.timer || !this.q.length || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      while (this.q.length && this.q[0]!.at <= this.now() + 0.5) this.q.shift()!.fn();
      this.arm();
    }, Math.max(0, this.q[0]!.at - this.now()));
  }
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.q = [];
  }
}

// ---------------------------------------------------------------------------
// One call through a real relay
// ---------------------------------------------------------------------------

const ADMIN = "harness-admin-token-0123456789";
/** Whether the fake service accepts permessage-deflate (a Python `websockets` server does by default). */
const SERVICE_DEFLATE = process.env.HARNESS_SERVICE_DEFLATE !== "0";
const quietLlm: Llm = async () => ({ content: [{ type: "text", text: "好" }], stopReason: "end_turn", model: "harness" });

async function startRelay(upstreamPort: number) {
  const dir = mkdtempSync(join(tmpdir(), "pocket-voice-harness-"));
  const logs: string[] = [];
  const relay = new Relay({
    dbPath: join(dir, "h.db"),
    adminToken: ADMIN,
    log: (m) => logs.push(m),
    llm: quietLlm,
    live: { url: `ws://127.0.0.1:${upstreamPort}/v1/realtime`, apiKey: "harness-key", model: "moss-live-1.0", refreshGapMs: 0 },
  });
  const base = `http://127.0.0.1:${await relay.listen(0, "127.0.0.1")}`;
  const api = async (path: string, body?: unknown, token?: string) => {
    const res = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return (await res.json()) as any;
  };
  const code = (await api("/v1/pair/codes", { kind: "viewer" }, ADMIN)).code;
  const token = (await api("/v1/pair", { code, name: "Harness Phone", kind: "viewer" })).token as string;
  return {
    relay,
    logs,
    url: `${base.replace("http", "ws")}/v1/assistant/live`,
    token,
    close: async () => {
      await relay.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface CallResult {
  scenario: string;
  seed: number;
  trace: Arrival[];
  /** Relay forwarding: service sent -> phone socket got, per audio chunk. */
  forwardMs: number[];
  serviceQueueMs: number[];
  /** Phone mic frames: lateness against a steady 20 ms clock, at the service. */
  micLateMs: number[];
  micFrames: number;
  /** Binary frames that did not follow their own response.audio.context. */
  pairing: number;
  receipts: { chunks: number; acked: number; expected: number; completed: number; stopped: number; replies: number };
  loopDelayP99: number;
  loopDelayMax: number;
  deflate: boolean;
}

async function oneCall(sc: Scenario, seed: number, replies: number): Promise<CallResult> {
  const gen = GEN[sc.gen]!;
  const { events, endMs, interrupted } = plan(gen, seed, replies);
  const horizon = endMs + 10_000;
  const up = new Link(LINKS.backbone!, seed * 7 + 1, horizon);
  const down = new Link(LINKS[sc.link]!, seed * 7 + 2, horizon);
  const uplink = new Link(LINKS[sc.link]!, seed * 7 + 3, horizon);

  const moss = new WebSocketServer({ port: 0, host: "127.0.0.1", perMessageDeflate: SERVICE_DEFLATE });
  await new Promise<void>((r) => moss.once("listening", () => r()));
  const env = await startRelay((moss.address() as { port: number }).port);
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();

  const sentAt = new Map<string, number>();
  /** The fake service's own send queue (compression), not the relay's. */
  const serviceQueueMs: number[] = [];
  const micAt: number[] = [];
  const receipts = { chunks: 0, completed: new Set<string>(), stopped: new Set<string>() };
  let deflateOn = false;
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  /** When the call became ready: the plan's clock starts here. */
  let base = 0;
  const service = new Pipe(now);
  const downPipe = new Pipe(now);
  const upPipe = new Pipe(now);

  // --- the fake voice service
  const ready = new Promise<void>((resolve) => {
    moss.on("connection", (ws, req) => {
      deflateOn = /permessage-deflate/.test(String(req.headers["sec-websocket-extensions"] ?? "")) && /permessage-deflate/.test(ws.extensions);
      ws.on("message", (data, binary) => {
        if (binary) {
          micAt.push(now());
          return;
        }
        const m = JSON.parse(data.toString());
        switch (m.action) {
          case "attach_session":
            ws.send(JSON.stringify({ action: "session_attached", data: { session_id: "h1", memory_scope: "session", delegation: "client" } }));
            break;
          case "session.update":
            ws.send(JSON.stringify({ action: "session.updated", data: { error: "", tools: [] } }));
            base = now();
            resolve();
            break;
          case "playback.chunk.completed":
            receipts.chunks++;
            break;
          case "playback.completed":
            receipts.completed.add(m.run_id);
            break;
          case "playback.stopped":
            receipts.stopped.add(m.run_id);
            break;
        }
      });
      ready.then(() => {
        // Service clock: each event goes out once generated and through the backbone link, in order.
        let seq = 0;
        for (const e of events) {
          service.push(up.at(base + e.at), () => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (e.pcm) {
              // The first bytes carry a sequence number so the phone can check what it pairs.
              e.pcm.writeUInt32LE(seq++, 0);
              const queued = now();
              ws.send(e.pcm, { binary: true }, () => {
                sentAt.set(e.chunk!, now());
                serviceQueueMs.push(now() - queued);
              });
            } else ws.send(JSON.stringify(e.msg));
          });
        }
      });
    });
  });

  // --- the fake phone
  const phone = new WebSocket(env.url, { headers: { Authorization: `Bearer ${env.token}` } });
  const trace: Arrival[] = [];
  const forwardMs: number[] = [];
  const contexts: Array<{ run: string; chunk: string }> = [];
  const live = new JitterPlayer({ thresholdMs: 40, refillAfterMs: 1000 });
  const done = new Set<string>();
  const stopped = new Set<string>();
  const got = new Map<string, number>();
  const acked = new Set<string>();
  const heard = new Map<string, number>();
  let stepT = 0;
  const uplinkSend = (data: string | Buffer, binary = false) => upPipe.push(uplink.at(now()), () => phone.readyState === WebSocket.OPEN && phone.send(data, { binary }));
  let pairing = 0;
  let audioSeq = 0;
  // Plays in real time and sends receipts the way VoiceCall.kt does (every 20 ms).
  const deliver = (a: Arrival) => {
    trace.push(a);
    if (a.kind === "audio") {
      got.set(a.run, (got.get(a.run) ?? 0) + 1);
      live.audio(a.t, { run: a.run, id: a.id, frames: a.frames });
    } else if (a.kind === "done") {
      done.add(a.run);
      live.done(a.t, a.run);
    } else {
      stopped.add(a.run);
      live.stop(a.t, a.run);
      uplinkSend(JSON.stringify({ action: "playback.stopped", run_id: a.run, turn_id: a.run.replace("run", "turn"), played_audio_ms: Math.round(heard.get(a.run) ?? 0), reason: "interrupted" }));
    }
  };
  let lastAck = 0;
  const ticker = setInterval(() => {
    const t = Math.floor(now());
    for (; stepT <= t; stepT++) {
      live.step(stepT);
      live.track.step(stepT);
    }
    if (t - lastAck < 20) return;
    lastAck = t;
    for (const p of live.track.played) {
      if (acked.has(p.id) || stopped.has(p.run)) continue;
      acked.add(p.id);
      heard.set(p.run, (heard.get(p.run) ?? 0) + (p.end - p.start));
      uplinkSend(JSON.stringify({ action: "playback.chunk.completed", chunk_id: p.id, run_id: p.run, turn_id: p.run.replace("run", "turn") }));
      const n = [...acked].filter((id) => id.startsWith(`${p.run}-`)).length;
      if (done.has(p.run) && n === got.get(p.run)) uplinkSend(JSON.stringify({ action: "playback.completed", run_id: p.run, turn_id: p.run.replace("run", "turn") }));
    }
  }, 5);

  phone.on("message", (data, binary) => {
    const r = now();
    const at = down.at(r);
    if (binary) {
      const c = contexts.shift();
      if ((data as Buffer).readUInt32LE(0) !== audioSeq++ || !c) pairing++;
      if (!c) return;
      forwardMs.push(r - (sentAt.get(c.chunk) ?? r));
      const frames = (data as Buffer).length / 2;
      downPipe.push(at, () => deliver({ t: at, kind: "audio", run: c.run, id: c.chunk, frames }));
      return;
    }
    const m = JSON.parse(data.toString());
    const d = m.data ?? {};
    if (m.action === "response.audio.context") contexts.push({ run: d.run_id, chunk: d.chunk_id });
    else if (m.action === "response.audio.done") downPipe.push(at, () => deliver({ t: at, kind: "done", run: d.run_id }));
    else if (m.action === "response.audio.stop") downPipe.push(at, () => deliver({ t: at, kind: "stop", run: d.run_id }));
  });
  await new Promise<void>((r) => phone.once("open", () => r()));
  await ready;
  // Mic: one 20 ms frame of 16 kHz PCM on a steady clock, through the uplink.
  const silence = Buffer.alloc(640);
  let micN = 0;
  const mic = setInterval(() => {
    while (base + micN * 20 <= now()) {
      micN++;
      uplinkSend(silence, true);
    }
  }, 4);

  await new Promise((r) => setTimeout(r, base + endMs + 3000 - now()));
  clearInterval(mic);
  clearInterval(ticker);
  service.close();
  downPipe.close();
  upPipe.close();
  await new Promise((r) => setTimeout(r, 800));
  phone.send(JSON.stringify({ action: "relay.hangup" }));
  await new Promise((r) => setTimeout(r, 100));
  phone.terminate();
  loop.disable();
  await env.close();
  await new Promise<void>((r) => moss.close(() => r()));

  // Mic lateness against an ideal 20 ms clock anchored on the earliest frame.
  const offs = micAt.map((t, k) => t - k * 20);
  const anchor = Math.min(...offs);
  const expected = trace.filter((a) => a.kind === "audio" && a.run !== interrupted).length;
  const ackedNormal = [...acked].filter((id) => !id.startsWith(`${interrupted}-`)).length;
  return {
    scenario: sc.name,
    seed,
    trace: trace.sort((a, b) => a.t - b.t),
    forwardMs,
    serviceQueueMs,
    micLateMs: offs.map((o) => o - anchor),
    micFrames: micAt.length,
    pairing,
    receipts: { chunks: receipts.chunks, acked: ackedNormal, expected, completed: receipts.completed.size, stopped: receipts.stopped.size, replies },
    loopDelayP99: loop.percentile(99) / 1e6,
    loopDelayMax: loop.max / 1e6,
    deflate: deflateOn,
  };
}

// ---------------------------------------------------------------------------
// Relay forwarding cost alone
// ---------------------------------------------------------------------------

async function transport(load: boolean): Promise<{ load: boolean; deflate: boolean; p50: number; p99: number; max: number; n: number }> {
  const moss = new WebSocketServer({ port: 0, host: "127.0.0.1", perMessageDeflate: true });
  await new Promise<void>((r) => moss.once("listening", () => r()));
  const env = await startRelay((moss.address() as { port: number }).port);
  const sent = new Map<number, number>();
  const lat: number[] = [];
  let deflateOn = false;
  let stopLoad = false;
  // Other work on the relay's thread pool: hosts' compressed screens (permessage-deflate on /v1/ws).
  const blob = Buffer.from(Array.from({ length: 1 << 20 }, (_, i) => String.fromCharCode(32 + ((i * 7919) % 90))).join(""));
  const pump = () => {
    if (stopLoad) return;
    deflate(blob, { level: 4 }, () => pump());
  };
  const r = rng(99);
  const ready = new Promise<WebSocket>((resolve) => {
    moss.on("connection", (ws, req) => {
      deflateOn = /permessage-deflate/.test(String(req.headers["sec-websocket-extensions"] ?? "")) && /permessage-deflate/.test(ws.extensions);
      ws.on("message", (data, binary) => {
        if (binary) return;
        const m = JSON.parse(data.toString());
        if (m.action === "attach_session") ws.send(JSON.stringify({ action: "session_attached", data: { delegation: "client" } }));
        if (m.action === "session.update") {
          ws.send(JSON.stringify({ action: "session.updated", data: { error: "", tools: [] } }));
          resolve(ws);
        }
      });
    });
  });
  const phone = new WebSocket(env.url, { headers: { Authorization: `Bearer ${env.token}` } });
  let seq = 0;
  phone.on("message", (data, binary) => {
    if (!binary) return;
    const id = (data as Buffer).readUInt32LE(0);
    lat.push(performance.now() - (sent.get(id) ?? performance.now()));
  });
  const ws = await ready;
  if (load) for (let i = 0; i < 8; i++) pump();
  const n = 400;
  for (let k = 0; k < n; k++) {
    const pcm = speechPcm(80 * PER_MS, r, k * 3840);
    pcm.writeUInt32LE(seq, 0);
    ws.send(JSON.stringify({ action: "response.audio.context", data: { run_id: "r", turn_id: "t", chunk_id: `c${seq}` } }));
    sent.set(seq, performance.now());
    ws.send(pcm, { binary: true });
    seq++;
    await new Promise((res) => setTimeout(res, 20));
  }
  await new Promise((res) => setTimeout(res, 500));
  stopLoad = true;
  phone.terminate();
  await env.close();
  await new Promise<void>((res) => moss.close(() => res()));
  const s = [...lat].sort((a, b) => a - b);
  const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 100) / 100;
  return { load, deflate: deflateOn, p50: q(50), p99: q(99), max: Math.round(s[s.length - 1]! * 100) / 100, n: lat.length };
}

// ---------------------------------------------------------------------------
// Scoring and the report
// ---------------------------------------------------------------------------

const POLICIES: Array<{ name: string; make: () => import("./playout.ts").Player }> = [
  { name: "before, mixer output (refills after ~1 s dry)", make: () => new DirectPlayer({ refillAfterMs: 1000 }) },
  { name: "before, output that refills at once (AudioTrack docs)", make: () => new DirectPlayer({ refillAfterMs: 0 }) },
  { name: "after, Android 12+, mixer output", make: () => new JitterPlayer({ thresholdMs: 40, refillAfterMs: 1000 }) },
  { name: "after, Android 12+, refills at once", make: () => new JitterPlayer({ thresholdMs: 40, refillAfterMs: 0 }) },
  { name: "after, Android 7-11, mixer output", make: () => new JitterPlayer({ thresholdMs: 200, refillAfterMs: 1000 }) },
  { name: "after, Android 7-11, refills at once", make: () => new JitterPlayer({ thresholdMs: 200, refillAfterMs: 0 }) },
];

function add(a: Score | null, b: Score): Score {
  if (!a) return { ...b };
  return {
    runs: a.runs + b.runs,
    speechSec: a.speechSec + b.speechSec,
    stalls: a.stalls + b.stalls,
    stallMs: a.stallMs + b.stallMs,
    shortStalls: a.shortStalls + b.shortStalls,
    maxStallMs: Math.max(a.maxStallMs, b.maxStallMs),
    choppyRuns: a.choppyRuns + b.choppyRuns,
    startP50: Math.max(a.startP50, b.startP50),
    startP95: Math.max(a.startP95, b.startP95),
    unplayedMs: a.unplayedMs + b.unplayedMs,
    trackUnderruns: a.trackUnderruns + b.trackUnderruns,
  };
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10 : 0;
};

function report(results: CallResult[]): void {
  const totals = new Map<string, Score>();
  const byScenario = new Map<string, CallResult[]>();
  for (const r of results) byScenario.set(r.scenario, [...(byScenario.get(r.scenario) ?? []), r]);
  for (const [name, rs] of byScenario) {
    console.log(`\n## ${name}  (${rs.length} call(s), seeds ${rs.map((r) => r.seed).join(",")})`);
    const fwd = rs.flatMap((r) => r.forwardMs);
    const sq = rs.flatMap((r) => r.serviceQueueMs);
    const late = rs.flatMap((r) => r.micLateMs);
    console.log(
      `relay forward p50 ${q(fwd, 50)} ms, p99 ${q(fwd, 99)} ms, max ${q(fwd, 100)} ms (service send queue max ${q(sq, 100)} ms); upstream deflate ${rs.some((r) => r.deflate) ? "on" : "off"}; ` +
        `event loop p99 ${Math.max(...rs.map((r) => r.loopDelayP99)).toFixed(1)} ms max ${Math.max(...rs.map((r) => r.loopDelayMax)).toFixed(1)} ms`,
    );
    console.log(`mic at the service: ${rs.reduce((n, r) => n + r.micFrames, 0)} frames, lateness p50 ${q(late, 50)} ms p99 ${q(late, 99)} ms max ${q(late, 100)} ms`);
    for (const r of rs) {
      const rc = r.receipts;
      console.log(`receipts (live, new player) seed ${r.seed}: chunk receipts at the service ${rc.chunks} (phone acked ${rc.acked}/${rc.expected} of uninterrupted replies), pairing errors ${r.pairing}, playback.completed ${rc.completed}/${rc.replies - 1}, playback.stopped ${rc.stopped}/1`);
    }
    console.log("| policy | stalls | <200 ms | stall ms | max stall | choppy replies | start p50/p95 ms | unplayed ms |");
    console.log("|---|---|---|---|---|---|---|---|");
    for (const p of POLICIES) {
      let s: Score | null = null;
      for (const r of rs) s = add(s, run(r.trace, p.make()));
      const x = s!;
      totals.set(p.name, add(totals.get(p.name) ?? null, x));
      console.log(`| ${p.name} | ${x.stalls} | ${x.shortStalls} | ${x.stallMs} | ${x.maxStallMs} | ${x.choppyRuns}/${x.runs} | ${x.startP50}/${x.startP95} | ${x.unplayedMs} |`);
    }
  }
  console.log(`\n## all scenarios (start: the worst scenario's p50/p95)`);
  console.log("| policy | stalls | <200 ms | stall ms | max stall | choppy replies | start p50/p95 ms | unplayed ms |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const [name, x] of totals) console.log(`| ${name} | ${x.stalls} | ${x.shortStalls} | ${x.stallMs} | ${x.maxStallMs} | ${x.choppyRuns}/${x.runs} | ${x.startP50}/${x.startP95} | ${x.unplayedMs} |`);
}

async function child(): Promise<void> {
  const [, , , name, seed, replies] = process.argv;
  const sc = SCENARIOS.find((s) => s.name === name)!;
  const res = await oneCall(sc, Number(seed), Number(replies));
  process.stdout.write(JSON.stringify(res), () => process.exit(0));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--child") return child();
  const scoreFile = args.find((a) => a.startsWith("--score="))?.slice(8);
  if (scoreFile) {
    // Re-scores saved calls; HARNESS_PLAYOUT='{"minTargetMs":120}' tries other jitter-buffer settings.
    if (process.env.HARNESS_PLAYOUT) Object.assign(PLAYOUT, JSON.parse(process.env.HARNESS_PLAYOUT));
    report(JSON.parse(readFileSync(scoreFile, "utf8")));
    return;
  }
  if (args.includes("--transport")) {
    console.log("relay forwarding of 80 ms chunks, service -> phone on localhost (400 chunks each)");
    for (const load of [false, true]) {
      const t = await transport(load);
      console.log(`thread pool ${load ? "busy (8 deflate jobs of 1 MB)" : "idle"}: upstream deflate ${t.deflate ? "on" : "off"}, p50 ${t.p50} ms, p99 ${t.p99} ms, max ${t.max} ms (n=${t.n})`);
    }
    process.exit(0);
  }
  const quick = args.includes("--quick");
  const seeds = quick ? [1] : [1, 2];
  const replies = quick ? 6 : 10;
  const only = args.find((a) => a.startsWith("--only="))?.slice(7);
  const jobs = SCENARIOS.filter((s) => !only || s.name.includes(only)).flatMap((s) => seeds.map((seed) => ({ s, seed })));
  console.log(`# voice harness: ${jobs.length} calls of ${replies} replies, in parallel`);
  const results = await Promise.all(
    jobs.map(
      ({ s, seed }) =>
        new Promise<CallResult>((resolve, reject) => {
          const p = spawn(process.execPath, [new URL(import.meta.url).pathname, "--child", s.name, String(seed), String(replies)], { stdio: ["ignore", "pipe", "inherit"] });
          let out = "";
          p.stdout.on("data", (d) => (out += d));
          p.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`${s.name} seed ${seed} exited ${code}`))));
        }),
    ),
  );
  const save = args.find((a) => a.startsWith("--save="))?.slice(7);
  if (save) writeFileSync(save, JSON.stringify(results));
  report(results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
