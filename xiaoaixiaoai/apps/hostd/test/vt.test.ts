import { test } from "node:test";
import assert from "node:assert/strict";
import { Screen, charWidth, sgrOnly } from "../src/vt.ts";

test("screen model: plain lines, colors and trailing trim", () => {
  const s = new Screen(20, 5);
  s.write("\x1b[?1049l\x1b[H\x1b[2Jhello \x1b[38;2;88;132;88mworld\x1b[0m   \r\nsecond");
  assert.equal(s.toText(), "hello world\nsecond");
  assert.equal(s.toAnsi(), "hello \x1b[0;38;2;88;132;88mworld\x1b[0m\nsecond");
});

test("screen model: cursor redraws overwrite in place (full-screen TUIs)", () => {
  const s = new Screen(30, 4);
  s.write("\x1b[H\x1b[2J\x1b[3;1H✳ Thinking…\x1b[1;1Htop");
  s.write("\x1b[H\r\x1b[2B\x1b[38;5;208m✢\x1b[3G\x1b[1mGerminating…\x1b[0m\x1b[K");
  assert.equal(s.toText(), "top\n\n✢ Germinating…");
  assert.match(s.toAnsi(), /\x1b\[0;38;5;208m✢/);
  assert.match(s.toAnsi(), /\x1b\[0;1;38;5;208mGerminating…/);
});

test("screen model: wide CJK takes two cells and wraps at the edge", () => {
  assert.equal(charWidth("中".codePointAt(0)!), 2);
  assert.equal(charWidth("a".codePointAt(0)!), 1);
  const s = new Screen(5, 3);
  s.write("中文字");
  assert.equal(s.toText(), "中文\n字");
});

test("screen model: scrolled lines become history, alt screen does not", () => {
  const s = new Screen(10, 2);
  s.write("a\r\nb\r\nc\r\nd");
  assert.equal(s.toText(10), "a\nb\nc\nd");
  assert.equal(s.toText(0), "c\nd");
  s.write("\x1b[?1049h\x1b[Hfull\r\nscreen\r\nmore");
  assert.equal(s.toText(0), "screen\nmore");
  s.write("\x1b[?1049l");
  assert.equal(s.toText(0), "c\nd");
});

test("screen model: split escape sequences across writes", () => {
  const s = new Screen(10, 2);
  s.write("x\x1b[3");
  s.write("1mred\x1b]0;title\x07");
  assert.equal(s.toAnsi(), "x\x1b[0;31mred\x1b[0m");
});

test("sgrOnly keeps colors and drops cursor/OSC escapes", () => {
  assert.equal(sgrOnly("\x1b[?25l\x1b]0;t\x07\x1b[1;31mhi\x1b[0m\x1b[K\r\n"), "\x1b[1;31mhi\x1b[0m\n");
});
