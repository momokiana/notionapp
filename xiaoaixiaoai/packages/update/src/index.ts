// Version, release lookup and in-place updates for the relay and the host CLI.
//
// An install made by scripts/install-relay.sh or scripts/install-host.sh looks like
//   <root>/releases/<version>/            one unpacked copy per version
//   <root>/current  -> releases/<version>  what the service runs
//   <root>/previous -> releases/<version>  the copy before the last update, for rollback
// An update unpacks the new copy next to the old one, checks that it starts, then swaps
// the `current` link in one rename, so a failed update leaves the running copy untouched.
// On Windows (scripts/install-host.ps1) the links are directory junctions, which need no
// Developer Mode; a junction can't be renamed over another, so it is replaced instead.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { RELEASE_ASSET_PREFIX, RELEASE_REPO, RELEASE_UPDATES_DISABLED_REASON, RELEASE_UPDATES_ENABLED, apkAssetName, inMainlandChina, releaseFromSums, releaseSources } from "@xiaoaixiaoai/protocol";
import { extractTarGz, tarVersion } from "./untar.ts";

const WINDOWS = process.platform === "win32";

/** The owned release repository, absent until configured in the protocol package. */
export const DEFAULT_REPO = RELEASE_REPO;

/** Remote updates must not fall back to upstream, legacy environment variables or a fake URL. */
export class ReleaseUpdatesDisabledError extends Error {
  readonly code = "RELEASE_UPDATES_DISABLED";

  constructor() {
    super(RELEASE_UPDATES_DISABLED_REASON);
    this.name = "ReleaseUpdatesDisabledError";
  }
}

/** Whether remote updates from the owned repository are active (tests/ops can disable via env). */
export function remoteUpdatesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return RELEASE_UPDATES_ENABLED && typeof DEFAULT_REPO === "string" && DEFAULT_REPO.length > 0 &&
    !/^(1|true|on|yes)$/i.test(env.XIAOAIXIAOAI_DISABLE_REMOTE_UPDATES ?? "");
}

function requireReleaseSource(): void {
  if (!remoteUpdatesEnabled()) throw new ReleaseUpdatesDisabledError();
}

/** Root of this copy: the folder with the workspace package.json. */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** One version for relay, host and app: the root package.json, stamped by the release workflow. */
export const VERSION = readVersion(APP_ROOT);

/** Release asset names. .github/workflows/release.yml and the app's updater use the same ones. */
export const ASSETS = {
  bundle: (version: string) => `${RELEASE_ASSET_PREFIX}-${version.trim().replace(/^v/i, "")}.tar.gz`,
  apk: apkAssetName,
  checksums: "SHA256SUMS",
};

export const SERVICES = {
  hostLaunchd: "com.xiaoaixiaoai.hostd",
  hostSystemd: "xiaoaixiaoai-hostd.service",
  relaySystemd: "xiaoaixiaoai-relay.service",
  /** Windows: the HKCU Run entry that starts `xiaoaixiaoai service` at logon (launcher in <root>\bin). */
  hostWindows: "XiaoAiXiaoAi",
} as const;

export type Service = "host" | "relay";

