import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPIRES, NOW, code, eventInput, fixture, responseInput, snapshot } from './helpers.js';

const update = (expected_event_version: number, overrides: object = {}) => ({ update_id: `update_${expected_event_version}`, expected_event_version, kind: 'progress', body: 'Progress', ...overrides });

test('C01: every protected route authenticates before processing untrusted input', async t => {
  const f = fixture(t);
  const routes = [['POST', '/events'], ['GET', '/events'], ['GET', '/events/missing'], ['POST', '/events/missing/updates'], ['POST', '/events/missing/responses'], ['GET', '/responses/missing'], ['GET', '/source/responses'], ['PUT', '/events/missing/read-state'], ['POST', '/events/missing/disposition'], ['GET', '/events/missing/history']] as const;
  for (const [method, path] of routes) {
    for (const authorization of [undefined, 'Bearer bad', `Bearer ${'0'.repeat(64)}`]) {
      const result = await f.app.inject({ method, url: `/v1${path}`, headers: authorization ? { authorization } : {}, ...(method === 'POST' ? { payload: '{malformed', headers: { ...(authorization ? { authorization } : {}), 'content-type': 'application/json' } } : {}) });
      code(result, 401, 'UNAUTHENTICATED');
    }
  }
  const created = await f.create();
  const input = responseInput();
  code(await f.req('POST', '/v1/events', eventInput(), 'user'), 403, 'FORBIDDEN');
  code(await f.req('POST', `/v1/events/${created.id}/responses`, input), 403, 'FORBIDDEN');
  code(await f.req('PUT', `/v1/events/${created.id}/read-state`, { event_version: 1 }), 403, 'FORBIDDEN');
  code(await f.req('POST', `/v1/events/${created.id}/disposition`, { request_id: 'd', expected_event_version: 1, disposition: 'completed' }), 403, 'FORBIDDEN');
  code(await f.req('GET', '/v1/source/responses', undefined, 'user'), 403, 'FORBIDDEN');
  f.config.principals = f.config.principals.filter(p => p.id !== 'source');
  code(await f.req('POST', '/v1/events', created.input), 401, 'UNAUTHENTICATED');
});

test('C02: two owners, neighboring sources, devices and epoch rotation remain isolated', async t => {
  const f = fixture(t);
  const a = await f.create(); const b = await f.create({}, 'neighbor'); const c = await f.create({}, 'foreign');
  const input = responseInput();
  assert.equal((await f.req('POST', `/v1/events/${a.id}/responses`, input, 'device2')).statusCode, 200);
  for (const actor of ['neighbor', 'foreign', 'outsider']) {
    for (const path of [`/events/${a.id}`, `/events/${a.id}/history`, `/responses/${input.response_id}`]) code(await f.req('GET', `/v1${path}`, undefined, actor), 404, 'NOT_FOUND');
    if (actor !== 'outsider') code(await f.req('POST', `/v1/events/${a.id}/updates`, update(2), actor), 404, 'NOT_FOUND');
  }
  code(await f.req('POST', `/v1/events/${a.id}/responses`, input, 'outsider'), 404, 'NOT_FOUND');
  const ownerEvents = (await f.req('GET', '/v1/events', undefined, 'user')).json().items;
  assert.deepEqual(ownerEvents.map((e: { id: string }) => e.id), [a.id, b.id]);
  assert.deepEqual((await f.req('GET', '/v1/events', undefined, 'foreign')).json().items.map((e: { id: string }) => e.id), [c.id]);
  assert.equal((await f.req('GET', `/v1/responses/${input.response_id}`, undefined, 'user')).json().actor_id, 'device2');
  const source = f.config.principals.find(p => p.id === 'source');
  assert.ok(source?.kind === 'source'); source.source_epoch = 'epoch_2';
  code(await f.req('GET', `/v1/events/${a.id}`), 404, 'NOT_FOUND');
  code(await f.req('GET', `/v1/responses/${input.response_id}`), 404, 'NOT_FOUND');
  code(await f.req('POST', `/v1/events/${a.id}/updates`, update(2)), 404, 'NOT_FOUND');
  assert.deepEqual((await f.req('GET', '/v1/source/responses')).json().items, []);
  assert.equal((await f.req('GET', `/v1/responses/${input.response_id}`, undefined, 'user')).json().reason_code, 'SOURCE_NOT_AUTHORIZED');
  const fresh = await f.create(a.input);
  assert.notEqual(fresh.id, a.id);
});

