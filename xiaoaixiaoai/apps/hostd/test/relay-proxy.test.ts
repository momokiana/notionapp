import assert from "node:assert/strict";
import { test } from "node:test";
import { localRelayProxy } from "../src/relay-proxy.ts";

const RELAY = "https://xiaoaixiaoai.example.com/prefix";

test("relay proxy is opt-in, loopback only, and only for a credential-free HTTPS relay URL", () => {
  assert.equal(localRelayProxy(undefined, RELAY), undefined);
  for (const proxy of ["http://localhost:80", "http://127.0.0.2:80", "http://example.com:80", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:80/path", "http://user@127.0.0.1:80", "socks5://127.0.0.1:1080"]) {
    assert.throws(() => localRelayProxy(proxy, RELAY), /--relay-proxy requires http:/);
  }
  for (const relay of ["http://127.0.0.1:1000", "https://user:password@example.com", "https://example.com/#fragment", "https://example.com/?query=x"]) {
    assert.throws(() => localRelayProxy("http://127.0.0.1:8080", relay), /--relay-proxy requires the registered HTTPS relay/);
  }
});

test("explicit proxy agent keeps certificate verification enabled and does not change global settings", () => {
  const prior = process.env.HTTPS_PROXY;
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!major || major < 24 || (major === 24 && (minor ?? 0) < 5)) {
    assert.throws(() => localRelayProxy("http://127.0.0.1:8080", RELAY), /requires Node 24\.5/);
    return;
  }
  const agent = localRelayProxy("http://127.0.0.1:8080", RELAY)!;
  try {
    assert.equal(agent.options.rejectUnauthorized, true);
    assert.equal(process.env.HTTPS_PROXY, prior);
  } finally { agent.destroy(); }
});