export function readVersion(root: string): string {
  try {
    const v = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    return typeof v === "string" && v ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const repo = (): string => {
  requireReleaseSource();
  return DEFAULT_REPO!;
};
const apiBase = (): string => "https://api.github.com";
const UA = "xiaoaixiaoai-updater";

/** Semver order; a pre-release sorts before its release. Returns -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const s = v.trim().replace(/^v/i, "").split("+")[0]!;
    const dash = s.indexOf("-");
    const core = dash < 0 ? s : s.slice(0, dash);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: dash < 0 ? "" : s.slice(dash + 1) };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return Math.sign(x.pre.localeCompare(y.pre, "en", { numeric: true }));
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

export interface Release {
  version: string;
  tag: string;
  page: string;
  /** Download URL by asset name. */
  assets: Record<string, string>;
  /** GitHub's source tarball of the tag, used when the bundle asset is missing. */
  tarball: string;
}

/**
 * Mirrors before GitHub: on in mainland China by this machine's time zone. A server often
 * runs on UTC, so XIAOAIXIAOAI_MIRROR=1 turns them on (and =0 off) whatever the time zone.
 */
export function mirrorsFirst(): boolean {
  const v = process.env.XIAOAIXIAOAI_MIRROR ?? "";
  if (/^(1|true|on|yes)$/i.test(v)) return true;
  if (/^(0|false|off|no)$/i.test(v)) return false;
  return inMainlandChina();
}

/** No network sources while disabled; otherwise a GitHub file may also use reviewed mirrors. */
export function sourcesFor(url: string): string[] {
  if (!remoteUpdatesEnabled()) return [];
  return url.startsWith("https://github.com/") ? releaseSources(url, mirrorsFirst()) : [url];
}

/**
 * The newest published release (GitHub skips drafts and pre-releases here). From the API,
 * or from the release's SHA256SUMS, which mirrors carry: in mainland China the mirrors are
 * asked first. With no owned release source this rejects before any network access.
 * Legacy HERDR_POCKET_REPO / HERDR_POCKET_API variables cannot re-enable updates.
 */
export async function latestRelease(): Promise<Release> {
  requireReleaseSource();
  const sums = sourcesFor(`https://github.com/${repo()}/releases/latest/download/${ASSETS.checksums}`).map((u) => () => latestFromSums(u));
  const tries = mirrorsFirst() ? [...sums.slice(0, -1), latestFromApi, sums[sums.length - 1]!] : [latestFromApi, ...sums];
  let first: unknown;
  for (const attempt of tries) {
    try {
      return await attempt();
    } catch (e) {
      first ??= e;
    }
  }
  throw first;
}

/** The release a SHA256SUMS listing names (fetched from `url`, which may be a mirror). */
async function latestFromSums(url: string): Promise<Release> {
  const found = releaseFromSums(await fetchText(url, [url]));
  if (!found) throw new Error(`${url} is not a release checksum list`);
  const tag = `v${found.version}`;
  const file = (name: string) => `https://github.com/${repo()}/releases/download/${tag}/${name}`;
  return {
    version: found.version,
    tag,
    page: `https://github.com/${repo()}/releases/tag/${tag}`,
    assets: Object.fromEntries(Object.keys(found.sums).concat(ASSETS.checksums).map((name) => [name, file(name)])),
    tarball: `https://github.com/${repo()}/archive/refs/tags/${tag}.tar.gz`,
  };
}

async function latestFromApi(): Promise<Release> {
  const url = `${apiBase()}/repos/${repo()}/releases/latest`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": UA };
  // Only the reviewed owned GitHub source is used; no legacy custom API receives a token.
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }).catch((e: Error) => {
    const cause = (e.cause as Error | undefined)?.message ?? e.message;
    throw new Error(`could not reach ${apiBase()} (${cause})`);
  });
  if (res.status === 404) throw new Error(`no published release found for ${repo()}`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url}`);
  const j = (await res.json()) as {
    tag_name?: string;
    html_url?: string;
    tarball_url?: string;
    assets?: { name: string; browser_download_url: string }[];
  };
  if (!j.tag_name) throw new Error("GitHub returned a release without a tag");
  return {
    version: j.tag_name.replace(/^v/i, ""),
    tag: j.tag_name,
    page: j.html_url ?? `https://github.com/${repo()}/releases`,
    assets: Object.fromEntries((j.assets ?? []).map((a) => [a.name, a.browser_download_url])),
    tarball: j.tarball_url ?? `${apiBase()}/repos/${repo()}/tarball/${j.tag_name}`,
  };
}

export interface Check {
  current: string;
  latest: Release;
  newer: boolean;
}

export async function checkForUpdate(current = VERSION): Promise<Check> {
  const latest = await latestRelease();
  return { current, latest, newer: compareVersions(latest.version, current) > 0 };
}

/**
 * Log a line when a newer release exists: first about a minute after start, then once a day.
 * XIAOAIXIAOAI_UPDATE_CHECK=0 turns it off. Failures (offline, rate limit) stay quiet.
 */