test('C03: semantic idempotency precedes mutable version checks but follows current visibility', async t => {
  const f = fixture(t);
  const e = await f.create({ request_id: 'stable_create' });
  const reordered = Object.fromEntries(Object.entries(e.input).reverse());
  assert.deepEqual((await f.req('POST', '/v1/events', reordered)).json(), e.ack);
  code(await f.req('POST', '/v1/events', { ...e.input, session_ref: 'different' }), 409, 'IDEMPOTENCY_CONFLICT');
  assert.notEqual((await f.create(e.input, 'neighbor')).id, e.id);
  const u = update(1);
  const ack = (await f.req('POST', `/v1/events/${e.id}/updates`, u)).json();
  assert.equal(ack.event_version, 2);
  assert.deepEqual((await f.req('POST', `/v1/events/${e.id}/updates`, u)).json(), ack);
  code(await f.req('POST', `/v1/events/${e.id}/updates`, { ...u, body: 'Different' }), 409, 'IDEMPOTENCY_CONFLICT');
  const r = responseInput({ response_id: 'stable_reply', event_version: 2, text: 'original' });
  const saved = await f.req('POST', `/v1/events/${e.id}/responses`, r, 'user');
  assert.equal(saved.statusCode, 200);
  assert.deepEqual((await f.req('POST', `/v1/events/${e.id}/responses`, r, 'device2')).json(), saved.json());
  for (const changed of [{ text: 'different' }, { action_id: 'text' }, { interaction_version: 2 }]) code(await f.req('POST', `/v1/events/${e.id}/responses`, { ...r, ...changed }, 'user'), 409, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.req('POST', `/v1/events/${e.id}/updates`, update(3, { interaction: null }))).statusCode, 200);
  f.setTime(Date.parse(EXPIRES));
  assert.deepEqual((await f.req('POST', `/v1/events/${e.id}/responses`, r, 'user')).json(), saved.json());
  code(await f.req('POST', `/v1/events/${e.id}/responses`, r, 'outsider'), 404, 'NOT_FOUND');
  const other = await f.create();
  code(await f.req('POST', `/v1/events/${other.id}/responses`, { ...r, event_version: 1 }, 'user'), 409, 'IDEMPOTENCY_CONFLICT');
});

test('C04: stale, malformed, expired, unavailable and read-only actions reject without partial writes', async t => {
  const f = fixture(t); const e = await f.create(); const before = snapshot(f.db);
  for (const [input, status, reason] of [
    [responseInput({ event_version: 2 }), 409, 'EVENT_VERSION_CONFLICT'],
    [responseInput({ interaction_version: 2 }), 409, 'INTERACTION_VERSION_CONFLICT'],
    [responseInput({ action_id: 'not_available' }), 422, 'INVALID_INPUT'],
    [responseInput({ action_id: 'text', text: ' \n ' }), 422, 'INVALID_INPUT'],
    [{ ...responseInput(), target: { session_ref: 'other' } }, 422, 'INVALID_INPUT'],
    [{ ...responseInput(), actor_id: 'source' }, 422, 'INVALID_INPUT'],
    [{ ...responseInput(), event_version: '1' }, 422, 'INVALID_INPUT'],
  ] as const) code(await f.req('POST', `/v1/events/${e.id}/responses`, input, 'user'), status, reason);
  assert.deepEqual(snapshot(f.db), before);
  const source = f.config.principals.find(p => p.id === 'source'); assert.ok(source?.kind === 'source');
  source.capabilities = ['publish', 'read_responses'];
  code(await f.req('POST', `/v1/events/${e.id}/responses`, responseInput(), 'user'), 409, 'SOURCE_READ_ONLY');
  code(await f.req('POST', '/v1/events', eventInput()), 409, 'SOURCE_READ_ONLY');
  const plain = eventInput(); delete plain.interaction;
  assert.equal((await f.req('POST', '/v1/events', plain, 'readonly')).statusCode, 200);
  source.capabilities.push('reply');
  f.setTime(Date.parse(EXPIRES));
  const expiredBefore = snapshot(f.db);
  code(await f.req('POST', `/v1/events/${e.id}/responses`, responseInput(), 'user'), 410, 'ACTION_EXPIRED');
  assert.deepEqual(snapshot(f.db), expiredBefore);
  assert.equal((await f.req('GET', `/v1/events/${e.id}`, undefined, 'user')).json().can_respond, false);
});

