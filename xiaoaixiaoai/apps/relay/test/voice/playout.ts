/**
 * The phone's speaker side, as models the harness can run on recorded
 * arrivals. `Playout` is the jitter buffer of the app's Playout.kt
 * (modules/xiaoaixiaoai-native/android/.../Playout.kt: same constants, same
 * decisions; keep the two in step), and `JitterPlayer` drives it the way
 * VoiceCall.kt's play thread does. `DirectPlayer` is VoiceCall.kt before it:
 * every chunk is written to the AudioTrack the moment it arrives.
 *
 * `TrackSim` stands in for Android's streaming AudioTrack, at 1 ms steps:
 * a buffer of `capacity` frames that starts playing once it holds `threshold`
 * frames; by default the threshold is the whole buffer
 * (getStartThresholdInFrames). A track that has been dry for `refillAfterMs`
 * must be filled to the threshold again before it plays, as the
 * AudioTrack.play() documentation says ("the buffer will need to be filled up
 * again after the track underruns"). When that happens depends on the output:
 * 0 models an output that gives up on a dry track at once, 1000 a mixer that
 * keeps it for about a second (an assumption, not measured on a device).
 */

export const RATE = 48_000;
export const PER_MS = RATE / 1000;

/** Mirrors the constants in VoiceCall.kt. */
export const PLAYOUT = {
  /** Audio held back before a reply starts, at least and at most. */
  minTargetMs: 200,
  maxTargetMs: 400,
  /**
   * The target for the next reply: what the last few replies needed (how late
   * their audio came against a steady playout from their first chunk), plus a margin.
   */
  historyRuns: 4,
  marginMs: 20,
  /** A stall in the middle of a reply raises the target by this much right away. */
  stepMs: 60,
  /** After a stall in the middle of a reply, play again once this share of the target is in (and at least `rebufferMinMs`). */
  rebufferShare: 0.5,
  rebufferMinMs: 80,
  /** Waiting for the target never takes longer than the target plus this. */
  holdSlackMs: 120,
  /**
   * Silence kept queued while the track has no speech, so it never runs dry. Only
   * where the track's start threshold is its whole buffer (before Android 12): a
   * dry track there plays again only once the whole buffer is full. From Android
   * 12 the threshold is 40 ms and one chunk restarts it; silence would only hold
   * speech back.
   */
  leadMs: 40,
  /** How often the play thread looks again when it has nothing to do. */
  loopMs: 5,
};

/** VoiceCall.kt before this change. */
export const DIRECT = {
  /** SPEAKER_RATE * 2 / 5 bytes: 200 ms. */
  bufferMs: 200,
  /** Sleep when the track is full. */
  fullSleepMs: 8,
};

export interface Piece {
  run: string;
  id: string;
  frames: number;
}

/** The jitter buffer: decides what the play thread writes next, or that it writes silence. */
export class Playout<T extends Piece = Piece> {
  private queue: T[] = [];
  private queued = 0;
  private holding = true;
  /** Holding after a stall in the middle of a reply, not before one. */
  private rebuffering = false;
  private holdSince = -1;
  private playing = "";
  private finished: string[] = [];
  // How late the arriving run's audio is against a steady playout from its first chunk.
  private arrivingRun = "";
  private arrivingSince = 0;
  private arrivingMs = 0;
  private lateMs = 0;
  private needed: number[] = [];
  targetMs = PLAYOUT.minTargetMs;
  stalls = 0;
  maxTargetMs = PLAYOUT.minTargetMs;

  push(p: T, now: number): void {
    if (p.run !== this.arrivingRun) {
      if (this.arrivingRun) this.learn(this.lateMs);
      this.arrivingRun = p.run;
      this.arrivingSince = now;
      this.arrivingMs = 0;
      this.lateMs = 0;
    } else this.lateMs = Math.max(this.lateMs, now - this.arrivingSince - this.arrivingMs);
    this.arrivingMs += p.frames / PER_MS;
    this.queue.push(p);
    this.queued += p.frames;
  }

  /** A run's audio has all come: the next target covers what the last few needed. */
  private learn(late: number): void {
    this.needed.push(late);
    if (this.needed.length > PLAYOUT.historyRuns) this.needed.shift();
    this.targetMs = Math.min(PLAYOUT.maxTargetMs, Math.max(PLAYOUT.minTargetMs, Math.max(...this.needed) + PLAYOUT.marginMs));
    this.maxTargetMs = Math.max(this.maxTargetMs, this.targetMs);
  }

