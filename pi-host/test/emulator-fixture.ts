/** Explicit, isolated manual Android integration fixture. Never submits user/device/OS receipts. */
import { createServer } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from 'notification-server/app';
import { pushConfig } from 'notification-server/notifications';
import { AppRuntime } from '../src/runtime.js';
import { fixture } from './helpers.js';
import { realNtfy } from './real-ntfy.js';

process.umask(0o077);
if (process.env.NOTIONAPP_EMULATOR_FIXTURE !== '1' || process.argv.length !== 3) throw new Error('Explicit NOTIONAPP_EMULATOR_FIXTURE=1 and verified absolute ntfy binary required');
const cleanups: (() => Promise<void>)[] = [];
let runtimeToStop: AppRuntime | undefined;
let stopping = false;
process.once('SIGTERM', () => { stopping = true; void runtimeToStop?.stop(); });
process.once('SIGINT', () => { stopping = true; void runtimeToStop?.stop(); });
try {
const ntfy = await realNtfy(process.argv[2]!, true);
cleanups.push(() => ntfy.close());
const f = fixture(true, { provider: 'emulator-local', id: 'deterministic' });
let calls = 0;
const model = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 1048576) { res.writeHead(413).end(); return; } chunks.push(Buffer.from(chunk)); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  calls++;
  writeFileSync(join(f.root, `model-request-${calls}.json`), JSON.stringify(body), { mode: 0o600 });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  const send = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: `emulator-${calls}`, object: 'chat.completion.chunk', created: 1, model: 'deterministic', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) })}\n\n`);
  if (calls <= 2) {
    const actions = calls === 1 ? [{ id: 'confirm', label: 'Confirm test', type: 'button' }, { id: 'reply', label: 'Text reply', type: 'text' }] : [{ id: 'reply', label: 'Text reply', type: 'text' }];
    send({ role: 'assistant', tool_calls: [{ index: 0, id: `question-${calls}`, type: 'function', function: { name: 'app_question', arguments: JSON.stringify({ title: calls === 1 ? 'Emulator button test' : 'Emulator text test', body: 'Isolated Android + SDK integration. The model is a local deterministic endpoint, not production Mio.', ttl_seconds: 7200, actions }) } }] }, null);
    send({}, 'tool_calls');
  } else { send({ role: 'assistant', content: 'Local source reported the final result on the original event. No external action executed; verification remains not_verified.' }, null); send({}, 'stop'); }
  res.end('data: [DONE]\n\n');
});
cleanups.push(async () => { model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); });
await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
const ma = model.address(); if (!ma || typeof ma === 'string') throw new Error('Owned model listener unavailable');
f.init();
writeFileSync(join(f.value.data_dir, 'agent', 'models.json'), JSON.stringify({ providers: { 'emulator-local': { api: 'openai-completions', baseUrl: `http://127.0.0.1:${ma.port}/v1`, models: [{ id: 'deterministic', name: 'Local deterministic emulator fixture', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }), { mode: 0o600 });
writeFileSync(join(f.value.data_dir, 'agent', 'auth.json'), JSON.stringify({ 'emulator-local': { type: 'api_key', key: 'local-synthetic-authorization-only' } }), { mode: 0o600 });
const runtime = await AppRuntime.open(f.config);
runtimeToStop = runtime; cleanups.push(() => runtime.close());
const app = createApp(runtime.native.database, false, { registry: runtime.registry, push: pushConfig(ntfy.origin, ntfy.token, true) });
cleanups.push(() => app.close());
await app.listen({ host: '127.0.0.1', port: 0 });
const aa = app.server.address(); if (!aa || typeof aa === 'string') throw new Error('Owned event listener unavailable');
writeFileSync(join(f.root, 'operator-private.json'), JSON.stringify({ origin: `http://127.0.0.1:${aa.port}`, user_token: f.userToken, ntfy_origin: ntfy.origin, subscriber: ntfy.subscriber, start_signal: join(f.root, 'start.signal') }), { mode: 0o600 });
console.log(JSON.stringify({ fixture_ready: true, private_root: f.root, credentials_not_logged: true, requires_real_android_registration_and_ui: true }));
  while (!stopping) {
    if (existsSync(join(f.root, 'start.signal'))) await runtime.runOnce();
    const events = runtime.core.listEvents(f.user(), { after: 0, limit: 100 }, f.registry()).items;
    const responses = runtime.core.listResponses(f.source(), { after: 0, limit: 100 }, f.registry()).items;
    writeFileSync(join(f.root, 'observed-ledger-private.json'), JSON.stringify({ model_requests: calls, events, responses, history: events.map(e => ({ event_id: e.id, items: runtime.core.listHistory(f.user(), e.id, { after: 0, limit: 100 }).items })) }), { mode: 0o600 });
    await new Promise(resolve => setTimeout(resolve, 500));
  }
} finally {
  let failure: unknown;
  try { await runtimeToStop?.stop(); } catch (error) { failure = error; }
  for (const close of cleanups.reverse()) { try { await close(); } catch (error) { failure ??= error; } }
  if (failure) throw failure;
  console.log(JSON.stringify({ fixture_stopped: true, preserved_original_ledger: true }));
}
