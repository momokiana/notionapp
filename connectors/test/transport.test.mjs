import test from 'node:test';
import assert from 'node:assert/strict';
import { Spool } from '../src/spool.mjs';
import { flush } from '../src/transport.mjs';
import { sourceBinding } from '../src/validation.mjs';
import { fixture, createInput, http, json, jsonBody, self } from './helpers.mjs';

// Synthetic HTTP protocol fixture, NOT the actual backend implementation.
async function publishing(t, behavior) {
  const f = fixture(), calls = [];
  const h = await http(t, async (req, res) => {
    if (req.url === '/v1/source/self') return json(res, self(f.c));
    const wire = await jsonBody(req); calls.push({ wire, path: req.url, binding: req.headers['x-notionapp-source-binding'] });
    await behavior(req, res, JSON.parse(wire), calls);
  }); f.c.server.base = h.origin;
  const s = new Spool(f.c, { init: true }); t.after(() => s.close()); return { f, s, calls };
}
const ack = (event = 'event_1', v = 1) => ({ event_id: event, event_version: v, saved_at: '2026-01-01T00:00:00Z' });

test('create/update use fixed original path/body and only database receipts', async t => {
  const { s, calls, f } = await publishing(t, (req, res, p) => json(res, ack('event_1', p.update_id ? 2 : 1)));
  s.enqueue(createInput()); assert.equal((await flush(s)).count, 1);
  s.enqueue({ id: 'operation_2', kind: 'update', event_id: 'event_1', payload: { update_id: 'update_1', expected_event_version: 1, kind: 'source_result_reported', body: 'Synthetic report, not verified' } });
  assert.equal((await flush(s)).count, 1); assert.equal(calls.length, 2);
  assert.equal(calls[1].path, '/v1/events/event_1/updates'); assert.equal(calls[0].binding, sourceBinding(f.c));
  assert.equal(JSON.parse(calls[0].wire).source_binding, sourceBinding(f.c));
  assert.equal(s.status().receipts, 'event_saved_is_not_source_received');
});

test('lost ACK/reopen retries identical persisted wire and ID, not a new event', async t => {
  let first = true;
  const { s, calls } = await publishing(t, (_req, res) => { if (first) { first = false; res.destroy(); } else json(res, ack()); });
  s.enqueue(createInput()); await assert.rejects(flush(s), /PUBLISH_UNKNOWN/);
  const wire = s.prepare().wire; assert.equal(s.status().counts[0].state, 'unknown');
  assert.equal((await flush(s)).count, 1); assert.equal(calls[0].wire, wire); assert.equal(calls[1].wire, wire);
});

test('4xx/version conflicts block fixed row; 5xx and malformed/mismatched ACK retain unknown', async t => {
  let status = 503;
  const { s, calls } = await publishing(t, (_req, res) => json(res, ack(), status)); s.enqueue(createInput());
  await assert.rejects(flush(s), /PUBLISH_UNKNOWN/); status = 409;
  await assert.rejects(flush(s), /PUBLISH_BLOCKED/); const count = calls.length;
  await assert.rejects(flush(s), /QUEUE_BLOCKED/); assert.equal(calls.length, count);
});

test('identity protocol/scopes/capabilities mismatches and old backend forbid every POST', async t => {
  const f = fixture(); let mode = 0, posts = 0;
  const h = await http(t, (req, res) => {
    if (req.method === 'POST') { posts++; return json(res, ack()); }
    const v = self(f.c); if (mode === 0) delete v.binding_protocol; if (mode === 1) v.source_epoch = 'other'; if (mode === 2) v.capabilities = [];
    json(res, v);
  }); f.c.server.base = h.origin; const s = new Spool(f.c, { init: true }); t.after(() => s.close()); s.enqueue(createInput());
  for (mode = 0; mode < 3; mode++) await assert.rejects(flush(s)); assert.equal(posts, 0); assert.equal(s.prepare().state, 'unknown');
});

test('Uniflo source overgrant is fail-closed, no interaction or input escalation', async t => {
  const f = fixture(); let posts = 0;
  const h = await http(t, (req, res) => { if (req.method === 'POST') posts++; json(res, { ...self(f.c), capabilities: ['publish', 'reply', 'deliver', 'read_responses'] }); });
  f.c.server.base = h.origin; f.c.uniflo = { origin: 'http://127.0.0.1:7311', sessions: [{ key: 'demo:one', alias: 'Demo' }] };
  const s = new Spool(f.c, { init: true }); t.after(() => s.close()); s.enqueue(createInput());
  await assert.rejects(flush(s), /OBSERVATION_REQUIRES_PUBLISH_ONLY/); assert.equal(posts, 0);
});

test('response lost after acceptance before local durable ACK remains replayable original', async t => {
  const { s, calls } = await publishing(t, (_req, res) => json(res, ack())); s.enqueue(createInput());
  await assert.rejects(flush(s, { afterResponse: () => { throw new Error('synthetic local storage failure'); } }), /PUBLISH_UNKNOWN/);
  assert.equal(s.prepare().state, 'unknown'); await flush(s); assert.equal(calls[0].wire, calls[1].wire);
});

test('redirects are never followed, wrong update target receipt remains unknown', async t => {
  let mode = 0;
  const { s } = await publishing(t, (_req, res) => {
    if (mode === 0) { res.writeHead(302, { location: 'http://127.0.0.1:1/private' }); res.end(); }
    else json(res, ack('wrong_event', 2));
  });
  s.enqueue({ id: 'operation_2', kind: 'update', event_id: 'event_1', payload: { update_id: 'update_1', expected_event_version: 1, kind: 'progress', body: '' } });
  await assert.rejects(flush(s), /PUBLISH_UNKNOWN/); mode = 1; await assert.rejects(flush(s), /PUBLISH_UNKNOWN/);
  assert.equal(s.prepare().state, 'unknown');
});
