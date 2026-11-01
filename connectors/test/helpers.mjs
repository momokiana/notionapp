import { mkdtempSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { config } from '../src/validation.mjs';

export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'connector-synthetic-')); chmodSync(root, 0o700);
  const c = config({ spool: join(root, 'spool.sqlite'), allow_loopback_http: true,
    server: { base: 'http://127.0.0.1:3000', owner_id: 'synthetic_owner', id: 'synthetic_actor', source_id: 'synthetic_source', source_epoch: 'epoch_1', installation: 'synthetic_install', token: randomBytes(32).toString('hex') } });
  return { root, c, save() { const p = join(root, 'config.json'); writeFileSync(p, JSON.stringify(c), { mode: 0o600 }); return p; } };
}
export const createInput = (overrides = {}) => ({ id: 'operation_1', kind: 'create', payload: { request_id: 'request_1', title: 'Synthetic build', body: '中文 😀', session_ref: 'synthetic_job', target_revision: 'revision_1', expires_at: '2099-01-01T00:00:00Z', ...overrides } });
export async function http(t, handler) {
  const s = createServer(handler); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(async () => { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); });
  return { server: s, origin: `http://127.0.0.1:${s.address().port}` };
}
export async function jsonBody(req) { const chunks = []; for await (const b of req) chunks.push(b); return Buffer.concat(chunks).toString(); }
export function json(res, v, code = 200, headers = {}) { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(v)); }
export function self(c) { const { token, base, installation, ...value } = c.server; return { ...value, capabilities: ['publish'], binding_protocol: 1 }; }
