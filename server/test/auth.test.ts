import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ApiError, fileRegistry, parseRegistry } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';
import { code, credentials, eventInput, fixture, snapshot } from './helpers.js';

const unavailable = (err: unknown) => err instanceof ApiError && err.status === 503 && err.code === 'AUTH_NOT_CONFIGURED';

test('C01: credential format, identity ambiguity, excess fields and weak token shapes fail closed', () => {
  const valid = credentials();
  const source = valid.principals.find(p => p.kind === 'source'); assert.ok(source);
  const user = valid.principals.find(p => p.kind === 'user'); assert.ok(user);
  for (const value of [
    null, [], {}, { principals: [] }, { ...valid, extra: true },
    { principals: [{ ...user, token: '' }] }, { principals: [{ ...user, token: 'f'.repeat(63) }] },
    { principals: [{ ...user, token: 'G'.repeat(64) }] }, { principals: [{ ...user, owner_id: '../other' }] },
    { principals: [{ ...user, source_id: 'pretend' }] }, { principals: [{ ...user, kind: 'admin' }] },
    { principals: [user, { ...user, id: 'another' }] }, { principals: [user, { ...user, token: 'f'.repeat(64) }] },
    { principals: [{ ...source, capabilities: ['publish', 'execute'] }] },
    { principals: [{ ...source, capabilities: ['reply', 'reply'] }] },
    { principals: [source, { ...source, id: 'other_actor', token: 'f'.repeat(64) }] },
    { principals: Array.from({ length: 101 }, () => user) },
  ]) assert.throws(() => parseRegistry(value), unavailable);
  assert.equal(parseRegistry(valid).authenticate(`bearer ${user.token}`).id, user.id);
  for (const header of ['', `Bearer ${user.token} extra`, `Basic ${user.token}`, `Bearer ${'0'.repeat(64)}`]) assert.throws(() => parseRegistry(valid).authenticate(header), (e: unknown) => e instanceof ApiError && e.status === 401);
});

test('C01: private credential files are bounded, regular, nonsymlink files and never cached', async t => {
  const f = fixture(t); const path = join(f.root, 'credentials.json'); const read = fileRegistry(path);
  assert.throws(read, unavailable);
  const put = (value: unknown) => { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); chmodSync(path, 0o600); };
  put(f.config);
  assert.equal(read().authenticate(`Bearer ${f.tokens.user}`).id, 'user');
  if (process.platform !== 'win32') {
    chmodSync(path, 0o644); assert.throws(read, unavailable); chmodSync(path, 0o600);
    const link = join(f.root, 'symlink.json'); symlinkSync(path, link); assert.throws(fileRegistry(link), unavailable);
  }
  const directory = join(f.root, 'directory'); mkdirSync(directory); assert.throws(fileRegistry(directory), unavailable);
  writeFileSync(path, 'x'.repeat(65537)); assert.throws(read, unavailable);
  writeFileSync(path, '{invalid'); assert.throws(read, unavailable);
  put({ principals: [] }); assert.throws(read, unavailable);
  put(f.config);
  f.config.principals = f.config.principals.filter(p => p.id !== 'user'); put(f.config);
  assert.throws(() => read().authenticate(`Bearer ${f.tokens.user}`), (e: unknown) => e instanceof ApiError && e.status === 401);
  unlinkSync(path); assert.throws(read, unavailable);
});

