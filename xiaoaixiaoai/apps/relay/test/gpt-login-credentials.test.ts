import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, chmod, symlink, rm, readdir, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { GptLoginCredentials, GptCredentialError } from "../src/assistant/gpt-login-credentials.ts";

const oauth = () => ({ type: "oauth", access: "FIXTURE_ACCESS_NOT_A_TOKEN", refresh: "FIXTURE_REFRESH_NOT_A_TOKEN",
  expires: Date.now() + 3_600_000, clientId: "fixture-issued-client", scopes: ["chatgpt.tokens.use.direct"], opaque: { keep: true } });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pocket-gpt-store-test-"));
  const file = join(dir, "auth.json");
  const data = { openai: oauth(), other: { type: "api_key", key: "!THIS_FIXTURE_MUST_NEVER_EXECUTE" } };
  await writeFile(file, JSON.stringify(data), { mode: 0o600 });
  return { dir, file, data, store: new GptLoginCredentials(file), close: () => rm(dir, { recursive: true, force: true }) };
}

test("constructor has no IO; selected OAuth read/list preserves opaque fields, never resolves another provider", async () => {
  const f = await fixture();
  try {
    const missing = new GptLoginCredentials(join(f.dir, "absent.json"));
    assert.ok(missing);
    assert.deepEqual(await f.store.read("openai"), f.data.openai);
    assert.deepEqual(await f.store.list(), [{ providerId: "openai", type: "oauth" }]);
    await assert.rejects(f.store.read("other"), GptCredentialError);
    await assert.rejects(f.store.delete("openai"), GptCredentialError);
    await assert.rejects(stat(join(f.dir, "absent.json")), { code: "ENOENT" });
    assert.deepEqual(await readdir(f.dir), ["auth.json"]);
  } finally { await f.close(); }
});

test("locked modify merges only selected latest record, atomically saves 0600 and retains all extension/provider data", async () => {
  const f = await fixture();
  try {
    const before = await stat(f.file);
    const next = await f.store.modify("openai", async (current) => ({ ...current!, access: "FIXTURE_ROTATED", type: "oauth" } as any));
    assert.equal((next as any).clientId, f.data.openai.clientId);
    const saved = JSON.parse(await readFile(f.file, "utf8"));
    assert.deepEqual(saved.other, f.data.other);
    assert.deepEqual(saved.openai.opaque, { keep: true });
    assert.equal(saved.openai.access, "FIXTURE_ROTATED");
    assert.equal((await stat(f.file)).mode & 0o777, 0o600);
    if (process.platform !== "win32") assert.notEqual((await stat(f.file)).ino, before.ino);
    const unchanged = await readFile(f.file, "utf8");
    await f.store.modify("openai", async () => undefined);
    assert.equal(await readFile(f.file, "utf8"), unchanged);
    assert.deepEqual(await readdir(f.dir), ["auth.json"]);
  } finally { await f.close(); }
});

test("a waiting modifier rereads latest map under the same normal Pi lock", async () => {
  const f = await fixture();
  try {
    const release = await lockfile.lock(f.file, { realpath: false, stale: 30_000, update: 5_000, retries: 0 });
    const pending = f.store.modify("openai", async (current) => ({ ...current!, type: "oauth", access: "FIXTURE_NEW" } as any));
    await writeFile(f.file, JSON.stringify({ ...f.data, other: { changedWhileWaiting: true }, openai: { ...f.data.openai, clientId: "new-fixture-client" } }));
    await release();
    await pending;
    const saved = JSON.parse(await readFile(f.file, "utf8"));
    assert.deepEqual(saved.other, { changedWhileWaiting: true });
    assert.equal(saved.openai.clientId, "new-fixture-client");
  } finally { await f.close(); }
});

test("missing, malformed, non-OAuth command, oversized, symlink and permissions errors are static and leave no copies", async () => {
  const f = await fixture();
  try {
    for (const value of ["{PRIVATE_SENTINEL_BAD_JSON", JSON.stringify({ openai: { type: "api_key", key: "!PRIVATE_SENTINEL_COMMAND" } }), JSON.stringify({ other: {} }), "x".repeat(1024 * 1024 + 1)]) {
      await writeFile(f.file, value);
      await assert.rejects(f.store.read("openai"), (e: Error) => {
        assert.ok(e instanceof GptCredentialError);
        assert.doesNotMatch(e.stack ?? "", /PRIVATE_SENTINEL|THIS_FIXTURE|auth\.json/);
        return true;
      });
    }
    await writeFile(f.file, JSON.stringify(f.data));
    if (process.platform !== "win32") {
      await chmod(f.file, 0o644);
      await assert.rejects(f.store.read("openai"), { code: "permissions" });
      await chmod(f.file, 0o600);
      const link = join(f.dir, "link.json");
      await symlink(f.file, link);
      await assert.rejects(new GptLoginCredentials(link).read("openai"), { code: "invalid" });
      await rm(link);
    }
    await rm(f.file);
    await assert.rejects(f.store.read("openai"), { code: "missing" });
    assert.deepEqual(await readdir(f.dir), []);
  } finally { await f.close(); }
});

