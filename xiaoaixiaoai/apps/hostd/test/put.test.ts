import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PUT_LIMITS, textWithFiles, type Agent } from "@xiaoaixiaoai/protocol";
import { checkFiles, putLocal, putThrough, safeName, KEEP_MS } from "../src/put.ts";
import { HcAdapter } from "../src/hc.ts";
import { Host } from "../src/host.ts";

/** Owner-only modes are a macOS/Linux thing; Windows keeps the files private by folder. */
const POSIX = process.platform !== "win32";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const jpeg = (name = "IMG_0001.jpg") => ({ name, mime: "image/jpeg", data: JPEG.toString("base64") });

test("terminal.put files: pictures only, real bytes, within the limits, safe distinct names", () => {
  const ok = checkFiles([jpeg("照片 1.JPG"), { name: "../../etc/passwd.png", mime: "image/png", data: PNG.toString("base64") }, jpeg("照片 1.JPG")]);
  assert.deepEqual(
    ok.map((f) => [f.name, f.mime, f.bytes.length]),
    [
      ["1.jpg", "image/jpeg", JPEG.length],
      ["passwd.png", "image/png", PNG.length],
      ["1-2.jpg", "image/jpeg", JPEG.length],
    ],
  );
  assert.deepEqual(checkFiles([jpeg("IMG 1.jpg"), jpeg("IMG 1.jpg"), jpeg("IMG 1.jpg")]).map((f) => f.name), ["IMG-1.jpg", "IMG-1-2.jpg", "IMG-1-3.jpg"]);
  assert.equal(safeName("", "image/webp", 2), "image-3.webp");
  assert.equal(safeName("...", "image/gif", 0), "image-1.gif");
  assert.equal(safeName("Screenshot 2026-11-14 at 10.00.00.png", "image/jpeg", 0), "Screenshot-2026-11-14-at-10.00.00.jpg");

  const refuses = (files: unknown, re: RegExp) => assert.throws(() => checkFiles(files), re);
  refuses(undefined, /没有收到图片/);
  refuses([], /没有收到图片/);
  refuses(Array.from({ length: PUT_LIMITS.files + 1 }, () => jpeg()), /一次最多发 6 张/);
  refuses([{ name: "a.pdf", mime: "application/pdf", data: JPEG.toString("base64") }], /不是 JPEG、PNG、WebP 或 GIF/);
  refuses([{ name: "a.png", mime: "image/png", data: JPEG.toString("base64") }], /内容和类型对不上/);
  refuses([{ name: "a.jpg", mime: "image/jpeg", data: "not base64!" }], /内容不对/);
  refuses([{ name: "a.jpg", mime: "image/jpeg", data: "" }], /内容不对/);
  const big = Buffer.alloc(PUT_LIMITS.fileBytes + 1, 0);
  JPEG.copy(big);
  refuses([{ name: "a.jpg", mime: "image/jpeg", data: big.toString("base64") }], /太大了/);
  const two = Buffer.alloc(Math.floor(PUT_LIMITS.totalBytes / 2) + 10, 0);
  JPEG.copy(two);
  refuses([{ name: "a.jpg", mime: "image/jpeg", data: two.toString("base64") }, { name: "b.jpg", mime: "image/jpeg", data: two.toString("base64") }], /加起来太大了/);
});

test("the message names each picture on a line of its own after the text", () => {
  assert.equal(textWithFiles("  看下这个报错 ", ["/a/1.jpg", "/a/2.png"]), "看下这个报错\n/a/1.jpg\n/a/2.png");
  assert.equal(textWithFiles("", ["/a/1.jpg"]), "/a/1.jpg");
});

test("putThrough hands over an owner-only temporary copy and removes it afterwards", async () => {
  const seen: Array<{ file: string; mode: number; bytes: number }> = [];
  const paths = await putThrough(checkFiles([jpeg("a.jpg"), jpeg("b.jpg")]), async (file) => {
    seen.push({ file, mode: statSync(file).mode & 0o777, bytes: readFileSync(file).length });
    return `/landed/${basename(file)}`;
  });
  assert.deepEqual(paths, ["/landed/a.jpg", "/landed/b.jpg"]);
  assert.deepEqual(seen.map((s) => [POSIX ? s.mode : 0o600, s.bytes]), [[0o600, JPEG.length], [0o600, JPEG.length]]);
  assert.equal(statSync(dirname(seen[0]!.file), { throwIfNoEntry: false }), undefined, "temporary folder removed");

  // A failing put still cleans up.
  let tmp = "";
  await assert.rejects(
    putThrough(checkFiles([jpeg()]), async (file) => {
      tmp = file;
      throw new Error("hc put failed: no such terminal");
    }),
    /no such terminal/,
  );
  assert.equal(existsSync(tmp), false);
});

