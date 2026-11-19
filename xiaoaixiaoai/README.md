# 小爱小爱

**爱弥斯是小爱小爱的助理。** 安卓端使用星海蓝粉主题、专用图标和星海手写标题。手机通过一次性邀请连接自己的服务，不需要在手机上登录模型账户。文字、历史和后台提醒由独立服务管理。

- [安卓 App 与构建](<apps/mobile/README.md>) · [主题、图标与字体](<apps/mobile/docs/starlight-theme.md>)
- [部署与配对](<docs/deploy/README.md>) · [DSH / Codex 项目会话](<docs/runtime-sessions.md>) · [爱弥斯的模型配置](<docs/config.md>)
- [项目维护指南](<AGENTS.md>) · [修改记录](<MODIFICATIONS.md>) · [版权与许可证](<NOTICE.md>)

## 源码与命令

| 目录 | 负责 | 安装后的命令 |
|---|---|---|
| `apps/mobile` | 安卓界面、配对和后台通知 | — |
| `apps/relay` | 自托管中转服务及爱弥斯助理 | `xiaoaixiaoai-relay` |
| `apps/hostd` | 电脑端连接器，可选 | `xiaoaixiaoai` |
| `packages/protocol`、`packages/update` | 共享协议和本地更新 | — |

在本目录安装并检查服务端代码：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
node --test scripts/test/*.test.mjs
```

安卓端是独立工作区，在 `apps/mobile` 运行 `pnpm install --frozen-lockfile --ignore-workspace` 后，可执行 `pnpm test`、`pnpm typecheck` 和 `pnpm lint`。仅发本项目自己签名的 APK；未配置自有发布源时，远程更新和配对网页下载保持关闭。

已安装的安卓身份 `dev.notifier.xiaoaixiaoai` 和配对 scheme `xiaoaixiaoai` 不随源码改名而改变。生成新部署不等于迁移已有实例，请先阅读[兼容与部署边界](<docs/deploy/README.md>)。

**修改与许可（2026-11-18）：** 本项目包含已修改的 AGPL-3.0-only 源码。[完整许可证](<LICENSE>)、[原有版权和附加许可](<NOTICE.md>)及[源码来源](<UPSTREAM.md>)随代码保留；参考资料不作为本产品的安装指引。
