import { join } from 'node:path';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AppCredentials } from '../../src/credentials.js';

/** Real SDK Responses construction, never a remote model. Callers must intercept global fetch; port 0 cannot be a service target. */
export async function pausedPhysicalModel(dataDir: string) {
  const runtime = await ModelRuntime.create({ credentials: new AppCredentials(join(dataDir, 'agent/auth.json'), 'openai'), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.refresh = async () => ({ aborted: false, errors: new Map() });
  runtime.registerProvider('openai', { api: 'openai-responses', baseUrl: 'http://127.0.0.1:0/v1', apiKey: 'sk-synthetic-paused-no-network',
    models: [{ id: 'gpt-6-sol', name: 'Synthetic pre-network SDK request only', reasoning: true,
      thinkingLevelMap: { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }, input: ['text'], contextWindow: 128000,
      maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  return runtime;
}
