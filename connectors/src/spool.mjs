import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, writeSync, fsyncSync, lstatSync, fstatSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, hash, fail, operation, privateParent, privateStat, spoolBinding, sourceBinding, MAX_BODY, config } from './validation.mjs';

import { APP, DDL, validateSpool } from './spool-format.mjs';
import { limits, recordReserve, accounting, quota, projection, fileState, physicalCause, MAX_FILE_BYTES, databaseLimits } from './spool-capacity.mjs';
import { readStorage, verifyStorage, LARGE_FILE_BYTES } from './spool-storage.mjs';
import * as maintenanceOps from './spool-maintenance.mjs';
export function syncParent(path) { const fd = openSync(dirname(path), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function same(a, b) { return a.dev === b.dev && a.ino === b.ino; }

/** Local bounded transport spool. No user responses, native commands, permissions or event history. */
export class Spool {
  constructor(c, { init = false, capacity = 10000, byteBudget = 8 * 1024 * 1024, maintenance = false } = {}) {
    c = config(c);
    const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
    this.c = freeze(c); this.path = c.spool; this.lock = `${c.spool}.lock`; this.limits = limits(capacity, byteBudget); this.capacity = capacity; this.legacyLimits=this.limits; this.fileLimit=MAX_FILE_BYTES; this.maintenance=maintenance; this.syncDirectory = syncParent;
    privateParent(this.path);
    let lockfd;
    try {
      lockfd = openSync(this.lock, 'wx', 0o600); this.lockStat = fstatSync(lockfd);
      writeSync(lockfd, JSON.stringify({ pid: process.pid, note: 'Verify this exact owner exited before removing a crash lock' })); fsyncSync(lockfd); syncParent(this.lock);
      let main;
      try { main=lstatSync(this.path); } catch(e) { if(e.code!=='ENOENT')throw e; }
      if (!main) {
        if (!init) fail('SPOOL_NOT_INITIALIZED');
        // An absent main file is not an empty namespace: SQLite may reset orphan WAL facts.
        for(const suffix of ['-wal','-shm','-journal','.storage']){
          let prior;try{prior=lstatSync(this.path+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}
          if(prior)fail('ORPHAN_SPOOL_FILES'); // no following links, opening SQLite, or creating a replacement main
        }
        const fd = openSync(this.path, 'wx', 0o600); try { fsyncSync(fd); } finally { closeSync(fd); } syncParent(this.path);
        this.isNew = true;
      } else privateStat(main);
      const initial = fileState(this.path);
      if (Object.values(initial.sizes).some(n => n > LARGE_FILE_BYTES)) fail('SPOOL_FULL');
      this.fileStat = initial.stats.main; this.storage=readStorage(c,this.fileStat);this.fileLimit=this.storage?LARGE_FILE_BYTES:MAX_FILE_BYTES;
      if (Object.values(initial.sizes).some(n => n > this.fileLimit)) fail('SPOOL_FULL');
      if (!this.isNew && this.fileStat.size === 0) fail('UNKNOWN_SPOOL');
      // Read-only validation before any WAL pragma or schema mutation of existing files.
      if (!this.isNew) {
        const read = new DatabaseSync(this.path, { readOnly: true });
        try { this.validate(read); } finally { read.close(); }
      }
      this.db = new DatabaseSync(this.path);
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=64');
      const pageSize = this.db.prepare('PRAGMA page_size').get().page_size;
      this.db.exec(`PRAGMA max_page_count=${Math.floor(this.fileLimit / pageSize)}`);
      if (this.isNew) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const sql of DDL) this.db.exec(sql);
          this.db.exec(`PRAGMA application_id=${APP}; PRAGMA user_version=1`);
          this.db.prepare('INSERT INTO meta VALUES (?,?)').run('binding', spoolBinding(c));
          this.db.prepare('INSERT INTO meta VALUES (?,?)').run('observer', canonical({ generation: 0, state: 'disconnected', reason: 'not_started' }));
          this.db.exec('COMMIT'); syncParent(this.path);
        } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
      }
      this.validate(this.db); this.refreshStorage(); this.assertFiles();
    } catch (e) {
      this.db?.close();
      if (this.lockStat && existsSync(this.lock) && same(lstatSync(this.lock), this.lockStat)) { unlinkSync(this.lock); syncParent(this.lock); }
      throw e;
    } finally { if (lockfd !== undefined) closeSync(lockfd); }
  }
  validate(db) {
    const version=validateSpool(db,this.c);verifyStorage(version,this.storage,{writing:true,maintenance:this.maintenance});
    if (db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size > this.fileLimit) fail('SPOOL_FULL');
    return version;
  }
  refreshStorage() {
    const files=fileState(this.path);if(!same(files.stats.main,this.fileStat))fail('SPOOL_PATH_CHANGED');
    this.storage=readStorage(this.c,this.fileStat);this.fileLimit=this.storage?LARGE_FILE_BYTES:MAX_FILE_BYTES;
    this.version=this.validate(this.db);this.limits=databaseLimits(this.db,this.fileLimit,this.legacyLimits);
  }
  currentLimits() { return databaseLimits(this.db,this.fileLimit,this.legacyLimits); }
  findRow(key,value) {
    if(!['seq','id'].includes(key))fail('INVALID_INPUT');
    return this.db.prepare(`SELECT * FROM queue WHERE ${key}=?`).get(value) ?? (this.version===2?this.db.prepare(`SELECT * FROM archive WHERE ${key}=?`).get(value):undefined);
  }
  assertFiles() {
    privateParent(this.path);
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`, `${this.path}-journal`, this.lock]) {
      if (!existsSync(path)) { if ([this.path, this.lock].includes(path)) fail('SPOOL_PATH_CHANGED'); else continue; }
      const s = lstatSync(path); privateStat(s);
      if ((path === this.path && !same(s, this.fileStat)) || (path === this.lock && !same(s, this.lockStat))) fail('SPOOL_PATH_CHANGED');
      if (s.size > this.fileLimit) fail('SPOOL_FULL');
    }
    const storage=readStorage(this.c,this.fileStat);
    if(Boolean(storage)!==Boolean(this.storage)||(storage&&(!same(storage.stat,this.storage.stat)||storage.value.state!==this.storage.value.state)))fail('SPOOL_PATH_CHANGED');
  }
  tx(action) {
    this.assertFiles();
    verifyStorage(this.version,this.storage,{writing:true,maintenance:this.upgrading===true});
    if (physicalCause(fileState(this.path),this.fileLimit)) fail('SPOOL_FULL');
    this.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const result = action(); this.db.exec('COMMIT'); committed = true; this.maintenanceHook?.('transaction_committed');
      this.assertFiles();
      this.syncDirectory(this.path); // covers newly created/recreated WAL directory entry before any ACK
      return result;
    } catch (e) { if (!committed) { try { this.db.exec('ROLLBACK'); } catch {} } throw e; }
  }
  insert(op, mapping = null) {
    const fp = hash(canonical(op));
    const prior = this.findRow('id',op.id);
    if (prior) { if (prior.fingerprint !== fp) fail('IDEMPOTENCY_CONFLICT'); return { state: prior.state, receipt: prior.ack ? JSON.parse(prior.ack) : null }; }
    const used = accounting(this.db, this.c);
    const bound=this.currentLimits();
    if (used.operations >= bound.operations || used.reserved_bytes + recordReserve(canonical(op.payload), mapping) > bound.reserved_bytes) fail('SPOOL_FULL');
    if(this.version===2){
      const high=this.db.prepare('SELECT max((SELECT coalesce(max(seq),0) FROM queue),(SELECT coalesce(max(seq),0) FROM archive)) AS n').get().n;
      if(!Number.isSafeInteger(high)||high>=Number.MAX_SAFE_INTEGER)fail('SEQUENCE_EXHAUSTED');
      this.db.prepare('INSERT INTO queue(seq,id,fingerprint,kind,event_id,mapping,payload,state) VALUES (?,?,?,?,?,?,?,?)').run(high+1,op.id,fp,op.kind,op.event_id??null,mapping,canonical(op.payload),'pending');
    }else this.db.prepare('INSERT INTO queue(id,fingerprint,kind,event_id,mapping,payload,state) VALUES (?,?,?,?,?,?,?)').run(op.id, fp, op.kind, op.event_id ?? null, mapping, canonical(op.payload), 'pending');
    return { state: 'connector_persisted', receipt: null };
  }
  enqueue(input) { const op = JSON.parse(JSON.stringify(operation(input))); return this.tx(() => this.insert(op)); }
  observer() { return JSON.parse(this.db.prepare("SELECT value FROM meta WHERE key='observer'").get().value); }
  setObserver(v) { this.db.prepare("UPDATE meta SET value=? WHERE key='observer'").run(canonical(v)); }
  disconnected(reason, generation) {
    this.tx(() => {
      const current = this.observer();
      if (generation !== undefined && current.generation !== generation) fail('STALE_OBSERVER');
      this.setObserver({ ...current, state: 'disconnected', reason });
    });
  }
  capacityStatus() { this.assertFiles(); return quota(this.db, this.c, this.currentLimits()); }
  beginObservation() {
    return this.tx(() => {
      if (this.capacityStatus().observation_admission !== 'accepting') fail('SPOOL_FULL');
      const generation = this.observer().generation + 1;
      if (!Number.isSafeInteger(generation)) fail('INVALID_SEQUENCE');
      this.setObserver({ generation, state: 'snapshot', reason: 'gap_current_snapshot_only' });
      return generation; // never clear old maps merely to prepare another cycle
    });
  }
  observe(key, data, watermark, generation, { snapshot = false } = {}) {
    return this.tx(() => {
      if (this.observer().generation !== generation) fail('STALE_OBSERVER');
      if (!Number.isSafeInteger(watermark) || watermark < 0) fail('INVALID_SEQUENCE');
      const selected = this.c.uniflo?.sessions.find(s => s.key === key); if (!selected) fail('UNSELECTED_SESSION');
      const marker = `snapshot_${hash(key)}`;
      const snapDone = this.db.prepare('SELECT value FROM meta WHERE key=?').get(marker)?.value === String(generation);
      const prior = this.db.prepare('SELECT * FROM maps WHERE key=?').get(key);
      if (prior && watermark < prior.watermark && (!snapshot || snapDone)) fail('SEQUENCE_ROLLBACK');
      const { observed_at: _time, ...semantic } = data;
      const digest = hash(canonical(semantic));
      if (!prior || prior.digest !== digest) {
        const rid = randomUUID();
        const ref = `uniflo_${hash(`${spoolBinding(this.c)}\n${key}`)}`;
        const op = prior ? { id: rid, kind: 'update', payload: { update_id: rid, kind: 'progress', body: canonical(data) } } : {
          id: rid, kind: 'create', payload: { request_id: rid, title: `${selected.alias} · 只读观察`, body: canonical(data), session_ref: ref, target_revision: 'readonly_1', expires_at: '2099-01-01T00:00:00Z' },
        };
        this.insert(op, key);
      }
      this.db.prepare('INSERT INTO maps VALUES (?,NULL,0,?,?) ON CONFLICT(key) DO UPDATE SET digest=excluded.digest,watermark=excluded.watermark').run(key, digest, watermark);
      if (snapshot) this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(marker, String(generation));
      this.setObserver({ generation, state: 'observing', reason: 'current_metadata_only' });
    });
  }
  prepare() {
    return this.tx(() => {
      const row = this.db.prepare("SELECT * FROM queue WHERE state!='saved' ORDER BY seq LIMIT 1").get();
      const barrier=this.version===2?this.db.prepare("SELECT seq FROM archive WHERE state='blocked' ORDER BY seq LIMIT 1").get():null;
      if(barrier&&(!row||barrier.seq<row.seq))fail('QUEUE_BLOCKED');
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
      const current = this.findRow('seq',row.seq);
      if (!current || current.wire !== row.wire || current.event_id !== row.event_id || current.mapping !== row.mapping) fail('RECEIPT_ROW_MISMATCH');
      if (current.state === 'saved') {
        if (current.ack !== canonical(ack)) fail('RECEIPT_CONFLICT');
        return; // original duplicate ACK is history, never permission to overwrite a later mapping
      }
      if (current.state !== 'unknown') fail('RECEIPT_ROW_MISMATCH');
      const result = this.db.prepare("UPDATE queue SET state='saved',ack=?,error=NULL WHERE seq=? AND state='unknown'").run(canonical(ack), row.seq);
      if (result.changes !== 1) fail('RECEIPT_ROW_MISMATCH');
      if (row.mapping) this.db.prepare('UPDATE maps SET event_id=?,version=? WHERE key=?').run(ack.event_id, ack.event_version, row.mapping);
    });
  }
  blocked(row,code) {
    this.tx(()=>{
      const current=this.findRow('seq',row.seq);
      if(!current||current.wire!==row.wire||current.event_id!==row.event_id)fail('RECEIPT_ROW_MISMATCH');
      if(current.state==='blocked'&&current.error===code)return;
      if(current.state!=='unknown')fail('RECEIPT_ROW_MISMATCH');
      this.db.prepare("UPDATE queue SET state='blocked',error=? WHERE seq=? AND state='unknown'").run(code,row.seq);
    });
  }
  upgrade() { const prior=this.maintenance;this.maintenance=true;this.upgrading=true;try{return maintenanceOps.upgrade(this);}finally{this.maintenance=prior;this.upgrading=false;} }
  resize(input) { return maintenanceOps.resize(this,input); }
  archive(input) { return maintenanceOps.archive(this,input); }
  archivePlan(input) { return maintenanceOps.planArchive(this.db,this.c,this.currentLimits(),input,{ready:this.storage?.value.state==='ready'}); }
  status() {
    this.assertFiles(); this.syncDirectory(this.path);
    return projection(this.db, this.c, this.currentLimits());
  }
  close() {
    if (!this.closed) { this.db?.close(); this.closed = true; }
    if (this.lockStat && existsSync(this.lock) && same(lstatSync(this.lock), this.lockStat)) { unlinkSync(this.lock); syncParent(this.lock); this.lockStat = undefined; }
  }
}
