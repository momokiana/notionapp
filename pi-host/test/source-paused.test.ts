import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createApp } from 'notification-server/app';
import { DeviceStore } from 'notification-server/device-store';
import { AppRuntime } from '../src/runtime.js';
import { NativeSession, responseType } from '../src/native.js';
import { fixture, fakeModels, ask, manualEvent, respond, exited, child } from './helpers.js';
import { pausedPhysicalModel } from './fixtures/source-paused-model.js';

function original(config: ReturnType<typeof fixture>['config']) {
  const manifestPath = join(config.data_dir, 'manifest.json'); const manifest = readFileSync(manifestPath);
  const nativePath = JSON.parse(manifest.toString()).session_file as string;
  return { manifestPath, manifest, nativePath, native: readFileSync(nativePath) };
}

test('explicit source pause validates original resources but skips corrupt unused profile/auth and every model/Agent path', async () => {
  const f = fixture(true); f.init(); const config = f.config; const saved = original(config);
  writeFileSync(join(config.data_dir, 'agent/auth.json'), 'not-json-selected-model-credential', { mode: 0o600 });
  writeFileSync(join(config.data_dir, 'agent/models.json'), JSON.stringify({ synthetic: '$NEVER_EXECUTE' }), { mode: 0o600 });
  const create = ModelRuntime.create; const fetch = globalThis.fetch; let modelCreates = 0; let network = 0; let r: AppRuntime | undefined;
  try {
    ModelRuntime.create = async () => { modelCreates++; throw new Error('A paused source must not create ModelRuntime'); };
    globalThis.fetch = async () => { network++; throw new Error('A paused source must not request a model'); };
    let now = Date.parse('2026-10-31T00:00:00Z'); r = await AppRuntime.open(config, { sourcePaused: true, now: () => now });
    assert.equal(r.session, undefined); assert.equal(r.host, undefined); assert.equal(r.sourcePaused, true);
    const first = r.sourceRuntime.observe(); assert.equal(first.state, 'paused'); assert.equal(first.model_permission_configured, true);
    now += 30000; for (let n = 0; n < 3; n++) assert.deepEqual(await r.runOnce(), { state: 'source_paused' });
    assert.deepEqual(r.sourceRuntime.observe(), first, 'Polling cannot freshen a mode observation into a new model qualification');
    assert.deepEqual(readFileSync(saved.nativePath), saved.native); assert.deepEqual(readFileSync(saved.manifestPath), saved.manifest);
    assert.equal((r.native.database.prepare('SELECT count(*) AS n FROM commands').get() as { n: number }).n, 0);
    assert.equal(modelCreates, 0); assert.equal(network, 0);
  } finally { ModelRuntime.create = create; globalThis.fetch = fetch; await r?.close(); }
  const again = new NativeSession(config); again.close();
  await assert.rejects(AppRuntime.open(config), SyntaxError, 'Ordinary serve still reads and rejects the malformed first auth profile; no implicit pause');
});

