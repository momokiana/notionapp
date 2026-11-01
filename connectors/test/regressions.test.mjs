import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Spool } from '../src/spool.mjs';
import { flush } from '../src/transport.mjs';
import { readPrivate, MAX_BODY } from '../src/validation.mjs';
import { main } from '../src/cli.mjs';
import { fixture, http, json, self, jsonBody, createInput } from './helpers.mjs';

test('same-instance async drain rejects reentry; original delayed ACK cannot race a later update', async t => {
  const f = fixture(); let release, accepted; const entered = new Promise(r => { accepted = r; });
  let attempts = 0, remote = 0;
  const h = await http(t, async (req, res) => {
    if (req.url === '/v1/source/self') return json(res, self(f.c));
    const body = JSON.parse(await jsonBody(req)); attempts++;
    const ack = { event_id: 'event', event_version: ++remote, saved_at: '2026-01-01T00:00:00Z' };
    if (!body.update_id) { release = () => json(res, ack); accepted(); } else json(res, ack);
  }); f.c.server.base = h.origin; f.c.uniflo = { origin: 'http://127.0.0.1:7311', sessions: [{ key: 'demo:one', alias: 'Demo' }] };
  const s = new Spool(f.c, { init: true }); t.after(() => s.close()); const gen = s.beginObservation();
  s.observe('demo:one', { state: 'work' }, 1, gen); s.observe('demo:one', { state: 'idle' }, 2, gen);
  const original = s.prepare(); const first = flush(s, { max: 1 }); await entered;
  await assert.rejects(flush(s), /FLUSH_IN_PROGRESS/); assert.equal(attempts, 1); release(); await first;
  await flush(s); assert.equal(remote, 2); assert.equal(s.db.prepare('SELECT version FROM maps').get().version, 2);
  const oldAck = JSON.parse(s.db.prepare('SELECT ack FROM queue ORDER BY seq LIMIT 1').get().ack);
  s.saved(original, oldAck); assert.equal(s.db.prepare('SELECT version FROM maps').get().version, 2);
  assert.throws(() => s.saved(original, { ...oldAck, event_id: 'different' }), /RECEIPT_CONFLICT/);
});

test('normal and repeated close really close SQLite; a close error keeps the actual writer lock', () => {
  const f = fixture(), s = new Spool(f.c, { init: true });
  const nativeClose = s.db.close.bind(s.db); s.db.close = () => { throw Error('synthetic close failure'); };
  assert.throws(() => s.close(), /synthetic close failure/); assert.ok(fs.existsSync(`${f.c.spool}.lock`));
  assert.equal(s.db.prepare('SELECT 1 AS n').get().n, 1);
  s.db.close = nativeClose; s.close(); s.close();
  assert.throws(() => s.db.prepare('SELECT 1')); assert.equal(fs.existsSync(`${f.c.spool}.lock`), false);
});

async function growsAfterStat(path, action) {
  const named = fs.statSync(path), originalStat = fs.fstatSync, originalRead = fs.readSync; let grew = false, bytes = 0;
  fs.fstatSync = (...args) => {
    const value = originalStat(...args);
    if (!grew && value.ino === named.ino && value.dev === named.dev) {
      grew = true;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', 'import{appendFileSync}from"node:fs";appendFileSync(process.argv[1],Buffer.alloc(1024*1024,120));', '--', path]);
      assert.equal(child.status, 0);
    }
    return value;
  };
  fs.readSync = (fd, ...args) => {
    const stat = originalStat(fd); const n = originalRead(fd, ...args);
    if (stat.ino === named.ino && stat.dev === named.dev) bytes += n; return n;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(async () => action(), /INPUT_TOO_LARGE/); }
  finally { fs.fstatSync = originalStat; fs.readSync = originalRead; syncBuiltinESMExports(); }
  assert.equal(grew, true); assert.equal(bytes, MAX_BODY + 1);
}

test('private config actual read is bounded despite real producer append after fstat', async () => {
  const f = fixture(), path = join(f.root, 'growth.json'); fs.writeFileSync(path, '{"synthetic":true}', { mode: 0o600 });
  assert.equal(readPrivate(path), '{"synthetic":true}'); await growsAfterStat(path, () => readPrivate(path));
});

test('actual CLI producer file read is bounded despite real producer append after fstat', async () => {
  const f = fixture(), cp = f.save(), input = join(f.root, 'growth-input.json'); const s = new Spool(f.c, { init: true }); s.close();
  fs.writeFileSync(input, JSON.stringify(createInput()), { mode: 0o600 }); await growsAfterStat(input, () => main(['enqueue', cp, input]));
  const reopened = new Spool(f.c); assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM queue').get().n, 0); reopened.close();
});
