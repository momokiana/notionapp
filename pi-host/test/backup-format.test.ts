import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { sealBackupArchive, openBackupArchive, frameBackupRecord, unframeBackupRecord, backupHash, type BackupCaptureMetadata, type BackupRecord } from '../src/backup-format.js';
import { modelBudget } from '../src/model-budget.js';
import { HostError } from '../src/private-files.js';

const marker = 'PRIVATE_SYNTHETIC_BACKUP_SECRET_AND_PERSONA_NOT_FOR_PUBLIC_CLI_74b826d8';
function fixture() {
  const key = randomBytes(32);
  const capture: BackupCaptureMetadata = { snapshot_id: randomUUID(), captured_at: new Date().toISOString(), origin_config_file: '/synthetic/original/config.json', native_id: randomUUID(), binding_hash: 'a'.repeat(64),
    selection: { source: { owner_id: 'synthetic_owner', principal_id: 'synthetic_actor', source_id: 'synthetic_source', source_epoch: 'epoch_1' }, model: { provider: 'openai', id: 'gpt-4o', thinking: 'off' }, model_budget: modelBudget(undefined), identity_fingerprint: null, system_prompt_sha256: backupHash(Buffer.from(marker)) } };
  // Envelope tests only: these bodies intentionally are NOT valid SQLite/Native/config material.
  const records: BackupRecord[] = ['config','registry','initial-prompt','manifest','native','ledger'].map(name => ({ name: name as BackupRecord['name'], bytes: Buffer.from(marker + ':' + name) }));
  return { key, capture, records };
}
const rejects = (action: () => unknown, expected?: string) => assert.throws(action, e => e instanceof HostError && (!expected || e.code === expected));
function authenticated(meta: unknown, bodies: Buffer[], key: Buffer) {
  const json = Buffer.from(typeof meta === 'string' ? meta : JSON.stringify(meta)); const size = Buffer.alloc(4); size.writeUInt32BE(json.length);
  const plain = Buffer.concat([size,json,...bodies]); const header = Buffer.alloc(28); header.write('NTAPPBKP'); header.writeUInt32BE(1,8); header.writeUInt32BE(plain.length,12); randomBytes(12).copy(header,16);
  const c = createCipheriv('aes-256-gcm',key,header.subarray(16),{authTagLength:16}); c.setAAD(header);
  return Buffer.concat([header,c.update(plain),c.final(),c.getAuthTag()]);
}

test('whole authenticated envelope retains exact bounded bytes and encrypts metadata as well as content', () => {
  const f = fixture(); const keyBefore = Buffer.from(f.key); const archive = sealBackupArchive(f.capture,f.records,f.key);
  assert.equal(archive.includes(Buffer.from(marker)),false); assert.equal(archive.includes(Buffer.from('synthetic_owner')),false); assert.equal(archive.includes(Buffer.from(f.capture.native_id)),false);
  const decoded = openBackupArchive(archive,f.key); assert.deepEqual(decoded.records,f.records); assert.equal(decoded.metadata.snapshot_id,f.capture.snapshot_id); assert.deepEqual(f.key,keyBefore);
  const next = sealBackupArchive(f.capture,f.records,f.key); assert.notDeepEqual(next.subarray(16,28),archive.subarray(16,28)); assert.notDeepEqual(next,archive);
});

test('wrong key, damaged nonce/ciphertext/tag, unsupported header, truncation and trailing bytes are never material', () => {
  const f = fixture(); const archive = sealBackupArchive(f.capture,f.records,f.key);
  rejects(() => openBackupArchive(archive,randomBytes(32)), 'BACKUP_AUTHENTICATION_FAILED');
  for (const index of [16,30,archive.length-1]) { const changed = Buffer.from(archive); changed[index] = changed[index]! ^ 1; rejects(() => openBackupArchive(changed,f.key),'BACKUP_AUTHENTICATION_FAILED'); }
  for (const invalid of [archive.subarray(0,-1),archive.subarray(0,30),Buffer.concat([archive,Buffer.from([0])])]) rejects(() => openBackupArchive(invalid,f.key),'INVALID_BACKUP_ARCHIVE');
  const version = Buffer.from(archive); version.writeUInt32BE(2,8); rejects(() => openBackupArchive(version,f.key),'INVALID_BACKUP_ARCHIVE');
  for (const key of [Buffer.alloc(0),Buffer.alloc(31),Buffer.alloc(33)]) rejects(() => openBackupArchive(archive,key),'BACKUP_KEY_INVALID');
});

