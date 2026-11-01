import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ApiError, parseRegistry, validId } from './auth.js';
import { DeviceStore, credentialHash, type HandoverInput } from './device-store.js';

export type HandoverRequest = Omit<HandoverInput, 'replacement_digest'>;
interface Intent extends HandoverInput { notifier_handover: 1; store_id: string }
export type HandoverPhase = 'intent_saved' | 'prepared' | 'file_replaced' | 'file_synced' | 'activated';
const bytesHash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function fail(code: string): never { throw new ApiError(409, code, 'Original handover requires exact operator reconciliation; files and identity are not reset'); }
function pathCheck(path: string) {
  if (process.platform === 'win32' || !isAbsolute(path) || resolve(path) !== path) fail('INVALID_HANDOVER_PATH');
  let at = parse(path).root;
  for (const part of path.slice(at.length).split(sep)) {
    at = resolve(at, part);
    try { if (lstatSync(at).isSymbolicLink()) fail('INVALID_HANDOVER_PATH'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) fail('INVALID_HANDOVER_PATH');
}
function read(path: string, limit: number): Buffer {
  pathCheck(path); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > limit) fail('INVALID_HANDOVER_FILE');
    const buffer = Buffer.alloc(limit + 1); let size = 0;
    while (size < buffer.length) { const n = readSync(fd, buffer, size, buffer.length - size, null); if (!n) break; size += n; }
    if (size > limit) fail('INVALID_HANDOVER_FILE'); return buffer.subarray(0, size);
  } finally { closeSync(fd); }
}
function sync(path: string) {
  pathCheck(path); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY); try { fsyncSync(parent); } finally { closeSync(parent); }
}
function save(path: string, content: Buffer, limit: number) {
  pathCheck(path); let fd: number;
  try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!read(path, limit).equals(content)) fail('ORIGINAL_HANDOVER_ARTIFACT_DIFFERS'); sync(path); return;
  }
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  sync(path);
}
function decodedRegistry(bytes: Buffer) {
  const value = JSON.parse(bytes.toString('utf8')) as { principals: { id: string; owner_id: string; kind: string; token: string }[] };
  parseRegistry(value, true); return value;
}
function requestInput(value: HandoverRequest) {
  if (!validId(value.request_id) || !validId(value.device_id) || !validId(value.owner_id) || typeof value.label !== 'string' || !value.label.trim() || [...value.label].length > 80 || /[\u0000-\u001f\u007f]/u.test(value.label) || typeof value.manage_devices !== 'boolean' || !/^[a-f0-9]{64}$/.test(value.old_hash) || !/^[a-f0-9]{64}$/.test(value.original_digest)) fail('INVALID_HANDOVER_REQUEST');
  pathCheck(value.registry_path);
}
function sameRequest(intent: Intent, request: HandoverRequest, storeId: string) {
  if (!intent || intent.notifier_handover !== 1 || intent.store_id !== storeId || Object.keys(intent).length !== 11 || Object.entries(request).some(([key, value]) => (intent as unknown as Record<string, unknown>)[key] !== value) || !/^[a-f0-9]{64}$/.test(intent.replacement_digest)) fail('ORIGINAL_HANDOVER_INTENT_DIFFERS');
}

/**
 * Supported registry writers MUST be quiesced or share this authority lock. This is NOT a CAS
 * against arbitrary uncooperative editors. The explicit flag asserts that supported single-writer
 * boundary; hashes detect observed conflicts but cannot make external file edits atomic.
 */
export function handoverStaticUser(store: DeviceStore, request: HandoverRequest, intentPath: string, exclusiveRegistryControl: boolean, onPhase?: (phase: HandoverPhase) => void) {
  if (!exclusiveRegistryControl) fail('EXCLUSIVE_REGISTRY_CONTROL_REQUIRED'); requestInput(request); pathCheck(intentPath);
  const preparedPath = `${request.registry_path}.handover-${request.request_id}.replacement`;
  let intent: Intent;
  try { intent = JSON.parse(read(intentPath, 8192).toString('utf8')) as Intent; sameRequest(intent, request, store.storeId); sync(intentPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const bytes = read(request.registry_path, 65536);
    if (bytesHash(bytes) !== request.original_digest) fail('HANDOVER_REGISTRY_CONFLICT');
    const root = decodedRegistry(bytes); const original = root.principals.find(p => p.id === request.device_id);
    if (!original || original.kind !== 'user' || original.owner_id !== request.owner_id || credentialHash(original.token) !== request.old_hash) fail('HANDOVER_ORIGINAL_IDENTITY_MISMATCH');
    const replacement = Buffer.from(JSON.stringify({ principals: root.principals.filter(p => p.id !== request.device_id) }) + '\n');
    decodedRegistry(replacement);
    intent = { notifier_handover: 1, store_id: store.storeId, ...request, replacement_digest: bytesHash(replacement) };
    save(preparedPath, replacement, 65536); save(intentPath, Buffer.from(JSON.stringify(intent) + '\n'), 8192);
  }
  onPhase?.('intent_saved');
  store.prepareHandover(intent); onPhase?.('prepared');
  const existing = store.handover(request.request_id)!;
  if (existing.phase === 'complete') {
    // Never rewrite or reactivate after historical completion, even after later rotation/revocation.
    const current = decodedRegistry(read(request.registry_path, 65536));
    if (current.principals.some(p => p.id === request.device_id || credentialHash(p.token) === request.old_hash)) fail('HANDOVER_STATIC_CREDENTIAL_REINTRODUCED');
    const result = store.guard(() => store.completeHandover(request.request_id, existing.replacement_digest));
    return { ...result, historical_completion: true, current_state: store.device(request.device_id)!.state, current_credential_version: store.device(request.device_id)!.credential_version };
  }
  store.guard(() => {
    const row = store.handover(request.request_id)!;
    const current = read(request.registry_path, 65536); const hash = bytesHash(current);
    if (hash === row.original_digest) {
      const prepared = read(preparedPath, 65536); if (bytesHash(prepared) !== row.replacement_digest) fail('ORIGINAL_HANDOVER_ARTIFACT_DIFFERS');
      renameSync(preparedPath, request.registry_path); onPhase?.('file_replaced');
    } else if (hash !== row.replacement_digest) fail('HANDOVER_REGISTRY_CONFLICT');
    sync(request.registry_path); store.recordHandoverFileSync(request.request_id, row.replacement_digest);
  });
  onPhase?.('file_synced');
  const result = store.guard(() => {
    const row = store.handover(request.request_id)!;
    if (bytesHash(read(request.registry_path, 65536)) !== row.replacement_digest) fail('HANDOVER_REGISTRY_CONFLICT');
    sync(request.registry_path); return store.completeHandover(request.request_id, row.replacement_digest);
  });
  onPhase?.('activated');
  return { ...result, historical_completion: false, current_state: store.device(request.device_id)!.state, current_credential_version: store.device(request.device_id)!.credential_version };
}

export function inspectStaticRegistry(path: string) {
  const bytes = read(path, 65536); const root = decodedRegistry(bytes);
  return { registry_digest: bytesHash(bytes), identities: root.principals.map(p => ({ id: p.id, owner_id: p.owner_id, kind: p.kind, credential_fingerprint: credentialHash(p.token) })) };
}