export function watchForUpdates(log: (msg: string) => void, command: string, timing: { firstMs?: number; everyMs?: number } = {}): () => void {
  if (!remoteUpdatesEnabled() || /^(0|false|off|no)$/i.test(process.env.XIAOAIXIAOAI_UPDATE_CHECK ?? "")) return () => {};
  const check = () =>
    checkForUpdate().then(
      (c) => {
        if (c.newer) log(`version ${c.latest.version} is out (this is ${c.current}): run \`${command}\` · ${c.latest.page}`);
      },
      () => {},
    );
  const first = setTimeout(check, timing.firstMs ?? 60_000);
  const every = setInterval(check, timing.everyMs ?? 24 * 3600_000);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

// ---------------------------------------------------------------------------
// Install layout
// ---------------------------------------------------------------------------

export interface Layout {
  root: string;
}

/** The managed install this code runs from, or an error that says how this copy is updated instead. */
export function findLayout(appRoot = APP_ROOT): Layout {
  const releases = dirname(appRoot);
  const root = dirname(releases);
  if (basename(releases) === "releases" && isLink(join(root, "current"))) return { root };
  if (process.env.XIAOAIXIAOAI_INSTALL === "docker") {
    throw new Error("this copy runs in Docker: preload a reviewed own image, set POCKET_IMAGE explicitly and start it with docker compose up -d --pull never.");
  }
  if (existsSync(join(appRoot, ".git"))) throw new Error(`${appRoot} is a git checkout: update it with \`git pull && pnpm install\`.`);
  throw new Error(`${appRoot} was not installed by the install script, so it can't update itself. Run the install script again (docs/deploy).`);
}

export interface UpdateOptions {
  service: Service;
  /** An explicit local bundle remains usable while release networking is disabled. */
  from?: string;
  /** Reinstall even when the latest release is not newer. */
  force?: boolean;
  /** Restart the service that runs this install (default true). */
  restart?: boolean;
  log?: (msg: string) => void;
  layout?: Layout;
}

export interface UpdateResult {
  from: string;
  to: string;
  changed: boolean;
  restarted?: string;
}

export async function update(o: UpdateOptions): Promise<UpdateResult> {
  // Fail before locating/writing an install. Only an explicit local file, the owned GitHub
  // download path, and rollback are usable; --force/legacy env cannot bypass this.
  if (!o.from || /^https?:\/\//i.test(o.from)) {
    requireReleaseSource();
    if (o.from && !o.from.startsWith(`https://github.com/${repo()}/releases/download/`)) {
      throw new ReleaseUpdatesDisabledError();
    }
  }
  const log = o.log ?? ((m: string) => console.log(m));
  const { root } = o.layout ?? findLayout();
  const current = readVersion(join(root, "current"));
  mustWrite(root, o.service);

  let src: { url: string; version?: string; sha256?: string; kind: "bundle" | "source" };
  if (o.from) {
    src = { url: o.from, kind: "bundle" };
  } else {
    const rel = await latestRelease();
    if (compareVersions(rel.version, current) <= 0 && !o.force) return { from: current, to: rel.version, changed: false };
    const name = ASSETS.bundle(rel.version);
    const url = rel.assets[name];
    if (url) {
      const sums = rel.assets[ASSETS.checksums];
      const sha256 = sums ? sumFor(await fetchText(sums), name) : undefined;
      if (sums && !sha256) throw new Error(`${ASSETS.checksums} of ${rel.tag} has no line for ${name}`);
      src = { url, version: rel.version, sha256, kind: "bundle" };
    } else {
      src = { url: rel.tarball, version: rel.version, kind: "source" };
    }
  }

  const unlock = lock(root);
  const work = mkdtempSync(join(root, ".update-"));
  /** A half-made copy in releases/ to remove when the update fails (Windows). */
  let partial: string | undefined;
  try {
    const file = join(work, "download.tar.gz");
    log(`downloading ${src.version ?? ""} ${src.url}`.replace(/\s+/, " "));
    await fetchTo(src.url, file, src.sha256, log);
    let dir: string;
    let version: string;
    if (WINDOWS) {
      // Junctions hold absolute paths, so the copy is unpacked where it will stay.
      version = src.version ?? tarVersion(file);
      dir = join(root, "releases", freeReleaseName(root, version));
      rmSync(dir, { recursive: true, force: true });
      partial = dir;
      extractTarGz(file, dir, { strip: 1, exclude: ["apps/mobile", "docs"] });
    } else {
      dir = join(work, "app");
      mkdirSync(dir);
      // --no-same-owner: files belong to whoever updates (root for the relay), never to the CI runner's uid.
      run("tar", ["-xzf", file, "-C", dir, "--strip-components=1", "--no-same-owner", "--exclude=*/apps/mobile", "--exclude=*/docs"]);
      version = src.version ?? readVersion(dir);
    }
    if (src.kind === "source") {
      stampVersion(dir, version);
      pnpmInstall(dir, log);
    } else if (src.version && readVersion(dir) !== src.version) {
      throw new Error(`the download says it is ${readVersion(dir)}, expected ${src.version}`);
    }
    smokeTest(dir, o.service, version);

    let name: string;
    if (WINDOWS) {
      name = basename(dir);
    } else {
      name = freeReleaseName(root, version);
      const target = join(root, "releases", name);
      rmSync(target, { recursive: true, force: true });
      renameSync(dir, target);
    }
    partial = undefined;
    const before = readLink(join(root, "current"));
    setLink(root, "current", `releases/${name}`);
    if (before && before !== `releases/${name}`) setLink(root, "previous", before);
    prune(root, work);
    log(`installed ${version} (was ${current})`);
    const restarted = o.restart === false ? undefined : restartService(o.service, root, log);
    return { from: current, to: version, changed: true, restarted };
  } finally {
    if (partial) rmSync(partial, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
    unlock();
  }
}

/** Swap back to the copy before the last update. */
export function rollback(o: Omit<UpdateOptions, "from" | "force">): UpdateResult {
  const log = o.log ?? ((m: string) => console.log(m));
  const { root } = o.layout ?? findLayout();
  mustWrite(root, o.service);
  const prev = readLink(join(root, "previous"));
  const cur = readLink(join(root, "current"));
  if (!prev || !cur || !existsSync(join(root, prev))) throw new Error("there is no earlier version to go back to");
  const from = readVersion(join(root, "current"));
  const to = readVersion(join(root, prev));
  const unlock = lock(root);
  try {
    setLink(root, "current", prev);
    setLink(root, "previous", cur);
  } finally {
    unlock();
  }
  log(`switched back to ${to} (was ${from})`);
  const restarted = o.restart === false ? undefined : restartService(o.service, root, log);
  return { from, to, changed: true, restarted };
}

/**
 * Restart the service that runs this install: the launchd agent or systemd unit written by the
 * install script, recognised by its file naming this install's folder. Anything else is left alone.
 */
export function restartService(service: Service, root: string, log: (msg: string) => void): string | undefined {
  let file: string;
  let commands: string[][];
  let name: string;
  if (service === "relay") {
    name = SERVICES.relaySystemd;
    file = `/etc/systemd/system/${name}`;
    commands = [["systemctl", "restart", name]];
  } else if (process.platform === "darwin") {
    name = SERVICES.hostLaunchd;
    file = join(homedir(), "Library", "LaunchAgents", `${name}.plist`);
    const domain = `gui/${process.getuid?.() ?? 501}`;
    // kickstart restarts a loaded agent; bootstrap loads one that is not.
    commands = [
      ["launchctl", "kickstart", "-k", `${domain}/${name}`],
      ["launchctl", "bootstrap", domain, file],
    ];
  } else if (WINDOWS) {
    // The new copy's own `service restart`: the running supervisor hands over to it.
    name = SERVICES.hostWindows;
    file = join(root, "bin", "hostd-start.js");
    commands = [[process.execPath, "--no-warnings", join(root, "current", "apps", "hostd", "src", "cli.ts"), "service", "restart"]];
  } else {
    name = SERVICES.hostSystemd;
    file = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", name);
    commands = [["systemctl", "--user", "restart", name]];
  }
  if (!fileMentions(file, root)) {
    log(`no ${name} service runs ${root}; restart it yourself to use the new version`);
    return undefined;
  }
  let last = "";
  for (const [cmd, ...args] of commands) {
    const r = spawnSync(cmd!, args, { encoding: "utf8", windowsHide: true, timeout: 90_000 });
    if (r.status === 0) {
      log(`restarted ${name}`);
      return name;
    }
    last = (r.stderr || r.error?.message || `exit ${r.status}`).trim();
  }
  log(`could not restart ${name} (${last}). Run: ${commands[0]!.join(" ")}`);
  return undefined;
}

// ---------------------------------------------------------------------------
// CLI commands shared by `xiaoaixiaoai` and `xiaoaixiaoai-relay`
// ---------------------------------------------------------------------------

export interface CommandInfo {
  service: Service;
  /** The command name users type, for messages. */
  bin: string;
}

export function updateHelpText(env: NodeJS.ProcessEnv = process.env): string {
  if (remoteUpdatesEnabled(env)) {
    return `  version [--check]   Print the version (--check queries the owned release source).
  update [--check] [--rollback] [--from <local-file>] [--force] [--no-restart]
        Update from the owned release source or an explicit local bundle (--from);
        --rollback switches back to the copy before the last update.`;
  }
  return `  version [--check]   Print the version; remote checks are disabled until an owned release source is configured.
  update [--check] [--rollback] [--from <local-file>] [--force] [--no-restart]
        Remote updates/downloads are disabled. --from installs an explicit local bundle;
        --rollback switches back to the copy before the last update.`;
}

export const UPDATE_HELP = updateHelpText();

export async function versionCommand(argv: string[], info: CommandInfo): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { check: { type: "boolean", default: false } } });
  console.log(`${info.bin} ${VERSION}`);
  if (values.check) await printCheck(info);
}

