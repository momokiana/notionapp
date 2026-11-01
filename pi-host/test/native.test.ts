import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync, renameSync, symlinkSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import { openDatabase } from 'notification-server/database';
import { AppRuntime } from '../src/runtime.js';
import { AppCredentials } from '../src/credentials.js';
import { initialize, NativeSession, responseType, status } from '../src/native.js';
import { fixture, fakeModels, manualEvent, respond, child, exited } from './helpers.js';

test('init is durable across a real new process; readonly status does not mutate native bytes', async () => {
  const f = fixture(false); assert.equal(f.init().model_requested, false);
  const first = new NativeSession(f.config); const id = first.manager.getSessionId(); const path = first.manager.getSessionFile()!;
  assert.equal(first.manager.getEntries().length, 4); const before = readFileSync(path); first.close();
  const result = await exited(child('status', f)); assert.equal(result.code, 0, result.error);
  assert.equal(JSON.parse(result.out).state, 'initialized'); assert.deepEqual(readFileSync(path), before);
  const second = new NativeSession(f.config); assert.equal(second.manager.getSessionId(), id); assert.equal(second.manager.getSessionFile(), path); second.close();
  assert.throws(() => initialize(f.config), /APP_ALREADY_INITIALIZED/);
});

test('default host has no model credentials/resources and requests no model', async t => {
  const f = fixture(false, { provider: 'openai', id: 'gpt-4o' }); f.init();
  const r = await AppRuntime.open(f.config); t.after(() => r.close());
  assert.equal((await r.runOnce() as { state: string }).state, 'initial_model_disabled');
  assert.equal(r.native.entries().length, 4); assert.deepEqual(r.session.getActiveToolNames(), ['app_question']);
  assert.deepEqual(r.session.getCallableToolNames(), []);
});

test('real synchronous native gate fsyncs exact original message, refreshes public context, and deduplicates after restart', async t => {
  const f = fixture(false); f.init(); const model = await fakeModels(f.root); const r = await AppRuntime.open(f.config, { modelRuntime: model.runtime });
  t.after(() => r.close());
  const event = manualEvent(r); const responseId = respond(r, f, event.id, '不可变原文 🧪', 'reply');
  const a = r.currentAuthority(); const command = r.delivery.claim(a.principal, randomUUID(), a.registry).command!;
  const altered = structuredClone(command); altered.response.text = 'changed before first input';
  assert.throws(() => r.host.compareAndEnqueue(altered, Date.now()), /NATIVE_COMMAND_CONFLICT/);
  const receipt = r.delivery.submitAtGate(r.currentAuthority, command.id, r.host);
  const entry = r.native.manager.getEntry(receipt.message_id); assert(entry?.type === 'custom_message' && typeof entry.content === 'string');
  assert.equal(JSON.parse(entry.content).response.text, '不可变原文 🧪'); assert.equal(JSON.parse(entry.content).response_id, responseId);
  assert(convertToLlm(r.session.messages).some(m => m.role === 'user' && JSON.stringify(m.content).includes('不可变原文')));
  assert.deepEqual(r.delivery.submitAtGate(r.currentAuthority, command.id, r.host), receipt);
  const changed = structuredClone(command); changed.response.text = 'changed'; assert.throws(() => r.host.compareAndEnqueue(changed, Date.now()), /NATIVE_COMMAND_CONFLICT/);
  const nativePath = r.native.manager.getSessionFile()!; const bytes = readFileSync(nativePath); await r.close();
  const restarted = await AppRuntime.open(f.config, { modelRuntime: model.runtime }); t.after(() => restarted.close());
  assert.deepEqual(restarted.host.getReceipt(command.id), receipt); assert.deepEqual(readFileSync(nativePath), bytes);
  assert.equal(restarted.native.entries().filter(e => e.type === 'custom_message' && e.customType === responseType).length, 1);
  assert.equal(model.calls.length, 0);
});