test('C05: the interaction slot is shared across devices; independent interactions allow identical text', async t => {
  const f = fixture(t); const e = await f.create();
  const first = responseInput({ action_id: 'text', text: 'same text' });
  const results = await Promise.all([
    f.req('POST', `/v1/events/${e.id}/responses`, first, 'user'),
    f.req('POST', `/v1/events/${e.id}/responses`, responseInput({ action_id: 'yes' }), 'device2'),
  ]);
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
  code(await f.req('POST', `/v1/events/${e.id}/responses`, responseInput({ event_version: 2 }), 'device2'), 409, 'ACTION_ALREADY_RESERVED');
  assert.equal((await f.req('POST', `/v1/events/${e.id}/updates`, update(2, { interaction: e.input.interaction }))).statusCode, 200);
  assert.equal((await f.req('POST', `/v1/events/${e.id}/responses`, responseInput({ event_version: 3, interaction_version: 2, action_id: 'text', text: 'same text' }), 'device2')).statusCode, 200);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM responses').get() as { n: number }).n, 2);
  assert.equal((await f.req('GET', `/v1/responses/${first.response_id}`, undefined, 'user')).json().routing_state, 'blocked');
});

test('C06: SQLite aborts at each write boundary roll back records, occupancy, history, operations and outbox', async t => {
  const f = fixture(t); const e = await f.create();
  const mutations = [
    { method: 'POST', path: '/v1/events', body: eventInput(), actor: 'source', targets: ['events', 'history', 'outbox', 'operations'], operation: 'INSERT' },
    { method: 'POST', path: `/v1/events/${e.id}/updates`, body: update(1), actor: 'source', targets: ['events', 'history', 'outbox', 'operations'], operation: 'UPDATE' },
    { method: 'POST', path: `/v1/events/${e.id}/responses`, body: responseInput(), actor: 'user', targets: ['responses', 'events', 'history', 'outbox', 'operations'], operation: 'UPDATE' },
    { method: 'POST', path: `/v1/events/${e.id}/disposition`, body: { request_id: 'decision', expected_event_version: 1, disposition: 'completed' }, actor: 'user', targets: ['events', 'history', 'operations'], operation: 'UPDATE' },
  ] as const;
  for (const mutation of mutations) for (const target of mutation.targets) {
    const before = snapshot(f.db);
    f.db.exec(`CREATE TRIGGER injected BEFORE ${target === 'events' ? mutation.operation : 'INSERT'} ON ${target} BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END`);
    code(await f.req(mutation.method, mutation.path, mutation.body, mutation.actor), 503, 'STORAGE_FAILURE');
    assert.deepEqual(snapshot(f.db), before, `${mutation.path}/${target}`);
    f.db.exec('DROP TRIGGER injected');
  }
  const good = await f.req('POST', `/v1/events/${e.id}/responses`, responseInput(), 'user');
  assert.equal(good.statusCode, 200);
  assert.equal((await f.req('GET', `/v1/responses/${good.json().response_id}`, undefined, 'user')).statusCode, 200);
  const before = snapshot(f.db);
  f.db.exec("CREATE TRIGGER injected BEFORE INSERT ON read_states BEGIN SELECT RAISE(ABORT,'fixture'); END");
  code(await f.req('PUT', `/v1/events/${e.id}/read-state`, { event_version: 2 }, 'user'), 503, 'STORAGE_FAILURE');
  assert.deepEqual(snapshot(f.db), before);
});

