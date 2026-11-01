import { fail, object, id, version, string, sourceBinding } from './validation.mjs';

export async function boundedBody(response, max) {
  if (!response.body) fail('INVALID_HTTP_RESPONSE');
  const reader = response.body.getReader(); const chunks = []; let n = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      n += value.byteLength; if (n > max) fail('HTTP_RESPONSE_TOO_LARGE'); chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function request(url, { token, method = 'GET', body, binding, signal, timeout = 5000 } = {}) {
  const deadline = AbortSignal.timeout(timeout);
  return fetch(url, {
    method, redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(binding ? { 'x-notionapp-source-binding': binding } : {}) },
    ...(body ? { body } : {}),
  });
}
export async function identity(c, signal) {
  const r = await request(`${c.server.base}/v1/source/self`, { token: c.server.token, signal });
  if (r.status !== 200) { await r.body?.cancel(); fail('SOURCE_PROTOCOL_UNAVAILABLE'); }
  let v; try { v = JSON.parse(await boundedBody(r, 4096)); } catch { fail('SOURCE_PROTOCOL_UNAVAILABLE'); }
  object(v, ['id', 'owner_id', 'source_id', 'source_epoch', 'capabilities', 'binding_protocol']);
  for (const k of ['id', 'owner_id', 'source_id', 'source_epoch']) if (id(v[k]) !== c.server[k]) fail('SOURCE_BINDING_MISMATCH');
  if (v.binding_protocol !== 1 || !Array.isArray(v.capabilities) || v.capabilities.some(x => !['publish', 'read_responses', 'reply', 'deliver'].includes(x)) || new Set(v.capabilities).size !== v.capabilities.length || !v.capabilities.includes('publish')) fail('SOURCE_PROTOCOL_UNAVAILABLE');
  if (c.uniflo && (v.capabilities.length !== 1 || v.capabilities[0] !== 'publish')) fail('OBSERVATION_REQUIRES_PUBLISH_ONLY');
}
export function receipt(row, value) {
  object(value, ['event_id', 'event_version', 'saved_at']); id(value.event_id); version(value.event_version); string(value.saved_at, 40, true);
  if (!Number.isFinite(Date.parse(value.saved_at))) fail('INVALID_RECEIPT');
  const sent = JSON.parse(row.wire);
  if (row.kind === 'create' ? value.event_version !== 1 : (value.event_id !== row.event_id || value.event_version !== sent.expected_event_version + 1)) fail('RECEIPT_TARGET_MISMATCH');
  return value;
}
/** Only database-publish idempotent replay, never native input or external-effect retry. */
export async function flush(spool, { signal, max = 100, afterResponse } = {}) {
  await identity(spool.c, signal); let saved = 0;
  while (saved < max && !signal?.aborted) {
    const row = spool.prepare(); if (!row) break;
    const path = row.kind === 'create' ? '/v1/events' : `/v1/events/${encodeURIComponent(row.event_id)}/updates`;
    let r;
    try {
      r = await request(`${spool.c.server.base}${path}`, { token: spool.c.server.token, method: 'POST', body: row.wire, binding: sourceBinding(spool.c), signal });
      if (r.status !== 200) {
        const status = r.status; await r.body?.cancel();
        if (status >= 400 && status < 500) { spool.blocked(row, `HTTP_${status}`); fail('PUBLISH_BLOCKED'); }
        fail('PUBLISH_UNKNOWN');
      }
      const ack = receipt(row, JSON.parse(await boundedBody(r, 4096)));
      await afterResponse?.(row, ack); // test dependency only; no dynamic config or plugin loading
      spool.saved(row, ack); saved++;
    } catch (e) {
      if (e.message === 'PUBLISH_BLOCKED') throw e;
      fail('PUBLISH_UNKNOWN'); // no upstream URL/body/error disclosure; fixed original wire is retained
    }
  }
  return { state: 'event_saved', count: saved, meaning: 'database_commit_only' };
}
