import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeSync, type Stats } from 'node:fs';
import { basename, dirname } from 'node:path';
import { backupHash } from './backup-format.js';
import { HostError, noSymlinks, requireHost } from './private-files.js';

export interface BackupFileRead { bytes: Buffer; dev: number; ino: number; size: number; mtime: number; ctime: number }
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
function privateParent(path: string) {
  noSymlinks(path); const value = lstatSync(path);
  requireHost(value.isDirectory() && value.uid === process.getuid?.() && (value.mode & 0o777) === 0o700, 'BACKUP_PRIVATE_PARENT_REQUIRED');
  return value;
}
function controlled(error: unknown, fallback: string): never {
  if (error instanceof HostError) throw error;
  throw new HostError(fallback); // Never forward a filesystem path or parser body into normal CLI output.
}

/** Fixed bounded source records only. This helper does not follow a directory or a path contained in an archive. */
export function readBackupFile(path: string, maxBytes: number): BackupFileRead {
  let fd: number | undefined;
  try {
    noSymlinks(path); requireHost(Number.isSafeInteger(maxBytes) && maxBytes >= 1 && maxBytes <= 160 * 1024 * 1024, 'BACKUP_INPUT_LIMIT_REQUIRED');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    requireHost(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size >= 1 && stat.size <= maxBytes, 'BACKUP_PRIVATE_INPUT_REQUIRED');
    const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, null); if (!count) break; offset += count; }
    const after = fstatSync(fd); const pathAfter = lstatSync(path);
    requireHost(offset === stat.size && same(stat, after) && same(stat, pathAfter) && after.size === stat.size
      && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs && !pathAfter.isSymbolicLink(), 'BACKUP_INPUT_CHANGED');
    return { bytes: bytes.subarray(0, offset), dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs };
  } catch (error) { return controlled(error, 'BACKUP_INPUT_UNAVAILABLE'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function readBackupKey(path: string): Buffer {
  try {
    privateParent(dirname(path)); noSymlinks(path);
    const stat = lstatSync(path);
    requireHost(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.size === 32, 'BACKUP_KEY_INVALID');
    const value = readBackupFile(path, 32); const after = lstatSync(path);
    requireHost(value.bytes.length === 32 && after.dev === value.dev && after.ino === value.ino && after.nlink === 1 && (after.mode & 0o777) === 0o600, 'BACKUP_KEY_INVALID');
    return value.bytes;
  } catch (error) { return controlled(error, 'BACKUP_KEY_INVALID'); }
}

/** Caller owns exactly this new path. No overwrite/rename/unlink or success before file and original-parent barriers. */
export function writeBackupFileExclusive(path: string, bytes: Buffer): { bytes: number; sha256: string } {
  let parentFd: number | undefined; let fd: number | undefined;
  try {
    noSymlinks(path); requireHost(Buffer.isBuffer(bytes) && bytes.length >= 1, 'BACKUP_OUTPUT_BYTES_REQUIRED');
    const parent = dirname(path); const before = privateParent(parent);
    parentFd = openSync(parent, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    requireHost(same(before, fstatSync(parentFd)), 'BACKUP_OUTPUT_PARENT_CHANGED');
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HostError('BACKUP_OUTPUT_EXISTS'); throw error; }
    const owned = fstatSync(fd);
    requireHost(owned.isFile() && owned.uid === process.getuid?.() && (owned.mode & 0o777) === 0o600 && owned.nlink === 1, 'BACKUP_PRIVATE_OUTPUT_REQUIRED');
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, null);
      requireHost(Number.isSafeInteger(count) && count > 0 && count <= bytes.length - offset, 'BACKUP_SHORT_WRITE'); offset += count;
    }
    fsyncSync(fd);
    const fileAfter = lstatSync(path); const parentAfter = privateParent(parent);
    requireHost(same(owned, fileAfter) && fileAfter.isFile() && fileAfter.size === bytes.length && fileAfter.nlink === 1
      && (fileAfter.mode & 0o777) === 0o600 && same(before, parentAfter), 'BACKUP_OUTPUT_CHANGED');
    fsyncSync(parentFd); // Held descriptor: exact original parent, not a newly looked-up substitute.
    requireHost(same(before, privateParent(parent)) && same(owned, lstatSync(path)), 'BACKUP_OUTPUT_CHANGED');
    return { bytes: bytes.length, sha256: backupHash(bytes) };
  } catch (error) { return controlled(error, 'BACKUP_WRITE_UNAVAILABLE'); }
  finally { try { if (fd !== undefined) closeSync(fd); } finally { if (parentFd !== undefined) closeSync(parentFd); } }
}

/** New inert stage root. The caller keeps this parent's descriptor until every child and the completion boundary is synced. */
export function createBackupStageRoot(path: string): { close: () => void; finish: () => void } {
  let parentFd: number | undefined;
  try {
    noSymlinks(path); const parent = dirname(path); const before = privateParent(parent);
    requireHost(basename(path) !== '.' && basename(path) !== '..', 'BACKUP_STAGE_PATH_INVALID');
    parentFd = openSync(parent, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    requireHost(same(before, fstatSync(parentFd)), 'BACKUP_OUTPUT_PARENT_CHANGED');
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HostError('BACKUP_OUTPUT_EXISTS'); throw error; }
    const stage = privateParent(path); fsyncSync(parentFd);
    let closed = false; const ownedParent = parentFd; parentFd = undefined;
    return {
      close: () => { if (!closed) { closed = true; closeSync(ownedParent); } },
      finish: () => {
        requireHost(!closed && same(stage, privateParent(path)) && same(before, privateParent(parent)), 'BACKUP_OUTPUT_CHANGED');
        const stageFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
        try { requireHost(same(stage, fstatSync(stageFd)), 'BACKUP_OUTPUT_CHANGED'); fsyncSync(stageFd); } finally { closeSync(stageFd); }
        fsyncSync(ownedParent);
        requireHost(same(stage, privateParent(path)) && same(before, privateParent(parent)), 'BACKUP_OUTPUT_CHANGED');
      },
    };
  } catch (error) { return controlled(error, 'BACKUP_STAGE_UNAVAILABLE'); }
  finally { if (parentFd !== undefined) closeSync(parentFd); }
}
