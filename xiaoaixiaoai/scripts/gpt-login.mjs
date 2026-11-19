#!/usr/bin/env node
/**
 * Independent OpenAI OAuth bootstrap for 小爱小爱 / 爱弥斯 (POSIX only).
 * Explicit trusted pi-ai 1.4.0 SDK root; no profile discovery, model calls or stdin codes.
 * Example: node scripts/gpt-login.mjs --sdk-root /opt/example/pi-ai --state-dir /var/lib/example/model-auth
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, link, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const MAX_MS = 15 * 60_000;
const MAX_BYTES = 1024 * 1024;
const NAME = "小爱小爱 / 爱弥斯";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
class SafeFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new SafeFailure(code); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const uid = () => typeof process.getuid === "function" ? process.getuid() : fail("UNSUPPORTED_PLATFORM");

async function absent(path) {
  try { await lstat(path); }
  catch (e) { if (e.code === "ENOENT") return; throw e; }
  fail("AUTH_EXISTS");
}

function privateFile(s) {
  return s.isFile() && s.uid === uid() && (s.mode & 0o7777) === 0o600 && s.nlink === 1;
}

async function stateDirectory(path) {
  // Do not create through a symlink in the supplied directory chain.
  if (await realpath(dirname(path)) !== dirname(path)) fail("STATE_UNSAFE");
  try { await mkdir(path, { mode: 0o700 }); }
  catch (e) { if (e.code !== "EEXIST") throw e; }
  const before = await lstat(path);
  if (!before.isDirectory() || before.uid !== uid() || (before.mode & 0o7777) !== 0o700 || await realpath(path) !== path) fail("STATE_UNSAFE");
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!same(before, stat)) fail("STATE_UNSAFE");
    // Linux dir-fd anchoring protects publication if a parent directory is renamed concurrently.
    const anchor = `/proc/self/fd/${handle.fd}`;
    if (await realpath(anchor) !== path) fail("STATE_UNSAFE");
    return {
      path, anchor, handle,
      async check() {
        const now = await lstat(path);
        if (!same(stat, now) || !now.isDirectory() || now.uid !== uid() || (now.mode & 0o7777) !== 0o700 || await realpath(path) !== path) fail("STATE_UNSAFE");
      },
    };
  } catch (e) { await handle.close(); throw e; }
}

async function publishNew(dir, name, text, beforeLink = () => {}) {
  const temp = join(dir.anchor, `.oauth-${randomUUID()}.tmp`);
  let created = false;
  try {
    await dir.check();
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { await file.writeFile(text, "utf8"); await file.sync(); }
    finally { await file.close(); }
    await dir.check();
    // Hard-link publication is atomic and MUST fail on any existing entry, including dangling symlinks.
    beforeLink();
    await link(temp, join(dir.anchor, name));
    await unlink(temp);
    created = false;
    await dir.handle.sync();
    await dir.check();
  } finally {
    if (created) await unlink(temp).catch(() => {});
  }
}

async function deviceId(dir) {
  const path = join(dir.anchor, "device-id");
  let before;
  try { before = await lstat(path); }
  catch (e) {
    if (e.code !== "ENOENT") throw e;
    await publishNew(dir, "device-id", `${randomUUID()}\n`);
    before = await lstat(path);
  }
  if (!privateFile(before) || before.size < 36 || before.size > 37) fail("DEVICE_UNSAFE");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await file.stat();
    if (!same(before, current) || !privateFile(current)) fail("DEVICE_UNSAFE");
    const bytes = Buffer.alloc(38);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (bytesRead !== current.size || after.size !== current.size || !privateFile(after)) fail("DEVICE_UNSAFE");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
    const id = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (!UUID.test(id)) fail("DEVICE_UNSAFE");
    return id;
  } finally { await file.close(); }
}

function authorizationUrl(raw, id) {
  if (typeof raw !== "string" || raw.length > 8192 || /[\p{Cc}\p{Cf}]/u.test(raw)) fail("AUTH_URL_REJECTED");
  const url = new URL(raw);
  if (url.origin !== "https://auth.openai.com" || url.username || url.password || url.pathname !== "/api/accounts/authorize" || url.hash) fail("AUTH_URL_REJECTED");
  const expected = {
    client_id: "dynamic_agent_client", agent_name_hint: NAME, ext_agent_host_id: `urn:uuid:${id}`,
    response_type: "code", redirect_uri: "http://127.0.0.1:1455/auth/callback", resource: "https://api.openai.com/v1",
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", code_challenge_method: "S256",
  };
  const keys = [...url.searchParams.keys()];
  const allowed = [...Object.keys(expected), "state", "nonce", "code_challenge"];
  if (keys.length !== allowed.length || new Set(keys).size !== keys.length || keys.some((k) => !allowed.includes(k))) fail("AUTH_URL_REJECTED");
  for (const [key, value] of Object.entries(expected)) if (url.searchParams.get(key) !== value) fail("AUTH_URL_REJECTED");
  for (const key of ["state", "nonce", "code_challenge"]) if (!/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get(key) ?? "")) fail("AUTH_URL_REJECTED");
  return url.href;
}

function abortWait(signals) {
  const signal = AbortSignal.any(signals.filter(Boolean));
  return new Promise((_, reject) => {
    const stop = () => reject(new SafeFailure("CANCELLED"));
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

/** Own output errors until all callbacks settle; never throw from an SDK notification. */
function safeOutput({ write, stream }, onFailure) {
  let closed = false;
  let pending = Promise.resolve();
  const waiting = new Set();
  const stop = () => {
    if (closed) return;
    closed = true;
    for (const done of waiting) done();
    // Do not abort reentrantly inside the SDK's pre-finally notify callback.
    queueMicrotask(onFailure);
  };
  stream.on("error", stop);
  stream.on("close", stop);
  stream.on("finish", stop);
  if (stream.destroyed || stream.closed || stream.writableEnded) stop();
  return {
    emit(text) {
      if (closed) return;
      pending = pending.then(async () => {
        if (closed) return;
        await new Promise((resolveWrite) => {
          const done = () => { waiting.delete(done); resolveWrite(); };
          waiting.add(done);
          try {
            if (write) Promise.resolve(write(text)).then(done, () => { stop(); done(); });
            else stream.write(text, (error) => { if (error) stop(); done(); });
          } catch { stop(); done(); }
        });
      });
    },
    async flush() {
      let last;
      do {
        last = pending;
        await last;
        // Node may emit a write's error/close on nextTick AFTER invoking its callback.
        await new Promise((resolveTurn) => setImmediate(resolveTurn));
      } while (last !== pending);
    },
    dispose() {
      stream.off("error", stop);
      stream.off("close", stop);
      stream.off("finish", stop);
    },
  };
}

