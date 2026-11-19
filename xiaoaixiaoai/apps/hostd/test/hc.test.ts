import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcAdapter } from "../src/hc.ts";

/** These fakes are shell scripts: Windows can't run them (CI there runs the rest). */
const SH = { skip: process.platform === "win32" && "shell-script fakes" };

/**
 * A stand-in for `hc connect` that behaves like herdr-core 0.1.21: once a
 * connection subscribes, it only streams events and never answers another
 * request on it; a fresh connection answers terminal.list.
 */
function fakeHc(dir: string, listState: string): string {
  const bin = join(dir, "hc");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const term = (state, turn, seen) => ({ address: "t1", state: "live", status: { app: "claude-code", state }, status_ms: 1, turn, labels: seen ? { "herdr.seen": String(seen) } : {} });
let subscribed = false;
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
    if (msg.method === "events.subscribe") {
      subscribed = true;
      out({ jsonrpc: "2.0", id: msg.id, result: { terminals: [term("working", 3)] } });
      setTimeout(() => out({ jsonrpc: "2.0", method: "event", params: { type: "status", terminal: "t1", data: { status: { app: "claude-code", msg: "still", state: "working" } } } }), 30);
      setTimeout(() => out({ jsonrpc: "2.0", method: "event", params: { type: "status", terminal: "t1", data: { status: { app: "claude-code", state: "done" } } } }), 80);
    } else if (msg.method === "terminal.list" && !subscribed) {
      const s = readFileSync(${JSON.stringify(listState)}, "utf8").trim();
      out({ jsonrpc: "2.0", id: msg.id, result: { terminals: [term(s, 3, s === "seen" ? 3 : 0)].map((t) => (s === "seen" ? { ...t, status: { app: "claude-code", state: "done" } } : t)) } });
    }
  }
});
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("status follows the event stream even though the subscribed connection answers nothing else", SH, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-fake-"));
  const listState = join(dir, "state");
  writeFileSync(listState, "done");
  const hc = new HcAdapter(fakeHc(dir, listState));
  const changes: string[] = [];
  hc.on("change", () => changes.push(HcAdapter.status(hc.terminals.get("t1")!)));
  hc.start();
  try {
    // The fake process starts slowly on a busy machine: wait for its snapshot (the "done" event follows 80 ms after it).
    for (let i = 0; i < 400 && !hc.terminals.get("t1"); i++) await wait(5);
    assert.equal(HcAdapter.status(hc.terminals.get("t1")!), "working", "snapshot from the subscription");
    await wait(700);
    // A message-only update did not count as a change; the finished turn came with the list that followed.
    assert.equal(HcAdapter.status(hc.terminals.get("t1")!), "done");
    assert.deepEqual(changes.slice(0, 2), ["working", "done"]);

    // A full list comes over its own connection: the desktop marked the turn seen.
    writeFileSync(listState, "seen");
    await hc.list();
    assert.equal(HcAdapter.status(hc.terminals.get("t1")!), "idle");
  } finally {
    hc.stop();
  }
});
