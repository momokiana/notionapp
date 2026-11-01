import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from 'notification-server/app';
import { pushConfig } from 'notification-server/notifications';
import { AppRuntime } from '../src/runtime.js';
import { fixture, fakeModels, ask } from './helpers.js';
import { realNtfy } from './real-ntfy.js';

const binary = process.env.NTFY_TEST_BINARY;
test('real ntfy software + actual service consumer + actual SDK: private publication, HTTP response, original result and cached replay; no device claim', { skip: !binary }, async t => {
  const ntfy = await realNtfy(binary!); t.after(() => ntfy.close());
  const f = fixture(); f.init(); const model = await fakeModels(f.root, [ask(), { text: '隔离结果只回原事件，不代表执行或独立核验。' }]);
  const r = await AppRuntime.open(f.config, { modelRuntime: model.runtime });
  const push = pushConfig(ntfy.origin, ntfy.token, true); const app = createApp(r.native.database, false, { registry: r.registry, push });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => { await r.stop(); await app.close(); await r.close(); });
  const address = app.server.address(); assert(address && typeof address === 'object'); const origin = `http://127.0.0.1:${address.port}`;
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const reply = await fetch(origin + path, { method, headers: { authorization: `Bearer ${f.userToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(reply.status, 200); return reply.json();
  };
  const topic = `isolated_${randomUUID()}`;
  const unauthorized = await fetch(`${ntfy.origin}/${topic}`, { method: 'POST', body: 'unauthorized fixture' });
  assert([401, 403].includes(unauthorized.status)); await unauthorized.body?.cancel();
  const privateRead = await fetch(`${ntfy.origin}/${topic}/json?poll=1`); assert([401, 403].includes(privateRead.status)); await privateRead.body?.cancel();
  // This is a synthetic HTTP actor/endpoint, explicitly not an Android distributor or device receipt.
  await api('/v1/device/push', 'PUT', { registration_id: randomUUID(), expected_generation: 0, endpoint: `${ntfy.origin}/${topic}?up=1` });
  const created = await r.runOnce() as { event_id: string };
  const waitFor = async (count: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const messages = await ntfy.messages(topic); const notices = await api('/v1/notifications');
      if (messages.length === count && notices.items.length === count && notices.items.every((n: { platform_state: string }) => n.platform_state === 'platform_accepted')) return messages;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Own real ntfy integration did not reach expected platform facts');
  };
  const first = (await waitFor(1))[0]!;
  const decode = (m: typeof first) => JSON.parse(m.encoding === 'base64' ? Buffer.from(m.message, 'base64').toString('utf8') : m.message);
  const initial = decode(first); assert.deepEqual(Object.keys(initial).sort(), ['delivery_id', 'event_id', 'event_version', 'nonce']);
  assert.equal(initial.event_id, created.event_id); assert.equal(initial.event_version, 1);
  const event = await api(`/v1/events/${created.event_id}`); assert.equal(event.delivery_state, 'platform_accepted');
  assert.equal(event.notification_delivery.device_received_at, null); assert.equal(event.notification_delivery.notification_posted_at, null); assert.equal(event.read_state.unread, true);
  const responseId = randomUUID();
  await api(`/v1/events/${event.id}/responses`, 'POST', { response_id: responseId, event_version: event.event_version, interaction_id: event.interaction.id, interaction_version: event.interaction_version, action_id: 'reply', text: '隔离 HTTP 角色回应，不是假装真机。' });
  await r.runOnce(); const messages = await waitFor(3); // question, saved response, source-reported result
  const payloads = messages.map(decode); assert(payloads.every(p => p.event_id === created.event_id)); assert.deepEqual(payloads.map(p => p.event_version), [1, 2, 3]);
  assert(!JSON.stringify(messages).includes('隔离 HTTP 角色回应')); assert(!JSON.stringify(messages).includes('隔离结果'));
  const response = await api(`/v1/responses/${responseId}`); assert.equal(response.source_delivery.state, 'source_received'); assert.equal(response.execution_state, 'not_observed');
  assert.equal(response.source_delivery.receipt.session_ref, r.native.manager.getSessionId());
  const result = await api(`/v1/events/${event.id}`); assert.equal(result.body, '隔离结果只回原事件，不代表执行或独立核验。'); assert.equal(result.disposition, 'open'); assert.equal(result.verification, 'not_verified');
  const allNotices = await api('/v1/notifications'); assert(allNotices.items.every((n: { device_received_at: string | null; notification_posted_at: string | null }) => n.device_received_at === null && n.notification_posted_at === null));
  await ntfy.restart(); assert.deepEqual((await ntfy.messages(topic)).map(m => m.id), messages.map(m => m.id));
  await r.runOnce(); assert.equal(model.calls.length, 2); assert.equal((await api('/v1/events')).items.length, 1);
});

test('optional Android fixture subscriber is read-only and limited to up*; live stream closes with owned fixture', { skip: !binary }, async () => {
  const ntfy = await realNtfy(binary!, true);
  try {
    assert(ntfy.subscriber);
    const authorization = `Basic ${Buffer.from(`${ntfy.subscriber.username}:${ntfy.subscriber.password}`).toString('base64')}`;
    const read = await fetch(`${ntfy.origin}/up_fixture/json?poll=1`, { headers: { authorization }, signal: AbortSignal.timeout(3000) });
    assert.equal(read.status, 200); await read.body?.cancel();
    const denied = await fetch(`${ntfy.origin}/not_a_distributor_topic/json?poll=1`, { headers: { authorization }, signal: AbortSignal.timeout(3000) });
    assert([401, 403].includes(denied.status)); await denied.body?.cancel();
    const publish = await fetch(`${ntfy.origin}/up_fixture`, { method: 'POST', headers: { authorization }, body: 'must be denied', signal: AbortSignal.timeout(3000) });
    assert([401, 403].includes(publish.status)); await publish.body?.cancel();
    const stream = await fetch(`${ntfy.origin}/up_fixture/json`, { headers: { authorization }, signal: AbortSignal.timeout(10000) });
    assert.equal(stream.status, 200);
    // Do not cancel first: closing this new fixture must release a real distributor-like stream.
    await ntfy.close(); await stream.body?.cancel();
  } catch (error) { await ntfy.close(); throw error; }
});
