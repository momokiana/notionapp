import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { loadConfig } from '../../src/config.js';
import { initialize, NativeSession, status } from '../../src/native.js';
import { AppRuntime } from '../../src/runtime.js';
import { fakeModels, ask } from '../helpers.js';

process.umask(0o077);
const [mode, path] = process.argv.slice(2);
if (!path) throw new Error('Test fixture config required');
const config = loadConfig(path);
const die = (): never => { fs.writeSync(1, `fault:${mode}\n`); process.kill(process.pid, 'SIGKILL'); throw new Error('SIGKILL was not delivered'); };
if (mode?.startsWith('init-')) {
  if (mode === 'init-native-ready') {
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === join(config.data_dir, 'manifest.json')) die(); return rename(from, to); };
  } else if (mode === 'init-partial-native') {
    const write = fs.writeFileSync;
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (typeof data === 'string' && data.includes(JSON.stringify(config.initialPrompt))) die();
      return write(file, data, options);
    }) as typeof fs.writeFileSync;
  } else if (mode === 'init-only-pending') {
    const open = fs.openSync;
    fs.openSync = ((file: fs.PathLike, flags: fs.OpenMode, permissions?: fs.Mode) => {
      if (file === join(config.data_dir, 'ledger.sqlite')) die();
      return open(file, flags, permissions);
    }) as typeof fs.openSync;
  }
  syncBuiltinESMExports(); initialize(config);
} else if (mode === 'status') console.log(JSON.stringify(status(config)));
else if (mode === 'hold-owner') {
  const native = new NativeSession(config); console.log('owner-ready');
  await new Promise<void>(resolve => { process.stdin.once('data', () => resolve()); process.stdin.resume(); });
  native.close(); process.stdin.pause();
} else if (mode === 'ambient-auth') {
  // Caller supplies only a synthetic env key and an empty isolated HOME, never real credentials.
  let r: AppRuntime | undefined;
  try { r = await AppRuntime.open(config); console.log('unexpected-ambient-auth'); process.exitCode = 2; }
  catch { console.log('ambient-auth-rejected'); }
  finally { await r?.close(); }
} else {
  const model = await fakeModels(dirname(path), mode === 'bootstrap-ack-loss' ? [ask()] : [{ text: '持久来源结果；并非独立验收。' }]);
  const r = await AppRuntime.open(config, { modelRuntime: model.runtime,
    ...(mode === 'native-before-public-receipt' ? { wrapHost: host => ({ synchronousDurableGate: true as const,
      getReceipt: id => host.getReceipt(id), compareAndEnqueue: (command, now) => { host.compareAndEnqueue(command, now); return die(); } }) } : {}) });
  if (mode === 'run-before-control') r.session.sendCustomMessage = async () => die();
  if (mode === 'bootstrap-ack-loss') {
    const create = r.core.create.bind(r.core);
    r.core.create = (...args) => { create(...args); return die(); };
  }
  if (mode === 'report-before-db' || mode === 'report-after-db-before-ack') {
    const update = r.delivery.update.bind(r.delivery);
    r.delivery.update = (...args) => { if (mode === 'report-after-db-before-ack') update(...args); return die(); };
  }
  try { await r.runOnce(); }
  finally { await r.close(); }
}
