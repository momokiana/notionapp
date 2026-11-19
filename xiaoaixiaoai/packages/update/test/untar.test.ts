import { strict as assert } from "node:assert";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { gzipSync } from "node:zlib";
import { extractTar, extractTarGz, readTar, tarVersion } from "../src/untar.ts";

/** One 512-byte header (ustar) with the checksum filled in. */
function header(name: string, o: { size?: number; type?: string; link?: string; mode?: number; prefix?: string } = {}): Buffer {
  const h = Buffer.alloc(512);
  const put = (s: string, at: number, len: number) => h.write(s.slice(0, len), at, len, "utf8");
  const num = (n: number, at: number, len: number) => put(`${n.toString(8).padStart(len - 1, "0")}\0`, at, len);
  put(name, 0, 100);
  num(o.mode ?? 0o644, 100, 8);
  num(0, 108, 8);
  num(0, 116, 8);
  num(o.size ?? 0, 124, 12);
  num(0, 136, 12);
  put(o.type ?? "0", 156, 1);
  put(o.link ?? "", 157, 100);
  put("ustar\x0000", 257, 8);
  if (o.prefix) put(o.prefix, 345, 155);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
const file = (name: string, body: string, mode?: number) => [header(name, { size: Buffer.byteLength(body), mode }), pad(Buffer.from(body))];
/** GNU long name: an `L` entry carrying the name of the next one. */
const gnuLong = (name: string) => [header("././@LongLink", { type: "L", size: name.length + 1 }), pad(Buffer.from(`${name}\0`))];
/** pax header with a path record. */
function paxPath(path: string): Buffer[] {
  let rec = ` path=${path}\n`;
  let len = rec.length;
  while (`${len}${rec}`.length !== len) len = `${len}${rec}`.length;
  rec = `${len}${rec}`;
  return [header("PaxHeader", { type: "x", size: rec.length }), pad(Buffer.from(rec))];
}
const tar = (...parts: Buffer[][]) => Buffer.concat([...parts.flat(), Buffer.alloc(1024)]);

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "hp-untar-"));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const long = `pkg-1.0.0/node_modules/.pnpm/is-fullwidth-code-point@3.0.0/node_modules/is-fullwidth-code-point/${"x".repeat(40)}.js`;
const sample = () =>
  tar(
    [header("pkg-1.0.0/", { type: "5", mode: 0o755 })],
    file("pkg-1.0.0/package.json", JSON.stringify({ version: "1.0.0" })),
    file("pkg-1.0.0/packages/protocol/index.js", "export const x = 1;\n"),
    file("pkg-1.0.0/scripts/run.sh", "#!/bin/sh\n", 0o755),
    gnuLong(long),
    file(long.slice(0, 99), "long gnu\n"),
    paxPath("pkg-1.0.0/deep/pax/name.txt"),
    file("ignored-by-pax.txt", "pax\n"),
    [header("protocol", { type: "2", link: "../../../../packages/protocol", prefix: "pkg-1.0.0/apps/hostd/node_modules/@xiaoaixiaoai" })],
    [header("pkg-1.0.0/apps/mobile/app.json", { size: 2 })],
    [pad(Buffer.from("{}"))],
  );

describe("untar", () => {
  test("reads ustar, GNU long names and pax paths", () => {
    const names = readTar(sample()).map((e) => e.name);
    assert.ok(names.includes(long));
    assert.ok(names.includes("pkg-1.0.0/deep/pax/name.txt"));
    assert.ok(names.includes("pkg-1.0.0/apps/hostd/node_modules/@xiaoaixiaoai/protocol"));
    assert.ok(!names.includes("ignored-by-pax.txt"));
  });

  test("unpacks with strip and exclude; folder links work", () => {
    const dest = temp();
    extractTar(sample(), dest, { strip: 1, exclude: ["apps/mobile"] });
    assert.equal(readFileSync(join(dest, "deep/pax/name.txt"), "utf8"), "pax\n");
    assert.equal(readFileSync(join(dest, long.slice("pkg-1.0.0/".length)), "utf8"), "long gnu\n");
    const link = join(dest, "apps/hostd/node_modules/@xiaoaixiaoai/protocol");
    assert.ok(lstatSync(link).isSymbolicLink(), "a symlink, or a junction on Windows");
    assert.equal(readFileSync(join(link, "index.js"), "utf8"), "export const x = 1;\n");
    assert.ok(!existsSync(join(dest, "apps/mobile")));
    if (process.platform !== "win32") assert.equal(statSync(join(dest, "scripts/run.sh")).mode & 0o111, 0o111);
  });

  test("junctions: links become absolute folder links", { skip: process.platform !== "win32" && "Windows only" }, () => {
    const dest = temp();
    extractTar(sample(), dest, { strip: 1, junctions: true });
    assert.equal(readFileSync(join(dest, "apps/hostd/node_modules/@xiaoaixiaoai/protocol/index.js"), "utf8"), "export const x = 1;\n");
  });

  test("refuses paths and links that leave the folder", () => {
    assert.throws(() => extractTar(tar(file("pkg/../../evil.txt", "x")), temp(), { strip: 1 }), /unsafe path/);
    assert.throws(() => extractTar(tar([header("pkg/out", { type: "2", link: "../../.." })]), temp(), { strip: 1 }), /outside the archive/);
  });

  test("version of a .tar.gz bundle", () => {
    const dir = temp();
    const gz = join(dir, "pkg-1.0.0.tar.gz");
    writeFileSync(gz, gzipSync(sample()));
    assert.equal(tarVersion(gz), "1.0.0");
    extractTarGz(gz, join(dir, "out"), { strip: 1 });
    assert.ok(existsSync(join(dir, "out/package.json")));
  });
});
