// Owned loopback fault transport only. Canonical device URL and exact upstream service stay unchanged.
import { createServer, request as upstreamRequest } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.umask(0o077);
if (process.env.NOTIONAPP_ACK_PROXY !== '1' || !/^\d+$/.test(process.argv[2] ?? '')) throw new Error('Explicit owned ACK proxy and original loopback upstream port required');
const port = Number(process.argv[2]); if (port < 1 || port > 65535) throw new Error('Invalid original upstream port');
const root = mkdtempSync(join(tmpdir(), 'notifier-ack-proxy-'));
let original; const attempts = [];
const save = () => writeFileSync(root + '/observation-private.json', JSON.stringify({ original, attempts, immutable_upstream: `http://127.0.0.1:${port}` }), { mode: 0o600 });
const server = createServer((request, response) => {
  const chunks = []; let size = 0;
  request.on('data', chunk => { size += chunk.length; if (size > 65536) request.destroy(); else chunks.push(chunk); });
  request.on('end', () => {
    const body = Buffer.concat(chunks); let responseId;
    if (request.method === 'POST' && /^\/v1\/events\/[A-Za-z0-9_-]+\/responses$/.test(request.url ?? '')) {
      try { responseId = JSON.parse(body.toString()).response_id; } catch { /* The real service will reject invalid input. */ }
    }
    const armed = existsSync(root + '/arm-response.signal') && !existsSync(root + '/release-response.signal');
    if (!original && armed && typeof responseId === 'string') original = { id: responseId, path: request.url, body_hash: createHash('sha256').update(body).digest('hex') };
    const drop = armed && original && responseId === original.id;
    if (drop && (request.url !== original.path || createHash('sha256').update(body).digest('hex') !== original.body_hash)) { request.destroy(); return; }
    const target = upstreamRequest({ host: '127.0.0.1', port, method: request.method, path: request.url, headers: { ...request.headers, connection: 'close' } }, result => {
      if (!drop) { response.writeHead(result.statusCode ?? 503, result.headers); result.pipe(response); return; }
      result.resume(); result.on('end', () => {
        attempts.push({ id: responseId, body_hash: original.body_hash, path: request.url, status: result.statusCode, ack_delivered: false }); save();
        request.socket.destroy();
      });
    });
    target.on('error', () => { if (drop) { attempts.push({ id: responseId, path: request.url, upstream_effect_unknown: true }); save(); } request.socket.destroy(); });
    target.end(body);
  });
});
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
save(); console.log(JSON.stringify({ fixture: 'original-ack-proxy', private_root: root, port: server.address().port, original_upstream_port: port }));
let stopping = false;
const close = () => { if (stopping) return; stopping = true; server.close(() => { console.log(JSON.stringify({ stopped: true, original_data_retained: true })); }); server.closeAllConnections(); };
process.once('SIGTERM', close); process.once('SIGINT', close);
