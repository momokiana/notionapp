// Independently authored wire-format examples, not copied agent sessions or upstream implementation.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export const CODEX_ID = '00000000-0000-4000-8000-000000000002';
export const SELECTED = [{ key: 'claude:synthetic_selected', alias: 'Synthetic Claude 中文😀' }, { key: `codex:${CODEX_ID}`, alias: 'Synthetic Codex 中文😀' }];
export const MARKER = 'FIXTURE_PRIVATE_CONTENT_中文😀';
const stamp = () => new Date().toISOString();
const line = v => JSON.stringify(v) + '\n';
function put(path, text) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, text, { mode: 0o600 }); }
export function seed(home) {
  const claude = join(home, '.claude/projects/synthetic/synthetic_selected.jsonl');
  const unselected = join(home, '.claude/projects/synthetic/synthetic_unselected.jsonl');
  const codex = join(home, `.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-${CODEX_ID}.jsonl`);
  const user = id => ({ type: 'user', uuid: id, sessionId: 'synthetic_selected', cwd: '/work/FIXTURE_PRIVATE_PATH', timestamp: stamp(), message: { role: 'user', content: MARKER } });
  put(claude, line({ type: 'custom-title', customTitle: 'FIXTURE_PRIVATE_TITLE', timestamp: stamp() }) + line(user('synthetic_user_1')));
  put(unselected, line({ ...user('synthetic_unselected_user'), sessionId: 'synthetic_unselected' }));
  put(codex, line({ type: 'session_meta', timestamp: stamp(), payload: { id: CODEX_ID, timestamp: stamp(), cwd: '/work/FIXTURE_PRIVATE_PATH', source: 'cli' } }) + line({ type: 'response_item', timestamp: stamp(), payload: { type: 'message', id: 'synthetic_codex_user_1', role: 'user', content: [{ type: 'input_text', text: MARKER }] } }));
  return { claude, codex, unselected };
}
export function appendLive(files, generation = 'live') {
  for (let i = 0; i < 12; i++) {
    appendFileSync(files.claude, line({ type: 'assistant', uuid: `${generation}_claude_${i}`, timestamp: stamp(), message: { id: `${generation}_message_${i}`, role: 'assistant', content: [{ type: 'text', text: `${MARKER} ${i}` }], stop_reason: 'end_turn' } }));
    appendFileSync(files.codex, line({ type: 'response_item', timestamp: stamp(), payload: { type: 'message', id: `${generation}_codex_${i}`, role: 'assistant', content: [{ type: 'output_text', text: `${MARKER} ${i}` }] } }));
  }
  appendFileSync(files.claude, line({ type: 'system', subtype: 'turn_duration', uuid: `${generation}_end`, timestamp: stamp(), durationMs: 50 }));
  appendFileSync(files.codex, line({ type: 'event_msg', timestamp: stamp(), payload: { type: 'task_complete', turn_id: generation } }));
  appendFileSync(files.unselected, line({ type: 'user', uuid: `${generation}_unselected`, timestamp: stamp(), message: { role: 'user', content: MARKER } }));
}
