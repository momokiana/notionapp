// Read only immutable public Git blobs; never copy a working server tree or native binary.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const repo = process.env.WEB_PUBLIC_REPO;
if (!repo) throw new Error('Set WEB_PUBLIC_REPO to a checkout of https://github.com/momokiana/notionapp');
const commit = '0a745c88fbba495f145263e5384af24215c394b2';
const git = path => execFileSync('git', ['-C', resolve(repo), 'show', commit + ':' + path], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
const sha = b => createHash('sha256').update(b).digest('hex');
const manifest = git('docs/releases/initial-export.json');
if (sha(manifest) !== 'c5e2fbcf80fffb0d1f1c28b69423f3f008fddd0638f521d8670f11d2f6bec1cc') throw new Error('Manifest mismatch');
const files = JSON.parse(manifest).components.find(c => c.component === 'server').files.sort((a,b) => a.path.localeCompare(b.path));
if (files.length !== 64) throw new Error('Expected exactly 64 backend files');
const out = resolve('.local/baseline');
if (existsSync(out)) throw new Error('Destination exists; preserve it, do not overwrite');
const blobs = files.map(f => {
  if (!/^server\/[A-Za-z0-9_./-]+$/.test(f.path) || f.path.includes('..')) throw new Error('Invalid manifest path');
  const blob = git(f.path), hash = sha(blob);
  if (hash !== f.source_sha256 || hash !== f.public_sha256) throw new Error('Blob mismatch');
  return { path: f.path, blob, hash };
});
const table = blobs.map(f => f.hash + '  ' + f.path + '\n').join('');
if (sha(table) !== 'f05bb7fb4369f07718e3bcca47d177cda34a413edd55802a9381bc15d832e967') throw new Error('Table mismatch');
for (const f of blobs) { const path = resolve(out, f.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, f.blob, { flag: 'wx' }); }
writeFileSync(resolve(out,'server64.sha256'), table, { flag: 'wx' });
console.log('Exported exactly 64 unchanged backend files at public commit ' + commit);
