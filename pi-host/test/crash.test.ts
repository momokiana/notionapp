import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from 'notification-server/database';
import { CoreStore } from 'notification-server/core';
import { NativeSession, initialize, status, responseType, controlType } from '../src/native.js';
import { AppRuntime } from '../src/runtime.js';
import { fixture, fakeModels, ask, manualEvent, respond, child, exited } from './helpers.js';

for (const mode of ['init-only-pending', 'init-partial-native', 'init-native-ready'] as const) test(`real SIGKILL ${mode}: never invent a replacement native ID or promise premature ready`, async () => {
  const f = fixture(false); const result = await exited(child(mode, f)); assert.equal(result.signal, 'SIGKILL', result.error);
  const pending = JSON.parse(readFileSync(join(f.value.data_dir, 'initializing.json'), 'utf8'));
  assert.equal(status(f.config).state, 'initialization_incomplete'); assert.equal(existsSync(join(f.value.data_dir, 'manifest.json')), false);
  if (mode === 'init-native-ready') {
    const before = readFileSync(pending.session_file); initialize(f.config);
    const n = new NativeSession(f.config); assert.equal(n.manager.getSessionId(), pending.native_id); assert.equal(n.manager.getSessionFile(), pending.session_file);
    assert.equal(n.manager.getEntries().length, 4); assert.deepEqual(readFileSync(pending.session_file), before); n.close();
  } else {
    const before = existsSync(pending.session_file) ? readFileSync(pending.session_file) : null;
    assert.throws(() => initialize(f.config));
    assert.equal(JSON.parse(readFileSync(join(f.value.data_dir, 'initializing.json'), 'utf8')).native_id, pending.native_id);
    assert.equal(existsSync(pending.session_file), before !== null); if (before) assert.deepEqual(readFileSync(pending.session_file), before);
  }
});

test('first run_started survives SIGKILL before any control/normal model message; restart only queries and never requests model', async t => {
  const f = fixture(); f.init(); const result = await exited(child('run-before-control', f)); assert.equal(result.signal, 'SIGKILL', result.error);
  const model = await fakeModels(f.root, [ask()]); const r = await AppRuntime.open(f.config, { modelRuntime: model.runtime }); t.after(() => r.close());
  const start = r.native.metadata().find(v => v.kind === 'run_started')!; assert(start); assert.equal(start.command_id, null);
  const bytes = readFileSync(r.native.manager.getSessionFile()!);
  assert.equal((await r.runOnce() as { state: string }).state, 'original_model_run_unresolved');
  assert.equal(model.calls.length, 0); assert.equal(r.native.entries().filter(e => e.type === 'custom_message' && e.customType === controlType).length, 0);
  assert.deepEqual(readFileSync(r.native.manager.getSessionFile()!), bytes); assert.equal(status(f.config).runs_without_terminal_record, 1);
});

test('real SDK native append + fsync then SIGKILL before public receipt: original native ID is queried, not enqueued again', async t => {
  const f = fixture(false); f.init(); const model = await fakeModels(f.root); let r = await AppRuntime.open(f.config, { modelRuntime: model.runtime });
  const event = manualEvent(r); const responseId = respond(r, f, event.id, '重启精确原文', 'reply'); await r.close();
  const result = await exited(child('native-before-public-receipt', f)); assert.equal(result.signal, 'SIGKILL', result.error);
  r = await AppRuntime.open(f.config, { modelRuntime: model.runtime }); t.after(() => r.close());
  const a = r.currentAuthority(); const before = r.core.getResponse(f.user(), responseId, f.registry());
  assert.equal(before.source_delivery?.state, 'effect_unknown');
  const commandId = before.source_delivery!.command_id!; const nativeReceipt = r.host.getReceipt(commandId)!; assert(nativeReceipt);
  const entriesBefore = r.native.entries().filter(e => e.type === 'custom_message' && e.customType === responseType).length;
  await r.runOnce(); await r.runOnce();
  const after = r.core.getResponse(f.user(), responseId, f.registry()); assert.equal(after.source_delivery?.state, 'source_received');
  assert.deepEqual(after.source_delivery?.receipt, nativeReceipt); assert.equal(after.source_delivery?.command_id, commandId);
  assert.equal(r.native.entries().filter(e => e.type === 'custom_message' && e.customType === responseType).length, entriesBefore);
  assert.equal(r.delivery.get(a.principal, commandId).response.text, '重启精确原文'); assert.equal(model.calls.length, 0);
});

