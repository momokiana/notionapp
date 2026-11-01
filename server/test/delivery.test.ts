import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseRegistry, type Principal } from '../src/auth.js';
import { DeliveryStore, type Command, type NativeHost, type NativeReceipt } from '../src/delivery.js';
import { SourcePump, NativeReceiptQuery, MAX_NATIVE_RECEIPT_BYTES } from '../src/source-adapter.js';
import { CoreStore } from '../src/core.js';
import { openDatabase } from '../src/database.js';
import { ledgerDdl, APP_ID, schemaVersion } from '../src/schema.js';
import { code, fixture, NOW, responseInput, snapshot } from './helpers.js';

function setup(t: Parameters<typeof fixture>[0], persistent = false) {
  const f = fixture(t, persistent);
  const sourcePrincipal = f.config.principals.find(p => p.kind === 'source' && p.id === 'source')!;
  assert.equal(sourcePrincipal.kind, 'source');
  if (sourcePrincipal.kind !== 'source') throw new Error('fixture');
  sourcePrincipal.capabilities.push('deliver');
  const authority = () => { const registry = f.registry(); return { registry, principal: registry.authenticate(`Bearer ${f.tokens.source}`) }; };
  const store = new DeliveryStore(f.db, () => NOW);
  const host: NativeHost & { calls: number } = {
    synchronousDurableGate: true, calls: 0,
    compareAndEnqueue(c: Command, now: number) {
      this.calls++; assert.equal(c.response.target.session_ref, 'fixture_session'); assert.equal(c.response.target.state_revision, 'revision_1'); assert.ok(Date.parse(c.response.expires_at) > now);
      return { command_id: c.id, session_ref: c.response.target.session_ref, state_revision: c.response.target.state_revision, message_id: 'native_message' };
    }, getReceipt() { return null; },
  };
  const ready = async () => { const e = await f.create(); const input = responseInput(); assert.equal((await f.req('POST', `/v1/events/${e.id}/responses`, input, 'user')).statusCode, 200); return { ...e, response: input.response_id }; };
  return { ...f, store, authority, host, ready, sourcePrincipal };
}

test('D01: explicit delivery capability, exact owner/source/epoch, claim idempotency and one stable command', async t => {
  const f = setup(t); const e = await f.ready();
  code(await f.req('POST', '/v1/source/commands/claim', { claim_id: 'no_user' }, 'user'), 403, 'FORBIDDEN');
  code(await f.req('POST', '/v1/source/commands/claim', { claim_id: 'no_neighbor' }, 'neighbor'), 403, 'FORBIDDEN');
  const first = await f.req('POST', '/v1/source/commands/claim', { claim_id: 'claim_1' }); assert.equal(first.statusCode, 200, first.body);
  const c = first.json().command as Command; assert.equal(c.response_id, e.response); assert.equal(c.state, 'effect_unknown');
  assert.deepEqual((await f.req('POST', '/v1/source/commands/claim', { claim_id: 'claim_1' })).json(), first.json());
  assert.equal((await f.req('POST', '/v1/source/commands/claim', { claim_id: 'claim_2' })).json().command, null);
  code(await f.req('GET', `/v1/source/commands/${c.id}`, undefined, 'user'), 403, 'FORBIDDEN');
  code(await f.req('POST', `/v1/source/commands/${c.id}/validate`, {} , 'neighbor'), 403, 'FORBIDDEN');
  f.sourcePrincipal.source_epoch = 'epoch_2';
  code(await f.req('GET', `/v1/source/commands/${c.id}`), 404, 'NOT_FOUND');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM commands').get() as { n: number }).n, 1);
});

