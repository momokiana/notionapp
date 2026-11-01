import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { validId } from 'notification-server/auth';
import { canonical, HostError, record, requireHost } from './private-files.js';
import { thinkingLevels, type ModelSelection } from './identity.js';
import { modelBudget, type ModelBudget } from './model-budget.js';
import type { Binding } from './config.js';

export const MAX_BACKUP_RECORD_BYTES = 128 * 1024 * 1024;
export const MAX_BACKUP_METADATA_BYTES = 64 * 1024;
const HEADER = 28;
const TAG = 16;
const MAGIC = Buffer.from('NTAPPBKP', 'ascii');
export const MAX_BACKUP_ARCHIVE_BYTES = HEADER + TAG + 4 + MAX_BACKUP_METADATA_BYTES + MAX_BACKUP_RECORD_BYTES;
export const backupRecordNames = ['config', 'registry', 'initial-prompt', 'system-prompt', 'manifest', 'native', 'ledger', 'device-authority', 'source-pump', 'initializing'] as const;
export type BackupRecordName = typeof backupRecordNames[number];
const requiredRecords: readonly BackupRecordName[] = ['config', 'registry', 'initial-prompt', 'manifest', 'native', 'ledger'];
const materialMagic = Buffer.from('NOTIFIER_RECOVERY_MATERIAL_1\0', 'ascii');
const metadataMagic = Buffer.from('NOTIFIER_RECOVERY_METADATA_1\0', 'ascii');
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export const backupHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const exact = (v: unknown, fields: string[]): v is Record<string, unknown> => record(v) && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const valid = (condition: unknown) => requireHost(condition, 'INVALID_BACKUP_ARCHIVE');

/** Original capture evidence, not a current identity/credential/permission validation. No system prompt or external model auth here. */
export interface BackupSelection {
  source: Binding; model: ModelSelection; model_budget: ModelBudget;
  identity_fingerprint: string | null; system_prompt_sha256: string;
}
export interface BackupRecord { name: BackupRecordName; bytes: Buffer }
export interface BackupRecordSummary { name: BackupRecordName; bytes: number; sha256: string }
export interface BackupMetadata {
  format: 1; snapshot_id: string; captured_at: string; origin_config_file: string; binding_hash: string; native_id: string;
  selection: BackupSelection; records: BackupRecordSummary[];
}
export interface BackupMaterial { metadata: BackupMetadata; records: BackupRecord[] }
export type BackupCaptureMetadata = Omit<BackupMetadata, 'format' | 'records'>;

