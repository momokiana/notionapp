import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from 'notification-server/app';
import { AppRuntime } from '../src/runtime.js';
import { controlType, responseType } from '../src/native.js';
import { fixture, fakeModels, ask, manualEvent, respond } from './helpers.js';
import { digest } from '../src/private-files.js';

test('real SDK + real ledger HTTP: button and text enter exact native context; next question/result update only original event', async t => {
  const f = fixture(); f.init();
  const model = await fakeModels(f.root, [ask(), ask('请用文字补充'), { thinking: 'PRIVATE_FIXTURE_THINKING_NOT_UPLOAD', text: '来源结果：原文已收到；没有执行或独立核验。' }]);
  const r = await AppRuntime.open(f.config, { modelRuntime: model.runtime });
  const app = createApp(r.native.database, false, { registry: r.registry }); await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => { await r.stop(); await app.close(); await r.close(); });
  const address = app.server.address(); assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${f.userToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200); return response.json();
  };
  const created = await r.runOnce() as { event_id: string }; assert(created.event_id);
  const inbox = await call('/v1/events'); assert.equal(inbox.items.length, 1);
  let event = await call(`/v1/events/${created.event_id}`);
  assert.equal(event.can_respond, true); assert.equal(event.verification, 'not_verified');
  assert.equal(r.session.getActiveToolNames().join(), 'app_question'); assert.equal(r.session.getCallableToolNames().length, 0);
  const settled = r.native.metadata().find(v => v.kind === 'run_settled')!;
  assert.equal((settled.target as { state_revision: string }).state_revision, r.host.target().state_revision, 'metadata publication/ACK must not invalidate the published target');
  const buttonId = randomUUID();
  const button = { response_id: buttonId, event_version: event.event_version, interaction_id: event.interaction.id, interaction_version: event.interaction_version, action_id: 'confirm', text: '' };
  await call(`/v1/events/${event.id}/responses`, 'POST', button);
  await call(`/v1/events/${event.id}/responses`, 'POST', button); // Original immutable request, not a second click.
  await r.runOnce();
  const first = r.native.entries().find(e => e.type === 'custom_message' && e.customType === responseType)!;
  assert(first.type === 'custom_message' && typeof first.content === 'string');
  const framed = JSON.parse(first.content);
  assert.equal(framed.response.id, buttonId); assert.equal(framed.response.action.label, '确认'); assert.equal(framed.response.text, '');
  const received = await call(`/v1/responses/${buttonId}`);
  assert.equal(received.source_delivery.receipt.message_id, first.id);
  assert.equal(received.source_delivery.receipt.session_ref, r.native.manager.getSessionId());
  assert.equal(received.execution_state, 'not_observed'); assert.equal(received.verification, 'not_verified');
  assert(JSON.stringify(model.calls[1]!.context.messages).includes(buttonId));
  assert.deepEqual(model.calls[1]!.env, {});
  event = await call(`/v1/events/${event.id}`);
  assert.equal(event.id, created.event_id); assert.equal(event.interaction.version, 2); assert.equal(event.can_respond, true);
  const textId = randomUUID(); const originalText = '精确原文：蓝🧪\n第二行，不执行外部操作';
  await call(`/v1/events/${event.id}/responses`, 'POST', { response_id: textId, event_version: event.event_version, interaction_id: event.interaction.id, interaction_version: event.interaction_version, action_id: 'reply', text: originalText });
  await r.runOnce(); await r.runOnce();
  event = await call(`/v1/events/${event.id}`);
  assert.equal(event.body, '来源结果：原文已收到；没有执行或独立核验。'); assert.equal(event.disposition, 'open'); assert.equal(event.can_respond, false);
  const nativeInputs = r.native.entries().filter(e => e.type === 'custom_message' && e.customType === responseType);
  assert.equal(nativeInputs.length, 2);
  const second = nativeInputs[1]!; assert(second.type === 'custom_message' && typeof second.content === 'string');
  assert.equal(JSON.parse(second.content).response.text, originalText);
  assert(JSON.stringify(model.calls[2]!.context.messages).includes('蓝🧪'));
  const history = await call(`/v1/events/${event.id}/history`);
  assert.equal(history.items.filter((h: { kind: string }) => h.kind === 'source_received').length, 2);
  assert.equal(history.items.filter((h: { kind: string }) => h.kind === 'source_result_reported').length, 1);
  assert(!JSON.stringify(history).includes('PRIVATE_FIXTURE_THINKING_NOT_UPLOAD'));
  assert.equal((await call('/v1/events')).items.length, 1); assert.equal(model.calls.length, 3);
});

test('source revoke and user close before model processing withhold new request; acceptance fact survives', async t => {
  const f = fixture(false); f.init(); const model = await fakeModels(f.root); const r = await AppRuntime.open(f.config, { modelRuntime: model.runtime }); t.after(() => r.close());
  const event = manualEvent(r); const responseId = respond(r, f, event.id);
  assert.equal((await r.runOnce() as { state: string }).state, 'source_received_model_disabled');
  assert.equal(model.calls.length, 0); assert.equal(r.core.getResponse(f.user(), responseId, f.registry()).source_delivery?.state, 'source_received');
  f.principals[1]!.capabilities = ['publish', 'read_responses', 'reply']; f.saveGrants();
  await assert.rejects(r.runOnce(), /SOURCE_AUTHORIZATION_CHANGED/); assert.equal(model.calls.length, 0);
  f.principals[1]!.capabilities!.push('deliver'); f.saveGrants();
  const e = r.core.getEvent(f.user(), event.id, f.registry()); r.core.disposition(f.user(), event.id, { request_id: randomUUID(), expected_event_version: e.event_version, disposition: 'completed' });
  await r.close(); f.value.allow_model_calls = true;
  const { writeFileSync } = await import('node:fs'); writeFileSync(f.configFile, JSON.stringify(f.value), { mode: 0o600 });
  const restarted = await AppRuntime.open(f.config, { modelRuntime: model.runtime }); t.after(() => restarted.close());
  await restarted.runOnce(); assert.equal(model.calls.length, 0);
  const result = restarted.core.getResponse(f.user(), responseId, f.registry()); assert.equal(result.source_delivery?.state, 'source_received'); assert.equal(result.routing_state, 'blocked');
});

