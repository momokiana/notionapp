import { openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';

export const ARTIFACT = Object.freeze({
  version: '0.2.6', commit: '4dbda948068e2f8ce288dc2c2e56777ca88274e0',
  url: 'https://github.com/Crosery/uniflo/releases/download/v0.2.6/uniflo-0.2.6-x86_64-unknown-linux-musl.tar.gz',
  archive_sha256: '3787f11f7a46581a86eb6101dd9b5905ad0a28d80cc96ae2806d16a62b631973',
  binary_sha256: 'e5d8c89633bac3f08d7f3a2ef8dec702579aceaf63878b79bc254c4894e7c996',
  bytes: 18720856, platform: 'linux-x64-musl', license: 'MIT',
});
export function verifyArtifact(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw Error('EXPLICIT_UNIFLO_BINARY_REQUIRED');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd); if (!s.isFile() || s.size !== ARTIFACT.bytes) throw Error('UNIFLO_ARTIFACT_SIZE');
    const h = createHash('sha256'), buffer = Buffer.alloc(65536); let total = 0;
    while (total <= ARTIFACT.bytes) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, ARTIFACT.bytes + 1 - total), null);
      if (!n) break; total += n; h.update(buffer.subarray(0, n));
    }
    if (total !== ARTIFACT.bytes || h.digest('hex') !== ARTIFACT.binary_sha256) throw Error('UNIFLO_ARTIFACT_HASH');
    return { version: ARTIFACT.version, sha256: ARTIFACT.binary_sha256, bytes: total };
  } finally { closeSync(fd); }
}
