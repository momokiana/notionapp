import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { HTTPMethods } from 'fastify';
import { createApp } from '../src/app.js';
import { parseRegistry } from '../src/auth.js';
import { openDatabase } from '../src/database.js';
import type { SourceRuntimeObservation, SourceRuntimeProvider } from '../src/source-runtime.js';
import { credentials, eventInput, NOW, snapshot } from './helpers.js';

const observation = (): SourceRuntimeObservation => ({ source_id: 'source', source_epoch: 'epoch_1', state: 'paused',
  model_permission_configured: true, reason_code: 'SOURCE_PAUSED_EXPLICIT', observed_at: new Date(NOW).toISOString() });
function setup(t: TestContext, provider?: SourceRuntimeProvider) {
  const config = credentials(); const db = openDatabase(':memory:');
  const tokens = Object.fromEntries(config.principals.map(p => [p.id, p.token]));
  const app = createApp(db, false, { registry: () => parseRegistry(config), ...(provider ? { sourceRuntime: provider } : {}), now: () => NOW });
  t.after(() => app.close());
  const request = (method: HTTPMethods, url: string, payload?: object, actor = 'user') => app.inject({ method, url,
    headers: actor === 'anonymous' ? {} : { authorization: `Bearer ${tokens[actor]}` }, ...(payload ? { payload } : {}) });
  const create = async (actor = 'source') => {
    const r = await request('POST', '/v1/events', eventInput(), actor); assert.equal(r.statusCode, 200); return r.json().event_id as string;
  };
  const url = (id: string, version = 1, source = 'source') => `/v1/source-runtime/${source}?event_id=${id}&event_version=${version}`;
  return { config, db, request, create, url };
}
const provider = (observe: () => SourceRuntimeObservation): SourceRuntimeProvider => ({ owner_id: 'owner', source_id: 'source', source_epoch: 'epoch_1', observe });

test('runtime observation requires current user owner and exact authoritative event/source scope without mutating the ledger', async t => {
  let calls = 0; const f = setup(t, provider(() => { calls++; return observation(); })); const id = await f.create();
  const other = await f.create('foreign'); const before = snapshot(f.db);
  for (const [actor, status] of [['anonymous', 401], ['source', 403], ['outsider', 404]] as const) {
    const r = await f.request('GET', f.url(id), undefined, actor); assert.equal(r.statusCode, status, r.body);
  }
  assert.equal((await f.request('GET', f.url(other))).statusCode, 404);
  assert.equal((await f.request('GET', f.url(id, 1, 'neighbor'))).statusCode, 404); assert.equal(calls, 0);
  for (let n = 0; n < 3; n++) {
    const r = await f.request('GET', f.url(id)); assert.equal(r.statusCode, 200); assert.deepEqual(r.json(), { event_id: id, event_version: 1, ...observation() });
  }
  assert.equal(calls, 3); assert.deepEqual(snapshot(f.db), before); assert.equal((await f.request('GET', '/health')).json().storage, 'ready');
});

test('no provider remains local unknown and stale event versions never consume or create an observation', async t => {
  const old = setup(t); const id = await old.create(); assert.equal((await old.request('GET', old.url(id))).statusCode, 404);
  let calls = 0; const f = setup(t, provider(() => { calls++; return observation(); })); const event = await f.create(); const before = snapshot(f.db);
  assert.equal((await f.request('GET', f.url(event, 2))).statusCode, 409); assert.equal(calls, 0);
  assert.equal((await f.request('GET', `/v1/source-runtime/source?event_id=${event}&event_version=9007199254740992`)).statusCode, 409);
  assert.deepEqual(snapshot(f.db), before);
});

test('same source name with a different epoch cannot attach current host observation to an old event', async t => {
  let epoch = 'epoch_1'; const p: SourceRuntimeProvider = { owner_id: 'owner', source_id: 'source', get source_epoch() { return epoch; }, observe: () => ({ ...observation(), source_epoch: epoch }) };
  const f = setup(t, p); const old = await f.create(); epoch = 'epoch_2';
  const source = f.config.principals.find(p => p.id === 'source')!; assert.equal(source.kind, 'source'); if (source.kind === 'source') source.source_epoch = epoch;
  const current = await f.create(); const before = snapshot(f.db);
  assert.equal((await f.request('GET', f.url(old))).statusCode, 404);
  const r = await f.request('GET', f.url(current)); assert.equal(r.statusCode, 200); assert.equal(r.json().source_epoch, epoch);
  assert.deepEqual(snapshot(f.db), before);
});

test('invalid/secret-bearing runtime values and thrown errors are bounded failures, never copied into an API reply', async t => {
  const secret = 'synthetic-secret-should-not-appear'; let value: unknown = observation();
  const f = setup(t, provider(() => { if (value instanceof Error) throw value; return value as SourceRuntimeObservation; })); const id = await f.create(); const before = snapshot(f.db);
  for (const bad of [null, { ...observation(), path: secret }, { ...observation(), reason_code: secret }, { ...observation(), state: 'running' },
    { ...observation(), source_epoch: 'another_epoch' }, { ...observation(), observed_at: '2026' }, { ...observation(), model_permission_configured: 'true' },
    { ...observation(), observed_at: secret.repeat(1000) }, new Error(secret), Promise.resolve(observation())]) {
    value = bad; const r = await f.request('GET', f.url(id)); assert.equal(r.statusCode, 503); assert.equal(r.json().error.code, 'RUNTIME_OBSERVATION_UNAVAILABLE'); assert(!r.body.includes(secret)); assert(Buffer.byteLength(r.body) < 4096);
  }
  assert.deepEqual(snapshot(f.db), before);
});
