// Metro: resolve the shared wire contract from the monorepo without a workspace install.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const protocolDir = path.resolve(projectRoot, "../../packages/protocol");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [...(config.watchFolders ?? []), protocolDir];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  "@xiaoaixiaoai/protocol": path.join(protocolDir, "src/index.ts"),
};
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "@xiaoaixiaoai/protocol") {
    return { type: "sourceFile", filePath: path.join(protocolDir, "src/index.ts") };
  }
  return upstream ? upstream(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
};
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

module.exports = config;
