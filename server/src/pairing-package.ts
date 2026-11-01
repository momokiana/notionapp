import { ApiError, validId } from './auth.js';

export const PAIRING_PACKAGE_LIMIT = 8192;
export interface PairingPackage {
  notifier_pairing: 1; base: string; store_id: string; invitation_id: string; secret: string; expires_at: number; owner_id: string; label: string; manage_devices: boolean;
}
function invalid(): never { throw new ApiError(422, 'INVALID_PAIRING_PACKAGE', 'Invalid or unsupported bounded pairing package'); }
export function pairingBase(value: string, allowLoopbackHttp = false): string {
  let url: URL; try { url = new URL(value); } catch { return invalid(); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1','[::1]','localhost'].includes(url.hostname)))) invalid();
  return url.origin;
}
export function parsePairingPackage(value: string, allowLoopbackHttp = false): PairingPackage {
  if (Buffer.byteLength(value) > PAIRING_PACKAGE_LIMIT) invalid();
  let decoded: unknown; try { decoded = JSON.parse(value); } catch { return invalid(); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) invalid();
  const row = decoded as Record<string, unknown>;
  const keys = ['notifier_pairing','base','store_id','invitation_id','secret','expires_at','owner_id','label','manage_devices'];
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(k => !keys.includes(k)) || row.notifier_pairing !== 1 || typeof row.base !== 'string' || typeof row.store_id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.store_id) || !validId(row.invitation_id) || typeof row.secret !== 'string' || !/^[a-f0-9]{64}$/.test(row.secret) || !Number.isSafeInteger(row.expires_at) || (row.expires_at as number) < 0 || !validId(row.owner_id) || typeof row.label !== 'string' || !row.label.trim() || [...row.label].length > 80 || /[\u0000-\u001f\u007f]/u.test(row.label) || typeof row.manage_devices !== 'boolean') invalid();
  const base = pairingBase(row.base, allowLoopbackHttp);
  if (row.base !== base) invalid(); // No ambiguous path/default-port/case normalization during later adoption.
  return { notifier_pairing: 1, base, store_id: row.store_id, invitation_id: row.invitation_id, secret: row.secret, expires_at: row.expires_at as number, owner_id: row.owner_id, label: row.label, manage_devices: row.manage_devices };
}