test('paused HTTP saves one original waiting response, exposes scoped observation, then original source accepts it exactly once without model calls', async () => {
  const f = fixture(false); f.init(); const models = await fakeModels(f.root);
  const live = await AppRuntime.open(f.config, { modelRuntime: models.runtime });
  const target = live.host.target(); const created = live.core.create(f.source(), { request_id: randomUUID(), title: 'Paused source', body: 'A synthetic question',
    session_ref: target.session_ref, target_revision: target.state_revision, expires_at: '2099-01-01T00:00:00Z', interaction: { id: 'pause-question', actions: [{ id: 'yes', type: 'button', label: 'Save and wait' }] } });
  const saved = original(f.config); await live.close();
  const paused = await AppRuntime.open(f.config, { sourcePaused: true });
  const app = createApp(paused.native.database, false, { registry: paused.registry, sourceRuntime: paused.sourceRuntime });
  const id = randomUUID(); const headers = { authorization: `Bearer ${f.userToken}` };
  const body = { response_id: id, event_version: 1, interaction_id: 'pause-question', interaction_version: 1, action_id: 'yes', text: '' };
  try {
    for (let n = 0; n < 2; n++) assert.equal((await app.inject({ method: 'POST', url: `/v1/events/${created.event_id}/responses`, headers, payload: body })).statusCode, 200);
    const response = await app.inject({ method: 'GET', url: `/v1/responses/${id}`, headers }); assert.equal(response.statusCode, 200); assert.equal(response.json().eligibility_state, 'waiting_source');
    assert.equal((await app.inject({ method: 'GET', url: `/v1/source-runtime/${f.value.source.source_id}?event_id=${created.event_id}&event_version=2`, headers })).json().state, 'paused');
    for (let n = 0; n < 3; n++) await paused.runOnce();
    assert.equal((paused.native.database.prepare('SELECT count(*) AS n FROM responses').get() as { n: number }).n, 1);
    assert.equal((paused.native.database.prepare('SELECT count(*) AS n FROM commands').get() as { n: number }).n, 0);
    assert.deepEqual(readFileSync(saved.nativePath), saved.native); assert.deepEqual(readFileSync(saved.manifestPath), saved.manifest);
  } finally { await app.close(); await paused.close(); }
  const resumed = await AppRuntime.open(f.config, { modelRuntime: models.runtime });
  try {
    const result = await resumed.runOnce() as { state: string }; assert.equal(result.state, 'source_received_model_disabled');
    await resumed.runOnce(); assert.equal(resumed.native.entries().filter(e => e.type === 'custom_message' && e.customType === responseType).length, 1);
    assert.equal((resumed.native.database.prepare('SELECT count(*) AS n FROM commands').get() as { n: number }).n, 1);
    assert.equal(resumed.core.getResponse(f.user(), id, f.registry()).id, id); assert.equal(models.calls.length, 0);
    assert.equal(resumed.sourceRuntime.observe().reason_code, 'MODEL_PERMISSION_DISABLED');
  } finally { await resumed.close(); }
});

