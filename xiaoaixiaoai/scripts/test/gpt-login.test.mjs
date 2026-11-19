import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, lstat, readdir, rm, chmod, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { runLogin } from "../gpt-login.mjs";

const CLI = fileURLToPath(new URL("../gpt-login.mjs", import.meta.url));
const POSIX = process.platform === "linux";
const OPTIONS = { skip: !POSIX };
const CREDENTIAL = { type: "oauth", access: "FAKE_ACCESS", refresh: "FAKE_REFRESH", expires: 2000000000000, clientId: "FAKE_CLIENT", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], opaque: { nested: ["FAKE_OPAQUE", { keep: true }] } };
const NO_SECRETS = /FAKE_ACCESS|FAKE_REFRESH|FAKE_CALLBACK_CODE|FAKE_OPAQUE|FAKE_AMBIENT|paste|粘贴/i;

async function fixture(config = {}) {
  const root = await mkdtemp(join(tmpdir(), "xiaoaixiaoai-oauth-fake-"));
  const sdkRoot = join(root, "fake-sdk");
  const stateDir = join(root, "model-auth");
  await mkdir(join(sdkRoot, "dist/providers"), { recursive: true });
  await writeFile(join(sdkRoot, "package.json"), JSON.stringify({ type: "module", name: "fake-sdk-only" }));
  const setup = { mode: "ok", credential: CREDENTIAL, stateDir, trace: join(root, "trace.json"), ...config };
  await writeFile(join(sdkRoot, "dist/fake.js"), `
import { writeFile, symlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
export const config = ${JSON.stringify(setup)};
export const trace = { loginCalls: 0, registrations: 0, cleanup: false };
export async function save() { await writeFile(config.trace, JSON.stringify(trace)); }
export async function oauthLogin(interaction, options) {
  trace.loginCalls++;
  trace.listenerActive = true;
  trace.uuid = options.getDeviceId();
  if (trace.uuid !== options.getDeviceId()) throw Error('unstable device id');
  trace.agentName = options.agentName;
  await save();
  const url = new URL('https://auth.openai.com/api/accounts/authorize');
  url.search = new URLSearchParams({ client_id: 'dynamic_agent_client', agent_name_hint: options.agentName, ext_agent_host_id: 'urn:uuid:' + trace.uuid, response_type: 'code', redirect_uri: 'http://127.0.0.1:1455/auth/callback', resource: 'https://api.openai.com/v1', scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', state: 's'.repeat(43), nonce: 'n'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' }).toString();
  // Match SDK1.4: notify/prompt happen BEFORE the provider's cleanup try/finally.
  interaction.notify({ type: 'auth_url', url: config.url ?? url.href, instructions: 'paste FAKE_CALLBACK_CODE here' });
  const manualAbort = new AbortController();
  const manual = interaction.prompt({ type: config.mode === 'unsupported-prompt' ? 'secret' : 'manual_code', message: 'paste FAKE_CALLBACK_CODE', signal: AbortSignal.any([manualAbort.signal, interaction.signal]) });
  void manual.catch(() => {});
  let ticker;
  try {
    interaction.notify({ type: 'progress', message: 'FAKE_ACCESS FAKE_REFRESH FAKE_CALLBACK_CODE' });
    // Fixture-only notifications make a closed stdout pipe observably return EPIPE.
    if (config.mode === 'wait-output') ticker = setInterval(() => interaction.notify({ type: 'progress', message: 'FAKE_ACCESS' }), 5);
    if (config.mode === 'wait' || config.mode === 'wait-output' || interaction.signal.aborted) await manual;
    if (config.mode === 'error') throw Error('FAKE_ACCESS FAKE_REFRESH raw upstream body FAKE_CALLBACK_CODE');
    if (config.mode === 'race') await writeFile(config.stateDir + '/auth.json', 'FAKE_EXISTING_DO_NOT_OVERWRITE', { mode: 0o600 });
    if (config.mode === 'race-symlink') await symlink(config.trace, config.stateDir + '/auth.json');
    return config.credential;
  } finally {
    clearInterval(ticker);
    manualAbort.abort();
    // Models.login may have rejected already. The CLI must await this SAME operation's cleanup.
    await delay(10);
    trace.cleanup = true;
    trace.listenerActive = false;
    await save();
  }
}
`);
  await writeFile(join(sdkRoot, "dist/index.js"), `
import { trace, save } from './fake.js';
export const PI_AI_VERSION = ${JSON.stringify(config.version ?? "1.4.0")};
export class InMemoryCredentialStore { async modify(id, fn) { if (id !== 'openai') throw Error('wrong store'); return fn(undefined); } }
export class InMemoryModelsStore {}
export function createModels(config) {
  let provider;
  if (!(config.credentials instanceof InMemoryCredentialStore) || !(config.modelsStore instanceof InMemoryModelsStore)) throw Error('not in-memory');
  return {
    setProvider(p) { if (p.id !== 'openai' || provider) throw Error('wrong registration'); provider = p; trace.registrations++; },
    async login(id, kind, interaction, options) {
      if (id !== 'openai' || kind !== 'oauth') throw Error('wrong login');
      if (await config.authContext.env('OPENAI_API_KEY') !== undefined || await config.authContext.env('FAKE_AMBIENT') !== undefined || await config.authContext.fileExists('/never-read-old-profile') !== false) throw Error('ambient fallback enabled');
      trace.isolated = true;
      const operation = provider.auth.oauth.login(interaction, options);
      const abort = new Promise((_, reject) => {
        const stop = () => reject(Error('SDK abort FAKE_ACCESS'));
        if (interaction.signal.aborted) stop();
        else interaction.signal.addEventListener('abort', stop, { once: true });
      });
      const credential = await Promise.race([operation, abort]);
      await config.credentials.modify(id, async () => credential);
      await save();
      return credential;
    },
    getAuth() { throw Error('FORBIDDEN getAuth FAKE_ACCESS'); },
    getModel() { throw Error('FORBIDDEN model lookup'); },
    refresh() { throw Error('FORBIDDEN network catalog'); },
    stream() { throw Error('FORBIDDEN model call'); }
  };
}
`);
  await writeFile(join(sdkRoot, "dist/providers/openai.js"), `import { oauthLogin } from '../fake.js'; export function openaiProvider() { return { id: 'openai', auth: { oauth: { login: oauthLogin } } }; }`);
  return { root, sdkRoot, stateDir, trace: setup.trace, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function invoke(f, extra = {}) {
  const child = spawn(process.execPath, [CLI, "--sdk-root", f.sdkRoot, "--state-dir", f.stateDir], { env: { ...process.env, PI_OAUTH_CALLBACK_HOST: "127.0.0.1", OPENAI_API_KEY: "FAKE_AMBIENT", ...extra }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const listeners = [];
  child.stdout.on("data", (b) => { stdout += b; for (const resolve of listeners.splice(0)) resolve(); });
  child.stderr.on("data", (b) => { stderr += b; });
  const result = new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => { child.kill("SIGKILL"); reject(Error("fake CLI did not exit")); }, 10_000);
    child.once("error", reject);
    child.once("close", (code, signal) => { clearTimeout(watchdog); resolve({ code, signal, stdout, stderr }); });
  });
  return {
    child, result,
    async authUrl() {
      while (!stdout.includes("AUTH_URL ")) {
        await Promise.race([new Promise((resolve) => listeners.push(resolve)), result.then(() => { throw Error("CLI exited before auth URL"); })]);
      }
    },
  };
}
const modes = async (path) => (await lstat(path)).mode & 0o777;
const cleanOutput = (r) => { assert.doesNotMatch(r.stdout + r.stderr, NO_SECRETS); assert.equal(r.stderr, ""); };

// Every SDK loaded below is freshly generated fixture ESM. The actual installed SDK is never imported.
test("fake SDK login uses only OpenAI OAuth, private files, stable UUID and preserves every opaque field", OPTIONS, async () => {
  const f = await fixture();
  try {
    const r = await invoke(f).result;
    assert.equal(r.code, 0); cleanOutput(r);
    assert.match(r.stdout, /AUTH_URL https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?/);
    assert.match(r.stdout, /OAUTH_COMPLETE\n$/);
    assert.equal(await modes(f.stateDir), 0o700);
    assert.equal(await modes(join(f.stateDir, "auth.json")), 0o600);
    assert.equal(await modes(join(f.stateDir, "device-id")), 0o600);
    assert.deepEqual(JSON.parse(await readFile(join(f.stateDir, "auth.json"), "utf8")), { openai: CREDENTIAL });
    const trace = JSON.parse(await readFile(f.trace, "utf8"));
    assert.deepEqual([trace.loginCalls, trace.registrations, trace.cleanup, trace.isolated], [1, 1, true, true]);
    assert.equal(trace.agentName, "小爱小爱 / 爱弥斯");
    assert.equal(await readFile(join(f.stateDir, "device-id"), "utf8"), trace.uuid + "\n");
    assert.match(trace.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual((await readdir(f.stateDir)).sort(), ["auth.json", "device-id"]);
  } finally { await f.cleanup(); }
});

test("an existing auth entry (regular file, directory or dangling symlink) prevents even starting OAuth", OPTIONS, async () => {
  for (const kind of ["file", "directory", "symlink"]) {
    const f = await fixture();
    try {
      await mkdir(f.stateDir, { mode: 0o700 });
      const auth = join(f.stateDir, "auth.json");
      if (kind === "file") await writeFile(auth, "FAKE_EXISTING", { mode: 0o600 });
      else if (kind === "directory") await mkdir(auth);
      else await symlink(join(f.root, "nonexistent"), auth);
      const before = await lstat(auth);
      const r = await invoke(f).result;
      assert.equal(r.code, 1); cleanOutput(r);
      assert.match(r.stdout, /AUTH_EXISTS/); assert.doesNotMatch(r.stdout, /AUTH_URL/);
      assert.equal((await lstat(auth)).ino, before.ino);
      await assert.rejects(lstat(f.trace), { code: "ENOENT" });
    } finally { await f.cleanup(); }
  }
});

test("unsafe state directories and ancestor symlinks are rejected without chmod or following them", OPTIONS, async () => {
  for (const kind of ["wide", "leaf-symlink", "ancestor-symlink"]) {
    const f = await fixture();
    try {
      if (kind === "wide") { await mkdir(f.stateDir, { mode: 0o755 }); await chmod(f.stateDir, 0o755); }
      else {
        const real = join(f.root, "real"); await mkdir(real, { mode: 0o700 });
        if (kind === "leaf-symlink") await symlink(real, f.stateDir);
        else { const alias = join(f.root, "alias"); await symlink(real, alias); f.stateDir = join(alias, "nested"); }
      }
      const r = await invoke(f).result;
      assert.equal(r.code, 1); cleanOutput(r); assert.doesNotMatch(r.stdout, /AUTH_URL/);
      if (kind === "wide") assert.equal(await modes(f.stateDir), 0o755);
      if (kind === "ancestor-symlink") await assert.rejects(lstat(join(f.root, "real/nested")), { code: "ENOENT" });
      await assert.rejects(lstat(f.trace), { code: "ENOENT" });
    } finally { await f.cleanup(); }
  }
});

test("device identity is validated strictly, never chmodded or replaced", OPTIONS, async () => {
  for (const kind of ["bad-uuid", "oversized", "wide", "symlink", "hardlink"]) {
    const f = await fixture();
    try {
      await mkdir(f.stateDir, { mode: 0o700 });
      const id = join(f.stateDir, "device-id");
      const valid = "12345678-1234-4234-8234-123456789abc\n";
      if (kind === "symlink") await symlink(join(f.root, "nonexistent"), id);
      else {
        await writeFile(id, kind === "bad-uuid" ? "not-a-uuid" : kind === "oversized" ? valid.repeat(100) : valid, { mode: 0o600 });
        if (kind === "wide") await chmod(id, 0o644);
        if (kind === "hardlink") await link(id, join(f.root, "other-link"));
      }
      const before = await lstat(id);
      const r = await invoke(f).result;
      assert.equal(r.code, 1); cleanOutput(r); assert.match(r.stdout, /DEVICE_UNSAFE/);
      const after = await lstat(id);
      assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode);
      await assert.rejects(lstat(f.trace), { code: "ENOENT" });
    } finally { await f.cleanup(); }
  }
});

test("SDK mismatch and non-loopback callback overrides fail before login", OPTIONS, async () => {
  for (const config of [{ version: "1.5.0" }, { callback: "0.0.0.0" }]) {
    const f = await fixture(config);
    try {
      const r = await invoke(f, config.callback ? { PI_OAUTH_CALLBACK_HOST: config.callback } : {}).result;
      assert.equal(r.code, 1); cleanOutput(r); assert.doesNotMatch(r.stdout, /AUTH_URL/);
      await assert.rejects(lstat(f.trace), { code: "ENOENT" });
    } finally { await f.cleanup(); }
  }
});

test("malicious authorization URLs never print, abort asynchronously, and still reach SDK cleanup", OPTIONS, async () => {
  for (const url of ["https://evil.example.com/FAKE_ACCESS", "http://auth.openai.com/api/accounts/authorize", "https://auth.openai.com/oauth/authorize", "https://auth.openai.com/api/accounts/authorize?code=FAKE_CALLBACK_CODE", "https://auth.openai.com.evil.example.com/api/accounts/authorize"]) {
    const f = await fixture({ url });
    try {
      const r = await invoke(f).result;
      assert.equal(r.code, 1); cleanOutput(r); assert.doesNotMatch(r.stdout, /AUTH_URL https:/);
      assert.equal(JSON.parse(await readFile(f.trace, "utf8")).cleanup, true);
      await assert.rejects(lstat(join(f.stateDir, "auth.json")), { code: "ENOENT" });
      assert.deepEqual(await readdir(f.stateDir), ["device-id"]);
    } finally { await f.cleanup(); }
  }
});

test("errors, unsupported prompts and invalid credentials never leak SDK payloads or leave partial auth", OPTIONS, async () => {
  for (const config of [{ mode: "error" }, { mode: "unsupported-prompt" }, { credential: { ...CREDENTIAL, type: "api_key" } }, { credential: { ...CREDENTIAL, expires: null } }, { credential: { ...CREDENTIAL, access: "" } }, { credential: { ...CREDENTIAL, opaque: "FAKE_OPAQUE".repeat(120000) } }]) {
    const f = await fixture(config);
    try {
      const r = await invoke(f).result;
      assert.equal(r.code, 1); cleanOutput(r);
      await assert.rejects(lstat(join(f.stateDir, "auth.json")), { code: "ENOENT" });
      assert.deepEqual(await readdir(f.stateDir), ["device-id"]);
    } finally { await f.cleanup(); }
  }
});

test("atomic publication never clobbers an auth entry that appears during OAuth", OPTIONS, async () => {
  for (const mode of ["race", "race-symlink"]) {
    const f = await fixture({ mode });
    try {
      const r = await invoke(f).result;
      assert.equal(r.code, 1); cleanOutput(r);
      if (mode === "race") assert.equal(await readFile(join(f.stateDir, "auth.json"), "utf8"), "FAKE_EXISTING_DO_NOT_OVERWRITE");
      else assert.equal((await lstat(join(f.stateDir, "auth.json"))).isSymbolicLink(), true);
      assert.deepEqual((await readdir(f.stateDir)).sort(), ["auth.json", "device-id"]);
    } finally { await f.cleanup(); }
  }
});

test("SIGINT/SIGTERM/SIGHUP cancel, ignore piped manual codes, and clean the fake SDK before exit", OPTIONS, async () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const f = await fixture({ mode: "wait" });
    try {
      const run = invoke(f);
      await run.authUrl();
      run.child.stdin.write("FAKE_CALLBACK_CODE\n");
      run.child.kill(signal);
      const r = await run.result;
      assert.equal(r.code, 130); cleanOutput(r); assert.match(r.stdout, /OAUTH_FAILED CANCELLED/);
      assert.equal(JSON.parse(await readFile(f.trace, "utf8")).cleanup, true);
      assert.deepEqual(await readdir(f.stateDir), ["device-id"]);
    } finally { await f.cleanup(); }
  }
});

