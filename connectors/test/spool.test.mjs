import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync, readFileSync, symlinkSync, existsSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Spool } from '../src/spool.mjs';
import { config, operation, sourceBinding, hash, privateParent, readPrivate } from '../src/validation.mjs';
import { fixture, createInput } from './helpers.mjs';

test('strict producer contract, Unicode, calendar dates, no routes/shell/identity injection', () => {
  assert.doesNotThrow(() => operation(createInput()));
  for (const v of [{ ...createInput(), command: 'anything' }, { ...createInput(), event_id: 'other' }, createInput({ source_binding: 'a'.repeat(64) }), createInput({ title: '😀'.repeat(201) }), createInput({ expires_at: '2099-02-30T00:00:00Z' }), createInput({ interaction: { id: 'q', actions: [{ id: 'x', label: 'x', type: 'shell' }] } })]) assert.throws(() => operation(v));
  assert.throws(() => operation({ ...createInput(), kind: 'update', event_id: 'event', payload: { update_id: 'u', expected_event_version: 0, kind: 'progress', body: '' } }));
});

test('private durable spool: original canonical operation survives close/reopen; altered duplicate rejected', () => {
  const f = fixture(); let s = new Spool(f.c, { init: true });
  assert.equal(s.enqueue(createInput()).state, 'connector_persisted');
  assert.equal(s.enqueue(JSON.parse(JSON.stringify(createInput()))).state, 'pending');
  assert.throws(() => s.enqueue(createInput({ body: 'changed' })), /IDEMPOTENCY_CONFLICT/);
  const row = s.prepare(); assert.equal(row.state, 'unknown'); assert.equal(JSON.parse(row.wire).source_binding, sourceBinding(f.c));
  s.close(); assert.equal(existsSync(`${f.c.spool}.lock`), false);
  s = new Spool(f.c); assert.equal(s.prepare().wire, row.wire); s.close();
  assert.equal(readFileSync(f.c.spool).includes(Buffer.from(f.c.server.token)), false);
});

test('single writer covers async lifetime; changed source/epoch/actor/token/installation/origin cannot reopen', () => {
  const f = fixture(), s = new Spool(f.c, { init: true });
  assert.throws(() => new Spool(f.c), /EEXIST/); s.close();
  for (const key of ['source_id', 'source_epoch', 'id', 'owner_id', 'installation', 'base', 'token']) {
    const c = structuredClone(f.c); c.server[key] = key === 'token' ? 'e'.repeat(64) : key === 'base' ? 'https://example.org' : `${c.server[key]}x`;
    assert.throws(() => new Spool(c), /SPOOL_BINDING_MISMATCH/);
  }
});

test('unknown database/permissions/symlinks are refused without clearing bytes', () => {
  const f = fixture(); writeFileSync(f.c.spool, 'unknown fixture', { mode: 0o600 }); const before = hash(readFileSync(f.c.spool));
  assert.throws(() => new Spool(f.c)); assert.equal(hash(readFileSync(f.c.spool)), before);
  unlinkSync(f.c.spool); symlinkSync('/dev/null', f.c.spool); assert.throws(() => new Spool(f.c)); unlinkSync(f.c.spool);
  chmodSync(f.root, 0o755); assert.throws(() => privateParent(f.c.spool)); chmodSync(f.root, 0o700);
  writeFileSync(f.c.spool, '', { mode: 0o644 }); assert.throws(() => new Spool(f.c));
  assert.throws(() => readPrivate(f.c.spool));
});

test('recognized application marker alone cannot authorize unknown schema', () => {
  const f = fixture(); const s = new Spool(f.c, { init: true }); s.close();
  const d = new DatabaseSync(f.c.spool); d.exec('CREATE TABLE unexpected(x)'); d.close();
  assert.throws(() => new Spool(f.c), /UNKNOWN_SPOOL/);
});

test('queue capacity is explicit, duplicates still reconcile at full; observation watermark rolls back with outbox', () => {
  const f = fixture(); f.c.uniflo = { origin: 'http://127.0.0.1:7311', sessions: [{ key: 'demo:one', alias: 'Demo' }] };
  const s = new Spool(f.c, { init: true, capacity: 1 }); s.enqueue(createInput());
  assert.equal(s.enqueue(createInput()).state, 'pending'); const generation = s.beginObservation();
  assert.throws(() => s.observe('demo:one', { state: 'work' }, 20, generation), /SPOOL_FULL/);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM maps').get().n, 0);
  assert.equal(s.observer().state, 'snapshot'); s.close();
});

test('binding is frozen for the complete async lifetime, not a caller-mutable config reference', () => {
  const f = fixture(), s = new Spool(f.c, { init: true }); const original = sourceBinding(s.c);
  f.c.server.source_epoch = 'different'; f.c.server.token = 'e'.repeat(64);
  assert.equal(sourceBinding(s.c), original); assert.throws(() => { s.c.server.source_epoch = 'mutated'; }, TypeError); s.close();
});

test('source-binding injection is included in final UTF8 byte budget before any send', () => {
  const f = fixture(), s = new Spool(f.c, { init: true }); let input;
  for (let n = 1; n <= 200; n++) {
    const candidate = createInput({ body: '😀'.repeat(16000), session_ref: 's'.repeat(512), target_revision: 'r'.repeat(200), title: '😀'.repeat(n) });
    const bytes = Buffer.byteLength(JSON.stringify(candidate.payload));
    if (bytes > 65460 && bytes <= 65536) { input = candidate; break; }
  }
  assert.ok(input); s.enqueue(input); assert.throws(() => s.prepare(), /INPUT_TOO_LARGE/);
  assert.equal(s.status().counts[0].state, 'pending'); s.close();
});

test('fixed binding hash tuple and secure origins; Uniflo explicit selection delimiter rejected', () => {
  const f = fixture(); assert.equal(sourceBinding(f.c), hash(JSON.stringify(['synthetic_owner', 'synthetic_actor', 'synthetic_source', 'epoch_1'])));
  for (const url of ['http://example.org', 'https://user@example.org', 'https://example.org/path', 'https://example.org?token=x']) {
    assert.throws(() => config({ ...f.c, server: { ...f.c.server, base: url } }));
  }
  assert.throws(() => config({ ...f.c, uniflo: { origin: 'http://127.0.0.1:7311', sessions: [{ key: 'demo:one,two', alias: 'Demo' }] } }));
});