test('D02: validate is not a permit; every qualification changed before final gate prevents native acceptance', async t => {
  for (const change of ['pause', 'complete', 'interaction', 'target', 'revoke', 'epoch', 'expired']) {
    const f = setup(t); const e = await f.ready(); const a = f.authority(); const c = f.store.claim(a.principal, `claim_${change}`, a.registry).command!;
    assert.equal(f.store.validate(a.principal, c.id, a.registry).execution_authorized, false);
    if (change === 'pause' || change === 'complete') assert.equal((await f.req('POST', `/v1/events/${e.id}/disposition`, { request_id: 'decision', expected_event_version: 2, disposition: change === 'pause' ? 'paused' : 'completed' }, 'user')).statusCode, 200);
    if (change === 'interaction' || change === 'target') assert.equal((await f.req('POST', `/v1/events/${e.id}/updates`, { update_id: 'new_question', expected_event_version: 2, kind: 'progress', body: 'changed', ...(change === 'target' ? { target_revision: 'revision_2' } : { interaction: e.input.interaction }) })).statusCode, 200);
    if (change === 'revoke') f.sourcePrincipal.capabilities = ['read_responses', 'publish'];
    if (change === 'epoch') f.sourcePrincipal.source_epoch = 'epoch_2';
    if (change === 'expired') f.setTime(Date.parse('2099-01-01T00:00:00Z'));
    const store = change === 'expired' ? new DeliveryStore(f.db, () => Date.parse('2099-01-01T00:00:00Z')) : f.store;
    assert.throws(() => store.submitAtGate(f.authority, c.id, f.host)); assert.equal(f.host.calls, 0, change);
  }
});

test('D03: synchronous final gate holds real SQLite lock against another process; later disposition does not erase receipt', async t => {
  const f = setup(t, true); const e = await f.ready(); const a = f.authority(); const c = f.store.claim(a.principal, 'gate', a.registry).command!;
  const base = f.host.compareAndEnqueue.bind(f.host);
  f.host.compareAndEnqueue = (command, now) => {
    const result = execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/delivery-process.ts', import.meta.url)), 'contend', f.databasePath], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 });
    assert.equal(result.trim(), 'SQLITE_BUSY'); return base(command, now);
  };
  const receipt = f.store.submitAtGate(f.authority, c.id, f.host); assert.equal(f.host.calls, 1);
  assert.deepEqual(f.store.submitAtGate(f.authority, c.id, f.host), receipt); assert.equal(f.host.calls, 1);
  assert.equal((await f.req('POST', `/v1/events/${e.id}/disposition`, { request_id: 'after', expected_event_version: 2, disposition: 'paused' }, 'user')).statusCode, 200);
  assert.equal(f.store.get(a.principal, c.id).state, 'source_received');
  const view = (await f.req('GET', `/v1/responses/${e.response}`, undefined, 'user')).json();
  assert.equal(view.routing_state, 'blocked'); assert.equal(view.source_delivery.state, 'source_received'); assert.equal(view.execution_state, 'not_observed');
});

test('D04: exact receipt immutable, progress/result associated to original event, no reopen or duplicate history', async t => {
  const f = setup(t); const e = await f.ready(); const a = f.authority(); const c = f.store.claim(a.principal, 'receive', a.registry).command!;
  const r: NativeReceipt = { command_id: c.id, session_ref: 'wrong', state_revision: 'revision_1', message_id: 'native_1' };
  code(await f.req('POST', `/v1/source/commands/${c.id}/receipt`, { receipt_id: 'r1', ...r }), 409, 'RECEIPT_TARGET_MISMATCH');
  r.session_ref = 'fixture_session';
  assert.equal((await f.req('POST', `/v1/source/commands/${c.id}/receipt`, { receipt_id: 'r1', ...r })).statusCode, 200);
  code(await f.req('POST', `/v1/source/commands/${c.id}/receipt`, { receipt_id: 'r1', ...r, message_id: 'different' }), 409, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.req('POST', `/v1/events/${e.id}/disposition`, { request_id: 'done', expected_event_version: 2, disposition: 'completed' }, 'user')).statusCode, 200);
  const update = { update_id: 'result', expected_event_version: 3, kind: 'source_result_reported', body: 'Source result, not verified' };
  const result = await f.req('POST', `/v1/source/commands/${c.id}/updates`, update); assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual((await f.req('POST', `/v1/source/commands/${c.id}/updates`, update)).json(), result.json());
  const current = (await f.req('GET', `/v1/events/${e.id}`, undefined, 'user')).json(); assert.equal(current.disposition, 'completed'); assert.equal(current.event_version, 4);
  const history = (await f.req('GET', `/v1/events/${e.id}/history`, undefined, 'user')).json().items as { kind: string; data: any }[];
  assert.equal(history.filter(h => h.kind === 'command_update_link').length, 1); assert.equal(history.find(h => h.kind === 'command_update_link')!.data.command_id, c.id);
});

