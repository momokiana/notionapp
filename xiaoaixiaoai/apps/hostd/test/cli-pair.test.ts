import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A relay stand-in that records what the CLI asks for. */
async function fakeRelay(devices: number) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const read = async (req: IncomingMessage) => {
    let s = "";
    for await (const c of req) s += c;
    return s ? JSON.parse(s) : null;
  };
  const server = createServer(async (req, res) => {
    const body = await read(req);
    calls.push({ method: req.method!, path: req.url!, body });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/pocket/v1/health") return res.end(JSON.stringify({ ok: true, devices }));
    if (req.url === "/pocket/v1/pair" && body?.code === "MEOW-482193") {
      return res.end(JSON.stringify({ token: "hp_test", device: { id: "dev1", name: body.name, kind: "host", online: false, createdAt: 0, lastSeenAt: 0 } }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: "not_found", message: "no" } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pocket`;
  return { base, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function cli(args: string[]): Promise<{ code: number; out: string; err: string; home: string }> {
  const home = mkdtempSync(join(tmpdir(), "pocket-cli-"));
  dirs.push(home);
  return new Promise((resolve) => {
    const child = execFile(process.execPath, ["--no-warnings", CLI, ...args], { env: { ...process.env, XIAOAIXIAOAI_HOME: home, POCKET_ADMIN_TOKEN: "" } }, (err, out, errOut) =>
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out, err: errOut, home }),
    );
    child.stdin?.end();
  });
}

test("login takes an invite link: server and code come from it", async () => {
  const relay = await fakeRelay(1);
  try {
    for (const args of [[`${relay.base}/p/meow-482193`], ["--code", `${relay.base}/p/MEOW-482193`]]) {
      const r = await cli(["login", ...args, "--name", "test mac"]);
      assert.equal(r.code, 0, r.err);
      const pairCall = relay.calls.filter((c) => c.path === "/pocket/v1/pair").pop()!;
      assert.equal(pairCall.body.code, "MEOW-482193");
      assert.equal(pairCall.body.kind, "host");
      const cfg = JSON.parse(readFileSync(join(r.home, "hostd.json"), "utf8"));
      assert.equal(cfg.server, relay.base);
      assert.equal(cfg.deviceId, "dev1");
    }
    assert.equal(relay.calls.filter((c) => c.path === "/pocket/v1/join").length, 0);
  } finally {
    await relay.close();
  }
});

test("a relay with no devices asks for its setup code instead of waiting for a scan nobody can approve", async () => {
  const relay = await fakeRelay(0);
  try {
    const r = await cli(["login", "--server", relay.base]);
    assert.equal(r.code, 1);
    assert.match(r.err, /no devices yet/);
    assert.match(r.err, /--code <CODE>/);
    assert.equal(relay.calls.filter((c) => c.path === "/pocket/v1/join").length, 0);
  } finally {
    await relay.close();
  }
});

test("a malformed invite link is refused before anything is sent", async () => {
  const r = await cli(["login", "https://xiaoaixiaoai.example.com/p/nope"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /not an invite link/);
});