  /** The service has sent all of this run's audio. */
  finish(run: string): void {
    if (this.finished.includes(run)) return;
    this.finished.push(run);
    if (this.finished.length > 64) this.finished.shift();
  }

  /** The run was stopped: its queued audio goes. */
  drop(run: string): T[] {
    const gone = this.queue.filter((p) => p.run === run);
    if (gone.length) {
      this.queue = this.queue.filter((p) => p.run !== run);
      this.queued = this.queue.reduce((n, p) => n + p.frames, 0);
    }
    if (this.playing === run) this.playing = "";
    this.holding = true;
    this.rebuffering = false;
    this.holdSince = -1;
    return gone;
  }

  /** Pieces flushed out of the track that still have to be played, back at the front. */
  requeue(pieces: T[]): void {
    if (!pieces.length) return;
    this.queue = [...pieces, ...this.queue];
    this.queued += pieces.reduce((n, p) => n + p.frames, 0);
  }

  get queuedMs(): number {
    return this.queued / PER_MS;
  }

  /**
   * What to write next, or null for nothing. `audioFrames`: speech the track
   * holds and has not played yet (silence not counted).
   */
  take(now: number, audioFrames: number): T | null {
    if (this.holding) {
      if (!this.queue.length) return null;
      if (this.holdSince < 0) this.holdSince = now;
      const want = this.rebuffering ? Math.max(PLAYOUT.rebufferMinMs, this.targetMs * PLAYOUT.rebufferShare) : this.targetMs;
      const ready =
        this.queuedMs >= want ||
        this.finished.includes(this.queue[0]!.run) ||
        this.finished.includes(this.queue[this.queue.length - 1]!.run) ||
        now - this.holdSince >= want + PLAYOUT.holdSlackMs;
      if (!ready) return null;
      this.holding = false;
      this.rebuffering = false;
      this.holdSince = -1;
    }
    const p = this.queue.shift();
    if (!p) {
      if (audioFrames <= 0) {
        // Ran dry in the middle of a reply: wait for a cushion instead of playing scraps.
        const midReply = !!this.playing && !this.finished.includes(this.playing);
        if (midReply) {
          this.stalls++;
          this.targetMs = Math.min(PLAYOUT.maxTargetMs, this.targetMs + PLAYOUT.stepMs);
          this.maxTargetMs = Math.max(this.maxTargetMs, this.targetMs);
        }
        this.holding = true;
        this.rebuffering = midReply;
      }
      return null;
    }
    this.queued -= p.frames;
    this.playing = p.run;
    return p;
  }
}

interface Seg {
  frames: number;
  /** Absent for silence. */
  piece?: Piece;
  /** First frame of the piece in this segment (a piece can be split over writes). */
  first: boolean;
  last: boolean;
}

export interface Played {
  run: string;
  id: string;
  start: number;
  end: number;
}

export class TrackSim {
  private buf: Seg[] = [];
  buffered = 0;
  /** Of `buffered`, what is speech. */
  audio = 0;
  private running = false;
  private dry = false;
  head = 0;
  written = 0;
  underruns = 0;
  /** Pieces fully played, with when they started and ended. */
  played: Played[] = [];
  private starts = new Map<string, number>();
  capacity: number;
  threshold: number;
  refillAfterMs: number;
  private drySince = -1;

  constructor(capacity: number, threshold: number, refillAfterMs: number) {
    this.capacity = capacity;
    this.threshold = Math.max(1, Math.min(threshold, capacity));
    this.refillAfterMs = refillAfterMs;
  }

  /** Non-blocking write; returns the frames taken. */
  write(frames: number, piece: Piece | undefined, first: boolean, last: boolean): number {
    const n = Math.min(frames, this.capacity - this.buffered);
    if (n <= 0) return 0;
    this.buf.push({ frames: n, piece, first, last: last && n === frames });
    this.buffered += n;
    if (piece) this.audio += n;
    this.written += n;
    return n;
  }

  flush(): Seg[] {
    const out = this.buf;
    this.buf = [];
    this.buffered = 0;
    this.audio = 0;
    this.running = false;
    this.head = 0;
    this.written = 0;
    return out;
  }

