import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryModelsStore, normalizeContext, type Model } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { assertIdentity, loadConfig } from '../src/config.js';
import { AppCredentials } from '../src/credentials.js';
import { modelBudget, checkBudgetSupport, checkOutputPayload } from '../src/model-budget.js';
import { NativeSession, responseType, status } from '../src/native.js';
import { AppRuntime } from '../src/runtime.js';
import { fixture, fakeModels, ask, manualEvent, respond } from './helpers.js';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
function namedFixture() {
  const f = fixture(false, { provider: 'openai', id: 'gpt-6-sol' });
  const persona = join(f.root, 'persona.txt'); const settings = join(f.root, 'settings.json'); const credentials = join(f.root, 'shared-auth.json');
  const text = 'SYNTHETIC PERSONA ONLY. My name is Fixture Identity, not real Mio. Keep this exact marker: fixture-persona-2026.';
  writeFileSync(persona, text, { mode: 0o600 });
  writeFileSync(settings, JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-6-sol', defaultThinkingLevel: 'xhigh',
    packages: ['!must-never-execute-or-load'] }), { mode: 0o600 });
  writeFileSync(credentials, JSON.stringify({ openai: { type: 'api_key', key: 'sk-synthetic-shared-profile-not-a-real-key' },
    unrelated: { type: 'api_key', key: '!must-never-execute-or-discover' } }), { mode: 0o600 });
  const reference = { name: 'Synthetic fixture identity, not Mio', persona_file: persona, persona_sha256: sha(text), settings_file: settings, credentials_file: credentials };
  const value = { ...f.value, model: { ...f.value.model, thinking: 'xhigh' }, identity_reference: reference };
  writeFileSync(f.configFile, JSON.stringify(value), { mode: 0o600 });
  return { f, persona, settings, credentials, text, reference, value };
}

test('named persona references preserve exact model/xhigh and actual SDK prompt; no global rules, profiles, or conversations load', async t => {
  const p = namedFixture(); const c = loadConfig(p.f.configFile); p.f.init();
  const marker = join(p.f.value.data_dir, 'work', 'AGENTS.md'); writeFileSync(marker, 'UNWANTED_WORK_RULE_MUST_NOT_LOAD', { mode: 0o600 });
  const originalAuth = readFileSync(p.credentials);
  const r = await AppRuntime.open(c); t.after(() => r.close());
  assert(r.session.systemPrompt.includes(p.text)); assert(!r.session.systemPrompt.includes('UNWANTED_WORK_RULE_MUST_NOT_LOAD'));
  assert(r.session.systemPrompt.includes('not a QQ, Feishu, patrol, or work conversation'));
  assert.equal(r.session.thinkingLevel, 'xhigh'); assert.equal(r.session.model?.id, 'gpt-6-sol');
  assert.equal(r.native.manager.buildSessionContext().thinkingLevel, 'xhigh');
  assert.deepEqual(r.session.getActiveToolNames(), ['app_question']); assert.equal(r.session.getCallableToolNames().length, 0);
  for (const name of ['auth.json', 'models.json', 'models-store.json']) assert(!existsSync(join(c.data_dir, 'agent', name)));
  assert.deepEqual(readFileSync(p.credentials), originalAuth);
  const info = status(c); assert(info.state === 'initialized'); assert.equal(info.identity?.name, p.reference.name);
  assert(!JSON.stringify(info).includes(p.text)); assert(!JSON.stringify(info).includes('sk-synthetic'));
  assert.equal((await r.runOnce() as { state: string }).state, 'initial_model_disabled');
  assert.equal(r.native.metadata().filter(v => v.kind === 'model_request_intent').length, 0);
});

