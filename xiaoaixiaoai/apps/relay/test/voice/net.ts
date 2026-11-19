/**
 * Seeded randomness and a one-way network model for the voice harness: a
 * per-message delay with a long tail, plus stalls during which nothing gets
 * through (what a TCP stream over a mobile link looks like). Order is kept,
 * as on a single WebSocket.
 */

/** mulberry32: small, fast, reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function uniform(r: () => number, lo: number, hi: number): number {
  return lo + (hi - lo) * r();
}

/** Log-normal with the given median; sigma is the spread of the logarithm. */
export function lognormal(r: () => number, median: number, sigma: number): number {
  const u = Math.max(1e-12, r());
  const v = r();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return median * Math.exp(sigma * z);
}

export interface LinkProfile {
  name: string;
  /** Fixed one-way delay, ms. */
  baseMs: number;
  /** Per-message extra delay: log-normal median and sigma. */
  jitterMedianMs: number;
  jitterSigma: number;
  /** Stalls per second (Poisson) and their length range. */
  stallsPerSec: number;
  stallMs: [number, number];
}

export const LINKS: Record<string, LinkProfile> = {
  /** Server to server: the relay and the voice service. */
  backbone: { name: "backbone", baseMs: 8, jitterMedianMs: 1, jitterSigma: 0.8, stallsPerSec: 1 / 40, stallMs: [40, 120] },
  wifi: { name: "wifi", baseMs: 15, jitterMedianMs: 3, jitterSigma: 0.9, stallsPerSec: 1 / 30, stallMs: [80, 220] },
  /** A phone on 4G/5G: a long tail and a stall every several seconds. */
  mobile: { name: "mobile", baseMs: 35, jitterMedianMs: 6, jitterSigma: 1.0, stallsPerSec: 1 / 8, stallMs: [120, 450] },
};

/**
 * One direction of a link. `at(t)` turns a send time into a delivery time;
 * times must be given in non-decreasing order.
 */
export class Link {
  private r: () => number;
  private stalls: Array<[number, number]> = [];
  private last = 0;
  private p: LinkProfile;

  constructor(p: LinkProfile, seed: number, horizonMs: number) {
    this.p = p;
    this.r = rng(seed);
    let t = 0;
    while (p.stallsPerSec > 0) {
      t += -Math.log(Math.max(1e-12, this.r())) * (1000 / p.stallsPerSec);
      if (t > horizonMs) break;
      this.stalls.push([t, t + uniform(this.r, p.stallMs[0], p.stallMs[1])]);
    }
  }

  at(sendMs: number): number {
    let t = sendMs;
    for (const [s, e] of this.stalls) if (t >= s && t < e) t = e;
    t += this.p.baseMs + Math.min(400, lognormal(this.r, this.p.jitterMedianMs, this.p.jitterSigma));
    this.last = Math.max(this.last, t);
    return this.last;
  }
}
