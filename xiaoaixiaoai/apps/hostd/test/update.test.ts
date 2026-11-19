import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE_UPDATES_DISABLED_REASON } from "@xiaoaixiaoai/protocol";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("host CLI update/check consumers respect XIAOAIXIAOAI_DISABLE_REMOTE_UPDATES and reject foreign URLs", () => {
  const dir = mkdtempSync(join(tmpdir(), "xiaoaixiaoai-host-update-"));
  const guard = join(dir, "network-guard.mjs");
  writeFileSync(guard, 'globalThis.fetch = async () => { throw new Error("UNEXPECTED_NETWORK_ACCESS"); };\n');
  const baseEnv = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    XIAOAIXIAOAI_HOME: join(dir, "config"),
    XIAOAIXIAOAI_STATE: join(dir, "state"),
    HERDR_POCKET_API: "https://api.example.com",
    HERDR_POCKET_REPO: "Crosery/herdr-pocket",
    XIAOAIXIAOAI_UPDATE_CHECK: "1",
  };
  const disabledEnv = { ...baseEnv, XIAOAIXIAOAI_DISABLE_REMOTE_UPDATES: "1" };
  try {
    for (const args of [["version", "--check"], ["update", "--check"], ["update"], ["update", "--force"], ["update", "--from", "https://example.com/bundle.tar.gz"]]) {
      const r = spawnSync(process.execPath, ["--import", pathToFileURL(guard).href, CLI, ...args], { env: disabledEnv, encoding: "utf8", timeout: 20_000 });
      assert.ifError(r.error);
      assert.equal(r.status, 1, args.join(" "));
      assert.ok(r.stderr.includes(RELEASE_UPDATES_DISABLED_REASON), `${args.join(" ")}: ${r.stderr}`);
      assert.ok(!r.stderr.includes("UNEXPECTED_NETWORK_ACCESS"));
    }
    const foreign = spawnSync(process.execPath, ["--import", pathToFileURL(guard).href, CLI, "update", "--from", "https://example.com/bundle.tar.gz"], { env: baseEnv, encoding: "utf8", timeout: 20_000 });
    assert.equal(foreign.status, 1);
    assert.ok(foreign.stderr.includes(RELEASE_UPDATES_DISABLED_REASON));
    const help = spawnSync(process.execPath, [CLI, "--help"], { env: disabledEnv, encoding: "utf8", timeout: 20_000 });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Remote updates\/downloads are disabled/);
    assert.deepEqual(readdirSync(dir), ["network-guard.mjs"], "no host config, sessions or update staging was created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