test('authentication does not permit duplicate/unknown records, bad hashes, oversized claims, private extra fields or duplicate JSON keys', () => {
  const f = fixture(); const decoded = openBackupArchive(sealBackupArchive(f.capture,f.records,f.key),f.key); const bodies = f.records.map(r => r.bytes);
  const invalid: unknown[] = [];
  invalid.push({...decoded.metadata, records:[...decoded.metadata.records,decoded.metadata.records[0]]});
  invalid.push({...decoded.metadata, records:decoded.metadata.records.map((r,i) => i===0 ? {...r,name:'../key'} : r)});
  invalid.push({...decoded.metadata, records:decoded.metadata.records.map((r,i) => i===0 ? {...r,sha256:'0'.repeat(64)} : r)});
  invalid.push({...decoded.metadata, records:decoded.metadata.records.map((r,i) => i===0 ? {...r,bytes:128*1024*1024+1} : r)});
  invalid.push({...decoded.metadata, private_error:marker});
  invalid.push({...decoded.metadata, selection:{...decoded.metadata.selection, model_budget:{...decoded.metadata.selection.model_budget, private_error:marker}}});
  invalid.push(JSON.stringify(decoded.metadata).replace('"format":1','"format":0,"format":1'));
  for (const value of invalid) rejects(() => openBackupArchive(authenticated(value,bodies,f.key),f.key),'INVALID_BACKUP_ARCHIVE');
  rejects(() => openBackupArchive(authenticated(decoded.metadata,[...bodies,Buffer.from('trailing')],f.key),f.key),'INVALID_BACKUP_ARCHIVE');
});

test('seal rejects missing/duplicate records instead of claiming a full snapshot', () => {
  const f = fixture(); rejects(() => sealBackupArchive(f.capture,f.records.slice(1),f.key),'INVALID_BACKUP_ARCHIVE');
  rejects(() => sealBackupArchive(f.capture,[...f.records,f.records[0]!],f.key),'INVALID_BACKUP_ARCHIVE');
});

test('the separate encryption key is never embedded in a source record or metadata, even under an accidental role alias', () => {
  const f=fixture(); const records=f.records.map((r,i)=>i===0?{...r,bytes:Buffer.from(f.key)}:r);
  rejects(()=>sealBackupArchive(f.capture,records,f.key),'BACKUP_KEY_INCLUDED_IN_SOURCE');
  const original=openBackupArchive(sealBackupArchive(f.capture,f.records,f.key),f.key);
  const metadata={...original.metadata,records:records.map(r=>({name:r.name,bytes:r.bytes.length,sha256:backupHash(r.bytes)}))};
  rejects(()=>openBackupArchive(authenticated(metadata,records.map(r=>r.bytes),f.key),f.key),'BACKUP_KEY_INCLUDED_IN_SOURCE');
  const key=Buffer.from('a'.repeat(32));
  rejects(()=>sealBackupArchive({...f.capture,selection:{...f.capture.selection,source:{...f.capture.selection.source,owner_id:key.toString()}}},f.records,key),'BACKUP_KEY_INCLUDED_IN_SOURCE');
});

test('inert material frames roundtrip byte-for-byte but cannot be parsed as ordinary JSON/native JSONL', () => {
  const r: BackupRecord = {name:'config',bytes:Buffer.from('{"data_dir":"/synthetic/original"}\n')}; const frame = frameBackupRecord(r);
  assert.deepEqual(unframeBackupRecord(frame),r); assert.throws(() => JSON.parse(frame.toString('utf8')));
  assert.throws(() => JSON.parse(frame.toString('utf8').split('\n')[0]!));
  rejects(() => unframeBackupRecord(frame.subarray(0,-1)),'INVALID_BACKUP_ARCHIVE');
  const changed = Buffer.from(frame); changed[0] = 0; rejects(() => unframeBackupRecord(changed),'INVALID_BACKUP_ARCHIVE');
});
