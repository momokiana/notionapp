import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type Api } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { parseRegistry } from 'notification-server/auth';
import { loadConfig } from '../src/config.js';
import { initialize } from '../src/native.js';
import type { AppRuntime } from '../src/runtime.js';
import type { Action } from 'notification-server/contracts';

export function fixture(allow = true, model = { provider: 'isolated-fixture', id: 'fixture' }) {
  const root = mkdtempSync('/tmp/notionapp-pi-test-');
  const userToken = randomBytes(32).toString('hex'); const sourceToken = randomBytes(32).toString('hex');
  const principals = [
    { id: 'phone-user', owner_id: 'fixture-owner', kind: 'user', token: userToken },
    { id: 'app-principal', owner_id: 'fixture-owner', kind: 'source', source_id: 'fixture-app', source_epoch: 'fixture-epoch', token: sourceToken, capabilities: ['publish', 'reply', 'deliver', 'read_responses'] },
  ];
  const authFile = join(root, 'registry.json'); const seed = join(root, 'initial.txt'); const configFile = join(root, 'config.json');
  writeFileSync(authFile, JSON.stringify({ principals }), { mode: 0o600 });
  writeFileSync(seed, 'Isolated App test instruction: ask a phone question with app_question. This is not a real cloud or work session.', { mode: 0o600 });
  const value = { data_dir: join(root, 'app'), auth_file: authFile, initial_prompt_file: seed,
    source: { owner_id: 'fixture-owner', principal_id: 'app-principal', source_id: 'fixture-app', source_epoch: 'fixture-epoch' }, model, allow_model_calls: allow };
  writeFileSync(configFile, JSON.stringify(value), { mode: 0o600 });
  return { root, configFile, value, authFile, principals, userToken, sourceToken,
    get config() { return loadConfig(configFile); },
    init() { return initialize(loadConfig(configFile)); },
    registry() { return parseRegistry({ principals }); },
    saveGrants() { writeFileSync(authFile, JSON.stringify({ principals }), { mode: 0o600 }); },
    user() { return parseRegistry({ principals }).authenticate(`Bearer ${userToken}`); },
    source() { return parseRegistry({ principals }).authenticate(`Bearer ${sourceToken}`); },
  };
}
const childPath = fileURLToPath(new URL('./fixtures/child.ts', import.meta.url));
export function child(mode: string, f: ReturnType<typeof fixture>, extra: Record<string, string> = {}) {
  return spawn(process.execPath, ['--import', 'tsx', childPath, mode, f.configFile], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: f.root, ...extra }, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
export async function exited(c: ReturnType<typeof child>) {
  let out = '', error = '';
  c.stdout.on('data', b => { out += String(b); }); c.stderr.on('data', b => { error += String(b); });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; c.kill('SIGKILL'); }, 120000);
  try {
    const [code, signal] = await once(c, 'exit');
    if (timedOut) throw new Error('Owned test child timed out before its expected boundary; not a successful injected crash');
    if (signal === 'SIGKILL' && !out.includes('fault:')) throw new Error('Unmarked child SIGKILL is not fault-injection evidence');
    return { code, signal, out, error };
  } finally { clearTimeout(timeout); }
}
export const actions: Action[] = [{ id: 'confirm', label: '确认', type: 'button' }, { id: 'reply', label: '文字回应', type: 'text' }];
export const ask = (body = '请选择下一步'): Plan => ({ question: { title: '隔离 App 问题', body, ttl_seconds: 3600, actions } });
export interface Plan {
  text?: string; question?: { title: string; body: string; ttl_seconds: number; actions: Action[] };
  stop?: Exclude<AssistantMessage['stopReason'], 'pending'>; thinking?: string; onRequest?: () => void; extraQuestion?: boolean;
}
export async function fakeModels(root: string, plans: Plan[] = [ask(), { text: '来源自报结果：已保留原回应，未执行外部操作。' }]) {
  mkdirSync(join(root, 'fake-agent'), { mode: 0o700, recursive: true });
  const runtime = await ModelRuntime.create({ authPath: join(root, 'fake-agent', 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const calls: { model: Model<Api>; context: Context; env: unknown }[] = [];
  // registerProvider normally schedules availability checks for ALL builtins. Keep this fixture
  // strictly offline and free of ambient credential discovery; static registration is sufficient.
  const refresh = runtime.refresh;
  runtime.refresh = async () => ({ aborted: false, errors: new Map() });
  runtime.registerProvider('isolated-fixture', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:0/v1', apiKey: 'isolated-non-secret',
    models: [{ id: 'fixture', name: 'Deterministic local fixture, not cloud', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 }],
    streamSimple: (model, context, options) => {
      calls.push({ model, context: structuredClone(context), env: options?.env });
      const plan = plans[calls.length - 1] ?? { text: 'unexpected extra fixture request' };
      plan.onRequest?.();
      const content: AssistantMessage['content'] = [];
      if (plan.thinking) content.push({ type: 'thinking', thinking: plan.thinking });
      if (plan.question) content.push({ type: 'toolCall', id: `fixture_question_${calls.length}`, name: 'app_question', arguments: { ...plan.question, actions: plan.question.actions.map(a => ({ ...a })) } });
      else content.push({ type: 'text', text: plan.text ?? '' });
      if (plan.extraQuestion && plan.question) content.push({ type: 'toolCall', id: `fixture_extra_${calls.length}`, name: 'app_question', arguments: { ...plan.question, actions: plan.question.actions.map(a => ({ ...a })) } });
      const stop = plan.stop ?? (plan.question ? 'toolUse' : 'stop');
      const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: stop, timestamp: Date.now(),
        ...(['error', 'aborted'].includes(stop) ? { errorMessage: 'isolated fixture interruption' } : {}) };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message });
        if (stop === 'error' || stop === 'aborted') stream.push({ type: 'error', reason: stop, error: message });
        else stream.push({ type: 'done', reason: stop, message });
        stream.end();
      });
      return stream;
    } });
  runtime.refresh = refresh;
  return { runtime, calls };
}
export function manualEvent(runtime: AppRuntime, body = '隔离手动卡片', target = runtime.host.target()) {
  const a = runtime.currentAuthority();
  const saved = runtime.core.create(a.principal, { request_id: randomUUID(), title: '隔离卡片', body, session_ref: target.session_ref, target_revision: target.state_revision,
    expires_at: new Date(Date.now() + 3600000).toISOString(), interaction: { id: randomUUID(), actions } });
  return runtime.core.getEvent(a.principal, saved.event_id, a.registry);
}
export function respond(runtime: AppRuntime, f: ReturnType<typeof fixture>, eventId: string, text = '', actionId = 'confirm') {
  const e = runtime.core.getEvent(f.user(), eventId, f.registry());
  const id = randomUUID();
  runtime.core.respond(f.user(), e.id, { response_id: id, event_version: e.event_version, interaction_id: e.interaction!.id, interaction_version: e.interaction_version, action_id: actionId, text }, f.registry());
  return id;
}
