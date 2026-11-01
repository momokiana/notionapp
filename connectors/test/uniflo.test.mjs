import test from 'node:test';
import assert from 'node:assert/strict';
import { Spool } from '../src/spool.mjs';
import { observeOnce, ndjson } from '../src/uniflo.mjs';
import { fixture, http, json } from './helpers.mjs';

const key = 'demo:session_1';
const session = (status = 'work') => ({ key, harness: 'demo', id: 'session_1', status, updated_at: 123, title: 'PRIVATE_TITLE', source: '/PRIVATE_PATH', preview: 'PRIVATE_PREVIEW', pid: 999 });
async function observed(t, envelopes, { capacity = 10000, snapshot = session(), snapshotSeq = 10, healthSeq = 10, raw } = {}) {
  const f = fixture(), requests = [];
  const h = await http(t, (req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    if (req.url === '/v1/health') return json(res, { ok: true, schema: 1, seq: healthSeq });
    if (req.url === `/v1/sessions/${encodeURIComponent(key)}`) return json(res, snapshot ?? {}, snapshot ? 200 : 404, { 'x-uniflo-seq': String(snapshotSeq) });
    if (req.url.startsWith('/v1/stream.ndjson?')) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const bytes = Buffer.from(raw ?? envelopes.map(x => JSON.stringify(x)).join('\n') + '\n');
      // Split EVERY UTF-8 byte to exercise chunk boundaries, including emoji.
      for (const b of bytes) res.write(Buffer.from([b])); res.end(); return;
    }
    json(res, {}, 404);
  });
  f.c.uniflo = { origin: h.origin, token: 'synthetic_uniflo_token', sessions: [{ key, alias: 'Synthetic selection 中文😀' }] };
  const s = new Spool(f.c, { init: true, capacity }); t.after(() => s.close()); return { s, requests, f };
}
const hello = (n = 20) => ({ type: 'hello', seq: n, version: 'synthetic_v1', server: 'synthetic_server' });

test('snapshot→hello→replay window, filtering jumps and duplicates; no private upstream fields leave spool outbox', async t => {
  const { s, requests } = await observed(t, [hello(), { type: 'session', seq: 11, session: session('idle') },
    { type: 'session', seq: 11, session: session('idle') }, { type: 'event', seq: 19, event: { id: 'PRIVATE_EVENT', session: key, kind: 'assistant_message', text: 'PRIVATE_TEXT 😀' } },
    { type: 'new_type_v1', seq: 20, private: 'ignored' }]);
  await assert.rejects(observeOnce(s), /STREAM_ENDED/);
  const rows = s.db.prepare('SELECT * FROM queue ORDER BY seq').all(); assert.equal(rows.length, 3);
  const wire = rows.map(r => r.payload).join('\n');
  for (const secret of ['PRIVATE_TITLE', '/PRIVATE_PATH', 'PRIVATE_PREVIEW', 'PRIVATE_EVENT', 'PRIVATE_TEXT', key, 'synthetic_uniflo_token']) assert.equal(wire.includes(secret), false, secret);
  assert.equal(JSON.parse(rows[1].payload).kind, 'progress'); assert.equal(JSON.parse(JSON.parse(rows[1].payload).body).state, 'idle');
  assert.equal(JSON.parse(rows[0].payload).interaction, undefined);
  assert.equal(s.db.prepare('SELECT watermark FROM maps').get().watermark, 19);
  assert.equal(s.observer().state, 'disconnected');
  assert.ok(requests.every(r => r.method === 'GET' && !r.url.includes('token=') && !r.url.includes('/memory') && !r.url.includes('/resume')));
  assert.ok(requests.at(-1).url.includes('since=10'));
});

test('lagged does not pretend to backfill history; restart resnapshot permits lower daemon seq but keeps original mapping', async t => {
  const { s } = await observed(t, [hello(), { type: 'lagged', seq: 10, missed: 100 }]);
  await assert.rejects(observeOnce(s), /STREAM_LAGGED/); assert.equal(s.observer().reason, 'STREAM_LAGGED');
  const first = s.db.prepare('SELECT * FROM queue').get();
  await assert.rejects(observeOnce(s), /STREAM_LAGGED/);
  const rows = s.db.prepare('SELECT * FROM queue ORDER BY seq').all(); assert.equal(rows.length, 2);
  assert.equal(rows[0].payload, first.payload); assert.equal(rows[1].kind, 'update');
  assert.equal(JSON.parse(JSON.parse(rows[1].payload).body).history_complete, false);
});

test('hello sequence rollback triggers gap without acknowledging replay', async t => {
  const { s } = await observed(t, [hello(9), { type: 'session', seq: 11, session: session('idle') }]);
  await assert.rejects(observeOnce(s), /SEQUENCE_ROLLBACK/);
  assert.equal(s.db.prepare('SELECT watermark FROM maps').get().watermark, 10);
});

