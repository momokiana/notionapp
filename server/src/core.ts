import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ApiError, type Principal, type Registry } from './auth.js';
import type { CreateEvent, UpdateEvent, SubmitResponse, Disposition, EventData, InteractionInput, ResponseData } from './contracts.js';

import { initializeSchema } from './schema.js';
import {assertNoRecovery} from './recovery-gate.js';
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  return JSON.stringify(v);
};
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const error = (status: number, code: string, message: string): never => { throw new ApiError(status, code, message); };
const stamp = (n: number) => new Date(n).toISOString();

export const initializeCore = initializeSchema;

export function parseExpiry(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return error(422, 'INVALID_INPUT', 'expires_at must be a valid RFC 3339 time');
  const [, y, m, d, h, min, sec, tz] = match;
  const year = Number(y); const month = Number(m); const day = Number(d);
  const result = Date.parse(value);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || Number(h) > 23 || Number(min) > 59 || Number(sec) > 59 || (tz !== 'Z' && (Number(tz?.slice(1, 3)) > 23 || Number(tz?.slice(4)) > 59)) || !Number.isFinite(result)) return error(422, 'INVALID_INPUT', 'expires_at must be a valid RFC 3339 time');
  return result;
}
function checkInteraction(value: InteractionInput | null | undefined): void {
  if (value && new Set(value.actions.map(a => a.id)).size !== value.actions.length) error(422, 'INVALID_INPUT', 'Action IDs must be unique within an interaction');
}
export interface Page { after: number; limit: number }
export function pageOf(query: { after?: string; limit?: string }): Page {
  const after = Number(query.after ?? 0); const limit = Number(query.limit ?? 50);
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return error(422, 'INVALID_INPUT', 'Invalid pagination cursor or page limit');
  return { after, limit };
}

