import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError } from './auth.js';
import { DeliveryStore, type Authority, type NativeHost, type NativeReceipt } from './delivery.js';

type Journal = { binding: string; claim_id: string; command_id: string | null; phase: 'claiming' | 'submitting' | 'settled' };
/** One writer/one private journal per adapter. Never repoint it to a different source/epoch. */
export class SourcePump {
  constructor(private delivery: DeliveryStore, private authority: Authority, private host: NativeHost, private path: string) {}
  private load(): Journal | null {
    if (!existsSync(this.path)) return null;
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096 || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error('Private adapter journal is unavailable');
      const value = JSON.parse(readFileSync(fd, 'utf8')) as Journal;
      if (!value || typeof value.binding !== 'string' || typeof value.claim_id !== 'string' || !['claiming', 'submitting', 'settled'].includes(value.phase) || (value.command_id !== null && typeof value.command_id !== 'string')) throw new Error('Invalid adapter journal; do not reset unknown work');
      return value;
    } finally { closeSync(fd); }
  }
  private save(value: Journal) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
    if (process.platform !== 'win32') { const dir = openSync(dirname(this.path), constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); } }
  }
  runOnce() {
    this.delivery.assertReady();
    const previous = this.load();
    const { principal, registry } = this.authority();
    if (principal.kind !== 'source') throw new Error('A pinned source identity is required');
    const binding = JSON.stringify([principal.owner_id, principal.id, principal.source_id, principal.source_epoch]);
    if (previous && previous.binding !== binding) throw new Error('Journal source identity changed; never repoint unknown work');
    let journal: Journal;
    const fresh = previous === null || previous.phase === 'settled';
    if (fresh) { journal = { binding, claim_id: randomUUID(), command_id: null, phase: 'claiming' }; this.save(journal); }
    else journal = previous;
    const claim = this.delivery.claim(principal, journal.claim_id, registry);
    if (!claim.command) { this.save({ ...journal, phase: 'settled' }); return { state: 'idle' }; }
    const c = claim.command;
    if (journal.command_id !== null && journal.command_id !== c.id) throw new Error('Journal command binding changed; input is disabled');
    journal = { ...journal, command_id: c.id };
    if (c.receipt) { this.save({ ...journal, phase: 'settled' }); return { state: 'source_received', command_id: c.id }; }
    const receipt = this.host.getReceipt(c.id);
    if (receipt) {
      this.delivery.receipt(principal, c.id, c.id, receipt);
      this.save({ ...journal, phase: 'settled' }); return { state: 'source_received', command_id: c.id };
    }
    // Existing journal is a crash window, even if the previous process never reached native input.
    if (!fresh) return { state: 'effect_unknown', command_id: c.id };
    this.delivery.validate(principal, c.id, registry);
    this.save({ ...journal, phase: 'submitting' });
    const native = this.delivery.submitAtGate(this.authority, c.id, this.host);
    this.save({ ...journal, phase: 'settled' });
    return { state: 'source_received', command_id: c.id, receipt: native };
  }
}

// Four fixed fields: (80 + 512 + 200 + 512) code points * <=6 JSON UTF-8 bytes
// plus <256 bytes of keys/framing fits <8 KiB; 16 KiB is bounded headroom.
export const MAX_NATIVE_RECEIPT_BYTES = 16 * 1024;
/** Optional read-only loopback bridge. There is intentionally no HTTP submit method. */
export class NativeReceiptQuery {
  private base: URL;
  constructor(base: string, private token: string) {
    this.base = new URL(base);
    if (this.base.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(this.base.hostname) || this.base.username || this.base.password || this.base.search || this.base.hash || this.base.pathname !== '/' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('A private loopback receipt bridge is required');
  }
  async get(commandId: string): Promise<NativeReceipt | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(commandId)) throw new Error('Invalid command ID');
    const response = await fetch(new URL(`commands/${commandId}`, this.base), { headers: { authorization: `Bearer ${this.token}` }, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (response.status === 404) return null;
    if (response.status !== 200) throw new ApiError(503, 'NATIVE_QUERY_FAILED', 'Keep the original unknown command');
    if (!response.body) throw new Error('Missing receipt body');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_NATIVE_RECEIPT_BYTES) throw new Error('Receipt body too large'); chunks.push(value); }
    } finally { await reader.cancel(); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as NativeReceipt;
    if (result.command_id !== commandId || typeof result.session_ref !== 'string' || typeof result.state_revision !== 'string' || typeof result.message_id !== 'string') throw new Error('Receipt correlation mismatch');
    return result;
  }
}