test('persona/model/reference changes reject new work while an existing exact durable native receipt remains queryable', async t => {
  const p = namedFixture(); p.f.init(); const c = p.f.config;
  const r = await AppRuntime.open(c); t.after(() => r.close());
  const e = manualEvent(r); const response = respond(r, p.f, e.id);
  assert.equal((await r.runOnce() as { state: string }).state, 'source_received_model_disabled');
  const command = r.native.entries().find(v => v.type === 'custom_message' && v.customType === responseType)!;
  assert(command.type === 'custom_message'); const id = (command.details as { command_id: string }).command_id;
  const receipt = r.host.getReceipt(id); assert(receipt);
  writeFileSync(p.persona, p.text + ' changed', { mode: 0o600 });
  assert.throws(() => assertIdentity(c), /IDENTITY_PERSONA_CHANGED/); assert.throws(() => p.f.config, /IDENTITY_PERSONA_CHANGED/);
  assert.deepEqual(r.host.getReceipt(id), receipt);
  assert.equal(r.core.getResponse(p.f.user(), response, p.f.registry()).source_delivery?.state, 'source_received');
  writeFileSync(p.persona, p.text, { mode: 0o600 });
  writeFileSync(p.settings, JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-6-sol', defaultThinkingLevel: 'off' }), { mode: 0o600 });
  assert.throws(() => assertIdentity(c), /IDENTITY_MODEL_SELECTION_CHANGED/);
  assert.deepEqual(r.host.getReceipt(id), receipt);
  assert.equal(r.native.metadata().filter(v => v.kind === 'model_request_intent').length, 0);
});

test('named reference rejects changed permissions, symbolic paths, mixed custom prompts and App-local model/auth overrides', async t => {
  const p = namedFixture(); p.f.init();
  chmodSync(p.persona, 0o644); assert.throws(() => p.f.config, /PRIVATE_FILE_REQUIRED/); chmodSync(p.persona, 0o600);
  const link = join(p.f.root, 'persona-link'); symlinkSync(p.persona, link);
  writeFileSync(p.f.configFile, JSON.stringify({ ...p.value, identity_reference: { ...p.reference, persona_file: link } }), { mode: 0o600 });
  assert.throws(() => p.f.config, /SYMLINK_NOT_ALLOWED/);
  writeFileSync(p.f.configFile, JSON.stringify({ ...p.value, system_prompt_file: p.persona }), { mode: 0o600 });
  assert.throws(() => p.f.config, /IDENTITY_WITH_CUSTOM_SYSTEM_PROMPT_FORBIDDEN/);
  writeFileSync(p.f.configFile, JSON.stringify(p.value), { mode: 0o600 });
  writeFileSync(join(p.f.value.data_dir, 'agent', 'models.json'), '{}', { mode: 0o600 });
  await assert.rejects(AppRuntime.open(p.f.config), /NAMED_IDENTITY_LOCAL_PROFILE_FORBIDDEN/);
  unlinkSync(join(p.f.value.data_dir, 'agent', 'models.json'));
  const r = await AppRuntime.open(p.f.config); t.after(() => r.close());
  writeFileSync(p.credentials, '{}', { mode: 0o600 }); assert.throws(() => assertIdentity(r.config), /EXPLICIT_APP_MODEL_CREDENTIAL_REQUIRED/);
});

test('explicit output modes cannot silently downgrade; budget and named identity are immutable binding inputs', () => {
  const f = fixture(false); const first = f.config;
  assert.deepEqual(first.model_budget, { request_limit: 3, output: { mode: 'protocol_tokens', max_tokens: 16384 } });
  assert.throws(() => modelBudget({ request_limit: 3, output: { mode: 'provider_managed', max_tokens: 16384 } }), /INVALID_MODEL_OUTPUT_BUDGET/);
  assert.throws(() => modelBudget({ request_limit: 0, output: { mode: 'provider_managed' } }), /INVALID_MODEL_BUDGET/);
  writeFileSync(f.configFile, JSON.stringify({ ...f.value, model_budget: { request_limit: 3, output: { mode: 'provider_managed' } } }), { mode: 0o600 });
  assert.notEqual(f.config.bindingHash, first.bindingHash);
  assert.throws(() => checkOutputPayload('openai-responses', {}, first.model_budget.output), /MODEL_OUTPUT_BUDGET_UNSUPPORTED/);
});

for (const kind of ['api-key-protocol', 'oauth-protocol-rejected', 'oauth-provider-managed'] as const) test(`actual SDK1.4 output-budget payload, no network: ${kind}`, async () => {
  const f = fixture(false, { provider: 'openai', id: 'gpt-6-sol' });
  const models = await ModelRuntime.create({ credentials: new AppCredentials(join(f.root, 'not-read.json'), 'openai'), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  const model = models.getPhysicalModel('openai', 'gpt-6-sol')!; assert(model);
  const apiKey = kind === 'api-key-protocol' ? 'sk-synthetic-budget-only' : 'synthetic-oauth-access-only';
  const output = kind === 'oauth-provider-managed' ? { mode: 'provider_managed' as const } : { mode: 'protocol_tokens' as const, max_tokens: 16384 };
  if (kind === 'oauth-protocol-rejected') assert.throws(() => checkBudgetSupport(model, { apiKey }, output), /MODEL_OUTPUT_BUDGET_UNSUPPORTED/);
  else checkBudgetSupport(model, { apiKey }, output);
  let payload: Record<string, unknown> | undefined; let network = 0;
  assert.equal(model.api, 'openai-responses');
  const result = await streamSimple(model as Model<'openai-responses'>, normalizeContext({ messages: [{ role: 'system', content: 'Synthetic offline payload test, not Mio.', timestamp: 0 }, { role: 'user', content: 'No model request.', timestamp: 0 }] }), {
    apiKey, maxTokens: 16384, reasoning: 'xhigh', maxRetries: 0, transport: 'sse',
    fetch: async () => { network++; throw new Error('TEST_NETWORK_FORBIDDEN'); },
    onPayload: v => { payload = v as Record<string, unknown>; checkOutputPayload(model.api, v, output); throw new Error('TEST_STOP_BEFORE_HTTP'); },
  }).result();
  assert(payload); assert.equal(network, 0); assert.equal(result.stopReason, 'error');
  if (kind === 'api-key-protocol') { assert.equal(payload.max_output_tokens, 16384); assert(result.errorMessage?.includes('TEST_STOP_BEFORE_HTTP')); }
  else { assert(!Object.hasOwn(payload, 'max_output_tokens')); assert.equal((payload.reasoning as { effort: string }).effort, 'xhigh');
    assert(result.errorMessage?.includes(kind === 'oauth-protocol-rejected' ? 'MODEL_OUTPUT_BUDGET_UNSUPPORTED' : 'TEST_STOP_BEFORE_HTTP')); }
});

test('actual SDK reads only selected shared credential; valid rotation works, missing/near-expired/expired cannot refresh or inherit ambient auth', async () => {
  const p = namedFixture(); const before = readFileSync(p.credentials); const oldEnv = process.env.OPENAI_API_KEY; const oldFetch = globalThis.fetch;
  let network = 0; globalThis.fetch = async () => { network++; throw new Error('TEST_NETWORK_FORBIDDEN'); };
  process.env.OPENAI_API_KEY = 'sk-synthetic-ambient-must-not-fallback';
  try {
    const credentials = new AppCredentials(p.credentials, 'openai');
    assert.deepEqual(await credentials.list(), [{ providerId: 'openai', type: 'api_key' }]);
    await assert.rejects(credentials.read('unrelated'), /UNCONFIGURED_APP_PROVIDER/);
    let callback = 0; await assert.rejects((credentials.modify as (...args: unknown[]) => Promise<never>)('openai', () => { callback++; }), /APP_CREDENTIAL_REFRESH_REQUIRES_OPERATOR/);
    assert.equal(callback, 0);
    const models = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
    const model = models.getPhysicalModel('openai', 'gpt-6-sol')!;
    const save = (expires: number, access = 'synthetic-readonly-access') => writeFileSync(p.credentials, JSON.stringify({ openai: { type: 'oauth', access, refresh: 'synthetic-refresh-must-not-use', expires } }), { mode: 0o600 });
    save(Date.now() + 3600000); assert.equal((await models.getAuth(model, { env: {} }))?.auth.apiKey, 'synthetic-readonly-access');
    save(Date.now() + 3600000, 'synthetic-rotated-access'); assert.equal((await models.getAuth(model, { env: {} }))?.auth.apiKey, 'synthetic-rotated-access');
    for (const expires of [Date.now() + 60000, Date.now() - 60000]) { save(expires); const bytes = readFileSync(p.credentials);
      await assert.rejects(models.getAuth(model, { env: {} })); assert.deepEqual(readFileSync(p.credentials), bytes); }
    writeFileSync(p.credentials, '{}', { mode: 0o600 }); await assert.rejects(models.getAuth(model, { env: {} }));
    unlinkSync(p.credentials); await assert.rejects(models.getAuth(model, { env: {} }));
    assert.equal(network, 0);
  } finally { globalThis.fetch = oldFetch; if (oldEnv === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldEnv;
    writeFileSync(p.credentials, before, { mode: 0o600 }); }
});

test('three unique model-request reservations survive restart; a fourth input cannot get a native receipt or reset the budget', async t => {
  const f = fixture(); f.init(); const models = await fakeModels(f.root, [ask(), ask('Second synthetic question'), ask('Third synthetic question')]);
  let r = await AppRuntime.open(f.config, { modelRuntime: models.runtime }); t.after(() => r.close());
  const first = await r.runOnce() as { event_id: string };
  respond(r, f, first.event_id); await r.runOnce(); respond(r, f, first.event_id); await r.runOnce();
  assert.equal(models.calls.length, 3); assert.equal(r.native.metadata().filter(v => v.kind === 'model_request_intent').length, 3);
  const original = r.native.manifest.native_id; await r.close(); r = await AppRuntime.open(f.config, { modelRuntime: models.runtime });
  assert.equal(r.native.manifest.native_id, original); assert.equal((status(f.config) as { model_budget: { request_intents: number } }).model_budget.request_intents, 3);
  const fourth = respond(r, f, first.event_id); await r.runOnce().catch(() => undefined);
  assert.equal(models.calls.length, 3); assert.equal(r.native.entries().filter(v => v.type === 'custom_message' && v.customType === responseType).length, 2);
  assert.equal(r.core.getResponse(f.user(), fourth, f.registry()).source_delivery?.receipt, null);
  await r.close(); const bytes = readFileSync(join(f.value.data_dir, 'manifest.json'));
  writeFileSync(f.configFile, JSON.stringify({ ...f.value, model_budget: { request_limit: 4, output: { mode: 'protocol_tokens', max_tokens: 16384 } } }), { mode: 0o600 });
  await assert.rejects(AppRuntime.open(f.config, { modelRuntime: models.runtime }), /BINDING_MISMATCH/);
  assert.deepEqual(readFileSync(join(f.value.data_dir, 'manifest.json')), bytes);
});

test('unknown original model run keeps its reservation after restart and never invokes a replacement request', async t => {
  const f = fixture(); f.init(); const models = await fakeModels(f.root, [{ stop: 'error', text: 'Incomplete synthetic output.' }]);
  let r = await AppRuntime.open(f.config, { modelRuntime: models.runtime }); t.after(() => r.close());
  assert.equal((await r.runOnce() as { state: string }).state, 'model_outcome_unresolved'); await r.close();
  r = await AppRuntime.open(f.config, { modelRuntime: models.runtime });
  assert.equal((await r.runOnce() as { state: string }).state, 'original_model_run_unresolved');
  assert.equal(models.calls.length, 1); assert.equal(r.native.metadata().filter(v => v.kind === 'model_request_intent').length, 1);
});

test('the real synchronous input gate rejects persona drift without any new native input or model reservation', async t => {
  const p = namedFixture(); p.f.init(); const r = await AppRuntime.open(p.f.config); t.after(() => r.close());
  const event = manualEvent(r); const id = respond(r, p.f, event.id);
  const before = sha(readFileSync(r.native.manifest.session_file));
  writeFileSync(p.persona, p.text + ' changed before final gate', { mode: 0o600 });
  await r.runOnce().catch(() => undefined);
  assert.equal(r.native.entries().filter(v => v.type === 'custom_message' && v.customType === responseType).length, 0);
  assert.equal(r.native.metadata().filter(v => v.kind === 'model_request_intent').length, 0);
  assert.equal(r.core.getResponse(p.f.user(), id, p.f.registry()).source_delivery?.receipt, null);
  assert.equal(sha(readFileSync(r.native.manifest.session_file)), before);
});

test('SDK1.0.2 manifest is rejected without changing original manifest, native file, or ledger', () => {
  const f = fixture(false); f.init(); const manifest = join(f.value.data_dir, 'manifest.json');
  const value = JSON.parse(readFileSync(manifest, 'utf8')) as { sdk: string; session_file: string }; value.sdk = '1.0.2';
  writeFileSync(manifest, JSON.stringify(value), { mode: 0o600 });
  const files = [manifest, value.session_file, join(f.value.data_dir, 'ledger.sqlite')]; const before = files.map(p => sha(readFileSync(p)));
  assert.throws(() => new NativeSession(f.config), /BINDING_MISMATCH/); assert.deepEqual(files.map(p => sha(readFileSync(p))), before);
});
