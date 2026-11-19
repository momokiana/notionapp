// Keep signing policy in the Expo source, not in generated android/ files.
// Secrets are read by Gradle at build time, never added to expoConfig/the JS bundle.
const { withAppBuildGradle } = require("expo/config-plugins");

const MARKER = "// 小爱小爱 owned release signing";
const GRADLE = `
${MARKER}
def xiaoaiSigningValue = { envName, propertyName ->
    System.getenv(envName) ?: findProperty(propertyName)?.toString()
}
def xiaoaiSigning = [
    storeFile: xiaoaiSigningValue('XIAOAI_SIGNING_STORE', 'android.injected.signing.store.file'),
    storePassword: xiaoaiSigningValue('XIAOAI_SIGNING_STORE_PASSWORD', 'android.injected.signing.store.password'),
    keyAlias: xiaoaiSigningValue('XIAOAI_SIGNING_KEY_ALIAS', 'android.injected.signing.key.alias'),
    keyPassword: xiaoaiSigningValue('XIAOAI_SIGNING_KEY_PASSWORD', 'android.injected.signing.key.password')
]
def xiaoaiSigningComplete = xiaoaiSigning.values().every { it != null && !it.isEmpty() }
// Expo's default template signs release with its public debug key. Never retain that fallback.
android.buildTypes.release.signingConfig = null
if (xiaoaiSigningComplete) {
    android.signingConfigs {
        xiaoaixiaoaiRelease {
            storeFile file(xiaoaiSigning.storeFile)
            storePassword xiaoaiSigning.storePassword
            keyAlias xiaoaiSigning.keyAlias
            keyPassword xiaoaiSigning.keyPassword
        }
    }
    android.buildTypes.release.signingConfig = android.signingConfigs.xiaoaixiaoaiRelease
} else {
    gradle.taskGraph.whenReady { graph ->
        if (graph.allTasks.any { it.project == project && it.name.toLowerCase().contains('release') }) {
            throw new GradleException('小爱小爱 release signing is not configured; public debug signing is forbidden.')
        }
    }
}
`;

module.exports = (config) => withAppBuildGradle(config, (c) => {
  if (c.modResults.language !== "groovy") throw new Error("小爱小爱 signing plugin requires the generated Groovy build.gradle");
  if (!c.modResults.contents.includes(MARKER)) c.modResults.contents += GRADLE;
  return c;
});
