import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CoreStore } from '../src/core.js';
import { schemaVersion } from '../src/schema.js';
import { openDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { NOW, code, fixture, responseInput, snapshot } from './helpers.js';

test('C05/C07: independent processes race on a real disk database; the SQLite slot stays unique', { timeout: 30000 }, async t => {
  const f = fixture(t, true); const e = await f.create();
  const children = ['user', 'device2'].map(actor => {
    const child = fork(fileURLToPath(new URL('./fixtures/contender.ts', import.meta.url)), [f.databasePath], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
    return { child, actor, exited, ready: once(child, 'message') };
  });
  for (const p of children) assert.deepEqual((await p.ready)[0], { ready: true });
  const outcomes = children.map(({ child, actor }) => {
    const result = once(child, 'message');
    child.send({ config: f.config, token: f.tokens[actor], event: e.id, input: responseInput() });
    return result;
  });
  const results = (await Promise.all(outcomes)).map(([result]) => result as { status: number; saved?: { response_id: string } });
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  for (const p of children) assert.deepEqual(await p.exited, [0, null]);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM responses').get() as { n: number }).n, 1);
  assert.throws(() => f.db.prepare("INSERT INTO responses(owner,id,event_id,source,epoch,interaction_id,interaction_version,data) SELECT owner,'another_id',event_id,source,epoch,interaction_id,interaction_version,data FROM responses").run(), /UNIQUE constraint failed/);
  const winner = results.find(r => r.status === 200); assert.ok(winner?.saved);
  const before = snapshot(f.db);
  await f.app.close();
  const db = openDatabase(f.databasePath);
  const reopened = createApp(db, false, { registry: f.registry, now: () => NOW }); t.after(() => reopened.close());
  assert.deepEqual(snapshot(db), before);
  const result = await reopened.inject({ method: 'GET', url: `/v1/responses/${winner.saved.response_id}`, headers: { authorization: `Bearer ${f.tokens.user}` } });
  assert.equal(result.statusCode, 200); assert.equal(result.json().event_id, e.id);
  const occupied = await reopened.inject({ method: 'POST', url: `/v1/events/${e.id}/responses`, payload: responseInput({ event_version: 2 }), headers: { authorization: `Bearer ${f.tokens.device2}` } });
  // Controlled clock must still be valid after the connection restart.
  code(occupied, 409, 'ACTION_ALREADY_RESERVED');
  assert.deepEqual(snapshot(db), before);
});

test('C06/C07: failed schema initialization rolls back atomically and can subsequently initialize cleanly', () => {
  const db = openDatabase(':memory:');
  try {
    db.pragma('max_page_count = 1');
    assert.throws(() => new CoreStore(db), /full/);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all(), []);
    assert.equal(db.pragma('application_id', { simple: true }), 0);
    assert.equal(db.pragma('user_version', { simple: true }), 0);
    db.pragma('max_page_count = 100');
    new CoreStore(db);
    assert.equal(db.pragma('user_version', { simple: true }), schemaVersion);
  } finally { db.close(); }
});

test('C07: unknown, unsupported and altered schemas are refused without clearing their records', async t => {
  const f = fixture(t);
  const unknown = openDatabase(join(f.root, 'foreign.sqlite'));
  t.after(() => unknown.close());
  unknown.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('preserve')");
  assert.throws(() => new CoreStore(unknown), /unrecognized/);
  assert.deepEqual(unknown.prepare('SELECT * FROM unrelated').all(), [{ value: 'preserve' }]);
  assert.equal(unknown.pragma('user_version', { simple: true }), 0);
  await f.create(); const before = snapshot(f.db);
  f.db.pragma('user_version = 999'); assert.throws(() => new CoreStore(f.db), /unrecognized/);
  assert.deepEqual(snapshot(f.db), before);
  f.db.pragma(`user_version = ${schemaVersion}`);
  f.db.exec('CREATE INDEX unsupported_index ON events(owner)');
  assert.throws(() => new CoreStore(f.db), /unrecognized/);
  assert.deepEqual(snapshot(f.db), before);
  const path = join(f.root, 'corrupt.sqlite'); writeFileSync(path, 'not a SQLite file');
  const original = readFileSync(path);
  assert.throws(() => openDatabase(path));
  assert.deepEqual(readFileSync(path), original);
});