test('C08: immutable binding/action snapshots survive progress and never revive after A-B-A binding changes', async t => {
  const f = fixture(t); const e = await f.create();
  const r = responseInput({ action_id: 'text', text: '  retain raw input\n' });
  assert.equal((await f.req('POST', `/v1/events/${e.id}/responses`, r, 'user')).statusCode, 200);
  let view = (await f.req('GET', `/v1/responses/${r.response_id}`, undefined, 'user')).json();
  assert.equal(view.routing_state, 'waiting_source'); // Own saved receipt must not invalidate itself.
  assert.deepEqual(view.target, { source_id: 'source', source_epoch: 'epoch_1', session_ref: 'fixture_session', state_revision: 'revision_1' });
  assert.equal(view.text, r.text); assert.equal(view.event_version_seen, 1);
  assert.equal((await f.req('POST', `/v1/events/${e.id}/updates`, update(2))).statusCode, 200);
  assert.equal((await f.req('GET', `/v1/responses/${r.response_id}`, undefined, 'user')).json().routing_state, 'waiting_source');
  await f.req('POST', `/v1/events/${e.id}/updates`, update(3, { target_revision: 'revision_2' }));
  await f.req('POST', `/v1/events/${e.id}/updates`, update(4, { target_revision: 'revision_1' }));
  view = (await f.req('GET', `/v1/responses/${r.response_id}`, undefined, 'user')).json();
  assert.equal(view.routing_state, 'blocked'); assert.equal(view.target.state_revision, 'revision_1');
  assert.equal(view.interaction_version, 1); assert.equal(view.text, r.text);
  const history = (await f.req('GET', `/v1/events/${e.id}/history`, undefined, 'user')).json().items;
  assert.equal(history[0].data.title, e.input.title); assert.equal(history[0].data.body, e.input.body);
  assert.deepEqual(history[0].data.interaction.actions, e.input.interaction?.actions);
  assert.equal(history[3].data.target_revision, 'revision_2');
  assert.equal(history[4].data.target_revision, 'revision_1');
});

test('C08: expiry changes cannot extend a saved response or restore an invalidated generation', async t => {
  const f = fixture(t); const e = await f.create(); const r = responseInput();
  await f.req('POST', `/v1/events/${e.id}/responses`, r, 'user');
  await f.req('POST', `/v1/events/${e.id}/updates`, update(2, { expires_at: '2026-01-01T01:00:00Z' }));
  await f.req('POST', `/v1/events/${e.id}/updates`, update(3, { expires_at: EXPIRES }));
  const view = (await f.req('GET', `/v1/responses/${r.response_id}`, undefined, 'user')).json();
  assert.equal(view.routing_state, 'blocked'); assert.equal(view.expires_at, EXPIRES);
  const unchanged = await f.create(); const r2 = responseInput();
  await f.req('POST', `/v1/events/${unchanged.id}/responses`, r2, 'user');
  f.setTime(Date.parse(EXPIRES));
  const expired = (await f.req('GET', `/v1/responses/${r2.response_id}`, undefined, 'user')).json();
  assert.equal(expired.routing_state, 'expired'); assert.equal(expired.execution_authorized, false);
});

