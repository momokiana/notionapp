import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { parseRegistry } from '../src/auth.js';
import { openDatabase } from '../src/database.js';
import { DeviceStore } from '../src/device-store.js';
import { DeviceAuthority } from '../src/device-authority.js';
import { credentials, eventInput, responseInput, NOW, snapshot } from './helpers.js';

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
async function fixture(t: TestContext) {
  const root = mkdtempSync('/tmp/notifier-device-http-'); chmodSync(root, 0o700);
  const path = join(root, 'authority.sqlite'); const id = DeviceStore.initialize(path).store_id;
  const store = new DeviceStore(path, id); const config = credentials(); const authority = new DeviceAuthority(store, () => parseRegistry(config));
  const db = openDatabase(join(root, 'ledger.sqlite')); const app = createApp(db, false, { registry: authority.registry, now: () => NOW });
  t.after(async () => { await app.close(); store.close(); });
  const claim = (manager = false) => {
    const invitation = { request_id: randomUUID(), invitation_id: randomUUID(), secret: randomBytes(32).toString('hex'), owner_id: 'owner', label: 'HTTP phone', manage_devices: manager, expires_at: Date.now() + 60000 };
    store.createInvitation('operator', invitation); const token = randomBytes(32).toString('hex');
    const result = store.claim({ claim_id: randomUUID(), invitation_id: invitation.invitation_id, secret: invitation.secret, token }, authority.assertTokenAvailable);
    return { token, id: result.device_id };
  };
  const manager = claim(true);
  let port = 0;
  const start = async () => { const url = await app.listen({ host: '127.0.0.1', port: 0 }); port = Number(new URL(url).port); };
  const request = async (method: string, path: string, token: string, body?: object) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', connection: 'close' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any };
  };
  const event = async () => { const result = await request('POST', '/v1/events', config.principals.find(p => p.kind === 'source')!.token, eventInput()); assert.equal(result.status, 200); return result.data.event_id as string; };
  const revoker = async () => {
    const child = fork(fileURLToPath(new URL('./fixtures/device-process.ts', import.meta.url)), [], { execArgv: ['--import', new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href], stdio: ['ignore','ignore','ignore','ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
    const [ready] = await once(child, 'message'); assert.equal(ready.phase, 'ready');
    return (target: string, signals: Record<string, string> = {}) => {
      const done = once(child, 'message').then(([message]) => { assert.equal(message.phase, 'committed', 'Independent revocation must really commit'); return message; });
      child.send({ path, store_id: id, token: manager.token, request_id: randomUUID(), target, ...signals }); return done;
    };
  };
  return { root, store, db, app, claim, start, request, event, revoker };
}

test('real HTTP: revoke in another process after onRequest rejects all five original user write surfaces', { timeout: 30000 }, async t => {
  const f = await fixture(t); let target: { method: string; path: string; revoke: () => Promise<unknown> } | undefined;
  f.app.addHook('preHandler', async request => { if (target && request.method === target.method && request.url === target.path) { const selected = target; target = undefined; await selected.revoke(); } });
  await f.start(); const event = await f.event();
  const actions = [
    { method: 'POST', path: `/v1/events/${event}/responses`, body: responseInput() },
    { method: 'PUT', path: `/v1/events/${event}/read-state`, body: { event_version: 1 } },
    { method: 'POST', path: `/v1/events/${event}/disposition`, body: { request_id: randomUUID(), expected_event_version: 1, disposition: 'completed' } },
    { method: 'PUT', path: '/v1/device/push', body: { registration_id: randomUUID(), expected_generation: 0, endpoint: null } },
    { method: 'POST', path: '/v1/notifications/notice_fixture/receipt', body: { nonce: randomBytes(32).toString('hex'), state: 'device_received' } },
  ];
  const original = snapshot(f.db);
  for (const action of actions) {
    const phone = f.claim(); const revoke = await f.revoker(); target = { method: action.method, path: action.path, revoke: () => revoke(phone.id) };
    const result = await f.request(action.method, action.path, phone.token, action.body);
    assert.equal(result.status, 401, `${action.method} ${action.path}`); assert.equal(result.data.error.code, 'UNAUTHENTICATED');
    assert.deepEqual(snapshot(f.db), original);
  }
});

test('real HTTP: revocation beats idempotent old success without deleting the prior legitimate ledger facts', { timeout: 15000 }, async t => {
  const f = await fixture(t); let revoke: (() => Promise<unknown>) | undefined;
  f.app.addHook('preHandler', async request => { if (revoke && request.method === 'POST' && request.url.endsWith('/responses')) { const next = revoke; revoke = undefined; await next(); } });
  await f.start(); const event = await f.event(); const phone = f.claim(); const body = responseInput();
  assert.equal((await f.request('POST', `/v1/events/${event}/responses`, phone.token, body)).status, 200);
  const original = snapshot(f.db); const independent = await f.revoker(); revoke = () => independent(phone.id);
  const repeated = await f.request('POST', `/v1/events/${event}/responses`, phone.token, body); assert.equal(repeated.status, 401); assert.deepEqual(snapshot(f.db), original);
});

test('real HTTP: original user gate reservation blocks independent revocation until the legitimate ledger commit', { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.start(); const event = await f.event(); const phone = f.claim(); const revoke = await f.revoker();
  const entered = join(f.root, 'user-gate-held.signal'); const busy = join(f.root, 'real-sqlite-busy.signal'); const committed = join(f.root, 'revoker-committed.signal');
  f.db.function('probe_original_authority_gate', () => {
    writeFileSync(entered, 'held', { mode: 0o600, flag: 'wx' }); const deadline = Date.now() + 6000;
    while (!existsSync(busy)) { if (Date.now() > deadline) throw new Error('Independent SQLite busy proof did not arrive'); pause(10); }
    assert.equal(existsSync(committed), false); pause(100); assert.equal(existsSync(committed), false); return 1;
  });
  f.db.exec('CREATE TEMP TRIGGER probe_gate BEFORE INSERT ON main.responses BEGIN SELECT probe_original_authority_gate(); END');
  const done = revoke(phone.id, { wait_for: entered, busy_proof: busy, committed }); const body = responseInput();
  const result = await f.request('POST', `/v1/events/${event}/responses`, phone.token, body); assert.equal(result.status, 200);
  await done; assert.equal(existsSync(committed), true);
  assert.equal((f.db.prepare('SELECT COUNT(*) n FROM responses WHERE id=?').get(body.response_id) as { n: number }).n, 1);
  assert.equal((await f.request('GET', `/v1/events/${event}`, phone.token)).status, 401);
});

test('real HTTP distinct managed actors share one owner event/read state, compete for one original response slot, and revoke independently', { timeout: 20000 }, async t => {
  const f = await fixture(t); await f.start(); const event = await f.event(); const a = f.claim(); const b = f.claim();
  assert.notEqual(a.id, b.id); assert.notEqual(a.token, b.token); const first = responseInput(); const second = responseInput();
  const results = await Promise.all([f.request('POST', `/v1/events/${event}/responses`, a.token, first), f.request('POST', `/v1/events/${event}/responses`, b.token, second)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal((f.db.prepare('SELECT COUNT(*) n FROM responses').get() as { n: number }).n, 1);
  const observed = await f.request('GET', `/v1/events/${event}`, a.token); assert.equal(observed.status, 200);
  assert.equal((await f.request('PUT', `/v1/events/${event}/read-state`, a.token, { event_version: observed.data.event_version })).status, 200);
  const shared = await f.request('GET', `/v1/events/${event}`, b.token); assert.equal(shared.status, 200); assert.equal(shared.data.read_state.unread, false);
  const original = snapshot(f.db); const revoke = await f.revoker(); await revoke(a.id);
  assert.equal((await f.request('GET', `/v1/events/${event}`, a.token)).status, 401); assert.equal((await f.request('GET', `/v1/events/${event}`, b.token)).status, 200); assert.deepEqual(snapshot(f.db), original);
});
