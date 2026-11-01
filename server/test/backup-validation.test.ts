import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema } from '../src/schema.js';
import { assertLedgerBackupDatabase, withReadOnlyBackupImage } from '../src/backup-validation.js';
import { assertDeviceBackupDatabase, DeviceStore } from '../src/device-store.js';

const create = () => { const db = new Database(':memory:'); initializeSchema(db); return db; };

test('backup validates exact current ledger without constructing or mutating CoreStore', t => {
  const db = create(); t.after(() => db.close()); db.pragma('query_only=ON');
  const before = db.serialize(); assertLedgerBackupDatabase(db); assert.deepEqual(db.serialize(), before);
  assert.equal((db.prepare('SELECT count(*) n FROM operations').get() as { n: number }).n, 0);
});

test('empty, legacy and extra-table/trigger snapshot schemas are never repaired or migrated', () => {
  for (const variant of ['empty','legacy','table','trigger']) {
    const db = variant === 'empty' ? new Database(':memory:') : create();
    try {
      if (variant === 'legacy') db.pragma('user_version=2');
      if (variant === 'table') db.exec('CREATE TABLE unexpected_backup_fact(value TEXT)');
      if (variant === 'trigger') db.exec('CREATE TRIGGER unexpected_backup_effect AFTER INSERT ON events BEGIN SELECT 1; END');
      db.pragma('query_only=ON'); const before = variant === 'empty' ? null : Buffer.from(db.serialize()); const version = db.pragma('user_version', { simple: true });
      assert.throws(() => assertLedgerBackupDatabase(db)); assert.equal(db.pragma('user_version', { simple: true }),version);
      if (before) assert.deepEqual(db.serialize(), before);
      else assert.equal((db.prepare('SELECT count(*) n FROM sqlite_schema').get() as { n: number }).n, 0);
    } finally { db.close(); }
  }
});

test('integrity and matching DDL do not hide foreign-key violations in snapshot data', t => {
  const db = create(); t.after(() => db.close()); db.pragma('foreign_keys=OFF');
  db.exec("INSERT INTO history(event_id,kind,data,created_at) VALUES('absent_event','response_saved','{}','synthetic')");
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); db.pragma('query_only=ON');
  assert.throws(() => assertLedgerBackupDatabase(db));
});

test('derived image callbacks are synchronous and read-only, and their connection always closes', t => {
  const root = mkdtempSync(join(tmpdir(), 'notifier-backup-derived-')); chmodSync(root,0o700); const path = join(root,'derived.sqlite');
  const source = create(); t.after(() => source.close()); writeFileSync(path,source.serialize(),{mode:0o600}); const before=readFileSync(path); let escaped!: Database.Database;
  const value=withReadOnlyBackupImage(path,db=>{escaped=db;assertLedgerBackupDatabase(db);assert.throws(()=>db.exec("INSERT INTO operations VALUES('x','x','x','x')"));return 1;});
  assert.equal(value,1);assert.equal(escaped.open,false);assert.deepEqual(readFileSync(path),before);
  assert.throws(()=>withReadOnlyBackupImage('/no-config-or-original-path',async()=>1));
  assert.throws(()=>withReadOnlyBackupImage(path,()=>{throw new Error('synthetic validator failure');}));
});

test('managed image validator checks exact store/schema read-only without opening DeviceStore or adopting another ID', t => {
  const root = mkdtempSync(join(tmpdir(), 'notifier-backup-validation-')); chmodSync(root,0o700); const path = join(root,'authority.sqlite'); const id = DeviceStore.initialize(path).store_id;
  const db = new Database(path,{readonly:true,fileMustExist:true}); t.after(() => db.close()); db.pragma('query_only=ON');
  const before = readFileSync(path); assertDeviceBackupDatabase(db,id); assert.throws(() => assertDeviceBackupDatabase(db,randomUUID())); assert.deepEqual(readFileSync(path),before);
});