test('bootstrap event commit then lost ACK reuses original create ID with zero model requests and one event', async t => {
  const f = fixture(); f.init(); const result = await exited(child('bootstrap-ack-loss', f)); assert.equal(result.signal, 'SIGKILL', result.error);
  const model = await fakeModels(f.root); const r = await AppRuntime.open(f.config, { modelRuntime: model.runtime }); t.after(() => r.close());
  assert.equal(r.core.listEvents(f.user(), { after: 0, limit: 100 }, f.registry()).items.length, 1);
  assert.equal((await r.runOnce() as { state: string }).state, 'report_saved'); await r.runOnce();
  assert.equal(model.calls.length, 0); assert.equal(r.core.listEvents(f.user(), { after: 0, limit: 100 }, f.registry()).items.length, 1);
  assert.equal(r.native.metadata().filter(v => v.kind === 'report_intent').length, 1);
});

for (const mode of ['report-before-db', 'report-after-db-before-ack'] as const) test(`${mode} SIGKILL + user closes: reconcile exact original report before any known-rejected late fact`, async t => {
  const f = fixture(); f.init(); const firstModel = await fakeModels(f.root, [ask()]); let r = await AppRuntime.open(f.config, { modelRuntime: firstModel.runtime });
  const first = await r.runOnce() as { event_id: string }; respond(r, f, first.event_id); await r.close();
  const result = await exited(child(mode, f)); assert.equal(result.signal, 'SIGKILL', result.error);
  const db = openDatabase(join(f.value.data_dir, 'ledger.sqlite')); const core = new CoreStore(db);
  const before = core.getEvent(f.user(), first.event_id, f.registry());
  core.disposition(f.user(), before.id, { request_id: randomUUID(), expected_event_version: before.event_version, disposition: 'completed' }); db.close();
  const model = await fakeModels(f.root); r = await AppRuntime.open(f.config, { modelRuntime: model.runtime }); t.after(() => r.close());
  const initial = await r.runOnce() as { state: string };
  if (mode === 'report-before-db') {
    assert.equal(initial.state, 'report_version_conflict');
    assert.equal(r.native.metadata().filter(v => v.kind === 'report_rejected').length, 1);
    assert.equal((await r.runOnce() as { state: string }).state, 'report_saved');
    const intents = r.native.metadata().filter(v => v.kind === 'report_intent'); assert.equal(intents.length, 3); // bootstrap, original rejected update, linked late fact
    assert(intents.at(-1)!.rejected_parent);
    assert.equal((intents.at(-1)!.input as Record<string, unknown>).interaction, undefined);
  } else { assert.equal(initial.state, 'report_saved'); assert.equal(r.native.metadata().filter(v => v.kind === 'report_rejected').length, 0); }
  await r.runOnce(); await r.runOnce();
  const event = r.core.getEvent(f.user(), first.event_id, f.registry()); assert.equal(event.disposition, 'completed'); assert.equal(event.body, '持久来源结果；并非独立验收。');
  assert.equal(r.core.listHistory(f.user(), event.id, { after: 0, limit: 100 }).items.filter(h => h.kind === 'source_result_reported').length, 1);
  assert.equal(r.native.entries().filter(e => e.type === 'custom_message' && e.customType === responseType).length, 1); assert.equal(model.calls.length, 0);
});

test('known report version conflict caused by changed source content stays held; no automatic rebase into a new question', async t => {
  const f = fixture(); f.init(); const firstModel = await fakeModels(f.root, [ask()]); let r = await AppRuntime.open(f.config, { modelRuntime: firstModel.runtime });
  const first = await r.runOnce() as { event_id: string }; respond(r, f, first.event_id); await r.close();
  assert.equal((await exited(child('report-before-db', f))).signal, 'SIGKILL');
  const db = openDatabase(join(f.value.data_dir, 'ledger.sqlite')); const core = new CoreStore(db); const event = core.getEvent(f.source(), first.event_id, f.registry());
  core.update(f.source(), event.id, { update_id: randomUUID(), expected_event_version: event.event_version, kind: 'progress', body: 'new authoritative source content', target_revision: 'new-source-revision', interaction: { id: 'new-question', actions: [{ id: 'new', label: '新的问题', type: 'button' }] } }); db.close();
  const model = await fakeModels(f.root); r = await AppRuntime.open(f.config, { modelRuntime: model.runtime }); t.after(() => r.close());
  assert.equal((await r.runOnce() as { state: string }).state, 'report_version_conflict');
  await assert.rejects(r.runOnce(), /REPORT_CONFLICT_REQUIRES_INSPECTION/);
  const current = r.core.getEvent(f.user(), event.id, f.registry()); assert.equal(current.body, 'new authoritative source content'); assert.equal(current.interaction?.id, 'new-question');
  assert.equal(model.calls.length, 0); assert.equal(r.native.metadata().filter(v => v.kind === 'report_intent').length, 2);
});
