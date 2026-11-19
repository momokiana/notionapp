import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_DISPLAY_NAME,
  APP_PACKAGE_ID,
  APP_SCHEME,
  RELEASES_PAGE,
  RELEASE_UPDATES_ENABLED,
  apkAssetName,
  compareVersions,
  joinAppLink,
  joinLink,
  pairAppLink,
  pairLink,
  parseJoinLink,
  parsePairInput,
  parsePairLink,
} from "@xiaoaixiaoai/protocol";
import { Relay } from "../src/server.ts";

const ADMIN = "test-admin-token-0123456789abcdef";
const PUBLIC = "https://xiaoaixiaoai.example.com/pocket";
const dirs: string[] = [];
const BOOTSTRAP = fileURLToPath(new URL("../src/bootstrap.ts", import.meta.url));

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "pocket-pairing-"));
  dirs.push(dir);
  return join(dir, "relay.db");
}

async function start(dbPath: string, opts: { adminToken?: string; publicUrl?: string } = {}) {
  const relay = new Relay({ dbPath, log: () => {}, ...opts });
  const port = await relay.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  const api = async (path: string, init: { token?: string; body?: unknown } = {}) => {
    const res = await fetch(base + path, {
      method: init.body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  const page = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, headers: res.headers, html: await res.text() };
  };
  return { relay, base, api, page };
}

function runBootstrap(dbPath: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BOOTSTRAP, ...args], { env: { ...process.env, POCKET_DB: dbPath, POCKET_PUBLIC_URL: PUBLIC } }, (err, stdout) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: stdout });
    });
  });
}

test("first run: a one-time setup code lets the first device in without the admin token", async () => {
  const db = tempDb();
  const { relay, api } = await start(db, { publicUrl: PUBLIC });
  try {
    const info = relay.setupCode()!;
    assert.match(info.code, /^[A-Z]{4}-\d{6}$/);
    assert.equal(info.link, `${PUBLIC}/p/${info.code}`);
    assert.equal(info.hostCommand, `xiaoaixiaoai up ${info.link}`);
    assert.ok(info.expiresAt - Date.now() > 29 * 60_000 && info.expiresAt - Date.now() <= 30 * 60_000);
    assert.deepEqual(parsePairLink(info.link!), { server: PUBLIC, code: info.code });
    // Asking again shows the same code; asking for a fresh one retires the old one.
    assert.equal(relay.setupCode()!.code, info.code);
    const fresh = relay.setupCode(true)!;
    assert.notEqual(fresh.code, info.code);
    assert.equal((await api("/v1/pair", { body: { code: info.code, name: "x", kind: "viewer" } })).status, 401);

    const first = await api("/v1/pair", { body: { code: fresh.code, name: "first phone", kind: "viewer" } });
    assert.equal(first.status, 200);
    assert.match(first.json.token, /^hp_/);
    // Set up now: no more setup codes, and the used one stays used.
    assert.equal(relay.setupCode(), null);
    assert.equal((await api("/v1/pair", { body: { code: fresh.code, name: "second", kind: "host" } })).status, 401);
  } finally {
    await relay.close();
  }
});

test("the setup code goes away when the first device comes in another way", async () => {
  const { relay, api } = await start(tempDb(), { adminToken: ADMIN });
  try {
    const setup = relay.setupCode()!;
    assert.equal(setup.link, undefined, "no public URL configured: no link");
    const code = (await api("/v1/pair/codes", { token: ADMIN, body: { kind: "host" } })).json.code;
    assert.equal((await api("/v1/pair", { body: { code, name: "mac", kind: "host" } })).status, 200);
    assert.equal((await api("/v1/pair", { body: { code: setup.code, name: "late", kind: "viewer" } })).status, 401);
    assert.equal(relay.setupCode(), null);
  } finally {
    await relay.close();
  }
});

