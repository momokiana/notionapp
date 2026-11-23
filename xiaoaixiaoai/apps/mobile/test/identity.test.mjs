import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { APP_DISPLAY_NAME, APP_PACKAGE_ID, APP_SCHEME, RELEASE_REPO, RELEASES_PAGE, apkAssetName, RELEASE_UPDATES_ENABLED } from "../../../packages/protocol/src/index.ts";
import { updatesConfigured } from "../src/lib/update-policy.ts";

const appRoot = new URL("../", import.meta.url);
const text = (path) => readFile(new URL(path, appRoot), "utf8");

test("小爱小爱 has an independent Android identity matching the shared link contract", async () => {
  const { expo } = JSON.parse(await text("app.json"));
  assert.equal(expo.name, APP_DISPLAY_NAME);
  assert.equal(expo.name, "小爱小爱");
  assert.equal(expo.slug, "xiaoaixiaoai");
  assert.equal(expo.android.package, APP_PACKAGE_ID);
  assert.notEqual(expo.android.package, "dev.crosery.herdrpocket");
  assert.equal(expo.scheme, APP_SCHEME);
  assert.deepEqual(expo.android.intentFilters[0].data, [{ scheme: APP_SCHEME }]);
  const notifier = await text("modules/xiaoaixiaoai-native/android/src/main/java/dev/notifier/xiaoaixiaoai/bridge/Notifier.kt");
  assert.ok(notifier.includes(`Uri.parse("${APP_SCHEME}://$path")`));
  assert.equal(notifier.includes("herdrpocket://"), false);
  assert.ok(notifier.includes('const val ALERT_CHANNEL = "pocket_alerts_v2"'));
  assert.ok(notifier.includes("R.raw.aemeath_dingdong"));
  const sound = await readFile(new URL("modules/xiaoaixiaoai-native/android/src/main/res/raw/aemeath_dingdong.wav", appRoot));
  assert.equal(sound.subarray(0, 4).toString(), "RIFF");
  assert.equal(sound.subarray(8, 12).toString(), "WAVE");
  assert.equal(apkAssetName("0.1.0"), "xiaoaixiaoai-0.1.0-android-arm64.apk");
});

test("the app icon and assistant portrait are derived from the chosen artwork, not upstream mascot assets", async () => {
  const { expo } = JSON.parse(await text("app.json"));
  const adaptive = expo.android.adaptiveIcon;
  for (const [path, size] of [
    [expo.icon, 1024], [adaptive.foregroundImage, 1024], [adaptive.backgroundImage, 1024],
    ["assets/brand/aimisi-avatar.png", 512],
  ]) {
    const png = await readFile(new URL(path, appRoot));
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  const mascot = await text("src/components/Mascot.tsx");
  const voice = await text("src/components/VoiceOrb.tsx");
  assert.ok(mascot.includes("assets/brand/aimisi-avatar.png"));
  assert.equal(mascot.includes('require("../../assets/mascot/'), false);
  assert.equal(voice.includes('require("../../assets/mascot/'), false);
  assert.ok((await text("assets/brand/USER-ARTWORK.md")).includes("KURO GAMES"));
});

test("updates point exclusively to the owned repository and reject upstream or mismatched policies", () => {
  assert.equal(RELEASE_UPDATES_ENABLED, true);
  assert.equal(RELEASE_REPO, "momokiana/notionapp");
  assert.equal(RELEASES_PAGE, "https://github.com/momokiana/notionapp/releases/latest");
  assert.equal(updatesConfigured({ enabled: true, repository: RELEASE_REPO, page: RELEASES_PAGE }), true);
  assert.equal(updatesConfigured({ enabled: false, repository: "example/own-app", page: "https://github.com/example/own-app/releases/latest" }), false);
  assert.equal(updatesConfigured({ enabled: true, repository: null, page: null }), false);
  assert.equal(updatesConfigured({ enabled: true, repository: "Crosery/herdr-pocket", page: "https://github.com/Crosery/herdr-pocket/releases/latest" }), false);
  assert.equal(updatesConfigured({ enabled: true, repository: "example/own-app", page: "https://unrelated.invalid" }), false);
  assert.equal(updatesConfigured({ enabled: true, repository: "example/own-app", page: "https://github.com/example/own-app/releases/latest" }), true);
});

test("all mobile updater entry points reject disabled updates before reading cached releases or invoking native installation", async () => {
  const source = await text("src/lib/update.ts");
  for (const name of ["checkForUpdate", "downloadUpdate", "installUpdate", "resumeInstallIfAllowed"]) {
    const start = source.indexOf(`export ${["checkForUpdate", "downloadUpdate"].includes(name) ? "async " : ""}function ${name}(`);
    assert.ok(start >= 0, name);
    const body = source.slice(source.indexOf("{", start) + 1).trimStart();
    assert.ok(body.startsWith("if (applyDisabledPolicy()) return;"), `${name} must gate cached data and native calls`);
  }
  assert.ok(source.includes("updateRelease: null, updatePrompted: null, updateCheckedAt: 0"));
  assert.equal(source.includes("/^herdr-pocket-"), false);
});
