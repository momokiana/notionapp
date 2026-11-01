import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { readConfig } from '../src/config.js';

test('defaults bind only to loopback and use a persistent local database', () => {
  const cwd = resolve('config-test');
  assert.deepEqual(readConfig({}, cwd), {
    host: '127.0.0.1',
    port: 3000,
    databasePath: resolve(cwd, 'data/app.sqlite'),
    authFile: resolve(cwd, 'data/credentials.json'),
  });
});

test('explicit host, port and database file are respected', () => {
  assert.deepEqual(readConfig({ HOST: '::1', PORT: '4200', DATABASE_PATH: './state/test.sqlite', AUTH_FILE: './private/auth.json' }), {
    host: '::1',
    port: 4200,
    databasePath: resolve('./state/test.sqlite'),
    authFile: resolve('./private/auth.json'),
  });
});

test('malformed, empty, fractional and out-of-range ports are rejected', () => {
  for (const port of ['', '0', '-1', '65536', '3000suffix', '3.5', '1e3', ' 3000 ']) {
    assert.throws(() => readConfig({ PORT: port }), /PORT/);
  }
});

test('implicit or malformed host names are rejected', () => {
  for (const host of ['', 'localhost', 'not-an-address']) {
    assert.throws(() => readConfig({ HOST: host }), /HOST/);
  }
});

test('runtime configuration rejects empty credentials paths', () => {
  for (const authFile of ['', '  ']) assert.throws(() => readConfig({ AUTH_FILE: authFile }), /AUTH_FILE/);
});

test('runtime configuration does not silently use an empty or in-memory database', () => {
  for (const databasePath of ['', '  ', ':memory:']) {
    assert.throws(() => readConfig({ DATABASE_PATH: databasePath }), /DATABASE_PATH/);
  }
});

test('managed device auth is explicitly selected with both original path and fixed ID, never inferred', () => {
  const id = randomUUID();
  for (const env of [{ DEVICE_AUTH_PATH: './authority.sqlite' }, { DEVICE_AUTH_STORE_ID: id }, { DEVICE_AUTH_PATH: '', DEVICE_AUTH_STORE_ID: id }, { DEVICE_AUTH_PATH: './authority.sqlite', DEVICE_AUTH_STORE_ID: 'replacement' }]) assert.throws(() => readConfig(env));
  assert.deepEqual(readConfig({ DEVICE_AUTH_PATH: './private/authority.sqlite', DEVICE_AUTH_STORE_ID: id }).deviceAuth, { path: resolve('./private/authority.sqlite'), store_id: id });
});