export async function updateCommand(argv: string[], info: CommandInfo): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: "boolean", default: false },
      rollback: { type: "boolean", default: false },
      from: { type: "string" },
      force: { type: "boolean", default: false },
      "no-restart": { type: "boolean", default: false },
    },
  });
  if (values.check) {
    console.log(`${info.bin} ${VERSION}`);
    return printCheck(info);
  }
  const restart = !values["no-restart"];
  const r = values.rollback
    ? rollback({ service: info.service, restart })
    : await update({ service: info.service, from: values.from, force: values.force, restart });
  if (!r.changed) console.log(`already up to date (${r.from}; latest release ${r.to})`);
  else console.log(`✓ ${r.from} → ${r.to}${r.restarted ? ` · restarted ${r.restarted}` : ""}`);
}

async function printCheck(info: CommandInfo): Promise<void> {
  const c = await checkForUpdate();
  if (c.newer) console.log(`newer release: ${c.latest.version} · ${c.latest.page}\nrun \`${info.bin} update\``);
  else console.log(`up to date (latest release ${c.latest.version})`);
}

// ---------------------------------------------------------------------------

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Where a link points, as `releases/<name>`. Junctions (Windows) hold absolute paths;
 * they are given back in the same relative form as the symlinks elsewhere.
 */
