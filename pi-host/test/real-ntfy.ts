import { mkdtempSync, writeFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

/** Never connects to an operator-supplied service. Only an explicitly selected binary and fresh Unix socket. */
export async function realNtfy(binary: string, androidSubscriber = false) {
  if (!isAbsolute(binary) || !/^ntfy version 2\.34\.0\b/m.test(execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 }))) throw new Error('This fixture requires the verified official ntfy 2.34.0 binary');
  const root = mkdtempSync(join(tmpdir(), 'notionapp-ntfy-test-')); const socket = join(root, 'ntfy.sock'); const config = join(root, 'server.yml');
  writeFileSync(config, JSON.stringify({ 'listen-http': '-', 'listen-unix': socket, 'listen-unix-mode': 384,
    'auth-file': join(root, 'auth.db'), 'auth-default-access': 'deny-all', 'cache-file': join(root, 'cache.db'),
    'web-root': 'disable', 'enable-signup': false, 'enable-login': false, 'upstream-base-url': '', 'firebase-key-file': '', 'attachment-cache-dir': '', 'log-level': 'WARN' }), { mode: 0o600 });
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, NTFY_CONFIG_FILE: config };
  const fd = openSync(join(root, 'private-ntfy.log'), 'a', 0o600); let child: ChildProcess | undefined;
  const proxy = createServer((req, res) => {
    const upstream = request({ socketPath: socket, path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve)); const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Owned loopback listener unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const c = child; const done = once(c, 'exit'); c.kill('SIGTERM'); const timer = setTimeout(() => c.kill('SIGKILL'), 10000);
      try { const [code] = await done; if (code !== 0) throw new Error('Owned ntfy did not stop cleanly'); } finally { clearTimeout(timer); }
    }
    child = undefined;
  };
  const start = async () => {
    const mask = process.umask(0o077); try { child = spawn(binary, ['serve'], { env, stdio: ['ignore', fd, fd] }); } finally { process.umask(mask); }
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error('Owned ntfy startup failed; see private fixture log');
      if (existsSync(socket)) { const r = await fetch(origin + '/v1/health', { signal: AbortSignal.timeout(1000) }); const ok = r.ok; await r.body?.cancel(); if (ok) return; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Owned ntfy readiness timeout');
  };
  const close = async () => { try { await stop(); } finally { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); closeSync(fd); } };
  try {
    await start(); await stop(); // 2.34 user CLI requires existing initialized auth schema.
    execFileSync(binary, ['user', 'add', '--role=admin', 'isolated-fixture'], { env: { ...env, NTFY_PASSWORD: randomBytes(32).toString('hex') }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    const tokenOutput = execFileSync(binary, ['token', 'add', 'isolated-fixture'], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).toString();
    const token = tokenOutput.match(/\btk_[A-Za-z0-9_-]+/)?.[0]; if (!token) throw new Error('Private fixture token unavailable');
    // Android's unmodified account UI uses Basic auth. This optional synthetic user
    // can only read distributor-created up* topics; it cannot publish or administer.
    const subscriber = androidSubscriber ? { username: 'android-fixture', password: randomBytes(24).toString('hex') } : undefined;
    if (subscriber) {
      execFileSync(binary, ['user', 'add', subscriber.username], { env: { ...env, NTFY_PASSWORD: subscriber.password }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
      execFileSync(binary, ['access', subscriber.username, 'up*', 'read-only'], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    }
    await start();
    return { origin, token, subscriber, close, restart: async () => { await stop(); await start(); },
      messages: async (topic: string) => {
        const r = await fetch(`${origin}/${topic}/json?poll=1&since=all`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
        if (!r.ok) throw new Error('Real private subscriber rejected');
        return (await r.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { id: string; event: string; message: string; encoding?: string }).filter(m => m.event === 'message');
      } };
  } catch (error) { await close(); throw error; }
}
