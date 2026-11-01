import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { parseRegistry } from '../src/auth.js';
import { CoreStore } from '../src/core.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/database.js';
import { NotificationStore, pushConfig, type PushPayload } from '../src/notifications.js';
import { APP_ID, commandDdl, ledgerDdl, schemaVersion } from '../src/schema.js';
import { credentials, eventInput, fixture, NOW, responseInput } from './helpers.js';

// This is an actual local service + ntfy protocol stub + simulated authenticated device receipt, not a phone/distributor test.
test('N08: live event HTTP -> lifecycle consumer -> ntfy HTTP -> correlated device/OS request receipts', { timeout: 20000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'notifier-push-e2e-'));
  const config = credentials(); const tokens = Object.fromEntries(config.principals.map(p => [p.id, p.token]));
  let receive!: (payload: PushPayload) => void;
  const incoming = new Promise<PushPayload>(resolve => { receive = resolve; });
  const ntfy = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/up_private_fixture'); assert.equal(req.headers['x-unifiedpush'], '1');
    const payload = JSON.parse(body) as PushPayload;
    assert.deepEqual(Object.keys(payload).sort(), ['delivery_id', 'event_id', 'event_version', 'nonce']);
    res.writeHead(200); res.end('{}'); receive(payload);
  });
  ntfy.listen(0, '127.0.0.1'); await once(ntfy, 'listening');
  const push = pushConfig(`http://127.0.0.1:${(ntfy.address() as { port: number }).port}`, undefined, true);
  const app = createApp(openDatabase(join(root, 'ledger.sqlite')), false, { registry: () => parseRegistry(config), now: () => NOW, push });
  t.after(async () => { await app.close(); await new Promise<void>(resolve => ntfy.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const req = async (method: string, path: string, body?: object, actor = 'user') => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${tokens[actor]}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any };
  };
  assert.equal((await req('GET', '/v1/device/push')).data.configured, true);
  const registration = { registration_id: 'register_e2e', expected_generation: 0, endpoint: `${push.origin}/up_private_fixture?up=1` };
  assert.equal((await req('PUT', '/v1/device/push', registration, 'source')).status, 403);
  assert.equal((await req('PUT', '/v1/device/push', registration)).status, 200);
  const created = await req('POST', '/v1/events', eventInput(), 'source'); assert.equal(created.status, 200);
  const payload = await incoming; assert.equal(payload.event_id, created.data.event_id); assert.equal(payload.event_version, 1);
  assert.equal((await req('POST', `/v1/notifications/${payload.delivery_id}/receipt`, { nonce: payload.nonce, state: 'device_received' }, 'device2')).status, 404);
  assert.equal((await req('POST', `/v1/notifications/${payload.delivery_id}/receipt`, { nonce: '0'.repeat(64), state: 'device_received' })).status, 409);
  const received = await req('POST', `/v1/notifications/${payload.delivery_id}/receipt`, { nonce: payload.nonce, state: 'device_received' });
  assert.equal(received.status, 200); assert.equal(received.data.delivery_id, payload.delivery_id); assert.equal(received.data.event_id, payload.event_id); assert.equal(received.data.event_version, payload.event_version);
  const before = (await req('GET', `/v1/events/${payload.event_id}`)).data;
  assert.equal(before.delivery_state, 'device_received'); assert.equal(before.read_state.unread, true); assert.equal(before.notification_delivery.notification_posted_at, null);
  assert.equal((await req('POST', `/v1/notifications/${payload.delivery_id}/receipt`, { nonce: payload.nonce, state: 'notification_posted' })).status, 200);
  const after = (await req('GET', `/v1/events/${payload.event_id}`)).data; assert.equal(after.delivery_state, 'notification_posted'); assert.equal(after.verification, 'not_verified'); assert.equal(after.read_state.unread, true);
  assert.equal((await req('GET', '/v1/notifications')).data.items.length, 1);
});

test('N09: exact v2 commands survive v3 migration and injected partial notification migration rolls back', async t => {
  const f = fixture(t); const source = f.config.principals.find(p => p.kind === 'source' && p.id === 'source')!;
  if (source.kind !== 'source') throw new Error('fixture'); source.capabilities.push('deliver');
  const e = await f.create(); assert.equal((await f.req('POST', `/v1/events/${e.id}/responses`, responseInput(), 'user')).statusCode, 200);
  assert.equal((await f.req('POST', '/v1/source/commands/claim', { claim_id: 'preserve_v2_command' })).statusCode, 200);
  const commands = f.db.prepare('SELECT * FROM commands').all(); const operations = f.db.prepare('SELECT * FROM operations').all();
  for (const table of ['notifications', 'notice_batches', 'push_devices']) f.db.exec(`DROP TABLE ${table}`);
  f.db.pragma('user_version=2'); new CoreStore(f.db);
  assert.equal(f.db.pragma('user_version', { simple: true }), schemaVersion); assert.deepEqual(f.db.prepare('SELECT * FROM commands').all(), commands); assert.deepEqual(f.db.prepare('SELECT * FROM operations').all(), operations);
  const db = openDatabase(':memory:'); t.after(() => db.close());
  for (const sql of [...ledgerDdl, commandDdl]) db.exec(sql); db.pragma(`application_id=${APP_ID}`); db.pragma('user_version=2');
  const exec = db.exec.bind(db); db.exec = (sql: string) => { const value = exec(sql); if (sql.includes('CREATE TABLE notice_batches')) throw new Error('notification migration interrupted'); return value; };
  assert.throws(() => new CoreStore(db), /interrupted/); assert.equal(db.pragma('user_version', { simple: true }), 2);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('push_devices','notice_batches','notifications')").all(), []);
});

test('N10: independent processes compete for one durable notification attempt', { timeout: 30000 }, async t => {
  const f = fixture(t, true); const config = pushConfig('https://ntfy.fixture.invalid'); const store = new NotificationStore(f.db, f.registry, config, () => NOW);
  const registry = f.registry(); store.register(registry.authenticate(`Bearer ${f.tokens.user}`), { registration_id: 'concurrent_device', expected_generation: 0, endpoint: `${config.origin}/up_fixture` }); await f.create();
  const auth = join(f.root, 'notification-auth.json'); writeFileSync(auth, JSON.stringify(f.config), { mode: 0o600 });
  const results = await Promise.all([0, 1].map(() => new Promise<{ id: string | null }>((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./fixtures/notification-process.ts', import.meta.url)), [f.databasePath, auth], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = ''; child.stdout!.on('data', chunk => { output += String(chunk); }); child.on('error', reject); child.on('exit', status => status === 0 ? resolve(JSON.parse(output) as { id: string | null }) : reject(new Error('consumer process failed')));
  })));
  assert.equal(results.filter(r => r.id !== null).length, 1); assert.equal((f.db.prepare('SELECT count(*) AS n FROM notifications').get() as { n: number }).n, 1);
});

test('N11: optional runtime push configuration defaults off and rejects orphan/unsafe channel settings', () => {
  assert.equal(readConfig({}).push, undefined);
  for (const env of [{ PUSH_TOKEN: 'fixture_token_123' }, { PUSH_ORIGIN: 'http://external.invalid' }, { PUSH_ORIGIN: 'https://fixture.invalid/path' }, { PUSH_ALLOW_LOCAL_HTTP: 'yes' }]) assert.throws(() => readConfig(env));
  assert.equal(readConfig({ PUSH_ORIGIN: 'http://127.0.0.1:12345', PUSH_ALLOW_LOCAL_HTTP: '1' }).push!.origin, 'http://127.0.0.1:12345');
});
