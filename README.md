# notionapp（开发中）

> 当前独立开发分支 `wip/web-002`：准确32项H5源码，新增有界本机草稿/快捷回复与dev私有路径防护；同人独审对68项新候选限定FINAL PASS，作者接收零漂移。不是完整产品稳定基线或正式Release，main未合。见[准确范围/实际复验](docs/releases/web-002.md)及[source/export哈希](docs/releases/web-002.json)。

> **002的dev私有路径修复只属于002新字节，001旧源码仍未修。** `.gitignore`不是HTTP访问控制；不得把dev/preview当生产服务或暴露/转发dev端口。[001历史警示](docs/releases/web-001-dev-private-files.md)不因后继修复而倒签。

面向个人自托管的轻量通知与交互 App：程序或 AI 助理发出事件，手机展示卡片，用户通过按钮或文字回应，来源的后续进展回到同一事件。

`notionapp` 是仓库名，产品名尚未确定；本项目与 Notion 没有集成或隶属关系。

## 范围与现状

- 用户已确认H5先行、安卓H5＋原生壳；本分支交有界[H5事件客户端与本机草稿/模板](web/README.md)，React/TypeScript/Vite，不重做既有Fastify/TypeScript/SQLite后端。原Compose工程保留、暂停扩展，旧结论不迁签；原生能力及缓存/WebView性能仍须分别实现/验证。
- 可选独立 Pi SDK 宿主；可选自托管 ntfy / UnifiedPush 通知，不默认连接 AI、推送服务器或现有工作会话。
- 历史Compose安卓已增量公开 [android-002 缓存区间与后继隔离修复](docs/releases/android-002.md)，保留 [001草稿/快捷回复及其历史范围](docs/releases/android-001.md)；不是正式发行、生产可用声明或完整产品验收。不含未就绪的新对话/媒体/复杂卡片、T014或待最终结论的新后端绑定接口；连接器候选仅在独立分支，不在 main。
- 本仓库不包含私人部署、账号、人格、原始聊天、设备/原生会话标识、运行数据库或原始验收证据。

已读 ≠ 平台接受 ≠ 设备收到 ≠ 系统请求提醒 ≠ 来源收件 ≠ 已执行 ≠ 完成或独立验收。

## 构建入口

H5切片：按[web/README.md](web/README.md)使用Node22.23.2，在`web/`执行`npm ci && npm run check`。真实API测试只从固定公开commit导出64项后端到独立副本，不复制活动server、旧依赖/库或凭据；详见[web-002清单](docs/releases/web-002.json)。草稿重开仅覆盖API不可达、静态资源仍可加载；未交完整收件箱/详情/历史持久离线窗口、全网离线冷启动、Android壳/Native/模型/推送或公网部署。

以下是保留的原公开组件入口，不构成恢复暂停工作或新端通过：

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
