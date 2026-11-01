import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ApiError, validId } from './auth.js';
import { DeviceStore } from './device-store.js';
import { PAIRING_PACKAGE_LIMIT, pairingBase, parsePairingPackage, type PairingPackage } from './pairing-package.js';
import { handoverStaticUser, inspectStaticRegistry } from './device-handover.js';

function invalid(): never { throw new ApiError(422, 'INVALID_CLI_ARGUMENTS', 'Use an explicit supported device command and its exact targets'); }
function privatePath(path: string) {
  if (process.platform === 'win32' || !isAbsolute(path) || resolve(path) !== path) invalid();
  let at = parse(path).root;
  for (const part of path.slice(at.length).split(sep)) {
    at = resolve(at, part);
    try { if (lstatSync(at).isSymbolicLink()) invalid(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) invalid();
}
function parentSync(path: string) { const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function readPackage(path: string, local: boolean) {
  privatePath(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > PAIRING_PACKAGE_LIMIT) invalid();
    const bytes = Buffer.alloc(PAIRING_PACKAGE_LIMIT + 1); let size = 0;
    while (size < bytes.length) { const count = readSync(fd, bytes, size, bytes.length - size, null); if (!count) break; size += count; }
    if (size > PAIRING_PACKAGE_LIMIT) invalid();
    const result = parsePairingPackage(bytes.subarray(0, size).toString('utf8'), local);
    fsyncSync(fd); parentSync(path); return result;
  } finally { closeSync(fd); }
}
function writePackage(path: string, value: PairingPackage) {
  privatePath(path);
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  parentSync(path);
}

function main() {
  const parsed = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {
    path: { type: 'string' }, 'store-id': { type: 'string' }, owner: { type: 'string' }, device: { type: 'string' }, request: { type: 'string' },
    base: { type: 'string' }, out: { type: 'string' }, label: { type: 'string' }, manager: { type: 'boolean', default: false }, 'allow-loopback-http': { type: 'boolean', default: false },
    'auth-file': { type: 'string' }, 'expected-token-hash': { type: 'string' }, 'expected-file-hash': { type: 'string' }, intent: { type: 'string' }, kind: { type: 'string' }, 'exclusive-registry-control': { type: 'boolean', default: false },
  } });
  const command = parsed.positionals[0]; if (parsed.positionals.length !== 1 || !command) invalid();
  const v = parsed.values;
  const allowed: Record<string, string[]> = {
    init: ['path'], invite: ['path','store-id','owner','base','out','label','manager','allow-loopback-http'],
    show: ['out','allow-loopback-http'], list: ['path','store-id','owner'], revoke: ['path','store-id','owner','device','request'], receipt: ['path','store-id','request','owner','device','kind'],
    'inspect-static': ['auth-file'], handover: ['path','store-id','owner','device','request','auth-file','expected-token-hash','expected-file-hash','intent','label','manager','exclusive-registry-control'],
  };
  if (!allowed[command] || Object.entries(v).some(([key, value]) => value !== false && !allowed[command]!.includes(key))) invalid();
  const required = (key: keyof typeof v): string => { const value = v[key]; if (typeof value !== 'string' || !value) invalid(); return value; };
  const local = v['allow-loopback-http'] === true;
  if (command === 'show') {
    const pkg = readPackage(required('out'), local);
    console.error('PAIRING_SECRET_DISPLAY: this one-use package contains a credential; do not share it in logs.');
    console.log(JSON.stringify(pkg)); return;
  }
  if (command === 'inspect-static') { console.log(JSON.stringify(inspectStaticRegistry(required('auth-file')))); return; }
  const path = required('path');
  if (command === 'init') { console.log(JSON.stringify(DeviceStore.initialize(path))); return; }
  const store = new DeviceStore(path, required('store-id'));
  try {
    if (command === 'invite') {
      const owner = required('owner'); if (!validId(owner)) invalid();
      const base = pairingBase(required('base'), local); const out = required('out'); const label = required('label');
      let pkg: PairingPackage;
      try { pkg = readPackage(out, local); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        pkg = parsePairingPackage(JSON.stringify({ notifier_pairing: 1, base, store_id: store.storeId, invitation_id: randomUUID(), secret: randomBytes(32).toString('hex'), expires_at: Date.now() + 10 * 60 * 1000, owner_id: owner, label, manage_devices: v.manager === true }), local);
        writePackage(out, pkg); // Complete original secret/ID/body is durable BEFORE touching the authority.
      }
      if (pkg.store_id !== store.storeId || pkg.base !== base || pkg.owner_id !== owner || pkg.label !== label || pkg.manage_devices !== (v.manager === true)) throw new ApiError(409, 'ORIGINAL_INVITATION_DIFFERS', 'Retained original invitation differs; do not overwrite it');
      const result = store.createInvitation('operator', { request_id: pkg.invitation_id, invitation_id: pkg.invitation_id, secret: pkg.secret, owner_id: pkg.owner_id, label: pkg.label, manage_devices: pkg.manage_devices, expires_at: pkg.expires_at });
      console.log(JSON.stringify({ ...result, store_id: store.storeId, private_package_written: true }));
    } else if (command === 'handover') {
      console.log(JSON.stringify(handoverStaticUser(store, { request_id: required('request'), device_id: required('device'), owner_id: required('owner'), label: required('label'), manage_devices: v.manager === true, old_hash: required('expected-token-hash'), registry_path: required('auth-file'), original_digest: required('expected-file-hash') }, required('intent'), v['exclusive-registry-control'] === true)));
    } else if (command === 'list') {
      console.log(JSON.stringify({ items: store.list(required('owner')).map(d => ({ device_id: d.id, owner_id: d.owner, label: d.label, manage_devices: d.manager === 1, state: d.state, credential_version: d.credential_version, created_at: d.created_at })) }));
    } else if (command === 'revoke') {
      console.log(JSON.stringify(store.operatorRevoke(required('owner'), required('device'), required('request'))));
    } else if (command === 'receipt') {
      if (v.owner !== undefined || v.device !== undefined || v.kind !== undefined) {
        const kind = required('kind'); if (kind !== 'revoke' && kind !== 'rotate') invalid();
        console.log(JSON.stringify({ historical_fact: true, kind, fact: store.deviceOperationFact(required('owner'), required('device'), kind, required('request')) }));
      } else console.log(JSON.stringify(store.operatorRevocationReceipt(required('request'))));
    } else invalid();
  } finally { store.close(); }
}
try { main(); }
catch (error) {
  const code = error instanceof ApiError ? error.code : (error as NodeJS.ErrnoException).code;
  console.error(JSON.stringify({ error: /^[A-Z_]+$/.test(code ?? '') ? code : 'DEVICE_CLI_FAILED', original_records_preserved: true, must_reconcile_original: true })); process.exitCode = 1;
}
