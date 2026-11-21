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
import { loadModelSetup } from "../src/config.ts";

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
  assert.match(res.text, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  assert.doesNotMatch(res.text, /class="tab-view"[^>]*style="[^"]*display:/);
  assert.match(res.text, /导出 AI 排障包/);
  assert.match(res.text, /全部测速/);
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

test("runtime model/provider overrides persist across restarts, mask keys, fetch upstream models, and hot-swap active models", async () => {
  const { createServer } = await import("node:http");
  const upstreamCalls: string[] = [];
  const fakeUpstream = createServer((req, res) => {
    upstreamCalls.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
    if (req.url === "/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "alpha-fast" }, { id: "alpha-pro" }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => fakeUpstream.listen(0, "127.0.0.1", r));
  const addr = fakeUpstream.address() as { port: number };
  const fakeBase = `http://127.0.0.1:${addr.port}`;

  const d2 = mkdtempSync(join(tmpdir(), "xa-modelcfg-test-"));
  const dbPath = join(d2, "relay.db");
  const baseTargets = [
    { provider: "deepseek", protocol: "openai" as const, baseUrl: "https://api.deepseek.com", apiKey: "sk-server-key-9876", model: "deepseek-flash" },
    { provider: "deepseek", protocol: "openai" as const, baseUrl: "https://api.deepseek.com", apiKey: "sk-server-key-9876", model: "deepseek-v4-pro" },
  ];
  let r1: Relay | undefined;
  let r2: Relay | undefined;
  try {
    r1 = new Relay({ dbPath, adminToken: ADMIN, assistant: { targets: baseTargets }, log: () => {} });
    const p1 = await r1.listen(0, "127.0.0.1");
    const u1 = `http://127.0.0.1:${p1}`;
    const hdr = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };

    // Pair viewer to confirm admin-only guard.
    const pc = await (await fetch(`${u1}/v1/pair/codes`, { method: "POST", headers: hdr, body: JSON.stringify({ kind: "viewer" }) })).json() as any;
    const phone = await (await fetch(`${u1}/v1/pair`, { method: "POST", headers: hdr, body: JSON.stringify({ kind: "viewer", code: pc.code, name: "P" }) })).json() as any;
    assert.equal((await fetch(`${u1}/v1/admin/models`, { headers: { authorization: `Bearer ${phone.token}` } })).status, 401);

    // Initial view masks server key and reflects defaults.
    const init = await (await fetch(`${u1}/v1/admin/models`, { headers: hdr })).json() as any;
    assert.equal(init.modified, false);
    assert.equal(init.providers.length, 1);
    assert.equal(init.providers[0].maskedKey, "…9876");
    assert.doesNotMatch(JSON.stringify(init), /sk-server-key-9876/);
    assert.equal(init.order[0].model, "deepseek-flash");

    // Add console provider, fetch its models, and promote alpha-pro to primary.
    const up = await fetch(`${u1}/v1/admin/models/provider`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ id: "alpha", label: "Alpha Gateway", protocol: "openai", baseUrl: fakeBase, apiKey: "sk-alpha-secret-4321" }),
    });
    assert.equal(up.status, 200);
    const upJson = await up.json() as any;
    assert.equal(upJson.modified, true);
    assert.equal(upJson.providers.find((x: any) => x.id === "alpha").maskedKey, "…4321");
    assert.doesNotMatch(JSON.stringify(upJson), /sk-alpha-secret-4321/);

    const fetched = await (await fetch(`${u1}/v1/admin/models/fetch`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ provider: "alpha" }),
    })).json() as any;
    assert.deepEqual(fetched.models, ["alpha-fast", "alpha-pro"]);
    assert.match(upstreamCalls[0] ?? "", /Bearer sk-alpha-secret-4321/);

    const reordered = await (await fetch(`${u1}/v1/admin/models/order`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({
        order: [
          { provider: "alpha", model: "alpha-pro" },
          { provider: "deepseek", model: "deepseek-flash" },
        ],
      }),
    })).json() as any;
    assert.equal(reordered.order[0].model, "alpha-pro");
    assert.equal(reordered.order[0].isPrimary, true);

    const ov1 = await (await fetch(`${u1}/v1/admin/overview`, { headers: hdr })).json() as any;
    assert.deepEqual(ov1.assistant.models, ["alpha:alpha-pro", "deepseek:deepseek-flash"]);
    assert.equal(r1.assistant.state().model, "alpha-pro");

    await r1.close();
    r1 = undefined;

    // Restart relay with same DB + env defaults: SQLite override persists!
    r2 = new Relay({ dbPath, adminToken: ADMIN, assistant: { targets: baseTargets }, log: () => {} });
    const p2 = await r2.listen(0, "127.0.0.1");
    const u2 = `http://127.0.0.1:${p2}`;
    assert.equal(r2.assistant.state().model, "alpha-pro");
    const afterRestart = await (await fetch(`${u2}/v1/admin/models`, { headers: hdr })).json() as any;
    assert.equal(afterRestart.modified, true);
    assert.equal(afterRestart.order[0].model, "alpha-pro");

    // Reset back to server defaults.
    const reset = await (await fetch(`${u2}/v1/admin/models/reset`, { method: "POST", headers: hdr, body: "{}" })).json() as any;
    assert.equal(reset.modified, false);
    assert.equal(reset.order[0].model, "deepseek-flash");
    assert.equal(r2.assistant.state().model, "deepseek-flash");
  } finally {
    if (r1) await r1.close();
    if (r2) await r2.close();
    fakeUpstream.close();
    rmSync(d2, { recursive: true, force: true });
  }
});