test('D05: async native host is rejected before invocation and uncertain attempts never enqueue twice', async t => {
  const f = setup(t); await f.ready(); const a = f.authority(); const c = f.store.claim(a.principal, 'async', a.registry).command!;
  let calls = 0;
  const asyncHost = { synchronousDurableGate: true, async compareAndEnqueue() { calls++; return {}; }, getReceipt() { return null; } } as unknown as NativeHost;
  assert.throws(() => f.store.submitAtGate(f.authority, c.id, asyncHost), /synchronous/); assert.equal(calls, 0);
  f.host.compareAndEnqueue = () => { calls++; throw new Error('native receipt lost after input may have happened'); };
  assert.throws(() => f.store.submitAtGate(f.authority, c.id, f.host)); assert.equal(calls, 1);
  assert.throws(() => f.store.submitAtGate(f.authority, c.id, f.host), /never enqueue/); assert.equal(calls, 1);
});

test('D06: real process SIGKILL after durable native acceptance reopens both ledgers and only queries old command', { timeout: 30000 }, async t => {
  const f = setup(t, true); const e = await f.ready();
  const auth = join(f.root, 'auth.json'); writeFileSync(auth, JSON.stringify(f.config), { mode: 0o600 });
  const journal = join(f.root, 'pump.json'); const native = join(f.root, 'native.json');
  const child = fork(fileURLToPath(new URL('./fixtures/delivery-process.ts', import.meta.url)), ['crash', f.databasePath, auth, journal, native, f.tokens.source!], { execArgv: ['--import', 'tsx'], stdio: 'ignore' });
  const exit = await once(child, 'exit'); assert.deepEqual(exit, [null, 'SIGKILL']);
  const persisted = JSON.parse(readFileSync(native, 'utf8')) as NativeReceipt;
  const db = openDatabase(f.databasePath); t.after(() => db.close()); const reopened = new DeliveryStore(db, () => NOW);
  let enqueue = 0;
  const host: NativeHost = { synchronousDurableGate: true, compareAndEnqueue() { enqueue++; throw new Error('must not retry'); }, getReceipt(id) { assert.equal(id, persisted.command_id); return JSON.parse(readFileSync(native, 'utf8')) as NativeReceipt; } };
  const result = new SourcePump(reopened, f.authority, host, journal).runOnce(); assert.equal(result.state, 'source_received'); assert.equal(enqueue, 0);
  assert.equal(reopened.get(f.authority().principal, persisted.command_id).response_id, e.response);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM commands').get() as { n: number }).n, 1);
});

