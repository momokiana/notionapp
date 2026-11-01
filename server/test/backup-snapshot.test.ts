import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, chmodSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { ApiError } from '../src/auth.js';
import { DeviceStore } from '../src/device-store.js';
import { serializeBackupDatabase } from '../src/backup-snapshot.js';

const code = (expected: string) => (e: unknown) => e instanceof ApiError && e.code === expected;
const root = () => { const p = mkdtempSync(join(tmpdir(), 'notifier-backup-snapshot-')); chmodSync(p, 0o700); return p; };
const modulePath = createRequire(import.meta.url).resolve('better-sqlite3');

function populated() {
  const dir = root(); const path = join(dir, 'authority.sqlite'); const id = DeviceStore.initialize(path).store_id;
  const store = new DeviceStore(path, id); const invitation = randomUUID(); const secret = randomBytes(32).toString('hex'); const token = randomBytes(32).toString('hex');
  store.createInvitation('operator', { request_id: invitation, invitation_id: invitation, secret, owner_id: 'owner', label: 'Synthetic backup phone', manage_devices: false, expires_at: Date.now() + 60000 });
  const claim = store.claim({ invitation_id: invitation, secret, token, claim_id: randomUUID() }, () => {});
  return { dir, path, id, store, claim };
}

test('managed backup image contains committed WAL facts and cannot be read through an escaped lock-window lease', t => {
  const f = populated(); t.after(() => f.store.close());
  // Hold an old reader so a later committed row really remains in WAL.
  const old = new Database(f.path, { readonly: true }); t.after(() => old.close()); old.exec('BEGIN'); old.prepare('SELECT count(*) FROM devices').get();
  f.store.operatorRevoke('owner', f.claim.device_id, randomUUID());
  const before = readFileSync(f.path); let escaped!: () => Buffer;
  const bytes = f.store.withBackupSnapshot(read => { escaped = read; return read(); });
  assert.throws(() => escaped(), code('BACKUP_SNAPSHOT_LOCK_REQUIRED'));
  assert.deepEqual(readFileSync(f.path), before);
  const snapshot = join(f.dir, 'snapshot.sqlite'); writeFileSync(snapshot, bytes, { mode: 0o600 });
  const db = new Database(snapshot, { readonly: true, fileMustExist: true }); t.after(() => db.close()); db.pragma('query_only=ON');
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal((db.prepare('SELECT state FROM devices WHERE id=?').get(f.claim.device_id) as { state: string }).state, 'revoked');
  assert.equal((db.prepare('SELECT id FROM authority').get() as { id: string }).id, f.id);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
});

test('managed backup uses original authority then ledger lock window; independent writers cannot mutate either capture', t => {
  const f = populated(); t.after(() => f.store.close());
  const ledgerPath = join(f.dir, 'isolated-ledger.sqlite'); const ledger = new Database(ledgerPath); t.after(() => ledger.close());
  ledger.pragma('journal_mode=WAL'); ledger.exec('CREATE TABLE synthetic_fact(id INTEGER PRIMARY KEY); INSERT INTO synthetic_fact VALUES(1)');
  const images = f.store.withBackupSnapshot(readAuthority => ledger.transaction(() => {
    const child = spawnSync(process.execPath, ['--input-type=commonjs', '-e', `const D=require(${JSON.stringify(modulePath)}); const results=[]; for(const p of process.argv.slice(1)){const db=new D(p);db.pragma('busy_timeout=0');try{db.exec('BEGIN IMMEDIATE');results.push('unexpected_writer');db.exec('ROLLBACK')}catch(e){results.push(e.code)}finally{db.close()}} console.log(JSON.stringify(results))`, f.path, ledgerPath], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), ['SQLITE_BUSY', 'SQLITE_BUSY']);
    return { authority: readAuthority(), ledger: serializeBackupDatabase(ledger) };
  }).immediate());
  assert.ok(images.authority.length >= 4096 && images.ledger.length >= 4096);
  const independent = new Database(f.path); t.after(() => independent.close()); independent.pragma('busy_timeout=0'); independent.exec('BEGIN IMMEDIATE'); independent.exec('ROLLBACK');
});

test('snapshot refuses async capture before invoking it, rejects thenables and releases authority on every failure', t => {
  const f = populated(); t.after(() => f.store.close()); let effects = 0;
  assert.throws(() => f.store.withBackupSnapshot(async read => { effects++; return read(); }), code('ASYNC_BACKUP_CAPTURE_FORBIDDEN'));
  assert.equal(effects, 0);
  assert.throws(() => f.store.withBackupSnapshot(() => ({ then() {} })), code('ASYNC_AUTHORITY_GATE_FORBIDDEN'));
  assert.throws(() => f.store.withBackupSnapshot(() => { throw new ApiError(503, 'SYNTHETIC_CAPTURE_FAILED', 'No private data'); }), code('SYNTHETIC_CAPTURE_FAILED'));
  const independent = new Database(f.path); t.after(() => independent.close()); independent.pragma('busy_timeout=0'); independent.exec('BEGIN IMMEDIATE'); independent.exec('ROLLBACK');
  assert.equal(f.store.list('owner').length, 1);
});

test('bounded snapshot refuses absence of transaction or oversized pages before allocating serialization', t => {
  const dir = root(); const db = new Database(join(dir, 'synthetic.sqlite')); t.after(() => db.close()); db.exec('CREATE TABLE synthetic_fact(id INTEGER)');
  assert.throws(() => serializeBackupDatabase(db), code('BACKUP_SNAPSHOT_LOCK_REQUIRED'));
  const original = db.serialize; let calls = 0; db.serialize = () => { calls++; return original.call(db); };
  db.transaction(() => { assert.throws(() => serializeBackupDatabase(db, 4096), code('BACKUP_DATABASE_TOO_LARGE')); }).immediate();
  assert.equal(calls, 0); assert.equal(db.inTransaction, false);
});
