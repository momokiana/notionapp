import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import {assertNoRecovery,assertNoRecoveryFile} from './recovery-gate.js';

// No product schema or migration is introduced by this foundation.
export function openDatabase(path: string): Database.Database {
  assertNoRecoveryFile(path);
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const database = new Database(path);
  try {
    assertNoRecovery(database);
    database.pragma('busy_timeout = 5000');
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    database.pragma('synchronous = FULL');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
