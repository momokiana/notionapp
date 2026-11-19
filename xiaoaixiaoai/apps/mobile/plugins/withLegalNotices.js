// Keep license notices in the APK without adding credits to the product UI.
const { copyFile, mkdir } = require("node:fs/promises");
const { join } = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

module.exports = (config) => withDangerousMod(config, ["android", async (c) => {
  if (c.modRequest.introspect) return c;
  const app = c.modRequest.projectRoot;
  const root = join(app, "..", "..");
  const assets = join(c.modRequest.platformProjectRoot, "app", "src", "main", "assets", "licenses");
  await mkdir(assets, { recursive: true });
  const fontNotice = "XiaoaiStarlightHand-OFL.txt";
  await Promise.all([
    copyFile(join(app, "assets", "fonts", fontNotice), join(assets, fontNotice)),
    copyFile(join(root, "LICENSE"), join(assets, "AGPL-3.0.txt")),
    copyFile(join(root, "NOTICE.md"), join(assets, "NOTICE.md")),
  ]);
  return c;
}]);
