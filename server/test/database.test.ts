import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/database.js';

test('a real SQLite file preserves data across connection restarts', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'notification-db-test-'));
  const path = join(directory, 'nested', 'test.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const first = openDatabase(path);
  try {
    assert.equal(first.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(first.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(first.pragma('synchronous', { simple: true }), 2);
    assert.equal(first.pragma('busy_timeout', { simple: true }), 5000);
    // This table is a test fixture, not the product event schema.
    first.exec('CREATE TABLE fixture (value TEXT NOT NULL)');
    first.prepare('INSERT INTO fixture VALUES (?)').run('中文 SQLite persistence');
  } finally {
    first.close();
  }

  const second = openDatabase(path);
  try {
    assert.deepEqual(second.prepare('SELECT value FROM fixture').get(), {
      value: '中文 SQLite persistence',
    });
  } finally {
    second.close();
  }
});

test('opening storage does not invent product tables or migrations', (t) => {
  const database = openDatabase(':memory:');
  t.after(() => { if (database.open) database.close(); });
  assert.deepEqual(database.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table'), []);
});

test('invalid database contents fail instead of silently replacing data', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'notification-invalid-db-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'invalid.sqlite');
  const original = 'This is not a SQLite database; do not replace it.';
  writeFileSync(path, original);

  assert.throws(() => openDatabase(path), /not a database/);
  assert.equal(readFileSync(path, 'utf8'), original);
});
