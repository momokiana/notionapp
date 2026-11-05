import { canonical, fail, spoolBinding } from './validation.mjs';

export const APP = 0x4e434f4e;
export const DDL = [
  'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  'CREATE TABLE queue (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, event_id TEXT, mapping TEXT, payload TEXT NOT NULL, wire TEXT, state TEXT NOT NULL, ack TEXT, error TEXT) STRICT',
  'CREATE TABLE maps (key TEXT PRIMARY KEY, event_id TEXT, version INTEGER NOT NULL, digest TEXT NOT NULL, watermark INTEGER NOT NULL) STRICT',
];
export function validateSpool(db, c) {
  if (db.prepare('PRAGMA application_id').get().application_id !== APP || db.prepare('PRAGMA user_version').get().user_version !== 1) fail('UNKNOWN_SPOOL');
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 4").all().map(r => r.sql).sort();
  if (canonical(sql) !== canonical([...DDL].sort()) || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('UNKNOWN_SPOOL');
  if (db.prepare("SELECT value FROM meta WHERE key='binding'").get()?.value !== spoolBinding(c)) fail('SPOOL_BINDING_MISMATCH');
}