test('C09: source queries are read-only; source reports cannot mint delivery, verification or read receipts', async t => {
  const f = fixture(t); const e = await f.create(); const r = responseInput();
  await f.req('POST', `/v1/events/${e.id}/responses`, r, 'user');
  const before = snapshot(f.db);
  for (let i = 0; i < 2; i++) {
    const response = (await f.req('GET', `/v1/responses/${r.response_id}`)).json();
    assert.equal(response.execution_authorized, false); assert.equal(response.execution_state, 'not_observed');
    assert.equal(response.routing_state, 'waiting_source'); assert.equal(response.verification, 'not_verified');
    assert.equal((await f.req('GET', '/v1/source/responses')).json().items.length, 1);
    await f.req('GET', `/v1/events/${e.id}/history`);
  }
  assert.deepEqual(snapshot(f.db), before);
  const source = f.config.principals.find(p => p.id === 'source'); assert.ok(source?.kind === 'source');
  source.capabilities = ['publish', 'reply'];
  for (const path of [`/v1/responses/${r.response_id}`, '/v1/source/responses', `/v1/events/${e.id}/history`]) code(await f.req('GET', path), 403, 'FORBIDDEN');
  source.capabilities.push('read_responses');
  code(await f.req('POST', `/v1/events/${e.id}/updates`, update(2, { verification: 'passed' })), 422, 'INVALID_INPUT');
  code(await f.req('POST', `/v1/events/${e.id}/updates`, update(2, { kind: 'source_received' })), 422, 'INVALID_INPUT');
  assert.equal((await f.req('POST', `/v1/events/${e.id}/updates`, update(2, { kind: 'source_result_reported', body: 'Source claims success' }))).statusCode, 200);
  const event = (await f.req('GET', `/v1/events/${e.id}`, undefined, 'user')).json();
  assert.equal(event.verification, 'not_verified'); assert.equal(event.delivery_state, 'not_observed');
  assert.equal(event.evidence_level, 'source_reported'); assert.equal(event.read_state.version, 0);
  assert.equal(event.disposition, 'open');
});

test('C10: reading is monotonic and independent; late source updates cannot reopen user decisions', async t => {
  const f = fixture(t); const e = await f.create();
  assert.equal((await f.req('PUT', `/v1/events/${e.id}/read-state`, { event_version: 1 }, 'user')).statusCode, 200);
  let view = (await f.req('GET', `/v1/events/${e.id}`, undefined, 'device2')).json();
  assert.equal(view.read_state.unread, false); assert.equal(view.can_respond, true); assert.equal(view.event_version, 1);
  code(await f.req('PUT', `/v1/events/${e.id}/read-state`, { event_version: 2 }, 'user'), 409, 'EVENT_VERSION_CONFLICT');
  const disposition = { request_id: 'completed', expected_event_version: 1, disposition: 'completed' };
  const saved = await f.req('POST', `/v1/events/${e.id}/disposition`, disposition, 'user'); assert.equal(saved.statusCode, 200);
  assert.deepEqual((await f.req('POST', `/v1/events/${e.id}/disposition`, disposition, 'device2')).json(), saved.json());
  code(await f.req('POST', `/v1/events/${e.id}/disposition`, { ...disposition, disposition: 'open' }, 'user'), 409, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.req('POST', `/v1/events/${e.id}/updates`, update(2))).statusCode, 200);
  view = (await f.req('GET', `/v1/events/${e.id}`, undefined, 'user')).json();
  assert.equal(view.disposition, 'completed'); assert.equal(view.can_respond, false); assert.equal(view.read_state.unread, true);
  code(await f.req('POST', `/v1/events/${e.id}/responses`, responseInput({ event_version: 3 }), 'user'), 409, 'EVENT_CLOSED');
  assert.deepEqual(f.db.prepare('SELECT state FROM outbox').all(), [{ state: 'withheld' }]);
  await f.req('PUT', `/v1/events/${e.id}/read-state`, { event_version: 3 }, 'device2');
  await f.req('PUT', `/v1/events/${e.id}/read-state`, { event_version: 1 }, 'user');
  assert.equal((await f.req('GET', `/v1/events/${e.id}`, undefined, 'user')).json().read_state.version, 3);
  for (const disposition of ['paused', 'not_tracking']) {
    const other = await f.create();
    await f.req('POST', `/v1/events/${other.id}/disposition`, { request_id: disposition, expected_event_version: 1, disposition }, 'user');
    code(await f.req('POST', `/v1/events/${other.id}/responses`, responseInput({ event_version: 2 }), 'user'), 409, 'EVENT_CLOSED');
  }
});

