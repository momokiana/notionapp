# 更新与发布

## 版本号

整个项目只有一个版本号：根目录 `package.json` 的 `version`。中转服务（`/v1/health` 里的 `version`）和电脑端（`herdr-pocket version`）都从这里读。发布时 `scripts/set-version.mjs` 把它同步到各个包和 Android App 的 `app.json`（`version`）；App 的构建插件再由它算出 `versionCode = 主版本×1000000 + 次版本×1000 + 修订号`（例如 1.2.3 → 1002003），保证每次更新的 versionCode 都更大。

## 一次发布里有什么

打 `vX.Y.Z` 标签后，`.github/workflows/release.yml` 生成 GitHub Release：

| 文件 | 用途 |
|---|---|
| `herdr-pocket-X.Y.Z.tar.gz` | 中转服务 + 电脑端的发布包，已带生产依赖，不分系统和 CPU。安装脚本和 `update` 用它 |
| `herdr-pocket-X.Y.Z-android-arm64.apk` | Android App。App 内更新用它 |
| `SHA256SUMS` | 上面两个文件的 SHA256，安装脚本和 `update` 下载后都会核对 |

同时推送镜像 `ghcr.io/<owner>/herdr-pocket-relay:X.Y.Z`、`:X.Y` 和 `:latest`（amd64 + arm64）。带 `-rc.1` 这类后缀的标签发布为预发布，不打 `latest`，也不会被 `update` 选中。

## 各部分怎么更新

| 部分 | 命令 | 做了什么 |
|---|---|---|
| 电脑端 | `herdr-pocket update` | 查 GitHub 最新 Release → 下载发布包并核对 SHA256 → 解压到 `releases/<版本>` → 试启动一次 → 切换 `current` → 重启 launchd / systemd 服务。`--rollback` 退回上一个版本 |
| 中转服务（Node + systemd） | `sudo herdr-pocket-relay update` | 同上，重启 `herdr-pocket-relay.service` |
| 中转服务（Docker） | `sudo herdr-pocket-relay update` | `docker compose pull && docker compose up -d`，数据卷保留 |
| Fly.io / 其他平台 | 重新部署 | 重新拉 `latest` 镜像 |
| 手机 App | App 内提示 | 下载 APK 安装 |

说明：

- `update` 只会重启属于这份安装的服务（服务文件里写着这个安装目录）；别的方式装的不会碰，只提示你自己重启。
- 只保留当前和上一个版本，更早的自动删掉。
- 发布包缺失时（比如手动建的 Release），`update` 退回到 GitHub 的源码包，这时需要本机有 pnpm。
- 想从自己的 fork 更新：`HERDR_POCKET_REPO=<owner>/<repo> herdr-pocket update`；安装脚本同样认这个变量。
- 查询 GitHub 有频率限制（未登录每小时 60 次），设置 `GITHUB_TOKEN` 可以放宽。

### 中国大陆

在中国大陆直连 GitHub 很慢或者连不上（2026-11 实测：直连下载 APK 约 100 KB/s，`herdr-pocket update` 直连失败），所以按设备时区判断，时区是中国大陆的（`Asia/Shanghai` 等；Windows 是“China Standard Time”）就先走镜像：

- 发布文件（版本信息、发布包、APK）：先试 `ghfast.top`、`gh-proxy.com`，最后才直连 GitHub。其他地区反过来，直连失败才用镜像。
- 版本信息读的是最新 Release 的 `SHA256SUMS`。镜像能转发这个文件，但转发不了 GitHub API。
- 安装脚本要下载 Node 时，校验值总是取自 nodejs.org，Node 安装包本身先从 `npmmirror.com` 下载。
- 不管从哪里下载，都会核对 `SHA256SUMS`。手机端 Android 还会检查签名，只接受同一把密钥签名的更新包。
- 服务器时区常常是 UTC：设 `HERDR_POCKET_MIRROR=1` 强制先走镜像，设成 `0` 则不用镜像。电脑端、中转服务和安装脚本都认这个变量。
- 手机 App 只看手机的时区。这套逻辑从 0.1.4 起才有，0.1.3 及以前的 App 还是直连 GitHub。

