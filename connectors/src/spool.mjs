import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, writeSync, fsyncSync, lstatSync, fstatSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, hash, fail, operation, privateParent, privateStat, spoolBinding, sourceBinding, MAX_BODY, config } from './validation.mjs';

const APP = 0x4e434f4e;
const DDL = [
  'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  'CREATE TABLE queue (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, event_id TEXT, mapping TEXT, payload TEXT NOT NULL, wire TEXT, state TEXT NOT NULL, ack TEXT, error TEXT) STRICT',
  'CREATE TABLE maps (key TEXT PRIMARY KEY, event_id TEXT, version INTEGER NOT NULL, digest TEXT NOT NULL, watermark INTEGER NOT NULL) STRICT',
];
export function syncParent(path) { const fd = openSync(dirname(path), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function same(a, b) { return a.dev === b.dev && a.ino === b.ino; }

/** Local bounded transport spool. No user responses, native commands, permissions or event history. */
export class Spool {
  constructor(c, { init = false, capacity = 10000 } = {}) {
    c = config(c);
    const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
    this.c = freeze(c); this.path = c.spool; this.lock = `${c.spool}.lock`; this.capacity = Math.min(capacity, 10000); this.syncDirectory = syncParent;
    privateParent(this.path);
    let lockfd;
    try {
      lockfd = openSync(this.lock, 'wx', 0o600); this.lockStat = fstatSync(lockfd);
      writeSync(lockfd, JSON.stringify({ pid: process.pid, note: 'Verify this exact owner exited before removing a crash lock' })); fsyncSync(lockfd); syncParent(this.lock);
      if (!existsSync(this.path)) {
        if (!init) fail('SPOOL_NOT_INITIALIZED');
        const fd = openSync(this.path, 'wx', 0o600); try { fsyncSync(fd); } finally { closeSync(fd); } syncParent(this.path);
        this.isNew = true;
      }
      for (const p of [this.path, `${this.path}-wal`, `${this.path}-shm`, `${this.path}-journal`]) if (existsSync(p)) privateStat(lstatSync(p));
      this.fileStat = lstatSync(this.path);
      if (!this.isNew && this.fileStat.size === 0) fail('UNKNOWN_SPOOL');
      // Read-only validation before any WAL pragma or schema mutation of existing files.
      if (!this.isNew) {
        const read = new DatabaseSync(this.path, { readOnly: true });
        try { this.validate(read); } finally { read.close(); }
      }
      this.db = new DatabaseSync(this.path);
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA max_page_count=8192; PRAGMA wal_autocheckpoint=64');
      if (this.isNew) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const sql of DDL) this.db.exec(sql);
          this.db.exec(`PRAGMA application_id=${APP}; PRAGMA user_version=1`);
          this.db.prepare('INSERT INTO meta VALUES (?,?)').run('binding', spoolBinding(c));
          this.db.prepare('INSERT INTO meta VALUES (?,?)').run('observer', canonical({ generation: 0, state: 'disconnected', reason: 'not_started' }));
          this.db.exec('COMMIT'); syncParent(this.path);
        } catch (e) { this.db.exec('ROLLBACK'); throw e; }
      }
      this.validate(this.db); this.assertFiles();
    } catch (e) {
      this.db?.close();
      if (this.lockStat && existsSync(this.lock) && same(lstatSync(this.lock), this.lockStat)) { unlinkSync(this.lock); syncParent(this.lock); }
      throw e;
    } finally { if (lockfd !== undefined) closeSync(lockfd); }
  }
  validate(db) {
    if (db.prepare('PRAGMA application_id').get().application_id !== APP || db.prepare('PRAGMA user_version').get().user_version !== 1) fail('UNKNOWN_SPOOL');
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.sql).sort();
    if (canonical(sql) !== canonical([...DDL].sort()) || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('UNKNOWN_SPOOL');
    if (db.prepare("SELECT value FROM meta WHERE key='binding'").get()?.value !== spoolBinding(this.c)) fail('SPOOL_BINDING_MISMATCH');
  }
  assertFiles() {
    privateParent(this.path);
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`, `${this.path}-journal`, this.lock]) {
      if (!existsSync(path)) { if ([this.path, this.lock].includes(path)) fail('SPOOL_PATH_CHANGED'); else continue; }
      const s = lstatSync(path); privateStat(s);
      if ((path === this.path && !same(s, this.fileStat)) || (path === this.lock && !same(s, this.lockStat))) fail('SPOOL_PATH_CHANGED');
      if (s.size > 32 * 1024 * 1024) fail('SPOOL_FULL');
    }
  }
  tx(action) {
    this.assertFiles(); this.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const result = action(); this.db.exec('COMMIT'); committed = true;
      this.syncDirectory(this.path); // covers newly created/recreated WAL directory entry before any ACK
      return result;
    } catch (e) { if (!committed) this.db.exec('ROLLBACK'); throw e; }
  }
  insert(op, mapping = null) {
    const fp = hash(canonical(op));
    const prior = this.db.prepare('SELECT * FROM queue WHERE id=?').get(op.id);
    if (prior) { if (prior.fingerprint !== fp) fail('IDEMPOTENCY_CONFLICT'); return { state: prior.state, receipt: prior.ack ? JSON.parse(prior.ack) : null }; }
    if (this.db.prepare('SELECT COUNT(*) AS n FROM queue').get().n >= this.capacity) fail('SPOOL_FULL');
    this.db.prepare('INSERT INTO queue(id,fingerprint,kind,event_id,mapping,payload,state) VALUES (?,?,?,?,?,?,?)').run(op.id, fp, op.kind, op.event_id ?? null, mapping, canonical(op.payload), 'pending');
    return { state: 'connector_persisted', receipt: null };
  }
  enqueue(input) { const op = JSON.parse(JSON.stringify(operation(input))); return this.tx(() => this.insert(op)); }
  observer() { return JSON.parse(this.db.prepare("SELECT value FROM meta WHERE key='observer'").get().value); }
  setObserver(v) { this.db.prepare("UPDATE meta SET value=? WHERE key='observer'").run(canonical(v)); }
  disconnected(reason) { this.tx(() => this.setObserver({ ...this.observer(), state: 'disconnected', reason })); }
  beginObservation() {
    return this.tx(() => {
      const generation = this.observer().generation + 1;
      this.setObserver({ generation, state: 'snapshot', reason: 'gap_current_snapshot_only' });
      // A new daemon may restart its sequence. Old transport rows remain untouched.
      this.db.prepare('UPDATE maps SET watermark=0').run(); return generation;
    });
  }
  observe(key, data, watermark, generation) {
    return this.tx(() => {
      if (this.observer().generation !== generation) fail('STALE_OBSERVER');
      const prior = this.db.prepare('SELECT * FROM maps WHERE key=?').get(key);
      if (prior && watermark < prior.watermark) fail('SEQUENCE_ROLLBACK');
      const { observed_at: _time, ...semantic } = data;
      const digest = hash(canonical(semantic));
      if (!prior || prior.digest !== digest) {
        const selected = this.c.uniflo.sessions.find(s => s.key === key); if (!selected) fail('UNSELECTED_SESSION');
        const rid = randomUUID();
        const ref = `uniflo_${hash(`${spoolBinding(this.c)}\n${key}`)}`;
        const op = prior ? { id: rid, kind: 'update', payload: { update_id: rid, kind: 'progress', body: canonical(data) } } : {
          id: rid, kind: 'create', payload: { request_id: rid, title: `${selected.alias} · 只读观察`, body: canonical(data), session_ref: ref, target_revision: 'readonly_1', expires_at: '2099-01-01T00:00:00Z' },
        };
        this.insert(op, key);
      }
      this.db.prepare('INSERT INTO maps VALUES (?,NULL,0,?,?) ON CONFLICT(key) DO UPDATE SET digest=excluded.digest,watermark=excluded.watermark').run(key, digest, watermark);
      this.setObserver({ generation, state: 'observing', reason: 'current_metadata_only' });
    });
  }
  prepare() {
    return this.tx(() => {
      const row = this.db.prepare("SELECT * FROM queue WHERE state!='saved' ORDER BY seq LIMIT 1").get();
      if (!row) return null; if (row.state === 'blocked') fail('QUEUE_BLOCKED');
      if (row.wire) return row;
      const p = JSON.parse(row.payload); let event = row.event_id;
      if (row.mapping && row.kind === 'update') {
        const m = this.db.prepare('SELECT * FROM maps WHERE key=?').get(row.mapping);
        if (!m?.event_id || m.version < 1) fail('MAPPING_NOT_SAVED');
        event = m.event_id; p.expected_event_version = m.version;
      }
      p.source_binding = sourceBinding(this.c);
      const wire = canonical(p); if (Buffer.byteLength(wire) > MAX_BODY) fail('INPUT_TOO_LARGE');
      this.db.prepare("UPDATE queue SET wire=?,event_id=?,state='unknown' WHERE seq=?").run(wire, event, row.seq);
      return { ...row, wire, event_id: event, state: 'unknown' };
    });
  }
  saved(row, ack) {
    this.tx(() => {
      this.db.prepare("UPDATE queue SET state='saved',ack=?,error=NULL WHERE seq=? AND state='unknown'").run(canonical(ack), row.seq);
      if (row.mapping) this.db.prepare('UPDATE maps SET event_id=?,version=? WHERE key=?').run(ack.event_id, ack.event_version, row.mapping);
    });
  }
  blocked(row, code) { this.tx(() => this.db.prepare("UPDATE queue SET state='blocked',error=? WHERE seq=?").run(code, row.seq)); }
  status() {
    this.assertFiles(); this.syncDirectory(this.path);
    return { counts: this.db.prepare('SELECT state,COUNT(*) AS count FROM queue GROUP BY state').all(), observation: this.observer(), receipts: 'event_saved_is_not_source_received' };
  }
  close() {
    if (this.db?.isOpen) this.db.close();
    if (this.lockStat && existsSync(this.lock) && same(lstatSync(this.lock), this.lockStat)) { unlinkSync(this.lock); syncParent(this.lock); this.lockStat = undefined; }
  }
}
