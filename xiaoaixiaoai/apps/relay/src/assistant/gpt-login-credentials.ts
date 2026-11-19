/** App-owned storage seam only. OAuth resolution and rotation belong to pi-ai Models. */
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";

export type CredentialFailure = "missing" | "invalid" | "permissions" | "locked" | "compromised" | "refresh" | "storage" | "cancelled";
export class GptCredentialError extends Error {
  readonly code: CredentialFailure;
  constructor(code: CredentialFailure) {
    super(`gpt-login credentials: ${code}`);
    this.code = code;
  }
}
const MAX_BYTES = 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function oauth(v: unknown): OAuthCredential {
  if (!object(v) || v.type !== "oauth" || typeof v.access !== "string" || !v.access.trim() ||
      typeof v.refresh !== "string" || !v.refresh.trim() || typeof v.expires !== "number" || !Number.isFinite(v.expires))
    throw new GptCredentialError("invalid");
  return v as OAuthCredential;
}
function selected(provider: string): void {
  if (provider !== "openai") throw new GptCredentialError("invalid");
}

/** Same .lock/realpath convention as Pi's file store; no implicit auth path or file creation. */
export class GptLoginCredentials implements CredentialStore {
  readonly path: string;
  failure: CredentialFailure | undefined;
  constructor(path: string) {
    if (!isAbsolute(path)) throw new GptCredentialError("invalid");
    this.path = resolve(path);
  }
  private async regular(): Promise<void> {
    const stat = await lstat(this.path);
    if (!stat.isFile() || await realpath(this.path) !== this.path) throw new GptCredentialError("invalid");
    if (process.platform !== "win32" && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()))
      throw new GptCredentialError("permissions");
    if (stat.size > MAX_BYTES) throw new GptCredentialError("invalid");
  }
  private async readMap(): Promise<Record<string, unknown>> {
    await this.regular();
    const handle = await open(this.path, "r");
    try {
      const data = await handle.readFile();
      if (data.length > MAX_BYTES) throw new GptCredentialError("invalid");
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^\uFEFF/, "")); }
      catch { throw new GptCredentialError("invalid"); }
      if (!object(parsed) || !Object.hasOwn(parsed, "openai")) throw new GptCredentialError("missing");
      oauth(parsed.openai);
      return parsed;
    } finally { await handle.close(); }
  }
  private async save(map: Record<string, unknown>, check: () => void): Promise<void> {
    const temp = join(dirname(this.path), `.pocket-auth-${randomUUID()}.tmp`);
    let created = false;
    try {
      const text = JSON.stringify(map, null, 2);
      if (Buffer.byteLength(text) > MAX_BYTES) throw new GptCredentialError("invalid");
      const handle = await open(temp, "wx", 0o600);
      created = true;
      try { await handle.writeFile(text, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      check();
      await this.regular();
      check();
      await rename(temp, this.path);
      created = false;
      // A successful rename is never rolled back: the refresh token may already be rotated.
      if (process.platform !== "win32") {
        const dir = await open(dirname(this.path), "r");
        try { await dir.sync(); } finally { await dir.close(); }
      }
    } finally { if (created) await unlink(temp).catch(() => {}); }
  }
  private async locked<T>(fn: (check: () => void) => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    let release: (() => Promise<void>) | undefined;
    let compromised = false;
    const check = () => { if (compromised) throw new GptCredentialError("compromised"); };
    try {
      options?.signal?.throwIfAborted();
      await this.regular();
      const deadline = Date.now() + 30_000;
      let retry = 0, eperm = 0;
      for (;;) {
        options?.signal?.throwIfAborted();
        try {
          release = await lockfile.lock(this.path, {
            realpath: false, retries: 0, stale: 30_000, update: 5_000,
            onCompromised: () => { compromised = true; },
          });
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ELOCKED" && !(process.platform === "win32" && code === "EPERM" && ++eperm <= 5)) throw err;
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new GptCredentialError("locked");
          const wait = Math.min(remaining, Math.round(Math.min(10 * 2 ** retry++, 1_000) * (1 + Math.random())));
          await delay(wait, undefined, { signal: options?.signal });
        }
      }
      options?.signal?.throwIfAborted();
      check();
      const result = await fn(check);
      check();
      return result;
    } catch (err) {
      const code = err instanceof GptCredentialError ? err.code : options?.signal?.aborted ? "cancelled" :
        (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "storage";
      this.failure = code;
      throw new GptCredentialError(code);
    } finally {
      if (release) {
        try { await release(); }
        catch { if (!compromised) { this.failure = "storage"; throw new GptCredentialError("storage"); } }
      }
    }
  }
  async read(provider: string, options?: AuthOperationOptions): Promise<Credential> {
    selected(provider);
    return this.locked(async () => structuredClone(oauth((await this.readMap()).openai)), options);
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    await this.read("openai", options);
    return [{ providerId: "openai", type: "oauth" }];
  }
  async modify(provider: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential> {
    selected(provider);
    return this.locked(async (check) => {
      const map = await this.readMap();
      const current = oauth(map.openai);
      let next: Credential | undefined;
      try { next = await fn(structuredClone(current)); }
      catch { throw new GptCredentialError("refresh"); }
      // Models supplies a detached lock-wait signal: once fn begins refreshing, model
      // cancellation MUST NOT be used here to discard its newly rotated credential.
      check();
      if (next === undefined) return structuredClone(current);
      oauth(next);
      await this.save({ ...map, openai: next }, check);
      return structuredClone(next);
    }, options);
  }
  async delete(_provider: string, _options?: AuthOperationOptions): Promise<void> {
    throw new GptCredentialError("invalid");
  }
}
