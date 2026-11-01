import { constants, closeSync, existsSync, fsyncSync, lstatSync, openSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import { ApiError, validId } from './auth.js';
import { serializeBackupDatabase } from './backup-snapshot.js';
import { assertSnapshotCatalog } from './backup-validation.js';
import {assertNoRecovery,assertNoRecoveryFile} from './recovery-gate.js';

const APP = 0x4e444156;
const VERSION = 1;
export const DEVICE_AUTHORITY_MAX_BYTES = 256 * 1024 * 1024;
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ddl = [
  `CREATE TABLE authority (id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version=1))`,
  `CREATE TABLE devices (id TEXT PRIMARY KEY, owner TEXT NOT NULL, label TEXT NOT NULL, manager INTEGER NOT NULL CHECK(manager IN (0,1)), state TEXT NOT NULL CHECK(state IN ('active','revoked','handover_pending')), credential_version INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE credentials (hash TEXT PRIMARY KEY, device TEXT NOT NULL REFERENCES devices(id), version INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), UNIQUE(device,version))`,
  `CREATE TABLE invitations (id TEXT PRIMARY KEY, owner TEXT NOT NULL, label TEXT NOT NULL, manager INTEGER NOT NULL CHECK(manager IN (0,1)), secret_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN (0,1)), claim_id TEXT UNIQUE, claim_digest TEXT, claim_result TEXT)`,
  `CREATE TABLE device_operations (scope TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope,id))`,
  `CREATE TABLE transitions (request_id TEXT PRIMARY KEY, device TEXT NOT NULL REFERENCES devices(id), owner TEXT NOT NULL, from_hash TEXT NOT NULL, to_hash TEXT NOT NULL UNIQUE, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL)`,
  `CREATE TABLE handovers (id TEXT PRIMARY KEY, device TEXT NOT NULL UNIQUE REFERENCES devices(id), old_hash TEXT NOT NULL, registry_path TEXT NOT NULL, original_digest TEXT NOT NULL, replacement_digest TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('prepared','file_synced','complete')))`,
];
export const deviceAuthorityDdl:readonly string[]=ddl;
const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
};
export const credentialHash = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => credentialHash(canonical(value));
function fail(status: number, code: string, message: string): never { throw new ApiError(status, code, message); }
const unavailable = (): never => fail(503, 'DEVICE_AUTHORITY_UNAVAILABLE', 'The configured original device authority is unavailable');
const input = (ok: unknown) => { if (!ok) fail(422, 'INVALID_INPUT', 'Invalid device operation'); };
const idInput = (id: string) => input(validId(id));
const tokenInput = (token: string) => input(typeof token === 'string' && hex.test(token));
const labelInput = (label: string) => input(typeof label === 'string' && label.trim() && [...label].length <= 80 && !/[\u0000-\u001f\u007f]/u.test(label));
const equal = (a: string, b: string) => hex.test(a) && hex.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
function inputCheck(manager: boolean, old: string, original: string, replacement: string, path: string) {
  input(typeof manager === 'boolean' && hex.test(old) && hex.test(original) && hex.test(replacement) && original !== replacement && isAbsolute(path) && resolve(path) === path);
}
function available(check: (token: string) => void, token: string) {
  if (check.constructor.name === 'AsyncFunction') fail(503, 'ASYNC_AUTHORITY_GATE_FORBIDDEN', 'Credential checks must be synchronous');
  const result: unknown = check(token);
  if (result !== undefined) fail(503, 'ASYNC_AUTHORITY_GATE_FORBIDDEN', 'Credential checks must complete synchronously');
}