test('user closes during already-started model request: late result appends without reopening or new notification', async t => {
  const f = fixture(); f.init(); let r: AppRuntime;
  const model = await fakeModels(f.root, [ask(), { text: '迟到来源结果', onRequest: () => {
    const e = r.core.listEvents(f.user(), { after: 0, limit: 100 }, f.registry()).items[0]!;
    r.core.disposition(f.user(), e.id, { request_id: randomUUID(), expected_event_version: e.event_version, disposition: 'completed' });
  } }]);
  r = await AppRuntime.open(f.config, { modelRuntime: model.runtime }); t.after(() => r.close());
  const first = await r.runOnce() as { event_id: string }; respond(r, f, first.event_id);
  const before = (r.native.database.prepare('SELECT COUNT(*) n FROM outbox').get() as { n: number }).n;
  await r.runOnce();
  const event = r.core.getEvent(f.user(), first.event_id, f.registry());
  assert.equal(event.body, '迟到来源结果'); assert.equal(event.disposition, 'completed'); assert.equal(event.verification, 'not_verified');
  assert.equal((r.native.database.prepare('SELECT COUNT(*) n FROM outbox').get() as { n: number }).n, before);
  assert.equal(model.calls.length, 2);
});

test('closed event receives a generated follow-up as noninteractive progress, not a replacement question', async t => {
  const f = fixture(); f.init(); const model = await fakeModels(f.root, [ask(), ask('关闭后的后续问题')]);
  const r = await AppRuntime.open(f.config, { modelRuntime: model.runtime }); t.after(() => r.close());
  const first = await r.runOnce() as { event_id: string }; respond(r, f, first.event_id);
  const send = r.session.sendCustomMessage.bind(r.session);
  r.session.sendCustomMessage = async (...args) => {
    await send(...args); const e = r.core.getEvent(f.user(), first.event_id, f.registry());
    r.core.disposition(f.user(), e.id, { request_id: randomUUID(), expected_event_version: e.event_version, disposition: 'not_tracking' });
  };
  await r.runOnce(); const event = r.core.getEvent(f.user(), first.event_id, f.registry());
  assert.equal(event.disposition, 'not_tracking'); assert.equal(event.interaction_version, 1); assert.equal(event.can_respond, false);
  assert(event.body.includes('未替换交互')); assert(event.body.includes('关闭后的后续问题'));
});

for (const stop of ['error', 'aborted', 'length', 'deferred'] as const) test(`SDK ${stop} terminal never promotes partial text or settled to source success`, async t => {
  const f = fixture(); f.init(); const model = await fakeModels(f.root, [{ stop, text: 'incomplete fixture text' }]);
  const r = await AppRuntime.open(f.config, { modelRuntime: model.runtime }); t.after(() => r.close());
  assert.equal((await r.runOnce() as { state: string }).state, 'model_outcome_unresolved');
  assert.equal((await r.runOnce() as { state: string }).state, 'original_model_run_unresolved');
  assert.equal(model.calls.length, 1); assert.equal(r.core.listEvents(f.user(), { after: 0, limit: 100 }, f.registry()).items.length, 0);
  assert.equal(r.native.entries().filter(e => e.type === 'custom_message' && e.customType === controlType).length, 1);
});

test('a tool batch with a second question cannot turn a single terminate hint into a published successful question', async t => {
  const f = fixture(); f.init(); const model = await fakeModels(f.root, [{ ...ask(), extraQuestion: true }, { text: 'fallback after invalid tool batch' }]);
  const r = await AppRuntime.open(f.config, { modelRuntime: model.runtime }); t.after(() => r.close());
  assert.equal((await r.runOnce() as { state: string }).state, 'model_outcome_unresolved');
  assert.equal(r.native.metadata().filter(v => v.kind === 'question_intent').length, 1);
  assert.equal(r.core.listEvents(f.user(), { after: 0, limit: 100 }, f.registry()).items.length, 0);
  const requests = model.calls.length; await r.runOnce(); assert.equal(model.calls.length, requests);
});

test('over-limit visible source output remains intact natively and is not silently truncated into a card', async t => {
  const f = fixture(); f.init(); const original = '🧪'.repeat(16001); const model = await fakeModels(f.root, [ask(), { text: original }]);
  const r = await AppRuntime.open(f.config, { modelRuntime: model.runtime }); t.after(() => r.close());
  const first = await r.runOnce() as { event_id: string }; respond(r, f, first.event_id); await r.runOnce();
  assert(r.core.getEvent(f.user(), first.event_id, f.registry()).body.includes('未上传'));
  const last = r.native.entries().filter(e => e.type === 'message' && e.message.role === 'assistant').at(-1)!;
  assert(last.type === 'message' && last.message.role === 'assistant');
  assert.equal(digest(last.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n')), digest(original));
});