## 发布步骤

```sh
node scripts/set-version.mjs 0.2.0      # 改版本号并提交
git commit -am "release 0.2.0" && git tag v0.2.0 && git push && git push --tags
```

工作流会再按标签盖一次版本号，所以即使忘了第一步，构建出来的东西版本也是对的；但仓库里的版本号会落后，建议照做。已经存在的标签可以在 Actions 里手动运行 Release 重新构建（`workflow_dispatch`，填标签），文件会覆盖上传。

## Android 签名

本地构建和 CI 用同一把密钥、同一种方式签名：Gradle 的 `-Pandroid.injected.signing.*` 参数。密钥只生成一次，放在仓库外面。

### 1. 生成自己的密钥（fork 也一样）

```sh
keytool -genkeypair -v -keystore /path/to/herdr-pocket-release.jks \
  -alias herdr-pocket -keyalg RSA -keysize 4096 -validity 10000
```

`keytool` 会交互地问密码，密码不会留在 shell 历史里。把 keystore 文件放在仓库以外的位置，密码存进系统钥匙串或密码管理器。默认的 PKCS12 格式里密钥密码和 keystore 密码是同一个。

### 2. 本地签名构建

```sh
cd apps/mobile
pnpm install --ignore-workspace
pnpm exec expo prebuild --platform android --no-install   # android/ 不进仓库，第一次和改了 app.json 后要跑
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a -Pexpo.webp.animated=true \
  -Pandroid.injected.signing.store.file=/path/to/herdr-pocket-release.jks \
  -Pandroid.injected.signing.store.password="$ANDROID_KEYSTORE_PASSWORD" \
  -Pandroid.injected.signing.key.alias=herdr-pocket \
  -Pandroid.injected.signing.key.password="$ANDROID_KEYSTORE_PASSWORD"
```

密码从环境变量取，不要直接写在命令里。macOS 上可以先从钥匙串读出来，例如 `export ANDROID_KEYSTORE_PASSWORD=$(security find-generic-password -s <钥匙串条目名> -w)`。产物在 `app/build/outputs/apk/release/app-release.apk`。不带这四个参数时，APK 用 debug 密钥签名。

核对签名：`apksigner verify --print-certs app-release.apk`。本地包和 CI 包的 `SHA-256` 指纹应该一样。

### 3. CI 用的四个 Secret

在 GitHub 仓库 Settings → Secrets and variables → Actions 里加：

| Secret | 内容 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | keystore 文件的 base64：macOS `base64 -i /path/to/herdr-pocket-release.jks`，Linux `base64 -w0 /path/to/herdr-pocket-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 密钥别名（上面例子里是 `herdr-pocket`） |
| `ANDROID_KEY_PASSWORD` | 密钥密码；和 keystore 密码相同可不填 |

`release.yml` 把 keystore 解码到 runner 的临时目录，再用上面同样的 `-Pandroid.injected.signing.*` 参数构建。每次构建的签名证书指纹会写在工作流的 Summary 里。

没配这些 Secret 时，APK 用公开的 debug 密钥签名，工作流会给出警告。这样的包可以拿来测试，但任何人都能用同一个密钥签出“更新”，不要发给用户。

### 密钥丢了就不能原地更新

Android 只接受和已装 App 签名相同的更新。keystore 文件或密码一旦丢失，所有已经装上的 App 都没法再覆盖更新（包括 App 内更新），只能卸载重装，卸载后要重新配对。所以 keystore 和密码至少要另外备份一份，也放在仓库以外。

同理，换签名就要卸载重装：从 debug 签名的测试包换到正式签名的包，需要卸载重装一次。fork 如果没改包名，用自己的密钥签出的 APK 不能覆盖安装官方签名的 App，反过来也不行。

## CI

`.github/workflows/ci.yml` 在推送到 main 和每个 PR 上运行：安装依赖、类型检查、relay / hostd / update 测试、shellcheck 检查安装脚本、打一次发布包、Android App 类型检查、构建一次中转服务镜像（不推送）。