/** Managed authority is explicitly POSIX-only until Windows ACL handling is independently implemented. */
function location(path: string) {
  if (process.platform === 'win32' || !isAbsolute(path) || resolve(path) !== path) unavailable();
  let at = parse(path).root;
  for (const component of path.slice(at.length).split(sep)) {
    at = resolve(at, component);
    if (existsSync(at) && lstatSync(at).isSymbolicLink()) unavailable();
  }
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) unavailable();
}
function sidecars(path: string): string[] {
  const found: string[] = [];
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const name = path + suffix;
    let stat;
    try { stat = lstatSync(name); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > DEVICE_AUTHORITY_MAX_BYTES) unavailable();
    found.push(name);
  }
  return found;
}
function inspect(path: string) {
  location(path); sidecars(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size < 4096 || stat.size > DEVICE_AUTHORITY_MAX_BYTES) unavailable();
  return { dev: stat.dev, ino: stat.ino };
}
function sync(path: string) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(file); } finally { closeSync(file); }
  // A readable committed WAL is still not proof that its original fsync succeeded.
  if (sidecars(path).includes(path + '-wal')) {
    const wal = openSync(path + '-wal', constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(wal); } finally { closeSync(wal); }
  }
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY); try { fsyncSync(parent); } finally { closeSync(parent); }
}
function configure(db: Database.Database) {
  db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma('busy_timeout=5000');
}
function schema(db: Database.Database, storeId: string) {
  if (db.pragma('application_id', { simple: true }) !== APP || db.pragma('user_version', { simple: true }) !== VERSION || db.pragma('journal_mode', { simple: true }) !== 'wal') unavailable();
  const objects = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as { type: string; sql: string }[];
  const expected = new Set(ddl.map(norm));
  if (objects.length !== ddl.length || objects.some(o => o.type !== 'table' || !expected.has(norm(o.sql)))) unavailable();
  const rows = db.prepare('SELECT id,version FROM authority').all() as { id: string; version: number }[];
  if (rows.length !== 1 || rows[0]?.id !== storeId || rows[0]?.version !== VERSION) unavailable();
}
/** Only authenticated, private derived backup images: no path access, writable pragmas, migration or store constructor. */
export function assertDeviceBackupDatabase(db: Database.Database, storeId: string): void {
  if (!uuid.test(storeId)) unavailable();
  assertSnapshotCatalog(db, ddl, APP, VERSION);
  const rows = db.prepare('SELECT id,version FROM authority').all() as { id: string; version: number }[];
  if (rows.length !== 1 || rows[0]?.id !== storeId || rows[0]?.version !== VERSION) unavailable();
}
export interface Device {
  id: string; owner: string; label: string; manager: number; state: 'active' | 'revoked' | 'handover_pending'; credential_version: number; created_at: number;
}
interface Credential { hash: string; device: string; version: number; active: number }
interface Invitation { id: string; owner: string; label: string; manager: number; secret_hash: string; expires_at: number; revoked: number; claim_id: string | null; claim_digest: string | null; claim_result: string | null }
export interface Transition { request_id: string; device: string; owner: string; from_hash: string; to_hash: string; from_version: number; to_version: number }
export interface DeviceIdentity { store_id: string; id: string; owner_id: string; label: string; manage_devices: boolean; credential_version: number }
export interface InviteInput { request_id: string; invitation_id: string; secret: string; owner_id: string; label: string; manage_devices: boolean; expires_at: number }
export interface ClaimInput { claim_id: string; invitation_id: string; secret: string; token: string }
export interface HandoverInput { request_id: string; device_id: string; owner_id: string; label: string; manage_devices: boolean; old_hash: string; registry_path: string; original_digest: string; replacement_digest: string }
export interface Handover { id: string; device: string; old_hash: string; registry_path: string; original_digest: string; replacement_digest: string; phase: 'prepared' | 'file_synced' | 'complete' }

