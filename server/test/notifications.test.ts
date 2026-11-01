import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { NotificationStore, payloadFor, publishNtfy, pushConfig, type Notice } from '../src/notifications.js';
import { fixture, NOW } from './helpers.js';
import { openDatabase } from '../src/database.js';
import { CoreStore } from '../src/core.js';

function setup(t: Parameters<typeof fixture>[0], persistent = false) {
  const f = fixture(t, persistent); const config = pushConfig('https://ntfy.fixture.invalid');
  const store = new NotificationStore(f.db, f.registry, config, () => NOW);
  const principal = (id = 'user') => f.registry().authenticate(`Bearer ${f.tokens[id]}`);
  const register = (id = 'user', endpoint = 'https://ntfy.fixture.invalid/up_fixture_topic', generation = 0, operation = `register_${id}`) => store.register(principal(id), { registration_id: operation, expected_generation: generation, endpoint });
  return { ...f, push: config, store, principal, register };
}

test('N01: configuration, endpoint origin and path restrictions; no config means no outgoing claim', async t => {
  for (const origin of ['http://ntfy.invalid', 'https://a.invalid/path', 'https://user:pass@a.invalid', 'https://a.invalid?x=1']) assert.throws(() => pushConfig(origin));
  assert.throws(() => pushConfig('https://a.invalid', 'bad\r\nheader'));
  const f = setup(t); await f.create();
  const off = new NotificationStore(f.db, f.registry, undefined); assert.equal(off.claim(), null);
  assert.throws(() => off.register(f.principal(), { registration_id: 'off', expected_generation: 0, endpoint: 'https://ntfy.fixture.invalid/topic' }), /configured/);
  for (const endpoint of ['https://evil.invalid/topic', 'https://ntfy.fixture.invalid/v1/users', 'https://u:p@ntfy.fixture.invalid/topic', 'https://ntfy.fixture.invalid/topic?auth=secret', 'https://ntfy.fixture.invalid/topic#x']) assert.throws(() => f.register('user', endpoint), /Endpoint/);
  assert.throws(() => f.store.register(f.principal('source'), { registration_id: 'source', expected_generation: 0, endpoint: null }), /User permission/);
});

test('N02: no devices preserves pending; current device gets one attempt, duplicate claim never republishes unknown', async t => {
  const f = setup(t); const e = await f.create(); assert.equal(f.store.claim(), null);
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM outbox WHERE state='pending'").get() as { n: number }).n, 1);
  const registration = f.register(); assert.equal(registration.generation, 1);
  assert.deepEqual(f.register(), registration);
  const notice = f.store.claim()!; assert.equal(notice.event_id, e.id); assert.equal(notice.platform_state, 'effect_unknown');
  assert.equal(f.store.claim(), null);
  assert.deepEqual(Object.keys(payloadFor(notice)).sort(), ['delivery_id', 'event_id', 'event_version', 'nonce']);
  const payload = JSON.stringify(payloadFor(notice)); assert.ok(!payload.includes('Fixture question')); assert.ok(!payload.includes('fixture_session')); assert.ok(!payload.includes(f.tokens.user!));
});

test('N03: multi-device audience is fixed; rotated/revoked endpoints are withheld, not reassigned', async t => {
  const f = setup(t); f.register(); f.register('device2', 'https://ntfy.fixture.invalid/up_second_topic'); await f.create();
  const first = f.store.claim()!;
  const other = first.actor === 'user' ? 'device2' : 'user';
  f.register(other, 'https://ntfy.fixture.invalid/up_rotated_topic', 1, 'rotate');
  assert.equal(f.store.claim(), null);
  const remaining = f.db.prepare('SELECT platform_state,generation FROM notifications WHERE actor=?').get(other) as { platform_state: string; generation: number };
  assert.equal(remaining.platform_state, 'withheld'); assert.equal(remaining.generation, 1);
  assert.throws(() => f.register(other, 'https://ntfy.fixture.invalid/up_old_topic', 1, 'stale'), /Refresh/);
  await f.create(); f.config.principals = f.config.principals.filter(p => p.id !== first.actor);
  const next = f.store.claim()!; assert.equal(next.actor, other); assert.equal(next.generation, 2);
});