test("putLocal keeps pictures in an owner-only folder per terminal, never overwrites, drops week-old ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "hp-files-"));
  const now = Date.now();
  mkdirSync(join(root, "old"), { recursive: true });
  const stale = join(root, "old", "x.jpg");
  writeFileSync(stale, JPEG);
  utimesSync(stale, new Date(now - KEEP_MS - 60_000), new Date(now - KEEP_MS - 60_000));
  const first = await putLocal(checkFiles([jpeg("shot.jpg")]), "1/../p2", root, now);
  const again = await putLocal(checkFiles([jpeg("shot.jpg")]), "1/../p2", root, now);
  assert.equal(first[0], join(root, "1_.._p2", "shot.jpg"));
  assert.equal(again[0], join(root, "1_.._p2", "shot-2.jpg"));
  if (POSIX) {
    assert.equal(statSync(first[0]!).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(first[0]!)).mode & 0o777, 0o700);
  }
  assert.equal(existsSync(join(root, "old")), false, "old picture and its empty folder removed");
});

test("HcAdapter.put runs `hc put --json` and returns where the file landed", { skip: !POSIX && "shell-script fake" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-put-"));
  const bin = join(dir, "hc");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(join(dir, "args"))}\nprintf '{"bytes":10,"path":"/state/files/t7/a.jpg"}\\n'\n`);
  chmodSync(bin, 0o755);
  assert.equal(await new HcAdapter(bin).put("t7", "/tmp/x/a.jpg"), "/state/files/t7/a.jpg");
  assert.equal(readFileSync(join(dir, "args"), "utf8").trim(), "put --json t7 /tmp/x/a.jpg");
  writeFileSync(bin, "#!/bin/sh\necho \"error: unrecognized subcommand 'put'\" >&2\nexit 2\n");
  await assert.rejects(new HcAdapter(bin).put("t7", "/tmp/x/a.jpg"), /unrecognized subcommand/);
});

function agent(source: "hc" | "herdr"): Agent {
  return { key: `d/${source}:t1`, deviceId: "d", source, localId: "t1", harness: "claude-code", status: "idle", isShell: false, updatedAt: 1 };
}

test("terminal.put: checked pictures land beside the agent; an old hc and bad files say why; read-only refuses", async () => {
  const root = mkdtempSync(join(tmpdir(), "hp-host-files-"));
  const make = (readOnly = false) => {
    const h = new Host({ config: { server: "http://127.0.0.1:9", token: "t", deviceId: "d", name: "test" }, readOnly, log: () => {} });
    const x = h as unknown as { handlers: Record<string, (p: unknown, from: string) => Promise<any>> };
    return { h, put: (params: unknown) => x.handlers["terminal.put"]!(params, "phone") };
  };
  const { h, put } = make();
  h.agents = [agent("hc")];
  const got: string[] = [];
  h.hc.put = async (address, file) => {
    got.push(`${address} ${basename(file)}`);
    return `/state/files/${address}/${basename(file)}`;
  };
  assert.deepEqual(await put({ agent: "d/hc:t1", files: [jpeg("a.jpg"), jpeg("a.jpg")] }), { paths: ["/state/files/t1/a.jpg", "/state/files/t1/a-2.jpg"] });
  assert.deepEqual(got, ["t1 a.jpg", "t1 a-2.jpg"]);

  await assert.rejects(put({ agent: "d/hc:t1", files: [{ name: "x", mime: "text/plain", data: "aGk=" }] }), (e: any) => e.code === "bad_request" && /不是 JPEG/.test(e.message));
  await assert.rejects(put({ agent: "d/hc:t9", files: [jpeg()] }), (e: any) => e.code === "not_found");
  h.hc.put = async () => {
    throw new Error("hc put failed: error: unrecognized subcommand 'put'");
  };
  await assert.rejects(put({ agent: "d/hc:t1", files: [jpeg()] }), (e: any) => e.code === "unsupported" && /hc put/.test(e.message));

  // Agents of the herdr terminal app: this computer keeps the copy.
  h.filesDir = root;
  h.agents = [agent("herdr")];
  const { paths } = await put({ agent: "d/herdr:t1", files: [jpeg("b.jpg")] });
  assert.deepEqual(paths, [join(root, "t1", "b.jpg")]);
  assert.deepEqual(readFileSync(paths[0]!), JPEG);
  h.stop();

  const ro = make(true);
  ro.h.agents = [agent("hc")];
  await assert.rejects(ro.put({ agent: "d/hc:t1", files: [jpeg()] }), (e: any) => e.code === "forbidden");
  ro.h.stop();
});
