import Database from 'better-sqlite3';
import { ApiError } from './auth.js';
import { APP_ID, ledgerDdl, commandDdl, schemaVersion } from './schema.js';
import { notificationDdl } from './notifications.js';

interface SchemaObject { type: string; name: string; tbl_name: string; sql: string | null }
const catalog = (db: Database.Database) => (db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all() as SchemaObject[])
  .map(row => ({ ...row, sql: row.sql === null ? null : row.sql.replace(/\s+/g, ' ').trim().replace(/;$/, '') }));
const invalid = (): never => { throw new ApiError(503, 'BACKUP_DATABASE_INVALID', 'Snapshot database is invalid; no initialization or migration performed'); };

/** Only trusted built-in DDL is used in a fresh memory reference, never archive SQL. No mutation of the inspected database. */
export function assertSnapshotCatalog(db: Database.Database, ddl: readonly string[], appId: number, version: number): void {
  if (db.pragma('application_id', { simple: true }) !== appId || db.pragma('user_version', { simple: true }) !== version) invalid();
  const reference = new Database(':memory:');
  try {
    for (const sql of ddl) reference.exec(sql);
    // Compare the entire catalog, including generated autoindexes and sqlite_sequence: do not broadly exempt sqlite_* names.
    if (JSON.stringify(catalog(db)) !== JSON.stringify(catalog(reference))) invalid();
  } finally { reference.close(); }
  const foreignKeys: unknown = db.pragma('foreign_key_check');
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || !Array.isArray(foreignKeys) || foreignKeys.length !== 0) invalid();
}

/** Caller-designated private read-only image. Inspect/stage use derived scratch only; capture may preflight its original ledger. Never an archived IO path. No writable pragma or migration. */
export function withReadOnlyBackupImage<T>(path: string, inspect: (db: Database.Database) => T): T {
  if (inspect.constructor.name === 'AsyncFunction') invalid();
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma('trusted_schema=OFF'); db.pragma('query_only=ON'); db.exec('BEGIN');
    const result = inspect(db);
    if (result && typeof (result as { then?: unknown }).then === 'function') invalid();
    return result;
  } finally { try { if (db.inTransaction) db.exec('ROLLBACK'); } finally { db.close(); } }
}

/** Strict current v3 only. initializeSchema/CoreStore are intentionally not called on restored material. */
export function assertLedgerBackupDatabase(db: Database.Database): void {
  assertSnapshotCatalog(db, [...ledgerDdl, commandDdl, ...notificationDdl], APP_ID, schemaVersion);
}
