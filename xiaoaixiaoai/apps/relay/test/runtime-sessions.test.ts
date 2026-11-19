import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import type { RpcMethod, ServerFrame } from "@xiaoaixiaoai/protocol";
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
