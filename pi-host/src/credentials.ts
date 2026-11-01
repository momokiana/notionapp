import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { HostError, privateJson, record, requireHost } from './private-files.js';

/** Literal, explicitly supplied private profiles only; no shell commands or ambient substitutions. */
export function literalProfile(v: unknown) {
  if (typeof v === 'string') requireHost(!v.trimStart().startsWith('!') && !/\$(?:\{|[A-Za-z_])/u.test(v), 'EXECUTABLE_OR_AMBIENT_PROFILE_FORBIDDEN');
  else if (Array.isArray(v)) v.forEach(literalProfile);
  else if (record(v)) Object.values(v).forEach(literalProfile);
}
/** Synchronous, literal read for final input gates; never resolves or refreshes OAuth. */
export function readAppCredential(path: string, provider: string): Credential {
  const data = privateJson(path);
  requireHost(record(data) && Object.hasOwn(data, provider), 'EXPLICIT_APP_MODEL_CREDENTIAL_REQUIRED');
  const value = data[provider]; literalProfile(value); // Do not discover or interpret other providers' profiles.
  requireHost(record(value) && value.env === undefined, 'UNSUPPORTED_APP_CREDENTIAL');
  if (value.type === 'api_key') requireHost(typeof value.key === 'string' && value.key.trim().length > 0, 'LITERAL_APP_KEY_REQUIRED');
  else requireHost(value.type === 'oauth' && typeof value.access === 'string' && !!value.access && typeof value.refresh === 'string'
    && typeof value.expires === 'number' && Number.isFinite(value.expires), 'UNSUPPORTED_APP_CREDENTIAL');
  return value as unknown as Credential;
}
/**
 * Do NOT return undefined for an unavailable configured credential: pi-ai would then
 * intentionally try ambient env/files. Absence/change of this required App file is a
 * configuration/storage failure, never permission to inherit another agent's auth.
 * Read-only: OAuth refresh/login/logout must be done separately for this App profile.
 */
export class AppCredentials implements CredentialStore {
  constructor(private path: string, private provider: string) {}
  async read(provider: string, options?: AuthOperationOptions): Promise<Credential> {
    options?.signal?.throwIfAborted();
    requireHost(provider === this.provider, 'UNCONFIGURED_APP_PROVIDER');
    return readAppCredential(this.path, provider);
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const value = await this.read(this.provider, options); return [{ providerId: this.provider, type: value.type }];
  }
  async modify(): Promise<never> { throw new HostError('APP_CREDENTIAL_REFRESH_REQUIRES_OPERATOR'); }
  async delete(): Promise<never> { throw new HostError('APP_CREDENTIAL_MUTATION_FORBIDDEN'); }
}
