import { boundedBody, request } from './transport.mjs';
import { fail, seq, string } from './validation.mjs';

export const UNIFLO_COMMIT = '4dbda948068e2f8ce288dc2c2e56777ca88274e0';
const MAX_LINE = 65536;
const observing = new WeakSet();
/** Fatal UTF-8 decoding, bounded lines across chunks; never persist raw upstream text. */
export async function* ndjson(body) {
  if (!body) fail('INVALID_STREAM');
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let pending = Buffer.alloc(0);
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      const all = Buffer.concat([pending, value]); let start = 0, end;
      while ((end = all.indexOf(10, start)) >= 0) {
        const line = all.subarray(start, end); if (line.length > MAX_LINE) fail('STREAM_LINE_TOO_LARGE');
        if (line.length) yield JSON.parse(decoder.decode(line)); start = end + 1;
      }
      pending = Buffer.from(all.subarray(start)); if (pending.length > MAX_LINE) fail('STREAM_LINE_TOO_LARGE');
    }
    // A cut-off final envelope is not an acknowledged observation.
    if (pending.length) fail('INCOMPLETE_STREAM_LINE');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function validateSession(v, key) {
  if (!v || v.key !== key || typeof v.harness !== 'string' || typeof v.id !== 'string' || `${v.harness}:${v.id}` !== key || !['work', 'idle'].includes(v.status)) fail('INVALID_SESSION_SNAPSHOT');
  string(v.harness, 80, true); return v.status;
}
function headerSeq(response) {
  const v = response.headers.get('x-uniflo-seq'); if (v === null || !/^\d{1,16}$/.test(v)) fail('INVALID_SEQUENCE'); return seq(Number(v));
}
function summary(selection, state, n, mode, eventKind) {
  return { source: 'uniflo', alias: selection.alias, state, upstream_seq: n, mode, history_complete: false, read_only: true,
    observed_at: new Date().toISOString(), ...(eventKind ? { event_kind: eventKind } : {}) };
}
/** One snapshot + stream connection. Caller reconnects after an explicit gap, never claims full catch-up. */
export async function observeOnce(spool, { signal, onObservation } = {}) {
  const c = spool.c; if (!c.uniflo) fail('UNIFLO_NOT_CONFIGURED');
  if (observing.has(spool)) fail('OBSERVER_BUSY');
  observing.add(spool);
  const u = c.uniflo;
  const watermarks = new Map(), known = new Map(); let stream, generation;
  try {
    generation = spool.beginObservation();
    const health = await request(`${u.origin}/v1/health`, { token: u.token, signal });
    if (health.status !== 200) { await health.body?.cancel(); fail('UNIFLO_UNAVAILABLE'); }
    const h = JSON.parse(await boundedBody(health, 4096));
    if (h.schema !== 1 || h.ok !== true) fail('UNIFLO_SCHEMA_UNSUPPORTED'); seq(h.seq);
    for (const s of u.sessions) {
      const r = await request(`${u.origin}/v1/sessions/${encodeURIComponent(s.key)}`, { token: u.token, signal });
      let state, n;
      if (r.status === 404) { await r.body?.cancel(); state = 'unavailable'; n = h.seq; }
      else {
        if (r.status !== 200) { await r.body?.cancel(); fail('UNIFLO_UNAVAILABLE'); }
        n = headerSeq(r); state = validateSession(JSON.parse(await boundedBody(r, 65536)), s.key); known.set(s.key, state);
      }
      // A daemon restart during this snapshot set is not a consistent baseline.
      if (n < h.seq) fail('SEQUENCE_ROLLBACK');
      watermarks.set(s.key, n);
      spool.observe(s.key, summary(s, state, n, generation === 1 ? 'baseline' : 'snapshot_after_gap'), n, generation, { snapshot: true });
      await onObservation?.();
    }
    const since = Math.min(...watermarks.values());
    const query = new URLSearchParams({ since: String(since), session: u.sessions.map(s => s.key).join(','), types: 'session,event,removed', max_text: '1' });
    stream = await request(`${u.origin}/v1/stream.ndjson?${query}`, { token: u.token, signal, timeout: 60000 });
    if (stream.status !== 200) { await stream.body?.cancel(); fail('UNIFLO_UNAVAILABLE'); }
    let hello = false;
    for await (const v of ndjson(stream.body)) {
      if (!v || typeof v.type !== 'string') fail('INVALID_STREAM'); seq(v.seq);
      if (v.type === 'hello') {
        if (hello || v.seq < Math.max(...watermarks.values())) fail('SEQUENCE_ROLLBACK');
        hello = true; continue; // hello is current head, NOT the processed replay watermark
      }
      if (!hello) fail('MISSING_STREAM_HELLO');
      if (v.type === 'lagged') fail('STREAM_LAGGED');
      if (!['session', 'event', 'removed'].includes(v.type)) continue; // schema v1 additive type
      const key = v.type === 'session' ? v.session?.key : v.type === 'event' ? v.event?.session : v.key;
      const selected = u.sessions.find(s => s.key === key); if (!selected) continue;
      if (v.seq <= watermarks.get(key)) continue;
      let state, kind;
      if (v.type === 'session') { state = validateSession(v.session, key); known.set(key, state); }
      else if (v.type === 'removed') { state = 'removed'; known.delete(key); }
      else {
        if (!known.has(key)) fail('METADATA_REQUIRED');
        state = known.get(key);
        // Only a fixed category leaves the machine, never upstream IDs/text/tool names.
        kind = ['assistant_message', 'turn_start', 'turn_end', 'system', 'usage', 'user_message', 'tool_call', 'tool_result', 'reasoning'].includes(v.event.kind) ? v.event.kind : 'other';
      }
      spool.observe(key, summary(selected, state, v.seq, 'live_observation', kind), v.seq, generation);
      watermarks.set(key, v.seq); // advance only after metadata + outbox committed
      await onObservation?.();
    }
    fail('STREAM_ENDED');
  } catch (e) {
    // Static reason vocabulary; raw upstream errors can contain paths, text or credentials.
    const reasons = ['STREAM_LAGGED', 'SEQUENCE_ROLLBACK', 'METADATA_REQUIRED', 'STREAM_ENDED', 'SPOOL_FULL', 'UNIFLO_SCHEMA_UNSUPPORTED'];
    if (generation !== undefined) {
      try { spool.disconnected(reasons.includes(e.message) ? e.message : signal?.aborted ? 'STOPPED' : 'OBSERVATION_GAP', generation); } catch {} // retain the primary failure and never overwrite a newer generation
    }
    throw e;
  } finally {
    if (stream?.body && !stream.body.locked) await stream.body.cancel().catch(() => {});
    observing.delete(spool);
  }
}
