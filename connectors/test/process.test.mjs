import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Spool, syncParent } from '../src/spool.mjs';
import { flush } from '../src/transport.mjs';
import { fixture, createInput, http, json, self, jsonBody } from './helpers.mjs';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const crash = fileURLToPath(new URL('./crash-child.mjs', import.meta.url));
function child(args) {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
  p.stdout.on('data', b => { out += b; }); p.stderr.on('data', b => { err += b; });
  return { process: p, done: new Promise((resolve, reject) => { p.once('error', reject); p.once('exit', (code, signal) => resolve({ code, signal, out, err })); }) };
}

test('actual CLI private init, offline enqueue, status and source-less flush rejection; no credential logs', async () => {
  const f = fixture(), cp = f.save(), op = join(f.root, 'operation.json'); writeFileSync(op, JSON.stringify(createInput()));
  for (const args of [['init', cp], ['enqueue', cp, op], ['status', cp]]) {
    const r = await child([cli, ...args]).done; assert.equal(r.code, 0, r.err); assert.equal(`${r.out}${r.err}`.includes(f.c.server.token), false);
  }
  f.c.server.base = 'http://127.0.0.1:1'; // changed binding cannot silently retarget offline pending
  f.save(); const rejected = await child([cli, 'flush', cp]).done; assert.equal(rejected.code, 1); assert.equal(rejected.out, '');
});

test('real SIGKILL after prepare and after remote ACK retains unknown; confirmed dead fixture lock is explicit recovery', async t => {
  const f = fixture(); const wires = [], stored = new Map();
  const h = await http(t, async (req, res) => {
    if (req.url === '/v1/source/self') return json(res, self(f.c));
    const wire = await jsonBody(req); wires.push(wire); const p = JSON.parse(wire);
    if (!stored.has(p.request_id)) stored.set(p.request_id, { event_id: 'synthetic_event', event_version: 1, saved_at: '2026-01-01T00:00:00Z' });
    json(res, stored.get(p.request_id));
  }); f.c.server.base = h.origin; const cp = f.save(); let s = new Spool(f.c, { init: true }); s.enqueue(createInput()); s.close();
  for (const mode of ['prepare', 'response']) {
    const r = await child([crash, cp, mode]).done; assert.equal(r.signal, 'SIGKILL');
    assert.ok(existsSync(`${f.c.spool}.lock`)); assert.throws(() => new Spool(f.c), /EEXIST/);
    // Not a product auto-unlock: this parent has just positively observed its exact child exit.
    unlinkSync(`${f.c.spool}.lock`); syncParent(f.c.spool);
    s = new Spool(f.c); assert.equal(s.prepare().state, 'unknown'); s.close();
  }
  s = new Spool(f.c); await flush(s); assert.equal(stored.size, 1); assert.equal(wires.length, 2); assert.equal(wires[0], wires[1]); s.close();
});

test('directory sync failure after commit returns no persistence/receipt success, recovery reconciles original row', () => {
  const f = fixture(), s = new Spool(f.c, { init: true });
  s.syncDirectory = () => { throw new Error('synthetic EIO'); };
  assert.throws(() => s.enqueue(createInput()), /synthetic EIO/); assert.throws(() => s.status(), /synthetic EIO/);
  s.syncDirectory = syncParent; assert.equal(s.enqueue(createInput()).state, 'pending');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM queue').get().n, 1); s.close();
});

test('SQLite physical page full rejects local enqueue and does not ACK partial queue', () => {
  const f = fixture(), s = new Spool(f.c, { init: true });
  const pages = s.db.prepare('PRAGMA page_count').get().page_count;
  s.db.exec(`PRAGMA max_page_count=${pages}`);
  assert.throws(() => s.enqueue(createInput({ body: 'a'.repeat(16000) })));
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM queue').get().n, 0); s.close();
});

test('actual run SIGTERM waits its own aborted request, removes only its lock and preserves pending', async t => {
  const f = fixture(); let entered;
  const waiting = new Promise(r => { entered = r; });
  const h = await http(t, (req, _res) => { entered(); }); f.c.server.base = h.origin;
  const cp = f.save(), s = new Spool(f.c, { init: true }); s.enqueue(createInput()); s.close();
  const running = child([cli, 'run', cp]); await waiting; running.process.kill('SIGTERM'); const r = await running.done;
  assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).state, 'stopped'); assert.equal(existsSync(`${f.c.spool}.lock`), false);
  const reopened = new Spool(f.c); assert.equal(reopened.status().counts[0].state, 'pending'); reopened.close();
});