function readLink(p: string): string | undefined {
  let target: string;
  try {
    target = readlinkSync(p);
  } catch {
    return undefined;
  }
  if (!WINDOWS) return target;
  const abs = target.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
  return basename(dirname(abs)) === "releases" ? `releases/${basename(abs)}` : target;
}

/** `current` or `previous` of an install, as `releases/<name>`. */
export function linkTarget(root: string, name: "current" | "previous"): string | undefined {
  return readLink(join(root, name));
}

/**
 * Point `<root>/<name>` at `target` (relative to root). Elsewhere a symlink replaced in one
 * rename, so readers see the old or the new target, never none; on Windows a junction.
 */
export function setLink(root: string, name: string, target: string): void {
  if (WINDOWS) {
    const link = join(root, name);
    removeLink(link);
    symlinkSync(resolve(root, target), link, "junction");
    return;
  }
  const tmp = join(root, `.${name}.${process.pid}`);
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, join(root, name));
}

/** Removes a link (never what it points to). */
function removeLink(p: string): void {
  try {
    unlinkSync(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code !== "EPERM" && code !== "EISDIR") throw e;
    rmdirSync(p); // a junction, on Windows versions where unlink refuses it
  }
}

function freeReleaseName(root: string, version: string): string {
  const inUse = new Set([readLink(join(root, "current")), readLink(join(root, "previous"))].map((l) => l && basename(l)));
  return inUse.has(version) ? `${version}+${Date.now().toString(36)}` : version;
}

/** Keep only the current and previous copies; drop leftovers of interrupted updates. */
function prune(root: string, work: string): void {
  const keep = new Set([readLink(join(root, "current")), readLink(join(root, "previous"))].map((l) => l && basename(l)));
  // A copy still in use (Windows keeps open files) is left for the next update.
  const drop = (p: string) => {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  };
  for (const name of readdirSync(join(root, "releases"))) {
    if (!keep.has(name)) drop(join(root, "releases", name));
  }
  for (const name of readdirSync(root)) {
    if (name.startsWith(".update-") && join(root, name) !== work) drop(join(root, name));
  }
}

function lock(root: string): () => void {
  const p = join(root, ".update.lock");
  try {
    mkdirSync(p);
  } catch {
    let age = Infinity;
    try {
      age = Date.now() - statSync(p).mtimeMs;
    } catch {}
    if (age < 30 * 60_000) throw new Error(`another update is running (${p}); delete that folder if it is not`);
    rmSync(p, { recursive: true, force: true });
    mkdirSync(p);
  }
  return () => rmSync(p, { recursive: true, force: true });
}

