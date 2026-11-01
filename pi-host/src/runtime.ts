import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCurrentSystemPrompt, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { Ajv } from 'ajv';
import { Type } from 'typebox';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SettingsManager, type AgentSession, type ResourceLoader, type ToolDefinition, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { ApiError, validId, type RegistryProvider } from 'notification-server/auth';
import { openDeviceRegistry } from 'notification-server/device-config';
import {assertNoRecoveryFile} from 'notification-server/recovery-gate';
import type { DeviceAuthority } from 'notification-server/device-authority';
import { CoreStore, parseExpiry } from 'notification-server/core';
import type { RuntimeReason, RuntimeState, SourceRuntimeObservation, SourceRuntimeProvider } from 'notification-server/source-runtime';
import { DeliveryStore, type Command, type NativeHost } from 'notification-server/delivery';
import { SourcePump } from 'notification-server/source-adapter';
import { schemas, type Action, type CreateEvent, type UpdateEvent } from 'notification-server/contracts';
import { assertIdentity, authority, factPrincipal, type AppConfig } from './config.js';
import { checkBudgetSupport, checkOutputPayload } from './model-budget.js';
import { AppCredentials, literalProfile } from './credentials.js';
import { controlType, NativeSession, PiNativeHost, responseType, runtimeType } from './native.js';
import { canonical, digest, HostError, privateJson, record, requireHost, stableId } from './private-files.js';

interface Question { title: string; body: string; actions: Action[]; expires_at: string }
interface Started { kind: 'run_started'; run_id: string; command_id: string | null; input_entry_id: string }
interface RequestIntent { kind: 'model_request_intent'; run_id: string }
interface HttpAttempt { kind: 'model_http_attempt'; run_id: string }
interface HttpResponse { kind: 'model_http_response'; run_id: string; status: number }
interface QuestionIntent { kind: 'question_intent'; run_id: string; tool_call_id: string; question: Question }
interface Settled { kind: 'run_settled'; run_id: string; final_entry_id: string; outcome: 'text' | 'question'; target: { session_ref: string; state_revision: string } }
interface Report {
  kind: 'report_intent'; run_id: string; command_id: string | null; event_id: string | null;
  method: 'create' | 'update'; input: CreateEvent | UpdateEvent; source_snapshot: string | null; rejected_parent: string | null;
}
interface Saved { kind: 'report_saved'; run_id: string; op_id: string; event_id: string; event_version: number }
interface Rejected { kind: 'report_rejected'; run_id: string; op_id: string; code: 'EVENT_VERSION_CONFLICT' }
interface Failed { kind: 'run_failed'; run_id: string; code: 'NO_COMPLETE_OUTPUT' }
type Journal = Started | RequestIntent | HttpAttempt | HttpResponse | QuestionIntent | Settled | Report | Saved | Rejected | Failed;
interface Outcome { kind: 'text' | 'question'; entry_id: string; text?: string; question?: Question }
const ajv = new Ajv({ allErrors: false, coerceTypes: false, removeAdditional: false });
const validCreate = ajv.compile(schemas.create);
const validUpdate = ajv.compile(schemas.update);
const questionSchema = Type.Object({
  title: Type.String({ description: '1–200 Unicode characters' }), body: Type.String({ description: 'At most 16000 Unicode characters' }),
  ttl_seconds: Type.Integer({ minimum: 30, maximum: 86400 }),
  actions: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), type: Type.Union([Type.Literal('button'), Type.Literal('text')]) }, { additionalProperties: false }), { minItems: 1, maxItems: 8 }),
}, { additionalProperties: false });
const hashString = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const nullableId = (v: unknown): v is string | null => v === null || validId(v);
const opId = (r: Report) => r.method === 'create' ? (r.input as CreateEvent).request_id : (r.input as UpdateEvent).update_id;
const boundedBody = (text: string) => [...text].length <= 16000 ? text : '完整内容留在原生会话，因超过卡片限额未上传；没有截断后冒充完整结果。';
function checkQuestion(q: unknown): asserts q is Question {
  requireHost(record(q) && typeof q.expires_at === 'string' && Array.isArray(q.actions) && validCreate({ request_id: 'validation', title: q.title, body: q.body, session_ref: 'validation', target_revision: 'validation', expires_at: q.expires_at, interaction: { id: 'validation', actions: q.actions } })
    && new Set(q.actions.map(a => record(a) ? a.id : null)).size === q.actions.length, 'INVALID_APP_QUESTION');
  parseExpiry(q.expires_at);
}
function sourceSnapshot(event: Record<string, unknown>) {
  return digest(['owner_id', 'source_id', 'source_epoch', 'title', 'body', 'session_ref', 'target_revision', 'expires_at', 'interaction', 'interaction_version', 'reserved_response_id'].map(k => event[k]));
}

