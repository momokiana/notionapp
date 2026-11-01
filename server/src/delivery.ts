import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ApiError, type Principal, type Registry } from './auth.js';
import { CoreStore } from './core.js';
import {assertNoRecovery} from './recovery-gate.js';
import { createHash } from 'node:crypto';
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}` : JSON.stringify(value);
import type { ResponseData, UpdateEvent } from './contracts.js';

export { commandDdl } from './schema.js';
export interface Command { id: string; response_id: string; event_id: string; response: ResponseData; state: 'effect_unknown' | 'source_received'; receipt: NativeReceipt | null }
export interface NativeReceipt { command_id: string; session_ref: string; state_revision: string; message_id: string }
export interface NativeHost {
  readonly synchronousDurableGate: true;
  /** Must synchronously CAS the exact native target and persist command dedupe + native message before returning. No deferred queue/network. */
  compareAndEnqueue(command: Readonly<Command>, now: number): NativeReceipt;
  getReceipt(commandId: string): NativeReceipt | null;
}
export type Authority = () => { principal: Principal; registry: Registry };
const fail = (status: number, code: string, message: string): never => { throw new ApiError(status, code, message); };
const source = (p: Principal) => {
  if (p.kind !== 'source' || !['deliver', 'read_responses', 'reply'].every(c => p.capabilities.includes(c))) return fail(403, 'FORBIDDEN', 'Explicit source delivery capabilities are required');
  return p;
};
const scoped = (p: Principal, kind: string, id = '') => JSON.stringify(['delivery', p.owner_id, p.kind === 'source' ? p.source_id : '', p.kind === 'source' ? p.source_epoch : '', kind, id]);
export class DeliveryStore {
  private core: CoreStore;
  constructor(private db: Database.Database, private now: () => number = Date.now) { this.core = new CoreStore(db, now); }
  assertReady() { assertNoRecovery(this.db); }
  private once<T>(scope: string, id: string, input: unknown, action: () => T): T {
    this.assertReady();
    return this.db.transaction(() => {
      this.assertReady();
      const digest = createHash('sha256').update(canonical(input)).digest('hex');
      const row = this.db.prepare('SELECT digest,result FROM operations WHERE scope=? AND id=?').get(scope, id) as { digest: string; result: string } | undefined;
      if (row) {
        if (row.digest !== digest) return fail(409, 'IDEMPOTENCY_CONFLICT', 'The operation ID has different content');
        return JSON.parse(row.result) as T;
      }
      const result = action(); this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(scope, id, digest, JSON.stringify(result)); return result;
    }).immediate();
  }
  private eligible(p: Principal, command: Command, registry: Registry) {
    source(p);
    const active = registry.source(p.owner_id, command.response.target.source_id, command.response.target.source_epoch);
    if (!active || active.id !== p.id || !['deliver', 'read_responses', 'reply'].every(c => active.capabilities.includes(c))) fail(403, 'FORBIDDEN', 'Source authorization changed');
    const view = this.core.getResponse(p, command.response_id, registry);
    if (view.eligibility_state !== 'waiting_source') fail(view.eligibility_state === 'expired' ? 410 : 409, view.eligibility_reason, 'The original response is not currently eligible');
    return view;
  }
  claim(p: Principal, claimId: string, registry: Registry): { command: Command | null } {
    const s = source(p);
    return this.once(scoped(p, 'claim'), claimId, {}, () => {
      const rows = this.db.prepare('SELECT r.id,r.event_id,r.data FROM responses r LEFT JOIN commands c ON c.owner=r.owner AND c.response_id=r.id WHERE r.owner=? AND r.source=? AND r.epoch=? AND c.id IS NULL ORDER BY r.seq').all(s.owner_id, s.source_id, s.source_epoch) as { id: string; event_id: string; data: string }[];
      for (const row of rows) {
        const response = JSON.parse(row.data) as ResponseData;
        const view = this.core.getResponse(p, row.id, registry);
        if (view.eligibility_state !== 'waiting_source') continue;
        const command: Command = { id: randomUUID(), response_id: row.id, event_id: row.event_id, response, state: 'effect_unknown', receipt: null };
        this.db.prepare('INSERT INTO commands(id,owner,source,epoch,response_id,event_id,data) VALUES (?,?,?,?,?,?,?)').run(command.id, s.owner_id, s.source_id, s.source_epoch, row.id, row.event_id, JSON.stringify(command));
        this.history(command, 'command_claimed', { command_id: command.id, response_id: row.id, state: 'effect_unknown' });
        return { command };
      }
      return { command: null };
    });
  }
  get(p: Principal, id: string): Command {
    this.assertReady();
    const s = source(p);
    const row = this.db.prepare('SELECT data,receipt FROM commands WHERE id=? AND owner=? AND source=? AND epoch=?').get(id, s.owner_id, s.source_id, s.source_epoch) as { data: string; receipt: string | null } | undefined;
    if (!row) return fail(404, 'NOT_FOUND', 'Command is not visible');
    const receipt = row.receipt ? JSON.parse(row.receipt) as NativeReceipt : null;
    return { ...JSON.parse(row.data) as Command, receipt, state: receipt ? 'source_received' : 'effect_unknown' };
  }
  validate(p: Principal, id: string, registry: Registry) {
    const command = this.get(p, id); this.eligible(p, command, registry);
    return { command_id: id, eligible: true, execution_authorized: false, state: command.state };
  }
  private history(c: Command, kind: string, data: unknown) {
    this.db.prepare('INSERT INTO history(event_id,kind,data,created_at) VALUES (?,?,?,?)').run(c.event_id, kind, JSON.stringify(data), new Date(this.now()).toISOString());
  }
  private checkReceipt(c: Command, r: NativeReceipt) {
    if (r.command_id !== c.id || r.session_ref !== c.response.target.session_ref || r.state_revision !== c.response.target.state_revision || typeof r.message_id !== 'string' || !r.message_id.trim() || [...r.message_id].length > 512) fail(409, 'RECEIPT_TARGET_MISMATCH', 'Native receipt does not match the original command');
  }
  receipt(p: Principal, id: string, receiptId: string, receipt: NativeReceipt) {
    const c = this.get(p, id); this.checkReceipt(c, receipt);
    // Normalize fixed fields: object key order never changes idempotency semantics.
    const r: NativeReceipt = { command_id: receipt.command_id, session_ref: receipt.session_ref, state_revision: receipt.state_revision, message_id: receipt.message_id };
    return this.once(scoped(p, 'receipt', id), receiptId, r, () => {
      const current = this.get(p, id);
      if (current.receipt) {
        if (JSON.stringify(current.receipt) !== JSON.stringify(r)) fail(409, 'RECEIPT_CONFLICT', 'An immutable native receipt already exists');
        return { command_id: id, state: 'source_received' as const, receipt: current.receipt };
      }
      this.db.prepare('UPDATE commands SET receipt=? WHERE id=?').run(JSON.stringify(r), id);
      this.history(c, 'source_received', { command_id: id, response_id: c.response_id, receipt: r, evidence: 'adapter_reported' });
      return { command_id: id, state: 'source_received' as const, receipt: r };
    });
  }
  /** Only an explicitly trusted synchronous in-process native host can enter this final gate. HTTP prechecks are never permits. */
  submitAtGate(authority: Authority, id: string, host: NativeHost) {
    this.assertReady();
    if (host.synchronousDurableGate !== true || host.compareAndEnqueue.constructor.name === 'AsyncFunction' || host.getReceipt.constructor.name === 'AsyncFunction') fail(503, 'NATIVE_GATE_UNAVAILABLE', 'A synchronous durable native gate is required');
    const initial = authority(); const c = this.get(initial.principal, id);
    if (c.receipt) return c.receipt;
    // This reservation commits independently of native input and of the following gate transaction.
    const reserved = this.db.prepare('UPDATE commands SET attempted=1 WHERE id=? AND attempted=0 AND receipt IS NULL').run(id);
    if (reserved.changes !== 1) return fail(409, 'EFFECT_UNKNOWN', 'Only query the original native command; never enqueue again');
    return this.db.transaction(() => {
      this.assertReady();
      const { principal, registry } = authority();
      const command = this.get(principal, id); this.eligible(principal, command, registry);
      const receipt = host.compareAndEnqueue(structuredClone(command), this.now());
      if (receipt && typeof (receipt as unknown as { then?: unknown }).then === 'function') fail(503, 'NATIVE_GATE_UNAVAILABLE', 'Deferred native acceptance is not supported');
      this.checkReceipt(command, receipt);
      this.receipt(principal, id, id, receipt);
      return receipt;
    }).immediate();
  }
  update(p: Principal, id: string, input: UpdateEvent) {
    const command = this.get(p, id);
    if (!command.receipt) fail(409, 'SOURCE_NOT_RECEIVED', 'A correlated native receipt is required');
    return this.once(scoped(p, 'associated_update', command.event_id), input.update_id, { command_id: id, ...input }, () => {
      const result = this.core.update(p, command.event_id, input);
      this.history(command, 'command_update_link', { command_id: id, response_id: command.response_id, update_id: input.update_id, event_version: result.event_version });
      return result;
    });
  }
}