test('restore same literal model still changes native revision; stale command is reserved unknown but never appended', async t => {
  const f = fixture(false); f.init(); const model = await fakeModels(f.root); const r = await AppRuntime.open(f.config, { modelRuntime: model.runtime }); t.after(() => r.close());
  const event = manualEvent(r); respond(r, f, event.id); const a = r.currentAuthority(); const c = r.delivery.claim(a.principal, randomUUID(), a.registry).command!;
  r.native.manager.appendModelChange('other-fixture', 'other-model'); r.native.manager.appendModelChange(f.config.model.provider, f.config.model.id); r.native.sync();
  assert.notEqual(r.host.target().state_revision, event.target_revision);
  assert.throws(() => r.delivery.submitAtGate(r.currentAuthority, c.id, r.host), /NATIVE_TARGET_CHANGED/);
  assert.throws(() => r.delivery.submitAtGate(r.currentAuthority, c.id, r.host), /Only query the original native command/);
  assert.equal(r.host.getReceipt(c.id), null); assert.equal(r.native.entries().filter(e => e.type === 'custom_message').length, 0);
});

test('wrong native session, expired input, busy session and capability loss cannot produce native input', async t => {
  for (const mode of ['session', 'expiry', 'busy', 'capability'] as const) {
    const f = fixture(false); f.init(); const model = await fakeModels(f.root); const r = await AppRuntime.open(f.config, { modelRuntime: model.runtime }); t.after(() => r.close());
    const target = r.host.target(); if (mode === 'session') target.session_ref = 'wrong-native-fixture';
    const e = manualEvent(r, '隔离目标验证', target); respond(r, f, e.id); const a = r.currentAuthority(); const c = r.delivery.claim(a.principal, randomUUID(), a.registry).command!;
    if (mode === 'session') assert.throws(() => r.host.compareAndEnqueue(c, Date.now()), /NATIVE_TARGET_CHANGED/);
    if (mode === 'expiry') assert.throws(() => r.host.compareAndEnqueue(c, Date.now() + 7200000), /NATIVE_TARGET_CHANGED/);
    if (mode === 'busy') { r.session.agent.followUp({ role: 'user', content: 'isolated queue probe', timestamp: Date.now() }); assert.throws(() => r.host.compareAndEnqueue(c, Date.now()), /NATIVE_SESSION_BUSY/); r.session.agent.clearAllQueues(); }
    if (mode === 'capability') { f.principals[1]!.capabilities = ['publish', 'reply']; f.saveGrants(); assert.throws(() => r.delivery.submitAtGate(r.currentAuthority, c.id, r.host), /SOURCE_AUTHORIZATION_CHANGED/); }
    assert.equal(r.native.entries().filter(e => e.type === 'custom_message').length, 0);
  }
});

test('strict native pre-open rejects partial, old version, wrong header, symlink and in-memory branch without SDK repairs', async t => {
  for (const mode of ['partial', 'version', 'header', 'symlink', 'branch'] as const) {
    const f = fixture(false); f.init(); const n = new NativeSession(f.config); const path = n.manager.getSessionFile()!; const original = readFileSync(path, 'utf8');
    if (mode === 'branch') {
      const model = await fakeModels(f.root); n.close(); const r = await AppRuntime.open(f.config, { modelRuntime: model.runtime }); t.after(() => r.close());
      r.native.manager.appendModelChange(f.config.model.provider, f.config.model.id); r.native.manager.branch(r.native.manager.getEntries()[3]!.id);
      assert.throws(() => r.host.target(), /NATIVE_STATE_CHANGED/); continue;
    }
    n.close();
    if (mode === 'partial') appendFileSync(path, '{"partial":');
    if (mode === 'version') writeFileSync(path, original.replace('"version":3', '"version":2'));
    if (mode === 'header') { const lines = original.trimEnd().split('\n'); const header = JSON.parse(lines[0]!); header.id = randomUUID(); lines[0] = JSON.stringify(header); writeFileSync(path, lines.join('\n') + '\n'); }
    if (mode === 'symlink') { renameSync(path, path + '.original'); symlinkSync(path + '.original', path); }
    const before = readFileSync(path);
    assert.throws(() => new NativeSession(f.config)); assert.deepEqual(readFileSync(path), before);
  }
});

