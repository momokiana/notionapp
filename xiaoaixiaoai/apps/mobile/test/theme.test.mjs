import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makePalette } from "../src/theme/palette.ts";

function luminance(hex) {
  assert.match(hex, /^#[a-f\d]{6}$/i);
  const [r, g, b] = hex.slice(1).match(/.{2}/g).map((v) => {
    const s = Number.parseInt(v, 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function checkContrast(p, fg, bg, minimum) {
  const a = luminance(p[fg]);
  const b = luminance(p[bg]);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  assert.ok(ratio >= minimum, `${fg} on ${bg}: ${ratio.toFixed(2)}:1, need ${minimum}:1`);
}

for (const dark of [false, true]) {
  test(`starlight ${dark ? "dark" : "light"} text and action contrast`, () => {
    const p = makePalette(dark);
    for (const fg of ["ink", "muted", "faint"]) {
      for (const bg of ["pageTop", "page", "pageBottom", "surface", "surface2", "surface3"]) checkContrast(p, fg, bg, 4.5);
    }
    for (const [fg, bg] of [
      ["ink", "reply"], ["ink", "bubble"], ["ink", "skyContainer"], ["ink", "accentContainer"],
      ["muted", "reply"], ["muted", "bubble"], ["muted", "skyContainer"], ["muted", "accentContainer"],
      ["onPrimary", "primary"], ["onPrimary", "primaryPressed"], ["skyText", "skyContainer"],
      ["skyText", "reply"], ["skyText", "surface3"], ["accentText", "accentContainer"], ["accentText", "surface3"],
      ["accentText", "glass"], ["accentText", "skyContainer"], ["onLavender", "lavenderContainer"],
      ["error", "errorContainer"], ["error", "surface3"], ["dusk", "duskContainer"],
    ]) checkContrast(p, fg, bg, 4.5);
    checkContrast(p, "outline", "surface2", 3);
    assert.notEqual(p.reply, p.bubble);
  });
}

test("native startup colors match the themed sky in both modes", async () => {
  const { expo } = JSON.parse(await readFile(new URL("../app.json", import.meta.url), "utf8"));
  const splash = expo.plugins.find((p) => Array.isArray(p) && p[0] === "expo-splash-screen")[1];
  assert.equal(splash.backgroundColor, makePalette(false).pageTop);
  assert.equal(splash.dark.backgroundColor, makePalette(true).pageTop);
  assert.equal(expo.backgroundColor, makePalette(false).pageTop);
  assert.equal(expo.android.adaptiveIcon.backgroundColor, makePalette(false).pageTop);
});