test('C01/C03: live HTTP auth-file revocation and capability reduction beat cached idempotent results', async t => {
  const f = fixture(t); const path = join(f.root, 'credentials.json');
  const app = createApp(openDatabase(':memory:'), false, { registry: fileRegistry(path) }); t.after(() => app.close());
  const request = (payload: object, token = f.tokens.source) => app.inject({ method: 'POST', url: '/v1/events', payload, headers: { authorization: `Bearer ${token}` } });
  const input = eventInput();
  code(await request(input), 503, 'AUTH_NOT_CONFIGURED');
  writeFileSync(path, JSON.stringify(f.config), { mode: 0o600 });
  assert.equal((await request(input)).statusCode, 200);
  const source = f.config.principals.find(p => p.id === 'source'); assert.ok(source?.kind === 'source');
  source.capabilities = ['read_responses', 'reply']; writeFileSync(path, JSON.stringify(f.config));
  code(await request(input), 403, 'FORBIDDEN');
  f.config.principals = f.config.principals.filter(p => p.id !== 'source'); writeFileSync(path, JSON.stringify(f.config));
  code(await request(input), 401, 'UNAUTHENTICATED');
  writeFileSync(path, '{broken'); code(await request(input), 503, 'AUTH_NOT_CONFIGURED');
  assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
});

test('R1/C01: JSON enum arrays never coerce into roles or capabilities; invalid files reject all HTTP access', async t => {
  const f = fixture(t); const path = join(f.root, 'malformed-enum.json');
  const db = openDatabase(':memory:');
  const app = createApp(db, false, { registry: fileRegistry(path) }); t.after(() => app.close());
  const put = (principals: unknown[]) => writeFileSync(path, JSON.stringify({ principals }), { mode: 0o600 });
  const request = (url: string, payload: object, token: string | undefined) => app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${token}` } });
  put(f.config.principals);
  const created = await request('/v1/events', eventInput(), f.tokens.source); assert.equal(created.statusCode, 200);
  const before = snapshot(db);
  const base = { id: 'malformed', owner_id: 'owner', token: randomBytes(32).toString('hex') };
  const source = { ...base, kind: 'source', source_id: 'malformed', source_epoch: 'epoch_1' };
  const malformed = [
    ...[['user'], ['source'], [['source']], { name: 'source' }, null, 1, true].map(kind => ({ ...base, kind })),
    ...[[['reply']], [['publish']], [['read_responses']], [{ name: 'reply' }], [true], [1], [null]].map(capabilities => ({ ...source, capabilities })),
  ];
  for (const principal of malformed) {
    const config = { principals: [...f.config.principals, principal] };
    assert.throws(() => parseRegistry(JSON.parse(JSON.stringify(config))), unavailable);
    put(config.principals); assert.throws(fileRegistry(path), unavailable);
    code(await request(`/v1/events/${created.json().event_id}/disposition`, { request_id: 'invalid_decision', expected_event_version: 1, disposition: 'completed' }, base.token), 503, 'AUTH_NOT_CONFIGURED');
    code(await request('/v1/events', eventInput(), f.tokens.source), 503, 'AUTH_NOT_CONFIGURED');
    code(await app.inject({ method: 'GET', url: '/v1/events', headers: { authorization: `Bearer ${f.tokens.user}` } }), 503, 'AUTH_NOT_CONFIGURED');
    assert.deepEqual(snapshot(db), before);
  }
  put(f.config.principals);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/events', headers: { authorization: `Bearer ${f.tokens.user}` } })).statusCode, 200);
});

test('C01/C09: credential bytes do not enter ledger, histories, API errors or successful responses', async t => {
  const f = fixture(t); const e = await f.create();
  const rejected = await f.req('POST', '/v1/events', { ...eventInput(), token: f.tokens.source });
  code(rejected, 422, 'INVALID_INPUT');
  const unknown = await f.app.inject({ method: 'GET', url: `/not-an-api?token=${f.tokens.source}` });
  code(unknown, 404, 'NOT_FOUND');
  const replies = [e.ack, rejected.json(), unknown.json(), (await f.req('GET', `/v1/events/${e.id}`, undefined, 'user')).json(), (await f.req('GET', `/v1/events/${e.id}/history`, undefined, 'user')).json()];
  const storage = JSON.stringify(snapshot(f.db));
  for (const token of Object.values(f.tokens)) {
    assert.equal(storage.includes(token), false);
    assert.equal(JSON.stringify(replies).includes(token), false);
  }
});
