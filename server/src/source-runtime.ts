import { ApiError, validId, type Principal, type Registry } from './auth.js';
import type { CoreStore } from './core.js';

export const runtimeStates = ['running', 'paused', 'blocked', 'unknown'] as const;
export const runtimeReasons = ['RUNTIME_NOT_OBSERVED', 'RUNTIME_INITIALIZED', 'RUNTIME_LOOP_OBSERVED', 'SOURCE_PAUSED_EXPLICIT', 'MODEL_PERMISSION_DISABLED', 'ORIGINAL_MODEL_RUN_UNRESOLVED', 'MODEL_REQUEST_BUDGET_EXHAUSTED', 'SOURCE_AUTHORIZATION_CHANGED', 'RUNTIME_UNAVAILABLE', 'RUNTIME_STOPPING'] as const;
export type RuntimeState = typeof runtimeStates[number];
export type RuntimeReason = typeof runtimeReasons[number];
export interface SourceRuntimeObservation {
  source_id: string; source_epoch: string; state: RuntimeState; model_permission_configured: boolean;
  reason_code: RuntimeReason; observed_at: string;
}
/** In-process trusted observation only. No HTTP/config plugin loader, control method or permission grant. */
export interface SourceRuntimeProvider {
  readonly owner_id: string; readonly source_id: string; readonly source_epoch: string;
  observe(): SourceRuntimeObservation;
}
function notVisible(): never { throw new ApiError(404, 'NOT_FOUND', 'Source runtime observation is not available'); }
function unavailable(): never { throw new ApiError(503, 'RUNTIME_OBSERVATION_UNAVAILABLE', 'Source runtime observation is unavailable'); }

export function observeSourceRuntime(provider: SourceRuntimeProvider | undefined, core: CoreStore, principal: Principal, registry: Registry,
  sourceId: string, eventId: string, expectedVersion: number) {
  if (principal.kind !== 'user') throw new ApiError(403, 'FORBIDDEN', 'Only the event owner may query this observation');
  if (!provider || !validId(provider.owner_id) || !validId(provider.source_id) || !validId(provider.source_epoch)
    || provider.owner_id !== principal.owner_id || provider.source_id !== sourceId) notVisible();
  const event = core.getEvent(principal, eventId, registry);
  // The client need not migrate its Event/cache schema to establish an epoch association.
  // The authoritative event, not a same-name source or client-supplied epoch, establishes it here.
  if (event.owner_id !== provider.owner_id || event.source_id !== sourceId || event.source_epoch !== provider.source_epoch) notVisible();
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== event.event_version) throw new ApiError(409, 'EVENT_VERSION_CONFLICT', 'Refresh the current event before using its observation');
  let raw: unknown;
  try { raw = provider.observe(); } catch { unavailable(); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) unavailable();
  const value = raw as Record<string, unknown>;
  const fields = ['source_id', 'source_epoch', 'state', 'model_permission_configured', 'reason_code', 'observed_at'];
  if (Object.keys(value).length !== fields.length || !fields.every(key => key in value)
    || value.source_id !== sourceId || value.source_epoch !== event.source_epoch
    || !runtimeStates.includes(value.state as RuntimeState) || !runtimeReasons.includes(value.reason_code as RuntimeReason)
    || typeof value.model_permission_configured !== 'boolean' || typeof value.observed_at !== 'string'
    || value.observed_at.length > 35 || !Number.isFinite(Date.parse(value.observed_at))) unavailable();
  const compatible: Record<RuntimeState, readonly RuntimeReason[]> = {
    running: ['RUNTIME_INITIALIZED', 'RUNTIME_LOOP_OBSERVED', 'MODEL_PERMISSION_DISABLED'], paused: ['SOURCE_PAUSED_EXPLICIT'],
    blocked: ['ORIGINAL_MODEL_RUN_UNRESOLVED', 'MODEL_REQUEST_BUDGET_EXHAUSTED', 'SOURCE_AUTHORIZATION_CHANGED', 'RUNTIME_UNAVAILABLE', 'RUNTIME_STOPPING'], unknown: ['RUNTIME_NOT_OBSERVED'],
  };
  if (!compatible[value.state as RuntimeState].includes(value.reason_code as RuntimeReason)
    || (value.reason_code === 'MODEL_PERMISSION_DISABLED' && value.model_permission_configured !== false)
    || new Date(value.observed_at as string).toISOString() !== value.observed_at) unavailable();
  const result = { event_id: event.id, event_version: event.event_version, source_id: sourceId, source_epoch: event.source_epoch,
    state: value.state as RuntimeState, model_permission_configured: value.model_permission_configured,
    reason_code: value.reason_code as RuntimeReason, observed_at: value.observed_at };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 4096) unavailable();
  return result;
}
