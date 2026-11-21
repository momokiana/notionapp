import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { agentKey, type Agent } from "@xiaoaixiaoai/protocol";
import type { Llm } from "../src/assistant/llm.ts";
import { Relay } from "../src/server.ts";
import { adminPage } from "../src/admin.ts";

const ADMIN = "diag-admin-token";
let dir = "";
let relay: Relay;
let base = "";

let lastProbeMaxTokens = 0;
const mockLlm: Llm = async (req) => {
  lastProbeMaxTokens = req.maxTokens ?? 0;
  return {
    content: [{ type: "text", text: "OK" }],
    stopReason: "end_turn",
    model: "mock-fast",
  };
};

async function req(path: string, token?: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: res.status, headers: res.headers, text, json };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "xa-diag-test-"));
  relay = new Relay({
    dbPath: join(dir, "relay.db"),
    adminToken: ADMIN,
    llm: mockLlm,
    assistantTiming: { doneDelayMs: 25, blockedDelayMs: 20, minTurnMs: 45_000, deskTurnMs: 180_000 },
    log: () => {},
  });
  const port = await relay.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

test("adminPage HTML serves valid CSP and syntax-clean inline script", async () => {
  const html = adminPage();
  const match = /<script>\s*([\s\S]*?)\s*<\/script>/.exec(html);
  assert.ok(match?.[1], "expected inline script inside adminPage()");
  // Prove inline script compiles with zero SyntaxError under Node's parser.
  assert.doesNotThrow(() => new Function(match[1]!));

  const res = await req("/admin");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(res.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
  assert.match(res.text, /导出 AI 排障包/);
  assert.match(res.text, /一键测速/);
});

test("diagnostics endpoints enforce auth boundaries, probe models, capture tri-tier logs, and redact secrets", async () => {
  const codeHost = await req("/v1/pair/codes", ADMIN, { body: { kind: "host" } });
  const host = (await req("/v1/pair", undefined, { body: { kind: "host", code: codeHost.json.code, name: "Win Workstation" } })).json;
  const codePhone = await req("/v1/pair/codes", ADMIN, { body: { kind: "viewer" } });
  const phone = (await req("/v1/pair", undefined, { body: { kind: "viewer", code: codePhone.json.code, name: "OPPO Phone" } })).json;

  // Unauthenticated access rejected.
  assert.equal((await req("/v1/admin/agents")).status, 401);
  assert.equal((await req("/v1/admin/probe", undefined, { method: "POST", body: {} })).status, 401);
  assert.equal((await req("/v1/diagnostics")).status, 401);

  // Admin-only routes reject device tokens, while /v1/diagnostics permits paired devices.
  assert.equal((await req("/v1/admin/agents", host.token)).status, 401);
  assert.equal((await req("/v1/admin/probe", phone.token, { method: "POST", body: {} })).status, 401);

  // Connect fake host WS and publish an agent transitioning working -> done quickly (triggers debug wake ignore log).
  const ws = new WebSocket(`${base.replace("http", "ws")}/v1/ws?token=${encodeURIComponent(host.token)}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const agentKeyStr = agentKey(host.device.id, "runtime", "runtime:codex:p1:s1");
  const mkAgent = (status: Agent["status"]): Agent => ({
    key: agentKeyStr,
    deviceId: host.device.id,
    source: "runtime",
    localId: "runtime:codex:p1:s1",
    harness: "codex",
    title: "Fix Logs",
    where: "D:\\repo",
    status,
    statusSince: Date.now() - 1000,
    updatedAt: Date.now(),
    isShell: false,
    model: "gpt-5.4",
    contextTokens: 120_000,
    contextLimit: 400_000,
    preview: "Checking token Bearer secret-leak-1234567890",
  });
  ws.send(JSON.stringify({ type: "agents", agents: [mkAgent("working")] }));
  await new Promise((r) => setTimeout(r, 25));
  ws.send(JSON.stringify({ type: "agents", agents: [mkAgent("done")] }));
  await new Promise((r) => setTimeout(r, 30));

  // Upload host & mobile logs.
  ws.send(JSON.stringify({
    type: "log",
    entries: [{ ts: Date.now(), level: "debug", kind: "runtime", msg: "status working -> done", data: { agent: agentKeyStr, turn: 1 } }],
  }));
  const phoneUpload = await req("/v1/logs", phone.token, {
    body: {
      entries: [{ ts: Date.now(), level: "warn", kind: "app", msg: "notify reconnect retry", data: { agent: agentKeyStr } }],
    },
  });
  assert.equal(phoneUpload.status, 200);
  await new Promise((r) => setTimeout(r, 40));

  // Probe models.
  const probe = await req("/v1/admin/probe", ADMIN, { method: "POST", body: {} });
  assert.equal(probe.status, 200);
  assert.equal(probe.json.results.length, 1);
  assert.equal(probe.json.results[0].ok, true);
  assert.equal(probe.json.results[0].reply, "OK");
  assert.ok(lastProbeMaxTokens >= 256);

  // Overview + admin/agents check.
  const ov = await req("/v1/admin/overview", ADMIN);
  assert.equal(ov.status, 200);
  assert.equal(ov.json.board.done, 1);
  assert.equal(typeof ov.json.notifySubs, "number");
  assert.equal(typeof ov.json.ledger.enabled, "boolean");

  const ag = await req("/v1/admin/agents", ADMIN);
  assert.equal(ag.status, 200);
  assert.equal(ag.json.agents.length, 1);
  assert.equal(ag.json.agents[0].deviceName, "Win Workstation");
  assert.doesNotMatch(ag.json.agents[0].preview, /secret-leak-1234567890/);
  assert.match(ag.json.agents[0].preview, /Bearer \*\*\*/);

  // Paired host can pull agent-scoped Markdown diagnostics bundle cleanly.
  const md = await req(`/v1/diagnostics?agent=${encodeURIComponent(agentKeyStr)}&format=markdown&since=1h`, host.token);
  assert.equal(md.status, 200);
  assert.match(md.headers.get("content-type") ?? "", /^text\/markdown/);
  assert.match(md.text, /# 小爱小爱 Tri-Tier Diagnostics Bundle/);
  assert.match(md.text, /## Agents \(1\)/);
  assert.match(md.text, /ignored stop \(runtime_short\)/);
  assert.match(md.text, /status working -> done/);
  assert.match(md.text, /notify reconnect retry/);
  assert.doesNotMatch(md.text, /secret-leak-1234567890/);

  // Paired host can pull JSON bundle with source counts across relay + host + viewer.
  const jb = await req(`/v1/diagnostics?agent=${encodeURIComponent(agentKeyStr)}&since=1h`, host.token);
  assert.equal(jb.status, 200);
  assert.ok(jb.json.summary.bySource.relay >= 1);
  assert.ok(jb.json.summary.bySource.host >= 1);
  assert.ok(jb.json.summary.bySource.viewer >= 1);

  ws.close();
});
