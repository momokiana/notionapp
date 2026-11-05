import { canonical, fail, object, spoolBinding } from './validation.mjs';

export const APP = 0x4e434f4e;
export const DDL = [
  'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  'CREATE TABLE queue (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, event_id TEXT, mapping TEXT, payload TEXT NOT NULL, wire TEXT, state TEXT NOT NULL, ack TEXT, error TEXT) STRICT',
  'CREATE TABLE maps (key TEXT PRIMARY KEY, event_id TEXT, version INTEGER NOT NULL, digest TEXT NOT NULL, watermark INTEGER NOT NULL) STRICT',
];
export const ROW_FIELDS = ['seq','id','fingerprint','kind','event_id','mapping','payload','wire','state','ack','error'];
export const ARCHIVE_DDL = "CREATE TABLE archive (seq INTEGER PRIMARY KEY, bytes INTEGER NOT NULL CHECK(bytes>=0), id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, event_id TEXT, mapping TEXT, payload TEXT NOT NULL, wire TEXT, state TEXT NOT NULL CHECK(state IN ('saved','blocked')), ack TEXT, error TEXT) STRICT";
export const DEFAULT_POLICY = Object.freeze({active_operations:10000,active_reserved_bytes:8*1024*1024,archive_operations:100000,archive_bytes:64*1024*1024});
export const POLICY_MAX = Object.freeze({active_operations:100000,active_reserved_bytes:32*1024*1024,archive_operations:1000000,archive_bytes:128*1024*1024});
export function storagePolicy(value) {
  object(value,Object.keys(DEFAULT_POLICY));
  for(const key of Object.keys(DEFAULT_POLICY))if(!Number.isSafeInteger(value[key])||value[key]<1||value[key]>POLICY_MAX[key])fail('INVALID_STORAGE_POLICY');
  return Object.freeze({...value});
}
export function readPolicy(db) {
  let value;try{value=JSON.parse(db.prepare("SELECT CASE WHEN length(CAST(value AS BLOB))<=4096 THEN value ELSE NULL END AS value FROM meta WHERE key='storage_policy'").get()?.value);return storagePolicy(value);}catch{fail('INVALID_STORAGE_POLICY');}
}
export function formatVersion(db) { return db.prepare('PRAGMA user_version').get().user_version; }
export function validateSpool(db, c) {
  const version=formatVersion(db);
  if (db.prepare('PRAGMA application_id').get().application_id !== APP || ![1,2].includes(version)) fail('UNKNOWN_SPOOL');
  const expected=version===1?DDL:[...DDL,ARCHIVE_DDL];
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 5").all().map(r => r.sql).sort();
  if (canonical(sql) !== canonical([...expected].sort()) || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('UNKNOWN_SPOOL');
  if (db.prepare("SELECT value FROM meta WHERE key='binding'").get()?.value !== spoolBinding(c)) fail('SPOOL_BINDING_MISMATCH');
  if(version===2){
    readPolicy(db);
    if(db.prepare('SELECT EXISTS(SELECT 1 FROM queue JOIN archive USING(id)) AS bad').get().bad || db.prepare('SELECT EXISTS(SELECT 1 FROM queue JOIN archive USING(seq)) AS bad').get().bad)fail('UNKNOWN_SPOOL');
  }
  return version;
}