test('C11: cursor pagination has stable order, no cross-scope records or gaps', async t => {
  const f = fixture(t); const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const e = await f.create(); ids.push(e.id);
    await f.req('POST', `/v1/events/${e.id}/responses`, responseInput(), 'user');
    await f.create({}, 'neighbor'); await f.create({}, 'foreign');
  }
  for (const [path, key, expected] of [
    ['/v1/events', 'id', ids],
    ['/v1/source/responses', 'event_id', ids],
  ] as const) {
    const found: string[] = []; let after: string | null = '0';
    while (after !== null) {
      const result = await f.req('GET', `${path}?limit=2&after=${after}`); assert.equal(result.statusCode, 200);
      const page = result.json(); assert.ok(page.items.length <= 2);
      found.push(...page.items.map((item: Record<string, string>) => item[key] as string));
      after = page.next_after;
    }
    assert.deepEqual(found, expected);
  }
  const history1 = (await f.req('GET', `/v1/events/${ids[0]}/history?limit=1`)).json();
  const history2 = (await f.req('GET', `/v1/events/${ids[0]}/history?limit=1&after=${history1.next_after}`)).json();
  assert.equal(history1.items[0].kind, 'event_created'); assert.equal(history2.items[0].kind, 'response_saved');
  assert.ok(history2.items[0].seq > history1.items[0].seq); assert.equal(history2.next_after, null);
});

test('C11: strict schemas, valid calendar times and explicit body/field/page limits', async t => {
  const f = fixture(t);
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'after=-1', 'after=9007199254740992', 'after=x', 'extra=1', 'limit=2&limit=3']) code(await f.req('GET', `/v1/events?${query}`), 422, 'INVALID_INPUT');
  for (const payload of [
    eventInput({ title: 'x'.repeat(201) }), eventInput({ body: 'x'.repeat(16001) }),
    eventInput({ expires_at: '2026-02-30T00:00:00Z' }), eventInput({ expires_at: '2026-01-01T24:00:00Z' }), eventInput({ expires_at: '2026-01-01T01:00:00' }),
    eventInput({ interaction: { id: 'q', actions: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, label: 'a', type: 'button' })) } }),
    eventInput({ interaction: { id: 'q', actions: [{ id: 'same', label: 'a', type: 'button' }, { id: 'same', label: 'b', type: 'text' }] } }),
    { ...eventInput(), owner_id: 'other' }, { ...eventInput(), callback_url: 'https://invalid.example' },
  ]) code(await f.req('POST', '/v1/events', payload), 422, 'INVALID_INPUT');
  code(await f.req('POST', '/v1/events', eventInput({ body: 'x'.repeat(70000) })), 413, 'INPUT_TOO_LARGE');
  const e = await f.create({ body: 'x'.repeat(16000), title: 'x'.repeat(200), expires_at: '2026-01-02T01:00:00+01:00' });
  const r = responseInput({ action_id: 'text', text: 'x'.repeat(4000) });
  code(await f.req('POST', `/v1/events/${e.id}/responses`, { ...r, text: 'x'.repeat(4001) }, 'user'), 422, 'INVALID_INPUT');
  assert.equal((await f.req('POST', `/v1/events/${e.id}/responses`, r, 'user')).statusCode, 200);
  assert.equal((await f.req('GET', `/v1/responses/${r.response_id}`, undefined, 'user')).json().text.length, 4000);
  assert.equal((await f.req('GET', `/v1/events?limit=100&after=0`)).statusCode, 200);
  f.setTime(NOW);
});
