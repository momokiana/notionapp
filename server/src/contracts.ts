export interface Action { id: string; label: string; type: 'button' | 'text' }
export interface InteractionInput { id: string; actions: Action[] }
export interface Interaction extends InteractionInput { version: number }
export interface CreateEvent {
  request_id: string; title: string; body: string; session_ref: string; target_revision: string;
  expires_at: string; interaction?: InteractionInput;
}
export interface UpdateEvent {
  update_id: string; expected_event_version: number; kind: 'progress' | 'source_result_reported';
  body: string; title?: string; target_revision?: string; expires_at?: string; interaction?: InteractionInput | null;
}
export interface SubmitResponse {
  response_id: string; event_version: number; interaction_id: string; interaction_version: number;
  action_id: string; text: string;
}
export type Disposition = 'open' | 'paused' | 'completed' | 'not_tracking';
export interface EventData {
  id: string; owner_id: string; source_id: string; source_epoch: string;
  title: string; body: string; session_ref: string; target_revision: string; expires_at: string;
  event_version: number; interaction_version: number; interaction: Interaction | null;
  reserved_response_id: string | null; disposition: Disposition; evidence_level: 'source_reported';
  created_at: string; updated_at: string;
}
export interface ResponseData {
  id: string; event_id: string; actor_id: string; created_at: string; event_version_seen: number;
  interaction_id: string; interaction_version: number; action: Action; text: string; expires_at: string;
  target: { source_id: string; source_epoch: string; session_ref: string; state_revision: string };
}

const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$' };
const version = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const text = (maxLength: number, minLength = 0) => ({ type: 'string', minLength, maxLength });
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', additionalProperties: false, properties, required });
const interaction = object({
  id,
  actions: { type: 'array', minItems: 1, maxItems: 8, items: object({ id, label: text(100, 1), type: { enum: ['button', 'text'] } }, ['id', 'label', 'type']) },
}, ['id', 'actions']);
export const schemas = {
  idParams: object({ id }, ['id']),
  page: object({ after: { type: 'string', pattern: '^\\d{1,16}$' }, limit: { type: 'string', pattern: '^\\d{1,3}$' } }, []),
  create: object({ request_id: id, title: text(200, 1), body: text(16000), session_ref: text(512, 1), target_revision: text(200, 1), expires_at: text(40, 1), interaction }, ['request_id', 'title', 'body', 'session_ref', 'target_revision', 'expires_at']),
  update: object({ update_id: id, expected_event_version: version, kind: { enum: ['progress', 'source_result_reported'] }, body: text(16000), title: text(200, 1), target_revision: text(200, 1), expires_at: text(40, 1), interaction: { anyOf: [interaction, { type: 'null' }] } }, ['update_id', 'expected_event_version', 'kind', 'body']),
  response: object({ response_id: id, event_version: version, interaction_id: id, interaction_version: version, action_id: id, text: text(4000) }, ['response_id', 'event_version', 'interaction_id', 'interaction_version', 'action_id', 'text']),
  read: object({ event_version: version }, ['event_version']),
  disposition: object({ request_id: id, expected_event_version: version, disposition: { enum: ['open', 'paused', 'completed', 'not_tracking'] } }, ['request_id', 'expected_event_version', 'disposition']),
};
