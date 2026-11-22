import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { resolveLocalWebPort, startLocalWebBridge } from "../src/local-web.ts";

test("LocalWebBridge serves /app/ statically and proxies subpath HTTP + WebSocket requests directly to relay", async (t) => {
  const webRoot = mkdtempSync(join(tmpdir(), "xa-local-web-"));
  t.after(() => rmSync(webRoot, { recursive: true, force: true }));
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>LocalDesktop</title>");
  writeFileSync(join(webRoot, "assets", "bundle.js"), "window.__OK__=1;");

  // Fake upstream relay mounted under a reverse-proxy subpath `/xiaoaixiaoai`
  const wss = new WebSocketServer({ noServer: true });
  const upstream = createHttpServer((req, res) => {
    if (req.url === "/xiaoaixiaoai/v1/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, via: "direct-upstream" }));
      return;
    }
    if (req.url === "/xiaoaixiaoai/v1/echo" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") }));
      });
      return;
    }
    res.writeHead(404);
    res.end("missing");
  });
  upstream.on("upgrade", (req, sock, head) => {
    if (req.url === "/xiaoaixiaoai/v1/ws?token=bad") {
      sock.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    if (req.url?.startsWith("/xiaoaixiaoai/v1/ws")) {
      wss.handleUpgrade(req, sock, head, (ws) => {
        ws.on("message", (data, isBinary) => {
          ws.send(isBinary ? Buffer.from([...(data as Buffer), 42]) : `echo:${data.toString()}`, { binary: isBinary });
        });
      });
    } else {
      sock.destroy();
    }
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  const upPort = (upstream.address() as { port: number }).port;
  const bridge = await startLocalWebBridge({
    relayServer: `http://127.0.0.1:${upPort}/xiaoaixiaoai`,
    webDir: webRoot,
    port: 0,
  });
  t.after(async () => {
    await bridge.close();
  });

  const base = `http://127.0.0.1:${bridge.port}`;

  const redirRoot = await fetch(`${base}/`, { redirect: "manual" });
  assert.equal(redirRoot.status, 302);
  assert.equal(redirRoot.headers.get("location"), "/app/");

  const idx = await fetch(`${base}/app/`);
  assert.equal(idx.status, 200);
  assert.match(await idx.text(), /LocalDesktop/);

  const js = await fetch(`${base}/app/assets/bundle.js`);
  assert.equal(js.status, 200);
  assert.equal(await js.text(), "window.__OK__=1;");

  const traversal = await fetch(`${base}/app/%2e%2e/secret`);
  assert.notEqual(traversal.status, 200);

  const health = await fetch(`${base}/v1/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, via: "direct-upstream" });

  const echo = await fetch(`${base}/v1/echo`, {
    method: "POST",
    headers: { Authorization: "Bearer tok-123", "Content-Type": "application/json" },
    body: JSON.stringify({ hi: "爱弥斯" }),
  });
  assert.equal(echo.status, 200);
  assert.deepEqual(await echo.json(), { auth: "Bearer tok-123", body: JSON.stringify({ hi: "爱弥斯" }) });

  // Text & binary WebSocket roundtrip
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/ws?token=tok-123`);
  await new Promise<void>((r, rej) => {
    ws.once("open", () => r());
    ws.once("error", rej);
  });
  ws.send("hello");
  const textReply = await new Promise<string>((r) => ws.once("message", (d) => r(d.toString())));
  assert.equal(textReply, "echo:hello");

  ws.send(Buffer.from([1, 2, 3]), { binary: true });
  const binReply = await new Promise<Buffer>((r) => ws.once("message", (d) => r(d as Buffer)));
  assert.deepEqual([...binReply], [1, 2, 3, 42]);
  ws.close();

  // Upstream 401 rejection propagates cleanly before WS upgrade
  const badWs = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/ws?token=bad`);
  const badStatus = await new Promise<number>((resolveStatus, rejectStatus) => {
    badWs.once("unexpected-response", (_r, res) => resolveStatus(res.statusCode ?? 0));
    badWs.once("error", rejectStatus);
  });
  assert.equal(badStatus, 401);
});

test("resolveLocalWebPort supports default, custom ports, and disabling", () => {
  assert.equal(resolveLocalWebPort(undefined), 18546);
  assert.equal(resolveLocalWebPort("off"), null);
  assert.equal(resolveLocalWebPort("0"), null);
  assert.equal(resolveLocalWebPort("19000"), 19000);
});