/** Authentication/control facts only. No event, response, native or provider data is duplicated here. */
export class DeviceStore {
  private readonly db: Database.Database;
  private readonly inode: { dev: number; ino: number };
  private guarded = false;
  static initialize(path: string): { store_id: string } {
    assertNoRecoveryFile(path);
    location(path);
    if (sidecars(path).length !== 0) unavailable();
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600); closeSync(fd);
    const mask = process.umask(0o077); let db: Database.Database | undefined;
    try {
      db = new Database(path, { fileMustExist: true }); configure(db);
      const store_id = randomUUID();
      db.transaction(() => {
        for (const sql of ddl) db!.exec(sql);
        db!.prepare('INSERT INTO authority VALUES(?,?)').run(store_id, VERSION);
        db!.pragma(`application_id=${APP}`); db!.pragma(`user_version=${VERSION}`);
      }).immediate();
      db.close(); db = undefined; sync(path); return { store_id };
    } finally { if (db?.open) db.close(); process.umask(mask); }
  }
  constructor(readonly path: string, readonly storeId: string, private readonly now: () => number = Date.now) {
    if (!uuid.test(storeId)) unavailable();
    assertNoRecoveryFile(path);
    this.inode = inspect(path);
    // Reject a foreign/degraded layout read-only, before any writable pragma or SQLite repair.
    const probe = new Database(path, { readonly: true, fileMustExist: true });
    try { schema(probe, storeId); } finally { probe.close(); }
    const current = inspect(path); if (current.dev !== this.inode.dev || current.ino !== this.inode.ino) unavailable();
    const mask = process.umask(0o077); let opened: Database.Database | undefined;
    try { opened = new Database(path, { fileMustExist: true }); configure(opened); this.db = opened; }
    catch (error) { if (opened?.open) opened.close(); throw error; }
    finally { process.umask(mask); }
    try { this.check(); } catch (e) { this.db.close(); throw e; }
  }
  close() { if (this.db.open) this.db.close(); }
  assertReady() { this.check(); }
  private check() {
    try {
    assertNoRecovery(this.db);
    const current = inspect(this.path);
    if (!this.db.open || current.dev !== this.inode.dev || current.ino !== this.inode.ino) unavailable();
    schema(this.db, this.storeId);
    // Readability alone is not a durability acknowledgement. A failed original sync never creates a new authority.
    sync(this.path);
    } catch (error) { if (error instanceof ApiError) throw error; unavailable(); }
  }
  /** Every supported authority writer and the complete synchronous user-write action share this lock. */
  guard<T>(action: () => T): T {
    this.check();
    if (action.constructor.name === 'AsyncFunction') fail(503, 'ASYNC_AUTHORITY_GATE_FORBIDDEN', 'Authority gates must be synchronous');
    const invoke = () => {
      const result = action();
      if (result && typeof (result as { then?: unknown }).then === 'function') fail(503, 'ASYNC_AUTHORITY_GATE_FORBIDDEN', 'Authority gates must be synchronous');
      return result;
    };
    try {
      if (this.guarded) return invoke();
      const result = this.db.transaction(() => {
        this.check(); this.guarded = true;
        try { return invoke(); } finally { this.guarded = false; }
      }).immediate();
      this.check();
      return result;
    } catch (error) { if (error instanceof ApiError) throw error; return unavailable(); }
  }
  /** Local operator capture only. The callback acquires ledger IMMEDIATE before invoking the bounded image reader. */
  withBackupSnapshot<T>(capture: (readImage: (maxBytes?: number) => Buffer) => T): T {
    if (capture.constructor.name === 'AsyncFunction') fail(503, 'ASYNC_BACKUP_CAPTURE_FORBIDDEN', 'Backup capture must be synchronous');
    return this.guard(() => {
      let active = true;
      const readImage = (maxBytes?: number) => {
        if (!active) fail(503, 'BACKUP_SNAPSHOT_LOCK_REQUIRED', 'Original snapshot lock window has ended');
        this.check();
        return serializeBackupDatabase(this.db, maxBytes);
      };
      try { return capture(readImage); } finally { active = false; }
    });
  }
  private once<T>(scope: string, id: string, value: unknown, action: () => T): T {
    idInput(id);
    const hash = digest(value);
    const row = this.db.prepare('SELECT digest,result FROM device_operations WHERE scope=? AND id=?').get(scope, id) as { digest: string; result: string } | undefined;
    if (row) { if (!equal(hash, row.digest)) fail(409, 'IDEMPOTENCY_CONFLICT', 'Original device operation content differs'); return JSON.parse(row.result) as T; }
    if ((this.db.prepare('SELECT COUNT(*) n FROM device_operations').get() as { n: number }).n >= 100000) fail(503, 'DEVICE_AUTHORITY_FULL', 'Device authority operation storage is full; original records retained');
    const result = action(); this.db.prepare('INSERT INTO device_operations VALUES(?,?,?,?)').run(scope, id, hash, JSON.stringify(result)); return result;
  }
  device(id: string): Device | undefined { this.check(); return this.db.prepare('SELECT * FROM devices WHERE id=?').get(id) as Device | undefined; }
  hasActor(id: string) { return this.device(id) !== undefined; }
  tokenRecord(token: string): { credential: Credential; device: Device } | undefined {
    this.check(); tokenInput(token);
    const credential = this.db.prepare('SELECT * FROM credentials WHERE hash=?').get(credentialHash(token)) as Credential | undefined;
    return credential ? { credential, device: this.db.prepare('SELECT * FROM devices WHERE id=?').get(credential.device) as Device } : undefined;
  }
  authenticate(token: string): DeviceIdentity {
    const found = this.tokenRecord(token);
    if (!found || found.credential.active !== 1 || found.device.state !== 'active' || found.device.credential_version !== found.credential.version) fail(401, 'UNAUTHENTICATED', 'A current managed device credential is required');
    return this.identity(found.device);
  }
  private identity(d: Device): DeviceIdentity { return { store_id: this.storeId, id: d.id, owner_id: d.owner, label: d.label, manage_devices: d.manager === 1, credential_version: d.credential_version }; }
  current(owner: string, id: string): DeviceIdentity | undefined {
    const device = this.device(id); return device?.owner === owner && device.state === 'active' ? this.identity(device) : undefined;
  }
  list(owner: string): Device[] { this.check(); idInput(owner); return this.db.prepare('SELECT * FROM devices WHERE owner=? ORDER BY created_at,id').all(owner) as Device[]; }
  createInvitation(issuer: string, value: InviteInput) {
    idInput(issuer); idInput(value.invitation_id); idInput(value.owner_id); tokenInput(value.secret); labelInput(value.label);
    input(typeof value.manage_devices === 'boolean' && Number.isSafeInteger(value.expires_at));
    return this.guard(() => this.once(`invite:${issuer}`, value.request_id, { ...value, secret: credentialHash(value.secret) }, () => {
      input(value.expires_at > this.now() && value.expires_at <= this.now() + 15 * 60 * 1000);
      if ((this.db.prepare('SELECT COUNT(*) n FROM invitations').get() as { n: number }).n >= 10000) fail(503, 'DEVICE_AUTHORITY_FULL', 'Invitation storage full; original claims retained');
      if (this.db.prepare('SELECT 1 FROM invitations WHERE id=? OR secret_hash=?').get(value.invitation_id, credentialHash(value.secret))) fail(409, 'INVITATION_ALREADY_KNOWN', 'Invitation identifiers or secret material cannot be reused');
      this.db.prepare('INSERT INTO invitations(id,owner,label,manager,secret_hash,expires_at,revoked) VALUES(?,?,?,?,?,?,0)').run(value.invitation_id, value.owner_id, value.label, value.manage_devices ? 1 : 0, credentialHash(value.secret), value.expires_at);
      return { invitation_id: value.invitation_id, owner_id: value.owner_id, manage_devices: value.manage_devices, expires_at: value.expires_at };
    }));
  }
  claim(value: ClaimInput, assertTokenAvailable: (token: string) => void) {
    idInput(value.claim_id); idInput(value.invitation_id); tokenInput(value.secret); tokenInput(value.token);
    return this.guard(() => {
      const invitation = this.db.prepare('SELECT * FROM invitations WHERE id=?').get(value.invitation_id) as Invitation | undefined;
      if (!invitation || !equal(invitation.secret_hash, credentialHash(value.secret))) fail(401, 'INVALID_PAIRING', 'Valid original pairing secret is required');
      const hash = digest({ ...value, secret: credentialHash(value.secret), token: credentialHash(value.token) });
      if (invitation.claim_id !== null) {
        if (invitation.claim_id !== value.claim_id || invitation.claim_digest !== hash || !invitation.claim_result) fail(409, 'PAIRING_ALREADY_USED', 'Original invitation is already claimed');
        // Historical acceptance is not current login or reactivation. Call authenticated self to adopt it.
        return JSON.parse(invitation.claim_result) as { claim_id: string; device_id: string; store_id: string };
      }
      if (invitation.revoked) fail(410, 'PAIRING_REVOKED', 'Invitation was revoked');
      if (invitation.expires_at <= this.now()) fail(410, 'PAIRING_EXPIRED', 'Invitation has expired');
      if ((this.db.prepare('SELECT COUNT(*) n FROM devices').get() as { n: number }).n >= 1000) fail(503, 'DEVICE_AUTHORITY_FULL', 'Device capacity full; original identities retained');
      available(assertTokenAvailable, value.token);
      if (this.tokenRecord(value.token)) fail(409, 'CREDENTIAL_ALREADY_KNOWN', 'Credential material cannot be reused');
      const id = `device_${randomUUID()}`;
      this.db.prepare("INSERT INTO devices VALUES(?,?,?,?, 'active',1,?)").run(id, invitation.owner, invitation.label, invitation.manager, this.now());
      this.db.prepare('INSERT INTO credentials VALUES(?,?,1,1)').run(credentialHash(value.token), id);
      const result = { claim_id: value.claim_id, device_id: id, store_id: this.storeId };
      this.db.prepare('UPDATE invitations SET claim_id=?,claim_digest=?,claim_result=? WHERE id=?').run(value.claim_id, hash, JSON.stringify(result), value.invitation_id);
      return result;
    });
  }
  revokeInvitation(issuer: string, owner: string, invitationId: string, requestId: string) {
    idInput(issuer); idInput(owner); idInput(invitationId);
    return this.guard(() => this.once(`invite_revoke:${issuer}`, requestId, { owner, invitationId }, () => {
      const row = this.db.prepare('SELECT * FROM invitations WHERE id=? AND owner=?').get(invitationId, owner) as Invitation | undefined;
      if (!row) fail(404, 'NOT_FOUND', 'Invitation is not visible');
      this.db.prepare('UPDATE invitations SET revoked=1 WHERE id=?').run(invitationId);
      return { invitation_id: invitationId, revoked: true, already_claimed: row.claim_id !== null };
    }));
  }
  claimFact(token: string, claimId: string) {
    idInput(claimId); const current = this.authenticate(token);
    const row = this.db.prepare('SELECT claim_result FROM invitations WHERE claim_id=?').get(claimId) as { claim_result: string } | undefined;
    const result = row ? JSON.parse(row.claim_result) as { claim_id: string; device_id: string; store_id: string } : undefined;
    if (!result || result.device_id !== current.id || result.store_id !== this.storeId || result.claim_id !== claimId) fail(404, 'NOT_FOUND', 'Original claim is not visible to this device');
    return result;
  }
  rotate(token: string, requestId: string, replacement: string, assertTokenAvailable: (token: string) => void) {
    tokenInput(token); tokenInput(replacement); idInput(requestId);
    return this.guard(() => {
      // Authentication before idempotency lookup: a revoked ctx never gets an old success as write permission.
      const current = this.authenticate(token);
      return this.once(`rotate:${current.id}`, requestId, { from: credentialHash(token), to: credentialHash(replacement) }, () => {
        available(assertTokenAvailable, replacement);
        if (this.tokenRecord(replacement)) fail(409, 'CREDENTIAL_ALREADY_KNOWN', 'Credential material cannot be reused');
        const version = current.credential_version + 1;
        this.db.prepare('UPDATE credentials SET active=0 WHERE device=?').run(current.id);
        this.db.prepare('INSERT INTO credentials VALUES(?,?,?,1)').run(credentialHash(replacement), current.id, version);
        this.db.prepare('UPDATE devices SET credential_version=? WHERE id=?').run(version, current.id);
        const transition: Transition = { request_id: requestId, device: current.id, owner: current.owner_id, from_hash: credentialHash(token), to_hash: credentialHash(replacement), from_version: current.credential_version, to_version: version };
        this.db.prepare('INSERT INTO transitions VALUES(?,?,?,?,?,?,?)').run(requestId, current.id, current.owner_id, transition.from_hash, transition.to_hash, transition.from_version, transition.to_version);
        return transition;
      });
    });
  }
  transition(token: string, requestId: string): Transition {
    idInput(requestId);
    const current = this.authenticate(token);
    const result = this.db.prepare('SELECT * FROM transitions WHERE request_id=? AND device=? AND owner=? AND to_hash=? AND to_version=?').get(requestId, current.id, current.owner_id, credentialHash(token), current.credential_version) as Transition | undefined;
    if (!result) fail(404, 'NOT_FOUND', 'Original transition is not visible for this current credential');
    return result;
  }
  revoke(token: string, requestId: string, target: string) {
    idInput(requestId); idInput(target);
    return this.guard(() => {
      const current = this.authenticate(token);
      return this.once(`revoke:${current.id}`, requestId, { target }, () => {
        const device = this.device(target);
        if (!device || device.owner !== current.owner_id) fail(404, 'NOT_FOUND', 'Device is not visible');
        if (target !== current.id && !current.manage_devices) fail(403, 'FORBIDDEN', 'Explicit device management permission required');
        if (device.state === 'handover_pending') fail(409, 'HANDOVER_UNRESOLVED', 'Original handover must settle first');
        this.db.prepare("UPDATE devices SET state='revoked' WHERE id=?").run(target);
        this.db.prepare('UPDATE credentials SET active=0 WHERE device=?').run(target);
        return { request_id: requestId, device_id: target, owner_id: current.owner_id, revoked: true, previous_hash: target === current.id ? credentialHash(token) : null };
      });
    });
  }
  prepareHandover(input: HandoverInput) {
    idInput(input.request_id); idInput(input.device_id); idInput(input.owner_id); labelInput(input.label);
    inputCheck(input.manage_devices, input.old_hash, input.original_digest, input.replacement_digest, input.registry_path);
    return this.guard(() => this.once('handover_prepare', input.request_id, input, () => {
      if (this.device(input.device_id) || this.db.prepare('SELECT 1 FROM credentials WHERE hash=?').get(input.old_hash)) fail(409, 'HANDOVER_IDENTITY_ALREADY_KNOWN', 'An existing managed identity cannot be adopted by guessing a static label');
      if ((this.db.prepare('SELECT COUNT(*) n FROM devices').get() as { n: number }).n >= 1000) fail(503, 'DEVICE_AUTHORITY_FULL', 'Original identities retained');
      this.db.prepare("INSERT INTO devices VALUES(?,?,?,?,'handover_pending',1,?)").run(input.device_id, input.owner_id, input.label, input.manage_devices ? 1 : 0, this.now());
      this.db.prepare('INSERT INTO credentials VALUES(?,?,1,0)').run(input.old_hash, input.device_id);
      this.db.prepare("INSERT INTO handovers VALUES(?,?,?,?,?,?,'prepared')").run(input.request_id, input.device_id, input.old_hash, input.registry_path, input.original_digest, input.replacement_digest);
      return { request_id: input.request_id, device_id: input.device_id, owner_id: input.owner_id, prepared: true };
    }));
  }
  handover(requestId: string): Handover | undefined { idInput(requestId); this.check(); return this.db.prepare('SELECT * FROM handovers WHERE id=?').get(requestId) as Handover | undefined; }
  recordHandoverFileSync(requestId: string, verifiedDigest: string) {
    if (!this.guarded) fail(503, 'AUTHORITY_GATE_REQUIRED', 'The original file operation must hold its authority gate');
    const row = this.handover(requestId);
    if (!row || row.replacement_digest !== verifiedDigest) fail(409, 'HANDOVER_PROOF_MISMATCH', 'Original handover file proof differs');
    if (row.phase === 'prepared') this.db.prepare("UPDATE handovers SET phase='file_synced' WHERE id=?").run(requestId);
  }
  completeHandover(requestId: string, verifiedDigest: string) {
    if (!this.guarded) fail(503, 'AUTHORITY_GATE_REQUIRED', 'The original activation must hold its authority gate');
    const row = this.handover(requestId);
    if (!row || row.replacement_digest !== verifiedDigest || row.phase === 'prepared') fail(409, 'HANDOVER_PROOF_MISMATCH', 'Original handover has no synced file proof');
    return this.once('handover_complete', requestId, { device: row.device, verifiedDigest }, () => {
      const device = this.device(row.device);
      if (!device || device.state !== 'handover_pending' || device.credential_version !== 1) fail(409, 'HANDOVER_IDENTITY_CHANGED', 'Original pending identity differs');
      this.db.prepare("UPDATE devices SET state='active' WHERE id=?").run(row.device);
      this.db.prepare('UPDATE credentials SET active=1 WHERE device=? AND hash=? AND version=1').run(row.device, row.old_hash);
      this.db.prepare("UPDATE handovers SET phase='complete' WHERE id=?").run(requestId);
      return { request_id: requestId, store_id: this.storeId, device_id: row.device, owner_id: device.owner, credential_version: 1, handover_completed: true };
    });
  }
  revocationFact(token: string, requestId: string) {
    idInput(requestId); const current = this.authenticate(token);
    return this.deviceOperationFact(current.owner_id, current.id, 'revoke', requestId);
  }
  deviceOperationFact(owner: string, actor: string, kind: 'rotate' | 'revoke', requestId: string) {
    idInput(owner); idInput(actor); idInput(requestId); this.check();
    const device = this.device(actor);
    if (!device || device.owner !== owner || !['rotate','revoke'].includes(kind)) fail(404, 'NOT_FOUND', 'Original device operation is not visible');
    const row = this.db.prepare('SELECT result FROM device_operations WHERE scope=? AND id=?').get(`${kind}:${actor}`, requestId) as { result: string } | undefined;
    if (!row) fail(404, 'NOT_FOUND', 'Original device operation fact is unavailable');
    const fact = JSON.parse(row.result) as Record<string, unknown>;
    if (kind === 'revoke') return { request_id: requestId, device_id: fact.device_id as string, owner_id: owner, revoked: fact.revoked === true };
    return fact;
  }
  operatorRevoke(owner: string, target: string, requestId: string) {
    idInput(owner); idInput(target);
    return this.guard(() => this.once('operator_revoke', requestId, { owner, target }, () => {
      const device = this.device(target);
      if (!device || device.owner !== owner) fail(404, 'NOT_FOUND', 'Original managed device is not visible');
      if (device.state === 'handover_pending') fail(409, 'HANDOVER_UNRESOLVED', 'Original handover must settle first');
      this.db.prepare("UPDATE devices SET state='revoked' WHERE id=?").run(target);
      this.db.prepare('UPDATE credentials SET active=0 WHERE device=?').run(target);
      return { request_id: requestId, device_id: target, owner_id: owner, revoked: true };
    }));
  }
  operatorRevocationReceipt(requestId: string) {
    idInput(requestId); this.check();
    const row = this.db.prepare("SELECT result FROM device_operations WHERE scope='operator_revoke' AND id=?").get(requestId) as { result: string } | undefined;
    if (!row) fail(404, 'NOT_FOUND', 'Original operator revocation fact is unavailable');
    return JSON.parse(row.result) as { request_id: string; device_id: string; owner_id: string; revoked: boolean };
  }
  selfRevocationReceipt(token: string, requestId: string) {
    tokenInput(token); idInput(requestId); this.check();
    const original = this.tokenRecord(token);
    if (!original) fail(401, 'UNAUTHENTICATED', 'Original credential is required for this one fact');
    const row = this.db.prepare('SELECT result FROM device_operations WHERE scope=? AND id=?').get(`revoke:${original.device.id}`, requestId) as { result: string } | undefined;
    const result = row ? JSON.parse(row.result) as { request_id: string; device_id: string; owner_id: string; revoked: boolean; previous_hash: string | null } : undefined;
    if (!result || result.request_id !== requestId || result.device_id !== original.device.id || result.owner_id !== original.device.owner || result.previous_hash !== credentialHash(token) || !result.revoked) fail(404, 'NOT_FOUND', 'The one original self-revocation fact is not visible');
    return { request_id: requestId, device_id: result.device_id, revoked: true };
  }
}
