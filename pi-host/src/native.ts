import { chmodSync, existsSync, lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SessionManager, VERSION, CURRENT_SESSION_VERSION, type AgentSession, type SessionEntry, type SessionHeader } from '@earendil-works/pi-coding-agent';
import { openDatabase } from 'notification-server/database';
import {assertNoRecovery,assertNoRecoveryFile} from 'notification-server/recovery-gate';
import { CoreStore, parseExpiry } from 'notification-server/core';
import type { Command, NativeHost, NativeReceipt } from 'notification-server/delivery';
import { assertIdentity, type AppConfig } from './config.js';
import { canonical, digest, HostError, newPrivateFile, noSymlinks, privateBytes, privateDirectory, privateJson, record, requireHost, saveJson, syncFile } from './private-files.js';

const FORMAT = 1;
const SDK = '1.4.0';
export const MAX_NATIVE_BYTES = 64 * 1024 * 1024;
const ownerType = 'notifier_owner';
export const runtimeType = 'notifier_runtime';
export const responseType = 'notifier_response';
export const controlType = 'notifier_run';
interface Pending {
  version: 1; sdk: string; binding_hash: string; native_id: string; session_file: string; cwd: string;
}
interface Manifest extends Pending { prefix_hash: string }
interface Raw { header: SessionHeader; entries: SessionEntry[]; text: string; dev: number; ino: number }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const entryId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const ledgerPath = (c: AppConfig) => join(c.data_dir, 'ledger.sqlite');
const manifestPath = (c: AppConfig) => join(c.data_dir, 'manifest.json');
const pendingPath = (c: AppConfig) => join(c.data_dir, 'initializing.json');
function versionCheck() { requireHost(VERSION === SDK && CURRENT_SESSION_VERSION === 3, 'UNSUPPORTED_PI_VERSION'); }
function pendingOf(c: AppConfig, value: unknown): Pending {
  requireHost(record(value) && value.version === FORMAT && value.sdk === SDK && value.binding_hash === c.bindingHash && uuid(value.native_id)
    && typeof value.session_file === 'string' && dirname(value.session_file) === join(c.data_dir, 'native')
    && basename(value.session_file).endsWith(`_${value.native_id}.jsonl`) && value.cwd === join(c.data_dir, 'work'), 'BINDING_MISMATCH');
  noSymlinks(value.session_file);
  return value as unknown as Pending;
}
function rawNative(c: AppConfig, p: Pending): Raw {
  const file = privateBytes(p.session_file, MAX_NATIVE_BYTES);
  return { ...validateNativeBackupBytes(c, p, file.bytes), dev: file.dev, ino: file.ino };
}
/** Pure validation of authenticated backup bytes. No path traversal, SDK open, repair or source execution. */
export function validateNativeBackupBytes(c: Pick<AppConfig, 'bindingHash' | 'model' | 'initialPrompt'>,
  p: { native_id: string; cwd: string }, bytes: Uint8Array): Pick<Raw, 'header' | 'entries' | 'text'> {
  requireHost(bytes.byteLength <= MAX_NATIVE_BYTES, 'NATIVE_FILE_INVALID');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  requireHost(text.endsWith('\n') && !text.includes('\r'), 'NATIVE_FILE_INCOMPLETE');
  const lines = text.slice(0, -1).split('\n');
  requireHost(lines.length >= 5 && lines.length <= 100000 && lines.every(Boolean), 'NATIVE_FILE_INVALID');
  const values: unknown[] = lines.map(line => JSON.parse(line));
  const h = values[0];
  requireHost(record(h) && h.type === 'session' && h.version === 3 && h.id === p.native_id && h.cwd === p.cwd && h.parentSession === undefined
    && typeof h.timestamp === 'string' && Number.isFinite(Date.parse(h.timestamp))
    && Object.keys(h).every(k => ['type', 'version', 'id', 'timestamp', 'cwd'].includes(k)), 'NATIVE_HEADER_MISMATCH');
  let previous: string | null = null; const seen = new Set<string>();
  for (const e of values.slice(1)) {
    requireHost(record(e) && entryId(e.id) && !seen.has(e.id) && e.parentId === previous && typeof e.timestamp === 'string' && Number.isFinite(Date.parse(e.timestamp)), 'NATIVE_NOT_LINEAR');
    seen.add(e.id); previous = e.id;
    requireHost(['message', 'model_change', 'thinking_level_change', 'custom', 'custom_message', 'usage'].includes(String(e.type)), 'UNSUPPORTED_NATIVE_ENTRY');
    if (e.type === 'message') requireHost(record(e.message) && ['user', 'system', 'assistant', 'toolResult'].includes(String(e.message.role)), 'INVALID_NATIVE_MESSAGE');
    if (e.type === 'custom') requireHost([ownerType, runtimeType].includes(String(e.customType)) && record(e.data), 'INVALID_NATIVE_METADATA');
    if (e.type === 'custom_message') requireHost([responseType, controlType].includes(String(e.customType)) && typeof e.content === 'string' && record(e.details), 'INVALID_NATIVE_INPUT');
  }
  const entries = values.slice(1) as SessionEntry[];
  const [marker, model, thinking, seed] = entries;
  requireHost(marker?.type === 'custom' && marker.customType === ownerType && canonical(marker.data) === canonical({ version: FORMAT, binding_hash: c.bindingHash })
    && model?.type === 'model_change' && model.provider === c.model.provider && model.modelId === c.model.id
    && thinking?.type === 'thinking_level_change' && thinking.thinkingLevel === c.model.thinking
    && seed?.type === 'message' && seed.message.role === 'user' && seed.message.content === c.initialPrompt, 'NATIVE_PREFIX_MISMATCH');
  // Reject noncanonical bytes before SDK.open: its loader would otherwise silently skip/repair them.
  requireHost(values.map(v => `${JSON.stringify(v)}\n`).join('') === text, 'NONCANONICAL_NATIVE_FILE');
  return { header: h as unknown as SessionHeader, entries, text };
}
/** Dedicated owner control resource only, usable by offline installation without opening any SDK session or active ledger. */
export function acquireOwnerLock(dataDir:string) {
  versionCheck(); privateDirectory(dataDir, true);
  const path = join(dataDir, 'owner-lock.sqlite');
  if (!existsSync(path)) newPrivateFile(path);
  privateBytes(path, MAX_NATIVE_BYTES);
  const lock = openDatabase(path);
  try { lock.pragma('busy_timeout = 0'); lock.exec('BEGIN EXCLUSIVE'); }
  catch { lock.close(); throw new HostError('APP_DIRECTORY_ALREADY_OWNED'); }
  return () => { if (lock.open) { try { lock.exec('ROLLBACK'); } finally { lock.close(); } } };
}
function claimOwner(c:AppConfig) { assertNoRecoveryFile(ledgerPath(c));return acquireOwnerLock(c.data_dir); }
function bindingRow(c: AppConfig, p: Pending) {
  return { scope: canonical(['pi_host_binding', c.bindingHash]), id: p.native_id, digest: digest(p), result: canonical(p) };
}
function checkLedger(c: AppConfig, p: Pending, initialize = false) {
  const path = ledgerPath(c);assertNoRecoveryFile(path);
  if (initialize) { requireHost(!existsSync(path), 'LEDGER_ALREADY_EXISTS'); newPrivateFile(path); }
  noSymlinks(path); const stat = lstatSync(path);
  requireHost(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && (initialize || stat.size >= 4096), 'ORIGINAL_LEDGER_REQUIRED');
  const db = openDatabase(path);
  try {
    const b = bindingRow(c, p);
    if (initialize) {
      new CoreStore(db);
      db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(b.scope, b.id, b.digest, b.result);
    } else requireHost(db.pragma('application_id', { simple: true }) === 0x4e4f5449 && db.pragma('user_version', { simple: true }) === 3, 'ORIGINAL_LEDGER_REQUIRED');
    const saved = db.prepare('SELECT digest,result FROM operations WHERE scope=? AND id=?').get(b.scope, b.id) as { digest: string; result: string } | undefined;
    requireHost(saved?.digest === b.digest && saved.result === b.result, 'LEDGER_BINDING_MISMATCH');
    new CoreStore(db); // Strict current schema check only after the original binding is proven; no legacy migration here.
    return db;
  } catch (error) { db.close(); throw error; }
}