test("timeout awaits provider cleanup despite the SDK Models abort race, and keeps the stable UUID", OPTIONS, async () => {
  const f = await fixture({ mode: "wait" });
  const id = "12345678-1234-4234-8234-123456789abc";
  try {
    await mkdir(f.stateDir, { mode: 0o700 });
    await writeFile(join(f.stateDir, "device-id"), id + "\n", { mode: 0o600 });
    let stdout = "";
    const code = await runLogin(f, { write: (s) => { stdout += s; }, timeoutMs: 80 });
    assert.equal(code, 124); cleanOutput({ stdout, stderr: "" });
    const trace = JSON.parse(await readFile(f.trace, "utf8"));
    assert.equal(trace.cleanup, true); assert.equal(trace.listenerActive, false); assert.equal(trace.uuid, id);
    assert.equal(await readFile(join(f.stateDir, "device-id"), "utf8"), id + "\n");
    assert.deepEqual(await readdir(f.stateDir), ["device-id"]);
  } finally { await f.cleanup(); }
});

test("a concurrent helper cannot start a second OAuth or remove the first helper's lock", OPTIONS, async () => {
  const f = await fixture({ mode: "wait" });
  let first;
  try {
    first = invoke(f);
    await first.authUrl();
    const second = await invoke(f).result;
    assert.equal(second.code, 1); cleanOutput(second); assert.doesNotMatch(second.stdout, /AUTH_URL/);
    assert.equal((await lstat(join(f.stateDir, ".login.lock"))).isFile(), true);
    first.child.kill("SIGTERM");
    assert.equal((await first.result).code, 130);
    assert.equal(JSON.parse(await readFile(f.trace, "utf8")).loginCalls, 1);
    assert.deepEqual(await readdir(f.stateDir), ["device-id"]);
  } finally {
    if (first && first.child.exitCode === null) { first.child.kill("SIGTERM"); await first.result; }
    await f.cleanup();
  }
});