/** Pure original-journal validation for live admission and authenticated inert backup material; never settle/replay/run. */
export function validateRuntimeBackupJournal(entries: readonly SessionEntry[], bindingHash: string, nativeId: string, requestLimit: number): Journal[] {
  const values = entries.filter(e => e.type === 'custom' && e.customType === runtimeType).map(e => {
    requireHost(e.type === 'custom' && record(e.data) && e.data.scope === bindingHash && record(e.data.value) && typeof e.data.value.kind === 'string', 'INVALID_RUNTIME_JOURNAL');
    return e.data.value;
  });
  const entryIds = new Set(entries.map(e => e.id));
  const starts = new Map<string, Started>(); const questions = new Set<string>(); const terminals = new Set<string>(); const reports = new Map<string, Report>();
  const requests = new Set<string>(); const attempts = new Set<string>(); const responses = new Set<string>();
  for (const value of values) {
    requireHost(validId(value.run_id), 'INVALID_RUNTIME_JOURNAL');
    const v = value as unknown as Journal;
    switch (v.kind) {
      case 'run_started':
        requireHost(!starts.has(v.run_id) && nullableId(v.command_id) && typeof v.input_entry_id === 'string' && entryIds.has(v.input_entry_id), 'INVALID_RUN_START');
        starts.set(v.run_id, v); break;
      case 'model_request_intent':
        requireHost(starts.has(v.run_id) && !requests.has(v.run_id) && !terminals.has(v.run_id) && requests.size < requestLimit, 'INVALID_MODEL_REQUEST_INTENT');
        requests.add(v.run_id); break;
      case 'model_http_attempt':
        requireHost(requests.has(v.run_id) && !attempts.has(v.run_id) && !terminals.has(v.run_id), 'INVALID_MODEL_HTTP_ATTEMPT');
        attempts.add(v.run_id); break;
      case 'model_http_response':
        requireHost(attempts.has(v.run_id) && !responses.has(v.run_id) && !terminals.has(v.run_id) && Number.isInteger(v.status) && v.status >= 100 && v.status <= 599, 'INVALID_MODEL_HTTP_RESPONSE');
        responses.add(v.run_id); break;
      case 'question_intent':
        requireHost(starts.has(v.run_id) && !questions.has(v.run_id) && typeof v.tool_call_id === 'string' && v.tool_call_id.length > 0 && v.tool_call_id.length <= 1024, 'INVALID_QUESTION_INTENT');
        checkQuestion(v.question); questions.add(v.run_id); break;
      case 'run_settled':
        requireHost(starts.has(v.run_id) && requests.has(v.run_id) && !terminals.has(v.run_id) && typeof v.final_entry_id === 'string' && entryIds.has(v.final_entry_id)
          && ['text', 'question'].includes(v.outcome) && record(v.target) && v.target.session_ref === nativeId
          && typeof v.target.state_revision === 'string' && /^pi_[a-f0-9]{64}$/.test(v.target.state_revision), 'INVALID_RUN_TERMINAL');
        terminals.add(v.run_id); break;
      case 'run_failed':
        requireHost(starts.has(v.run_id) && v.code === 'NO_COMPLETE_OUTPUT', 'INVALID_RUN_FAILURE'); break;
      case 'report_intent': {
        const id = opId(v);
        requireHost(starts.has(v.run_id) && terminals.has(v.run_id) && validId(id) && !reports.has(id) && nullableId(v.command_id) && nullableId(v.event_id)
          && starts.get(v.run_id)?.command_id === v.command_id && (v.source_snapshot === null || hashString(v.source_snapshot)) && nullableId(v.rejected_parent)
          && ((v.method === 'create' && v.command_id === null && v.event_id === null && validCreate(v.input))
            || (v.method === 'update' && v.command_id !== null && v.event_id !== null && validUpdate(v.input))), 'INVALID_REPORT_INTENT');
        reports.set(id, v); break;
      }
      case 'report_saved':
        requireHost(reports.get(v.op_id)?.run_id === v.run_id && validId(v.event_id) && Number.isSafeInteger(v.event_version) && v.event_version > 0, 'INVALID_REPORT_ACK'); break;
      case 'report_rejected':
        requireHost(reports.get(v.op_id)?.run_id === v.run_id && v.code === 'EVENT_VERSION_CONFLICT', 'INVALID_REPORT_REJECTION'); break;
      default: throw new HostError('UNKNOWN_RUNTIME_RECORD');
    }
  }
  return values as unknown as Journal[];
}