test("server-configured gpt-login stays available in /admin even when deepseek is active default", async () => {
  const setup = loadModelSetup({
    POCKET_ASSISTANT_PROVIDER: "deepseek",
    POCKET_ASSISTANT_MODELS: "deepseek:deepseek-flash",
    POCKET_DEEPSEEK_API_KEY: "sk-ds-fixture-9999",
    POCKET_GPT_LOGIN_CREDENTIALS_FILE: "/var/lib/xiaoaixiaoai/model-auth/auth.json",
    POCKET_GPT_LOGIN_REASONING: "low",
  });
  assert.deepEqual(setup.errors, []);
  assert.equal(setup.assistant?.targets.length, 1);
  assert.equal(setup.extraProviders?.length, 1);
  assert.equal(setup.extraProviders?.[0]?.provider, "gpt-login");

  const d3 = mkdtempSync(join(tmpdir(), "xa-gptcfg-test-"));
  const r3 = new Relay({
    dbPath: join(d3, "relay.db"),
    adminToken: ADMIN,
    assistant: { ...setup.assistant!, providers: setup.extraProviders },
    log: () => {},
  });
  try {
    const p3 = await r3.listen(0, "127.0.0.1");
    const u3 = `http://127.0.0.1:${p3}`;
    const hdr = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };

    const view = await (await fetch(`${u3}/v1/admin/models`, { headers: hdr })).json() as any;
    const gpt = view.providers.find((p: any) => p.id === "gpt-login");
    assert.ok(gpt, "gpt-login should appear in providers list");
    assert.equal(gpt.protocol, "pi-openai-oauth");
    assert.equal(gpt.readOnly, true);

    const cat = await (await fetch(`${u3}/v1/admin/models/fetch`, { method: "POST", headers: hdr, body: JSON.stringify({ provider: "gpt-login" }) })).json() as any;
    assert.ok(Array.isArray(cat.models) && cat.models.includes("gpt-6-sol"));

    const sw = await (await fetch(`${u3}/v1/admin/models/order`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ order: [{ provider: "gpt-login", model: "gpt-6-sol" }, { provider: "deepseek", model: "deepseek-flash" }] }),
    })).json() as any;
    assert.equal(sw.order[0].provider, "gpt-login");
    assert.equal(r3.assistant.state().model, "gpt-6-sol");
  } finally {
    await r3.close();
    rmSync(d3, { recursive: true, force: true });
  }
});
