import { ApiError, type Principal, type Registry, type RegistryProvider } from './auth.js';
import { DeviceStore, type InviteInput } from './device-store.js';

function forbidden(): never { throw new ApiError(403, 'FORBIDDEN', 'Explicit current device management permission is required'); }
function conflict(): never { throw new ApiError(503, 'DEVICE_IDENTITY_CONFLICT', 'Device and static identity bindings conflict'); }
function bearer(header: string | undefined): string {
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(header ?? '');
  if (!match?.[1]) throw new ApiError(401, 'UNAUTHENTICATED', 'A valid Bearer token is required');
  return match[1];
}
const same = (a: Principal, b: Principal) => a.id === b.id && a.owner_id === b.owner_id && a.kind === b.kind;
const user = (id: string, owner_id: string): Extract<Principal, { kind: 'user' }> => ({ id, owner_id, kind: 'user' });

/** Optional composition, not a second event authority. Merely constructing it does not enable any HTTP route. */
export class DeviceAuthority {
  readonly registry: RegistryProvider;
  constructor(readonly store: DeviceStore, private readonly legacy: RegistryProvider) {
    this.registry = () => {
      // Fail before using any old grant if the configured original authority or static file is unavailable.
      this.originals();
      const result: Registry = {
        authenticate: header => {
          const legacy = this.originals();
          const token = bearer(header); let original: Principal | undefined;
          try { original = legacy.authenticate(header); }
          catch (error) { if (!(error instanceof ApiError && error.status === 401)) throw error; }
          const found = this.store.tokenRecord(token);
          if (found) {
            this.assertActorBinding(found.device.id, found.device.owner);
            if (original && (original.kind !== 'user' || original.id !== found.device.id || original.owner_id !== found.device.owner)) conflict();
            const current = this.store.authenticate(token); return user(current.id, current.owner_id);
          }
          if (!original) throw new ApiError(401, 'UNAUTHENTICATED', 'A current credential is required');
          const managed = this.store.device(original.id);
          if (managed) {
            if (original.kind !== 'user' || original.owner_id !== managed.owner) conflict();
            // Managed state shadows ALL static secrets for this actor, not only the token used during handover.
            throw new ApiError(401, 'UNAUTHENTICATED', 'The static credential is no longer current');
          }
          return original;
        },
        user: (owner, id) => {
          this.originals();
          const managed = this.store.device(id);
          if (managed) this.assertActorBinding(managed.id, managed.owner);
          if (!managed) return this.legacy().user(owner, id);
          if (managed.owner !== owner) { if (this.legacy().user(owner, id)) conflict(); return undefined; }
          const current = this.store.current(owner, id); return current ? user(current.id, current.owner_id) : undefined;
        },
        source: (owner, id, epoch) => {
          const original = this.originals().source(owner, id, epoch);
          if (original && this.store.hasActor(original.id)) conflict();
          return original;
        },
      };
      return result;
    };
    Object.defineProperties(this.registry, {
      userWrite: { value: this.userWrite.bind(this) },
      withAuthority: { value: this.store.guard.bind(this.store) },
    });
  }
  private originals(): Registry {
    this.store.assertReady();
    const result = this.legacy();
    if (typeof result.actor !== 'function') throw new ApiError(503, 'DEVICE_AUTHORITY_UNAVAILABLE', 'Explicit static identity lookup is required');
    return result;
  }
  private assertActorBinding(id: string, owner: string) {
    const original = this.originals().actor!(id);
    if (original && (original.kind !== 'user' || original.owner_id !== owner)) conflict();
  }
  /** Reauthenticate the exact original request and execute its complete synchronous transaction under one authority lock. */
  userWrite<T>(header: string | undefined, expected: Principal, action: (principal: Extract<Principal, { kind: 'user' }>, registry: Registry) => T): T {
    if (action.constructor.name === 'AsyncFunction') throw new ApiError(503, 'ASYNC_AUTHORITY_GATE_FORBIDDEN', 'User write actions must be synchronous');
    return this.store.guard(() => {
      const registry = this.registry(); const current = registry.authenticate(header);
      if (current.kind !== 'user' || !same(expected, current)) throw new ApiError(401, 'UNAUTHENTICATED', 'Original user authorization is no longer current');
      return action(current, registry);
    });
  }
  assertTokenAvailable = (token: string) => {
    try { this.originals().authenticate(`Bearer ${token}`); }
    catch (error) { if (error instanceof ApiError && error.status === 401) return; throw error; }
    throw new ApiError(409, 'CREDENTIAL_ALREADY_KNOWN', 'Credential collides with an existing static identity');
  };
  invite(header: string | undefined, value: InviteInput) {
    return this.store.guard(() => {
      this.registry().authenticate(header);
      const current = this.store.authenticate(bearer(header));
      if (!current.manage_devices || value.owner_id !== current.owner_id) forbidden();
      return this.store.createInvitation(current.id, value);
    });
  }
}