function mustWrite(root: string, service: Service): void {
  try {
    accessSync(root, constants.W_OK);
  } catch {
    throw new Error(`can't write to ${root}${service === "relay" ? ": run it with sudo" : ""}`);
  }
}

/**
 * Whether a service file names this install. The Windows launcher is UTF-16 JScript, so its
 * paths are string literals with doubled backslashes; Windows paths ignore case.
 */
export function fileMentions(file: string, text: string, windows = WINDOWS): boolean {
  try {
    const b = readFileSync(file);
    const s = b[0] === 0xff && b[1] === 0xfe ? b.subarray(2).toString("utf16le") : b.toString("utf8");
    if (!windows) return s.includes(text);
    const low = s.toLowerCase();
    return [text, JSON.stringify(text).slice(1, -1)].some((t) => low.includes(t.toLowerCase()));
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[], cwd?: string): void {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 400)}`);
}

/** Downloads `src` (trying its mirrors in turn) and checks the hash when one is given. */
async function fetchTo(src: string, file: string, want?: string, log: (m: string) => void = () => {}): Promise<void> {
  const check = async () => {
    if (!want) return;
    const got = await sha256(file);
    if (got !== want) throw new Error(`checksum mismatch for ${basename(src)}: expected ${want}, got ${got}`);
  };
  if (!/^https?:\/\//i.test(src)) {
    copyFileSync(resolve(src.replace(/^file:\/\//i, "")), file);
    return check();
  }
  let first: unknown;
  for (const url of sourcesFor(src)) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/octet-stream" }, signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
      await check();
      return;
    } catch (e) {
      first ??= e;
      log(`  ${(e as Error).message.split("\n")[0]}${url === src ? "" : ` (through ${new URL(url).host})`}; trying the next source`);
    }
  }
  throw first;
}

async function fetchText(url: string, sources = sourcesFor(url)): Promise<string> {
  let first: unknown;
  for (const u of sources) {
    try {
      const res = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${u}`);
      return await res.text();
    } catch (e) {
      first ??= e;
    }
  }
  throw first;
}

/** The hash for one file in a `sha256sum` listing. */
export function sumFor(listing: string, name: string): string | undefined {
  for (const line of listing.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m && basename(m[2]!) === name) return m[1]!.toLowerCase();
  }
  return undefined;
}

async function sha256(file: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

function stampVersion(dir: string, version: string): void {
  const p = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(p, "utf8"));
  pkg.version = version;
  writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** Source tarballs come without node_modules: install the production deps of relay and host. */
function pnpmInstall(dir: string, log: (msg: string) => void): void {
  const args = ["install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--filter", "@xiaoaixiaoai/relay...", "--filter", "@xiaoaixiaoai/hostd..."];
  log("installing dependencies with pnpm");
  for (const pre of [["pnpm"], ["corepack", "pnpm"], ["npx", "--yes", "pnpm"]]) {
    // pnpm, corepack and npx are .cmd files on Windows, which only a shell runs (the arguments are fixed).
    const r = spawnSync(pre[0]!, [...pre.slice(1), ...args], { cwd: dir, stdio: ["ignore", "inherit", "inherit"], shell: WINDOWS });
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") continue;
    if (r.status === 0) return;
    throw new Error("pnpm install failed; nothing was changed");
  }
  throw new Error("this release has no prebuilt bundle and pnpm is not installed (npm i -g pnpm)");
}

/** Start the new copy once before switching to it, so missing files or deps never reach the service. */
function smokeTest(dir: string, service: Service, version: string): void {
  const args = service === "host" ? [join(dir, "apps/hostd/src/cli.ts"), "--version"] : [join(dir, "apps/relay/src/cli.ts"), "selftest"];
  const r = spawnSync(process.execPath, ["--no-warnings", ...args], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, XIAOAIXIAOAI_UPDATE_CHECK: "0" },
  });
  const out = (r.stdout ?? "").trim();
  if (r.status !== 0 || out !== version) {
    const why = r.error?.message ?? (r.stderr || out || `exit ${r.status}`).trim().slice(0, 400);
    throw new Error(`the new copy did not start (${why}); nothing was changed`);
  }
}