function recordLimit(name: BackupRecordName) {
  if (name === 'native') return 64 * 1024 * 1024;
  if (name === 'ledger' || name === 'device-authority') return 32 * 1024 * 1024;
  // Existing private config/registry/pump helpers are bounded; never accept arbitrary directory contents.
  return name === 'registry' ? 8 * 1024 * 1024 : 64 * 1024;
}
function selection(value: unknown): asserts value is BackupSelection {
  valid(exact(value, ['source', 'model', 'model_budget', 'identity_fingerprint', 'system_prompt_sha256']));
  const v = value as Record<string, unknown>;
  valid(exact(v.source, ['owner_id', 'principal_id', 'source_id', 'source_epoch']) && Object.values(v.source).every(validId));
  valid(exact(v.model, ['provider', 'id', 'thinking']));
  const m = v.model as Record<string, unknown>;
  valid([m.provider, m.id].every(s => typeof s === 'string' && s.trim() && [...s].length <= 200 && !/[\u0000-\u001f\u007f]/u.test(s))
    && thinkingLevels.includes(m.thinking as typeof thinkingLevels[number]));
  valid(record(v.model_budget));
  try { valid(canonical(modelBudget(v.model_budget)) === canonical(v.model_budget)); } catch { throw new HostError('INVALID_BACKUP_ARCHIVE'); }
  valid((v.identity_fingerprint === null || hex(v.identity_fingerprint)) && hex(v.system_prompt_sha256));
}
function metadata(value: unknown): asserts value is BackupMetadata {
  valid(exact(value, ['format', 'snapshot_id', 'captured_at', 'origin_config_file', 'binding_hash', 'native_id', 'selection', 'records']));
  const v = value as Record<string, unknown>;
  valid(v.format === 1 && uuid(v.snapshot_id) && uuid(v.native_id) && hex(v.binding_hash));
  valid(typeof v.origin_config_file === 'string' && isAbsolute(v.origin_config_file) && resolve(v.origin_config_file) === v.origin_config_file);
  valid(typeof v.captured_at === 'string' && v.captured_at.length <= 35 && Number.isFinite(Date.parse(v.captured_at))
    && new Date(v.captured_at as string).toISOString() === v.captured_at);
  selection(v.selection);
  valid(Array.isArray(v.records) && v.records.length >= requiredRecords.length && v.records.length <= backupRecordNames.length);
  const records = v.records as unknown[]; const seen = new Set<string>(); let total = 0;
  for (const item of records) {
    valid(exact(item, ['name', 'bytes', 'sha256'])); const r = item as Record<string, unknown>;
    valid(typeof r.name === 'string' && backupRecordNames.includes(r.name as BackupRecordName) && !seen.has(r.name));
    seen.add(r.name as string);
    valid(typeof r.bytes === 'number' && Number.isSafeInteger(r.bytes) && r.bytes >= 1 && r.bytes <= recordLimit(r.name as BackupRecordName) && hex(r.sha256));
    total += r.bytes as number; valid(Number.isSafeInteger(total) && total <= MAX_BACKUP_RECORD_BYTES);
  }
  valid(requiredRecords.every(name => seen.has(name)));
}

/** Envelope codec only. Callers must also validate SQLite/Native/config/journal semantics before reporting material verified. */
export function sealBackupArchive(capture: BackupCaptureMetadata, records: BackupRecord[], key: Buffer): Buffer {
  requireHost(Buffer.isBuffer(key) && key.length === 32, 'BACKUP_KEY_INVALID');
  const meta = { format: 1 as const, ...capture, records: records.map(r => ({ name: r.name, bytes: r.bytes.length, sha256: backupHash(r.bytes) })) };
  metadata(meta);
  const json = Buffer.from(JSON.stringify(meta), 'utf8'); valid(json.length <= MAX_BACKUP_METADATA_BYTES);
  requireHost(!json.includes(key) && records.every(r => !r.bytes.includes(key)), 'BACKUP_KEY_INCLUDED_IN_SOURCE');
  const length = 4 + json.length + records.reduce((n, r) => n + r.bytes.length, 0);
  valid(length <= MAX_BACKUP_ARCHIVE_BYTES - HEADER - TAG);
  const plaintext = Buffer.alloc(length); plaintext.writeUInt32BE(json.length, 0); json.copy(plaintext, 4);
  let offset = 4 + json.length;
  for (const r of records) { r.bytes.copy(plaintext, offset); offset += r.bytes.length; }
  const header = Buffer.alloc(HEADER); MAGIC.copy(header); header.writeUInt32BE(1, 8); header.writeUInt32BE(plaintext.length, 12); randomBytes(12).copy(header, 16);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, header.subarray(16), { authTagLength: TAG }); cipher.setAAD(header);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([header, encrypted, cipher.getAuthTag()]);
  } finally { plaintext.fill(0); }
}

