// Actual Fastify + actual CoreStore/SQLite, from a stable public-source scratch snapshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Spool } from '../src/spool.mjs';
import { flush } from '../src/transport.mjs';
import { sourceBinding } from '../src/validation.mjs';
import { fixture, createInput, http, json } from './helpers.mjs';
const src = process.env.CONNECTOR_TEST_SOURCE;
const { createApp } = await import(pathToFileURL(join(src, 'app.ts')));
const { openDatabase } = await import(pathToFileURL(join(src, 'database.ts')));
const { parseRegistry } = await import(pathToFileURL(join(src, 'auth.ts')));
const legacy = process.env.CONNECTOR_TEST_LEGACY === '1';
async function setup(t) {
  const f = fixture(); const principals = [{ kind: 'source', id: f.c.server.id, owner_id: f.c.server.owner_id, source_id: f.c.server.source_id, source_epoch: f.c.server.source_epoch, capabilities: ['publish'], token: f.c.server.token },
    { kind: 'user', id: 'synthetic_phone', owner_id: f.c.server.owner_id, token: 'd'.repeat(64) }];
  const db = openDatabase(join(f.root, 'ledger.sqlite')); const app = createApp(db, false, { registry: () => parseRegistry({ principals }) });
  await app.listen({ host: '127.0.0.1', port: 0 }); f.c.server.base = `http://127.0.0.1:${app.server.address().port}`;
  const s = new Spool(f.c, { init: true }); t.after(async () => { s.close(); await app.close(); }); return { f, s, app, db, principals };
}
if (legacy) {
  test('actual legacy server lacks protocol: connector sends zero create; bound direct POST rejected before writes', async t => {
    const { s, f, db } = await setup(t); s.enqueue(createInput());
    await assert.rejects(flush(s), /SOURCE_PROTOCOL_UNAVAILABLE/); assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 0);
    const wire = s.prepare().wire;
    const r = await fetch(`${f.c.server.base}/v1/events`, { method: 'POST', headers: { authorization: `Bearer ${f.c.server.token}`, 'content-type': 'application/json', 'x-notionapp-source-binding': sourceBinding(f.c) }, body: wire });
    assert.equal(r.status, 422); assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 0);
  });
} else {
  test('actual backend scripts create/update and lost durable ACK replay are one original event/history/outbox', async t => {
    const { s, db, f, app } = await setup(t); s.enqueue(createInput());
    await assert.rejects(flush(s, { afterResponse: () => { throw Error('synthetic crash window'); } }), /PUBLISH_UNKNOWN/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
    assert.equal((await flush(s)).count, 1); const event = db.prepare('SELECT id FROM events').get().id;
    s.enqueue({ id: 'op_update', kind: 'update', event_id: event, payload: { update_id: 'update_1', expected_event_version: 1, kind: 'source_result_reported', body: 'Synthetic source report' } });
    await flush(s); assert.equal(JSON.parse(db.prepare('SELECT data FROM events').get().data).event_version, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM history').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM commands').get().n, 0);
    const e = await app.inject({ method: 'GET', url: `/v1/events/${event}`, headers: { authorization: `Bearer ${f.c.server.token}` } });
    assert.equal(e.json().can_respond, false); assert.equal(e.json().verification, 'not_verified');
  });
  test('actual synchronous gate rejects probe→same-token owner/actor/source/epoch changes, including old ACK replay', async t => {
    for (const key of ['owner_id', 'id', 'source_id', 'source_epoch']) {
      const { f, s, db, principals } = await setup(t); s.enqueue(createInput());
      await assert.rejects(flush(s, { afterResponse: () => { throw Error('synthetic lost ACK'); } }));
      const origin = f.c.server.base; let posts = 0;
      const proxy = await http(t, async (req, res) => {
        const chunks = []; for await (const b of req) chunks.push(b);
        const r = await fetch(`${origin}${req.url}`, { method: req.method, headers: { authorization: `Bearer ${f.c.server.token}`, ...(req.method === 'POST' ? { 'content-type': 'application/json', 'x-notionapp-source-binding': req.headers['x-notionapp-source-binding'] } : {}) }, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
        const body = Buffer.from(await r.arrayBuffer());
        if (req.url === '/v1/source/self') principals[0][key] += '_changed'; else posts++;
        res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(body);
      });
      // Only for this synthetic harness: use same pinned public root via a local request router by replacing fetch URL, not spool binding.
      const originalFetch = globalThis.fetch;
      // Proxy's own fetch has no redirect:'error', so it bypasses the client's test interception.
      globalThis.fetch = (url, options) => originalFetch(String(url).startsWith(`${origin}/`) && options?.redirect === 'error' ? String(url).replace(origin, proxy.origin) : url, options);
      try { await assert.rejects(flush(s), /PUBLISH_BLOCKED/); } finally { globalThis.fetch = originalFetch; }
      assert.equal(posts, 1); assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
    }
  });
  test('actual backend user completion remains closed after connector late progress, notification/source states separate', async t => {
    const { f, s, app, db } = await setup(t); s.enqueue(createInput()); await flush(s); const event = db.prepare('SELECT id FROM events').get().id;
    const changed = await app.inject({ method: 'POST', url: `/v1/events/${event}/disposition`, headers: { authorization: 'Bearer ' + 'd'.repeat(64) }, payload: { request_id: 'completed', expected_event_version: 1, disposition: 'completed' } }); assert.equal(changed.statusCode, 200);
    s.enqueue({ id: 'late', kind: 'update', event_id: event, payload: { update_id: 'late', expected_event_version: 2, kind: 'progress', body: 'Late observation' } }); await flush(s);
    assert.equal(JSON.parse(db.prepare('SELECT data FROM events').get().data).disposition, 'completed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0);
  });
}
