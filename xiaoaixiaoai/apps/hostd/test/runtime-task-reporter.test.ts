import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RuntimeTaskEvent } from "@xiaoaixiaoai/protocol";
import { RuntimeTaskReporter } from "../src/runtime-task-reporter.ts";

const event = (kind: RuntimeTaskEvent["kind"]): RuntimeTaskEvent => ({ eventId: randomUUID(), requestId: randomUUID(), kind });

test("reporter preserves order, retries only missing acknowledgements, and replays on a new link", async () => {
  let time = 0;
  const events = [event("progress"), event("attention"), event("completed")];
  const sent: RuntimeTaskEvent[] = [];
  const reporter = () => new RuntimeTaskReporter(async () => events, (e) => { sent.push(e); }, () => true, () => time);
  const link = reporter();
  await link.tick();
  assert.deepEqual(sent.splice(0), events);
  link.ack(events[0]!.eventId);
  link.ack(events[1]!.eventId);
  time = 9_999;
  await link.tick();
  assert.deepEqual(sent, []);
  time++;
  await link.tick();
  assert.deepEqual(sent.splice(0), [events[2]]);
  await reporter().tick();
  assert.deepEqual(sent, events);
});

test("reporter does not read without capability and drops results after lease loss", async () => {
  let current = false;
  let reads = 0;
  let resolve!: (events: RuntimeTaskEvent[]) => void;
  const promise = new Promise<RuntimeTaskEvent[]>((done) => { resolve = done; });
  const sent: RuntimeTaskEvent[] = [];
  const link = new RuntimeTaskReporter(() => { reads++; return promise; }, (e) => { sent.push(e); }, () => current);
  await link.tick();
  assert.equal(reads, 0);
  current = true;
  const reading = link.tick();
  await link.tick();
  assert.equal(reads, 1);
  current = false;
  resolve([event("attention")]);
  await reading;
  assert.deepEqual(sent, []);
});
