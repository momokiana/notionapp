import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { credentials, eventInput, responseInput } from './helpers.js';

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return address.port;
}

test('C07/C12: actual HTTP process survives abrupt restart, replays original IDs and sanitizes logs', { timeout: 40000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'notification-process-'));
  const config = credentials();
  const tokens = Object.fromEntries(config.principals.map(p => [p.id, p.token]));
  const authFile = join(root, 'credentials.json'); writeFileSync(authFile, JSON.stringify(config), { mode: 0o600 });
  const children: { child: ChildProcess; closed: Promise<unknown[]> }[] = [];
  let logs = '';
  const start = async (portText?: string) => {
    const port = portText ?? String(await freePort());
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: port, DATABASE_PATH: join(root, 'ledger.sqlite'), AUTH_FILE: authFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close'); children.push({ child, closed });
    let resolveReady!: () => void;
    const ready = new Promise<void>(resolve => { resolveReady = resolve; });
    child.stdout.on('data', (chunk: Buffer) => { logs += chunk.toString(); if (chunk.toString().includes('Notification service listening')) resolveReady(); });
    child.stderr.on('data', (chunk: Buffer) => { logs += chunk.toString(); });
    if (portText) return { child, closed, address: '' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ready, closed.then(() => { throw new Error('Isolated server exited before ready'); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Isolated server startup timed out')), 15000); })]);
    } finally { clearTimeout(timer); }
    return { child, closed, address: `http://127.0.0.1:${port}` };
  };
  try {
    const first = await start();
    const request = async (address: string, method: string, path: string, input?: object, actor = 'source') => {
      const response = await fetch(`${address}/v1${path}`, { method, headers: { authorization: `Bearer ${tokens[actor]}`, 'content-type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(5000) });
      return { status: response.status, data: await response.json() as any };
    };
    const input = eventInput({ expires_at: new Date(Date.now() + 3600000).toISOString(), body: 'private_fixture_body_not_for_logs' });
    const created = await request(first.address, 'POST', '/events', input); assert.equal(created.status, 200);
    const id = created.data.event_id as string; const responseInputValue = responseInput({ text: 'private_fixture_reply_not_for_logs' });
    const saved = await request(first.address, 'POST', `/events/${id}/responses`, responseInputValue, 'user'); assert.equal(saved.status, 200);
    assert.equal((await request(first.address, 'PUT', `/events/${id}/read-state`, { event_version: 2 }, 'user')).status, 200);
    assert.equal((await request(first.address, 'GET', `/events?token=${tokens.source}&private_path=${encodeURIComponent(root)}`)).status, 422);
    first.child.kill('SIGKILL'); assert.deepEqual(await first.closed, [null, 'SIGKILL']);
    const second = await start();
    const event = await request(second.address, 'GET', `/events/${id}`, undefined, 'device2');
    assert.equal(event.status, 200); assert.equal(event.data.reserved_response_id, responseInputValue.response_id);
    assert.equal(event.data.read_state.version, 2); assert.equal(event.data.read_state.unread, false);
    assert.deepEqual(await request(second.address, 'POST', '/events', input), created);
    assert.deepEqual(await request(second.address, 'POST', `/events/${id}/responses`, responseInputValue, 'user'), saved);
    const occupied = await request(second.address, 'POST', `/events/${id}/responses`, responseInput({ event_version: 2 }), 'device2');
    assert.equal(occupied.status, 409); assert.equal(occupied.data.error.code, 'ACTION_ALREADY_RESERVED');
    const history = await request(second.address, 'GET', `/events/${id}/history`, undefined, 'user');
    assert.deepEqual(history.data.items.map((i: { kind: string }) => i.kind), ['event_created', 'response_saved']);
    const view = await request(second.address, 'GET', `/responses/${responseInputValue.response_id}`);
    assert.equal(view.data.routing_state, 'waiting_source'); assert.equal(view.data.execution_authorized, false);
    second.child.kill('SIGTERM'); assert.deepEqual(await second.closed, [0, null]);
    const invalid = await start('not-a-port'); assert.deepEqual(await invalid.closed, [1, null]);
    assert.match(logs, /STARTUP_FAILED/);
    for (const secret of [...Object.values(tokens), root, input.body, input.session_ref, responseInputValue.text]) assert.equal(logs.includes(secret), false);
  } finally {
    for (const p of children) if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGTERM');
    await Promise.all(children.map(p => p.closed));
    rmSync(root, { recursive: true, force: true });
  }
});
