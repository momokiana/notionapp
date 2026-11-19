import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { inMainlandChina, releaseFromSums, releaseSources } from "@xiaoaixiaoai/protocol";
import { ASSETS, DEFAULT_REPO, ReleaseUpdatesDisabledError, checkForUpdate, compareVersions, fileMentions, findLayout, latestRelease, linkTarget, readVersion, remoteUpdatesEnabled, repo, rollback, setLink, sourcesFor, sumFor, update, watchForUpdates } from "../src/index.ts";

/** Windows' own tar (bsdtar): Git's GNU tar on PATH reads `C:` in paths as a remote host. */
const TAR = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

const quiet = () => {};

/** A minimal copy: package.json with the version and a host CLI that prints it (or fails). */
function writeCopy(dir: string, version: string, works = true): void {
  mkdirSync(join(dir, "apps/hostd/src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "xiaoaixiaoai", version }));
  writeFileSync(join(dir, "apps/hostd/src/cli.ts"), works ? `console.log(${JSON.stringify(version)});\n` : `process.exit(3);\n`);
}

function makeBundle(dir: string, version: string, works = true): string {
  const stage = mkdtempSync(join(dir, "stage-"));
  writeCopy(join(stage, `xiaoaixiaoai-${version}`), version, works);
  const file = join(dir, `${works ? "" : "broken-"}${ASSETS.bundle(version)}`);
  execFileSync(TAR, ["-czf", file, "-C", stage, `xiaoaixiaoai-${version}`]);
  return file;
}

function makeInstall(dir: string, version: string): string {
  const root = join(dir, "install");
  writeCopy(join(root, "releases", version), version);
  setLink(root, "current", `releases/${version}`);
  return root;
}

describe("versions", () => {
  test("semver order", () => {
    assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
    assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
    assert.equal(compareVersions("1.0.0-rc.2", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0-rc.10", "1.0.0-rc.9"), 1);
    assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
    assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0);
  });

  test("checksum listing", () => {
    const h = "a".repeat(64);
    assert.equal(sumFor(`${"b".repeat(64)}  other.apk\n${h} *dist/xiaoaixiaoai-1.0.0.tar.gz\n`, "xiaoaixiaoai-1.0.0.tar.gz"), h);
    assert.equal(sumFor(`${h}  x\n`, "y"), undefined);
  });

  test("the release a SHA256SUMS listing names", () => {
    const h = "a".repeat(64);
    const r = releaseFromSums(`${h}  xiaoaixiaoai-0.1.3-android-arm64.apk\n${"b".repeat(64)}  xiaoaixiaoai-0.1.3.tar.gz\n`);
    assert.equal(r?.version, "0.1.3");
    assert.equal(r?.sums["xiaoaixiaoai-0.1.3-android-arm64.apk"], h);
    assert.equal(releaseFromSums("<html>rate limited</html>"), null);
    assert.equal(releaseFromSums(`${h}  xiaoaixiaoai-1.0.0-rc.1-android-arm64.apk\n`)?.version, "1.0.0-rc.1");
  });

  test("owned release sources honor XIAOAIXIAOAI_DISABLE_REMOTE_UPDATES and have no third-party mirrors", () => {
    const gh = "https://github.com/momokiana/notionapp/releases/download/v0.2.0/xiaoaixiaoai-0.2.0.tar.gz";
    assert.deepEqual(releaseSources(gh, true), [gh]);
    assert.deepEqual(releaseSources(gh, false), [gh]);
    assert.deepEqual(releaseSources(null, false), []);
    assert.equal(inMainlandChina("Asia/Shanghai"), true);
    assert.equal(inMainlandChina("Asia/Hong_Kong"), false);
    assert.equal(inMainlandChina("UTC"), false);
    const before = { mirror: process.env.XIAOAIXIAOAI_MIRROR, off: process.env.XIAOAIXIAOAI_DISABLE_REMOTE_UPDATES };
    try {
      process.env.XIAOAIXIAOAI_DISABLE_REMOTE_UPDATES = "1";
      assert.equal(remoteUpdatesEnabled(), false);
      process.env.XIAOAIXIAOAI_MIRROR = "1";
      assert.deepEqual(sourcesFor(gh), []);
      process.env.XIAOAIXIAOAI_MIRROR = "0";
      assert.deepEqual(sourcesFor(gh), []);
      assert.deepEqual(sourcesFor("https://example.com/x.tar.gz"), []);
    } finally {
      if (before.mirror === undefined) delete process.env.XIAOAIXIAOAI_MIRROR;
      else process.env.XIAOAIXIAOAI_MIRROR = before.mirror;
      if (before.off === undefined) delete process.env.XIAOAIXIAOAI_DISABLE_REMOTE_UPDATES;
      else process.env.XIAOAIXIAOAI_DISABLE_REMOTE_UPDATES = before.off;
    }
  });

  test("an unmanaged copy explains how it is updated", () => {
    const dir = mkdtempSync(join(tmpdir(), "hp-layout-"));
    mkdirSync(join(dir, ".git"));
    assert.throws(() => findLayout(dir), /git checkout/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("update from a file", () => {
  let dir: string;
  let root: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "hp-update-"));
    root = makeInstall(dir, "0.1.0");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("installs next to the old copy and switches", async () => {
    const r = await update({ service: "host", from: makeBundle(dir, "0.2.0"), restart: false, layout: { root }, log: quiet });
    assert.deepEqual([r.from, r.to, r.changed], ["0.1.0", "0.2.0", true]);
    assert.equal(linkTarget(root, "current"), "releases/0.2.0");
    assert.equal(linkTarget(root, "previous"), "releases/0.1.0");
    assert.equal(readVersion(join(root, "current")), "0.2.0");
  });

  test("a copy that does not start is never switched to", async () => {
    await assert.rejects(update({ service: "host", from: makeBundle(dir, "0.3.0", false), restart: false, layout: { root }, log: quiet }), /did not start/);
    assert.equal(linkTarget(root, "current"), "releases/0.2.0");
    assert.deepEqual(readdirSync(join(root, "releases")).sort(), ["0.1.0", "0.2.0"]);
    assert.ok(!readdirSync(root).some((n) => n.startsWith(".update")));
  });

  test("rollback swaps current and previous", () => {
    const r = rollback({ service: "host", restart: false, layout: { root }, log: quiet });
    assert.deepEqual([r.from, r.to], ["0.2.0", "0.1.0"]);
    assert.equal(readVersion(join(root, "current")), "0.1.0");
    assert.equal(linkTarget(root, "previous"), "releases/0.2.0");
  });

  test("keeps only current and previous", async () => {
    await update({ service: "host", from: makeBundle(dir, "0.4.0"), restart: false, layout: { root }, log: quiet });
    assert.deepEqual(readdirSync(join(root, "releases")).sort(), ["0.1.0", "0.4.0"]);
    // Reinstalling the running version goes to a new folder instead of over the running one.
    await update({ service: "host", from: makeBundle(dir, "0.4.0"), restart: false, layout: { root }, log: quiet });
    assert.match(linkTarget(root, "current") ?? "", /^releases\/0\.4\.0\+/);
    assert.equal(linkTarget(root, "previous"), "releases/0.4.0");
    assert.equal(readdirSync(join(root, "releases")).length, 2);
  });
});

describe("release isolation and env disablement", () => {
  test("untrusted external URLs and XIAOAIXIAOAI_DISABLE_REMOTE_UPDATES fail closed before fetch or install writes", async (t) => {
    const fetched = t.mock.method(globalThis, "fetch", async () => { throw new Error("network must not be used"); });
    const env = { ...process.env };
    const dir = mkdtempSync(join(tmpdir(), "xiaoaixiaoai-disabled-"));
    try {
      assert.equal(DEFAULT_REPO, "momokiana/notionapp");
      assert.equal(repo(), "momokiana/notionapp");
      // Even when remote updates are enabled, arbitrary URLs via --from are rejected before any network/disk work.
      await assert.rejects(update({ service: "host", from: "https://example.com/bundle.tar.gz", layout: { root: dir } }), ReleaseUpdatesDisabledError);
      process.env.HERDR_POCKET_API = "https://api.example.com";
      process.env.HERDR_POCKET_REPO = "Crosery/herdr-pocket";
      process.env.XIAOAIXIAOAI_UPDATE_CHECK = "1";
      process.env.XIAOAIXIAOAI_DISABLE_REMOTE_UPDATES = "1";
      await assert.rejects(latestRelease(), ReleaseUpdatesDisabledError);
      await assert.rejects(checkForUpdate(), { code: "RELEASE_UPDATES_DISABLED" });
      await assert.rejects(update({ service: "host", force: true, layout: { root: dir } }), ReleaseUpdatesDisabledError);
      assert.deepEqual(readdirSync(dir), [], "disabled updates never lock or stage an install");
      assert.equal(fetched.mock.callCount(), 0);
    } finally {
      process.env = env;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("background update watcher schedules no timers or network when disabled", (t) => {
    const env = { ...process.env };
    process.env.XIAOAIXIAOAI_DISABLE_REMOTE_UPDATES = "1";
    const first = t.mock.method(globalThis, "setTimeout", () => { throw new Error("no timeout expected"); });
    const every = t.mock.method(globalThis, "setInterval", () => { throw new Error("no interval expected"); });
    const log = t.mock.fn();
    try {
      const stop = watchForUpdates(log, "xiaoaixiaoai update", { firstMs: 0, everyMs: 1 });
      stop();
      assert.equal(first.mock.callCount(), 0);
      assert.equal(every.mock.callCount(), 0);
      assert.equal(log.mock.callCount(), 0);
    } finally {
      process.env = env;
    }
  });

  test("bundle and APK names belong to this app", () => {
    assert.equal(ASSETS.bundle("v0.5.0"), "xiaoaixiaoai-0.5.0.tar.gz");
    assert.equal(ASSETS.apk("v0.5.0"), "xiaoaixiaoai-0.5.0-android-arm64.apk");
    assert.equal(releaseFromSums(`${"a".repeat(64)}  herdr-pocket-0.5.0-android-arm64.apk\n`), null);
  });
});

describe("service files", () => {
  test("the Windows launcher (UTF-16 JScript, escaped paths) names its install", async () => {
    const { launcherScript } = await import("../../../apps/hostd/src/winservice.ts").catch(() => ({ launcherScript: undefined }));
    const dir = mkdtempSync(join(tmpdir(), "hp-svcfile-"));
    const root = "C:\\Users\\张三\\AppData\\Local\\Programs\\xiaoaixiaoai";
    const js =
      launcherScript?.(`${root}\\node\\node.exe`, `${root}\\current\\apps\\hostd\\src\\cli.ts`, []) ??
      `shell.Run(${JSON.stringify(`"${root}\\node\\node.exe"`)}, 0, false);`;
    const file = join(dir, "hostd-start.js");
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(js, "utf16le")]));
    assert.ok(fileMentions(file, root, true));
    assert.ok(fileMentions(file, root.toLowerCase(), true));
    assert.ok(!fileMentions(file, "C:\\Users\\other", true));
    rmSync(dir, { recursive: true, force: true });
  });
});