test('ready native binding refuses legacy/replaced public ledger before any automatic schema migration', () => {
  const f = fixture(false); f.init(); const path = join(f.value.data_dir, 'ledger.sqlite');
  let db = openDatabase(path);
  db.exec('DROP TABLE notifications; DROP TABLE notice_batches; DROP TABLE push_devices; PRAGMA user_version=2'); db.close();
  assert.throws(() => new NativeSession(f.config), /ORIGINAL_LEDGER_REQUIRED/);
  db = openDatabase(path);
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('notifications','notice_batches','push_devices')").get() as { n: number }).n, 0);
  db.close();
});

test('two real processes cannot own the same App directory; explicit release permits the same original session', async t => {
  const f = fixture(false); f.init(); const c = child('hold-owner', f); t.after(() => { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('owned child readiness timeout')), 120000);
    c.stdout.on('data', value => { if (String(value).includes('owner-ready')) { clearTimeout(timeout); resolve(); } });
    c.once('exit', () => { clearTimeout(timeout); reject(new Error('owner child exited early')); });
  });
  assert.throws(() => new NativeSession(f.config));
  const done = exited(c); c.stdin.end('release\n'); assert.equal((await done).code, 0);
  const n = new NativeSession(f.config); assert.equal(n.manager.getEntries().length, 4); n.close();
});

test('explicit App credential file supports owned literal auth but removal never becomes ambient fallback', async t => {
  const f = fixture(true, { provider: 'openai', id: 'gpt-4o' }); f.init();
  const path = join(f.value.data_dir, 'agent', 'auth.json');
  writeFileSync(path, JSON.stringify({ openai: { type: 'api_key', key: 'sk-literal-fixture-file-key-not-a-real-credential' } }), { mode: 0o600 });
  const credentials = new AppCredentials(path, 'openai'); assert.equal((await credentials.read('openai')).type, 'api_key');
  const r = await AppRuntime.open(f.config); t.after(() => r.close()); assert.equal(r.native.entries().length, 4);
  unlinkSync(path); await assert.rejects(credentials.read('openai')); await assert.rejects(credentials.read('other-provider'), /UNCONFIGURED_APP_PROVIDER/);
  writeFileSync(path, JSON.stringify({ openai: { type: 'api_key', key: '$OPENAI_API_KEY' } }), { mode: 0o600 });
  await assert.rejects(credentials.read('openai'), /EXECUTABLE_OR_AMBIENT_PROFILE_FORBIDDEN/);
  await assert.rejects(credentials.modify(), /APP_CREDENTIAL_REFRESH_REQUIRES_OPERATOR/);
});

test('no ambient provider key fallback and executable private credential/model profiles are rejected', async t => {
  const f = fixture(true, { provider: 'openai', id: 'gpt-4o' }); f.init();
  const result = await exited(child('ambient-auth', f, { OPENAI_API_KEY: 'synthetic-fixture-env-key-not-a-real-credential' }));
  assert.equal(result.code, 0, result.error); assert(result.out.includes('ambient-auth-rejected'));
  const g = fixture(false); g.init(); const marker = join(g.root, 'must-not-execute');
  writeFileSync(join(g.value.data_dir, 'agent', 'models.json'), JSON.stringify({ providers: { 'isolated-fixture': { apiKey: `!touch ${marker}` } } }), { mode: 0o600 });
  const model = await fakeModels(g.root);
  await assert.rejects(AppRuntime.open(g.config, { modelRuntime: model.runtime }), /EXECUTABLE_OR_AMBIENT_PROFILE_FORBIDDEN/);
  const { existsSync } = await import('node:fs'); assert.equal(existsSync(marker), false);
  chmodSync(g.configFile, 0o644); assert.throws(() => g.config, /PRIVATE_FILE_REQUIRED/);
  t.after(() => { chmodSync(g.configFile, 0o600); });
});