test('named original binding stays usable in paused mode across missing/near-expired/expired and operator-rotated selected model credentials', async () => {
  const f = fixture(false, { provider: 'openai', id: 'gpt-4o' });
  const persona = join(f.root, 'persona.txt'); const settings = join(f.root, 'settings.json'); const credentials = join(f.root, 'selected-model-auth.json');
  const text = 'Synthetic named source only, not Mio or any work conversation.';
  writeFileSync(persona, text, { mode: 0o600 });
  writeFileSync(settings, JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-4o', defaultThinkingLevel: 'off' }), { mode: 0o600 });
  writeFileSync(credentials, JSON.stringify({ openai: { type: 'api_key', key: 'sk-synthetic-initial-not-real' } }), { mode: 0o600 });
  writeFileSync(f.configFile, JSON.stringify({ ...f.value, identity_reference: { name: 'Synthetic named source', persona_file: persona,
    persona_sha256: createHash('sha256').update(text).digest('hex'), settings_file: settings, credentials_file: credentials } }), { mode: 0o600 });
  f.init(); const before = original(f.config); const fetch = globalThis.fetch; let network = 0;
  try {
    globalThis.fetch = async () => { network++; throw new Error('Selected model authorization must not trigger refresh or a request'); };
    for (const kind of ['missing', 'near-expired', 'expired', 'rotated'] as const) {
      if (kind === 'missing') unlinkSync(credentials);
      else writeFileSync(credentials, JSON.stringify({ openai: { type: 'oauth', access: `synthetic-${kind}-access`, refresh: 'synthetic-refresh-never-use',
        expires: Date.now() + (kind === 'expired' ? -60000 : kind === 'near-expired' ? 60000 : 3600000) } }), { mode: 0o600 });
      const authBefore = existsSync(credentials) ? readFileSync(credentials) : null;
      const config = f.config; const r = await AppRuntime.open(config, { sourcePaused: true }); const app = createApp(r.native.database, false, { registry: r.registry, sourceRuntime: r.sourceRuntime });
      try {
        assert.equal(r.native.manifest.native_id, JSON.parse(before.manifest.toString()).native_id);
        assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
        const events = await app.inject({ method: 'GET', url: '/v1/events', headers: { authorization: `Bearer ${f.userToken}` } }); assert.equal(events.statusCode, 200);
        await r.runOnce(); assert.equal(r.sourceRuntime.observe().state, 'paused'); assert.deepEqual(readFileSync(before.nativePath), before.native);
      } finally { await app.close(); await r.close(); }
      if (authBefore) assert.deepEqual(readFileSync(credentials), authBefore); else assert.equal(existsSync(credentials), false);
      if (kind !== 'rotated') {
        let admitted: AppRuntime | undefined;
        try { await assert.rejects(async () => { admitted = await AppRuntime.open({ ...config, allow_model_calls: true }); }); }
        finally { await admitted?.close(); }
      }
    }
    const live = await AppRuntime.open(f.config);
    try { assert.equal((await live.runOnce() as { state: string }).state, 'initial_model_disabled'); }
    finally { await live.close(); }
    assert.equal(network, 0); assert.deepEqual(readFileSync(before.nativePath), before.native); assert.deepEqual(readFileSync(before.manifestPath), before.manifest);
  } finally { globalThis.fetch = fetch; }
});

test('managed credential rotation and revocation remain authoritative for paused HTTP, without deleting the saved original response', async () => {
  const f = fixture(false); f.init(); const models = await fakeModels(f.root); const live = await AppRuntime.open(f.config, { modelRuntime: models.runtime });
  const target = live.host.target(); const saved = original(f.config); await live.close();
  const path = join(f.root, 'paused-device-authority.sqlite'); const storeId = DeviceStore.initialize(path).store_id;
  writeFileSync(f.configFile, JSON.stringify({ ...f.value, device_auth: { path, store_id: storeId } }), { mode: 0o600 });
  const r = await AppRuntime.open(f.config, { sourcePaused: true }); assert(r.deviceAuthority);
  const app = createApp(r.native.database, false, { registry: r.registry, deviceAuthority: r.deviceAuthority, sourceRuntime: r.sourceRuntime });
  const invitation = randomUUID(); const secret = randomBytes(32).toString('hex'); const token = randomBytes(32).toString('hex'); const next = randomBytes(32).toString('hex');
  r.deviceAuthority.store.createInvitation('operator', { request_id: invitation, invitation_id: invitation, secret, owner_id: f.value.source.owner_id,
    label: 'Synthetic paused phone', manage_devices: false, expires_at: Date.now() + 600000 });
  const bearer = (value: string) => ({ authorization: `Bearer ${value}` });
  try {
    const paired = await app.inject({ method: 'POST', url: '/v1/pairing/claim', payload: { store_id: storeId, claim_id: randomUUID(), invitation_id: invitation, secret, proposed_token: token } }); assert.equal(paired.statusCode, 200);
    const created = await app.inject({ method: 'POST', url: '/v1/events', headers: bearer(f.sourceToken), payload: { request_id: randomUUID(), title: 'Paused managed device', body: 'Synthetic',
      session_ref: target.session_ref, target_revision: target.state_revision, expires_at: '2099-01-01T00:00:00Z', interaction: { id: 'managed_question', actions: [{ id: 'yes', type: 'button', label: 'Save' }] } } });
    assert.equal(created.statusCode, 200); const event = created.json().event_id as string; const responseId = randomUUID();
    const response = { response_id: responseId, event_version: 1, interaction_id: 'managed_question', interaction_version: 1, action_id: 'yes', text: '' };
    assert.equal((await app.inject({ method: 'POST', url: `/v1/events/${event}/responses`, headers: bearer(token), payload: response })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/device/rotate', headers: bearer(token), payload: { request_id: randomUUID(), replacement_token: next } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/events/${event}/responses`, headers: bearer(token), payload: response })).statusCode, 401, 'A cached original success cannot reauthorize a rotated credential');
    const original = await app.inject({ method: 'GET', url: `/v1/responses/${responseId}`, headers: bearer(next) }); assert.equal(original.statusCode, 200); assert.equal(original.json().eligibility_state, 'waiting_source');
    const revoke = { request_id: randomUUID(), device_id: paired.json().device_id as string };
    assert.equal((await app.inject({ method: 'POST', url: '/v1/device/revoke', headers: bearer(next), payload: revoke })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: `/v1/events/${event}/read-state`, headers: bearer(next), payload: { event_version: 2 } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/source-runtime/${f.value.source.source_id}?event_id=${event}&event_version=2`, headers: bearer(next) })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/device/self-revocation-receipt', headers: bearer(next), payload: revoke })).statusCode, 200);
    assert.equal(r.core.getResponse(f.source(), responseId, r.registry()).id, responseId); await r.runOnce();
    assert.equal((r.native.database.prepare('SELECT count(*) AS n FROM commands').get() as { n: number }).n, 0);
    assert.deepEqual(readFileSync(saved.nativePath), saved.native); assert.deepEqual(readFileSync(saved.manifestPath), saved.manifest); assert.equal(models.calls.length, 0);
  } finally { await app.close(); await r.close(); }
});

test('paused admission cannot repair a missing ledger, bypass native owner/prefix/binding, or fall back from missing managed authority', async () => {
  const f = fixture(false); f.init(); const config = f.config; const saved = original(config);
  const owner = new NativeSession(config);
  try { await assert.rejects(AppRuntime.open(config, { sourcePaused: true }), /APP_DIRECTORY_ALREADY_OWNED/); } finally { owner.close(); }
  const ledger = join(config.data_dir, 'ledger.sqlite'); renameSync(ledger, ledger + '.retained-original');
  try { await assert.rejects(AppRuntime.open(config, { sourcePaused: true })); assert.equal(existsSync(ledger), false); }
  finally { renameSync(ledger + '.retained-original', ledger); }
  writeFileSync(saved.nativePath, '{"not":"a session header"}\n', { mode: 0o600 });
  try { await assert.rejects(AppRuntime.open(config, { sourcePaused: true })); assert.equal(readFileSync(saved.nativePath, 'utf8'), '{"not":"a session header"}\n'); }
  finally { writeFileSync(saved.nativePath, saved.native, { mode: 0o600 }); }
  const prompt = readFileSync(config.initial_prompt_file); writeFileSync(config.initial_prompt_file, 'Different synthetic binding', { mode: 0o600 });
  try { await assert.rejects(AppRuntime.open(f.config, { sourcePaused: true }), /BINDING_MISMATCH/); }
  finally { writeFileSync(config.initial_prompt_file, prompt, { mode: 0o600 }); }
  const missing = join(f.root, 'missing-managed-authority.sqlite');
  writeFileSync(f.configFile, JSON.stringify({ ...f.value, device_auth: { path: missing, store_id: randomUUID() } }), { mode: 0o600 });
  await assert.rejects(AppRuntime.open(f.config, { sourcePaused: true }), { code: 'ENOENT' }); assert.equal(existsSync(missing), false);
  assert.deepEqual(readFileSync(saved.nativePath), saved.native); assert.deepEqual(readFileSync(saved.manifestPath), saved.manifest);
  const again = new NativeSession(config); again.close();
});

test('exhausted original request allowance remains consumed across explicit pause; no new native input or model request is created', async () => {
  const f = fixture(); f.init(); const models = await fakeModels(f.root, [ask(), ask('Second'), ask('Third')]);
  const live = await AppRuntime.open(f.config, { modelRuntime: models.runtime });
  const first = await live.runOnce() as { event_id: string }; respond(live, f, first.event_id); await live.runOnce(); respond(live, f, first.event_id); await live.runOnce();
  const last = respond(live, f, first.event_id); const saved = original(f.config); const id = live.native.manifest.native_id;
  assert.equal(models.calls.length, 3); await live.close();
  const paused = await AppRuntime.open(f.config, { sourcePaused: true });
  try {
    assert.equal(paused.native.manifest.native_id, id); for (let n = 0; n < 3; n++) await paused.runOnce();
    assert.equal(paused.native.metadata().filter(v => v.kind === 'model_request_intent').length, 3); assert.equal(paused.config.model_budget.request_limit, 3);
    assert.equal(paused.core.getResponse(f.user(), last, f.registry()).eligibility_state, 'waiting_source');
    assert.equal(paused.native.entries().filter(e => e.type === 'custom_message' && e.customType === responseType).length, 2);
    assert.deepEqual(readFileSync(saved.nativePath), saved.native); assert.deepEqual(readFileSync(saved.manifestPath), saved.manifest); assert.equal(models.calls.length, 3);
  } finally { await paused.close(); }
});

test('real SIGKILL after SDK HTTP-attempt intent survives pause and normal restart with no request replay or allowance refund', async () => {
  const f = fixture(true, { provider: 'openai', id: 'gpt-6-sol' }); f.init();
  writeFileSync(join(f.config.data_dir, 'agent/auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'sk-synthetic-paused-no-network' } }), { mode: 0o600 });
  const childPath = fileURLToPath(new URL('./fixtures/source-paused-http-intent.ts', import.meta.url));
  const c = spawn(process.execPath, ['--import', 'tsx', childPath, f.configFile], { cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: f.root, NOTIONAPP_SOURCE_PAUSE_CRASH: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const killed = await exited(c); assert.equal(killed.signal, 'SIGKILL', killed.error); assert(killed.out.includes('fault:source-paused-http-intent'));
  const config = f.config; const saved = original(config); const paused = await AppRuntime.open(config, { sourcePaused: true });
  try {
    const metadata = paused.native.metadata(); assert.equal(metadata.filter(v => v.kind === 'model_request_intent').length, 1);
    assert.equal(metadata.filter(v => v.kind === 'model_http_attempt').length, 1); assert.equal(metadata.filter(v => v.kind === 'model_http_response').length, 0);
    for (let n = 0; n < 3; n++) await paused.runOnce(); assert.deepEqual(readFileSync(saved.nativePath), saved.native);
  } finally { await paused.close(); }
  const fetch = globalThis.fetch; let network = 0;
  try {
    globalThis.fetch = async () => { network++; throw new Error('Original unknown SDK request cannot be repeated'); };
    const models = await pausedPhysicalModel(config.data_dir); const r = await AppRuntime.open(config, { modelRuntime: models });
    try {
      for (let n = 0; n < 3; n++) assert.equal((await r.runOnce() as { state: string }).state, 'original_model_run_unresolved');
      assert.equal(r.native.metadata().filter(v => v.kind === 'model_request_intent').length, 1); assert.equal(r.native.metadata().filter(v => v.kind === 'model_http_attempt').length, 1);
      assert.equal(r.sourceRuntime.observe().reason_code, 'ORIGINAL_MODEL_RUN_UNRESOLVED'); assert.equal(network, 0);
      assert.deepEqual(readFileSync(saved.nativePath), saved.native); assert.deepEqual(readFileSync(saved.manifestPath), saved.manifest);
    } finally { await r.close(); }
  } finally { globalThis.fetch = fetch; }
});

test('paused mode does not promote a durable-but-unreported native input; normal restart queries the exact original receipt', async () => {
  const f = fixture(false); f.init(); const models = await fakeModels(f.root); const live = await AppRuntime.open(f.config, { modelRuntime: models.runtime });
  const event = manualEvent(live); const responseId = respond(live, f, event.id); await live.close();
  const killed = await exited(child('native-before-public-receipt', f)); assert.equal(killed.signal, 'SIGKILL', killed.error);
  const saved = original(f.config); const paused = await AppRuntime.open(f.config, { sourcePaused: true }); let commandId = ''; let entryId = '';
  try {
    const original = paused.core.getResponse(f.user(), responseId, f.registry()); assert.equal(original.source_delivery?.state, 'effect_unknown'); commandId = original.source_delivery!.command_id!;
    const inputs = paused.native.entries().filter(e => e.type === 'custom_message' && e.customType === responseType); assert.equal(inputs.length, 1); entryId = inputs[0]!.id;
    for (let n = 0; n < 3; n++) await paused.runOnce();
    assert.equal(paused.core.getResponse(f.user(), responseId, f.registry()).source_delivery?.state, 'effect_unknown');
    assert.deepEqual(readFileSync(saved.nativePath), saved.native); assert.equal(paused.native.metadata().filter(v => v.kind === 'model_request_intent').length, 0);
  } finally { await paused.close(); }
  const resumed = await AppRuntime.open(f.config, { modelRuntime: models.runtime });
  try {
    await resumed.runOnce(); await resumed.runOnce(); const found = resumed.core.getResponse(f.user(), responseId, f.registry()).source_delivery!;
    assert.equal(found.state, 'source_received'); assert.equal(found.command_id, commandId); assert.equal((found.receipt as { message_id: string }).message_id, entryId);
    assert.equal(resumed.native.entries().filter(e => e.type === 'custom_message' && e.customType === responseType).length, 1); assert.equal(models.calls.length, 0);
  } finally { await resumed.close(); }
});

for (const mode of ['report-before-db', 'report-after-db-before-ack'] as const) test(`source pause preserves original settled report across actual ${mode} SIGKILL, without replay until normal restart`, async () => {
  const f = fixture(); f.init(); const firstModels = await fakeModels(f.root, [ask()]); const live = await AppRuntime.open(f.config, { modelRuntime: firstModels.runtime });
  const event = await live.runOnce() as { event_id: string }; const responseId = respond(live, f, event.event_id); await live.close();
  const killed = await exited(child(mode, f)); assert.equal(killed.signal, 'SIGKILL', killed.error);
  const saved = original(f.config); const paused = await AppRuntime.open(f.config, { sourcePaused: true });
  const snapshot = () => ['events', 'responses', 'commands', 'operations', 'history', 'outbox', 'read_states'].map(table => paused.native.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  try {
    const before = snapshot(); const metadata = paused.native.metadata();
    assert.equal(metadata.filter(v => v.kind === 'model_request_intent').length, 2);
    assert.equal(metadata.filter(v => v.kind === 'report_intent').length, 2); assert.equal(metadata.filter(v => v.kind === 'report_saved').length, 1);
    assert.equal(paused.core.getResponse(f.user(), responseId, f.registry()).source_delivery?.state, 'source_received', 'Pause cannot erase the existing immutable receipt');
    for (let n = 0; n < 3; n++) await paused.runOnce();
    assert.deepEqual(snapshot(), before); assert.deepEqual(readFileSync(saved.nativePath), saved.native); assert.deepEqual(readFileSync(saved.manifestPath), saved.manifest);
  } finally { await paused.close(); }
  const models = await fakeModels(f.root); const r = await AppRuntime.open(f.config, { modelRuntime: models.runtime });
  try {
    assert.equal((await r.runOnce() as { state: string }).state, 'report_saved'); await r.runOnce();
    assert.equal(models.calls.length, 0); assert.equal(r.native.metadata().filter(v => v.kind === 'model_request_intent').length, 2);
    assert.equal(r.native.metadata().filter(v => v.kind === 'report_intent').length, 2); assert.equal(r.native.metadata().filter(v => v.kind === 'report_saved').length, 2);
    assert.equal(r.core.listHistory(f.user(), event.event_id, { after: 0, limit: 100 }).items.filter(v => v.kind === 'source_result_reported').length, 1);
    assert.equal(r.native.entries().filter(e => e.type === 'custom_message' && e.customType === responseType).length, 1);
  } finally { await r.close(); }
});