test('D11: legal Unicode/escaped maximum receipts fit bounded real HTTP query; budget+1 still rejects', async t => {
  const f = setup(t); let body = '';
  const http = createServer((_req, res) => { res.writeHead(200); res.end(body); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening'); t.after(() => new Promise<void>(resolve => http.close(() => resolve())));
  const query = new NativeReceiptQuery(`http://127.0.0.1:${(http.address() as { port: number }).port}`, 'a'.repeat(64));
  for (const character of ['🙂', '\u0000']) {
    const e = await f.create({ session_ref: character.repeat(512), target_revision: character.repeat(200) });
    assert.equal((await f.req('POST', `/v1/events/${e.id}/responses`, responseInput(), 'user')).statusCode, 200);
    const a = f.authority(); const c = f.store.claim(a.principal, `wide_${character === '🙂' ? 'unicode' : 'escaped'}`, a.registry).command!;
    const receipt = { command_id: c.id, session_ref: e.input.session_ref, state_revision: e.input.target_revision, message_id: character.repeat(512) };
    const saved = await f.req('POST', `/v1/source/commands/${c.id}/receipt`, { receipt_id: 'wide', ...receipt }); assert.equal(saved.statusCode, 200, saved.body);
    body = JSON.stringify(receipt); assert.ok(Buffer.byteLength(body) > 4096); assert.ok(Buffer.byteLength(body) < MAX_NATIVE_RECEIPT_BYTES);
    assert.deepEqual(await query.get(c.id), receipt);
  }
  body = 'x'.repeat(MAX_NATIVE_RECEIPT_BYTES + 1);
  await assert.rejects(query.get('budget_negative'), /body too large/);
});

test('D10: lost claim ACK survives journal/DB reopen; preparation crash stays unknown and never changes source binding', async t => {
  const f = setup(t, true); await f.ready(); const journal = join(f.root, 'lost-claim.json');
  const original = f.store.claim.bind(f.store);
  f.store.claim = (...args) => { original(...args); throw new Error('lost claim ACK'); };
  assert.throws(() => new SourcePump(f.store, f.authority, f.host, journal).runOnce(), /lost claim/);
  const db = openDatabase(f.databasePath); t.after(() => db.close()); const reopened = new DeliveryStore(db, () => NOW);
  const result = new SourcePump(reopened, f.authority, f.host, journal).runOnce();
  assert.equal(result.state, 'effect_unknown'); assert.equal(f.host.calls, 0);
  assert.equal((db.prepare('SELECT count(*) AS n FROM commands').get() as { n: number }).n, 1);
  f.sourcePrincipal.source_epoch = 'epoch_2';
  assert.throws(() => new SourcePump(reopened, f.authority, f.host, journal).runOnce(), /identity changed/);
});

test('D09: loopback bridge is query-only, bounded and rejects mismatched receipts/redirects', async t => {
  let mode = 'ok'; let calls = 0;
  const http = createServer((req, res) => {
    calls++; assert.equal(req.method, 'GET');
    if (mode === 'redirect') { res.writeHead(302, { location: '/commands/c1' }); res.end(); return; }
    if (mode === 'missing') { res.writeHead(404); res.end(); return; }
    res.writeHead(200); res.end(JSON.stringify({ command_id: mode === 'wrong' ? 'other' : 'c1', session_ref: 'native_session', state_revision: 'r1', message_id: 'message_1' }));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening'); t.after(() => new Promise<void>(resolve => http.close(() => resolve())));
  const query = new NativeReceiptQuery(`http://127.0.0.1:${(http.address() as { port: number }).port}`, 'a'.repeat(64));
  assert.equal((await query.get('c1'))!.command_id, 'c1');
  mode = 'wrong'; await assert.rejects(query.get('c1'), /correlation/);
  mode = 'redirect'; await assert.rejects(query.get('c1')); assert.equal(calls, 3);
  mode = 'missing'; assert.equal(await query.get('c1'), null);
  assert.throws(() => new NativeReceiptQuery('http://external.invalid/', 'a'.repeat(64)), /loopback/);
});

test('D08: independent claim processes reserve the response once', { timeout: 30000 }, async t => {
  const f = setup(t, true); await f.ready();
  const auth = join(f.root, 'claim-auth.json'); writeFileSync(auth, JSON.stringify(f.config), { mode: 0o600 });
  const results = await Promise.all(['claim_a', 'claim_b'].map(id => new Promise<{ id: string | null }>((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./fixtures/delivery-process.ts', import.meta.url)), ['claim', f.databasePath, auth, f.tokens.source!, id], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = ''; child.stdout!.on('data', chunk => { output += String(chunk); }); child.on('error', reject);
    child.on('exit', status => { if (status !== 0) reject(new Error('claim process failed')); else resolve(JSON.parse(output) as { id: string | null }); });
  })));
  assert.equal(results.filter(r => r.id !== null).length, 1);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM commands').get() as { n: number }).n, 1);
});

test('D07: exact v1 migration preserves six-table content and a failed migration rolls back', async t => {
  const f = setup(t); await f.ready(); const before = snapshot(f.db);
  for (const table of ['notifications', 'notice_batches', 'push_devices', 'commands']) f.db.exec(`DROP TABLE ${table}`);
  f.db.pragma('user_version=1'); new CoreStore(f.db);
  assert.deepEqual(snapshot(f.db), before); assert.equal(f.db.pragma('user_version', { simple: true }), schemaVersion);
  const db = openDatabase(':memory:'); t.after(() => db.close());
  for (const sql of ledgerDdl) db.exec(sql); db.pragma(`application_id=${APP_ID}`); db.pragma('user_version=1');
  const exec = db.exec.bind(db); db.exec = (sql: string) => { const value = exec(sql); if (sql.includes('CREATE TABLE commands')) throw new Error('injected migration failure'); return value; };
  assert.throws(() => new CoreStore(db), /injected/); assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='commands'").get() as { n: number }).n, 0);
});
