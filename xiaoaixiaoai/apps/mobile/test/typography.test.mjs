import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const app = new URL("../", import.meta.url);
const local = (path) => readFile(new URL(path, app));
const asset = "assets/fonts/XiaoaiStarlightHand.ttf";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("the Android display font is a local asset with the original OFL notice", async () => {
  const { expo } = JSON.parse(await local("app.json"));
  const font = expo.plugins.find((p) => Array.isArray(p) && p[0] === "expo-font");
  assert.ok(font?.[1].fonts.includes(`./${asset}`));
  assert.ok(expo.plugins.includes("./plugins/withLegalNotices"));
  const bin = await local(asset);
  assert.equal(bin.readUInt32BE(0), 0x00010000, "TrueType sfnt");
  assert.ok(bin.length < 5_000_000, "only ship our small display subset");
  assert.equal(digest(bin), "f0fa4ae1a7b99dd62e2f5348ce814a14a380c964ac7eb2377f56ffd7cbdbd601");
  const ofl = await local("assets/fonts/XiaoaiStarlightHand-OFL.txt");
  assert.equal(digest(ofl), "86b3a0b5162848503241d80ea9a309a6459690ba7dc547940758a6a689a53b02");
});

test("only display and short labels change fonts; conversation and terminal families stay", async () => {
  const tokens = (await local("src/theme/tokens.ts")).toString();
  const root = (await local("src/app/_layout.tsx")).toString();
  assert.match(tokens, /cute: "XiaoaiStarlightHand"/);
  assert.match(tokens, /body: "Nunito_400Regular"/);
  assert.match(tokens, /mono: "MapleMono-Regular"/);
  assert.match(tokens, /monoBold: "MapleMono-Bold"/);
  assert.doesNotMatch(root, /ZCOOLKuaiLe|XiaoaiStarlightHand\.ttf/);
  assert.match((await local("src/app/pair-new.tsx")).toString(), /<Text selectable style=\{\{ fontFamily: fonts\.monoBold/);
});
