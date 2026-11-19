// Build settings kept in app.json rather than in the generated android/ folder:
// - animated WebP (the moving mascot) needs Fresco's animated-webp decoder;
// - phones are arm64: shipping only arm64-v8a cuts the APK by roughly 75 MB
//   (the 32-bit and x86 copies of every native library). The emulator image
//   used for checks (sdk_gphone64_arm64) is arm64 too.
// - versionCode follows expo.version (1.2.3 -> 1002003, the release workflow's
//   scheme) unless android.versionCode is set, so in-app updates always go up.
const { withGradleProperties } = require("expo/config-plugins");

const SET = {
  "expo.webp.animated": "true",
  reactNativeArchitectures: "arm64-v8a",
};

function versionCodeOf(version) {
  const [major = 0, minor = 0, patch = 0] = String(version ?? "0.0.0")
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .map((x) => Number.parseInt(x, 10) || 0);
  return Math.max(1, major * 1000000 + minor * 1000 + patch);
}

module.exports = (config) => {
  config.android = config.android ?? {};
  if (config.android.versionCode == null) config.android.versionCode = versionCodeOf(config.version);
  return withGradleProperties(config, (c) => {
    for (const [key, value] of Object.entries(SET)) {
      const item = c.modResults.find((p) => p.type === "property" && p.key === key);
      if (item) item.value = value;
      else c.modResults.push({ type: "property", key, value });
    }
    return c;
  });
};