test("stdout consumer closure aborts through SDK cleanup instead of an unhandled EPIPE", OPTIONS, async (t) => {
  for (const signal of [null, "SIGTERM"]) {
    const f = await fixture({ mode: "wait-output" });
    let run, later;
    try {
      run = invoke(f);
      await run.authUrl();
      run.child.stdout.destroy();
      if (signal) later = setTimeout(() => run.child.kill(signal), 15);
      const r = await run.result;
      const trace = JSON.parse(await readFile(f.trace, "utf8"));
      const entries = await readdir(f.stateDir);
      t.diagnostic(JSON.stringify({ variant: signal ?? "EPIPE", code: r.code, rawStderr: !!r.stderr, cleanup: trace.cleanup, listenerActive: trace.listenerActive, lock: entries.includes(".login.lock"), auth: entries.includes("auth.json") }));
      assert.ok(r.stderr.length === 0, "stdout EPIPE must not escape as raw stderr");
      assert.ok([1, 130].includes(r.code));
      assert.equal(trace.cleanup, true);
      assert.equal(trace.listenerActive, false);
      assert.deepEqual(entries, ["device-id"]);
    } finally {
      clearTimeout(later);
      if (run && run.child.exitCode === null) { run.child.kill("SIGTERM"); await run.result; }
      await f.cleanup();
    }
  }
});

