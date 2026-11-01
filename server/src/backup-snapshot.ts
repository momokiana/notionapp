import type Database from 'better-sqlite3';
import { ApiError } from './auth.js';

/** Backup backpressure, not the authority/ledger's general storage capacity. */
export const MAX_BACKUP_DATABASE_BYTES = 32 * 1024 * 1024;

/** Caller holds the actual cross-store IMMEDIATE window; no async backup or bare main-file copy. */
export function serializeBackupDatabase(db: Database.Database, maxBytes = MAX_BACKUP_DATABASE_BYTES): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BACKUP_DATABASE_BYTES || !db.inTransaction) {
    throw new ApiError(503, 'BACKUP_SNAPSHOT_LOCK_REQUIRED', 'A bounded synchronous snapshot transaction is required');
  }
  const pages: unknown = db.pragma('page_count', { simple: true });
  const size: unknown = db.pragma('page_size', { simple: true });
  if (typeof pages !== 'number' || typeof size !== 'number' || !Number.isSafeInteger(pages) || pages < 1
    || !Number.isSafeInteger(size) || size < 512 || !Number.isSafeInteger(pages * size) || pages * size > maxBytes) {
    throw new ApiError(503, 'BACKUP_DATABASE_TOO_LARGE', 'Original database exceeds the backup snapshot limit; original data retained');
  }
  const image = db.serialize();
  if (!Buffer.isBuffer(image) || image.length !== pages * size || image.length > maxBytes) {
    throw new ApiError(503, 'BACKUP_SNAPSHOT_CHANGED', 'Snapshot size changed; no backup completion acknowledged');
  }
  return image;
}
