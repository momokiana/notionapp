# 小爱小爱：部署与配对

这是小爱小爱的**新安装**指引。安装器仅接收自己审查的本地源码或部署包；未配置自有发布源时，不拉取或安装上游产品，也不自动更新。

## 本地准备

1. 在主工程目录用 `pnpm install --frozen-lockfile --ignore-scripts` 安装锁定依赖。
2. 运行 `scripts/pack-release.sh <private-output-directory>`，得到 `xiaoaixiaoai-<version>.tar.gz`。先检查自检结果和产物，再把它传给你自己的服务器。此步骤不部署。
3. 仅在新环境安装。已有部署先备份，检查端口、服务用户、单位名、自己的 HTTPS 入口；不要覆盖其他服务或直接执行历史部署脚本。

## 新服务器

Linux 主机的示例（把路径、端口和公开地址换成自己的）。先确认没有同名的 `xiaoaixiaoai-relay.service`，由管理员检查后执行：

```sh
sudo bash scripts/install-relay.sh --native --source /path/to/xiaoaixiaoai-release.tar.gz \
  --dir /opt/xiaoaixiaoai --port 7420 --public-url https://xiaoaixiaoai.example.com
```

此示例不负责配置 HTTPS；用自己管理的反代转接 WebSocket 与 HTTP，按实际防火墙和监听范围调整，切勿把内部服务当成公网 HTTP。默认独立数据目录 `/var/lib/xiaoaixiaoai`、配置 `/etc/xiaoaixiaoai/relay.env`，命令 `xiaoaixiaoai-relay setup` 显示首台设备的私有一次性邀请。生产部署及重启需单独授权。

容器只用自己的镜像。先在受控环境构建并预载审核过的镜像，再给 [Compose 模板](<../../deploy/docker/compose.yml>)显式设 `POCKET_IMAGE`。配置不会回退到上游镜像。Fly、Kubernetes 和 Render 模板也须换成你自己的镜像及入口，不能拿占位配置直接上线。

## 手机和可选电脑端

- 手机打开小爱小爱扫码配对，邀请只交给自己的设备。没有自有下载源时，配对页不会提供安装包；请使用自有签名版本。
- 仅聊天和提醒不需要电脑端。需接电脑时，用 `bash scripts/install-host.sh --source /path/to/xiaoaixiaoai-release.tar.gz --server https://xiaoaixiaoai.example.com`（macOS/Linux）或用同目录 PowerShell 脚本的 `-From`、`-Server` 参数。命令名 `xiaoaixiaoai`，配置默认 `~/.config/xiaoaixiaoai/hostd.json` 或 `%APPDATA%\xiaoaixiaoai\hostd.json`，不读取或移动原有应用的电脑配置。只有已授权的电脑才能配对；可使用 `--read-only` 限制电脑端操作。
- [接入 DSH / Codex 项目会话](<../runtime-sessions.md>)由各自所在电脑的本机程序负责。无须开放 DSH 或 Codex 的接口到公网。
- 开启[模型功能](<../config.md>)由服务端另行配置，勿把密钥写入源码或下发手机。

## 已安装版本与兼容

源码与命令改名不意味着已部署文件、数据库和授权会自动迁移。不同名称的 Compose 项目使用不同数据卷，安装器会拒绝覆盖不同项目的配置；不要因此去停止或删除旧容器，迁移须先备份并单独计划。保留现有安卓 `applicationId`、签名、深链、SecureStore/设置键和 Android 通知频道 ID；已有配对不应因同签名覆盖而丢失。没有进行任何线上迁移。原有端点、服务和旧安装包未由本次更名改写。