test("closed Writable output aborts before OAuth or during a quiet wait and cleans before return", OPTIONS, async () => {
  for (const phase of ["before-login", "quiet-wait"]) {
    const f = await fixture({ mode: "wait" });
    let text = "";
    const output = new Writable({
      write(chunk, _encoding, done) {
        text += chunk.toString();
        done();
        if (phase === "quiet-wait" && text.includes("AUTH_URL ")) queueMicrotask(() => output.destroy());
      },
    });
    if (phase === "before-login") output.destroy();
    try {
      assert.equal(await runLogin(f, { output }), 1);
      assert.doesNotMatch(text, NO_SECRETS);
      assert.deepEqual(await readdir(f.stateDir), ["device-id"]);
      if (phase === "quiet-wait") {
        const trace = JSON.parse(await readFile(f.trace, "utf8"));
        assert.equal(trace.cleanup, true); assert.equal(trace.listenerActive, false);
      } else await assert.rejects(lstat(f.trace), { code: "ENOENT" });
      assert.equal(output.listenerCount("error"), 0);
      assert.equal(output.listenerCount("close"), 0);
    } finally { output.destroy(); await f.cleanup(); }
  }
});

test("sync and Promise completion-write failures return only after cleanup and preserve committed auth", OPTIONS, async () => {
  for (const failure of ["throw", "reject"]) {
    const f = await fixture();
    const writes = [];
    try {
      const code = await runLogin(f, { write(text) {
        writes.push(text);
        if (text === "OAUTH_COMPLETE\n") {
          const error = Object.assign(Error("FAKE_ACCESS raw output body"), { code: "EPIPE" });
          if (failure === "throw") throw error;
          return Promise.reject(error);
        }
      } });
      assert.equal(code, 1);
      assert.equal(writes.at(-1), "OAUTH_COMPLETE\n"); // No recursive failure logging to a closed sink.
      assert.doesNotMatch(writes.join(""), NO_SECRETS);
      assert.deepEqual(JSON.parse(await readFile(join(f.stateDir, "auth.json"), "utf8")), { openai: CREDENTIAL });
      assert.equal(await modes(join(f.stateDir, "auth.json")), 0o600);
      assert.deepEqual((await readdir(f.stateDir)).sort(), ["auth.json", "device-id"]);
      const trace = JSON.parse(await readFile(f.trace, "utf8"));
      assert.equal(trace.cleanup, true); assert.equal(trace.listenerActive, false);
    } finally { await f.cleanup(); }
  }
});

