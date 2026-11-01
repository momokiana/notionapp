import { writeSync } from 'node:fs';
import { loadConfig } from '../../src/config.js';
import { AppRuntime } from '../../src/runtime.js';
import { pausedPhysicalModel } from './source-paused-model.js';

if (process.env.NOTIONAPP_SOURCE_PAUSE_CRASH !== '1' || process.argv.length !== 3) throw new Error('Explicit isolated crash fixture required');
process.umask(0o077);
const config = loadConfig(process.argv[2]!);
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.url !== 'http://127.0.0.1:0/v1/responses') throw new Error('Unexpected synthetic SDK target; no request allowed');
  // The production wrapper has already synced model_request_intent and model_http_attempt.
  // No underlying fetch is called, so this is a genuine durable pre-fetch unknown, not a provider request.
  writeSync(1, 'fault:source-paused-http-intent\n'); process.kill(process.pid, 'SIGKILL');
  throw new Error('Expected owned SIGKILL did not occur');
};
const models = await pausedPhysicalModel(config.data_dir);
const runtime = await AppRuntime.open(config, { modelRuntime: models });
try { await runtime.runOnce(); } finally { await runtime.close(); }