/** No plaintext parser, stage/scratch write or semantic validator runs before GCM.final authenticates the complete envelope. */
export function openBackupArchive(archive: Buffer, key: Buffer): BackupMaterial {
  requireHost(Buffer.isBuffer(key) && key.length === 32, 'BACKUP_KEY_INVALID');
  valid(Buffer.isBuffer(archive) && archive.length >= HEADER + TAG + 4 && archive.length <= MAX_BACKUP_ARCHIVE_BYTES);
  const header = archive.subarray(0, HEADER);
  valid(header.subarray(0, 8).equals(MAGIC) && header.readUInt32BE(8) === 1 && header.readUInt32BE(12) === archive.length - HEADER - TAG);
  let first: Buffer | undefined; let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(16), { authTagLength: TAG }); decipher.setAAD(header); decipher.setAuthTag(archive.subarray(-TAG));
    first = decipher.update(archive.subarray(HEADER, -TAG));
    plaintext = Buffer.concat([first, decipher.final()]);
  } catch { throw new HostError('BACKUP_AUTHENTICATION_FAILED'); }
  finally { first?.fill(0); }
  try {
    requireHost(!plaintext.includes(key), 'BACKUP_KEY_INCLUDED_IN_SOURCE');
    valid(plaintext.length >= 4); const size = plaintext.readUInt32BE(0);
    valid(size >= 2 && size <= MAX_BACKUP_METADATA_BYTES && 4 + size <= plaintext.length);
    let meta: unknown;
    try { meta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext.subarray(4, 4 + size))); }
    catch { throw new HostError('INVALID_BACKUP_ARCHIVE'); }
    metadata(meta);
    valid(Buffer.from(JSON.stringify(meta), 'utf8').equals(plaintext.subarray(4, 4 + size))); // Reject duplicate keys/noncanonical metadata, not just last-key-wins parsing.
    const records: BackupRecord[] = []; let offset = 4 + size;
    // Check the whole authenticated record layout and hashes before returning any material.
    for (const r of meta.records) {
      valid(offset + r.bytes <= plaintext.length);
      const bytes = plaintext.subarray(offset, offset + r.bytes); valid(backupHash(bytes) === r.sha256); offset += r.bytes;
    }
    valid(offset === plaintext.length); offset = 4 + size;
    for (const r of meta.records) { records.push({ name: r.name, bytes: Buffer.from(plaintext.subarray(offset, offset + r.bytes)) }); offset += r.bytes; }
    return { metadata: meta, records };
  } finally { plaintext.fill(0); }
}

export function frameBackupMetadata(value: BackupMetadata): Buffer {
  metadata(value); const bytes = Buffer.from(JSON.stringify(value), 'utf8'); valid(bytes.length <= MAX_BACKUP_METADATA_BYTES);
  return Buffer.concat([metadataMagic, bytes]);
}
export function unframeBackupMetadata(frame: Buffer): BackupMetadata {
  valid(frame.length > metadataMagic.length && frame.length <= metadataMagic.length + MAX_BACKUP_METADATA_BYTES && frame.subarray(0, metadataMagic.length).equals(metadataMagic));
  try {
    const bytes = frame.subarray(metadataMagic.length); const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    metadata(value); valid(Buffer.from(JSON.stringify(value), 'utf8').equals(bytes)); return value;
  } catch { throw new HostError('INVALID_BACKUP_ARCHIVE'); }
}

/** Inert stage records are neither JSON, SQLite images nor SDK JSONL. Manual stripping is not a sandbox boundary. */
export function frameBackupRecord(r: BackupRecord): Buffer {
  valid(backupRecordNames.includes(r.name) && r.bytes.length >= 1 && r.bytes.length <= recordLimit(r.name));
  const name = Buffer.from(r.name, 'ascii'); const length = Buffer.alloc(5); length.writeUInt8(name.length, 0); length.writeUInt32BE(r.bytes.length, 1);
  return Buffer.concat([materialMagic, length, name, r.bytes]);
}
export function unframeBackupRecord(frame: Buffer): BackupRecord {
  valid(frame.length >= materialMagic.length + 6 && frame.subarray(0, materialMagic.length).equals(materialMagic));
  const nameSize = frame.readUInt8(materialMagic.length); const size = frame.readUInt32BE(materialMagic.length + 1); const start = materialMagic.length + 5;
  valid(nameSize >= 1 && nameSize <= 32 && start + nameSize + size === frame.length);
  const name = frame.subarray(start, start + nameSize).toString('ascii') as BackupRecordName;
  valid(backupRecordNames.includes(name) && Buffer.from(name, 'ascii').equals(frame.subarray(start, start + nameSize)) && size >= 1 && size <= recordLimit(name));
  return { name, bytes: Buffer.from(frame.subarray(start + nameSize)) };
}