/** init never calls a model. A usable manifest is the final commit, not the pending marker. */
export function initialize(c: AppConfig) {
  assertNoRecoveryFile(ledgerPath(c));assertIdentity(c);
  const release = claimOwner(c);
  try {
    requireHost(!existsSync(manifestPath(c)), 'APP_ALREADY_INITIALIZED');
    let p: Pending;
    if (existsSync(pendingPath(c))) {
      p = pendingOf(c, privateJson(pendingPath(c)));
      const raw = rawNative(c, p);
      requireHost(raw.entries.length === 4, 'INCOMPLETE_INITIALIZATION_REQUIRES_INSPECTION');
      const db = checkLedger(c, p); db.close();
    } else {
      requireHost(!existsSync(join(c.data_dir, 'native')) && !existsSync(ledgerPath(c)), 'EXISTING_RUNTIME_ARTIFACTS');
      for (const name of ['agent', 'work', 'native']) privateDirectory(join(c.data_dir, name), true);
      const manager = SessionManager.create(join(c.data_dir, 'work'), join(c.data_dir, 'native'));
      p = { version: FORMAT, sdk: SDK, binding_hash: c.bindingHash, native_id: manager.getSessionId(), session_file: manager.getSessionFile()!, cwd: manager.getCwd() };
      saveJson(pendingPath(c), p, true);
      const db = checkLedger(c, p, true); db.close(); syncFile(ledgerPath(c));
      manager.appendCustomEntry(ownerType, { version: FORMAT, binding_hash: c.bindingHash });
      manager.appendModelChange(c.model.provider, c.model.id);
      manager.appendThinkingLevelChange(c.model.thinking);
      // The explicitly supplied operator instruction is a real user message, not a phone receipt.
      manager.appendMessage({ role: 'user', content: c.initialPrompt, timestamp: Date.now() });
      chmodSync(p.session_file, 0o600); rawNative(c, p);
    }
    syncFile(p.session_file);
    const raw = rawNative(c, p);
    saveJson(manifestPath(c), { ...p, prefix_hash: digest(raw.entries.slice(0, 4)) }, true);
    return { state: 'initialized', model_requested: false };
  } finally { release(); }
}

