import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { Host } from "../src/host.ts";

/** Resolves when `check` turns true, polling every 20 ms; rejects after `ms`. */
async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A relay stand-in: answers the first `fail` upgrades the way a proxy does while the relay restarts. */
function fakeRelay(fail: number, autoPong = true) {
  const wss = new WebSocketServer({ noServer: true, autoPong });
  let upgrades = 0;
  let opened = 0;
  const server: Server = createServer();
  server.on("upgrade", (req, socket, head) => {
    upgrades++;
    if (upgrades <= fail) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, () => {
      opened++;
    });
  });
  return {
    server,
    get upgrades() {
      return upgrades;
    },
    get opened() {
      return opened;
    },
    async listen(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.closeAllConnections();
      server.close();
    },
  };
}

function host(server: string) {
  const logs: string[] = [];
  const h = new Host({ config: { server, token: "t", deviceId: "d", name: "test" }, log: (m) => logs.push(m) });
  return { h, logs, connect: () => (h as unknown as { connect(): void }).connect() };
}

test("a 502 while the relay restarts is retried instead of hanging", async () => {
  const relay = fakeRelay(2);
  const { h, logs, connect } = host(await relay.listen());
  try {
    connect();
    // Backoff is 1 s then 2 s: two failures and the third attempt connects within about 3 s.
    await until(() => h.connected, 6000, "reconnect after two 502s");
    assert.equal(relay.upgrades, 3);
    assert.ok(logs.filter((l) => l === "relay answered 502").length === 2, logs.join("\n"));
  } finally {
    h.stop();
    relay.close();
  }
});

test("a relay that stops answering pings is dropped and reconnected", async () => {
  const relay = fakeRelay(0, false);
  const { h, logs, connect } = host(await relay.listen());
  h.heartbeatMs = 100;
  try {
    connect();
    await until(() => relay.opened >= 2, 4000, "a second connection after silent pings");
    assert.ok(logs.includes("relay stopped answering, reconnecting"), logs.join("\n"));
  } finally {
    h.stop();
    relay.close();
  }
});

test("a revoked token stops retrying", async () => {
  const server = createServer();
  let upgrades = 0;
  server.on("upgrade", (_req, socket) => {
    upgrades++;
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { h, logs, connect } = host(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  try {
    connect();
    await until(() => logs.some((l) => l.includes("rejected this computer's token")), 3000, "401 log");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(upgrades, 1);
    assert.equal(h.connected, false);
  } finally {
    h.stop();
    server.closeAllConnections();
    server.close();
  }
});
