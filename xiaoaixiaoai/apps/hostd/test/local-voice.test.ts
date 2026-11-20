import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LocalVoiceBridge } from "../src/local-voice.ts";

function setupMockWorker(idleTimeoutMs = 300_000) {
  const dir = mkdtempSync(join(tmpdir(), "xa-local-voice-"));
  const logPath = join(dir, "worker-events.jsonl");
  const mockWorker = join(dir, "mock-voice-worker.mjs");

  writeFileSync(mockWorker, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logFile = ${JSON.stringify(logPath)};
const record = (entry) => appendFileSync(logFile, JSON.stringify(entry) + "\\n");
record({ event: "spawn", cfg: JSON.parse(process.env.LOCAL_VOICE_CONFIG_JSON || "{}") });
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");

const cancelled = new Set();
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  record({ event: "cmd", cmd: msg.cmd, requestId: msg.requestId });
  if (msg.cmd === "cancel") {
    if (msg.requestId) cancelled.add(msg.requestId);
    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, cancelled: true }) + "\\n");
    return;
  }
  if (msg.cmd === "warmup") {
    setTimeout(() => process.stdout.write(JSON.stringify({ id: msg.id, ok: true, ready: true }) + "\\n"), 20);
    return;
  }
  if (msg.cmd === "transcribe") {
    setTimeout(() => {
      if (cancelled.has(msg.requestId)) {
        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, text: "", cancelled: true }) + "\\n");
      } else {
        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, text: "帮我看一下状态" }) + "\\n");
      }
    }, 25);
    return;
  }
  if (msg.cmd === "synthesize") {
    setTimeout(() => {
      if (cancelled.has(msg.requestId)) {
        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, sampleRate: 48000, chunksBase64: [], cancelled: true }) + "\\n");
        return;
      }
      const chunk = Buffer.alloc(15360, 1).toString("base64");
      process.stdout.write(JSON.stringify({ id: msg.id, ok: true, sampleRate: 48000, chunksBase64: [chunk] }) + "\\n");
    }, 35);
  }
});
rl.on("close", () => {
  record({ event: "stdin-close" });
  process.exit(0);
});
`);

  const bridge = new LocalVoiceBridge({
    pythonBin: mockWorker,
    gptSovitsDir: dir,
    sovitsWeightsPath: join(dir, "s.pth"),
    gptWeightsPath: join(dir, "g.ckpt"),
    refAudioPath: join(dir, "r.wav"),
    refText: "测试参考句",
    idleTimeoutMs,
  });

  const logs = () => {
    try {
      return readFileSync(logPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  };

  return { dir, bridge, logs, cleanup: () => { bridge.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("LocalVoiceBridge loads lazily, queues requests, cancels cleanly, and releases worker on release() and idle timeout", async (t) => {
  const fx = setupMockWorker(180);
  t.after(fx.cleanup);

  assert.equal(fx.bridge.enabled, true);
  // Before any voice call, the Python/GPU worker must NOT have spawned yet.
  assert.equal(fx.logs().length, 0);

  const warm = await fx.bridge.warmup();
  assert.deepEqual(warm, { ready: true });
  assert.equal(fx.logs().filter((e) => e.event === "spawn").length, 1);

  const asr = await fx.bridge.transcribe({
    requestId: randomUUID(),
    audioBase64: Buffer.alloc(3200).toString("base64"),
    sampleRate: 16000,
  });
  assert.equal(asr.text, "帮我看一下状态");

  const ttsReq1 = randomUUID();
  const ttsReq2 = randomUUID();
  const p1 = fx.bridge.synthesize({ requestId: ttsReq1, text: "第一句。" });
  const p2 = fx.bridge.synthesize({ requestId: ttsReq2, text: "这句会被取消。" });
  await fx.bridge.cancel(ttsReq2);

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.sampleRate, 48000);
  assert.equal(r1.chunksBase64.length, 1);
  assert.equal(Buffer.from(r1.chunksBase64[0]!, "base64").length, 15360);
  assert.equal(r2.cancelled, true);
  assert.deepEqual(r2.chunksBase64, []);

  // Wait beyond idleTimeoutMs (180 ms) -> worker must exit cleanly to free VRAM.
  await delay(300);
  assert.ok(fx.logs().some((e) => e.event === "stdin-close"));

  // Next call respawns worker automatically.
  const ttsReq3 = randomUUID();
  const r3 = await fx.bridge.synthesize({ requestId: ttsReq3, text: "重新唤醒。" });
  assert.equal(r3.chunksBase64.length, 1);
  assert.equal(fx.logs().filter((e) => e.event === "spawn").length, 2);

  // Explicit release() kills active worker right away without hanging in-flight calls.
  const inflight = fx.bridge.synthesize({ requestId: randomUUID(), text: "挂断前。" });
  const released = await fx.bridge.release();
  assert.deepEqual(released, { released: true });
  const inflightRes = await inflight;
  assert.equal(inflightRes.cancelled, true);
});
