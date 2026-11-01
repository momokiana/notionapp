import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createApp } from 'notification-server/app';
import { AppCredentials } from '../src/credentials.js';
import { AppRuntime } from '../src/runtime.js';
import { fixture, actions } from './helpers.js';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const terminal = (res: import('node:http').ServerResponse, n: number, item: Record<string, unknown>, status = 'completed') => {
  const send = (type: string, value: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  send('response.created', { response: { id: `fixture_response_${n}`, status: 'in_progress' } });
  send('response.output_item.done', { output_index: 0, item });
  send(status === 'completed' ? 'response.completed' : 'response.incomplete', { response: { id: `fixture_response_${n}`, status, output: [item],
    ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  res.end();
};
const textItem = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic Responses result, not a real Mio reply.', annotations: [] }] };
async function localModel(root: string, port: number, key: string) {
  const credentials = new AppCredentials(join(root, 'shared-auth.json'), 'openai');
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  // Explicit test injection; do not discover unrelated providers' credentials while registering this local endpoint.
  runtime.refresh = async () => ({ aborted: false, errors: new Map() });
  runtime.registerProvider('openai', { api: 'openai-responses', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: key,
    models: [{ id: 'gpt-6-sol', name: 'Synthetic local Responses fixture, not Mio', reasoning: true,
      thinkingLevelMap: { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }, input: ['text'], contextWindow: 128000,
      maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  return runtime;
}
function profile() {
  const f = fixture(true, { provider: 'openai', id: 'gpt-6-sol' });
  const persona = 'SYNTHETIC NAMED PERSONA ONLY: fixture-responses-persona-2026. Not real Mio.';
  const key = 'sk-synthetic-local-responses-credential';
  writeFileSync(join(f.root, 'persona.txt'), persona, { mode: 0o600 });
  writeFileSync(join(f.root, 'settings.json'), JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-6-sol', defaultThinkingLevel: 'xhigh' }), { mode: 0o600 });
  writeFileSync(join(f.root, 'shared-auth.json'), JSON.stringify({ openai: { type: 'api_key', key } }), { mode: 0o600 });
  writeFileSync(f.configFile, JSON.stringify({ ...f.value, model: { ...f.value.model, thinking: 'xhigh' },
    identity_reference: { name: 'Synthetic Responses fixture, not Mio', persona_file: join(f.root, 'persona.txt'), persona_sha256: hash(persona),
      settings_file: join(f.root, 'settings.json'), credentials_file: join(f.root, 'shared-auth.json') } }), { mode: 0o600 });
  f.init(); return { f, persona, key };
}

test('real SDK1.4 Responses HTTP/SSE: named synthetic persona/xhigh, button and exact text, three physical requests, one original event', async t => {
  const { f, persona, key } = profile(); const authBefore = readFileSync(join(f.root, 'shared-auth.json'));
  const requests: { url: string | undefined; auth: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const b of req) chunks.push(Buffer.from(b));
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
    const n = requests.length;
    const item = n <= 2 ? { type: 'function_call', id: `fc_fixture_${n}`, call_id: `call_fixture_${n}`, name: 'app_question',
      arguments: JSON.stringify({ title: 'Synthetic Responses question', body: n === 1 ? 'Choose the button; this is a local fixture.' : 'Enter exact text; this is a local fixture.', ttl_seconds: 3600, actions }) } : textItem;
    terminal(res, n, item);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const models = await localModel(f.root, address.port, key); const r = await AppRuntime.open(f.config, { modelRuntime: models });
  const app = createApp(r.native.database, false, { registry: r.registry }); await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => { await r.stop(); await app.close(); await r.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const bound = app.server.address(); assert(bound && typeof bound === 'object');
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${bound.port}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${f.userToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(res.status, 200); return res.json();
  };
  const first = await r.runOnce() as { state: string; event_id: string }; assert.equal(first.state, 'report_saved');
  const responseIds: string[] = [];
  for (const [action, text] of [['confirm', ''], ['reply', 'Exact Responses input 🧪\n第二行']] as const) {
    const e = await call(`/v1/events/${first.event_id}`); const id = randomUUID(); responseIds.push(id);
    await call(`/v1/events/${e.id}/responses`, { response_id: id, event_version: e.event_version, interaction_id: e.interaction.id, interaction_version: e.interaction_version, action_id: action, text });
    assert.equal((await r.runOnce() as { state: string }).state, 'report_saved');
  }
  const last = await call(`/v1/events/${first.event_id}`); assert.equal(last.body, textItem.content[0]!.text);
  assert.equal(last.disposition, 'open'); assert.equal(last.verification, 'not_verified');
  assert.equal((await call('/v1/events')).items.length, 1); assert.equal(requests.length, 3);
  assert(requests.every(v => v.url === '/v1/responses' && v.auth === `Bearer ${key}` && v.body.max_output_tokens === 16384));
  assert(requests.every(v => JSON.stringify(v.body.input).includes(persona) && (v.body.reasoning as { effort: string }).effort === 'xhigh'));
  for (const id of responseIds) { assert(JSON.stringify(requests).includes(id)); const reply = await call(`/v1/responses/${id}`);
    assert.equal(reply.source_delivery.state, 'source_received'); assert.equal(reply.execution_state, 'not_observed'); assert.equal(reply.verification, 'not_verified'); }
  assert(JSON.stringify(requests[2]!.body).includes('Exact Responses input'));
  const nativeSystems = r.native.entries().filter(v => v.type === 'message' && v.message.role === 'system');
  assert(JSON.stringify(nativeSystems).includes(persona), 'Effective persona is private persisted system context, not just a config label');
  const log = r.native.metadata(); assert.equal(log.filter(v => v.kind === 'model_request_intent').length, 3);
  assert.equal(log.filter(v => v.kind === 'model_http_attempt').length, 3); assert.equal(log.filter(v => v.kind === 'model_http_response' && v.status === 200).length, 3);
  assert.deepEqual(readFileSync(join(f.root, 'shared-auth.json')), authBefore);
});

for (const fault of ['disconnect', '503', 'redirect', 'incomplete'] as const) test(`actual Responses ${fault}: one physical attempt, no retry or false complete result, original reservation survives restart`, async t => {
  const { f, key } = profile(); let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    if (fault === 'disconnect') { req.socket.destroy(); return; }
    if (fault === '503') { res.writeHead(503, { 'content-type': 'application/json', connection: 'close' }); res.end('{"error":{"message":"synthetic unavailable"}}'); return; }
    if (fault === 'redirect') { res.writeHead(302, { location: '/v1/must-not-follow', connection: 'close' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' }); terminal(res, 1, textItem, 'incomplete');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const a = server.address(); assert(a && typeof a === 'object');
  const models = await localModel(f.root, a.port, key); let r = await AppRuntime.open(f.config, { modelRuntime: models });
  t.after(async () => { await r.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  assert.equal((await r.runOnce() as { state: string }).state, 'model_outcome_unresolved'); assert.equal(calls, 1);
  assert.equal(r.native.metadata().filter(v => v.kind === 'model_request_intent').length, 1);
  assert.equal(r.native.metadata().filter(v => v.kind === 'model_http_attempt').length, 1);
  assert.equal(r.core.listEvents(f.user(), { after: 0, limit: 100 }, f.registry()).items.length, 0);
  await r.close(); r = await AppRuntime.open(f.config, { modelRuntime: models });
  assert.equal((await r.runOnce() as { state: string }).state, 'original_model_run_unresolved'); assert.equal(calls, 1);
  assert.equal(r.native.metadata().filter(v => v.kind === 'model_request_intent').length, 1);
});
