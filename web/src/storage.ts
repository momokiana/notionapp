import { event, id, object, text, same, type Event } from './contracts.ts';
import { draft, template, sameDraftTarget, type Draft, type Template } from './draft-data.ts';
export type Kind = 'response' | 'read' | 'disposition';
export interface Pending {
  id: string; kind: Kind; namespace: string; root: string; deployment: string; fingerprint: string;
  event: Event; actor: string | null; body: Record<string, unknown>; path: string; method: 'POST' | 'PUT';
  stage: 'prepared' | 'unknown'; created_at: string; draft_restore?: Draft;
}
export interface Outcome { id: string; event_id: string; kind: Kind; state: 'saved' | 'rejected'; at: string; code: string }
export interface LegacyRoot { schema: 1; store_id: string; pending: Pending | null; outcome: Outcome | null }
export interface WorkspaceRoot { schema: 2; store_id: string; pending: Pending | null; outcome: Outcome | null; drafts: Draft[]; templates: Template[] }
export type Root = LegacyRoot | WorkspaceRoot;
export const MAX_STATE_BYTES = 128 * 1024;
// Pure view only; callers persist this inside the original strict transaction when explicitly saving.
export function workspace(r: Root): WorkspaceRoot { return r.schema === 2 ? r : { ...r, schema: 2, drafts: [], templates: [] }; }
export interface Store {
  status(): Promise<'new' | 'ready'>;
  initialize(): Promise<void>;
  read(): Promise<Root>;
  change(fn: (root: Root) => Root): Promise<void>;
}
export type Lock = <T>(fn: () => Promise<T>) => Promise<T>;
export const browserLock: Lock = async fn => {
  if (!navigator.locks) throw new Error('LOCK_UNAVAILABLE');
  return await navigator.locks.request('notifier-web-outbound-v1', { mode: 'exclusive' }, fn);
};
function digest(v: unknown) { const s = text(v, 64); if (!/^[a-f0-9]{64}$/.test(s)) throw new Error('STORAGE_CORRUPT'); return s; }
export function pending(v: unknown, allowDraft = true): Pending {
  const o = object(v), e = event(o.event), b = object(o.body);
  const kind = o.kind as Kind;
  if (!['response', 'read', 'disposition'].includes(kind) || !['prepared', 'unknown'].includes(o.stage as string)) throw new Error('STORAGE_CORRUPT');
  const p: Pending = { id: id(o.id), kind, namespace: digest(o.namespace), root: text(o.root, 2048), deployment: text(o.deployment, 2048), fingerprint: digest(o.fingerprint),
    event: e, actor: o.actor === null ? null : id(o.actor), body: b, path: text(o.path, 240), method: o.method as Pending['method'], stage: o.stage as Pending['stage'], created_at: text(o.created_at, 40) };
  const expectedPath = '/v1/events/' + e.id + (kind === 'response' ? '/responses' : kind === 'read' ? '/read-state' : '/disposition');
  if (p.path !== expectedPath || p.method !== (kind === 'read' ? 'PUT' : 'POST') || !Number.isFinite(Date.parse(p.created_at))) throw new Error('STORAGE_CORRUPT');
  let expected: Record<string, unknown>;
  if (kind === 'response') {
    const a = e.interaction?.actions.find(a => a.id === b.action_id);
    if (!a || (a.type === 'button' && b.text !== '') || (a.type === 'text' && !text(b.text, 4000).trim())) throw new Error('STORAGE_CORRUPT');
    expected = { response_id: p.id, event_version: e.event_version, interaction_id: e.interaction!.id, interaction_version: e.interaction!.version, action_id: a.id, text: text(b.text, 4000) };
  } else if (kind === 'read') expected = { event_version: e.event_version };
  else {
    if (!['open', 'paused', 'completed', 'not_tracking'].includes(b.disposition as string)) throw new Error('STORAGE_CORRUPT');
    expected = { request_id: p.id, expected_event_version: e.event_version, disposition: b.disposition };
  }
  const fields=['id','kind','namespace','root','deployment','fingerprint','event','actor','body','path','method','stage','created_at'];
  if(Object.hasOwn(o,'draft_restore')) {
    if(!allowDraft||kind!=='response')throw new Error('STORAGE_CORRUPT');
    const d=draft(o.draft_restore);
    if(d.namespace!==p.namespace||d.root!==p.root||d.deployment!==p.deployment||d.fingerprint!==p.fingerprint||!sameDraftTarget(d,e)||d.action.id!==b.action_id||d.text!==b.text)throw new Error('STORAGE_CORRUPT');
    p.draft_restore=d;fields.push('draft_restore');
  }
  if (!same(b, expected) || !same(Object.keys(o).sort(), fields.sort())) throw new Error('STORAGE_CORRUPT');
  return p;
}
export function root(v: unknown): Root {
  try {
    if (new TextEncoder().encode(JSON.stringify(v)).length > MAX_STATE_BYTES) throw new Error('STORAGE_CAPACITY_EXCEEDED');
    const o = object(v), fields=['schema','store_id','pending','outcome',...(o.schema===2?['drafts','templates']:[])];
    if (![1,2].includes(o.schema as number) || !same(Object.keys(o).sort(), fields.sort())) throw new Error();
    const store_id = id(o.store_id); let outcome: Outcome | null = null;
    if (o.outcome !== null) {
      const x = object(o.outcome);
      if (!same(Object.keys(x).sort(),['id','event_id','kind','state','at','code'].sort()) || !['saved','rejected'].includes(x.state as string) || !['response','read','disposition'].includes(x.kind as string)) throw new Error();
      outcome = { id: id(x.id), event_id: id(x.event_id), kind: x.kind as Kind, state: x.state as Outcome['state'], at: text(x.at, 40), code: text(x.code, 80) };
    }
    const p=o.pending===null?null:pending(o.pending,o.schema===2);
    if(o.schema===1)return {schema:1,store_id,pending:p,outcome};
    if(!Array.isArray(o.drafts)||o.drafts.length>8||!Array.isArray(o.templates)||o.templates.length>12)throw new Error();
    const drafts=o.drafts.map(draft),templates=o.templates.map(template);
    if(new Set(drafts.map(d=>d.id)).size!==drafts.length||new Set(templates.map(t=>t.id)).size!==templates.length||drafts.some(d=>d.id===p?.draft_restore?.id))throw new Error();
    return {schema:2,store_id,pending:p,outcome,drafts,templates};
  } catch(e) { if(e instanceof Error&&e.message==='STORAGE_CAPACITY_EXCEEDED')throw e;throw new Error('STORAGE_CORRUPT'); }
}
const DB = 'notifier-web-ledger-v1', MARKER = 'notifier-web-store-v1';
function open(create: boolean): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1); let missing = false;
    req.onupgradeneeded = () => {
      if (!create) { missing = true; req.transaction!.abort(); }
      else req.result.createObjectStore('ledger');
    };
    req.onerror = () => missing ? resolve(null) : reject(new Error('STORAGE_OPEN_FAILED'));
    req.onblocked = () => reject(new Error('STORAGE_BLOCKED'));
    req.onsuccess = () => resolve(req.result);
  });
}
async function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, action: (value: unknown, store: IDBObjectStore) => T): Promise<T> {
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('ledger', mode, { durability: 'strict' }), store = tx.objectStore('ledger');
      const get = store.get('root'); let result: T; let failure: unknown;
      get.onsuccess = () => { try { result = action(get.result, store); } catch (e) { failure = e; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(failure ?? new Error('STORAGE_TRANSACTION_FAILED'));
    });
  } finally { db.close(); }
}
export class BrowserStore implements Store {
  async status(): Promise<'new' | 'ready'> {
    const marker = localStorage.getItem(MARKER), db = await open(false);
    if (!db && !marker) return 'new';
    if (!db || !marker) { db?.close(); throw new Error('STORAGE_PAIR_MISSING'); }
    await transaction(db, 'readonly', value => { if (root(value).store_id !== marker) throw new Error('STORAGE_PAIR_MISMATCH'); });
    return 'ready';
  }
  async initialize(): Promise<void> {
    if (await this.status() !== 'new') throw new Error('STORAGE_ALREADY_INITIALIZED');
    const store_id = crypto.randomUUID(), db = await open(true);
    if (!db) throw new Error('STORAGE_OPEN_FAILED');
    await transaction(db, 'readwrite', (value, store) => {
      if (value !== undefined) throw new Error('STORAGE_ALREADY_INITIALIZED');
      store.put({ schema: 1, store_id, pending: null, outcome: null } satisfies Root, 'root');
    });
    // These stores cannot commit atomically. Partial initialization stays read-only.
    localStorage.setItem(MARKER, store_id);
    await this.status();
  }
  async read(): Promise<Root> {
    const marker = localStorage.getItem(MARKER), db = await open(false);
    if (!db || !marker) { db?.close(); throw new Error('STORAGE_PAIR_MISSING'); }
    return transaction(db, 'readonly', value => { const r = root(value); if (r.store_id !== marker) throw new Error('STORAGE_PAIR_MISMATCH'); return r; });
  }
  async change(fn: (r: Root) => Root): Promise<void> {
    const marker = localStorage.getItem(MARKER), db = await open(false);
    if (!db || !marker) { db?.close(); throw new Error('STORAGE_PAIR_MISSING'); }
    await transaction(db, 'readwrite', (value, store) => {
      const r = root(value); if (r.store_id !== marker) throw new Error('STORAGE_PAIR_MISMATCH');
      const next = root(fn(r)); if (next.store_id !== r.store_id) throw new Error('STORAGE_PAIR_MISMATCH');
      if(r.schema===2&&next.schema!==2)throw new Error('STORAGE_DOWNGRADE_REFUSED');
      store.put(next, 'root');
    });
  }
}
