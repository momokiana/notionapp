import type Database from 'better-sqlite3';
import { notificationDdl } from './notifications.js';
import {assertNoRecovery} from './recovery-gate.js';

export const APP_ID = 0x4e4f5449;
export const ledgerDdl = [
  `CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, source TEXT NOT NULL, epoch TEXT NOT NULL, data TEXT NOT NULL)`,
  `CREATE TABLE responses (seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, id TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES events(id), source TEXT NOT NULL, epoch TEXT NOT NULL, interaction_id TEXT NOT NULL, interaction_version INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(owner,id), UNIQUE(event_id,interaction_id,interaction_version))`,
  `CREATE TABLE operations (scope TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope,id))`,
  `CREATE TABLE history (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL REFERENCES events(id), kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE read_states (event_id TEXT NOT NULL REFERENCES events(id), owner TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(event_id,owner))`,
  `CREATE TABLE outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL REFERENCES events(id), version INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','withheld')), UNIQUE(event_id,version,kind))`,
];
export const commandDdl = `CREATE TABLE commands (id TEXT PRIMARY KEY, owner TEXT NOT NULL, source TEXT NOT NULL, epoch TEXT NOT NULL, response_id TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES events(id), data TEXT NOT NULL, attempted INTEGER NOT NULL DEFAULT 0 CHECK(attempted IN (0,1)), receipt TEXT, UNIQUE(owner,response_id))`;
export const schemaVersion = 3;
const normalSql = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/;$/, '');
export function initializeSchema(db: Database.Database): void {
  assertNoRecovery(db);
  db.transaction(() => {
    assertNoRecovery(db);
    const objects = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as { type: string; name: string; sql: string }[];
    const version = db.pragma('user_version', { simple: true }); const appId = db.pragma('application_id', { simple: true });
    if (version === 0 && appId === 0 && objects.length === 0) {
      for (const sql of [...ledgerDdl, commandDdl, ...notificationDdl]) db.exec(sql);
      db.pragma(`application_id = ${APP_ID}`); db.pragma(`user_version = ${schemaVersion}`); return;
    }
    const expectedDdl = version === 1 ? ledgerDdl : version === 2 ? [...ledgerDdl, commandDdl] : version === schemaVersion ? [...ledgerDdl, commandDdl, ...notificationDdl] : null;
    const expected = new Set(expectedDdl?.map(normalSql));
    if (!expectedDdl || appId !== APP_ID || objects.length !== expectedDdl.length || objects.some(o => o.type !== 'table' || !expected.has(normalSql(o.sql)))) throw new Error('Unsupported or unrecognized core database schema; no migration performed');
    if (version === 1) db.exec(commandDdl);
    if (version === 1 || version === 2) {
      for (const sql of notificationDdl) db.exec(sql);
      db.pragma(`user_version = ${schemaVersion}`);
    }
  }).immediate();
}
