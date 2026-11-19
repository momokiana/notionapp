import { mkdir, mkdtemp, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUT_LIMITS } from "@xiaoaixiaoai/protocol";
import { stateDir } from "./platform.ts";

/** A picture from a phone, checked: safe name, real bytes. */
export interface CheckedFile {
  name: string;
  mime: string;
  bytes: Buffer;
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

/** First bytes of each accepted type: the name and the stated type are not trusted. */
function looksLike(mime: string, b: Buffer): boolean {
  switch (mime) {
    case "image/jpeg":
      return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/png":
      return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/gif":
      return b.length > 6 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a");
    case "image/webp":
      return b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP";
    default:
      return false;
  }
}

/**
 * A name that is safe on disk and in a typed message: ASCII letters, digits,
 * `.`, `_`, `-`, at most 60 characters, ending in the extension of its type.
 */
export function safeName(name: unknown, mime: string, index: number): string {
  const ext = EXT[mime] ?? "bin";
  const base = typeof name === "string" ? (name.split(/[\\/]/).pop() ?? "") : "";
  const stem = base
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 55);
  return `${/[A-Za-z0-9]/.test(stem) ? stem : `image-${index + 1}`}.${ext}`;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Checks what a phone sent for `terminal.put`: one to `PUT_LIMITS.files`
 * pictures of an accepted type whose bytes really are that type, within the
 * size limits. Names come back safe and distinct. Throws a message for people.
 */
export function checkFiles(files: unknown): CheckedFile[] {
  if (!Array.isArray(files) || !files.length) throw new Error("没有收到图片");
  if (files.length > PUT_LIMITS.files) throw new Error(`一次最多发 ${PUT_LIMITS.files} 张图片`);
  const out: CheckedFile[] = [];
  const names = new Set<string>();
  let total = 0;
  files.forEach((f, i) => {
    const file = (f && typeof f === "object" ? f : {}) as { name?: unknown; mime?: unknown; data?: unknown };
    const mime = typeof file.mime === "string" ? file.mime.toLowerCase() : "";
    if (!(PUT_LIMITS.mimes as readonly string[]).includes(mime)) throw new Error(`第 ${i + 1} 个文件不是 JPEG、PNG、WebP 或 GIF 图片`);
    const data = typeof file.data === "string" ? file.data : "";
    // Base64 is a third larger than what it carries: anything longer is over the limit already.
    if (!data || data.length % 4 !== 0 || data.length > Math.ceil(PUT_LIMITS.fileBytes / 3) * 4 || !BASE64.test(data)) {
      throw new Error(data.length > Math.ceil(PUT_LIMITS.fileBytes / 3) * 4 ? `第 ${i + 1} 张图片太大了` : `第 ${i + 1} 张图片的内容不对`);
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > PUT_LIMITS.fileBytes) throw new Error(`第 ${i + 1} 张图片太大了`);
    if (!looksLike(mime, bytes)) throw new Error(`第 ${i + 1} 张图片的内容和类型对不上`);
    total += bytes.length;
    if (total > PUT_LIMITS.totalBytes) throw new Error(`图片加起来太大了，一次最多 ${Math.floor(PUT_LIMITS.totalBytes / 1024 / 1024)} MB`);
    const first = safeName(file.name, mime, i);
    let name = first;
    for (let n = 2; names.has(name); n++) name = first.replace(/(\.[a-z]+)$/, `-${n}$1`);
    names.add(name);
    out.push({ name, mime, bytes });
  });
  return out;
}

/**
 * Hands each file to `put` (e.g. `hc put`, which keeps its own copy beside the
 * terminal) from a private temporary folder that is removed afterwards.
 * Returns where each file landed, in order.
 */
export async function putThrough(files: CheckedFile[], put: (file: string) => Promise<string>): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "xiaoaixiaoai-put-"));
  try {
    const paths: string[] = [];
    for (const f of files) {
      const file = join(dir, f.name);
      await writeFile(file, f.bytes, { mode: 0o600, flag: "wx" });
      paths.push(await put(file));
    }
    return paths;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Where pictures for agents of the herdr terminal app are kept (it has no `hc put`). */
export const FILES_DIR = process.env.XIAOAIXIAOAI_FILES ?? join(stateDir(), "files");

/** Kept files older than this are removed the next time a picture arrives. */
export const KEEP_MS = 7 * 24 * 3600_000;

/**
 * Writes the files into `<root>/<terminal>/` (owner-only folders and files),
 * never over an existing file, and returns their paths. Pictures older than
 * `KEEP_MS` anywhere under `root` are removed first.
 */
export async function putLocal(files: CheckedFile[], terminal: string, root = FILES_DIR, now = Date.now()): Promise<string[]> {
  await pruneOld(root, now - KEEP_MS);
  const dir = join(root, terminal.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_") || "_");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  for (const f of files) {
    const dot = f.name.lastIndexOf(".");
    for (let n = 1; ; n++) {
      const file = join(dir, n === 1 ? f.name : `${f.name.slice(0, dot)}-${n}${f.name.slice(dot)}`);
      try {
        await writeFile(file, f.bytes, { mode: 0o600, flag: "wx" });
        paths.push(file);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n >= 999) throw e;
      }
    }
  }
  return paths;
}

async function pruneOld(root: string, before: number): Promise<void> {
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return;
  }
  for (const d of dirs) {
    const dir = join(root, d);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const file = join(dir, n);
      try {
        const s = await stat(file);
        if (s.isFile() && s.mtimeMs < before) await rm(file, { force: true });
      } catch {
        /* gone already */
      }
    }
    // Only an empty folder goes: a picture written there meanwhile keeps it.
    await rmdir(dir).catch(() => undefined);
  }
}