test('removed is a progress observation, not deletion/completion; late event requires fresh metadata', async t => {
  const { s } = await observed(t, [hello(), { type: 'removed', seq: 11, key }, { type: 'event', seq: 12, event: { session: key, kind: 'turn_end' } }]);
  await assert.rejects(observeOnce(s), /METADATA_REQUIRED/);
  const row = s.db.prepare('SELECT payload FROM queue ORDER BY seq DESC LIMIT 1').get();
  assert.equal(JSON.parse(JSON.parse(row.payload).body).state, 'removed'); assert.equal(JSON.parse(row.payload).kind, 'progress');
  assert.equal(s.db.prepare('SELECT watermark FROM maps').get().watermark, 11);
});

test('missing snapshot never guesses target from event; unselected source ignored', async t => {
  const { s } = await observed(t, [hello(), { type: 'session', seq: 11, session: { ...session(), key: 'other:private' } }, { type: 'event', seq: 12, event: { session: key, kind: 'tool_call' } }], { snapshot: null });
  await assert.rejects(observeOnce(s), /METADATA_REQUIRED/);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM queue').get().n, 1);
});

test('backpressure cannot acknowledge an observation past unsaved queue gap', async t => {
  const { s } = await observed(t, [hello(), { type: 'session', seq: 12, session: session('idle') }], { capacity: 1 });
  await assert.rejects(observeOnce(s), /SPOOL_FULL/);
  assert.equal(s.db.prepare('SELECT watermark FROM maps').get().watermark, 10);
  assert.equal(s.observer().reason, 'SPOOL_FULL');
});

test('per-session snapshot watermarks bridge different snapshot times without using hello head as ACK', async t => {
  const f = fixture(), seen = [];
  const second = 'demo:session_2';
  const h = await http(t, (req, res) => {
    seen.push(req.url);
    if (req.url === '/v1/health') return json(res, { ok: true, schema: 1, seq: 10 });
    if (req.url === `/v1/sessions/${encodeURIComponent(key)}`) return json(res, session(), 200, { 'x-uniflo-seq': '10' });
    if (req.url === `/v1/sessions/${encodeURIComponent(second)}`) return json(res, { ...session('idle'), key: second, id: 'session_2' }, 200, { 'x-uniflo-seq': '20' });
    res.writeHead(200); res.end([hello(30), { type: 'session', seq: 15, session: session('idle') }, { type: 'session', seq: 15, session: { ...session(), key: second, id: 'session_2' } }].map(v => JSON.stringify(v)).join('\n') + '\n');
  });
  f.c.uniflo = { origin: h.origin, sessions: [{ key, alias: 'One' }, { key: second, alias: 'Two' }] };
  const s = new Spool(f.c, { init: true }); t.after(() => s.close()); await assert.rejects(observeOnce(s), /STREAM_ENDED/);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM queue').get().n, 3);
  assert.deepEqual(s.db.prepare('SELECT watermark FROM maps ORDER BY key').all().map(v => v.watermark), [15, 20]);
  assert.ok(seen.at(-1).includes('since=10'));
});

test('daemon restarts at lower seq: new baseline uses same original mapping, not another create', async t => {
  const f = fixture(); let n = 20;
  const h = await http(t, (req, res) => {
    if (req.url === '/v1/health') return json(res, { ok: true, schema: 1, seq: n });
    if (req.url.startsWith('/v1/sessions/')) return json(res, session(), 200, { 'x-uniflo-seq': String(n) });
    res.end(JSON.stringify(hello(n)) + '\n');
  }); f.c.uniflo = { origin: h.origin, sessions: [{ key, alias: 'Demo' }] };
  let s = new Spool(f.c, { init: true }); await assert.rejects(observeOnce(s), /STREAM_ENDED/); s.close(); n = 2;
  s = new Spool(f.c); t.after(() => s.close()); await assert.rejects(observeOnce(s), /STREAM_ENDED/);
  assert.deepEqual(s.db.prepare('SELECT kind FROM queue ORDER BY seq').all().map(r => r.kind), ['create', 'update']);
  assert.equal(s.db.prepare('SELECT watermark FROM maps').get().watermark, 2);
});

test('UTF-8 streaming handles Chinese/emoji, refuses partial line, invalid UTF8 and overlong line', async () => {
  const bytes = Buffer.from('{"text":"中文😀"}\n');
  const stream = () => new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(Buffer.from([b])); c.close(); } });
  const rows = []; for await (const v of ndjson(stream())) rows.push(v); assert.equal(rows[0].text, '中文😀');
  for (const b of [Buffer.from('{"text":"partial"}'), Buffer.from([255, 10]), Buffer.from('x'.repeat(65537) + '\n')]) {
    await assert.rejects(async () => { for await (const _ of ndjson(new ReadableStream({ start(c) { c.enqueue(b); c.close(); } }))) {} });
  }
});