test("restart and the bootstrap command show the same code until a device registers", async () => {
  const db = tempDb();
  const a = await start(db, { publicUrl: PUBLIC });
  const code = a.relay.setupCode()!.code;
  await a.relay.close();

  const b = await start(db, { publicUrl: PUBLIC });
  try {
    assert.equal(b.relay.setupCode()!.code, code);
    const cli = await runBootstrap(db, ["--json"]);
    assert.equal(cli.code, 0);
    const out = JSON.parse(cli.out);
    assert.equal(out.code, code);
    assert.equal(out.link, `${PUBLIC}/p/${code}`);
    const human = await runBootstrap(db, []);
    assert.match(human.out, new RegExp(`^setup code=${code} link=\\S+ expires=\\S+Z$`, "m"));

    assert.equal((await b.api("/v1/pair", { body: { code, name: "mac", kind: "host" } })).status, 200);
    const done = await runBootstrap(db, ["--json"]);
    assert.equal(done.code, 3);
    assert.deepEqual(JSON.parse(done.out), { setUp: true, devices: 1 });
  } finally {
    await b.relay.close();
  }
});

test("landing pages open the app, show the code and look nothing up", async () => {
  const { relay, api, page } = await start(tempDb(), { adminToken: ADMIN, publicUrl: PUBLIC });
  try {
    const real = (await api("/v1/pair/codes", { token: ADMIN, body: {} })).json;
    assert.equal(real.link, `${PUBLIC}/p/${real.code}`);

    const r = await page(`/p/${real.code}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type")!, /text\/html/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.match(r.headers.get("content-security-policy")!, /default-src 'none'/);
    assert.ok(r.html.includes(real.code));
    const app = pairAppLink(PUBLIC, real.code).replace(`${APP_SCHEME}://`, "intent://");
    assert.ok(
      r.html.includes(`${app.replace(/&/g, "&#38;")}#Intent;scheme=${APP_SCHEME};package=${APP_PACKAGE_ID};S.browser_fallback_url=${encodeURIComponent(RELEASES_PAGE!)};end`),
      "opens only this app through an intent",
    );
    assert.ok(r.html.includes(APP_DISPLAY_NAME));
    assert.equal(RELEASE_UPDATES_ENABLED, true);
    assert.ok(r.html.includes("https://github.com/momokiana/notionapp/releases/latest"), "links only to owned release page");
    assert.ok(r.html.includes("browser_fallback_url="), "provides owned fallback download URL");
    assert.ok(r.html.includes('class="ghost"'), "shows download link for owned repo");
    assert.ok(!/crosery/i.test(r.html), "never references upstream repo");
    assert.ok(!r.html.includes("herdrpocket"));
    assert.ok(!r.html.includes("Herdr Pocket"));

    // A code that does not exist gets the same page: nothing to learn from it.
    const fake = await page("/p/MEOW-0000");
    const strip = (html: string, code: string) => html.replaceAll(code, "CODE").replace(/nonce="[^"]+"/, "");
    assert.equal(fake.status, 200);
    assert.equal(strip(fake.html, "MEOW-0000"), strip(r.html, real.code));

    // Looking at the page does not use the code up.
    assert.equal((await api("/v1/pair", { body: { code: real.code, name: "phone", kind: "viewer" } })).status, 200);

    // Typed codes are tidied; junk is refused without being echoed.
    assert.ok((await page("/p/meow0042")).html.includes("MEOW-0042"));
    const junk = await page("/p/%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    assert.equal(junk.status, 404);
    assert.ok(!junk.html.includes("alert(1)"));

    const j = await page("/j/abcdEFGH1234_-xy");
    assert.equal(j.status, 200);
    assert.ok(j.html.includes(joinAppLink(PUBLIC, "abcdEFGH1234_-xy").replace(`${APP_SCHEME}://`, "intent://").replace(/&/g, "&#38;")));
    assert.ok(j.html.includes("https://github.com/momokiana/notionapp/releases/latest"));
    assert.ok(!/crosery/i.test(j.html));
    assert.equal((await page("/j/short")).status, 404);
  } finally {
    await relay.close();
  }
});

test("without a public URL the page escapes the Host header it echoes", async () => {
  const { relay, base } = await start(tempDb());
  try {
    const { port } = new URL(base);
    const html = await new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/p/MEOW-1234", headers: { Host: 'evil"><b>x' } }, (res) => {
        let s = "";
        res.on("data", (c) => (s += c));
        res.on("end", () => resolve(s));
      });
      req.on("error", reject);
      req.end();
    });
    assert.ok(html.includes("evil&#34;&#62;&#60;b&#62;x"), "the host shows up escaped");
    assert.ok(!html.includes('evil"><b>'));
  } finally {
    await relay.close();
  }
});