test("cancelled lock wait and failed refresh release only own lock and redact callback failures", async () => {
  const f = await fixture();
  try {
    const release = await lockfile.lock(f.file, { realpath: false, retries: 0 });
    const ac = new AbortController();
    const pending = f.store.read("openai", { signal: ac.signal });
    ac.abort();
    await assert.rejects(pending, { code: "cancelled" });
    assert.ok((await stat(`${f.file}.lock`)).isDirectory());
    await release();
    await assert.rejects(f.store.modify("openai", async () => { throw Error("PRIVATE_SENTINEL_REFRESH"); }), { message: "gpt-login credentials: refresh" });
    assert.deepEqual(await f.store.read("openai"), f.data.openai);
    assert.deepEqual(await readdir(f.dir), ["auth.json"]);
  } finally { await f.close(); }
});

test("lost ownership refuses persistence and cleans its temporary credential", async (t) => {
  const f = await fixture();
  try {
    t.mock.method(lockfile, "lock", async (_path: string, options: any) => {
      assert.equal(options.realpath, false); assert.equal(options.stale, 30_000); assert.equal(options.update, 5_000);
      queueMicrotask(() => options.onCompromised(Error("PRIVATE_SENTINEL_COMPROMISED")));
      return async () => {};
    });
    await assert.rejects(f.store.modify("openai", async (current) => ({ ...current!, access: "NOT_SAVED" } as any)), { code: "compromised" });
    assert.equal(JSON.parse(await readFile(f.file, "utf8")).openai.access, f.data.openai.access);
    assert.deepEqual(await readdir(f.dir), ["auth.json"]);
  } finally { await f.close(); }
});

test("pre-save destination failure leaves original fixture separate and cleans own tmp/lock", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.store.modify("openai", async (current) => {
      await rename(f.file, join(f.dir, "fixture-original"));
      await mkdir(f.file);
      return { ...current!, access: "NOT_SAVED" } as any;
    }), { code: "invalid" });
    assert.deepEqual((await readdir(f.dir)).sort(), ["auth.json", "fixture-original"]);
    assert.equal(JSON.parse(await readFile(join(f.dir, "fixture-original"), "utf8")).openai.access, f.data.openai.access);
  } finally { await f.close(); }
});

test("two processes using real Models normal refresh and the same file lock refresh only once", async () => {
  const f = await fixture();
  try {
    await writeFile(f.file, JSON.stringify({ ...f.data, openai: { ...f.data.openai, expires: 0 } }));
    const counter = join(f.dir, "fixture-refresh-count");
    const script = join(f.dir, "fixture.mjs");
    const storeUrl = new URL("../src/assistant/gpt-login-credentials.ts", import.meta.url).href;
    await writeFile(script, `
import { createModels } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { GptLoginCredentials } from ${JSON.stringify(storeUrl)};
import { appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const models = createModels({credentials:new GptLoginCredentials(process.argv[2]),authContext:{env:async()=>undefined,fileExists:async()=>false}});
models.setProvider({id:'openai',name:'fixture',getModels:()=>[],auth:{oauth:{name:'fixture',login:async()=>{throw Error('unused')},refresh:async(c)=>{await appendFile(process.argv[3],'refresh\\n');await delay(70);return {...c,access:'FIXTURE_ROTATED',expires:Date.now()+3600000}},toAuth:async(c)=>({apiKey:c.access})}},stream:()=>{throw Error('unused')},streamSimple:()=>{throw Error('unused')}});
await models.getAuth('openai');
console.log('fixture-ok');
`);
    const child = () => new Promise<void>((resolve, reject) => {
      const proc = spawn(process.execPath, [script, f.file, counter], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      proc.stdout.on("data", (v) => { stdout += v; }); proc.stderr.on("data", (v) => { stderr += v; });
      proc.on("error", reject);
      proc.on("exit", (code) => code === 0 && stdout.trim() === "fixture-ok" ? resolve() : reject(Error(`fixture child failed ${code}: ${stderr}`)));
    });
    await Promise.all([child(), child()]);
    assert.equal(await readFile(counter, "utf8"), "refresh\n");
    const saved = JSON.parse(await readFile(f.file, "utf8"));
    assert.equal(saved.openai.access, "FIXTURE_ROTATED");
    assert.deepEqual(saved.other, f.data.other);
  } finally { await f.close(); }
});
