import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { HTTPMethods } from 'fastify';
import { createApp } from '../src/app.js';
import { parseRegistry } from '../src/auth.js';
import { openDatabase } from '../src/database.js';
import type { CreateEvent, SubmitResponse } from '../src/contracts.js';

export const NOW = Date.parse('2026-01-01T00:00:00Z');
export const EXPIRES = '2026-01-02T00:00:00Z';
export function credentials() {
  const user = (id: string, owner_id: string) => ({ id, owner_id, kind: 'user' as const, token: randomBytes(32).toString('hex') });
  const source = (id: string, owner_id: string, capabilities = ['publish', 'read_responses', 'reply']) => ({
    id, owner_id, kind: 'source' as const, token: randomBytes(32).toString('hex'), source_id: id, source_epoch: 'epoch_1', capabilities,
  });
  return { principals: [user('user', 'owner'), user('device2', 'owner'), user('outsider', 'other'), source('source', 'owner'), source('neighbor', 'owner'), source('foreign', 'other'), source('readonly', 'owner', ['publish', 'read_responses'])] };
}
export const eventInput = (overrides: Partial<CreateEvent> = {}): CreateEvent => ({
  request_id: randomUUID(), title: 'Fixture question', body: 'Choose an option', session_ref: 'fixture_session', target_revision: 'revision_1', expires_at: EXPIRES,
  interaction: { id: 'question', actions: [{ id: 'yes', label: 'Continue', type: 'button' }, { id: 'text', label: 'Reply', type: 'text' }] }, ...overrides,
});
export const responseInput = (overrides: Partial<SubmitResponse> = {}): SubmitResponse => ({
  response_id: randomUUID(), event_version: 1, interaction_id: 'question', interaction_version: 1, action_id: 'yes', text: '', ...overrides,
});
export function fixture(t: TestContext, persistent = false) {
  const root = mkdtempSync(join(tmpdir(), 'notification-test-'));
  const config = credentials();
  const tokens = Object.fromEntries(config.principals.map(p => [p.id, p.token]));
  const registry = () => parseRegistry(config);
  let time = NOW;
  const databasePath = join(root, 'ledger.sqlite');
  const db = openDatabase(persistent ? databasePath : ':memory:');
  const app = createApp(db, false, { registry, now: () => time });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const req = (method: HTTPMethods, url: string, payload?: object, actor = 'source') => app.inject({
    method, url, ...(payload === undefined ? {} : { payload }), headers: { authorization: `Bearer ${tokens[actor]}` },
  });
  const create = async (overrides: Partial<CreateEvent> = {}, actor = 'source') => {
    const input = eventInput(overrides);
    const result = await req('POST', '/v1/events', input, actor);
    assert.equal(result.statusCode, 200, result.body);
    return { id: result.json().event_id as string, input, ack: result.json() };
  };
  return { root, databasePath, config, tokens, registry, db, app, req, create, setTime: (n: number) => { time = n; } };
}
export const tables = ['events', 'responses', 'operations', 'history', 'read_states', 'outbox', 'commands', 'push_devices', 'notice_batches', 'notifications'] as const;
export function snapshot(db: ReturnType<typeof openDatabase>) {
  return tables.map(name => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all());
}
export function code(response: { statusCode: number; body: string; json(): any }, status: number, expected: string) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, expected);
}
