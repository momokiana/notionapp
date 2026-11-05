# notionapp（开发中）

> 当前为独立分支 `wip/connectors-004`：[004-B显式v2/完整归档/持久有界扩容限定FINAL PASS](docs/releases/connectors-004.md)。004-A仍BLOCK/F1，B仅保守拒绝缺main的孤存储组；旧003及更早结论不倒改。**backend自身FINAL未知，未合main，不作联合/正式Release。** 双Node严格daemon消费真v2/archive，但发布接收器仍HTTP夹具，不是backend/native receipt；N1不变，无运行资料、标记、工具或原始证据入库。

面向个人自托管的轻量通知与交互 App：程序或 AI 助理发出事件，手机展示卡片，用户通过按钮或文字回应，来源的后续进展回到同一事件。

`notionapp` 是仓库名，产品名尚未确定；本项目与 Notion 没有集成或隶属关系。

## 范围与现状

- 安卓首发：Kotlin / Jetpack Compose；事件服务：Fastify / TypeScript / SQLite。
- 可选独立 Pi SDK 宿主；可选自托管 ntfy / UnifiedPush 通知，不默认连接 AI、推送服务器或现有工作会话。
- 安卓已增量公开 [android-002 缓存区间与后继隔离修复](docs/releases/android-002.md)，保留 [001草稿/快捷回复及其历史范围](docs/releases/android-001.md)；不是正式发行、生产可用声明或完整产品验收。不含未就绪的新对话/媒体/复杂卡片、T014或待最终结论的新后端绑定接口；连接器在main仍未合入；本独立分支从003增量004-B的显式存储生命周期，不替代后端或联合产品结论，不自启后继或其他暂停工作。
- 本仓库不包含私人部署、账号、人格、原始聊天、设备/原生会话标识、运行数据库或原始验收证据。

已读 ≠ 平台接受 ≠ 设备收到 ≠ 系统请求提醒 ≠ 来源收件 ≠ 已执行 ≠ 完成或独立验收。

## 构建入口

已按冻结白名单导入 [服务端](server/README.md)、[安卓](android/README.md) 和 [可选 Pi 宿主](pi-host/README.md) 源码、合成测试及依赖锁；各次导入与验证边界见 [公开状态](docs/status.md)，准确文件及前后哈希见 [首轮导出清单](docs/releases/initial-export.json)、[android-001 历史59项清单](docs/releases/android-001.json) 和 [android-002 当前63项清单](docs/releases/android-002.json)。

```sh
# 后端/Pi宿主仅记录 Node.js 22.23.2 的实际验证；npm 10+
# 包内 engines 下限不是支持矩阵，勿据连接器22.13结果推导后端可用
npm --prefix server ci
npm --prefix server run check
npm --prefix pi-host ci --ignore-scripts
npm --prefix pi-host run check

# JDK 17、Android SDK 35 / build-tools 35.0.0
cd android
./gradlew app:testDebugUnitTest app:assembleDebug app:lintDebug
```

**运行边界 N1：当前安装的后端 native 模块在 Node 22.13.0 下已有单独 open 即 SIGSEGV 的报告，原因未定；不支持该后端/同进程集成 runner 的22.13组合。** 连接器使用内置SQLite的22.13结果不能迁给后端；详见 [运行验证矩阵](docs/status.md)。依赖锁保持不变，不据构建配置猜根因或外推所有平台。

后端本地开发：`cd server && npm run dev`，默认只监听 `127.0.0.1:3000`。`/health` 只检查存储健康；没有私有认证配置时受保护接口拒绝。没有默认凭据。不得把健康检查当作事件、回复、后台推送或生产验收。

## 文档

- [需求与边界](docs/requirements.md)
- [架构与安全语义](docs/architecture.md)
- [公开状态、验证与排除项](docs/status.md)

## 许可证

目标是开源、可自托管；产品许可证尚未选择，目前没有授予通用开源使用许可的 LICENSE。[第三方依赖](THIRD_PARTY_NOTICES.md) 仍遵守各自许可证，本项目不随依赖许可自动选择产品许可证。
