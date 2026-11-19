import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const source = (name) => readFileSync(join(ROOT, name), "utf8");
const scripts = ["scripts/install-host.sh", "scripts/install-relay.sh"];
const disabled = /Owned release source is not configured; explicit local bundle required/;
const text = (path) => existsSync(path) ? readFileSync(path, "utf8") : "";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "xiaoaixiaoai-install-policy-"));
  const bin = join(dir, "fake-bin");
  mkdirSync(bin); mkdirSync(join(dir, "temp"));
  const trace = join(dir, "commands.log");
  for (const name of ["curl", "wget", "docker", "node", "npm", "pnpm", "corepack", "systemctl", "launchctl", "sudo", "useradd", "adduser", "openssl", "mkdir", "tar", "cp", "ln"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$POLICY_TRACE"\nexit 91\n`, { mode: 0o700 });
  }
  writeFileSync(join(bin, "id"), '#!/bin/sh\nprintf "1000\\n"\n', { mode: 0o700 });
  const env = {
    PATH: bin + delimiter + process.env.PATH,
    HOME: join(dir, "private-home"), TMPDIR: join(dir, "temp"), TZ: "UTC",
    XIAOAIXIAOAI_MIRROR: "0", POLICY_TRACE: trace, POLICY_ROOT: dir,
  };
  const target = join(dir, "target");
  const bundle = join(dir, "fixture-local-bundle.tar.gz");
  // An intentionally inert fixture. No real bundle is read or extracted by these tests.
  writeFileSync(bundle, "FAKE_LOCAL_BUNDLE_NOT_AN_INSTALL\n");
  return { dir, bin, trace, env, target, bundle, close: () => rmSync(dir, { recursive: true, force: true }) };
}

function runBash(file, args, f, extraEnv = {}) {
  return spawnSync("bash", [join(ROOT, file), ...args], {
    encoding: "utf8", env: { ...f.env, ...extraEnv }, timeout: 15_000,
  });
}