export class CoreStore {
  constructor(private db: Database.Database, private now: () => number = Date.now) { initializeCore(db); }
  private scope(p: Principal, kind: string, eventId = ''): string {
    return JSON.stringify([p.owner_id, p.kind, p.kind === 'source' ? p.source_id : 'user', p.kind === 'source' ? p.source_epoch : '', kind, eventId]);
  }
  private once<T>(scope: string, id: string, input: unknown, run: () => T): T {
    assertNoRecovery(this.db);
    return this.db.transaction(() => {
      assertNoRecovery(this.db);
      const prior = this.db.prepare('SELECT digest,result FROM operations WHERE scope=? AND id=?').get(scope, id) as { digest: string; result: string } | undefined;
      const digest = hash(input);
      if (prior) {
        if (digest !== prior.digest) return error(409, 'IDEMPOTENCY_CONFLICT', 'This ID is already bound to different input');
        return JSON.parse(prior.result) as T;
      }
      const result = run();
      this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(scope, id, digest, JSON.stringify(result));
      return result;
    }).immediate();
  }
  private user(p: Principal): void { if (p.kind !== 'user') error(403, 'FORBIDDEN', 'User permission is required'); }
  private source(p: Principal, capability: string): asserts p is Extract<Principal, { kind: 'source' }> {
    if (p.kind !== 'source' || !p.capabilities.includes(capability)) error(403, 'FORBIDDEN', 'Source capability is required');
  }
  private event(p: Principal, id: string): EventData {
    assertNoRecovery(this.db);
    const row = this.db.prepare(`SELECT data FROM events WHERE id=? AND owner=?${p.kind === 'source' ? ' AND source=? AND epoch=?' : ''}`).get(...(p.kind === 'source' ? [id, p.owner_id, p.source_id, p.source_epoch] : [id, p.owner_id])) as { data: string } | undefined;
    if (!row) return error(404, 'NOT_FOUND', 'Resource is not visible');
    return JSON.parse(row.data) as EventData;
  }
  private save(event: EventData): void {
    this.db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(event), event.id);
  }
  private history(event: EventData, kind: string, data: unknown): void {
    this.db.prepare('INSERT INTO history(event_id,kind,data,created_at) VALUES (?,?,?,?)').run(event.id, kind, JSON.stringify(data), stamp(this.now()));
  }
  private notice(event: EventData, kind: string): void {
    if (event.disposition === 'open') this.db.prepare("INSERT INTO outbox(event_id,version,kind,state) VALUES (?,?,?,'pending')").run(event.id, event.event_version, kind);
  }
  private version(event: EventData, expected: number): void {
    if (event.event_version !== expected) error(409, 'EVENT_VERSION_CONFLICT', 'Refresh the current event version');
  }
  private grant(event: EventData, registry: Registry): void {
    if (!registry.source(event.owner_id, event.source_id, event.source_epoch)?.capabilities.includes('reply')) error(409, 'SOURCE_READ_ONLY', 'The current source does not permit replies');
  }
  create(p: Principal, input: CreateEvent) {
    this.source(p, 'publish');
    return this.once(this.scope(p, 'create'), input.request_id, input, () => {
      parseExpiry(input.expires_at); checkInteraction(input.interaction);
      if (input.interaction && !p.capabilities.includes('reply')) error(409, 'SOURCE_READ_ONLY', 'A read-only source cannot offer reply actions');
      const at = stamp(this.now());
      const event: EventData = { id: randomUUID(), owner_id: p.owner_id, source_id: p.source_id, source_epoch: p.source_epoch,
        title: input.title, body: input.body, session_ref: input.session_ref, target_revision: input.target_revision, expires_at: input.expires_at,
        event_version: 1, interaction_version: input.interaction ? 1 : 0, interaction: input.interaction ? { ...input.interaction, version: 1 } : null,
        reserved_response_id: null, disposition: 'open', evidence_level: 'source_reported', created_at: at, updated_at: at };
      this.db.prepare('INSERT INTO events(id,owner,source,epoch,data) VALUES (?,?,?,?,?)').run(event.id, p.owner_id, p.source_id, p.source_epoch, JSON.stringify(event));
      this.history(event, 'event_created', event); this.notice(event, 'event_created');
      return { event_id: event.id, event_version: 1, saved_at: at };
    });
  }
  update(p: Principal, id: string, input: UpdateEvent) {
    this.source(p, 'publish'); this.event(p, id);
    return this.once(this.scope(p, 'update', id), input.update_id, input, () => {
      const event = this.event(p, id); this.version(event, input.expected_event_version);
      if (input.expires_at !== undefined) parseExpiry(input.expires_at);
      checkInteraction(input.interaction);
      if (input.interaction && !p.capabilities.includes('reply')) error(409, 'SOURCE_READ_ONLY', 'A read-only source cannot offer reply actions');
      // Binding/expiry changes create a new interaction generation even when later
      // restored to the old literal value: an old response must never revive.
      const bindingChanged = (input.target_revision !== undefined && input.target_revision !== event.target_revision)
        || (input.expires_at !== undefined && input.expires_at !== event.expires_at);
      event.body = input.body; if (input.title !== undefined) event.title = input.title;
      if (input.target_revision !== undefined) event.target_revision = input.target_revision;
      if (input.expires_at !== undefined) event.expires_at = input.expires_at;
      if (input.interaction !== undefined || bindingChanged) {
        const interaction = input.interaction === undefined ? event.interaction : input.interaction;
        event.interaction_version++;
        event.interaction = interaction ? { ...interaction, version: event.interaction_version } : null;
        event.reserved_response_id = null;
      }
      event.event_version++; event.updated_at = stamp(this.now()); this.save(event);
      this.history(event, input.kind, event); this.notice(event, input.kind);
      return { event_id: id, event_version: event.event_version, saved_at: event.updated_at };
    });
  }
  respond(p: Principal, id: string, input: SubmitResponse, registry: Registry) {
    this.user(p); this.event(p, id);
    return this.once(this.scope(p, 'response', id), input.response_id, input, () => {
      const event = this.event(p, id); this.version(event, input.event_version);
      if (this.db.prepare('SELECT 1 FROM responses WHERE owner=? AND id=?').get(p.owner_id, input.response_id)) error(409, 'IDEMPOTENCY_CONFLICT', 'This response ID is already in use');
      if (event.disposition !== 'open') error(409, 'EVENT_CLOSED', 'The user has paused or closed this event');
      if (parseExpiry(event.expires_at) <= this.now()) error(410, 'ACTION_EXPIRED', 'This interaction has expired');
      this.grant(event, registry);
      const interaction = event.interaction;
      if (!interaction || interaction.id !== input.interaction_id || interaction.version !== input.interaction_version) return error(409, 'INTERACTION_VERSION_CONFLICT', 'Refresh the current interaction');
      if (event.reserved_response_id) error(409, 'ACTION_ALREADY_RESERVED', 'This interaction already has a response');
      const action = interaction.actions.find(a => a.id === input.action_id);
      if (!action || (action.type === 'text' && input.text.trim() === '')) return error(422, 'INVALID_INPUT', 'Choose an available action with valid input');
      const at = stamp(this.now());
      const response: ResponseData = { id: input.response_id, event_id: id, actor_id: p.id, created_at: at, event_version_seen: input.event_version,
        interaction_id: interaction.id, interaction_version: interaction.version, action, text: input.text, expires_at: event.expires_at,
        target: { source_id: event.source_id, source_epoch: event.source_epoch, session_ref: event.session_ref, state_revision: event.target_revision } };
      // The unique interaction slot is durable even after later interaction replacement.
      this.db.prepare('INSERT INTO responses(owner,id,event_id,source,epoch,interaction_id,interaction_version,data) VALUES (?,?,?,?,?,?,?,?)').run(p.owner_id, response.id, id, event.source_id, event.source_epoch, interaction.id, interaction.version, JSON.stringify(response));
      event.reserved_response_id = response.id; event.event_version++; event.updated_at = at; this.save(event);
      this.history(event, 'response_saved', response); this.notice(event, 'response_saved');
      return { response_id: response.id, event_id: id, saved_at: at };
    });
  }
  private responseView(p: Principal, data: ResponseData, registry: Registry) {
    const event = this.event(p, data.event_id);
    let reason = 'NOT_DELIVERED'; let state = 'waiting_source';
    if (event.disposition !== 'open') { state = 'blocked'; reason = 'USER_DISPOSITION'; }
    else if (event.target_revision !== data.target.state_revision || event.interaction_version !== data.interaction_version || event.interaction?.id !== data.interaction_id) { state = 'blocked'; reason = 'TARGET_OR_INTERACTION_CHANGED'; }
    else if (!registry.source(event.owner_id, event.source_id, event.source_epoch)?.capabilities.includes('reply')) { state = 'blocked'; reason = 'SOURCE_NOT_AUTHORIZED'; }
    else if (parseExpiry(data.expires_at) <= this.now()) { state = 'expired'; reason = 'ACTION_EXPIRED'; }
    const eligibility = { eligibility_state: state, eligibility_reason: reason };
    const delivery = this.sourceDelivery(p, data.id);
    if (state === 'waiting_source' && delivery?.state === 'source_received') { state = 'source_received'; reason = 'SOURCE_RECEIVED'; }
    else if (state === 'waiting_source' && delivery?.state === 'effect_unknown') { state = 'effect_unknown'; reason = 'SOURCE_EFFECT_UNKNOWN'; }
    return { ...data, ...eligibility, source_delivery: delivery, routing_state: state, reason_code: reason, execution_state: 'not_observed', verification: 'not_verified', execution_authorized: false };
  }
  private sourceDelivery(p: Principal, responseId: string | null) {
    if (!responseId) return null;
    const row = this.db.prepare('SELECT id,receipt FROM commands WHERE owner=? AND response_id=?').get(p.owner_id, responseId) as { id: string; receipt: string | null } | undefined;
    return row ? { command_id: row.id, state: row.receipt ? 'source_received' : 'effect_unknown', receipt: row.receipt ? JSON.parse(row.receipt) as unknown : null, evidence: 'adapter_reported' } : { command_id: null, state: 'waiting_source', receipt: null, evidence: 'not_observed' };
  }
  getResponse(p: Principal, id: string, registry: Registry) {
    if (p.kind === 'source') this.source(p, 'read_responses');
    const row = this.db.prepare(`SELECT data FROM responses WHERE owner=? AND id=?${p.kind === 'source' ? ' AND source=? AND epoch=?' : ''}`).get(...(p.kind === 'source' ? [p.owner_id, id, p.source_id, p.source_epoch] : [p.owner_id, id])) as { data: string } | undefined;
    if (!row) return error(404, 'NOT_FOUND', 'Resource is not visible');
    return this.responseView(p, JSON.parse(row.data) as ResponseData, registry);
  }
  private notificationDelivery(p: Principal, id: string, version: number, previous = false) {
    if (p.kind !== 'user') return null;
    return (this.db.prepare(`SELECT id,version,platform_state,device_received_at,notification_posted_at FROM notifications WHERE event_id=? AND owner=? AND actor=? AND version${previous ? '<' : '='}? ORDER BY version DESC,seq DESC LIMIT 1`).get(id, p.owner_id, p.id, version) as { id: string; version: number; platform_state: string; device_received_at: string | null; notification_posted_at: string | null } | undefined) ?? null;
  }
  getEvent(p: Principal, id: string, registry: Registry) {
    const event = this.event(p, id);
    const read = this.db.prepare('SELECT version FROM read_states WHERE event_id=? AND owner=?').get(id, p.owner_id) as { version: number } | undefined;
    const notice = this.notificationDelivery(p, id, event.event_version);
    const previousNotice = this.notificationDelivery(p, id, event.event_version, true);
    const deliveryState = notice?.notification_posted_at ? 'notification_posted' : notice?.device_received_at ? 'device_received' : notice?.platform_state ?? 'not_observed';
    return { ...event, read_state: { version: read?.version ?? 0, unread: (read?.version ?? 0) < event.event_version },
      can_respond: p.kind === 'user' && event.disposition === 'open' && event.interaction !== null && event.reserved_response_id === null && parseExpiry(event.expires_at) > this.now() && !!registry.source(event.owner_id, event.source_id, event.source_epoch)?.capabilities.includes('reply'),
      delivery_state: deliveryState, notification_delivery: notice, previous_notification_delivery: previousNotice, source_delivery: this.sourceDelivery(p, event.reserved_response_id), verification: 'not_verified' };
  }
  private page<T>(rows: { seq: number; data: string }[], page: Page, map: (data: string) => T) {
    const selected = rows.slice(0, page.limit);
    return { items: selected.map(r => map(r.data)), next_after: rows.length > page.limit ? String(selected.at(-1)?.seq) : null };
  }
  listEvents(p: Principal, page: Page, registry: Registry) {
    const rows = this.db.prepare(`SELECT seq,data FROM events WHERE owner=? AND seq>?${p.kind === 'source' ? ' AND source=? AND epoch=?' : ''} ORDER BY seq LIMIT ?`).all(...(p.kind === 'source' ? [p.owner_id, page.after, p.source_id, p.source_epoch, page.limit + 1] : [p.owner_id, page.after, page.limit + 1])) as { seq: number; data: string }[];
    return this.page(rows, page, data => this.getEvent(p, (JSON.parse(data) as EventData).id, registry));
  }
  listResponses(p: Principal, page: Page, registry: Registry) {
    this.source(p, 'read_responses');
    const rows = this.db.prepare('SELECT seq,data FROM responses WHERE owner=? AND source=? AND epoch=? AND seq>? ORDER BY seq LIMIT ?').all(p.owner_id, p.source_id, p.source_epoch, page.after, page.limit + 1) as { seq: number; data: string }[];
    return this.page(rows, page, data => this.responseView(p, JSON.parse(data) as ResponseData, registry));
  }
  read(p: Principal, id: string, version: number) {
    this.user(p);
    return this.db.transaction(() => {
      const event = this.event(p, id);
      if (version > event.event_version) error(409, 'EVENT_VERSION_CONFLICT', 'A future version cannot be marked read');
      this.db.prepare('INSERT INTO read_states VALUES (?,?,?) ON CONFLICT(event_id,owner) DO UPDATE SET version=MAX(version,excluded.version)').run(id, p.owner_id, version);
      const row = this.db.prepare('SELECT version FROM read_states WHERE event_id=? AND owner=?').get(id, p.owner_id) as { version: number };
      return { event_id: id, read_version: row.version };
    }).immediate();
  }
  disposition(p: Principal, id: string, input: { request_id: string; expected_event_version: number; disposition: Disposition }) {
    this.user(p); this.event(p, id);
    return this.once(this.scope(p, 'disposition', id), input.request_id, input, () => {
      const event = this.event(p, id); this.version(event, input.expected_event_version);
      event.disposition = input.disposition; event.event_version++; event.updated_at = stamp(this.now()); this.save(event);
      if (event.disposition !== 'open') this.db.prepare("UPDATE outbox SET state='withheld' WHERE event_id=? AND state='pending'").run(id);
      this.history(event, 'user_disposition', { disposition: event.disposition, actor_id: p.id, event_version: event.event_version });
      return { event_id: id, event_version: event.event_version, saved_at: event.updated_at };
    });
  }
  listHistory(p: Principal, id: string, page: Page) {
    if (p.kind === 'source') this.source(p, 'read_responses');
    this.event(p, id);
    const rows = this.db.prepare('SELECT seq,kind,data,created_at FROM history WHERE event_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, page.after, page.limit + 1) as { seq: number; kind: string; data: string; created_at: string }[];
    const selected = rows.slice(0, page.limit);
    return { items: selected.map(r => ({ seq: r.seq, kind: r.kind, data: JSON.parse(r.data) as unknown, created_at: r.created_at })), next_after: rows.length > page.limit ? String(selected.at(-1)?.seq) : null };
  }
}