  /** Plays one millisecond. */
  step(t: number): void {
    if (!this.running) {
      if (this.buffered >= this.threshold && this.buffered > 0) this.running = true;
      else return;
    }
    let need = PER_MS;
    while (need > 0 && this.buf.length) {
      const s = this.buf[0]!;
      const take = Math.min(need, s.frames);
      if (s.piece && s.first && !this.starts.has(s.piece.id)) this.starts.set(s.piece.id, t + (PER_MS - need) / PER_MS);
      s.frames -= take;
      need -= take;
      this.buffered -= take;
      if (s.piece) this.audio -= take;
      this.head += take;
      if (s.frames === 0) {
        this.buf.shift();
        if (s.piece && s.last) {
          this.played.push({ run: s.piece.run, id: s.piece.id, start: this.starts.get(s.piece.id) ?? t, end: t + (PER_MS - need) / PER_MS });
          this.starts.delete(s.piece.id);
        }
      }
    }
    if (need > 0) {
      if (!this.dry) {
        this.underruns++;
        this.drySince = t;
      }
      this.dry = true;
      if (t - this.drySince >= this.refillAfterMs) this.running = false;
    } else this.dry = false;
  }
}

/** A player as the phone runs it: arrivals in, AudioTrack writes out. */
export interface Player {
  track: TrackSim;
  audio(t: number, p: Piece): void;
  done(t: number, run: string): void;
  stop(t: number, run: string): void;
  step(t: number): void;
  stalls?: () => number;
}

/** VoiceCall.kt before: write every chunk as soon as it arrives. */
export class DirectPlayer implements Player {
  track: TrackSim;
  private queue: Piece[] = [];
  private cur: Piece | null = null;
  private off = 0;
  private next = 0;

  constructor(opts: { refillAfterMs: number }) {
    const cap = DIRECT.bufferMs * PER_MS;
    this.track = new TrackSim(cap, cap, opts.refillAfterMs);
  }

  private stopped = new Set<string>();

  audio(_t: number, p: Piece): void {
    // As VoiceCall.kt: audio of a stopped reply that was still on its way is dropped.
    if (!this.stopped.has(p.run)) this.queue.push(p);
  }

  done(): void {}

  stop(_t: number, run: string): void {
    this.stopped.add(run);
    this.queue = this.queue.filter((p) => p.run !== run);
    // The old stopRun flushes the whole track when it holds any of the run, and drops the chunk being written.
    this.track.flush();
    this.cur = null;
    this.off = 0;
  }

  step(t: number): void {
    if (t < this.next) return;
    for (;;) {
      if (!this.cur) {
        this.cur = this.queue.shift() ?? null;
        this.off = 0;
        if (!this.cur) return;
      }
      const left = this.cur.frames - this.off;
      const n = this.track.write(left, this.cur, this.off === 0, true);
      this.off += n;
      if (n < left) {
        this.next = t + DIRECT.fullSleepMs;
        return;
      }
      this.cur = null;
    }
  }
}

/** VoiceCall.kt after: the jitter buffer decides, silence keeps the track running. */
export class JitterPlayer implements Player {
  track: TrackSim;
  playout = new Playout();
  private cur: Piece | null = null;
  private off = 0;
  private next = 0;
  private prime: number;

  private lead: number;

  /**
   * `thresholdMs`: the AudioTrack's start threshold (set to 40 ms from Android 12,
   * the whole buffer before); silence is kept queued only when it is the whole
   * buffer, as in VoiceCall.kt. `refillAfterMs`: the device model, as for TrackSim.
   */
  constructor(opts: { thresholdMs: number; refillAfterMs: number }) {
    const cap = DIRECT.bufferMs * PER_MS;
    this.track = new TrackSim(cap, opts.thresholdMs * PER_MS, opts.refillAfterMs);
    this.prime = this.track.threshold;
    this.lead = this.track.threshold >= cap ? PLAYOUT.leadMs * PER_MS : 0;
    this.track.write(this.prime, undefined, false, false);
  }

  stalls = () => this.playout.stalls;

  private stopped = new Set<string>();

  audio(t: number, p: Piece): void {
    if (!this.stopped.has(p.run)) this.playout.push(p, t);
  }

  done(_t: number, run: string): void {
    this.playout.finish(run);
  }

  stop(_t: number, run: string): void {
    this.stopped.add(run);
    this.playout.drop(run);
    const flushed = this.track.flush();
    // Other runs' audio that was in the track plays again from its start.
    const back: Piece[] = [];
    for (const s of flushed) if (s.piece && s.piece.run !== run && !back.includes(s.piece)) back.push(s.piece);
    if (this.cur && this.cur.run !== run && !back.includes(this.cur)) back.push(this.cur);
    this.playout.requeue(back);
    this.cur = null;
    this.off = 0;
    this.track.write(this.prime, undefined, false, false);
  }

