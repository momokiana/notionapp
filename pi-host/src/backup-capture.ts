import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_BACKUP_DATABASE_BYTES, serializeBackupDatabase } from 'notification-server/backup-snapshot';
import { assertLedgerBackupDatabase, withReadOnlyBackupImage } from 'notification-server/backup-validation';
import { loadConfig } from './config.js';
import { AppRuntime } from './runtime.js';
import {assertConfigNotRecovering} from './recovery-admission.js';
import { MAX_NATIVE_BYTES } from './native.js';
import { MAX_BACKUP_RECORD_BYTES, backupHash, type BackupCaptureMetadata, type BackupMaterial, type BackupMetadata, type BackupRecord, type BackupRecordName } from './backup-format.js';
import { readBackupFile, type BackupFileRead } from './backup-files.js';
import { canonical, noSymlinks, privateDirectory, record, requireHost } from './private-files.js';

function optional(path: string) {
  noSymlinks(path);
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function identity(path: string) {
  noSymlinks(path);
  try { const s = lstatSync(path); return { dev: s.dev, ino: s.ino }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function unchanged(a: BackupFileRead, b: BackupFileRead) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime && backupHash(a.bytes) === backupHash(b.bytes);
}

function rejectCredentialRoleOverlap(configFile: string, bytes: Buffer) {
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  requireHost(record(raw) && typeof raw.data_dir === 'string', 'INVALID_CONFIG');
  const reference = record(raw.identity_reference) ? raw.identity_reference : undefined;
  const credential = reference && typeof reference.credentials_file === 'string' ? reference.credentials_file : join(raw.data_dir, 'agent/auth.json');
  const credentialIdentity = identity(credential);
  const reads = [configFile, raw.auth_file, raw.initial_prompt_file, raw.system_prompt_file, record(raw.push) ? raw.push.token_file : undefined, reference?.persona_file, reference?.settings_file];
  for (const path of reads) if (typeof path === 'string') {
    const current = identity(path);
    requireHost(path !== credential && (!current || !credentialIdentity || current.dev !== credentialIdentity.dev || current.ino !== credentialIdentity.ino), 'BACKUP_EXTERNAL_REFERENCE_OVERLAP');
  }
}

/** No listen/tick/consumer/Agent. Operator must separately quiesce supported maintenance/static writers; hashes are not arbitrary-editor CAS. */
export async function captureBackupMaterial(configFile: string, writersQuiesced: boolean): Promise<BackupMaterial> {
  requireHost(writersQuiesced === true, 'BACKUP_WRITERS_MUST_BE_QUIESCED');
  assertConfigNotRecovering(configFile);
  const configRead = readBackupFile(configFile, 65536); rejectCredentialRoleOverlap(configFile, configRead.bytes); const config = loadConfig(configFile);
  privateDirectory(config.data_dir); readBackupFile(join(config.data_dir, 'manifest.json'), 65536);
  const originalLedger = join(config.data_dir, 'ledger.sqlite'); noSymlinks(originalLedger);
  const ledgerStat = lstatSync(originalLedger);
  requireHost(ledgerStat.isFile() && ledgerStat.uid === process.getuid?.() && (ledgerStat.mode & 0o077) === 0, 'ORIGINAL_LEDGER_REQUIRED');
  // Do not let a writable admission pragma change a foreign DELETE-mode database before rejecting its schema.
  withReadOnlyBackupImage(originalLedger, db => {
    const pages: unknown = db.pragma('page_count', { simple: true }); const size: unknown = db.pragma('page_size', { simple: true });
    requireHost(typeof pages === 'number' && typeof size === 'number' && Number.isSafeInteger(pages * size) && pages >= 1 && size >= 512 && pages * size <= MAX_BACKUP_DATABASE_BYTES, 'BACKUP_DATABASE_TOO_LARGE');
    assertLedgerBackupDatabase(db);
  });
  const runtime = await AppRuntime.open(config, { sourcePaused: true });
  try {
    const id = randomUUID();
    const capture = (readAuthority?: (maxBytes?: number) => Buffer) => runtime.native.database.transaction(() => {
      runtime.currentAuthority(); runtime.native.assertParity();
      // Revalidate references without selected-model credential content/Agent admission. Never archive those external files.
      const checkedConfig = readBackupFile(configFile, 65536);
      requireHost(unchanged(configRead, checkedConfig), 'BACKUP_INPUT_CHANGED'); rejectCredentialRoleOverlap(configFile, checkedConfig.bytes);
      const confirmed = loadConfig(configFile);
      requireHost(canonical(confirmed) === canonical(config), 'BACKUP_INPUT_CHANGED');
      const paths: { name: BackupRecordName; path: string; limit: number; optional: boolean }[] = [
        { name: 'config', path: configFile, limit: 65536, optional: false },
        { name: 'registry', path: config.auth_file, limit: 8 * 1024 * 1024, optional: false },
        { name: 'initial-prompt', path: config.initial_prompt_file, limit: 65536, optional: false },
        { name: 'manifest', path: join(config.data_dir, 'manifest.json'), limit: 65536, optional: false },
        { name: 'native', path: runtime.native.manifest.session_file, limit: MAX_NATIVE_BYTES, optional: false },
        { name: 'initializing', path: join(config.data_dir, 'initializing.json'), limit: 65536, optional: true },
        { name: 'source-pump', path: join(config.data_dir, 'source-pump.json'), limit: 4096, optional: true },
        ...(config.system_prompt_file ? [{ name: 'system-prompt' as const, path: config.system_prompt_file, limit: 65536, optional: false }] : []),
      ];
      const rawConfig = JSON.parse(configRead.bytes.toString('utf8')) as { push?: { token_file?: string } };
      const forbidden = [join(config.data_dir, 'agent/auth.json'), join(config.data_dir, 'agent/models.json'), join(config.data_dir, 'agent/models-store.json'),
        ...(config.identity_reference ? [config.identity_reference.persona_file, config.identity_reference.settings_file, config.identity_reference.credentials_file] : []),
        ...(rawConfig.push?.token_file ? [rawConfig.push.token_file] : [])].map(path => ({ path, identity: identity(path) }));
      let total = 0;
      const remaining = (maximum: number) => {
        requireHost(total < MAX_BACKUP_RECORD_BYTES, 'BACKUP_MATERIAL_TOO_LARGE');
        return Math.min(maximum, MAX_BACKUP_RECORD_BYTES - total);
      };
      const reads = paths.map(value => {
        const present = !value.optional || optional(value.path);
        if (!present) return { ...value, read: null };
        const source = identity(value.path);
        requireHost(forbidden.every(f => f.path !== value.path && (!source || !f.identity || source.dev !== f.identity.dev || source.ino !== f.identity.ino)), 'BACKUP_EXTERNAL_REFERENCE_OVERLAP');
        const read = readBackupFile(value.path, remaining(value.limit)); total += read.bytes.length;
        return { ...value, read };
      });
      const capturedConfig = reads.find(r => r.name === 'config')!.read!;
      requireHost(unchanged(configRead, capturedConfig), 'BACKUP_INPUT_CHANGED');
      // Both images are produced only after authority (when present) AND ledger IMMEDIATE are held.
      const records: BackupRecord[] = reads.flatMap(r => r.read ? [{ name: r.name, bytes: r.read.bytes }] : []);
      if (readAuthority) {
        const bytes = readAuthority(remaining(MAX_BACKUP_DATABASE_BYTES)); total += bytes.length;
        records.push({ name: 'device-authority', bytes });
      }
      const ledger = serializeBackupDatabase(runtime.native.database, remaining(MAX_BACKUP_DATABASE_BYTES)); total += ledger.length;
      records.push({ name: 'ledger', bytes: ledger });
      runtime.currentAuthority(); runtime.native.assertParity();
      for (const r of reads) {
        if (r.read) requireHost(unchanged(r.read, readBackupFile(r.path, r.limit)), 'BACKUP_INPUT_CHANGED');
        else requireHost(!optional(r.path), 'BACKUP_INPUT_CHANGED');
      }
      const evidence: BackupCaptureMetadata = { snapshot_id: id, captured_at: new Date().toISOString(), origin_config_file: configFile, binding_hash: config.bindingHash,
        native_id: runtime.native.manifest.native_id, selection: { source: { ...config.source }, model: { ...config.model }, model_budget: structuredClone(config.model_budget),
          identity_fingerprint: config.identity?.fingerprint ?? null, system_prompt_sha256: backupHash(Buffer.from(config.systemPrompt, 'utf8')) } };
      const metadata: BackupMetadata = { format: 1, ...evidence, records: records.map(r => ({ name: r.name, bytes: r.bytes.length, sha256: backupHash(r.bytes) })) };
      return { metadata, records };
    }).immediate();
    return runtime.deviceAuthority ? runtime.deviceAuthority.store.withBackupSnapshot(read => capture(read)) : capture();
  } finally { await runtime.close(); }
}
