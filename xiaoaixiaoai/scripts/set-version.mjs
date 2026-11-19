#!/usr/bin/env node
// Write one version everywhere it has to be spelled out:
//   package.json (root)        what the relay and the host CLI report (the source of truth)
//   packages/*, apps/relay, apps/hostd package.json   kept in step
//   apps/mobile/app.json       expo.version; plugins/withAndroidBuild.js derives the Android
//                              versionCode from it (1.2.3 -> 1002003) at prebuild
// Usage: node scripts/set-version.mjs 1.2.3        (a leading "v" is dropped)
// The release workflow runs it with the tag; run it yourself before tagging to commit the bump.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = (process.argv[2] ?? "").replace(/^v/, "");
const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
if (!m) {
  console.error("usage: node scripts/set-version.mjs <major.minor.patch[-pre]>");
  process.exit(1);
}
const [major, minor, patch] = m.slice(1).map(Number);
if (minor > 999 || patch > 999) {
  console.error("minor and patch must stay below 1000 (they share the Android versionCode)");
  process.exit(1);
}
// Android only installs an update with a versionCode at least as high: 1.2.3 -> 1002003.
const versionCode = major * 1_000_000 + minor * 1_000 + patch;

/** Replace the top-level "version" in place, keeping the file's own formatting. */
function stampPackage(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  const next = text.replace(/^(\s{2}"version":\s*)"[^"]*"/m, `$1"${version}"`);
  if (next === text && !text.includes(`"version": "${version}"`)) {
    // No version field yet: add it after "name".
    writeFileSync(file, text.replace(/^(\s{2}"name":\s*"[^"]*",\n)/m, `$1  "version": "${version}",\n`));
  } else writeFileSync(file, next);
  console.log(`${file.slice(root.length + 1)}  ${version}`);
}

stampPackage(join(root, "package.json"));
for (const dir of ["packages", "apps"]) {
  for (const name of readdirSync(join(root, dir))) {
    if (dir === "apps" && name !== "relay" && name !== "hostd") continue;
    stampPackage(join(root, dir, name, "package.json"));
  }
}

const appJson = join(root, "apps/mobile/app.json");
if (existsSync(appJson)) {
  const app = JSON.parse(readFileSync(appJson, "utf8"));
  app.expo.version = version;
  writeFileSync(appJson, `${JSON.stringify(app, null, 2)}\n`);
  const pinned = app.expo.android?.versionCode;
  console.log(`apps/mobile/app.json  ${version} (versionCode ${pinned ?? versionCode}${pinned ? ", pinned in app.json" : ""})`);
}
