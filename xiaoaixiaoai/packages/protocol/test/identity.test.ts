import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APP_DISPLAY_NAME,
  APP_PACKAGE_ID,
  APP_SCHEME,
  LATEST_SUMS_URL,
  RELEASE_ASSET_PREFIX,
  RELEASE_MIRRORS,
  RELEASE_REPO,
  RELEASES_PAGE,
  RELEASE_UPDATES_ENABLED,
  apkAssetName,
  joinAppLink,
  pairAppLink,
  parseJoinLink,
  parsePairInput,
  parsePairLink,
  releaseAssetUrl,
  releaseSources,
  type AssistantSettings,
} from "../src/index.ts";

test("the app identity and APK names are independent of upstream", () => {
  assert.equal(APP_DISPLAY_NAME, "小爱小爱");
  assert.equal(APP_SCHEME, "xiaoaixiaoai");
  assert.equal(APP_PACKAGE_ID, "dev.notifier.xiaoaixiaoai");
  assert.equal(RELEASE_ASSET_PREFIX, "xiaoaixiaoai");
  assert.equal(apkAssetName(" v1.2.3 "), "xiaoaixiaoai-1.2.3-android-arm64.apk");
});

test("only this app's scheme is generated and accepted", () => {
  const server = "https://pocket.example.com";
  const pair = pairAppLink(server, "MEOW-0042");
  const join = joinAppLink(server, "abcdEFGH1234");
  assert.equal(pair, "xiaoaixiaoai://pair?server=https%3A%2F%2Fpocket.example.com&code=MEOW-0042");
  assert.equal(join, "xiaoaixiaoai://join?server=https%3A%2F%2Fpocket.example.com&id=abcdEFGH1234");
  assert.deepEqual(parsePairLink(pair), { server, code: "MEOW-0042" });
  assert.deepEqual(parsePairInput(`邀请链接：${pair}`), { server, code: "MEOW-0042" });
  assert.deepEqual(parseJoinLink(join), { server, id: "abcdEFGH1234" });
  assert.equal(parsePairLink(pair.replace("xiaoaixiaoai:", "herdrpocket:")), null);
  assert.equal(parsePairInput(`邀请链接：${pair.replace("xiaoaixiaoai:", "herdrpocket:")}`), null);
  assert.equal(parsePairInput("herdrpocket://pair?server=https://pocket.example.com/p/MEOW-0042&code=MEOW-0042"), null);
  assert.equal(parseJoinLink(join.replace("xiaoaixiaoai:", "herdrpocket:")), null);
});

test("an absent owned release source never produces a download or proxy URL", () => {
  assert.equal(RELEASE_UPDATES_ENABLED, false);
  assert.equal(RELEASE_REPO, null);
  assert.equal(RELEASES_PAGE, null);
  assert.equal(LATEST_SUMS_URL, null);
  assert.deepEqual(RELEASE_MIRRORS, []);
  assert.equal(releaseAssetUrl("1.2.3", apkAssetName("1.2.3")), null);
  assert.deepEqual(releaseSources(LATEST_SUMS_URL, true), []);
  assert.deepEqual(releaseSources("https://github.com/Crosery/herdr-pocket/releases/latest", false), []);
});

test("assistant display name is optional for old relays and read-only for consumers", () => {
  const legacy: AssistantSettings = { confirm: "never" };
  const named: AssistantSettings = { confirm: "always", name: "爱弥斯" };
  assert.equal(legacy.name ?? "爱弥斯", "爱弥斯");
  assert.equal(named.name, "爱弥斯");
  // Compile-time compatibility check; this helper is deliberately never called.
  const cannotEditName = (settings: AssistantSettings) => {
    // @ts-expect-error A relay-provided display name is not a client-editable setting.
    settings.name = "other";
  };
  assert.equal(typeof cannotEditName, "function");
});
