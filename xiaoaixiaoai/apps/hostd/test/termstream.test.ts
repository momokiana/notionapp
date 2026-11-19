import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRows, diffRows, rowsChange, type TerminalRowsEvent } from "@xiaoaixiaoai/protocol";
import { Host } from "../src/host.ts";
import type { ScreenLines } from "../src/hcscreen.ts";

const line = (n: number) => `\x1b[0;32m✓\x1b[0m src/module_${n}.ts compiled ${n}`;

test("rows: a scroll is a shift plus the new lines, and applying it gives the next screen", () => {
  const prev = Array.from({ length: 240 }, (_, i) => line(i));
  const next = [...prev.slice(3), line(1000), line(1001), "status 中文"];
  const d = diffRows(prev, next);
  assert.equal(d.shift, 3);
  assert.equal(d.length, 240);
  assert.deepEqual(d.set?.map(([i]) => i), [237, 238, 239]);
  assert.deepEqual(applyRows(prev, d), next);
});

test("rows: any change round-trips, and the smaller form is chosen", () => {
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  let prev: string[] = [];
  for (let step = 0; step < 400; step++) {
    let next = [...prev];
    const kind = rnd(6);
    if (kind === 0) next = next.slice(rnd(5)); // scroll
    if (kind <= 1) for (let k = rnd(6); k > 0; k--) next.push(rnd(4) ? line(rnd(50)) : ""); // output, blank lines too
    if (kind === 2 && next.length) next[rnd(next.length)] = `edited ${step}`;
    if (kind === 3) next = next.slice(0, rnd(next.length + 1)); // cleared below
    if (kind === 4) next = Array.from({ length: rnd(30) }, () => line(rnd(9))); // full redraw, repeated lines
    if (next.length > 240) next = next.slice(next.length - 240);
    const c = rowsChange(prev.length ? prev : null, next);
    if (c) assert.deepEqual(applyRows(prev, c), next, `step ${step}`);
    else assert.deepEqual(prev, next, `step ${step}: null only when nothing changed`);
    prev = next;
  }
  assert.ok(rowsChange(["a"], Array.from({ length: 50 }, (_, i) => `x${i}`))?.lines, "a whole new screen goes as lines");
});

type Frame = { type: string; id?: string; event?: any; result?: unknown; error?: unknown };

/** A host with one hc agent whose screen watch the test drives. */
function host() {
  const h = new Host({ config: { server: "http://127.0.0.1:9", token: "t", deviceId: "d", name: "test" }, log: () => {} });
  const x = h as unknown as { agents: unknown[]; send: (f: Frame) => void; handleStreamSubscribe: (f: unknown) => Promise<void>; stopStream: (id: string) => void };
  x.agents = [{ key: "d/hc:t1", localId: "t1", source: "hc", deviceId: "d", status: "working" }];
  const sent: Frame[] = [];
  x.send = (f) => sent.push(f);
  const watches: Array<{ paint: (s: ScreenLines) => void; stopped: boolean; text?: boolean }> = [];
  let gate: Promise<void> = Promise.resolve();
  h.hc.watch = async (_address, _history, paint, _onError, opts = {}) => {
    const w = { paint, stopped: false, text: opts.text };
    watches.push(w);
    await gate;
    return () => {
      w.stopped = true;
    };
  };
  const subscribe = (id: string, params: unknown, from = "phone") => x.handleStreamSubscribe({ type: "stream_subscribe", id, from, stream: "terminal", params });
  return { h, sent, watches, subscribe, unsubscribe: (id: string) => x.stopStream(id), hold: (p: Promise<void>) => (gate = p) };
}

test("a viewer that asks for rows gets the screen once, then only what changed", async () => {
  const { sent, watches, subscribe } = host();
  await subscribe("s1", { agent: "d/hc:t1", rows: true });
  assert.equal(watches[0]!.text, false, "no plain text is made for a rows viewer");
  const screen = Array.from({ length: 100 }, (_, i) => line(i));
  watches[0]!.paint({ lines: screen, cols: 200, rows: 50 });
  watches[0]!.paint({ lines: screen, cols: 200, rows: 50 });
  const next = [...screen.slice(1), "new line"];
  watches[0]!.paint({ lines: next, cols: 200, rows: 50 });
  const events = sent.filter((f) => f.type === "stream_event").map((f) => f.event as TerminalRowsEvent);
  assert.equal(events.length, 2, "an unchanged paint sends nothing");
  assert.deepEqual([events[0]!.kind, events[0]!.seq, events[0]!.lines?.length], ["terminal_rows", 1, 100]);
  assert.deepEqual({ seq: events[1]!.seq, shift: events[1]!.shift, set: events[1]!.set, lines: events[1]!.lines }, { seq: 2, shift: 1, set: [[99, "new line"]], lines: undefined });
  assert.deepEqual(applyRows(applyRows([], events[0]!), events[1]!), next);
  assert.ok(JSON.stringify(events[1]).length < 200);
});

test("an older app still gets whole screens with text", async () => {
  const { sent, watches, subscribe } = host();
  await subscribe("s1", { agent: "d/hc:t1", history: 120 });
  assert.notEqual(watches[0]!.text, false);
  watches[0]!.paint({ lines: ["a", "b"], text: "a\nb", cols: 80, rows: 24 });
  const ev = sent.find((f) => f.type === "stream_event")!.event;
  assert.deepEqual(ev.screen, { ansi: "a\nb", text: "a\nb", cols: 80, rows: 24 });
  assert.equal(ev.kind, "terminal");
});

test("a queue-only stream watches no screen; the same viewer subscribing again replaces its stream", async () => {
  const { sent, watches, subscribe } = host();
  await subscribe("q1", { agent: "d/hc:t1", screen: false });
  assert.equal(watches.length, 0);
  assert.ok(sent.some((f) => f.type === "stream_open" && f.id === "q1" && !f.error));
  await subscribe("s1", { agent: "d/hc:t1", rows: true });
  await subscribe("s1", { agent: "d/hc:t1", rows: true });
  assert.deepEqual(watches.map((w) => w.stopped), [true, false]);
  assert.equal(sent.filter((f) => f.type === "stream_open" && f.id === "s1" && !f.error).length, 2);
  await subscribe("s1", { agent: "d/hc:t1" }, "someone-else");
  assert.ok(sent.some((f) => f.type === "stream_open" && f.id === "s1" && f.error), "another device cannot take a stream id over");
});

test("unsubscribing while the watch is still starting stops it", async () => {
  const { watches, subscribe, unsubscribe, hold, sent } = host();
  let release!: () => void;
  hold(new Promise((r) => (release = r)));
  const pending = subscribe("s1", { agent: "d/hc:t1", rows: true });
  await new Promise((r) => setImmediate(r));
  unsubscribe("s1");
  release();
  await pending;
  assert.equal(watches[0]!.stopped, true);
  assert.ok(!sent.some((f) => f.type === "stream_open"));
});
