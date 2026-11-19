// Unpacks a release .tar.gz with Node alone. Used on Windows, where the bundle's links
// (pnpm's node_modules are links) can't be made by tar.exe without Developer Mode: each
// link to a folder becomes a directory junction, which any user may create.
//
// No imports outside Node, so scripts/install-host.ps1 can run this one file from the
// bundle before anything else is unpacked:
//   node untar.ts <bundle.tar.gz>            print the bundle's version
//   node untar.ts <bundle.tar.gz> <folder>   unpack it into <folder> (its top folder dropped)

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export interface TarEntry {
  /** Path inside the archive, with `/` separators. */
  name: string;
  type: "file" | "dir" | "symlink" | "hardlink" | "other";
  mode: number;
  data: Buffer;
  /** Target of a symlink or hard link. */
  link: string;
}

const text = (b: Buffer, start: number, len: number) => {
  const s = b.subarray(start, start + len);
  const end = s.indexOf(0);
  return (end < 0 ? s : s.subarray(0, end)).toString("utf8");
};

function octal(b: Buffer, start: number, len: number): number {
  // Base-256 for values too big for octal (GNU): high bit of the first byte set.
  if (b[start]! & 0x80) {
    let n = b[start]! & 0x7f;
    for (let i = 1; i < len; i++) n = n * 256 + b[start + i]!;
    return n;
  }
  const s = text(b, start, len).trim();
  return s ? Number.parseInt(s, 8) : 0;
}

/** `key=value` records of a pax header. */
function pax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const len = Number.parseInt(data.subarray(i, space).toString("utf8"), 10);
    if (!(len > 0)) break;
    const record = data.subarray(space + 1, i + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/** The entries of an uncompressed tar (ustar, pax and GNU long names). */
export function readTar(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let longName: string | undefined;
  let longLink: string | undefined;
  let next: Record<string, string> = {};
  let off = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = octal(h, 124, 12);
    const flag = String.fromCharCode(h[156]!);
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (flag === "L") {
      longName = text(data, 0, data.length);
      continue;
    }
    if (flag === "K") {
      longLink = text(data, 0, data.length);
      continue;
    }
    if (flag === "x") {
      next = pax(data);
      continue;
    }
    if (flag === "g") continue;
    let name = text(h, 0, 100);
    if (text(h, 257, 5) === "ustar") {
      const prefix = text(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    name = next.path ?? longName ?? name;
    const link = next.linkpath ?? longLink ?? text(h, 157, 100);
    longName = longLink = undefined;
    next = {};
    const type =
      flag === "0" || flag === "\0" || flag === "7" ? "file" : flag === "5" ? "dir" : flag === "2" ? "symlink" : flag === "1" ? "hardlink" : "other";
    entries.push({ name, type, mode: octal(h, 100, 8) & 0o7777, data: Buffer.from(data), link });
  }
  return entries;
}

export interface ExtractOptions {
  /** Leading path parts to drop, like tar's --strip-components. */
  strip?: number;
  /** Paths (after stripping) to leave out, with everything under them. */
  exclude?: string[];
  /** Junctions instead of symlinks (default: on Windows). */
  junctions?: boolean;
}

/** Path inside the archive after stripping, or undefined to skip. Throws on paths that leave the folder. */
function inside(name: string, strip: number): string | undefined {
  const parts = name.replace(/\\/g, "/").split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..") || isAbsolute(name) || /^[A-Za-z]:/.test(name)) throw new Error(`unsafe path in the archive: ${name}`);
  const rest = parts.slice(strip);
  return rest.length ? rest.join("/") : undefined;
}

/** Unpacks a .tar.gz into `dest` (created if missing). */
export function extractTarGz(file: string, dest: string, o: ExtractOptions = {}): void {
  extractTar(gunzipSync(readFileSync(file)), dest, o);
}

export function extractTar(tar: Buffer, dest: string, o: ExtractOptions = {}): void {
  const strip = o.strip ?? 0;
  const junctions = o.junctions ?? process.platform === "win32";
  const exclude = (o.exclude ?? []).map((e) => e.replace(/^\/+|\/+$/g, ""));
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  const within = (p: string) => p === root || p.startsWith(root + sep);
  const links: Array<{ path: string; link: string; target: string; hard: boolean }> = [];

  for (const e of readTar(tar)) {
    const rel = inside(e.name, strip);
    if (!rel || exclude.some((x) => rel === x || rel.startsWith(`${x}/`))) continue;
    const path = join(root, ...rel.split("/"));
    if (e.type === "dir") {
      mkdirSync(path, { recursive: true });
    } else if (e.type === "file") {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, e.data, { mode: (e.mode & 0o777) | 0o600 });
    } else if (e.type === "symlink" || e.type === "hardlink") {
      // Hard links name another entry of the archive; symlinks are relative to their folder.
      const target = e.type === "hardlink" ? join(root, ...(inside(e.link, strip) ?? "").split("/")) : resolve(dirname(path), e.link);
      if (!within(target)) throw new Error(`link outside the archive: ${e.name} -> ${e.link}`);
      links.push({ path, link: e.link, target, hard: e.type === "hardlink" });
    }
  }

  if (!junctions) {
    for (const l of links) {
      mkdirSync(dirname(l.path), { recursive: true });
      if (l.hard) copyFileSync(l.target, l.path);
      else symlinkSync(l.link, l.path);
    }
    return;
  }
  // Junctions last, so their targets exist; a link to a link resolves once that one is made.
  let pending = links;
  for (let round = 0; pending.length && round < 8; round++) {
    const later: typeof links = [];
    for (const l of pending) {
      if (!existsSync(l.target)) {
        later.push(l);
        continue;
      }
      mkdirSync(dirname(l.path), { recursive: true });
      if (statSync(l.target).isDirectory()) symlinkSync(l.target, l.path, "junction");
      else copyFileSync(l.target, l.path);
    }
    pending = later;
  }
  if (pending.length) throw new Error(`links to nothing in the archive: ${pending.map((l) => l.link).join(", ")}`);
}

/** The version in the archive's top-level package.json. */
export function tarVersion(file: string): string {
  for (const e of readTar(gunzipSync(readFileSync(file)))) {
    const parts = e.name.split("/").filter(Boolean);
    if (e.type === "file" && parts.length === 2 && parts[1] === "package.json") {
      const v = JSON.parse(e.data.toString("utf8")).version;
      if (typeof v === "string" && v) return v;
    }
  }
  throw new Error(`${file} has no package.json with a version`);
}

// What install-host.ps1 runs (see the top of this file).
const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  const [file, dest] = process.argv.slice(2);
  if (!file) {
    console.error("usage: node untar.ts <bundle.tar.gz> [<folder>]");
    process.exit(2);
  }
  if (dest) extractTarGz(file, dest, { strip: 1, exclude: ["apps/mobile", "docs"] });
  console.log(tarVersion(file));
}
