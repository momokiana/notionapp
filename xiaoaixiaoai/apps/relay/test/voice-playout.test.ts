/**
 * The speaker's jitter buffer, on made-up arrivals. test/voice/playout.ts is
 * the TypeScript twin of the app's Playout.kt (the Kotlin is not run here); the
 * voice harness (node test/voice/harness.ts) runs both players on simulated calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lognormal, rng } from "./voice/net.ts";
import { DirectPlayer, JitterPlayer, PER_MS, PLAYOUT, Playout, run, type Arrival } from "./voice/playout.ts";

/**
 * Three replies of 60 chunks from a speech model barely faster than real time
 * (median 1.08x per chunk) that now and then pauses 100-300 ms. Each reply ends
 * with a 20 ms chunk.
 */
function tight(seed: number): Arrival[] {
  const r = rng(seed);
  const out: Arrival[] = [];
  for (let n = 0; n < 3; n++) {
    let t = 1000 + n * 10_000;
    const name = `r${n}`;
    for (let k = 0; k < 60; k++) {
      t += 60 / Math.max(0.6, Math.min(4, lognormal(r, 1.08, 0.18)));
      if (r() < 0.05) t += 100 + 200 * r();
      out.push({ t, kind: "audio", run: name, id: `${name}-${k}`, frames: (k === 59 ? 20 : 60) * PER_MS });
    }
    out.push({ t: t + 1, kind: "done", run: name });
  }
  return out.sort((x, y) => x.t - y.t);
}

test("speech that comes barely faster than it plays: a few longer pauses instead of many short breaks", () => {
  let oldUnplayed = 0;
  for (const seed of [1, 2, 3]) {
    const trace = tight(seed);
    const before = run(trace, new DirectPlayer({ refillAfterMs: 1000 }));
    const after = run(trace, new JitterPlayer({ thresholdMs: 40, refillAfterMs: 1000 }));
    assert.ok(after.stalls < before.stalls, `seed ${seed}: ${after.stalls} breaks after, ${before.stalls} before`);
    assert.ok(after.shortStalls < before.shortStalls, `seed ${seed}: ${after.shortStalls} short breaks after, ${before.shortStalls} before`);
    assert.equal(after.unplayedMs, 0);
    // Android 12+: the same whether a dry track resumes at once or waits for its (40 ms) start threshold.
    assert.deepEqual(run(trace, new JitterPlayer({ thresholdMs: 40, refillAfterMs: 0 })), after);
    // The cushion costs at the start, never more than the most it waits for.
    assert.ok(after.startP95 <= PLAYOUT.maxTargetMs + PLAYOUT.holdSlackMs + 10, `seed ${seed}: start ${after.startP95} ms`);
    oldUnplayed += run(trace, new DirectPlayer({ refillAfterMs: 0 })).unplayedMs;
  }
  // The old player on an output that refills at once: a reply's last bit can stay below the threshold, never heard.
  assert.ok(oldUnplayed > 0);
});

test("a reply that is all in starts at once, and a short one is not held back for the cushion", () => {
  const trace: Arrival[] = [
    { t: 500, kind: "audio", run: "s", id: "s0", frames: 60 * PER_MS },
    { t: 505, kind: "audio", run: "s", id: "s1", frames: 60 * PER_MS },
    { t: 506, kind: "done", run: "s" },
  ];
  const s = run(trace, new JitterPlayer({ thresholdMs: 40, refillAfterMs: 1000 }));
  assert.equal(s.runs, 1);
  assert.equal(s.unplayedMs, 0);
  assert.ok(s.startP50 < PLAYOUT.minTargetMs, `start ${s.startP50} ms`);
});

test("a stopped reply goes silent, audio still on its way is dropped, the next reply plays whole", () => {
  const trace: Arrival[] = [];
  for (let k = 0; k < 40; k++) trace.push({ t: 300 + k * 20, kind: "audio", run: "cut", id: `cut-${k}`, frames: 60 * PER_MS });
  trace.push({ t: 900, kind: "stop", run: "cut" });
  for (let k = 0; k < 20; k++) trace.push({ t: 2000 + k * 50, kind: "audio", run: "next", id: `next-${k}`, frames: 60 * PER_MS });
  trace.push({ t: 3000, kind: "done", run: "next" });
  trace.sort((x, y) => x.t - y.t);
  for (const thresholdMs of [40, 200]) {
    const p = new JitterPlayer({ thresholdMs, refillAfterMs: 1000 });
    const s = run(trace, p);
    assert.ok(p.track.played.filter((x) => x.run === "cut").every((x) => x.end <= 901), "nothing of the cut reply plays after the stop");
    assert.equal(p.track.played.filter((x) => x.run === "next").length, 20);
    assert.equal(s.unplayedMs, 0);
  }
});

test("the cushion follows how late the last replies' audio came, within its bounds", () => {
  const p = new Playout();
  assert.equal(p.targetMs, PLAYOUT.minTargetMs);
  // A reply whose audio fell 300 ms behind a steady playout, then the next one starts.
  p.push({ run: "a", id: "a0", frames: 60 * PER_MS }, 0);
  p.push({ run: "a", id: "a1", frames: 60 * PER_MS }, 360);
  p.push({ run: "b", id: "b0", frames: 60 * PER_MS }, 5000);
  assert.equal(p.targetMs, 300 + PLAYOUT.marginMs);
  // Far behind: capped.
  p.push({ run: "b", id: "b1", frames: 60 * PER_MS }, 7000);
  p.push({ run: "c", id: "c0", frames: 60 * PER_MS }, 9000);
  assert.equal(p.targetMs, PLAYOUT.maxTargetMs);
});
