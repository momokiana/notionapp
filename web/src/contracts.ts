// Deliberately local HTTP views. The server owns the ledger and all authorization.
export type Disposition = 'open' | 'paused' | 'completed' | 'not_tracking';
export const dispositions = ['open', 'paused', 'completed', 'not_tracking'] as const;
export const dispositionNames: Record<Disposition, string> = { open: '跟进中', paused: '暂停', completed: '已完成事项', not_tracking: '不再跟踪' };
export interface Action { id: string; label: string; type: 'button' | 'text' }
export interface Interaction { id: string; version: number; actions: Action[] }
export interface SourceDelivery { command_id: string | null; state: string; receipt: Record<string, unknown> | null; evidence: string }
export interface Notice { id: string; version: number; platform_state: string; device_received_at: string | null; notification_posted_at: string | null }
export interface Event {
  id: string; owner_id: string; source_id: string; source_epoch: string;
  title: string; body: string; session_ref: string; target_revision: string; expires_at: string;
  event_version: number; interaction_version: number; interaction: Interaction | null;
  reserved_response_id: string | null; disposition: Disposition; created_at: string; updated_at: string;
  read_state: { version: number; unread: boolean }; can_respond: boolean;
  source_delivery: SourceDelivery | null; notification_delivery: Notice | null; previous_notification_delivery: Notice | null;
  delivery_state: string; verification: string;
}
export interface Response {
  id: string; event_id: string; actor_id: string; created_at: string; event_version_seen: number;
  interaction_id: string; interaction_version: number; action: Action; text: string; expires_at: string;
  target: { source_id: string; source_epoch: string; session_ref: string; state_revision: string };
  eligibility_state: string; eligibility_reason: string; routing_state: string; reason_code: string;
  source_delivery: SourceDelivery | null; execution_state: string; verification: string; execution_authorized: false;
}
export interface History { seq: number; kind: string; data: Record<string, unknown>; created_at: string }
export interface Page<T> { items: T[]; next_after: string | null }
export interface Device { store_id: string; device_id: string; owner_id: string; label: string; credential_version: number; manage_devices: boolean }
export const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('INVALID_SERVER_DATA');
  return v as Record<string, unknown>;
};
export function text(v: unknown, max = 16000): string {
  if (typeof v !== 'string' || [...v].length > max) throw new Error('INVALID_SERVER_DATA');
  return v;
}
export function integer(v: unknown, min = 0): number {
  if (!Number.isSafeInteger(v) || (v as number) < min) throw new Error('INVALID_SERVER_DATA');
  return v as number;
}
export function id(v: unknown): string {
  const s = text(v, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(s)) throw new Error('INVALID_SERVER_DATA');
  return s;
}
function bool(v: unknown): boolean { if (typeof v !== 'boolean') throw new Error('INVALID_SERVER_DATA'); return v; }
export function oneOf<T extends string>(v: unknown, values: readonly T[]): T {
  if (!values.includes(v as T)) throw new Error('INVALID_SERVER_DATA');
  return v as T;
}
export const nullableText = (v: unknown, max = 512) => v === null ? null : text(v, max);
export function action(v: unknown): Action {
  const o = object(v);
  return { id: id(o.id), label: text(o.label, 100), type: oneOf(o.type, ['button', 'text']) };
}
function interaction(v: unknown): Interaction | null {
  if (v === null) return null;
  const o = object(v);
  if (!Array.isArray(o.actions) || o.actions.length < 1 || o.actions.length > 8) throw new Error('INVALID_SERVER_DATA');
  const actions = o.actions.map(action);
  if (new Set(actions.map(a => a.id)).size !== actions.length) throw new Error('INVALID_SERVER_DATA');
  return { id: id(o.id), version: integer(o.version, 1), actions };
}
export function sourceDelivery(v: unknown): SourceDelivery | null {
  if (v === null) return null;
  const o = object(v);
  return { command_id: nullableText(o.command_id, 80), state: text(o.state, 80), receipt: o.receipt === null ? null : object(o.receipt), evidence: text(o.evidence, 80) };
}
function notice(v: unknown): Notice | null {
  if (v === null) return null;
  const o = object(v);
  return { id: id(o.id), version: integer(o.version, 1), platform_state: text(o.platform_state, 80), device_received_at: nullableText(o.device_received_at), notification_posted_at: nullableText(o.notification_posted_at) };
}
export function event(v: unknown): Event {
  const o = object(v), read = object(o.read_state);
  const e: Event = {
    id: id(o.id), owner_id: id(o.owner_id), source_id: id(o.source_id), source_epoch: id(o.source_epoch),
    title: text(o.title, 200), body: text(o.body), session_ref: text(o.session_ref, 512), target_revision: text(o.target_revision, 200), expires_at: text(o.expires_at, 40),
    event_version: integer(o.event_version, 1), interaction_version: integer(o.interaction_version), interaction: interaction(o.interaction),
    reserved_response_id: o.reserved_response_id === null ? null : id(o.reserved_response_id), disposition: oneOf(o.disposition, dispositions),
    created_at: text(o.created_at, 40), updated_at: text(o.updated_at, 40),
    read_state: { version: integer(read.version), unread: bool(read.unread) }, can_respond: bool(o.can_respond),
    source_delivery: sourceDelivery(o.source_delivery), notification_delivery: notice(o.notification_delivery), previous_notification_delivery: notice(o.previous_notification_delivery),
    delivery_state: text(o.delivery_state, 80), verification: text(o.verification, 80),
  };
  if (!Number.isFinite(Date.parse(e.expires_at)) || (e.interaction && e.interaction.version !== e.interaction_version)) throw new Error('INVALID_SERVER_DATA');
  return e;
}
export function response(v: unknown): Response {
  const o = object(v), t = object(o.target);
  if (o.execution_authorized !== false) throw new Error('UNSUPPORTED_EXECUTION_CLAIM');
  return { id: id(o.id), event_id: id(o.event_id), actor_id: id(o.actor_id), created_at: text(o.created_at, 40), event_version_seen: integer(o.event_version_seen, 1),
    interaction_id: id(o.interaction_id), interaction_version: integer(o.interaction_version, 1), action: action(o.action), text: text(o.text, 4000), expires_at: text(o.expires_at, 40),
    target: { source_id: id(t.source_id), source_epoch: id(t.source_epoch), session_ref: text(t.session_ref, 512), state_revision: text(t.state_revision, 200) },
    eligibility_state: text(o.eligibility_state, 80), eligibility_reason: text(o.eligibility_reason, 80), routing_state: text(o.routing_state, 80), reason_code: text(o.reason_code, 80),
    source_delivery: sourceDelivery(o.source_delivery), execution_state: text(o.execution_state, 80), verification: text(o.verification, 80), execution_authorized: false };
}
export function history(v: unknown): History { const o = object(v); return { seq: integer(o.seq, 1), kind: text(o.kind, 100), data: object(o.data), created_at: text(o.created_at, 40) }; }
export function page<T>(v: unknown, parse: (item: unknown) => T): Page<T> {
  const o = object(v);
  if (!Array.isArray(o.items) || o.items.length > 50 || (o.next_after !== null && (typeof o.next_after !== 'string' || !/^\d{1,16}$/.test(o.next_after) || !Number.isSafeInteger(Number(o.next_after))))) throw new Error('INVALID_SERVER_DATA');
  return { items: o.items.map(parse), next_after: o.next_after as string | null };
}
export function device(v: unknown): Device { const o = object(v); return { store_id: text(o.store_id, 80), device_id: id(o.device_id), owner_id: id(o.owner_id), label: text(o.label, 80), credential_version: integer(o.credential_version, 1), manage_devices: bool(o.manage_devices) }; }
export function same(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v !== null && typeof v === 'object' ? '{' + Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => JSON.stringify(k) + ':' + canonical(x)).join(',') + '}' : JSON.stringify(v);
  return canonical(a) === canonical(b);
}
// Dynamic observation fields do not change the user's confirmed question, but versions do.
export function confirmation(e: Event) {
  const { id, owner_id, source_id, source_epoch, title, body, session_ref, target_revision, expires_at, event_version, interaction_version, interaction, disposition, can_respond, reserved_response_id } = e;
  return { id, owner_id, source_id, source_epoch, title, body, session_ref, target_revision, expires_at, event_version, interaction_version, interaction, disposition, can_respond, reserved_response_id };
}