test("final Writable callback and nextTick error events are flushed without deleting committed auth", OPTIONS, async () => {
  for (const phase of ["callback-error", "after-callback-error"]) {
    const f = await fixture();
    let text = "";
    const output = new Writable({ write(chunk, _encoding, done) {
      const message = chunk.toString(); text += message;
      if (message !== "OAUTH_COMPLETE\n") return done();
      setImmediate(() => {
        const error = Object.assign(Error("FAKE_REFRESH raw EPIPE body"), { code: "EPIPE" });
        if (phase === "callback-error") done(error);
        else { done(); output.destroy(error); }
      });
    } });
    try {
      assert.equal(await runLogin(f, { output }), 1);
      assert.doesNotMatch(text, NO_SECRETS);
      assert.deepEqual(JSON.parse(await readFile(join(f.stateDir, "auth.json"), "utf8")), { openai: CREDENTIAL });
      assert.deepEqual((await readdir(f.stateDir)).sort(), ["auth.json", "device-id"]);
      assert.equal(JSON.parse(await readFile(f.trace, "utf8")).cleanup, true);
      assert.equal(output.listenerCount("error"), 0);
      assert.equal(output.listenerCount("close"), 0);
    } finally { output.destroy(); await f.cleanup(); }
  }
});

test("CLI help and argument errors tolerate a consumer closed before the first write", OPTIONS, async () => {
  for (const argv of [["--help"], []]) {
    const child = spawn(process.execPath, [CLI, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.destroy();
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error("closed-output CLI did not exit")); }, 5000);
      child.once("error", reject);
      child.once("close", (status) => { clearTimeout(timer); resolve(status); });
    });
    assert.equal(code, 1); assert.equal(stderr, "");
  }
});

test("CLI requires explicit absolute arguments and rejects unknown flags without SDK or auth discovery", OPTIONS, async () => {
  for (const argv of [[], ["--sdk-root", "relative", "--state-dir", "/not-used"], ["--sdk-root", "/not-used", "--state-dir", "relative"], ["--sdk-root", "/not-used", "--state-dir", "/not-used", "--force", "yes"]]) {
    const child = spawn(process.execPath, [CLI, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", (b) => { output += b; }); child.stderr.on("data", (b) => { output += b; });
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(code, 2); assert.equal(output, "OAUTH_FAILED INVALID_ARGUMENTS\n");
  }
});