/**
 * Exported for fake-SDK tests. `output` is an owned Writable for this operation;
 * custom `write` callbacks must return a Promise when their completion is asynchronous.
 */
export async function runLogin({ sdkRoot, stateDir }, { write, output = process.stdout, signal, timeoutMs = MAX_MS } = {}) {
  const control = new AbortController();
  let reason;
  const abort = (code) => { reason ??= code; control.abort(new SafeFailure(reason)); };
  const logger = safeOutput({ write, stream: output }, () => abort("OUTPUT_CLOSED"));
  let result = 1;
  const handlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map((name) => [name, () => abort("CANCELLED")]));
  for (const [name, fn] of handlers) process.on(name, fn);
  const outerAbort = () => abort("CANCELLED");
  signal?.addEventListener("abort", outerAbort, { once: true });
  if (signal?.aborted) outerAbort();
  const timer = setTimeout(() => abort("TIMEOUT"), Math.min(MAX_MS, Math.max(1, timeoutMs)));
  let dir;
  let lock;
  let lockStat;
  let providerWork;
  const check = () => { if (control.signal.aborted) fail(reason ?? "CANCELLED"); };
  try {
    if (process.platform !== "linux" || !isAbsolute(sdkRoot ?? "") || !isAbsolute(stateDir ?? "")) fail("INVALID_ARGUMENTS");
    if (process.env.PI_OAUTH_CALLBACK_HOST && process.env.PI_OAUTH_CALLBACK_HOST !== "127.0.0.1") fail("CALLBACK_HOST_REJECTED");
    check();
    dir = await stateDirectory(resolve(stateDir));
    await absent(join(dir.anchor, "auth.json")); // Never open/read an existing credential.
    lock = await open(join(dir.anchor, ".login.lock"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    lockStat = await lock.stat();
    const id = await deviceId(dir);
    await dir.check();
    await absent(join(dir.anchor, "auth.json"));
    check();
    const root = await realpath(sdkRoot);
    const sdk = await import(pathToFileURL(join(root, "dist/index.js")).href);
    if (sdk.PI_AI_VERSION !== "1.4.0") fail("SDK_VERSION_REJECTED");
    const { openaiProvider } = await import(pathToFileURL(join(root, "dist/providers/openai.js")).href);
    const credentials = new sdk.InMemoryCredentialStore();
    const models = sdk.createModels({ credentials, modelsStore: new sdk.InMemoryModelsStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
    const provider = openaiProvider();
    const oauth = provider.auth.oauth;
    // Models.login races abort ahead of the provider's finally. Observe that SAME public operation
    // without changing its parameters/flow so cancellation waits for SDK-owned callback cleanup.
    models.setProvider({ ...provider, auth: { ...provider.auth, oauth: { ...oauth, login(...args) {
      const result = Reflect.apply(oauth.login, oauth, args);
      providerWork = Promise.resolve(result);
      void providerWork.catch(() => {});
      return result;
    } } } });
    let urlShown = false;
    const interaction = {
      signal: control.signal,
      async prompt(prompt) {
        if (prompt.type !== "manual_code") abort("PROMPT_REJECTED");
        // No stdin, pasted callback URL or manual code. Let the SDK callback win this race.
        return abortWait([control.signal, prompt.signal]);
      },
      notify(event) {
        try {
          if (event?.type === "auth_url") {
            if (urlShown) fail("AUTH_URL_REJECTED");
            const safe = authorizationUrl(event.url, id);
            check();
            urlShown = true;
            logger.emit(`AUTH_URL ${safe}\n`);
          } else if (event?.type === "progress" || event?.type === "info") {
            logger.emit("OAUTH_PROGRESS\n"); // Never render SDK messages/links/error bodies.
          } else abort("EVENT_REJECTED");
        } catch { abort(event?.type === "auth_url" ? "AUTH_URL_REJECTED" : "EVENT_REJECTED"); }
      },
    };
    check();
    logger.emit("OAUTH_STARTING\n");
    await logger.flush();
    check();
    const credential = await models.login("openai", "oauth", interaction, { getDeviceId: () => id, agentName: NAME });
    if (providerWork) await providerWork;
    check();
    if (!urlShown || !object(credential) || credential.type !== "oauth" || typeof credential.access !== "string" || !credential.access.trim() || typeof credential.refresh !== "string" || !credential.refresh.trim() || !Number.isFinite(credential.expires)) fail("CREDENTIAL_REJECTED");
    const text = `${JSON.stringify({ openai: credential }, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_BYTES) fail("CREDENTIAL_REJECTED");
    await logger.flush();
    check();
    await publishNew(dir, "auth.json", text, check);
    logger.emit("OAUTH_COMPLETE\n");
    await logger.flush();
    check();
    result = 0;
  } catch (e) {
    const code = reason ?? (e instanceof SafeFailure ? e.code : "FAILED");
    abort(code);
    // Await the provider operation, not a detached abort race, before reporting cancellation.
    if (providerWork) await providerWork.catch(() => {});
    logger.emit(`OAUTH_FAILED ${code}\n`);
    result = code === "CANCELLED" ? 130 : code === "TIMEOUT" ? 124 : 1;
  } finally {
    if (providerWork) await providerWork.catch(() => {});
    if (lock) {
      await lock.close().catch(() => {});
      try {
        if (same(lockStat, await lstat(join(dir.anchor, ".login.lock")))) await unlink(join(dir.anchor, ".login.lock"));
      } catch {}
    }
    await dir?.handle.close().catch(() => {});
    try { await logger.flush(); }
    finally {
      logger.dispose();
      clearTimeout(timer);
      signal?.removeEventListener("abort", outerAbort);
      for (const [name, fn] of handlers) process.off(name, fn);
    }
  }
  // A final asynchronous write/close can fail after auth was durably published. Keep auth intact.
  return result === 0 && reason ? (reason === "CANCELLED" ? 130 : reason === "TIMEOUT" ? 124 : 1) : result;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = { "--sdk-root": "sdkRoot", "--state-dir": "stateDir" }[argv[i]];
    if (!key || out[key] !== undefined || !argv[i + 1] || !isAbsolute(argv[i + 1])) fail("INVALID_ARGUMENTS");
    out[key] = argv[i + 1];
  }
  if (!out.sdkRoot || !out.stateDir) fail("INVALID_ARGUMENTS");
  return out;
}

async function printStatus(text, code) {
  let closed = false;
  const logger = safeOutput({ stream: process.stdout }, () => { closed = true; });
  try { logger.emit(text); await logger.flush(); }
  finally { logger.dispose(); }
  return closed ? 1 : code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    process.exitCode = await printStatus("Usage: gpt-login.mjs --sdk-root /absolute/trusted/pi-ai-1.4.0 --state-dir /absolute/private/model-auth\n", 0);
  } else {
    try { process.exitCode = await runLogin(args(process.argv.slice(2))); }
    catch { process.exitCode = await printStatus("OAUTH_FAILED INVALID_ARGUMENTS\n", 2); }
  }
}
