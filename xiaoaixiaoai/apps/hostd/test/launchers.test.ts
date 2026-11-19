import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPrograms } from "../src/create.ts";

test("programs installed under ~/.bun/bin are found even when the shell can't tell", { skip: process.platform === "win32" && "macOS/Linux lookup; Windows is in platform.test.ts" }, async () => {
  // Under launchd the PATH is bare and a login shell skips ~/.zshrc, where bun adds ~/.bun/bin:
  // Claude Code was missing from the phone's "new agent" list because of that.
  const home = mkdtempSync(join(tmpdir(), "hp-home-"));
  mkdirSync(join(home, ".bun", "bin"), { recursive: true });
  const claude = join(home, ".bun", "bin", "claude");
  writeFileSync(claude, "#!/bin/sh\n");
  chmodSync(claude, 0o755);
  writeFileSync(join(home, ".bun", "bin", "codex"), "not executable");
  const saved = { HOME: process.env.HOME, SHELL: process.env.SHELL, PATH: process.env.PATH };
  process.env.HOME = home;
  process.env.SHELL = "/usr/bin/false"; // the shell probe fails outright
  process.env.PATH = "/usr/bin:/bin";
  try {
    const found = await findPrograms(["claude", "codex", "no-such-agent"]);
    assert.equal(found.get("claude"), claude);
    assert.equal(found.has("codex"), false);
    assert.equal(found.has("no-such-agent"), false);
  } finally {
    Object.assign(process.env, saved);
  }
});
