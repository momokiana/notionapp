import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import type { Agent, RpcMethod, ServerFrame } from "@xiaoaixiaoai/protocol";
import { Relay } from "../src/server.ts";
import { Host } from "../../hostd/src/host.ts";
import { loadRuntimeSessions } from "../../hostd/src/runtime-sessions.ts";

const timeout = { timeout: 12_000, skip: process.platform !== "linux" && "Requires a local DSH Unix socket" };

test("an authenticated phone browses and writes only its approved DSH targets through an unchanged relay wire", timeout, async (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "xa-e2e-"));
  const cleanup: Array<() => unknown | Promise<unknown>> = [() => rmSync(dir, { recursive: true, force: true })];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const socketPath = join(dir, "dsh.sock");
  const sessionId = "dsh-test-1";
  const projectId = "workspace-test-1";
  const promptText = "TEST_ONLY_DO_NOT_LOG_测试任务";
  const agent = { id: sessionId, status: "idle", session: { id: sessionId, header: { id: sessionId } } };
  const prompts: object[] = [];
  const mockDsh = {
    workspaceRegistry: { get: (id: string) => id === projectId ? project : undefined, archivedSessionIds: [] },
    agents: { roots: () => [agent], get: (id: string) => id === sessionId ? agent : undefined },
    sessionController: {
      list: async () => ({ items: [
        { sessionId, running: agent.status === "running", blank: false, agentAvailable: true, formatStatus: "current", cwd: "/PRIVATE_LOCAL", projections: { values: { title: "原有测试会话", body: "PRIVATE_HISTORY" } } },
        { sessionId: "dsh-other", running: true, blank: false, agentAvailable: true, formatStatus: "current", projections: { values: { title: "UNSHARED_PROJECT" } } },
      ] }),
      prompt: async (p: object) => { prompts.push(p); agent.status = "running"; return { accepted: true }; },
    },
  };
  const project = { id: projectId, title: "隔离工程", sessionIds: [sessionId] };
  const bridgePath = "../../hostd/integrations/dsh/index.mjs";
  const bridge = (await import(bridgePath)).default;
  const closeBridge: () => Promise<void> = await bridge.apply(mockDsh, { socketPath, workspaceIds: [projectId], enableSend: true, sendAllowlist: [{ workspaceId: projectId, sessionId }] });
  cleanup.push(closeBridge);
  const admin = "test-only-private-admin-placeholder";
  // Optional compatibility run against a checksum-verified, unpacked legacy artifact.
  const fixturePath = process.env.XIAOAI_TEST_FROZEN_RELAY;
  const RelayFixture: typeof Relay = fixturePath ? (await import(pathToFileURL(fixturePath).href)).Relay : Relay;
  const relay = new RelayFixture({ dbPath: join(dir, "test.db"), adminToken: admin, rpcTimeoutMs: 3000, log: () => {} });
  const server = `http://127.0.0.1:${await relay.listen(0, "127.0.0.1")}`;
  cleanup.push(() => relay.close());
  async function pair(kind: "host" | "viewer", name: string) {
    const c = await fetch(server + "/v1/pair/codes", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${admin}` }, body: JSON.stringify({ kind }) });
    assert.equal(c.status, 200);
    const p = await fetch(server + "/v1/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: (await c.json()).code, kind, name }) });
    assert.equal(p.status, 200);
    return await p.json() as { token: string; device: { id: string } };
  }
  const [viewer, other, pc] = [await pair("viewer", "同意的测试手机"), await pair("viewer", "未授权手机"), await pair("host", "隔离 WSL")];
  const readOnlyPc = await pair("host", "只读测试主机");
  const cfg = join(dir, "runtime.json");
  writeFileSync(cfg, JSON.stringify({ viewerId: viewer.device.id, dsh: { socketPath } }), { mode: 0o600 });
  function makeHost(device: typeof pc, name: string, readOnly = false) {
    const host = new Host({ config: { server, token: device.token, deviceId: device.device.id, name }, readOnly, runtimeOnly: true, runtimeSessions: loadRuntimeSessions(cfg), log: () => {} });
    host.logEveryMs = 10_000;
    host.hc.available = host.herdr.available = host.uniflo.available = async () => assert.fail("runtime-only must not enumerate terminal or history sources");
    cleanup.push(() => host.stop());
    return host;
  }
  const host = makeHost(pc, "隔离 WSL");
  const readOnlyHost = makeHost(readOnlyPc, "只读测试主机", true);
  const clients = new Set<WebSocket>();
  cleanup.push(() => { for (const s of clients) s.terminate(); });
  async function phone(token: string) {
    const ws = new WebSocket(server.replace("http:", "ws:") + "/v1/ws", { headers: { authorization: `Bearer ${token}` } });
    clients.add(ws);
    const frames: ServerFrame[] = [];
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    async function wait<F extends ServerFrame>(pred: (f: ServerFrame) => boolean): Promise<F> {
      for (let i = 0; i < 150; i++) {
        const j = frames.findIndex(pred);
        if (j >= 0) return frames.splice(j, 1)[0] as F;
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.fail("missing fixture frame");
    }
    await wait((f) => f.type === "snapshot");
    return { ws, frames, wait, async rpc(method: RpcMethod, params: unknown, to = pc.device.id) {
      const id = randomUUID();
      ws.send(JSON.stringify({ type: "rpc", id, to, from: viewer.device.id, method, params }));
      return wait<Extract<ServerFrame, { type: "rpc_result" }>>((f) => f.type === "rpc_result" && f.id === id);
    } };
  }
  const good = await phone(viewer.token);
  const stranger = await phone(other.token);
  await Promise.all([host.start(), readOnlyHost.start()]);
  await good.wait((f) => f.type === "device" && f.device.id === pc.device.id && f.device.sources?.includes("runtime-sessions") === true);
  await good.wait((f) => f.type === "device" && f.device.id === readOnlyPc.device.id && f.device.sources?.includes("dsh-directory") === true);
  const first = await good.rpc("runtimeSessions.list", {});
  assert.deepEqual(first.result, { runtimes: [{ runtime: "dsh", online: true }], projects: [{ runtime: "dsh", id: projectId, title: "隔离工程", sessions: [{ id: sessionId, title: "原有测试会话", state: "idle", canSend: true }] }] });
  assert.equal((await stranger.rpc("runtimeSessions.list", {})).error?.code, "forbidden", "forged from does not grant access");

  const entry = {
    project: { id: projectId, title: "隔离工程" },
    session: { id: sessionId, title: "原有测试会话", state: "idle", canSend: true }, archived: false,
  };
  const masked = { ...entry, session: { ...entry.session, canSend: false } };
  for (const query of [
    { view: "sessions", projectId, search: "原有测试会话" },
    { view: "exact", sessionIds: [sessionId, "dsh-other"] },
  ]) {
    const page = await good.rpc("runtimeSessions.browse", query);
    assert.equal(page.error, undefined);
    assert.deepEqual(page.result, { view: query.view, scope: "selected", entries: [entry] });
    const readOnly = await good.rpc("runtimeSessions.browse", query, readOnlyPc.device.id);
    assert.equal(readOnly.error, undefined);
    assert.deepEqual(readOnly.result, { view: query.view, scope: "selected", entries: [masked] });
  }
  const privateSearch = { view: "sessions", projectId, search: "PRIVATE_BROWSE_FILTER" };
  assert.deepEqual((await good.rpc("runtimeSessions.browse", privateSearch)).result, { view: "sessions", scope: "selected", entries: [] });
  const forged = await stranger.rpc("runtimeSessions.browse", privateSearch);
  assert.equal(forged.error?.code, "forbidden", "browse uses the authenticated device, not the forged from field");
  assert.equal(forged.result, undefined);
  const privateExact = await stranger.rpc("runtimeSessions.browse", { view: "exact", sessionIds: [sessionId, "PRIVATE_EXACT_LOOKUP_ID"] }, readOnlyPc.device.id);
  assert.equal(privateExact.error?.code, "forbidden");
  assert.equal(privateExact.result, undefined);

  const p = { runtime: "dsh", projectId, sessionId, requestId: randomUUID(), input: promptText };
  assert.equal((await good.rpc("runtimeSessions.send", { ...p, requestId: randomUUID() }, readOnlyPc.device.id)).error?.code, "forbidden");
  assert.equal((await stranger.rpc("runtimeSessions.send", p)).error?.code, "forbidden");
  assert.equal((await good.rpc("terminal.read", { agent: sessionId })).error?.code, "unsupported");
  assert.equal((await good.rpc("runtimeSessions.send", { ...p, requestId: randomUUID(), sessionId: "dsh-other" })).error?.code, "forbidden");
  assert.deepEqual(prompts, []);
  const send = await good.rpc("runtimeSessions.send", p);
  assert.equal(send.error, undefined);
  assert.deepEqual(send.result, { accepted: true, requestId: p.requestId });
  assert.deepEqual((await good.rpc("runtimeSessions.send", p)).result, send.result);
  assert.deepEqual(prompts, [{ sessionId, requestId: p.requestId, mode: "queue", content: [{ type: "text", text: promptText }] }]);
  assert.match(JSON.stringify((await good.rpc("runtimeSessions.list", {})).result), /"state":"running"/);
  const browseSecrets = /PRIVATE_BROWSE_FILTER|PRIVATE_EXACT_LOOKUP_ID|workspace-test-1/;
  const strangerFrames = JSON.stringify(stranger.frames);
  assert.doesNotMatch(strangerFrames, /PRIVATE_HISTORY|原有测试会话|TEST_ONLY_DO_NOT_LOG|dsh-test-1/);
  assert.doesNotMatch(strangerFrames, browseSecrets);
  const logs = JSON.stringify([host.logs.take(200), readOnlyHost.logs.take(200)]);
  assert.doesNotMatch(logs, /TEST_ONLY_DO_NOT_LOG|UNSHARED_PROJECT|PRIVATE_HISTORY/);
  assert.doesNotMatch(logs, browseSecrets);
  const relayLogs = await fetch(server + "/v1/logs", { headers: { authorization: `Bearer ${admin}` } });
  assert.equal(relayLogs.status, 200);
  const audit = await relayLogs.text();
  assert.match(audit, /runtimeSessions\.browse/);
  assert.doesNotMatch(audit, /TEST_ONLY_DO_NOT_LOG|UNSHARED_PROJECT|PRIVATE_HISTORY|原有测试会话/);
  assert.doesNotMatch(audit, browseSecrets);
});

test("relay exposes runtimeSessions.detail/answer, runtime-detail capability, and safe /v1/releases asset downloads", timeout, async (t) => {
  const { mkdirSync, symlinkSync } = await import("node:fs");
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "xa-e2e-v4-"));
  const cleanup: Array<() => unknown | Promise<unknown>> = [() => rmSync(dir, { recursive: true, force: true })];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });

  const releasesDir = join(dir, "releases");
  mkdirSync(releasesDir);
  const apkName = "xiaoaixiaoai-0.2.0-android-arm64.apk";
  const tarName = "xiaoaixiaoai-0.2.0.tar.gz";
  const outsideFile = join(dir, "secret.apk");
  writeFileSync(outsideFile, "SECRET_DO_NOT_SERVE");
  writeFileSync(join(releasesDir, apkName), "FAKE_APK_BINARY");
  writeFileSync(join(releasesDir, tarName), "FAKE_TAR_BINARY");
  writeFileSync(join(releasesDir, "SHA256SUMS"), `abc  ${apkName}\ndef  ${tarName}\n`);
  writeFileSync(join(releasesDir, "evil.apk"), "BAD_NAME");
  if (process.platform !== "win32") symlinkSync(outsideFile, join(releasesDir, "xiaoaixiaoai-9.9.9-android-arm64.apk"));

  const socketPath = join(dir, "dsh.sock");
  const sessionId = "dsh-detail-1";
  const projectId = "workspace-detail-1";
  const agent = { id: sessionId, status: "idle", session: { id: sessionId, header: { id: sessionId } } };
  const project = { id: projectId, title: "详情验证工程", sessionIds: [sessionId] };
  const answered: unknown[] = [];
  const mockDsh = {
    workspaceRegistry: { get: (id: string) => id === projectId ? project : undefined, archivedSessionIds: [] },
    agents: { roots: () => [agent], get: (id: string) => id === sessionId ? agent : undefined },
    get: (name: string) => name === "userQuestions" ? { answer: (_ag: unknown, callId: string, clean: unknown) => { answered.push({ callId, clean }); return true; } } : undefined,
    sessionController: {
      list: async () => ({ items: [{ sessionId, running: false, blank: false, agentAvailable: true, formatStatus: "current", projections: { values: { title: "详情会话" } } }] }),
      inspect: async () => ({
        events: [
          { type: "user/message", seq: 1, time: 1000, data: { source: { kind: "user" }, content: [{ type: "text", text: "PRIVATE_PHONE_QUESTION_TEXT" }] } },
          { type: "tool/ptc-dispatch", seq: 2, time: 2000, data: { name: "ask_user_question", subCallId: "e2e-call-1", content: [{ type: "text", text: JSON.stringify({ pending: true }) }], arguments: { questions: [{ id: "q1", question: "是否发布", options: [{ label: "是" }, { label: "否" }] }] } } },
        ],
      }),
      prompt: async () => ({ accepted: true }),
    },
  };

  const bridgePath = "../../hostd/integrations/dsh/index.mjs";
  const bridge = (await import(bridgePath)).default;
  const closeBridge: () => Promise<void> = await bridge.apply(mockDsh, { socketPath, workspaceIds: [projectId], enableSend: true, sendAllowlist: [{ workspaceId: projectId, sessionId }] });
  cleanup.push(closeBridge);

  const admin = "test-only-private-admin-placeholder-v4";
  const relay = new Relay({ dbPath: join(dir, "test.db"), adminToken: admin, releasesDir, rpcTimeoutMs: 3000, log: () => {} });
  const server = `http://127.0.0.1:${await relay.listen(0, "127.0.0.1")}`;
  cleanup.push(() => relay.close());

  async function pair(kind: "host" | "viewer", name: string) {
    const c = await fetch(server + "/v1/pair/codes", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${admin}` }, body: JSON.stringify({ kind }) });
    const p = await fetch(server + "/v1/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: (await c.json()).code, kind, name }) });
    return await p.json() as { token: string; device: { id: string } };
  }
  const [viewer, stranger, pc] = [await pair("viewer", "授权手机"), await pair("viewer", "陌生手机"), await pair("host", "主机")];
  const cfg = join(dir, "runtime.json");
  writeFileSync(cfg, JSON.stringify({ viewerId: viewer.device.id, dsh: { socketPath } }), { mode: 0o600 });
  const host = new Host({ config: { server, token: pc.token, deviceId: pc.device.id, name: "主机" }, runtimeOnly: true, runtimeSessions: loadRuntimeSessions(cfg), log: () => {} });
  host.logEveryMs = 10_000;
  host.hc.available = host.herdr.available = host.uniflo.available = async () => false;
  cleanup.push(() => host.stop());

  async function phone(token: string, fromId: string) {
    const ws = new WebSocket(server.replace("http:", "ws:") + "/v1/ws", { headers: { authorization: `Bearer ${token}` } });
    cleanup.push(() => { ws.terminate(); });
    const frames: ServerFrame[] = [];
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    async function wait<F extends ServerFrame>(pred: (f: ServerFrame) => boolean): Promise<F> {
      for (let i = 0; i < 150; i++) {
        const j = frames.findIndex(pred);
        if (j >= 0) return frames.splice(j, 1)[0] as F;
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.fail("missing fixture frame");
    }
    await wait((f) => f.type === "snapshot");
    return {
      frames,
      wait,
      async rpc(method: RpcMethod, params: unknown) {
        const id = randomUUID();
        ws.send(JSON.stringify({ type: "rpc", id, to: pc.device.id, from: fromId, method, params }));
        return wait<Extract<ServerFrame, { type: "rpc_result" }>>((f) => f.type === "rpc_result" && f.id === id);
      },
    };
  }

  const [good, bad] = [await phone(viewer.token, viewer.device.id), await phone(stranger.token, viewer.device.id)];
  await host.start();
  await good.wait((f) => f.type === "device" && f.device.id === pc.device.id && f.device.sources?.includes("runtime-detail") === true);

  assert.equal((await bad.rpc("runtimeSessions.detail", { runtime: "dsh", projectId, sessionId })).error?.code, "forbidden");
  assert.equal((await bad.rpc("runtimeSessions.answer", { runtime: "dsh", projectId, sessionId, requestId: randomUUID(), callId: "e2e-call-1", answers: [{ id: "q1", selected: ["是"] }] })).error?.code, "forbidden");

  const detail = await good.rpc("runtimeSessions.detail", { runtime: "dsh", projectId, sessionId, limit: 20 });
  assert.equal(detail.error, undefined);
  assert.equal((detail.result as { pendingQuestions: Array<{ callId: string }> }).pendingQuestions[0]!.callId, "e2e-call-1");

  const reqId = randomUUID();
  const ans = await good.rpc("runtimeSessions.answer", { runtime: "dsh", projectId, sessionId, requestId: reqId, callId: "e2e-call-1", answers: [{ id: "q1", selected: ["是"] }] });
  assert.deepEqual(ans.result, { accepted: true, requestId: reqId });
  assert.equal(answered.length, 1);

  assert.doesNotMatch(JSON.stringify(bad.frames), /PRIVATE_PHONE_QUESTION_TEXT/);
  assert.doesNotMatch(JSON.stringify(host.logs.take(200)), /PRIVATE_PHONE_QUESTION_TEXT/);

  // Relay release downloads
  const sumsRes = await fetch(`${server}/v1/releases/SHA256SUMS`);
  assert.equal(sumsRes.status, 200);
  assert.match(await sumsRes.text(), /xiaoaixiaoai-0\.2\.0-android-arm64\.apk/);
  const headTar = await fetch(`${server}/v1/releases/${tarName}`, { method: "HEAD" });
  assert.equal(headTar.status, 200);
  assert.equal(headTar.headers.get("content-length"), "15");
  const getApk = await fetch(`${server}/v1/releases/${apkName}`);
  assert.equal(getApk.status, 200);
  assert.equal(await getApk.text(), "FAKE_APK_BINARY");
  assert.equal((await fetch(`${server}/v1/releases/evil.apk`)).status, 404);
  assert.equal((await fetch(`${server}/v1/releases/%2e%2e/SHA256SUMS`)).status, 404);
  if (process.platform !== "win32") {
    assert.equal((await fetch(`${server}/v1/releases/xiaoaixiaoai-9.9.9-android-arm64.apk`)).status, 404);
  }
});

test("unified runtime pool publishes DSH and Antigravity agents to mobile and 爱弥斯 with read-only enforcement", timeout, async (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "xa-e2e-unified-"));
  const cleanup: Array<() => unknown | Promise<unknown>> = [() => rmSync(dir, { recursive: true, force: true })];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });

  const socketPath = join(dir, "dsh.sock");
  const sessionId = "dsh-uni-1";
  const projectId = "ws-uni-1";
  const agent = { id: sessionId, status: "idle", session: { id: sessionId, header: { id: sessionId } } };
  const project = { id: projectId, title: "核心后端", sessionIds: [sessionId] };
  const prompts: unknown[] = [];
  const answered: unknown[] = [];
  let pendingCall: string | null = "uni-call-1";
  const mockDsh = {
    workspaceRegistry: { list: () => [project], get: (id: string) => (id === projectId ? project : undefined), archivedSessionIds: [] },
    agents: { roots: () => [agent], get: (id: string) => (id === sessionId ? agent : undefined) },
    get: (name: string) => {
      if (name === "userQuestions") {
        return { answer: (_ag: unknown, callId: string, clean: unknown) => { answered.push({ callId, clean }); pendingCall = null; return true; } };
      }
      if (name === "sessionProjections") {
        return {
          stateOf: () => pendingCall
            ? { questions: { active: [{ callId: pendingCall, state: "continued", questions: [{ id: "q1", question: "采用哪种重试方案", options: [{ label: "方案A" }, { label: "方案B" }] }] }] } }
            : undefined,
        };
      }
      return undefined;
    },
    sessionController: {
      resolveAgent: async () => ({ agent }),
      list: async () => ({ items: [{ sessionId, running: agent.status === "running", blank: false, agentAvailable: true, formatStatus: "current", updatedAt: 50_000, projections: { values: { title: "接口优化" } } }] }),
      inspect: async () => ({
        events: [
          { type: "user/message", seq: 1, time: 1000, data: { source: { kind: "user" }, content: [{ type: "text", text: "请排查超时原因" }] } },
          ...(pendingCall
            ? [{ type: "tool/ptc-dispatch", seq: 2, time: 2000, data: { name: "ask_user_question", subCallId: pendingCall, content: [{ type: "text", text: JSON.stringify({ pending: true }) }], arguments: { questions: [{ id: "q1", question: "采用哪种重试方案", options: [{ label: "方案A" }, { label: "方案B" }] }] } } }]
            : []),
        ],
      }),
      prompt: async (p: unknown) => { prompts.push(p); agent.status = "running"; return { accepted: true }; },
    },
  };

  const bridgePath = "../../hostd/integrations/dsh/index.mjs";
  const bridge = (await import(bridgePath)).default;
  const closeBridge: () => Promise<void> = await bridge.apply(mockDsh, {
    socketPath,
    workspaceScope: "all",
    enableSend: true,
    sendScope: "profile",
    resumeExisting: true,
  });
  cleanup.push(closeBridge);

  const brainDir = join(dir, "brain");
  const agLogs = join(brainDir, "ag-uni-1", ".system_generated", "logs");
  mkdirSync(agLogs, { recursive: true });
  writeFileSync(join(agLogs, "transcript.jsonl"), `${[
    JSON.stringify({ type: "SYSTEM_MESSAGE", content: "<user_information>\nActive Workspaces:\n- D:\\work\\gamesuperagent\n</user_information>" }),
    JSON.stringify({ type: "USER_INPUT", created_at: "2026-11-20T01:00:00.000Z", content: "<USER_REQUEST>\n查看 gamesuperagent 规划\n</USER_REQUEST>" }),
    JSON.stringify({ type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-20T01:00:05.000Z", content: "已整理 gamesuperagent 第一阶段设计。" }),
  ].join("\n")}\n`);

  const admin = "test-only-unified-admin";
  const relay = new Relay({ dbPath: join(dir, "test.db"), adminToken: admin, rpcTimeoutMs: 3000, log: () => {} });
  const server = `http://127.0.0.1:${await relay.listen(0, "127.0.0.1")}`;
  cleanup.push(() => relay.close());

  async function pair(kind: "host" | "viewer", name: string) {
    const c = await fetch(server + "/v1/pair/codes", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${admin}` }, body: JSON.stringify({ kind }) });
    const p = await fetch(server + "/v1/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: (await c.json()).code, kind, name }) });
    return await p.json() as { token: string; device: { id: string } };
  }
  const [viewer, pc] = [await pair("viewer", "手机"), await pair("host", "统一桌面")];
  const cfg = join(dir, "runtime.json");
  writeFileSync(cfg, JSON.stringify({ viewerId: viewer.device.id, publishAgents: true, allowAssistant: true, dsh: { socketPath }, antigravity: { brainDir } }), { mode: 0o600 });

  const host = new Host({
    config: { server, token: pc.token, deviceId: pc.device.id, name: "统一桌面" },
    allow: [viewer.device.id, "assistant"],
    runtimeOnly: true,
    runtimeSessions: loadRuntimeSessions(cfg),
    log: () => {},
  });
  host.logEveryMs = 10_000;
  cleanup.push(() => host.stop());

  const ws = new WebSocket(server.replace("http:", "ws:") + "/v1/ws", { headers: { authorization: `Bearer ${viewer.token}` } });
  cleanup.push(() => { ws.terminate(); });
  const frames: ServerFrame[] = [];
  ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  async function wait<F extends ServerFrame>(pred: (f: ServerFrame) => boolean): Promise<F> {
    for (let i = 0; i < 150; i++) {
      const j = frames.findIndex(pred);
      if (j >= 0) return frames.splice(j, 1)[0] as F;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail("missing unified fixture frame");
  }
  async function rpc(method: RpcMethod, params: unknown) {
    const id = randomUUID();
    ws.send(JSON.stringify({ type: "rpc", id, to: pc.device.id, from: viewer.device.id, method, params }));
    return wait<Extract<ServerFrame, { type: "rpc_result" }>>((f) => f.type === "rpc_result" && f.id === id);
  }
  await wait((f) => f.type === "snapshot");
  await host.start();

  const agentsFrame = await wait<Extract<ServerFrame, { type: "agents" }>>((f) => f.type === "agents" && f.agents.some((a) => a.harness === "antigravity") && f.agents.some((a) => a.harness === "dsh"));
  const dshAgent = agentsFrame.agents.find((a) => a.harness === "dsh") as Agent;
  const agAgent = agentsFrame.agents.find((a) => a.harness === "antigravity") as Agent;
  assert.equal(dshAgent.source, "runtime");
  assert.equal(dshAgent.status, "blocked");
  assert.equal(dshAgent.canSend, true);
  assert.equal(agAgent.source, "runtime");
  assert.equal(agAgent.canSend, false);
  assert.equal(agAgent.where, "gamesuperagent");

  // 爱弥斯 resolves "反重力" directly and assistant search finds "反重力 gamesuperagent".
  assert.equal(relay.assistant.resolveAgent("反重力").key, agAgent.key);
  const searchRes = await relay.callHost(pc.device.id, "sessions.search", { q: "反重力 gamesuperagent" });
  assert.equal(searchRes.total, 1);
  assert.equal(searchRes.results[0]!.harness, "antigravity");

  // Mobile reads session.events (with pendingQuestions) and answers question + sends follow-up via unified terminal.send.
  const evRes = await rpc("session.events", { agent: dshAgent.key, limit: 20 });
  const evData = evRes.result as { events: unknown[]; pendingQuestions?: Array<{ callId: string }>; canSend?: boolean };
  assert.equal(evData.canSend, true);
  assert.equal(evData.pendingQuestions?.[0]?.callId, "uni-call-1");

  const ansSend = await rpc("terminal.send", { agent: dshAgent.key, text: "1" });
  assert.equal(ansSend.error, undefined);
  for (let i = 0; i < 40 && answered.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(answered.length, 1);

  const promptSend = await rpc("terminal.send", { agent: dshAgent.key, text: "继续执行测试" });
  assert.equal(promptSend.error, undefined);
  for (let i = 0; i < 40 && prompts.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(prompts.length, 1);

  // Antigravity rejects terminal.send even when called directly.
  const agBlocked = await rpc("terminal.send", { agent: agAgent.key, text: "不应该发送" });
  assert.equal(agBlocked.error?.code, "forbidden");
  const spaces = await rpc("spaces.list", {});
  assert.equal((spaces.result as { canCreate: boolean }).canCreate, false);
});
