import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export type Principal = { id: string; owner_id: string } & (
  { kind: 'user' } |
  { kind: 'source'; source_id: string; source_epoch: string; capabilities: string[] }
);
export interface Registry {
  authenticate(header: string | undefined): Principal;
  /** Non-secret identity lookup for optional managed-device collision checks. */
  actor?(id: string): Principal | undefined;
  user(owner: string, id: string): Extract<Principal, { kind: 'user' }> | undefined;
  source(owner: string, id: string, epoch: string): Extract<Principal, { kind: 'source' }> | undefined;
}
export interface RegistryProvider {
  (): Registry;
  readonly userWrite?: <T>(header: string | undefined, expected: Principal, action: (principal: Extract<Principal, { kind: 'user' }>, registry: Registry) => T) => T;
  readonly withAuthority?: <T>(action: () => T) => T;
}
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export const validId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);
const digest = (value: string) => createHash('sha256').update(value).digest();
const unavailable = () => new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Authentication configuration is unavailable');

export function parseRegistry(value: unknown, allowEmpty = false): Registry {
  const fail = (): never => { throw unavailable(); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const root = value as Record<string, unknown>;
  if (Object.keys(root).join() !== 'principals' || !Array.isArray(root.principals) || (!allowEmpty && root.principals.length < 1) || root.principals.length > 100) return fail();
  const ids = new Set<string>(); const tokens = new Set<string>(); const sources = new Set<string>();
  const entries = root.principals.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail();
    const row = entry as Record<string, unknown>;
    if (!validId(row.id) || !validId(row.owner_id) || (row.kind !== 'user' && row.kind !== 'source') || typeof row.token !== 'string' || !/^[a-f0-9]{64}$/.test(row.token)) return fail();
    if (ids.has(row.id) || tokens.has(row.token)) return fail();
    ids.add(row.id); tokens.add(row.token);
    const allowed = row.kind === 'user' ? ['id', 'owner_id', 'kind', 'token'] : ['id', 'owner_id', 'kind', 'token', 'source_id', 'source_epoch', 'capabilities'];
    if (Object.keys(row).some(key => !allowed.includes(key))) return fail();
    let principal: Principal = { id: row.id, owner_id: row.owner_id, kind: 'user' };
    if (row.kind === 'source') {
      if (!validId(row.source_id) || !validId(row.source_epoch) || !Array.isArray(row.capabilities) || row.capabilities.some(c => typeof c !== 'string' || !['publish', 'read_responses', 'reply', 'deliver'].includes(c)) || new Set(row.capabilities).size !== row.capabilities.length) return fail();
      const sourceKey = JSON.stringify([row.owner_id, row.source_id]);
      if (sources.has(sourceKey)) return fail();
      sources.add(sourceKey);
      principal = { id: row.id, owner_id: row.owner_id, kind: 'source', source_id: row.source_id, source_epoch: row.source_epoch, capabilities: row.capabilities as string[] };
    }
    return { hash: digest(row.token), principal };
  });
  return {
    authenticate(header) {
      const match = /^Bearer ([a-f0-9]{64})$/i.exec(header ?? '');
      const hash = digest(match?.[1] ?? '');
      let found: Principal | undefined;
      for (const entry of entries) { if (timingSafeEqual(hash, entry.hash) && match) found = entry.principal; }
      if (!found) throw new ApiError(401, 'UNAUTHENTICATED', 'A valid Bearer token is required');
      return found;
    },
    actor(id) { return entries.find(e => e.principal.id === id)?.principal; },
    user(owner, id) {
      return entries.map(e => e.principal).find((p): p is Extract<Principal, { kind: 'user' }> => p.kind === 'user' && p.owner_id === owner && p.id === id);
    },
    source(owner, id, epoch) {
      return entries.map(e => e.principal).find((p): p is Extract<Principal, { kind: 'source' }> => p.kind === 'source' && p.owner_id === owner && p.source_id === id && p.source_epoch === epoch);
    },
  };
}

// Reopen the current private file on every request: revocation never uses stale cached grants.
export function fileRegistry(path: string, allowEmpty = false): RegistryProvider {
  return () => {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 65536 || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw unavailable();
      // Bound the actual read as well as fstat: the file can grow after inspection.
      const buffer = Buffer.alloc(65537);
      let size = 0;
      while (size < buffer.length) {
        const read = readSync(fd, buffer, size, buffer.length - size, null);
        if (read === 0) break;
        size += read;
      }
      if (size > 65536) throw unavailable();
      return parseRegistry(JSON.parse(buffer.subarray(0, size).toString('utf8')), allowEmpty);
    } catch { throw unavailable(); }
    finally { if (fd !== undefined) closeSync(fd); }
  };
}