test('N07: rotating before consumption freezes all old intent audiences, including beyond one batch', async t => {
  const f = setup(t); f.register(); for (let i = 0; i < 101; i++) await f.create();
  f.register('user', 'https://ntfy.fixture.invalid/up_rotated', 1, 'rotate_before_consumer');
  assert.equal(f.store.claim(), null); assert.equal(f.store.claim(), null);
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM notifications WHERE generation=1 AND platform_state='withheld'").get() as { n: number }).n, 101);
  const fresh = await f.create(); const notice = f.store.claim()!; assert.equal(notice.event_id, fresh.id); assert.equal(notice.generation, 2);
});

test('N12: current version summary never inherits older receipts, including late old receipts', async t => {
  const f = setup(t); f.register(); const e = await f.create(); const old = f.store.claim()!;
  f.store.platform(old.id, 'platform_accepted'); f.store.receipt(f.principal(), old.id, { nonce: old.nonce, state: 'notification_posted' });
  assert.equal((await f.req('GET', `/v1/events/${e.id}`, undefined, 'user')).json().delivery_state, 'notification_posted');
  assert.equal((await f.req('POST', `/v1/events/${e.id}/updates`, { update_id: 'v2', expected_event_version: 1, kind: 'progress', body: 'new version' })).statusCode, 200);
  let current = (await f.req('GET', `/v1/events/${e.id}`, undefined, 'user')).json();
  assert.equal(current.event_version, 2); assert.equal(current.delivery_state, 'not_observed'); assert.equal(current.notification_delivery, null);
  assert.equal(current.previous_notification_delivery.version, 1); assert.ok(current.previous_notification_delivery.notification_posted_at);
  f.register('device2', 'https://ntfy.fixture.invalid/up_second'); // Freeze v2 as pending for the already registered phone.
  current = (await f.req('GET', `/v1/events/${e.id}`, undefined, 'user')).json();
  assert.equal(current.notification_delivery.version, 2); assert.equal(current.delivery_state, 'pending'); assert.ok(current.previous_notification_delivery.notification_posted_at);
  const next = f.store.claim()!; assert.equal(next.version, 2);
  f.store.receipt(f.principal(), old.id, { nonce: old.nonce, state: 'device_received' });
  current = (await f.req('GET', `/v1/events/${e.id}`, undefined, 'user')).json();
  assert.equal(current.delivery_state, 'effect_unknown'); assert.equal(current.notification_delivery.notification_posted_at, null); assert.ok(current.previous_notification_delivery.notification_posted_at);
  f.store.platform(next.id, 'platform_accepted'); f.store.receipt(f.principal(), next.id, { nonce: next.nonce, state: 'device_received' });
  assert.equal((await f.req('GET', `/v1/events/${e.id}`, undefined, 'user')).json().delivery_state, 'device_received');
});

test('N13: registration active flag reflects the current approved channel, not only a stored endpoint', async t => {
  const f = setup(t); f.register(); await f.create();
  const changed = new NotificationStore(f.db, f.registry, pushConfig('https://new-ntfy.fixture.invalid'));
  assert.equal(changed.device(f.principal()).registered, false); assert.equal(changed.claim(), null);
  assert.throws(() => changed.register(f.principal(), { registration_id: 'wrong_old_origin', expected_generation: 1, endpoint: 'https://ntfy.fixture.invalid/up_fixture_topic' }), /configured/);
  changed.register(f.principal(), { registration_id: 'new_origin', expected_generation: 1, endpoint: 'https://new-ntfy.fixture.invalid/up_new_topic' });
  assert.equal(changed.device(f.principal()).registered, true); assert.equal(changed.claim(), null);
  const e = await f.create(); assert.equal(changed.claim()!.event_id, e.id);
});

test('N14: endpoint removal while consumer is disabled still pins old intent audiences', async t => {
  const f = setup(t); f.register(); await f.create();
  const off = new NotificationStore(f.db, f.registry, undefined);
  off.register(f.principal(), { registration_id: 'disable_offline', expected_generation: 1, endpoint: null });
  assert.equal(off.claim(), null);
  f.register('user', 'https://ntfy.fixture.invalid/up_reenabled', 2, 'enable_after_off');
  assert.equal(f.store.claim(), null);
  const old = f.db.prepare('SELECT generation,platform_state FROM notifications').get() as { generation: number; platform_state: string };
  assert.equal(old.generation, 1); assert.equal(old.platform_state, 'withheld');
});

