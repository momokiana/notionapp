# 小爱小爱

> **主工程位于 [xiaoaixiaoai/](<xiaoaixiaoai/README.md>)**。爱弥斯是小爱小爱的助理。安卓端、自托管中转服务和可选电脑端均在 `xiaoaixiaoai/` 下开发与构建。
>
> `notionapp` 是历史仓库名，本项目与 Notion 没有集成或隶属关系。早期原型目录（`android/`、`web/`、`server/`、`pi-host/`、`pocket/`、`legacy/`）已于仓库整理时从 `main` 移除。

## 项目概览

面向个人自托管的安卓端 AI 助理与电脑端项目会话（DSH / Codex）管理工具：

- **安卓端**（`xiaoaixiaoai/apps/mobile`）：Expo Android 应用，通过一次性邀请码配对自有中转服务，支持与爱弥斯文字对话、历史恢复、后台定时提醒、DSH 项目会话目录查看、任务发送与后台任务通知。
- **自托管中转服务**（`xiaoaixiaoai/apps/relay`）：管理设备配对、爱弥斯助理对话、模型接入与私密通知投递。
- **可选电脑端连接器**（`xiaoaixiaoai/apps/hostd`）：按需连接本机 DSH / Codex / Herdr 会话，支持只读目录、profile 级授权发送、本地代理隧道和任务事件上报。
- **共享包**（`xiaoaixiaoai/packages/protocol`、`xiaoaixiaoai/packages/update`）：通信协议定义与本地更新逻辑。

## 快速入口

- [主工程说明与构建命令](<xiaoaixiaoai/README.md>)
- [当前状态与进度](<docs/status.md>)
- [修改记录（0.1.0 – 0.1.9）](<xiaoaixiaoai/MODIFICATIONS.md>)
- [DSH / Codex 项目会话说明](<xiaoaixiaoai/docs/runtime-sessions.md>)
- [首版交付与验收](<docs/migrations/2026-11-17-xiaoaixiaoai-first-use.md>) · [0.1.0 真机验收记录](<docs/xiaoaixiaoai-phone-check.md>)

## 版权与许可证

主工程基于修改后的 AGPL-3.0-only 源码构建，详见 [LICENSE](<xiaoaixiaoai/LICENSE>)、[NOTICE.md](<xiaoaixiaoai/NOTICE.md>) 与 [UPSTREAM.md](<xiaoaixiaoai/UPSTREAM.md>)。本仓库不包含任何私人部署配置、服务器地址、账号凭据、签名密钥、真实聊天数据或构建产物。
