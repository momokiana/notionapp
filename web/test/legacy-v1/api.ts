export interface Connection { root: string; deployment: string; token: string; fingerprint: string; namespace: string }
export async function hash(s: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function apiRoot(origin: string): string {
  const u = new URL(origin);
  if (u.origin !== origin || u.username || u.password || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))) throw new Error('需要 HTTPS 或本机回环 origin');
  return u.origin + '/api';
}
export async function connection(origin: string, deployment: string, token: string): Promise<Connection> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('凭据应为64位小写十六进制，请完整粘贴');
  const root = apiRoot(origin), fingerprint = await hash(token);
  return Object.freeze({ root, deployment, token, fingerprint, namespace: await hash(JSON.stringify([root, deployment, fingerprint])) });
}
export class HttpError extends Error { constructor(public status: number, public code: string) { super(`${status} ${code}`); } }
// Covers 50 legal event/history snapshots at their UTF-8/JSON field bounds.
// The page parser still enforces 50 items and each individual field's limit.
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
export class UnverifiedHttpError extends Error { constructor(readonly status: number) { super('INVALID_SERVER_DATA'); } }
export function authorizationLost(e: unknown): boolean { return (e instanceof HttpError || e instanceof UnverifiedHttpError) && [401, 403].includes(e.status); }
export class Stale extends Error { constructor() { super('当前页面或连接已改变，请刷新后重新确认'); } }
export type Fetch = typeof fetch;
export const browserFetch: Fetch = (input, init) => globalThis.fetch(input, init);
export class Api {
  constructor(readonly c: Connection, readonly assertCurrent: () => void, readonly fetcher: Fetch = browserFetch) {}
  async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    this.assertCurrent();
    if (!/^\/v1\/[A-Za-z0-9_/?=&-]+$/.test(path)) throw new Error('INVALID_API_PATH');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
    let receivedStatus: number | undefined;
    try {
      const r = await this.fetcher(this.c.root + path, {
        method, headers: { Authorization: 'Bearer ' + this.c.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
      });
      receivedStatus = r.status;
      this.assertCurrent();
      if (r.redirected || !r.headers.get('content-type')?.includes('application/json')) throw new Error('INVALID_SERVER_DATA');
      const reader = r.body?.getReader();
      if (!reader) throw new Error('INVALID_SERVER_DATA');
      let size = 0; const chunks: Uint8Array[] = [];
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('SERVER_DATA_TOO_LARGE'); } chunks.push(part.value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      this.assertCurrent();
      const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (r.status !== 200) {
        if (!data || typeof data !== 'object' || Array.isArray(data) || !exactKeys(data as Record<string, unknown>, ['error'])) throw new Error('INVALID_SERVER_DATA');
        const error = (data as { error: unknown }).error;
        if (!error || typeof error !== 'object' || Array.isArray(error) || !exactKeys(error as Record<string, unknown>, ['code', 'message'])) throw new Error('INVALID_SERVER_DATA');
        const { code, message } = error as Record<string, unknown>;
        if (typeof code !== 'string' || !/^[A-Z_]{1,80}$/.test(code) || typeof message !== 'string' || [...message].length > 2048) throw new Error('INVALID_SERVER_DATA');
        throw new HttpError(r.status, code);
      }
      return data;
    } catch (e) {
      // A malformed rejection is never a known business refusal, but a received
      // 401/403 must still remove write qualification rather than keeping auth green.
      if (receivedStatus !== undefined && receivedStatus !== 200 && !(e instanceof HttpError) && !(e instanceof Stale)) throw new UnverifiedHttpError(receivedStatus);
      throw e;
    } finally { clearTimeout(timer); }
  }
}
export function errorMessage(e: unknown): string {
  if (e instanceof Stale) return e.message;
  if (e instanceof HttpError) {
    const hints: Record<string, string> = { UNAUTHENTICATED: '认证已失效，未决记录（若有）仍保留，请重新输入原凭据核对', EVENT_VERSION_CONFLICT: '事件版本已变化，请重新查看并确认', INTERACTION_VERSION_CONFLICT: '问题已变化，请重新查看', ACTION_ALREADY_RESERVED: '这个问题已经保存了回应', ACTION_EXPIRED: '操作已过期', EVENT_CLOSED: '事项当前不允许回应', SOURCE_READ_ONLY: '来源当前不接受回应' };
    return (hints[e.code] ?? '服务拒绝或暂时不可用') + `（${e.status} ${e.code}）`;
  }
  if (e instanceof Error && ['INVALID_SERVER_DATA', 'SERVER_DATA_TOO_LARGE', 'UNSUPPORTED_EXECUTION_CLAIM'].includes(e.message)) return '服务数据不符合本客户端合同，未推断成功';
  if (e instanceof Error && (e.message.startsWith('STORAGE_') || e.message.startsWith('LOCK_'))) return '本机提交账本不可写，未清除原记录：' + e.message;
  if (e instanceof Error && e.message.length < 140 && !e.message.includes('fetch')) return e.message;
  return '连接中断或响应不可核实；已提交的操作可能已保存，请查原请求';
}
