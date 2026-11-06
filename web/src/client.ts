import { Api, HttpError, Stale, connection, errorMessage, browserFetch, authorizationLost, type Connection, type Fetch } from './api.ts';
import { device, event, history, page, response, object, type Device, type Event, type History, type Response, type Action, type Disposition } from './contracts.ts';
import { BrowserStore, browserLock, type Pending, type Outcome, type Store, type Lock, type Kind } from './storage.ts';
import { Ledger } from './ledger.ts';

export interface View {
  connection: Connection | null; device: Device | null; busy: string; error: string; message: string;
  events: Event[]; next: string | null; windowStart: string; detail: Event | null; fresh: boolean;
  history: History[]; historyNext: string | null; historyStart: string; response: Response | null; runtime: string;
  storage: 'checking' | 'new' | 'ready' | 'blocked'; pending: Pending | null; outcome: Outcome | null;
  authenticated: boolean; observedAt: string | null;
}
const initial = (): View => ({ connection: null, device: null, busy: '', error: '', message: '', events: [], next: null, windowStart: '0', detail: null, fresh: false, history: [], historyNext: null, historyStart: '0', response: null, runtime: '未观察', storage: 'checking', pending: null, outcome: null, authenticated: false, observedAt: null });
export class Client {
  private view = initial(); private listeners = new Set<() => void>(); private generation = 0; private foreground = true;
  readonly ledger: Ledger;
  constructor(readonly origin: string, readonly deployment: string, readonly store: Store = new BrowserStore(), readonly lock: Lock = browserLock, readonly fetcher: Fetch = browserFetch) { this.ledger = new Ledger(store, lock); }
  snapshot = () => this.view;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<View>) { this.view = { ...this.view, ...patch }; this.listeners.forEach(fn => fn()); }
  private check(gen: number) { if (gen !== this.generation || !this.foreground) throw new Stale(); }
  private api(gen: number): Api { if (!this.view.connection) throw new Error('先输入凭据连接服务'); return new Api(this.view.connection, () => this.check(gen), this.fetcher); }
  private async local(gen: number) {
    const status = await this.store.status(); this.check(gen);
    if (status === 'new') { this.set({ storage: 'new', pending: null, outcome: null }); return; }
    const root = await this.store.read(); this.check(gen);
    this.set({ storage: 'ready', pending: root.pending, outcome: root.outcome });
  }
  async start() {
    const gen = this.generation;
    try { await this.local(gen); } catch (e) { if (!(e instanceof Stale)) this.set({ storage: 'blocked', error: errorMessage(e) }); }
  }
  async initialize() {
    await this.work('建立本机提交账本', async gen => { await this.lock(() => this.store.initialize()); this.check(gen); await this.local(gen); this.set({ message: '本机提交账本已建立；凭据仍只留内存' }); });
  }
  async connect(token: string) {
    const gen = ++this.generation;
    this.set({ ...initial(), storage: this.view.storage, pending: this.view.pending, outcome: this.view.outcome, busy: '验证服务连接' });
    try {
      const c = await connection(this.origin, this.deployment, token); this.check(gen); this.set({ connection: c });
      await this.loadEvents(gen, '0');
      const api = this.api(gen); let identity: Device | null = null;
      try { identity = device(await api.request('/v1/device/self')); }
      catch (e) { if (!(e instanceof HttpError && e.status === 404)) throw e; }
      this.check(gen); this.set({ device: identity, authenticated: true, message: identity ? '已核受管设备身份，未启用原生通知' : '已读取事件API；静态凭据无设备actor自查，指纹不等于服务身份' });
      await this.local(gen);
    } catch (e) { if (gen === this.generation) this.set({ authenticated: false, error: errorMessage(e) }); }
    finally { if (gen === this.generation) this.set({ busy: '' }); }
  }
  disconnect() { ++this.generation; const { storage, pending, outcome } = this.view; this.set({ ...initial(), storage, pending, outcome, message: '已移除内存凭据，未删除本机未决记录' }); }
  lifecycle(active: boolean) {
    if (this.foreground === active) return;
    this.foreground = active; ++this.generation;
    this.set({ fresh: false, busy: '', message: active ? '已回到前台，请刷新当前事件后再操作' : '已离开前台，当前确认失效' });
    if (active) void this.start();
  }
  private async work(label: string, fn: (gen: number) => Promise<void>) {
    if (this.view.busy) return;
    const gen = this.generation; this.set({ busy: label, error: '', message: '' });
    try { this.check(gen); await fn(gen); }
    catch (e) {
      if (gen !== this.generation) return;
      const authLost = authorizationLost(e);
      this.set({ error: errorMessage(e), fresh: false, ...(authLost ? { authenticated: false } : {}) });
      try { await this.local(gen); } catch (s) { if (!(s instanceof Stale)) this.set({ storage: 'blocked', error: errorMessage(s) }); }
    } finally { if (gen === this.generation) this.set({ busy: '' }); }
  }
  private async loadEvents(gen: number, after: string, append = false) {
    const got = page(await this.api(gen).request('/v1/events?after=' + after + '&limit=50'), event); this.check(gen);
    if (got.next_after !== null && Number(got.next_after) <= Number(after)) throw new Error('INVALID_SERVER_DATA');
    const events = append ? [...this.view.events, ...got.items] : got.items;
    if (events.length > 100 || new Set(events.map(e => e.id)).size !== events.length) throw new Error('INVALID_SERVER_DATA');
    this.set({ events, next: got.next_after, ...(append ? {} : { windowStart: after }), observedAt: new Date().toISOString() });
  }
  async refresh() {
    await this.work('读取当前服务状态', async gen => {
      this.set({ fresh: false }); await this.loadEvents(gen, '0');
      if (this.view.detail) await this.loadDetail(gen, this.view.detail.id);
      await this.local(gen);
      this.set({ message: '已重新读取当前快照；没有自动标已读或提交回应' });
    });
  }
  async nextEvents() {
    if (!this.view.next) return;
    await this.work('读取后续事件', gen => this.loadEvents(gen, this.view.next!, this.view.events.length < 100));
  }
  private async loadDetail(gen: number, eventId: string) {
    const api = this.api(gen), e = event(await api.request('/v1/events/' + eventId));
    if (e.id !== eventId) throw new Error('INVALID_SERVER_DATA');
    const h = page(await api.request('/v1/events/' + eventId + '/history?after=0&limit=50'), history);
    let r: Response | null = null;
    if (e.reserved_response_id) { r = response(await api.request('/v1/responses/' + e.reserved_response_id)); if (r.event_id !== eventId || r.id !== e.reserved_response_id) throw new Error('INVALID_SERVER_DATA'); }
    let runtime = '未配置观察，状态未知';
    try { const o = object(await api.request('/v1/source-runtime/' + e.source_id + '?event_id=' + e.id + '&event_version=' + e.event_version));
      if (o.event_id !== e.id || o.event_version !== e.event_version || o.source_id !== e.source_id || o.source_epoch !== e.source_epoch || !['running','paused','blocked','unknown'].includes(o.state as string)) throw new Error('INVALID_SERVER_DATA');
      runtime = `${o.state}，观察时间 ${String(o.observed_at)}`;
    } catch (err) { if (!(err instanceof HttpError && err.status === 404)) throw err; }
    this.check(gen); this.set({ detail: e, history: h.items, historyNext: h.next_after, historyStart: '0', response: r, runtime, fresh: true, observedAt: new Date().toISOString(), events: this.view.events.map(x => x.id === e.id ? e : x) });
  }
  async select(eventId: string) {
    await this.work('读取事件与历史', async gen => { this.set({ detail: null, history: [], response: null, fresh: false }); await this.loadDetail(gen, eventId); });
  }
  back() { if (!this.view.busy) this.set({ detail: null, fresh: false, response: null, history: [] }); }
  async nextHistory(first = false) {
    const e = this.view.detail, after = first ? '0' : this.view.historyNext;
    if (!e || after === null) return;
    await this.work('读取事件历史', async gen => {
      const h = page(await this.api(gen).request('/v1/events/' + e.id + '/history?after=' + after + '&limit=50'), history);
      if (h.next_after !== null && Number(h.next_after) <= Number(after)) throw new Error('INVALID_SERVER_DATA');
      const append = !first && this.view.history.length < 200;
      const items = append ? [...this.view.history, ...h.items] : h.items;
      if (new Set(items.map(x => x.seq)).size !== items.length || items.length > 200) throw new Error('INVALID_SERVER_DATA');
      this.check(gen); this.set({ history: items, historyNext: h.next_after, ...(append ? {} : { historyStart: after }) });
    });
  }
  async submit(kind: Kind, selection?: Action | Disposition, text = '') {
    const viewed = this.view.detail;
    if (!viewed || !this.view.fresh || !this.view.authenticated || this.view.storage !== 'ready') { this.set({ error: '当前内容只读，请连接并刷新后再确认' }); return; }
    await this.work('核对版本并保存原请求', async gen => {
      const savedId = await this.ledger.submit(this.api(gen), viewed, kind, selection, text, this.view.device?.device_id ?? null);
      this.check(gen); await this.local(gen);
      this.set({ fresh: false, message: `服务已保存（${savedId}）；正在读取当前结果` });
      try { await this.loadDetail(gen, viewed.id); this.set({ message: `服务已保存，当前结果已刷新（${savedId}）` }); }
      catch (e) { this.check(gen); this.set({ message: `服务已保存（${savedId}），当前结果刷新失败，请只读刷新，不要重新发送`, error: errorMessage(e), fresh: false, ...(authorizationLost(e) ? { authenticated: false } : {}) }); }
    });
  }
  async recover() {
    await this.work('只读核对原请求', async gen => {
      const result = await this.ledger.recover(this.api(gen)); this.check(gen); await this.local(gen);
      this.set({ message: result.message, fresh: false });
      try { await this.loadDetail(gen, result.eventId); } catch (e) { this.check(gen); this.set({ message: result.saved ? '已按原回应ID确认服务保存，当前结果刷新失败，请只读刷新，不要重新发送' : result.message, error: errorMessage(e), fresh: false, ...(authorizationLost(e) ? { authenticated: false } : {}) }); }
    });
  }
}