export interface RuntimeOptions {
  /** Test/embedding injection is in-process trusted code, not a config/HTTP plugin loader. */
  modelRuntime?: ModelRuntime;
  /** Explicit process mode, not a persisted grant, recovery freeze or automatic fallback. */
  sourcePaused?: boolean;
  registry?: RegistryProvider;
  now?: () => number;
  wrapHost?: (host: NativeHost) => NativeHost;
}
/** Serial controller; all durable state is in the owned native file and the existing product ledger. */
export class AppRuntime {
  readonly native: NativeSession;
  readonly core: CoreStore;
  readonly delivery: DeliveryStore;
  readonly registry: RegistryProvider;
  readonly deviceAuthority: DeviceAuthority | undefined;
  private readonly authorityResources: ReturnType<typeof openDeviceRegistry> | undefined;
  readonly currentAuthority: ReturnType<typeof authority>;
  session!: AgentSession;
  host!: PiNativeHost;
  private pump!: SourcePump;
  private active: Started | null = null;
  private busy: Promise<unknown> | null = null;
  private stopping = false;
  private disposed = false;
  private readonly now: () => number;
  readonly sourcePaused: boolean;
  private observation!: SourceRuntimeObservation;
  private constructor(readonly config: AppConfig, options: RuntimeOptions) {
    requireHost(options.sourcePaused === undefined || typeof options.sourcePaused === 'boolean', 'INVALID_RUNTIME_MODE');
    this.sourcePaused = options.sourcePaused === true;
    requireHost(!(this.sourcePaused && (options.modelRuntime || options.wrapHost)), 'PAUSED_MODEL_OR_HOST_OVERRIDE_FORBIDDEN');
    requireHost(!(config.device_auth && options.registry), 'DEVICE_AUTHORITY_OVERRIDE_FORBIDDEN');
    assertNoRecoveryFile(join(config.data_dir,'ledger.sqlite'));
    this.authorityResources = options.registry ? undefined : openDeviceRegistry(config.auth_file, config.device_auth);
    this.registry = options.registry ?? this.authorityResources!.registry;
    this.deviceAuthority = this.authorityResources?.deviceAuthority;
    let native: NativeSession | undefined;
    try {
      this.currentAuthority = authority(config, this.registry); this.currentAuthority();
      this.native = native = new NativeSession(config);
      this.now = options.now ?? Date.now;
      this.core = new CoreStore(this.native.database, this.now); this.delivery = new DeliveryStore(this.native.database, this.now);
    } catch (error) { try { native?.close(); } finally { this.authorityResources?.close(); } throw error; }
  }
  static async open(config: AppConfig, options: RuntimeOptions = {}) {
    const r = new AppRuntime(config, options);
    try {
      r.observe('unknown', 'RUNTIME_NOT_OBSERVED');
      r.log();
      if (r.sourcePaused) { r.observe('paused', 'SOURCE_PAUSED_EXPLICIT'); return r; }
      assertIdentity(config);
      const dir = join(config.data_dir, 'agent');
      for (const file of ['auth.json', 'models.json', 'models-store.json']) {
        const path = join(dir, file);
        if (config.identity_reference) requireHost(!existsSync(path), 'NAMED_IDENTITY_LOCAL_PROFILE_FORBIDDEN');
        else if (existsSync(path)) literalProfile(privateJson(path, 8 * 1024 * 1024));
      }
      const credentials = new AppCredentials(config.identity_reference?.credentials_file ?? join(dir, 'auth.json'), config.model.provider);
      const models = options.modelRuntime ?? await ModelRuntime.create({ credentials,
        ...(config.identity_reference ? { modelsPath: null, modelsStore: new InMemoryModelsStore() }
          : { modelsPath: join(dir, 'models.json'), modelsStorePath: join(dir, 'models-store.json') }),
        allowModelNetwork: false, refreshOnCreate: false });
      requireHost(!models.getError(), 'INVALID_MODEL_PROFILE');
      const model = models.getPhysicalModel(config.model.provider, config.model.id);
      requireHost(model && ['openai-completions', 'openai-responses', 'anthropic-messages'].includes(model.api), 'EXACT_SUPPORTED_PHYSICAL_MODEL_REQUIRED');
      const endpoint = new URL(model.baseUrl);
      requireHost(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
        && (endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname))), 'PRIVATE_MODEL_ENDPOINT_REQUIRED');
      // env:{} is only an SDK overlay, NOT an ambient-auth sandbox. The required
      // App credential store above is the no-fallback boundary; nonstandard IAM/ADC APIs are unsupported.
      if (config.allow_model_calls) {
        if (!options.modelRuntime) await credentials.read(config.model.provider);
        const resolved = await models.getAuth(model, { env: {} });
        requireHost(resolved, 'EXPLICIT_APP_MODEL_CREDENTIAL_REQUIRED');
        checkBudgetSupport(model, resolved.auth, config.model_budget.output);
      }
      const er = createExtensionRuntime();
      const loader: ResourceLoader = {
        getExtensions: () => ({ extensions: [], errors: [], runtime: er }), getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => config.systemPrompt, getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
        extendResources: () => {}, reload: async () => {},
      };
      const created = await createAgentSession({ cwd: r.native.manifest.cwd, agentDir: dir, modelRuntime: models, model, thinkingLevel: config.model.thinking,
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: 300000 } },
          cacheWarming: 'off', transport: 'sse', httpIdleTimeoutMs: 300000, enableInstallTelemetry: false, enableAnalytics: false, enableSkillCommands: false }),
        resourceLoader: loader, tools: ['app_question'], customTools: [r.questionTool()], sessionManager: r.native.manager });
      r.session = created.session;
      r.session.agent.toolExecution = 'sequential';
      const sdkStream = r.session.agent.streamFunction;
      r.session.agent.streamFunction = (selected, context, settings) => {
        r.assertModelAuthority();
        requireHost(selected.provider === config.model.provider && selected.id === config.model.id
          && (settings?.reasoning ?? 'off') === config.model.thinking, 'MODEL_SELECTION_CHANGED');
        const prompt = getCurrentSystemPrompt(context.messages);
        requireHost(prompt?.includes(config.systemPrompt), 'MODEL_IDENTITY_CONTEXT_CHANGED');
        const run = r.active!;
        requireHost(!r.log().some(v => v.kind === 'model_request_intent' && v.run_id === run.run_id), 'ORIGINAL_MODEL_REQUEST_ALREADY_STARTED');
        r.requireRequestSlot();
        r.append({ kind: 'model_request_intent', run_id: run.run_id }); // Unknown reservations are never refunded.
        let payloadChecked = false; let attempted = false;
        const output = config.model_budget.output;
        return sdkStream(selected, context, { ...settings, env: {}, maxRetries: 0, cacheRetention: 'none',
          ...(output.mode === 'protocol_tokens' ? { maxTokens: output.max_tokens } : {}),
          onPayload: async (payload, physical) => {
            const replacement = await settings?.onPayload?.(payload, physical);
            const final = replacement === undefined ? payload : replacement;
            r.assertModelAuthority(); checkOutputPayload(physical.api, final, output); payloadChecked = true;
            return final;
          },
          fetch: async (input, init) => {
            r.assertModelAuthority();
            requireHost(payloadChecked && !attempted, 'ONE_HTTP_ATTEMPT_PER_MODEL_RUN');
            const request = new Request(input, init); const url = new URL(request.url); const base = new URL(selected.baseUrl);
            requireHost(request.method === 'POST' && url.origin === base.origin && !url.username && !url.password && !url.hash
              && url.pathname.startsWith(`${base.pathname.replace(/\/$/u, '')}/`), 'MODEL_HTTP_TARGET_CHANGED');
            attempted = true; r.append({ kind: 'model_http_attempt', run_id: run.run_id });
            // A redirect is a different target, not authority to forward this credential.
            const response = await fetch(request, { redirect: 'error' });
            r.append({ kind: 'model_http_response', run_id: run.run_id, status: response.status });
            return response;
          } });
      };
      r.host = new PiNativeHost(r.native, r.session, id => r.delivery.get(factPrincipal(config), id), () => {
        requireHost(!r.unfinished() && !r.acceptedWithoutReport(), 'ORIGINAL_MODEL_RUN_UNRESOLVED'); r.currentAuthority(); assertIdentity(config);
        if (config.allow_model_calls) r.requireRequestSlot();
      });
      r.host.target(); r.native.sync();
      r.pump = new SourcePump(r.delivery, r.currentAuthority, options.wrapHost?.(r.host) ?? r.host, join(config.data_dir, 'source-pump.json'));
      r.observe('running', 'RUNTIME_INITIALIZED');
      return r;
    } catch (error) {
      // Ownership survives a failed open: one cleanup error must not strand the remaining resources.
      try { r.session?.dispose(); }
      finally { try { r.native.close(); } finally { r.authorityResources?.close(); } }
      throw error;
    }
  }
  private observe(state: RuntimeState, reason: RuntimeReason) {
    if (this.observation?.state === state && this.observation.reason_code === reason) return;
    this.observation = { source_id: this.config.source.source_id, source_epoch: this.config.source.source_epoch, state,
      model_permission_configured: this.config.allow_model_calls, reason_code: reason, observed_at: new Date(this.now()).toISOString() };
  }
  get sourceRuntime(): SourceRuntimeProvider {
    const binding = this.config.source;
    return { owner_id: binding.owner_id, source_id: binding.source_id, source_epoch: binding.source_epoch,
      observe: () => ({ ...this.observation }) };
  }
  private log(): Journal[] {
    return validateRuntimeBackupJournal(this.native.entries(), this.config.bindingHash, this.native.manifest.native_id, this.config.model_budget.request_limit);
  }
  private append(value: Journal) { this.native.append(value as unknown as Record<string, unknown>); this.log(); }
  private unfinished() {
    const log = this.log();
    return log.filter((v): v is Started => v.kind === 'run_started').find(v => !log.some(s => s.kind === 'report_saved' && s.run_id === v.run_id));
  }
  private acceptedWithoutReport() {
    const log = this.log();
    return this.native.entries().some(e => {
      if (e.type !== 'custom_message' || e.customType !== responseType) return false;
      requireHost(record(e.details) && typeof e.details.command_id === 'string', 'INVALID_NATIVE_RECEIPT');
      const commandId = e.details.command_id;
      const start = log.find((v): v is Started => v.kind === 'run_started' && v.command_id === commandId);
      return !start || !log.some(v => v.kind === 'report_saved' && v.run_id === start.run_id);
    });
  }
  private requireRequestSlot() {
    requireHost(this.log().filter(v => v.kind === 'model_request_intent').length < this.config.model_budget.request_limit, 'MODEL_REQUEST_BUDGET_EXHAUSTED');
  }
  private assertModelAuthority() {
    assertIdentity(this.config);
    requireHost(this.config.allow_model_calls && !this.stopping && this.active, 'MODEL_CALLS_DISABLED');
    const a = this.currentAuthority(); this.native.assertParity();
    if (this.active.command_id !== null) {
      const c = this.delivery.get(a.principal, this.active.command_id);
      requireHost(c.receipt?.message_id === this.active.input_entry_id && this.core.getResponse(a.principal, c.response_id, a.registry).eligibility_state === 'waiting_source', 'MODEL_INPUT_NO_LONGER_ELIGIBLE');
    }
  }
  private questionTool(): ToolDefinition<typeof questionSchema> {
    return { name: 'app_question', label: 'App question', exposure: 'model-only', description: 'Save exactly one next App question in this run, then stop. Actual event publication happens after the native run settles. You cannot choose source, session, target or event IDs.',
      parameters: questionSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute: async (call, params, signal) => {
        this.assertModelAuthority(); requireHost(!signal?.aborted && call.length > 0 && call.length <= 1024, 'QUESTION_INTERRUPTED');
        const run = this.active!;
        requireHost(Number.isInteger(params.ttl_seconds) && params.ttl_seconds >= 30 && params.ttl_seconds <= 86400, 'INVALID_QUESTION_TTL');
        const q: Question = { title: params.title, body: params.body, actions: params.actions, expires_at: new Date(this.now() + params.ttl_seconds * 1000).toISOString() };
        checkQuestion(q);
        const previous = this.log().find((v): v is QuestionIntent => v.kind === 'question_intent' && v.run_id === run.run_id);
        if (previous) {
          requireHost(previous.tool_call_id === call && canonical({ ...previous.question, expires_at: '' }) === canonical({ ...q, expires_at: '' }), 'ONE_QUESTION_PER_RUN');
        } else this.append({ kind: 'question_intent', run_id: run.run_id, tool_call_id: call, question: q });
        const intent = previous ?? { kind: 'question_intent' as const, run_id: run.run_id, tool_call_id: call, question: q };
        return { content: [{ type: 'text', text: 'Question intent persisted in this native session; event/device delivery is not yet acknowledged.' }],
          details: { protocol: 'app_question_v1', scope: this.config.bindingHash, run_id: run.run_id, tool_call_id: call, intent_hash: digest(intent), terminate: true }, terminate: true };
      } };
  }
  /** Query only persisted native entries belonging to this exact control run. */
  private outcome(start: Started): Outcome | null {
    const entries = this.native.entries();
    const controls = entries.filter(e => e.type === 'custom_message' && e.customType === controlType && record(e.details) && e.details.scope === this.config.bindingHash && e.details.run_id === start.run_id);
    if (controls.length !== 1) return null;
    const control = controls[0]!;
    if (control.type !== 'custom_message' || !record(control.details) || control.details.command_id !== start.command_id) return null;
    const from = entries.findIndex(e => e.id === control.id);
    if (entries.findIndex(e => e.id === start.input_entry_id) >= from) return null;
    const tail = entries.slice(from + 1);
    if (tail.some(e => e.type === 'custom_message' || (e.type === 'message' && e.message.role === 'user'))) return null;
    const messages = tail.filter((e): e is Extract<SessionEntry, { type: 'message' }> => e.type === 'message');
    const assistants = messages.filter(e => e.message.role === 'assistant');
    if (!assistants.length || assistants.some(e => e.message.role !== 'assistant' || e.message.provider !== this.config.model.provider || e.message.model !== this.config.model.id || !['stop', 'toolUse'].includes(e.message.stopReason))
      || messages.some(e => e.message.role === 'toolResult' && e.message.isError)) return null;
    const final = assistants.at(-1)!;
    if (final.message.role !== 'assistant') return null;
    const toolCalls = assistants.flatMap(e => e.message.role === 'assistant' ? e.message.content.filter(b => b.type === 'toolCall') : []);
    const results = messages.filter(e => e.message.role === 'toolResult');
    if (new Set(toolCalls.map(c => c.id)).size !== toolCalls.length || toolCalls.length !== results.length || toolCalls.some(c => results.filter(e => e.message.role === 'toolResult' && e.message.toolCallId === c.id && e.message.toolName === c.name).length !== 1)) return null;
    const intent = this.log().find((v): v is QuestionIntent => v.kind === 'question_intent' && v.run_id === start.run_id);
    if (final.message.stopReason === 'stop') {
      if (intent || toolCalls.length || messages.at(-1)?.id !== final.id || final.message.content.some(c => !['text', 'thinking'].includes(c.type))) return null;
      const text = final.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return { kind: 'text', entry_id: final.id, text };
    }
    // terminate is not persisted by SDK as a top-level message field; the owned tool records its exact proof in details.
    if (!intent || toolCalls.length !== 1 || results.length !== 1 || toolCalls[0]?.name !== 'app_question' || toolCalls[0].id !== intent.tool_call_id || messages.at(-1)?.id !== results[0]?.id) return null;
    const result = results[0]!.message;
    if (result.role !== 'toolResult' || !record(result.details) || canonical(result.details) !== canonical({ protocol: 'app_question_v1', scope: this.config.bindingHash, run_id: start.run_id, tool_call_id: intent.tool_call_id, intent_hash: digest(intent), terminate: true })) return null;
    return { kind: 'question', entry_id: final.id, question: intent.question };
  }
  private settle(start: Started): Settled | null {
    this.native.sync(); const outcome = this.outcome(start); if (!outcome) return null;
    const value: Settled = { kind: 'run_settled', run_id: start.run_id, final_entry_id: outcome.entry_id, outcome: outcome.kind, target: this.host.target() };
    this.append(value); return value;
  }
  private async start(command: Command | null) {
    this.currentAuthority(); requireHost(!this.unfinished() && this.session.isIdle && !this.session.pendingMessageCount, 'MODEL_RUN_NOT_IDLE');
    if (!this.config.allow_model_calls) return { state: command ? 'source_received_model_disabled' : 'initial_model_disabled' };
    assertIdentity(this.config); this.requireRequestSlot();
    const input = command?.receipt?.message_id ?? this.native.manager.getEntries()[3]!.id;
    requireHost(!command || command.receipt?.message_id === this.host.getReceipt(command.id)?.message_id, 'ORIGINAL_RECEIPT_REQUIRED');
    const start: Started = { kind: 'run_started', run_id: stableId('run', this.native.manifest.native_id, command?.id ?? 'bootstrap'), command_id: command?.id ?? null, input_entry_id: input };
    requireHost(!this.log().some(v => v.kind === 'run_started' && v.run_id === start.run_id), 'ORIGINAL_RUN_ALREADY_STARTED');
    this.append(start); // fsync commits before even calling sendCustomMessage.
    this.active = start;
    try {
      this.assertModelAuthority();
      await this.session.sendCustomMessage({ customType: controlType, display: true,
        content: 'Process the already persisted App input. Do not inject it again or infer execution permission from transport metadata. Ask one next question with app_question, or provide a text result. No other actions are available.',
        details: { scope: this.config.bindingHash, run_id: start.run_id, command_id: start.command_id } }, { triggerTurn: true });
    } catch { /* Exact native output is the authority, not a thrown provider message containing secrets. */ }
    finally { this.active = null; }
    if (this.stopping) return { state: 'model_interrupted' };
    const settled = this.settle(start);
    if (!settled) { this.append({ kind: 'run_failed', run_id: start.run_id, code: 'NO_COMPLETE_OUTPUT' }); return { state: 'model_outcome_unresolved' }; }
    return this.report(start, settled);
  }
  private makeReport(start: Started, settled: Settled): Report {
    const outcome = this.outcome(start);
    requireHost(outcome?.entry_id === settled.final_entry_id && outcome.kind === settled.outcome, 'ORIGINAL_OUTPUT_CHANGED');
    const a = this.currentAuthority();
    const question = outcome.question;
    if (question) requireHost(parseExpiry(question.expires_at) > this.now(), 'ORIGINAL_QUESTION_EXPIRED');
    const body = question?.body ?? (outcome.text?.trim() ? outcome.text : '来源本轮已结束，但没有可回传的可见文字；这不是执行或独立验收回执。');
    const interaction = question ? { id: stableId('int', start.run_id), actions: question.actions } : undefined;
    if (start.command_id === null) {
      const input: CreateEvent = { request_id: stableId('create', start.run_id), title: question?.title ?? '独立 App 会话输出', body: boundedBody(body),
        session_ref: settled.target.session_ref, target_revision: settled.target.state_revision, expires_at: question?.expires_at ?? new Date(this.now() + 3600000).toISOString(), ...(interaction ? { interaction } : {}) };
      requireHost(validCreate(input), 'INVALID_CREATE_REPORT');
      return { kind: 'report_intent', run_id: start.run_id, command_id: null, event_id: null, method: 'create', input, source_snapshot: null, rejected_parent: null };
    }
    const c = this.delivery.get(a.principal, start.command_id);
    const event = this.core.getEvent(a.principal, c.event_id, a.registry);
    requireHost(event.interaction?.id === c.response.interaction_id && event.interaction_version === c.response.interaction_version
      && event.target_revision === c.response.target.state_revision && event.reserved_response_id === c.response_id, 'EVENT_BINDING_CHANGED');
    const openQuestion = question && event.disposition === 'open';
    const input: UpdateEvent = { update_id: stableId('update', start.run_id), expected_event_version: event.event_version,
      kind: question ? 'progress' : 'source_result_reported', body: boundedBody(question && !openQuestion ? `来源生成了后续问题，但事项保持关闭，未替换交互：\n${body}` : body),
      ...(openQuestion ? { title: question.title, interaction: interaction!, target_revision: settled.target.state_revision, expires_at: question.expires_at } : {}) };
    requireHost(validUpdate(input), 'INVALID_UPDATE_REPORT');
    return { kind: 'report_intent', run_id: start.run_id, command_id: c.id, event_id: c.event_id, method: 'update', input, source_snapshot: sourceSnapshot(event), rejected_parent: null };
  }
  private submit(report: Report) {
    const a = this.currentAuthority();
    try {
      const saved = report.method === 'create' ? this.core.create(a.principal, report.input as CreateEvent) : this.delivery.update(a.principal, report.command_id!, report.input as UpdateEvent);
      this.append({ kind: 'report_saved', run_id: report.run_id, op_id: opId(report), event_id: saved.event_id, event_version: saved.event_version });
      return { state: 'report_saved', event_id: saved.event_id, event_version: saved.event_version };
    } catch (error) {
      if (report.method === 'update' && error instanceof ApiError && error.code === 'EVENT_VERSION_CONFLICT') {
        this.append({ kind: 'report_rejected', run_id: report.run_id, op_id: opId(report), code: 'EVENT_VERSION_CONFLICT' });
        return { state: 'report_version_conflict' };
      }
      throw error;
    }
  }
  private report(start: Started, settled: Settled) {
    const report = this.makeReport(start, settled); this.append(report); return this.submit(report);
  }
  private replay(start: Started, settled: Settled) {
    const log = this.log(); const reports = log.filter((v): v is Report => v.kind === 'report_intent' && v.run_id === start.run_id);
    if (!reports.length) return this.report(start, settled);
    const last = reports.at(-1)!;
    if (!log.some(v => v.kind === 'report_rejected' && v.op_id === opId(last))) return this.submit(last); // Original ID/body first, including unknown ACK.
    const a = this.currentAuthority();
    requireHost(last.method === 'update' && last.event_id && last.command_id, 'REPORT_CONFLICT_REQUIRES_INSPECTION');
    const event = this.core.getEvent(a.principal, last.event_id, a.registry);
    requireHost(sourceSnapshot(event) === last.source_snapshot, 'REPORT_CONFLICT_REQUIRES_INSPECTION');
    // A known transactional rejection, unchanged source content, and only user state changes: append a fact, never a new interaction/target.
    const input: UpdateEvent = { update_id: stableId('late', opId(last), event.event_version), expected_event_version: event.event_version,
      kind: (last.input as UpdateEvent).kind, body: (last.input as UpdateEvent).body };
    const late: Report = { ...last, input, source_snapshot: sourceSnapshot(event), rejected_parent: opId(last) };
    this.append(late); return this.submit(late);
  }
  private reconcileAccepted() {
    const a = this.currentAuthority();
    const ids = this.native.entries().filter(e => e.type === 'custom_message' && e.customType === responseType).map(e => {
      requireHost(e.type === 'custom_message' && record(e.details) && typeof e.details.command_id === 'string', 'INVALID_NATIVE_RECEIPT'); return e.details.command_id;
    });
    for (const id of ids) {
      const c = this.delivery.get(a.principal, id); const r = this.host.getReceipt(id);
      requireHost(r, 'ORIGINAL_NATIVE_RECEIPT_MISSING');
      if (!c.receipt) this.delivery.receipt(a.principal, id, id, r);
    }
    return ids;
  }
  private pumpHasWork() {
    const path = join(this.config.data_dir, 'source-pump.json');
    if (existsSync(path)) {
      const j = privateJson(path, 4096);
      requireHost(record(j) && ['claiming', 'submitting', 'settled'].includes(String(j.phase)), 'INVALID_SOURCE_JOURNAL');
      if (j.phase !== 'settled') return true;
    }
    const a = this.currentAuthority(); let after = 0;
    while (true) {
      const rows = this.native.database.prepare('SELECT r.seq,r.id FROM responses r LEFT JOIN commands c ON c.owner=r.owner AND c.response_id=r.id WHERE r.owner=? AND r.source=? AND r.epoch=? AND c.id IS NULL AND r.seq>? ORDER BY r.seq LIMIT 100').all(a.principal.owner_id, a.principal.source_id, a.principal.source_epoch, after) as { seq: number; id: string }[];
      if (!rows.length) return false;
      for (const row of rows) if (this.core.getResponse(a.principal, row.id, a.registry).eligibility_state === 'waiting_source') return true;
      after = rows.at(-1)!.seq;
    }
  }
  private async tick() {
    requireHost(!this.stopping, 'RUNTIME_STOPPING');this.native.assertParity(); this.currentAuthority();
    if (this.sourcePaused) { this.native.assertParity(); return { state: 'source_paused' }; }
    const log = this.log(); const unfinished = this.unfinished();
    if (unfinished) {
      let settled = log.find((v): v is Settled => v.kind === 'run_settled' && v.run_id === unfinished.run_id);
      if (!settled) settled = this.settle(unfinished) ?? undefined; // Query persisted output, never trigger the original model run again.
      return settled ? this.replay(unfinished, settled) : { state: 'original_model_run_unresolved' };
    }
    const accepted = this.reconcileAccepted();
    const pending = accepted.find(id => !log.some(v => v.kind === 'run_started' && v.command_id === id));
    if (pending) return this.start(this.delivery.get(this.currentAuthority().principal, pending));
    if (this.pumpHasWork()) {
      const result = this.pump.runOnce();
      if (result.state === 'source_received' && typeof result.command_id === 'string' && !this.log().some(v => v.kind === 'run_started' && v.command_id === result.command_id)) return this.start(this.delivery.get(this.currentAuthority().principal, result.command_id));
      return result;
    }
    return !log.some(v => v.kind === 'run_started') ? this.start(null) : { state: 'idle' };
  }
  runOnce(): Promise<unknown> {
    requireHost(!this.busy, 'RUNTIME_TICK_ALREADY_ACTIVE');
    this.busy = this.tick().then(result => {
      const state = record(result) && typeof result.state === 'string' ? result.state : '';
      if (this.sourcePaused) this.observe('paused', 'SOURCE_PAUSED_EXPLICIT');
      else if (['original_model_run_unresolved', 'model_outcome_unresolved', 'model_interrupted'].includes(state)) this.observe('blocked', 'ORIGINAL_MODEL_RUN_UNRESOLVED');
      else this.observe('running', state.endsWith('_model_disabled') ? 'MODEL_PERMISSION_DISABLED' : 'RUNTIME_LOOP_OBSERVED');
      return result;
    }).catch(error => {
      const reason = error instanceof HostError && ['MODEL_REQUEST_BUDGET_EXHAUSTED', 'SOURCE_AUTHORIZATION_CHANGED', 'ORIGINAL_MODEL_RUN_UNRESOLVED'].includes(error.code)
        ? error.code as RuntimeReason : 'RUNTIME_UNAVAILABLE';
      this.observe('blocked', reason); throw error;
    }).finally(() => { this.busy = null; }); return this.busy;
  }
  async stop() { this.stopping = true; this.observe('blocked', 'RUNTIME_STOPPING'); if (this.session) await this.session.abort(); await this.busy?.catch(() => {}); }
  async close() {
    if (this.disposed) return;
    await this.stop(); this.disposed = true;
    try { this.session?.dispose(); } finally { try { this.native.close(); } finally { this.authorityResources?.close(); } }
  }
}