for (const script of scripts) {
  test(`${script}: syntax parses without execution`, () => {
    const r = spawnSync("bash", ["-n", join(ROOT, script)], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
  for (const [label, args, repo] of [
    ["no source", [], ""],
    ["legacy upstream repo cannot enable downloads", [], "Crosery/herdr-pocket"],
    ["legacy custom repo cannot enable downloads", ["--version", "0.1.0"], "own/repository"],
    ["URL source rejected", ["--source", "https://example.invalid/bundle.tar.gz"], ""],
    ["missing local source rejected", ["--source", "/nonexistent-xiaoaixiaoai-fixture/bundle.tar.gz"], ""],
  ]) {
    test(`${script}: ${label}, before network or filesystem effects`, () => {
      const f = fixture();
      try {
        const r = runBash(script, ["--dir", f.target, ...args], f, { HERDR_POCKET_REPO: repo });
        assert.ifError(r.error);
        assert.notEqual(r.status, 0);
        if (!args.includes("--source")) assert.match(r.stderr, disabled);
        else assert.match(r.stderr, /local .*?(?:bundle|checkout)|existing local/);
        assert.equal(text(f.trace), "", "no network, directory, Node, Docker or service command reached");
        assert.equal(existsSync(f.target), false);
      } finally { f.close(); }
    });
  }
}

test("host local source passes policy but first mkdir is intercepted; no install occurs", () => {
  const f = fixture();
  try {
    const r = runBash(scripts[0], ["--source", f.bundle, "--dir", f.target, "--no-service"], f);
    assert.equal(r.status, 91, r.stderr);
    assert.equal(text(f.trace), "mkdir\n");
    assert.equal(existsSync(f.target), false);
  } finally { f.close(); }
});

for (const [label, image] of [
  ["missing explicit image", null],
  ["official image", "ghcr.io/crosery/herdr-pocket-relay:latest"],
  ["case-insensitive official namespace", "GHCR.IO/CROSERY/another-relay:latest"],
  ["shell interpolation is not an image", "own/relay:$(not-a-command)"],
  ["image URL is not a reference", "https://registry.example.invalid/own/relay:local"],
  ["official namespace with explicit HTTPS port", "ghcr.io:443/crosery/herdr-pocket-relay:latest"],
]) {
  test(`relay Docker rejects ${label} before Docker/Node/mkdir`, () => {
    const f = fixture();
    try {
      const r = runBash(scripts[1], ["--source", f.bundle, "--dir", f.target, "--docker", ...(image ? ["--image", image] : [])], f);
      assert.ifError(r.error);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /explicit own\/local --image|upstream official image|plain Docker image reference/);
      assert.equal(text(f.trace), "");
      assert.equal(existsSync(f.target), false);
    } finally { f.close(); }
  });
}

test("Docker installer does not overwrite a different existing Compose project", () => {
  const f = fixture();
  try {
    mkdirSync(f.target);
    const compose = join(f.target, "compose.yml");
    const original = "name: herdr-pocket\nvolumes:\n  data:\n";
    writeFileSync(compose, original);
    const r = runBash(scripts[1], ["--source", f.bundle, "--dir", f.target, "--docker", "--image", "xiaoaixiaoai-fixture:local"], f);
    assert.ifError(r.error);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Existing Compose project is not xiaoaixiaoai/);
    assert.equal(text(compose), original);
    assert.equal(text(f.trace), "", "no network, writes, Docker or service commands reached");
  } finally { f.close(); }
});

test("local Docker fixture generates a fail-closed manager; no Docker daemon or downloads run", () => {
  const f = fixture();
  try {
    const checkout = join(f.dir, "local-checkout");
    mkdirSync(join(checkout, "deploy", "docker"), { recursive: true });
    writeFileSync(join(checkout, "deploy", "docker", "compose.yml"), source("deploy/docker/compose.yml"));
    mkdirSync(f.target);
    writeFileSync(join(f.target, "relay.env"), "POCKET_ASSISTANT_MODELS=\n");
    for (const name of ["mkdir", "cp"]) {
      const command = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
      assert.ok(command.startsWith("/"));
      writeFileSync(join(f.bin, name), `#!/bin/sh\nfor p do case "$p" in -*) ;; "$POLICY_ROOT"|"$POLICY_ROOT"/*) ;; *) exit 93 ;; esac; done\nexec '${command}' "$@"\n`, { mode: 0o700 });
    }
    writeFileSync(join(f.bin, "docker"), '#!/bin/sh\nprintf "docker:%s:image=%s\\n" "$*" "${POCKET_IMAGE:-}" >> "$POLICY_TRACE"\nexit 0\n', { mode: 0o700 });
    const inherited = { POCKET_IMAGE: "ghcr.io/crosery/herdr-pocket-relay:latest", HERDR_POCKET_REPO: "Crosery/herdr-pocket" };
    const r = runBash(scripts[1], ["--source", checkout, "--dir", f.target, "--docker", "--image", "xiaoaixiaoai-fixture:local", "--port", "7420", "--no-start"], f, inherited);
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stderr);
    const manager = join(f.target, "xiaoaixiaoai-relay");
    const managerText = sourceFrom(manager);
    assert.doesNotMatch(managerText, /docker compose pull|raw\.githubusercontent/);
    assert.match(managerText, /export POCKET_IMAGE="xiaoaixiaoai-fixture:local"/);
    const before = text(f.trace);
    const update = spawnSync("sh", [manager, "update"], { env: { ...f.env, ...inherited }, encoding: "utf8" });
    assert.equal(update.status, 1);
    assert.match(update.stderr, /Remote image updates are disabled/);
    assert.equal(text(f.trace), before, "update reached no fake Docker command");
    for (const op of ["start", "restart"]) {
      const result = spawnSync("sh", [manager, op], { env: { ...f.env, ...inherited }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const calls = text(f.trace).slice(before.length).trim().split("\n");
    assert.equal(calls.length, 2);
    assert.ok(calls.every((line) => line.includes("--pull never") && line.endsWith("image=xiaoaixiaoai-fixture:local")));
    assert.doesNotMatch(text(f.trace), /docker:compose pull|curl|node|systemctl/);
  } finally { f.close(); }
});

function sourceFrom(path) { return readFileSync(path, "utf8"); }

test("shell sources retain local install branches but no remote product fallback/bootstrap", () => {
  for (const name of scripts) {
    const value = source(name);
    assert.doesNotMatch(value, /raw\.githubusercontent\.com|github\.com\/\$REPO|gh_fetch|latest_tag|docker compose pull/);
    assert.ok(value.indexOf("explicit local bundle required") < value.indexOf('mkdir -p "$DIR"'));
    assert.match(value, /file=\$SOURCE/);
  }
});

test("container templates have no official fallback and require a deliberate own image", () => {
  const compose = source("deploy/docker/compose.yml");
  const k8s = source("deploy/k8s/relay.yaml");
  const render = source("deploy/render/render.yaml");
  assert.match(compose, /image: \$\{POCKET_IMAGE:\?[^}]+\}/);
  assert.match(compose, /pull_policy: never/);
  assert.match(k8s, /^\s+image: ""$/m);
  assert.match(render, /^\s+url: ""$/m);
  for (const value of [compose, k8s, render]) assert.doesNotMatch(value, /ghcr\.io\/crosery\//i);
});

const windowsPowerShell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const pwshProbe = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8" });
const powershell = pwshProbe.status === 0 ? "pwsh" : existsSync(windowsPowerShell) ? windowsPowerShell : null;
function psRun(program) {
  return spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(program, "utf16le").toString("base64")], { encoding: "utf8", timeout: 25_000 });
}
const psSource = source("scripts/install-host.ps1");
const psPath = powershell === windowsPowerShell
  ? join(ROOT, "scripts/install-host.ps1").replace(/^\/mnt\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:/`)
  : join(ROOT, "scripts/install-host.ps1");
const psPrelude = `$source = [IO.File]::ReadAllText('${psPath.replaceAll("'", "''")}', [Text.Encoding]::UTF8)\n$tokens = $null; $errors = $null\n$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)\nif ($errors.Count -ne 0) { Write-Output ('PARSE_ERRORS=' + $errors.Count); exit 2 }\n`;

test("PowerShell source is parsed only, never dot-sourced or installed", { skip: !powershell && "PowerShell unavailable" }, () => {
  const r = psRun(psPrelude + "Write-Output 'PARSE_OK'");
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PARSE_OK/);
});

test("PowerShell pure guard rejects defaults, legacy env, URLs/UNC and missing files without IO", { skip: !powershell && "PowerShell unavailable" }, () => {
  const r = psRun(psPrelude + `
$ErrorActionPreference = 'Stop'
$f = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'AssertLocalBundleSource' }, $true)
if (-not $f) { throw 'GUARD_MISSING' }
# Execute only the pure function definition; never invoke the installer AST/body.
Invoke-Expression $f.Extent.Text
function Invoke-WebRequest { throw 'NETWORK_USED' }
function Invoke-RestMethod { throw 'NETWORK_USED' }
function New-Item { throw 'WRITE_USED' }
function PrivateNode { throw 'NODE_USED' }
$script:checks = 0
function Test-Path([string]$LiteralPath, [string]$PathType) {
  $script:checks++
  if ($PathType -ne 'Leaf') { throw 'NOT_LEAF' }
  return $LiteralPath -eq 'C:\\fixture\\own-bundle.tar.gz' -or $LiteralPath -eq 'Env:FAKE_POLICY_PATH'
}
function Resolve-Path([string]$LiteralPath) {
  $provider = if ($LiteralPath -eq 'Env:FAKE_POLICY_PATH') { 'Environment' } else { 'FileSystem' }
  return [pscustomobject]@{ Path = $LiteralPath; ProviderPath = $LiteralPath; Provider = [pscustomobject]@{ Name = $provider } }
}
$env:HERDR_POCKET_REPO = 'Crosery/herdr-pocket'
foreach ($bad in @('', ' ', 'https://example.invalid/file.tar.gz', 'file:///C:/fixture/file.tar.gz', '\\\\server\\share\\file.tar.gz', '//server/share/file.tar.gz', 'C:\\fixture\\missing.tar.gz', 'Env:FAKE_POLICY_PATH')) {
  $rejected = $false
  try { $null = AssertLocalBundleSource $bad } catch { $rejected = $true }
  if (-not $rejected) { throw 'POLICY_ACCEPTED_BAD_SOURCE' }
}
$good = AssertLocalBundleSource 'C:\\fixture\\own-bundle.tar.gz'
if ($good -ne 'C:\\fixture\\own-bundle.tar.gz') { throw 'LOCAL_SOURCE_CHANGED' }
if ($script:checks -ne 3) { throw 'UNEXPECTED_PATH_IO' }
Write-Output 'MOCK_GUARD_9_CASES_OK'
`);
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MOCK_GUARD_9_CASES_OK/);
});

test("PowerShell main policy precedes bootstrap and cannot honor remote-repo overrides", () => {
  const guard = psSource.indexOf("$From = AssertLocalBundleSource $From");
  assert.ok(guard > 0 && guard < psSource.indexOf("$Node = PrivateNode") && guard < psSource.indexOf("New-Item"));
  assert.doesNotMatch(psSource, /\$Repo\s*=|GhFetch|LatestTag|raw\.githubusercontent|api\.github\.com/);
  assert.match(psSource, /\$file = \(Resolve-Path -LiteralPath \$From\)\.Path/);
});
