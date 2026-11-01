# notionapp（开发中）

> **FINAL BLOCK（F1–F3）：本分支的连接器候选 A 已被最终独审阻塞，不应使用或合入 main。** 发现并发 flush 迟到 ACK 状态回退、Node 22.13 正常 close 漏句柄、fstat 后文件增长导致无界读取；见 [BLOCK 记录](docs/releases/connectors-candidate-a.md)。保留 `wip/connectors-candidate-a` 及原代码供追溯；新后端正常集成仍未执行，未导入修复候选 B。

面向个人自托管的轻量通知与交互 App：程序或 AI 助理发出事件，手机展示卡片，用户通过按钮或文字回应，来源的后续进展回到同一事件。

`notionapp` 是仓库名，产品名尚未确定；本项目与 Notion 没有集成或隶属关系。

## 范围与现状

- 安卓首发：Kotlin / Jetpack Compose；事件服务：Fastify / TypeScript / SQLite。
- 可选独立 Pi SDK 宿主；可选自托管 ntfy / UnifiedPush 通知，不默认连接 AI、推送服务器或现有工作会话。
- 公开的是既有开发基线，不是正式发行、生产可用声明或完整产品验收；不含后续 T014 受控启用、android-001 草稿/模板；本候选分支的连接器已标为 FINAL BLOCK、待新后端集成，不是可用交付。
- 本仓库不包含私人部署、账号、人格、原始聊天、设备/原生会话标识、运行数据库或原始验收证据。

已读 ≠ 平台接受 ≠ 设备收到 ≠ 系统请求提醒 ≠ 来源收件 ≠ 已执行 ≠ 完成或独立验收。

## 构建入口

已按冻结白名单导入 [服务端](server/README.md)、[安卓](android/README.md) 和 [可选 Pi 宿主](pi-host/README.md) 源码、合成测试及依赖锁；各次导入与验证边界见 [公开状态](docs/status.md)，准确文件及前后哈希见 [导出清单](docs/releases/initial-export.json)。

```sh
# Node.js 22 LTS（Pi 宿主要求 >=22.19）与 npm 10+
npm --prefix server ci
npm --prefix server run check
npm --prefix pi-host ci --ignore-scripts
npm --prefix pi-host run check

# JDK 17、Android SDK 35 / build-tools 35.0.0
cd android
./gradlew app:testDebugUnitTest app:assembleDebug app:lintDebug
```

后端本地开发：`cd server && npm run dev`，默认只监听 `127.0.0.1:3000`。`/health` 只检查存储健康；没有私有认证配置时受保护接口拒绝。没有默认凭据。不得把健康检查当作事件、回复、后台推送或生产验收。

## 文档

- [需求与边界](docs/requirements.md)
- [架构与安全语义](docs/architecture.md)
- [公开状态、验证与排除项](docs/status.md)

## 许可证

目标是开源、可自托管；产品许可证尚未选择，目前没有授予通用开源使用许可的 LICENSE。[第三方依赖](THIRD_PARTY_NOTICES.md) 仍遵守各自许可证，本项目不随依赖许可自动选择产品许可证。
