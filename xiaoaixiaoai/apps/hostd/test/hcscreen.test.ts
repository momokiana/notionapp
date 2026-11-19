import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcScreens } from "../src/hcscreen.ts";

/** These fakes are shell scripts: Windows can't run them (CI there runs the rest). */
const SH = { skip: process.platform === "win32" && "shell-script fakes" };

/** A framed `hc connect` stand-in: records attach params and the bytes typed on the stream. */
function fakeHc(dir: string): { bin: string; typed: string; attaches: string } {
  const bin = join(dir, "hc");
  const typed = join(dir, "typed");
  const attaches = join(dir, "attaches");
  writeFileSync(typed, "");
  writeFileSync(attaches, "");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const H = 9;
const frame = (ch, kind, p) => { const h = Buffer.alloc(H); h.writeUInt32LE(ch, 0); h[4] = kind; h.writeUInt32LE(p.length, 5); return Buffer.concat([h, p]); };
let buf = Buffer.alloc(0), framed = false;
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  if (!framed) {
    const nl = buf.indexOf(10); if (nl < 0) return;
    buf = buf.subarray(nl + 1); framed = true;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { features: ["framed"] } }) + "\\n");
  }
  while (buf.length >= H) {
    const ch = buf.readUInt32LE(0), kind = buf[4], len = buf.readUInt32LE(5);
    if (buf.length < H + len) return;
    const p = buf.subarray(H, H + len); buf = buf.subarray(H + len);
    if (ch === 0) {
      const m = JSON.parse(p.toString());
      appendFileSync(${JSON.stringify(attaches)}, JSON.stringify(m.params) + "\\n");
      process.stdout.write(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { channel: 7, automatic_input: true, terminal: { cols: m.params.cols, rows: m.params.rows } } }))));
      process.stdout.write(frame(7, 0, Buffer.from("first paint")));
    } else if (ch === 7 && kind === 0) appendFileSync(${JSON.stringify(typed)}, p);
    else if (ch === 7 && kind === 2) appendFileSync(${JSON.stringify(typed)}, "<CLOSE>");
  }
});
`,
  );
  chmodSync(bin, 0o755);
  return { bin, typed, attaches };
}

test("typing goes out at once, in order, on one stream at the terminal's own size", SH, async () => {
  const f = fakeHc(mkdtempSync(join(tmpdir(), "hc-framed-")));
  const screens = new HcScreens(f.bin);
  try {
    await Promise.all([screens.input("t1", "abc你好", 202, 47), screens.input("t1", "\x7f", 202, 47)]);
    await screens.input("t1", "!\r", 202, 47);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(readFileSync(f.typed, "utf8"), "abc你好\x7f!\r");
    const attaches = readFileSync(f.attaches, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(attaches.length, 1, "one stream for a burst of typing");
    assert.deepEqual({ ...attaches[0] }, { terminal: "t1", cols: 202, rows: 47, observe: false, resumed: true });
  } finally {
    screens.stop();
  }
});
