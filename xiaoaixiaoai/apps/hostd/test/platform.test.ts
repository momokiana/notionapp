import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { configDir, controlAddress, onPath, programExtensions, programName, stateDir } from "../src/platform.ts";
import { installRoot, launcherScript, runEntry } from "../src/winservice.ts";

describe("platform paths", () => {
  const win = { APPDATA: "C:\\Users\\张三\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\张三\\AppData\\Local" };

  test("settings and state folders per OS", () => {
    assert.equal(configDir({}, false, "/home/a"), "/home/a/.config/xiaoaixiaoai");
    assert.equal(stateDir({}, false, "/home/a"), "/home/a/.local/state/xiaoaixiaoai");
    assert.equal(configDir(win, true, "C:\\Users\\张三"), "C:\\Users\\张三\\AppData\\Roaming\\xiaoaixiaoai");
    assert.equal(stateDir(win, true, "C:\\Users\\张三"), "C:\\Users\\张三\\AppData\\Local\\xiaoaixiaoai");
    assert.equal(configDir({ XIAOAIXIAOAI_HOME: "/x" }, true), "/x");
  });

  test("control channel: a socket, or a named pipe per settings folder", () => {
    assert.equal(controlAddress("/home/a/.config/xiaoaixiaoai", false), "/home/a/.config/xiaoaixiaoai/hostd.sock");
    const a = controlAddress("C:\\Users\\a\\AppData\\Roaming\\xiaoaixiaoai", true);
    assert.match(a, /^\\\\\.\\pipe\\xiaoaixiaoai-hostd-[0-9a-f]{16}$/);
    // Windows paths are case-insensitive: the same folder is the same pipe.
    assert.equal(controlAddress("c:\\users\\A\\appdata\\roaming\\xiaoaixiaoai", true), a);
    assert.notEqual(controlAddress("C:\\Users\\b\\AppData\\Roaming\\xiaoaixiaoai", true), a);
    assert.match(controlAddress("C:\\x", true, "service"), /^\\\\\.\\pipe\\xiaoaixiaoai-service-/);
  });

  test("program names and extensions", () => {
    assert.equal(programName("claude.cmd"), "claude");
    assert.equal(programName("codex.EXE"), "codex");
    assert.equal(programName("claude"), "claude");
    assert.deepEqual(programExtensions({ PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1" }), [".com", ".exe", ".bat", ".cmd"]);
  });
});

describe("Windows program lookup", () => {
  const dir = mkdtempSync(join(tmpdir(), "hp-path-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("finds name.exe / name.cmd in PATH order, then extra folders", () => {
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
    writeFileSync(join(dir, "b", "claude.cmd"), "");
    writeFileSync(join(dir, "a", "codex.exe"), "");
    writeFileSync(join(dir, "b", "codex.cmd"), "");
    const env = { PATH: [join(dir, "a"), `"${join(dir, "b")}"`].join(";"), PATHEXT: ".EXE;.CMD" };
    // On Windows join() gives C:\..; elsewhere the lookup still works on the folder names.
    const sep = process.platform === "win32" ? "\\" : "/";
    const found = (n: string) => onPath(n, env, true)?.replace(/[\\/]/g, sep);
    assert.equal(found("claude"), join(dir, "b", "claude.cmd"));
    assert.equal(found("codex"), join(dir, "a", "codex.exe"));
    assert.equal(onPath("gemini", env, true), undefined);
    assert.equal(onPath("claude", env, false), undefined);
    writeFileSync(join(dir, "gemini.cmd"), "");
    assert.equal(onPath("gemini", env, true, [dir])?.replace(/[\\/]/g, sep), join(dir, "gemini.cmd"));
  });
});

describe("Windows service", () => {
  test("the install root comes from releases/<version>", () => {
    assert.equal(installRoot("C:\\Users\\a\\AppData\\Local\\Programs\\xiaoaixiaoai\\releases\\0.2.0\\"), "C:\\Users\\a\\AppData\\Local\\Programs\\xiaoaixiaoai");
    assert.equal(installRoot("/home/a/.local/share/xiaoaixiaoai/releases/0.2.0"), "/home/a/.local/share/xiaoaixiaoai");
    assert.equal(installRoot("/home/a/work/xiaoaixiaoai"), undefined);
  });

  test("the logon launcher runs the supervisor hidden, with the run options", () => {
    const js = launcherScript("C:\\Users\\张三\\node\\node.exe", "C:\\Users\\张三\\hp\\current\\apps\\hostd\\src\\cli.ts", ["--read-only"]);
    assert.match(js, /new ActiveXObject\("WScript\.Shell"\)/);
    // JSON string escapes are JScript string escapes: the path keeps its backslashes and characters.
    const run = /shell\.Run\((".*"), 0, false\);/.exec(js);
    assert.ok(run);
    assert.equal(JSON.parse(run[1]!), '"C:\\Users\\张三\\node\\node.exe" --no-warnings "C:\\Users\\张三\\hp\\current\\apps\\hostd\\src\\cli.ts" service run "--read-only"');
    assert.match(runEntry("C:\\hp\\bin\\hostd-start.js"), /wscript\.exe" \/\/B \/\/Nologo \/\/E:JScript "C:\\hp\\bin\\hostd-start\.js"$/);
  });
});