  step(t: number): void {
    if (t < this.next) return;
    for (;;) {
      if (!this.cur) {
        this.cur = this.playout.take(t, this.track.audio);
        this.off = 0;
      }
      if (this.cur) {
        const left = this.cur.frames - this.off;
        const n = this.track.write(left, this.cur, this.off === 0, true);
        this.off += n;
        if (n < left) break;
        this.cur = null;
        continue;
      }
      if (this.track.buffered < this.lead) this.track.write(this.lead - this.track.buffered, undefined, false, false);
      break;
    }
    this.next = t + PLAYOUT.loopMs;
  }
}

// ---------------------------------------------------------------------------
// Running a player on a recorded trace
// ---------------------------------------------------------------------------

/** What reached the phone, and when (ms since the call started). */
export type Arrival =
  | { t: number; kind: "audio"; run: string; id: string; frames: number }
  | { t: number; kind: "done"; run: string }
  | { t: number; kind: "stop"; run: string };

export interface Score {
  runs: number;
  speechSec: number;
  /** Silences inside a reply of at least 10 ms: the stutter. */
  stalls: number;
  stallMs: number;
  /** Stalls under 200 ms, the "卡卡" kind. */
  shortStalls: number;
  maxStallMs: number;
  /** Replies with at least one stall. */
  choppyRuns: number;
  /** First chunk arrived -> first sound, per reply. */
  startP50: number;
  startP95: number;
  /** Audio that never got played by the end (stuck under the start threshold). */
  unplayedMs: number;
  trackUnderruns: number;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

export function run(trace: Arrival[], player: Player, tailMs = 10_000): Score {
  const end = Math.ceil(trace[trace.length - 1]?.t ?? 0) + tailMs;
  const firstArrival = new Map<string, number>();
  const stoppedAt = new Map<string, number>();
  const total = new Map<string, number>();
  let i = 0;
  for (let t = 0; t <= end; t++) {
    while (i < trace.length && trace[i]!.t <= t) {
      const a = trace[i++]!;
      if (a.kind === "audio") {
        if (!firstArrival.has(a.run)) firstArrival.set(a.run, a.t);
        total.set(a.run, (total.get(a.run) ?? 0) + a.frames);
        player.audio(t, { run: a.run, id: a.id, frames: a.frames });
      } else if (a.kind === "done") player.done(t, a.run);
      else {
        stoppedAt.set(a.run, t);
        player.stop(t, a.run);
      }
    }
    player.step(t);
    player.track.step(t);
  }
  const byRun = new Map<string, Played[]>();
  for (const p of player.track.played) {
    const l = byRun.get(p.run) ?? [];
    l.push(p);
    byRun.set(p.run, l);
  }
  let stalls = 0;
  let stallMs = 0;
  let shortStalls = 0;
  let maxStall = 0;
  let choppy = 0;
  const starts: number[] = [];
  for (const [r, list] of byRun) {
    list.sort((a, b) => a.start - b.start);
    starts.push(list[0]!.start - (firstArrival.get(r) ?? list[0]!.start));
    let n = 0;
    for (let k = 1; k < list.length; k++) {
      const gap = list[k]!.start - list[k - 1]!.end;
      if (gap >= 10) {
        n++;
        stallMs += gap;
        if (gap < 200) shortStalls++;
        maxStall = Math.max(maxStall, gap);
      }
    }
    stalls += n;
    if (n) choppy++;
  }
  // Pieces of runs that were not stopped and never finished playing.
  let unplayed = 0;
  const playedIds = new Set(player.track.played.map((p) => p.id));
  for (const a of trace) if (a.kind === "audio" && !stoppedAt.has(a.run) && !playedIds.has(a.id)) unplayed += a.frames;
  let speech = 0;
  for (const [r, f] of total) if (!stoppedAt.has(r)) speech += f;
  return {
    runs: byRun.size,
    speechSec: Math.round(speech / RATE),
    stalls,
    stallMs: Math.round(stallMs),
    shortStalls,
    maxStallMs: Math.round(maxStall),
    choppyRuns: choppy,
    startP50: Math.round(pct(starts, 50)),
    startP95: Math.round(pct(starts, 95)),
    unplayedMs: Math.round(unplayed / PER_MS),
    trackUnderruns: player.track.underruns,
  };
}
