import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class HostError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function requireHost(value: unknown, code: string): asserts value {
  if (!value) throw new HostError(code);
}
export const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (record(v)) return `{${Object.entries(v).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  return JSON.stringify(v);
}
export const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
export const stableId = (kind: string, ...values: unknown[]) => `${kind}_${digest(values)}`;

export function noSymlinks(path: string) {
  requireHost(process.platform !== 'win32' && isAbsolute(path) && resolve(path) === path, 'POSIX_ABSOLUTE_PATH_REQUIRED');
  let part = parse(path).root;
  for (const component of path.slice(part.length).split('/')) {
    if (!component) continue;
    part = join(part, component);
    if (existsSync(part)) requireHost(!lstatSync(part).isSymbolicLink(), 'SYMLINK_NOT_ALLOWED');
    else { // existsSync follows broken symlinks; lstat still detects them.
      try { requireHost(!lstatSync(part).isSymbolicLink(), 'SYMLINK_NOT_ALLOWED'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}
export function privateDirectory(path: string, create = false) {
  noSymlinks(path);
  if (create && !existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const s = lstatSync(path);
  requireHost(s.isDirectory() && s.uid === process.getuid?.() && (s.mode & 0o077) === 0, 'PRIVATE_DIRECTORY_REQUIRED');
}
export function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function privateBytes(path: string, limit: number): { bytes: Buffer; dev: number; ino: number } {
  noSymlinks(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    requireHost(s.isFile() && s.uid === process.getuid?.() && (s.mode & 0o077) === 0 && s.size <= limit, 'PRIVATE_FILE_REQUIRED');
    const bytes = Buffer.alloc(s.size + 1); let length = 0;
    while (length < bytes.length) { const n = readSync(fd, bytes, length, bytes.length - length, null); if (!n) break; length += n; }
    requireHost(length <= s.size && fstatSync(fd).size === s.size, 'FILE_CHANGED_DURING_READ');
    return { bytes: bytes.subarray(0, length), dev: s.dev, ino: s.ino };
  } finally { closeSync(fd); }
}
export function privateText(path: string, limit: number): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(privateBytes(path, limit).bytes);
}
export function privateJson(path: string, limit = 65536): unknown { return JSON.parse(privateText(path, limit)); }
export function syncFile(path: string) {
  noSymlinks(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    requireHost(s.isFile() && s.uid === process.getuid?.() && (s.mode & 0o077) === 0, 'PRIVATE_FILE_REQUIRED');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
/** Caller holds the dedicated owner lock. Atomic replacement is only for its own named artifacts. */
export function saveJson(path: string, value: unknown, exclusive = false) {
  privateDirectory(dirname(path)); noSymlinks(path);
  requireHost(!exclusive || !existsSync(path), 'ARTIFACT_ALREADY_EXISTS');
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  requireHost(!exclusive || !existsSync(path), 'ARTIFACT_ALREADY_EXISTS');
  renameSync(tmp, path); syncDirectory(dirname(path));
}
export function newPrivateFile(path: string) {
  privateDirectory(dirname(path)); noSymlinks(path);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
