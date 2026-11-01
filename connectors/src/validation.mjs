import { createHash } from 'node:crypto';
import { openSync, readFileSync, closeSync, fstatSync, lstatSync, realpathSync, constants } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export const MAX_BODY = 65536;
export const fail = code => { throw new Error(code); };
export const hash = value => createHash('sha256').update(value).digest('hex');
export const canonical = value => JSON.stringify(normalize(value));
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])]));
  return v;
}
export function object(v, required, optional = []) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => ![...required, ...optional].includes(k))) fail('INVALID_INPUT');
}
export function string(v, max, nonempty = false) {
  if (typeof v !== 'string' || [...v].length > max || (nonempty && !v.trim()) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) fail('INVALID_INPUT');
  return v;
}
export function id(v) { if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v)) fail('INVALID_INPUT'); return v; }
export function version(v) { if (!Number.isSafeInteger(v) || v < 1) fail('INVALID_INPUT'); return v; }
export function seq(v) { if (!Number.isSafeInteger(v) || v < 0) fail('INVALID_SEQUENCE'); return v; }
function expiry(v) {
  string(v, 40, true);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(v);
  if (!m || +m[1] < 1970 || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate() || +m[4] > 23 || +m[5] > 59 || +m[6] > 59 || !Number.isFinite(Date.parse(v)) || (m[7] !== 'Z' && (+m[7].slice(1, 3) > 23 || +m[7].slice(4) > 59))) fail('INVALID_INPUT');
}
function interaction(v) {
  object(v, ['id', 'actions']); id(v.id);
  if (!Array.isArray(v.actions) || v.actions.length < 1 || v.actions.length > 8) fail('INVALID_INPUT');
  const seen = new Set();
  for (const a of v.actions) {
    object(a, ['id', 'label', 'type']); id(a.id); string(a.label, 100, true);
    if (!['button', 'text'].includes(a.type) || seen.has(a.id)) fail('INVALID_INPUT'); seen.add(a.id);
  }
}
export function payload(v, kind, mapped = false) {
  if (kind === 'create') {
    object(v, ['request_id', 'title', 'body', 'session_ref', 'target_revision', 'expires_at'], ['interaction']);
    id(v.request_id); string(v.title, 200, true); string(v.session_ref, 512, true); string(v.target_revision, 200, true); expiry(v.expires_at);
  } else {
    object(v, ['update_id', ...(mapped ? [] : ['expected_event_version']), 'kind', 'body'], ['title', 'target_revision', 'expires_at', 'interaction']);
    id(v.update_id); if (!mapped) version(v.expected_event_version);
    if (!['progress', 'source_result_reported'].includes(v.kind)) fail('INVALID_INPUT');
    if (v.title !== undefined) string(v.title, 200, true);
    if (v.target_revision !== undefined) string(v.target_revision, 200, true);
    if (v.expires_at !== undefined) expiry(v.expires_at);
  }
  string(v.body, 16000);
  if (Object.hasOwn(v, 'interaction') && !(kind === 'update' && v.interaction === null)) interaction(v.interaction);
  if (Buffer.byteLength(JSON.stringify(v)) > MAX_BODY) fail('INPUT_TOO_LARGE');
  return v;
}
export function operation(v) {
  object(v, ['id', 'kind', 'payload'], ['event_id']); id(v.id);
  if (!['create', 'update'].includes(v.kind)) fail('INVALID_INPUT');
  if (v.kind === 'update') id(v.event_id); else if (Object.hasOwn(v, 'event_id')) fail('INVALID_INPUT');
  payload(v.payload, v.kind); return v;
}
export function origin(raw, allowHttp = false, localOnly = false) {
  if (typeof raw !== 'string') fail('INVALID_ORIGIN');
  let u; try { u = new URL(raw); } catch { fail('INVALID_ORIGIN'); }
  const local = ['127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || (u.protocol !== 'https:' && !(allowHttp && local && u.protocol === 'http:')) || (localOnly && !local)) fail('INVALID_ORIGIN');
  return u.origin;
}
export function config(v) {
  object(v, ['server', 'spool'], ['allow_loopback_http', 'uniflo']);
  if (v.allow_loopback_http !== undefined && typeof v.allow_loopback_http !== 'boolean') fail('INVALID_CONFIG');
  object(v.server, ['base', 'owner_id', 'id', 'source_id', 'source_epoch', 'installation', 'token']);
  for (const k of ['owner_id', 'id', 'source_id', 'source_epoch', 'installation']) id(v.server[k]);
  if (typeof v.server.token !== 'string' || !/^[a-f0-9]{64}$/.test(v.server.token)) fail('INVALID_CONFIG');
  if (typeof v.spool !== 'string' || !isAbsolute(v.spool) || resolve(v.spool) !== v.spool) fail('INVALID_PATH');
  const result = structuredClone(v); result.server.base = origin(v.server.base, v.allow_loopback_http);
  if (v.uniflo !== undefined) {
    object(v.uniflo, ['origin', 'sessions'], ['token']);
    result.uniflo.origin = origin(v.uniflo.origin, true, true);
    if (v.uniflo.token !== undefined && (typeof v.uniflo.token !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(v.uniflo.token))) fail('INVALID_CONFIG');
    if (!Array.isArray(v.uniflo.sessions) || v.uniflo.sessions.length < 1 || v.uniflo.sessions.length > 16) fail('INVALID_CONFIG');
    const seen = new Set();
    for (const s of v.uniflo.sessions) {
      object(s, ['key', 'alias']); string(s.key, 300, true); string(s.alias, 100, true);
      // Comma is the upstream filter delimiter, not part of this supported key subset.
      if (!/^[A-Za-z0-9_-]+:[^,\s\x00-\x1f]+$/.test(s.key) || seen.has(s.key)) fail('INVALID_CONFIG'); seen.add(s.key);
    }
  }
  return result;
}
export const sourceBinding = c => hash(JSON.stringify([c.server.owner_id, c.server.id, c.server.source_id, c.server.source_epoch]));
export const spoolBinding = c => canonical({ server: { ...c.server, token: hash(c.server.token) }, uniflo: c.uniflo ? { ...c.uniflo, token: c.uniflo.token ? hash(c.uniflo.token) : null } : null });
export function privateParent(path) {
  if (process.platform === 'win32' || !isAbsolute(path) || resolve(path) !== path || realpathSync(dirname(path)) !== dirname(path)) fail('PRIVATE_PATH_REQUIRED');
  const p = lstatSync(dirname(path));
  if (!p.isDirectory() || p.uid !== process.getuid() || (p.mode & 0o077)) fail('PRIVATE_PATH_REQUIRED');
}
export function privateStat(s) {
  if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o077) || s.nlink !== 1) fail('PRIVATE_FILE_REQUIRED');
}
export function readPrivate(path, limit = MAX_BODY) {
  privateParent(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd), named = lstatSync(path); privateStat(s);
    if (named.isSymbolicLink() || named.dev !== s.dev || named.ino !== s.ino || s.size > limit) fail('PRIVATE_FILE_REQUIRED');
    const b = readFileSync(fd); if (b.length > limit) fail('INPUT_TOO_LARGE'); return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } finally { closeSync(fd); }
}
