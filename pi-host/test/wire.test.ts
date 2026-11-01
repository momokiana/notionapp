import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppRuntime } from '../src/runtime.js';
import { fixture, actions, respond } from './helpers.js';

for (const disconnected of [false, true]) test(`real SDK OpenAI-compatible HTTP/SSE transport (${disconnected ? 'unknown disconnect, no retry' : 'tool question and exact native response'}); local model fixture only`, async t => {
  const f = fixture(true, { provider: 'isolated-http', id: 'fixture-http' }); f.init();
  const requests: { authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const key = 'literal-isolated-wire-fixture-not-a-real-key';
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    requests.push({ authorization: req.headers.authorization, body });
    if (disconnected) { req.socket.destroy(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
    const send = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: 'local-wire-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-http', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) })}\n\n`);
    if (requests.length === 1) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'wire-question', type: 'function', function: { name: 'app_question', arguments: JSON.stringify({ title: '实际 SDK 传输夹具', body: '模型是隔离本地夹具，不是云端澪。', ttl_seconds: 3600, actions }) } }] }, null);
      send({}, 'tool_calls');
    } else { send({ role: 'assistant', content: 'HTTP/SSE 原事件结果；仍属本地模型夹具。' }, null); send({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeIdleConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address === 'object');
  writeFileSync(join(f.value.data_dir, 'agent', 'models.json'), JSON.stringify({ providers: { 'isolated-http': { api: 'openai-completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: 'fixture-http', name: 'Local HTTP fixture', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }), { mode: 0o600 });
  writeFileSync(join(f.value.data_dir, 'agent', 'auth.json'), JSON.stringify({ 'isolated-http': { type: 'api_key', key } }), { mode: 0o600 });
  const r = await AppRuntime.open(f.config); t.after(() => r.close());
  const first = await r.runOnce() as { state: string; event_id?: string };
  if (disconnected) {
    assert.equal(first.state, 'model_outcome_unresolved'); assert.equal((await r.runOnce() as { state: string }).state, 'original_model_run_unresolved');
    assert.equal(requests.length, 1); assert.equal(r.core.listEvents(f.user(), { after: 0, limit: 100 }, f.registry()).items.length, 0);
  } else {
    assert.equal(first.state, 'report_saved'); assert(first.event_id);
    const original = '经实际 SDK HTTP 发送的原文 🧪'; const responseId = respond(r, f, first.event_id, original, 'reply');
    assert.equal((await r.runOnce() as { state: string }).state, 'report_saved'); assert.equal(requests.length, 2);
    assert(JSON.stringify(requests[1]!.body.messages).includes(original)); assert(JSON.stringify(requests[1]!.body.messages).includes(responseId));
    const event = r.core.getEvent(f.user(), first.event_id, f.registry()); assert.equal(event.body, 'HTTP/SSE 原事件结果；仍属本地模型夹具。'); assert.equal(event.disposition, 'open');
    assert.equal(r.core.getResponse(f.user(), responseId, f.registry()).source_delivery?.state, 'source_received');
  }
  assert(requests.every(request => request.authorization === `Bearer ${key}`));
  assert(!JSON.stringify(requests.map(request => request.body)).includes(key));
});