/** One exact linear App session, one OS-backed owner lock, one original ledger. */
export class NativeSession {
  readonly manager: SessionManager;
  readonly database: ReturnType<typeof openDatabase>;
  readonly manifest: Manifest;
  private identity: { dev: number; ino: number };
  private release: () => void;
  private closed = false;
  constructor(readonly config: AppConfig) {
    this.release = claimOwner(config);
    try {
      this.manifest = pendingOf(config, privateJson(manifestPath(config))) as Manifest;
      requireHost(typeof this.manifest.prefix_hash === 'string', 'BINDING_MISMATCH');
      for (const name of ['agent', 'work', 'native']) privateDirectory(join(config.data_dir, name));
      const raw = rawNative(config, this.manifest);
      requireHost(digest(raw.entries.slice(0, 4)) === this.manifest.prefix_hash, 'NATIVE_PREFIX_MISMATCH');
      this.identity = { dev: raw.dev, ino: raw.ino };
      this.database = checkLedger(config, this.pending());
      try { this.manager = SessionManager.open(this.manifest.session_file, join(config.data_dir, 'native'), this.manifest.cwd); this.assertParity(); }
      catch (error) { this.database.close(); throw error; }
    } catch (error) { this.release(); throw error; }
  }
  private pending(): Pending {
    const { version, sdk, binding_hash, native_id, session_file, cwd } = this.manifest;
    return { version, sdk, binding_hash, native_id, session_file, cwd };
  }
  assertParity() {
    requireHost(!this.closed, 'NATIVE_OWNER_CLOSED');assertNoRecovery(this.database);
    const raw = rawNative(this.config, this.manifest);
    requireHost(raw.dev === this.identity.dev && raw.ino === this.identity.ino && digest(raw.entries.slice(0, 4)) === this.manifest.prefix_hash
      && this.manager.getSessionId() === this.manifest.native_id && this.manager.getSessionFile() === this.manifest.session_file
      && this.manager.getLeafId() === raw.entries.at(-1)?.id
      && [this.manager.getHeader(), ...this.manager.getEntries()].map(v => `${JSON.stringify(v)}\n`).join('') === raw.text, 'NATIVE_STATE_CHANGED');
  }
  sync() { this.assertParity(); syncFile(this.manifest.session_file); }
  entries() { this.assertParity(); return this.manager.getEntries(); }
  metadata(): Record<string, unknown>[] {
    return this.entries().filter(e => e.type === 'custom' && e.customType === runtimeType).map(e => {
      requireHost(e.type === 'custom' && record(e.data) && e.data.scope === this.config.bindingHash && record(e.data.value) && typeof e.data.value.kind === 'string', 'INVALID_RUNTIME_JOURNAL');
      return e.data.value;
    });
  }
  append(value: Record<string, unknown>) {
    this.assertParity(); requireHost(typeof value.kind === 'string', 'INVALID_RUNTIME_RECORD');
    const id = this.manager.appendCustomEntry(runtimeType, { scope: this.config.bindingHash, value });
    this.sync(); return id;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { if (this.database.open) this.database.close(); } finally { this.release(); }
  }
}

