/** Explicit local named-profile/Responses Android fixture. Synthetic persona/model only; NEVER real Mio. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createApp } from 'notification-server/app';
import { pushConfig } from 'notification-server/notifications';
import { AppCredentials } from '../src/credentials.js';
import { AppRuntime } from '../src/runtime.js';
import { fixture } from './helpers.js';
import { realNtfy } from './real-ntfy.js';

process.umask(0o077);
if (process.env.NOTIONAPP_EMULATOR_FIXTURE !== '1' || process.env.NOTIONAPP_EMULATOR_PROFILE_FIXTURE !== '1' || process.argv.length !== 3) throw new Error('Explicit emulator/profile fixture switches and verified absolute ntfy binary required');
const cleanups: (() => Promise<void>)[] = [];
let runtimeToStop: AppRuntime | undefined; let stopping = false;
process.once('SIGTERM', () => { stopping = true; void runtimeToStop?.stop(); });
process.once('SIGINT', () => { stopping = true; void runtimeToStop?.stop(); });
try {
  const ntfy = await realNtfy(process.argv[2]!, true); cleanups.push(() => ntfy.close());
  const f = fixture(true, { provider: 'openai', id: 'gpt-6-sol' });
  const persona = 'SYNTHETIC NAMED APP FIXTURE ONLY. You are Fixture Identity, NOT real cloud Mio. Preserve marker profile-android-2026.';
  const key = 'sk-synthetic-profile-emulator-only';
  writeFileSync(join(f.root, 'persona.txt'), persona, { mode: 0o600 });
  writeFileSync(join(f.root, 'settings.json'), JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-6-sol', defaultThinkingLevel: 'xhigh' }), { mode: 0o600 });
  writeFileSync(join(f.root, 'shared-auth.json'), JSON.stringify({ openai: { type: 'api_key', key } }), { mode: 0o600 });
  writeFileSync(f.configFile, JSON.stringify({ ...f.value, model: { ...f.value.model, thinking: 'xhigh' },
    identity_reference: { name: 'Synthetic App profile, NOT Mio', persona_file: join(f.root, 'persona.txt'), persona_sha256: createHash('sha256').update(persona).digest('hex'),
      settings_file: join(f.root, 'settings.json'), credentials_file: join(f.root, 'shared-auth.json') } }), { mode: 0o600 });
  let calls = 0;
  const model = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 1048576) { res.writeHead(413).end(); return; } chunks.push(Buffer.from(chunk)); }
    calls++; const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    writeFileSync(join(f.root, `model-request-${calls}.json`), JSON.stringify(body), { mode: 0o600 });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
    const send = (type: string, value: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    send('response.created', { response: { id: `profile_local_${calls}`, status: 'in_progress' } });
    const item = calls <= 2 ? { type: 'function_call', id: `fc_profile_${calls}`, call_id: `call_profile_${calls}`, name: 'app_question', arguments: JSON.stringify({
      title: calls === 1 ? 'Profile fixture button test' : 'Profile fixture text test',
      body: 'Synthetic named profile + Pi1.4 Responses transport. This is NOT a real Mio reply.', ttl_seconds: 7200,
      actions: calls === 1 ? [{ id: 'confirm', label: 'Confirm test', type: 'button' }, { id: 'reply', label: 'Text reply', type: 'text' }] : [{ id: 'reply', label: 'Text reply', type: 'text' }],
    }) } : { type: 'message', id: 'msg_profile_final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', annotations: [],
      text: 'Synthetic profile/Responses round trip finished on the original event. NOT real Mio. No external action executed; not_verified.' }] };
    send('response.output_item.done', { output_index: 0, item });
    send('response.completed', { response: { id: `profile_local_${calls}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
  });
  cleanups.push(async () => { model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve)); const ma = model.address();
  if (!ma || typeof ma === 'string') throw new Error('Owned model listener unavailable');
  f.init();
  const models = await ModelRuntime.create({ credentials: new AppCredentials(join(f.root, 'shared-auth.json'), 'openai'), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  // Trusted, explicitly synthetic fixture injection; production named mode has no custom models file/discovery.
  models.refresh = async () => ({ aborted: false, errors: new Map() });
  models.registerProvider('openai', { api: 'openai-responses', baseUrl: `http://127.0.0.1:${ma.port}/v1`, apiKey: key,
    models: [{ id: 'gpt-6-sol', name: 'LOCAL synthetic profile fixture, NOT Mio', reasoning: true,
      thinkingLevelMap: { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      input: ['text'], contextWindow: 128000, maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const runtime = await AppRuntime.open(f.config, { modelRuntime: models }); runtimeToStop = runtime; cleanups.push(() => runtime.close());
  const app = createApp(runtime.native.database, false, { registry: runtime.registry, push: pushConfig(ntfy.origin, ntfy.token, true) }); cleanups.push(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 }); const aa = app.server.address();
  if (!aa || typeof aa === 'string') throw new Error('Owned event listener unavailable');
  writeFileSync(join(f.root, 'operator-private.json'), JSON.stringify({ origin: `http://127.0.0.1:${aa.port}`, user_token: f.userToken, ntfy_origin: ntfy.origin,
    subscriber: ntfy.subscriber, start_signal: join(f.root, 'start.signal'), synthetic_profile: true }), { mode: 0o600 });
  console.log(JSON.stringify({ fixture_ready: true, private_root: f.root, credentials_not_logged: true, synthetic_profile_not_mio: true, requires_real_android_registration_and_ui: true }));
  while (!stopping) {
    if (existsSync(join(f.root, 'start.signal'))) await runtime.runOnce();
    const events = runtime.core.listEvents(f.user(), { after: 0, limit: 100 }, f.registry()).items;
    const responses = runtime.core.listResponses(f.source(), { after: 0, limit: 100 }, f.registry()).items;
    writeFileSync(join(f.root, 'observed-ledger-private.json'), JSON.stringify({ model_requests: calls, events, responses,
      history: events.map(e => ({ event_id: e.id, items: runtime.core.listHistory(f.user(), e.id, { after: 0, limit: 100 }).items })) }), { mode: 0o600 });
    await new Promise(resolve => setTimeout(resolve, 500));
  }
} finally {
  let failure: unknown;
  try { await runtimeToStop?.stop(); } catch (error) { failure = error; }
  for (const close of cleanups.reverse()) { try { await close(); } catch (error) { failure ??= error; } }
  if (failure) throw failure;
  console.log(JSON.stringify({ fixture_stopped: true, preserved_original_ledger: true }));
}
