import type { Api, Model, ModelAuth } from '@earendil-works/pi-ai';
import { record, requireHost } from './private-files.js';

export type OutputBudget = { mode: 'protocol_tokens'; max_tokens: number } | { mode: 'provider_managed' };
export interface ModelBudget { request_limit: number; output: OutputBudget }
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));

/** No implicit downgrade from a protocol bound to provider-managed generation. */
export function modelBudget(value: unknown): ModelBudget {
  if (value === undefined) return { request_limit: 3, output: { mode: 'protocol_tokens', max_tokens: 16384 } };
  requireHost(record(value) && keys(value, ['request_limit', 'output']) && Number.isSafeInteger(value.request_limit)
    && Number(value.request_limit) >= 1 && Number(value.request_limit) <= 100, 'INVALID_MODEL_BUDGET');
  const out = value.output;
  requireHost(record(out) && ((out.mode === 'provider_managed' && keys(out, ['mode'])) || (out.mode === 'protocol_tokens'
    && keys(out, ['mode', 'max_tokens']) && Number.isSafeInteger(out.max_tokens) && Number(out.max_tokens) >= 16 && Number(out.max_tokens) <= 128000)), 'INVALID_MODEL_OUTPUT_BUDGET');
  return value as unknown as ModelBudget;
}
export function checkBudgetSupport(model: Model<Api>, auth: ModelAuth, budget: OutputBudget) {
  if (budget.mode === 'provider_managed') return;
  // This audited SDK branch omits max_output_tokens; a preference/abort cannot replace it.
  const subscription = model.api === 'openai-responses' && model.provider === 'openai' && model.baseUrl === 'https://api.openai.com/v1'
    && auth.apiKey !== undefined && !auth.apiKey.startsWith('sk-');
  const disabled = model.api === 'openai-responses' && model.compat && 'supportsMaxOutputTokens' in model.compat && model.compat.supportsMaxOutputTokens === false;
  requireHost(!subscription && !disabled, 'MODEL_OUTPUT_BUDGET_UNSUPPORTED');
}
/** Called on the actual final SDK payload, before the HTTP client gets it. */
export function checkOutputPayload(api: Api, payload: unknown, output: OutputBudget) {
  if (output.mode === 'provider_managed') return;
  requireHost(record(payload), 'MODEL_OUTPUT_BUDGET_UNSUPPORTED');
  const limit = api === 'openai-responses' ? payload.max_output_tokens : api === 'openai-completions'
    ? payload.max_completion_tokens ?? payload.max_tokens : api === 'anthropic-messages' ? payload.max_tokens : undefined;
  requireHost(Number.isSafeInteger(limit) && Number(limit) >= 1 && Number(limit) <= output.max_tokens, 'MODEL_OUTPUT_BUDGET_UNSUPPORTED');
}