test("links: https pages and the independent app scheme parse, upstream scheme is refused", () => {
  assert.equal(pairLink("https://x.dev/pocket/", "MEOW-0042"), "https://x.dev/pocket/p/MEOW-0042");
  assert.deepEqual(parsePairLink("https://x.dev/pocket/p/MEOW-0042"), { server: "https://x.dev/pocket", code: "MEOW-0042" });
  assert.deepEqual(parsePairLink("http://192.0.2.10:7420/p/MEOW-0042/?from=chat"), { server: "http://192.0.2.10:7420", code: "MEOW-0042" });
  assert.deepEqual(parsePairLink(pairAppLink("https://x.dev", "BAAA-123456")), { server: "https://x.dev", code: "BAAA-123456" });
  assert.deepEqual(parsePairLink("xiaoaixiaoai://pair?server=https%3A%2F%2Fx.dev&code=MEOW-0042"), { server: "https://x.dev", code: "MEOW-0042" });
  assert.equal(parsePairLink("herdrpocket://pair?server=https%3A%2F%2Fx.dev&code=MEOW-0042"), null);
  assert.equal(parsePairInput("herdrpocket://pair?server=https%3A%2F%2Fx.dev&code=MEOW-0042"), null);
  assert.equal(parsePairLink("https://x.dev/p/not-a-code"), null);
  assert.equal(parsePairLink("https://x.dev/j/abcdEFGH1234"), null);
  assert.deepEqual(parsePairInput("https://x.dev/p/meow-0042"), { server: "https://x.dev", code: "MEOW-0042" });
  const message = "用小爱小爱打开这个链接就能连上（10 分钟内有效）：\nhttps://x.dev/pocket/p/MEOW-0042\n打不开时输入配对码 MEOW-0042";
  assert.deepEqual(parsePairInput(message), { server: "https://x.dev/pocket", code: "MEOW-0042" });
  assert.equal(parsePairInput("见 https://x.dev/about 页面"), null);

  assert.equal(joinLink("https://x.dev", "abcdEFGH1234"), "https://x.dev/j/abcdEFGH1234");
  assert.deepEqual(parseJoinLink("https://x.dev/j/abcdEFGH1234"), { server: "https://x.dev", id: "abcdEFGH1234" });
  assert.deepEqual(parseJoinLink(joinAppLink("https://x.dev", "abcdEFGH1234")), { server: "https://x.dev", id: "abcdEFGH1234" });
  assert.equal(parseJoinLink("herdrpocket://join?server=https%3A%2F%2Fx.dev&id=abcdEFGH1234"), null);
  assert.equal(parseJoinLink("https://x.dev/p/MEOW-0042"), null);
  assert.equal(parseJoinLink("https://x.dev/j/a"), null);
});

test("release helpers: asset name and version order", () => {
  assert.equal(apkAssetName("v0.2.0"), "xiaoaixiaoai-0.2.0-android-arm64.apk");
  assert.ok(compareVersions("0.2.0", "0.1.9") > 0);
  assert.ok(compareVersions("v0.10.0", "0.9.3") > 0);
  assert.equal(compareVersions("v1.0", "1.0.0"), 0);
  assert.ok(compareVersions("1.0.0-beta.1", "1.0.0") < 0);
  assert.ok(compareVersions("1.0.0-rc.10", "1.0.0-rc.9") > 0);
  assert.ok(compareVersions("0.1.0", "0.1.1") < 0);
});