test('N04: user close withholds unsent intents and reopen does not resurrect them; in-flight known receipt remains', async t => {
  const f = setup(t); const e = await f.create(); f.register(); const n = f.store.claim()!;
  assert.equal((await f.req('POST', `/v1/events/${e.id}/disposition`, { request_id: 'pause', expected_event_version: 1, disposition: 'paused' }, 'user')).statusCode, 200);
  const received = f.store.receipt(f.principal(), n.id, { nonce: n.nonce, state: 'device_received' });
  assert.equal(received.evidence, 'device_reported'); assert.equal(f.store.claim(), null);
  assert.equal((await f.req('POST', `/v1/events/${e.id}/disposition`, { request_id: 'reopen', expected_event_version: 2, disposition: 'open' }, 'user')).statusCode, 200);
  assert.equal(f.store.claim(), null);
  assert.deepEqual(f.store.receipt(f.principal(), n.id, { nonce: n.nonce, state: 'device_received' }), received);
  const second = await f.create(); assert.equal((await f.req('POST', `/v1/events/${second.id}/disposition`, { request_id: 'done', expected_event_version: 1, disposition: 'completed' }, 'user')).statusCode, 200);
  assert.equal(f.store.claim(), null);
});

test('N05: receipts bind exact device/nonce; platform/receiver/OS request stay independent and idempotent', async t => {
  const f = setup(t); await f.create(); f.register(); const n = f.store.claim()!;
  assert.throws(() => f.store.receipt(f.principal('device2'), n.id, { nonce: n.nonce, state: 'device_received' }), /not visible/);
  assert.throws(() => f.store.receipt(f.principal(), n.id, { nonce: 'a'.repeat(64), state: 'device_received' }), /does not match/);
  const first = f.store.receipt(f.principal(), n.id, { nonce: n.nonce, state: 'device_received' });
  assert.deepEqual(f.store.receipt(f.principal(), n.id, { nonce: n.nonce, state: 'device_received' }), first);
  const pending = f.store.list(f.principal(), 0, 50).items[0]!; assert.equal(pending.platform_state, 'effect_unknown'); assert.ok(pending.device_received_at); assert.equal(pending.notification_posted_at, null);
  f.store.platform(n.id, 'platform_accepted'); f.store.receipt(f.principal(), n.id, { nonce: n.nonce, state: 'notification_posted' });
  const known = f.store.list(f.principal(), 0, 50).items[0]!; assert.equal(known.platform_state, 'platform_accepted'); assert.ok(known.device_received_at); assert.ok(known.notification_posted_at);
});

test('N06: real HTTP ntfy protocol accepts minimal payload, failures/response loss never auto-retry across disk reopen', async t => {
  const f = setup(t, true); let requests = 0; let mode = 'ok';
  const server = createServer(async (req, res) => {
    requests++; let body = ''; for await (const chunk of req) body += String(chunk);
    assert.equal(req.headers['x-unifiedpush'], '1'); assert.equal(req.headers['content-type'], 'application/octet-stream');
    assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ['delivery_id', 'event_id', 'event_version', 'nonce']);
    if (mode === 'loss') { req.socket.destroy(); return; }
    res.writeHead(mode === 'reject' ? 403 : mode === 'unknown' ? 503 : mode === 'redirect' ? 302 : 200, mode === 'redirect' ? { location: '/must_not_follow' } : {}); res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port; const config = pushConfig(`http://127.0.0.1:${port}`, undefined, true);
  const store = new NotificationStore(f.db, f.registry, config, () => NOW);
  store.register(f.principal(), { registration_id: 'local', expected_generation: 0, endpoint: `${config.origin}/up_fixture?up=1` });
  for (const value of ['ok', 'reject', 'unknown', 'loss', 'redirect']) {
    mode = value; await f.create(); const n = store.claim()!; const status = await publishNtfy(config, n);
    assert.equal(status, value === 'ok' ? 'platform_accepted' : value === 'reject' ? 'failed' : 'effect_unknown');
    if (status !== 'effect_unknown') store.platform(n.id, status);
    assert.equal(store.claim(), null);
  }
  assert.equal(requests, 5);
  const db = openDatabase(f.databasePath); t.after(() => db.close()); new CoreStore(db);
  const reopened = new NotificationStore(db, f.registry, config); assert.equal(reopened.claim(), null); assert.equal(requests, 5);
  assert.deepEqual(reopened.list(f.principal(), 0, 50).items.map(n => n.platform_state), ['platform_accepted', 'failed', 'effect_unknown', 'effect_unknown', 'effect_unknown']);
});