interface InputDetails { version: 1; scope: string; command_id: string; response_hash: string }
export class PiNativeHost implements NativeHost {
  readonly synchronousDurableGate = true as const;
  constructor(readonly native: NativeSession, readonly session: AgentSession, private lookup: (id: string) => Command,
    private checkAuthority: () => unknown) {}
  private checkRuntime() {
    this.native.assertParity();
    const c = this.native.config; const context = this.native.manager.buildSessionContext();
    requireHost(this.session.sessionManager === this.native.manager && this.session.isIdle && this.session.pendingMessageCount === 0
      && !this.session.agent.hasQueuedMessages(), 'NATIVE_SESSION_BUSY');
    requireHost(this.session.model?.provider === c.model.provider && this.session.model.id === c.model.id
      && context.model?.provider === c.model.provider && context.model.modelId === c.model.id && this.session.thinkingLevel === c.model.thinking
      && canonical(this.session.getActiveToolNames()) === canonical(['app_question'])
      && this.session.getCallableToolNames().length === 0, 'NATIVE_CONFIGURATION_CHANGED');
  }
  target() {
    this.checkRuntime();
    const m = this.native.manager;
    const projection = m.buildSessionProjection();
    // Include entry IDs: restoring the same literal model/text must not restore an older revision.
    const contextual = m.getEntries().filter(e => e.type !== 'custom' && e.type !== 'usage' && e.type !== 'session_info');
    return { session_ref: this.native.manifest.native_id, state_revision: `pi_${digest({ entries: contextual, context: projection.messages,
      model: this.session.model, thinking: this.session.thinkingLevel, prompt: this.session.systemPrompt, tools: this.session.getActiveToolNames() })}` };
  }
  private inputs() {
    return this.native.entries().filter(e => e.type === 'custom_message' && e.customType === responseType).map(e => {
      requireHost(e.type === 'custom_message' && typeof e.content === 'string' && record(e.details), 'INVALID_NATIVE_RECEIPT');
      const d = e.details as unknown as InputDetails;
      const input: unknown = JSON.parse(e.content);
      requireHost(d.version === FORMAT && d.scope === this.native.config.bindingHash && record(input) && input.protocol === 'notifier_response_v1'
        && input.command_id === d.command_id && record(input.response) && digest(input.response) === d.response_hash, 'INVALID_NATIVE_RECEIPT');
      const c = this.lookup(d.command_id);
      requireHost(c.id === d.command_id && input.event_id === c.event_id && input.response_id === c.response_id && digest(c.response) === d.response_hash
        && c.response.target.session_ref === this.native.manifest.native_id && c.response.target.source_id === this.native.config.source.source_id
        && c.response.target.source_epoch === this.native.config.source.source_epoch, 'NATIVE_RECEIPT_BINDING_MISMATCH');
      return { entry: e, command: c, details: d };
    });
  }
  getReceipt(id: string): NativeReceipt | null {
    const found = this.inputs().filter(v => v.command.id === id);
    requireHost(found.length <= 1, 'DUPLICATE_NATIVE_COMMAND');
    const v = found[0];
    if (!v) return null;
    // Cache-readable JSONL is not proof that an earlier append's fsync succeeded.
    // Every receipt-producing query (including duplicate submission and recovery)
    // must complete both original-file and parent-directory barriers or throw.
    this.native.sync();
    if (this.session.isIdle && this.session.pendingMessageCount === 0 && !this.session.agent.hasQueuedMessages()) {
      this.session.agent.state.messages = this.native.manager.buildSessionContext().messages;
    }
    return { command_id: id, session_ref: v.command.response.target.session_ref, state_revision: v.command.response.target.state_revision, message_id: v.entry.id };
  }
  compareAndEnqueue(command: Readonly<Command>, now: number): NativeReceipt {
    const existing = this.getReceipt(command.id);
    if (existing) { requireHost(digest(this.lookup(command.id).response) === digest(command.response), 'NATIVE_COMMAND_CONFLICT'); return existing; }
    const persisted = this.lookup(command.id);
    requireHost(persisted.event_id === command.event_id && persisted.response_id === command.response_id && digest(persisted.response) === digest(command.response), 'NATIVE_COMMAND_CONFLICT');
    this.checkAuthority();
    const target = this.target(); const original = command.response.target; const b = this.native.config.source;
    requireHost(original.source_id === b.source_id && original.source_epoch === b.source_epoch && original.session_ref === target.session_ref
      && original.state_revision === target.state_revision && parseExpiry(command.response.expires_at) > now
      && command.response.id === command.response_id && command.response.event_id === command.event_id, 'NATIVE_TARGET_CHANGED');
    requireHost(!this.inputs().some(v => v.command.response_id === command.response_id), 'NATIVE_RESPONSE_ALREADY_ACCEPTED');
    const details: InputDetails = { version: FORMAT, scope: this.native.config.bindingHash, command_id: command.id, response_hash: digest(command.response) };
    const content = JSON.stringify({ protocol: 'notifier_response_v1', command_id: command.id, event_id: command.event_id, response_id: command.response_id, response: command.response });
    this.checkAuthority();
    requireHost(parseExpiry(command.response.expires_at) > Math.max(now, Date.now()), 'NATIVE_INPUT_EXPIRED');
    const message = this.native.manager.appendCustomMessageEntry(responseType, content, true, details);
    this.native.sync();
    // Public setter refreshes the replica only AFTER the authoritative finalized native entry is durable.
    this.session.agent.state.messages = this.native.manager.buildSessionContext().messages;
    return { command_id: command.id, session_ref: original.session_ref, state_revision: original.state_revision, message_id: message };
  }
}

