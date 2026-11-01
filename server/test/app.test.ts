import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';

test('health returns a database probe, not an event delivery claim', async (t) => {
  const database = openDatabase(':memory:');
  const app = createApp(database);
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok', storage: 'ready' });
});

test('unavailable storage is reported as unhealthy, never false success', async (t) => {
  const database = openDatabase(':memory:');
  const app = createApp(database);
  t.after(() => app.close());
  database.close();

  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { status: 'unavailable', storage: 'unavailable' });
});

test('core endpoints fail closed without credentials; no send or management API exists', async (t) => {
  const app = createApp(openDatabase(':memory:'));
  t.after(() => app.close());
  for (const url of ['/v1/events', '/v1/events/example/responses']) {
    const response = await app.inject({ method: 'POST', url, payload: {} });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'AUTH_NOT_CONFIGURED');
  }
  for (const url of ['/send', '/v1/commands/test/receipts', '/v1/sources']) {
    assert.equal((await app.inject({ method: 'POST', url, payload: {} })).statusCode, 404);
  }
});

test('the application serves real local HTTP and closes its SQLite connection', async () => {
  const database = openDatabase(':memory:');
  const app = createApp(database);
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', storage: 'ready' });
  } finally {
    await app.close();
  }
  assert.equal(database.open, false);
});
