import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ApiError, type Principal, type Registry, type RegistryProvider } from './auth.js';
import type { EventData } from './contracts.js';
import {assertNoRecovery} from './recovery-gate.js';

export const notificationDdl = [
  `CREATE TABLE push_devices (actor TEXT PRIMARY KEY, owner TEXT NOT NULL, registration_id TEXT NOT NULL, endpoint TEXT, generation INTEGER NOT NULL)`,
  `CREATE TABLE notice_batches (intent INTEGER PRIMARY KEY REFERENCES outbox(seq))`,
  `CREATE TABLE notifications (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, intent INTEGER NOT NULL REFERENCES outbox(seq), owner TEXT NOT NULL, actor TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES events(id), version INTEGER NOT NULL, generation INTEGER NOT NULL, endpoint TEXT NOT NULL, nonce TEXT NOT NULL, platform_state TEXT NOT NULL CHECK(platform_state IN ('pending','effect_unknown','platform_accepted','failed','withheld')), device_received_at TEXT, notification_posted_at TEXT, UNIQUE(intent,actor))`,
];
export interface PushConfig { origin: string; token?: string }
export function pushConfig(origin: string, token?: string, allowLocalHttp = false): PushConfig {
  const url = new URL(origin);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(allowLocalHttp && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('PUSH_ORIGIN must be a HTTPS origin (explicit loopback HTTP is test-only)');
  if (token !== undefined && !/^[A-Za-z0-9_-]{12,512}$/.test(token)) throw new Error('Invalid private ntfy publish token');
  return { origin: url.origin, ...(token === undefined ? {} : { token }) };
}
const fail = (status: number, code: string, message: string): never => { throw new ApiError(status, code, message); };
const currentUser = (registry: Registry, owner: string, id: string) => registry.user(owner, id);
const user = (p: Principal) => { if (p.kind !== 'user') fail(403, 'FORBIDDEN', 'User permission is required'); };
interface Device { actor: string; owner: string; registration_id: string; endpoint: string | null; generation: number }
export interface Notice { seq: number; id: string; intent: number; owner: string; actor: string; event_id: string; version: number; generation: number; endpoint: string; nonce: string; platform_state: string; device_received_at: string | null; notification_posted_at: string | null }
export interface PushPayload { event_id: string; event_version: number; delivery_id: string; nonce: string }
export class NotificationStore {
  constructor(private db: Database.Database, private registry: RegistryProvider, private config: PushConfig | undefined, private now: () => number = Date.now) {}
  assertReady() { assertNoRecovery(this.db); }
  private gated<T>(action: () => T): T {
    this.assertReady();
    const checked=()=>{this.assertReady();return action();};
    return this.registry.withAuthority ? this.registry.withAuthority(checked) : checked();
  }
  private endpoint(raw: string) {
    if (!this.config) return fail(503, 'PUSH_NOT_CONFIGURED', 'No push origin is configured');
    let url: URL; try { url = new URL(raw); } catch { return fail(422, 'INVALID_INPUT', 'Invalid ntfy endpoint'); }
    if (url.origin !== this.config.origin || url.username || url.password || url.hash || !/^\/[A-Za-z0-9_-]{1,64}$/.test(url.pathname) || (url.search !== '' && url.search !== '?up=1')) fail(422, 'INVALID_INPUT', 'Endpoint must be a topic on the configured ntfy origin');
    return `${url.origin}${url.pathname}`;
  }
  device(p: Principal) {
    user(p);
    const row = this.db.prepare('SELECT actor,owner,registration_id,generation,endpoint FROM push_devices WHERE actor=? AND owner=?').get(p.id, p.owner_id) as Device | undefined;
    let registered = false;
    if (row?.endpoint && this.config) { try { this.endpoint(row.endpoint); registered = true; } catch { /* Stored endpoint is no longer approved by the current channel configuration. */ } }
    return { configured: !!this.config, generation: row?.generation ?? 0, registration_id: row?.registration_id ?? null, registered };
  }
  register(p: Principal, input: { registration_id: string; expected_generation: number; endpoint: string | null }) {
    user(p); const endpoint = input.endpoint === null ? null : this.endpoint(input.endpoint);
    return this.gated(() => this.db.transaction(() => {
      this.assertReady();
      const scope = JSON.stringify(['push_register', p.owner_id, p.id]);
      const digest = JSON.stringify({ endpoint, expected_generation: input.expected_generation });
      const prior = this.db.prepare('SELECT digest,result FROM operations WHERE scope=? AND id=?').get(scope, input.registration_id) as { digest: string; result: string } | undefined;
      if (prior) { if (prior.digest !== digest) return fail(409, 'IDEMPOTENCY_CONFLICT', 'Registration ID has different content'); return JSON.parse(prior.result) as ReturnType<NotificationStore['device']>; }
      const current = this.device(p);
      if (current.generation !== input.expected_generation) fail(409, 'DEVICE_GENERATION_CONFLICT', 'Refresh the current device registration');
      // Freeze all existing intent audiences before adding/rotating/removing this endpoint.
      // First-ever registration still consumes unassigned pending intents; old assigned work never moves.
      this.batch();
      const generation = current.generation + 1;
      this.db.prepare('INSERT INTO push_devices VALUES (?,?,?,?,?) ON CONFLICT(actor) DO UPDATE SET owner=excluded.owner,registration_id=excluded.registration_id,endpoint=excluded.endpoint,generation=excluded.generation').run(p.id, p.owner_id, input.registration_id, endpoint, generation);
      const result = this.device(p);
      this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(scope, input.registration_id, digest, JSON.stringify(result)); return result;
    }).immediate());
  }
  /** Freeze each intent's device/endpoint-generation audience once. Never repoint old work after rotation. */
  private batch() {
    // Audience freezing is local bookkeeping even while publishing is disabled (e.g. endpoint removal).
    const registry = this.registry();
    let after = 0;
    while (true) {
      const intents = this.db.prepare("SELECT o.seq,o.event_id,o.version,e.owner,e.data FROM outbox o JOIN events e ON e.id=o.event_id LEFT JOIN notice_batches b ON b.intent=o.seq WHERE o.state='pending' AND b.intent IS NULL AND o.seq>? AND EXISTS(SELECT 1 FROM push_devices d WHERE d.owner=e.owner AND d.endpoint IS NOT NULL) ORDER BY o.seq LIMIT 100").all(after) as { seq: number; event_id: string; version: number; owner: string; data: string }[];
      if (!intents.length) break;
      for (const i of intents) {
        after = i.seq;
        const event = JSON.parse(i.data) as EventData; if (event.disposition !== 'open') continue;
        const devices = (this.db.prepare('SELECT * FROM push_devices WHERE owner=? AND endpoint IS NOT NULL').all(i.owner) as Device[]).filter(d => currentUser(registry, i.owner, d.actor));
        if (!devices.length) continue;
        this.db.prepare('INSERT INTO notice_batches VALUES (?)').run(i.seq);
        for (const d of devices) this.db.prepare("INSERT INTO notifications(id,intent,owner,actor,event_id,version,generation,endpoint,nonce,platform_state) VALUES (?,?,?,?,?,?,?,?,?,'pending')").run(randomUUID(), i.seq, i.owner, d.actor, i.event_id, i.version, d.generation, d.endpoint, randomBytes(32).toString('hex'));
      }
    }
  }
  claim(): Notice | null {
    this.assertReady();
    if (!this.config) return null;
    // Reserve the original unknown publish boundary under authority -> ledger lock order.
    return this.gated(() => this.db.transaction(() => {
      this.assertReady();
      this.batch();
      const registry = this.registry();
      const rows = this.db.prepare("SELECT * FROM notifications WHERE platform_state='pending' ORDER BY seq LIMIT 100").all() as Notice[];
      for (const n of rows) {
        const device = this.db.prepare('SELECT * FROM push_devices WHERE actor=? AND owner=?').get(n.actor, n.owner) as Device | undefined;
        const event = this.db.prepare('SELECT data FROM events WHERE id=?').get(n.event_id) as { data: string };
        const intent = this.db.prepare('SELECT state FROM outbox WHERE seq=?').get(n.intent) as { state: string };
        const active = device && device.generation === n.generation && device.endpoint === n.endpoint && currentUser(registry, n.owner, n.actor) && intent.state === 'pending' && (JSON.parse(event.data) as EventData).disposition === 'open';
        if (!active) { this.db.prepare("UPDATE notifications SET platform_state='withheld' WHERE id=?").run(n.id); continue; }
        try { this.endpoint(n.endpoint); }
        catch { this.db.prepare("UPDATE notifications SET platform_state='withheld' WHERE id=?").run(n.id); continue; }
        this.db.prepare("UPDATE notifications SET platform_state='effect_unknown' WHERE id=?").run(n.id);
        return { ...n, platform_state: 'effect_unknown' };
      }
      return null;
    }).immediate());
  }
  platform(id: string, state: 'platform_accepted' | 'failed') {
    this.assertReady();
    this.db.prepare("UPDATE notifications SET platform_state=? WHERE id=? AND platform_state='effect_unknown'").run(state, id);
  }
  receipt(p: Principal, id: string, input: { nonce: string; state: 'device_received' | 'notification_posted' }) {
    this.assertReady();user(p);
    return this.db.transaction(() => {
      this.assertReady();
      const row = this.db.prepare('SELECT * FROM notifications WHERE id=? AND owner=? AND actor=?').get(id, p.owner_id, p.id) as Notice | undefined;
      if (!row) return fail(404, 'NOT_FOUND', 'Delivery is not visible');
      if (!/^[a-f0-9]{64}$/.test(input.nonce) || !timingSafeEqual(Buffer.from(input.nonce, 'hex'), Buffer.from(row.nonce, 'hex'))) fail(409, 'RECEIPT_MISMATCH', 'Receipt does not match this device delivery');
      if (row.platform_state === 'pending' || row.platform_state === 'withheld') fail(409, 'NOT_PUBLISHED', 'This delivery has not entered the platform boundary');
      const field = input.state === 'device_received' ? 'device_received_at' : 'notification_posted_at';
      const at = row[field] ?? new Date(this.now()).toISOString();
      this.db.prepare(`UPDATE notifications SET ${field}=COALESCE(${field},?) WHERE id=?`).run(at, id);
      return { delivery_id: id, event_id: row.event_id, event_version: row.version, state: input.state, observed_at: at, evidence: 'device_reported' };
    }).immediate();
  }
  list(p: Principal, after: number, limit: number) {
    user(p);
    const rows = this.db.prepare('SELECT * FROM notifications WHERE owner=? AND actor=? AND seq>? ORDER BY seq LIMIT ?').all(p.owner_id, p.id, after, limit + 1) as Notice[];
    const selected = rows.slice(0, limit);
    return { items: selected.map(n => ({ id: n.id, event_id: n.event_id, event_version: n.version, platform_state: n.platform_state, device_received_at: n.device_received_at, notification_posted_at: n.notification_posted_at })), next_after: rows.length > limit ? String(selected.at(-1)!.seq) : null };
  }
}
export function payloadFor(n: Notice): PushPayload { return { event_id: n.event_id, event_version: n.version, delivery_id: n.id, nonce: n.nonce }; }
export async function publishNtfy(config: PushConfig, n: Notice, signal?: AbortSignal): Promise<'platform_accepted' | 'failed' | 'effect_unknown'> {
  // Registration already restricts the origin. Defense in depth for the direct publisher API.
  const url = new URL(n.endpoint);
  if (url.origin !== config.origin || url.search || url.hash || !/^\/[A-Za-z0-9_-]{1,64}$/.test(url.pathname) || url.username || url.password) throw new Error('Unapproved push endpoint');
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000), headers: { 'content-type': 'application/octet-stream', 'x-unifiedpush': '1', ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) }, body: JSON.stringify(payloadFor(n)) });
    await response.body?.cancel();
    return response.status >= 200 && response.status < 300 ? 'platform_accepted' : response.status >= 400 && response.status < 500 ? 'failed' : 'effect_unknown';
  } catch { return 'effect_unknown'; }
}
export function notificationConsumer(store: NotificationStore, config: PushConfig) {
  let stopping = false; let active: Promise<void> | null = null;
  const controller = new AbortController();
  const tick = () => {
    if (stopping || active) return;
    active = (async () => {
      try { const n = store.claim(); if (!n) return; store.assertReady(); const state = await publishNtfy(config, n, controller.signal); if (state !== 'effect_unknown') store.platform(n.id, state); }
      catch { /* No sensitive endpoint/config/body logging. Durable unknown rows are never retried. */ }
    })().finally(() => { active = null; });
  };
  const timer = setInterval(tick, 1000); timer.unref(); tick();
  return async () => { stopping = true; clearInterval(timer); controller.abort(); await active; };
}