/** Read-only file status; never opens an SDK session, starts a model, or acquires/creates a lock. */
export function status(c: AppConfig) {
  assertNoRecoveryFile(ledgerPath(c));
  versionCheck(); privateDirectory(c.data_dir);
  if (!existsSync(manifestPath(c))) return { state: existsSync(pendingPath(c)) ? 'initialization_incomplete' : 'not_initialized' };
  const p = pendingOf(c, privateJson(manifestPath(c))) as Manifest; const raw = rawNative(c, p);
  requireHost(digest(raw.entries.slice(0, 4)) === p.prefix_hash, 'NATIVE_PREFIX_MISMATCH');
  const journal = raw.entries.filter(e => e.type === 'custom' && e.customType === runtimeType).map(e => e.type === 'custom' && record(e.data) && record(e.data.value) ? e.data.value : {});
  const started = new Set(journal.filter(v => v.kind === 'run_started').map(v => v.run_id));
  const settled = new Set(journal.filter(v => v.kind === 'run_settled').map(v => v.run_id));
  const reported = new Set(journal.filter(v => v.kind === 'report_saved').map(v => v.run_id));
  return { state: 'initialized', sdk: SDK, native_session_fingerprint: digest(p.native_id).slice(0, 16),
    native_entries: raw.entries.length, native_inputs: raw.entries.filter(e => e.type === 'custom_message' && e.customType === responseType).length,
    runs_without_terminal_record: [...started].filter(id => !settled.has(id)).length,
    runs_without_report_ack: [...started].filter(id => !reported.has(id)).length, model_calls_enabled: c.allow_model_calls,
    identity: c.identity ? { name: c.identity.name, fingerprint: c.identity.fingerprint, persona_sha256: c.identity.persona_sha256 } : null,
    model: c.model, model_budget: { ...c.model_budget,
      request_intents: journal.filter(v => v.kind === 'model_request_intent').length,
      http_attempt_intents: journal.filter(v => v.kind === 'model_http_attempt').length,
      http_responses: journal.filter(v => v.kind === 'model_http_response').length } };
}
