// Allow http:// relays (LAN / self-hosted without TLS). Use https in production.
const { withAndroidManifest } = require("expo/config-plugins");
module.exports = (config) =>
  withAndroidManifest(config, (c) => {
    c.modResults.manifest.application[0].$["android:usesCleartextTraffic"] = "true";
    return c;
  });
