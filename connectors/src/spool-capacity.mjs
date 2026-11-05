import sqlite from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { config, fail, privateParent, privateStat, spoolBinding } from './validation.mjs';
import { validateSpool } from './spool-format.mjs';

export const MAX_OPERATIONS = 10000, MAX_RESERVED_BYTES = 8 * 1024 * 1024, MAX_FILE_BYTES = 32 * 1024 * 1024;
const ACK_RESERVE = 1024, ROW_RESERVE = 1024, WIRE_EXTRA = 256, META_RESERVE = 4096;
export const MIN_RECORD_RESERVE = ACK_RESERVE + ROW_RESERVE + WIRE_EXTRA;
export const OBSERVATION_RESERVE = 16 * 1024; // worst supported metadata operation, per selected source
const FILE_MARGIN = 1024 * 1024; // operational WAL headroom, not space or durability promised by SQLite
const measured = new WeakSet();
const byteLength = v => Buffer.byteLength(v ?? '', 'utf8');
export function limits(capacity = MAX_OPERATIONS, byteBudget = MAX_RESERVED_BYTES) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_OPERATIONS || !Number.isSafeInteger(byteBudget) || byteBudget < 1 || byteBudget > MAX_RESERVED_BYTES) fail('INVALID_SPOOL_LIMIT');
  return Object.freeze({ operations: capacity, reserved_bytes: byteBudget, file_bytes: MAX_FILE_BYTES });
}
export function recordReserve(payload, mapping = null) { return byteLength(payload) * 2 + WIRE_EXTRA + ACK_RESERVE + byteLength(mapping) + ROW_RESERVE; }
export const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
export function fileState(path) {
  privateParent(path); const stats = {}, sizes = {};
  for (const [kind, suffix] of Object.entries({ main: '', wal: '-wal', shm: '-shm', journal: '-journal', lock: '.lock' })) {
    let s; try { s = lstatSync(path + suffix); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!s && kind === 'main') fail('SPOOL_NOT_INITIALIZED');
    if (s) privateStat(s);
    stats[kind] = s ?? null; sizes[kind] = s?.size ?? 0;
  }
  return { stats, sizes };
}
export function physicalCause(files) {
  if (Object.values(files.sizes).some(n => n > MAX_FILE_BYTES)) return 'PHYSICAL_FILE_LIMIT';
  // Refuse new writes near a high-water WAL instead of deleting/truncating it or guessing checkpoint success.
  if (files.sizes.wal > MAX_FILE_BYTES - FILE_MARGIN || files.sizes.journal > MAX_FILE_BYTES - FILE_MARGIN) return 'STORAGE_HEADROOM';
  return null;
}
function registerMeasure(db) {
  if (!measured.has(db)) {
    // Connection-local UTF-8 measurement also works for an older v1 database with another text encoding.
    db.function('_connector_utf8_bytes', { deterministic: true }, byteLength); measured.add(db);
  }
}
export function accounting(db, c) {
  registerMeasure(db);
  const q = db.prepare(`SELECT count(*) AS operations,
    coalesce(sum(_connector_utf8_bytes(payload)+_connector_utf8_bytes(wire)+_connector_utf8_bytes(ack)),0) AS materialized_bytes,
    coalesce(sum(_connector_utf8_bytes(payload)+max(_connector_utf8_bytes(wire),_connector_utf8_bytes(payload)+${WIRE_EXTRA})+max(_connector_utf8_bytes(ack),${ACK_RESERVE})+_connector_utf8_bytes(mapping)+${ROW_RESERVE}),0) AS reserved_bytes FROM queue`).get();
  const m = db.prepare('SELECT count(*) AS n,coalesce(sum(_connector_utf8_bytes(key)+_connector_utf8_bytes(event_id)+_connector_utf8_bytes(digest)+1024),0) AS bytes FROM maps').get();
  const meta = db.prepare('SELECT coalesce(sum(_connector_utf8_bytes(key)+_connector_utf8_bytes(value)),0) AS bytes FROM meta').get().bytes;
  const futureMaps = (c.uniflo?.sessions ?? []).reduce((n, s) => n + byteLength(s.key) + 1200, 0);
  return { ...q, reserved_bytes: q.reserved_bytes + Math.max(m.bytes, futureMaps) + Math.max(meta, byteLength(spoolBinding(c)) + 7 + META_RESERVE), maps: m.n, meta_bytes: meta, database_page_bytes: db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size };
}
const states = ['pending', 'unknown', 'saved', 'blocked'];
export function safeReason(value) {
  return /^(?:HTTP_[45]\d\d|SPOOL_FULL|STREAM_LAGGED|SEQUENCE_ROLLBACK|METADATA_REQUIRED|STREAM_ENDED|UNIFLO_SCHEMA_UNSUPPORTED|STOPPED|OBSERVATION_GAP|not_started|current_metadata_only|gap_current_snapshot_only)$/.test(value ?? '') ? value : 'other';
}
export function readObserver(db) {
  const text = db.prepare("SELECT CASE WHEN length(CAST(value AS BLOB))<=4096 THEN value ELSE NULL END AS value FROM meta WHERE key='observer'").get()?.value;
  let v; try { v = JSON.parse(text); } catch { fail('UNKNOWN_SPOOL'); }
  if (!v || !Number.isSafeInteger(v.generation) || v.generation < 0 || !['snapshot', 'observing', 'disconnected'].includes(v.state) || typeof v.reason !== 'string') fail('UNKNOWN_SPOOL');
  return { generation: v.generation, state: v.state, reason: safeReason(v.reason) };
}
export function quota(db, c, bound, files = fileState(c.spool)) {
  const used = accounting(db, c), available = Math.max(0, bound.reserved_bytes - used.reserved_bytes);
  const base = physicalCause(files) ?? (used.database_page_bytes > bound.file_bytes ? 'DATABASE_PAGE_LIMIT' : null);
  const reason = base ?? (used.operations >= bound.operations ? 'OPERATION_LIMIT' : available < MIN_RECORD_RESERVE ? 'RESERVED_BYTES' : null);
  const selections = c.uniflo?.sessions.length ?? 0;
  const observationReason = reason ?? (selections && (used.operations + selections > bound.operations || available < selections * OBSERVATION_RESERVE) ? 'OBSERVATION_HEADROOM' : null);
  return { limits: bound, usage: used, available_reserved_bytes: available,
    retained_over_limit: used.operations > bound.operations || used.reserved_bytes > bound.reserved_bytes,
    admission: reason ? 'backpressure' : 'accepting', reason, admission_is_prediction: true,
    observation_admission: observationReason ? 'backpressure' : 'accepting', observation_reason: observationReason };
}
function statOnly(files) {
  return { diagnostic_only: true, persistence_ack: false, scope_validation: 'not_checked', counts: null, observation: null,
    files: files.sizes, file_sizes_are_nearby_stat: true, lock: files.stats.lock ? 'present' : 'absent',
    capacity: { admission: 'backpressure', reason: 'PHYSICAL_FILE_LIMIT', usage: null, limits: limits() } };
}
export function projection(db, c, bound, files = fileState(c.spool)) {
  const counts = db.prepare('SELECT state,COUNT(*) AS count FROM queue GROUP BY state').all();
  if (counts.some(r => !states.includes(r.state))) fail('UNKNOWN_SPOOL');
  const head = db.prepare("SELECT seq,kind,state,error FROM queue WHERE state!='saved' ORDER BY seq LIMIT 1").get();
  if (head && !['create', 'update'].includes(head.kind)) fail('UNKNOWN_SPOOL');
  return { diagnostic_only: true, persistence_ack: false, scope_validation: 'verified_snapshot',
    counts, observation: readObserver(db), capacity: quota(db, c, bound, files),
    first_unsettled: head ? { seq: head.seq, kind: head.kind, state: head.state, reason: head.error ? safeReason(head.error) : head.state === 'unknown' ? 'original_effect_unknown' : 'not_saved' } : null,
    files: files.sizes, file_sizes_are_nearby_stat: true, lock: files.stats.lock ? 'present' : 'absent', receipts: 'event_saved_is_not_source_received' };
}
/** SQL read-only, not a zero-physical-write forensic reader: SQLite can create/use private SHM. */
export function inspectSpool(input) {
  const c = config(input), before = fileState(c.spool);
  if (Object.values(before.sizes).some(n => n > MAX_FILE_BYTES)) return statOnly(before); // no SQL constructor or query
  const db = new sqlite.DatabaseSync(c.spool, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON; BEGIN');
    validateSpool(db, c); const output = projection(db, c, limits());
    const after = fileState(c.spool);
    for (const k of Object.keys(before.stats)) if (before.stats[k] && after.stats[k] && !sameFile(before.stats[k], after.stats[k])) fail('SPOOL_PATH_CHANGED');
    if (!sameFile(before.stats.main, after.stats.main)) fail('SPOOL_PATH_CHANGED');
    db.exec('COMMIT');
    const result = Object.values(after.sizes).some(n => n > MAX_FILE_BYTES) ? statOnly(after) : { ...output, files: after.sizes };
    if (Buffer.byteLength(JSON.stringify(result)) > 8192) fail('DIAGNOSTIC_TOO_LARGE');
    return result;
  } finally { db.close(); }
}
/** Never log an arbitrary upstream/SQLite error string. The primary SQLite FULL remains distinguishable. */
export function errorCode(e) {
  const codes = ['SPOOL_FULL','QUEUE_BLOCKED','IDEMPOTENCY_CONFLICT','SPOOL_BINDING_MISMATCH','SPOOL_PATH_CHANGED','SPOOL_NOT_INITIALIZED','UNKNOWN_SPOOL','PRIVATE_PATH_REQUIRED','PRIVATE_FILE_REQUIRED','INPUT_TOO_LARGE','INVALID_INPUT','INVALID_CONFIG','INVALID_SPOOL_LIMIT','OBSERVER_BUSY','STALE_OBSERVER','SEQUENCE_ROLLBACK'];
  if (codes.includes(e?.message)) return e.message;
  if ((e?.errcode & 255) === 13) return 'SQLITE_FULL';
  if (e?.code === 'EIO' || e?.code === 'ENOSPC') return 'STORAGE_UNAVAILABLE';
  if (e?.code === 'EEXIST') return 'WRITER_LOCK_PRESENT';
  return 'OPERATION_UNAVAILABLE';
}
