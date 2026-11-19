# 恢复开发：GPT 隔离验证与自有 App 改造清单

> 历史验收记录：保留当时的结论和命令；源码链接指向[更名之后的主线](<../../xiaoaixiaoai/README.md>)，不代表当时的精确字节。

日期：2026-11-17。用户要求从本主工程继续开发。本文是[源码迁入时快照](<2026-11-17-source-transfer.md>)之后的增量，不改写历史迁移清单，也不代表自有 APK 或生产验收完成。

## 本轮完成

- 复现原 GPT 接入的两处已知问题：测试 helper 把普通 stream 的选项错误地按 SimpleStreamOptions 传递；真实 SDK 假 HTTP 测试仍假定工具声明位于顶层 `tools`，而锁定 SDK 的 `gpt-6-sol` 模型使用输入记录中的 `additional_tools`。
- 修正[GPT 测试](<../../xiaoaixiaoai/apps/relay/test/gpt-login.test.ts>)：helper 使用 TranscriptContext，不再传递未使用且类型不兼容的选项；对两轮请求均校验真正发出的工具名称、类型、描述和参数，保留推理签名/工具调用 ID/工具返回的原断言，不靠删除断言使测试变绿。
- 新增[GPT 配置测试](<../../xiaoaixiaoai/apps/relay/test/gpt-login-config.test.ts>)四项，覆盖显式绝对凭据路径、配置解析不读账号、环境覆盖文件、拒绝混用 HTTP 密钥/地址/请求体以及不回显所给私值。
- 本轮没有改 GPT 运行实现、凭据存储实现或依赖锁；只修测试、补测试和说明。现有源码迁移、通知撤销修复与历史组件保留。

## 实际验证

运行环境：Linux/WSL、Node 24.22.2、pnpm 12.15.0。先在 `pocket/` 执行 `pnpm install --frozen-lockfile --ignore-scripts`，成功；未运行依赖生命周期脚本。当时的工作区锁 SHA256 前后保持 `eafebfc233dd0c2e3c31bcb494fa87898c7e4d6349b0c9c041ac1155dc061571`。

| 目录与命令 | 结果 | 范围 |
|---|---|---|
| `pocket/apps/relay`：`node --test test/gpt-login.test.ts test/gpt-login-credentials.test.ts test/gpt-login-config.test.ts` | 20/20，0 fail/cancel/skip | 真实 Pi Models/Responses SDK，假 provider/HTTP、临时合成凭据文件；含双进程刷新互斥 |
| `pocket`：`pnpm typecheck` | 4 包通过 | protocol、update、relay、hostd；工作区明确排除了 mobile/site，不冒称手机类型通过 |
| `pocket`：`pnpm --filter @herdr-pocket/relay test` | 88/88，0 fail/cancel/skip | 本机回环、假模型/语音和临时数据；包含上述20项，不相加成108个独立测试 |

保留初次失败：修正前本轮 GPT 集合 19/20，工具声明断言失败；工作区类型检查因上述 helper 报 TS2345。修正后获得表中结果。旧迁移快照里的15/16仍描述当时，不作为当前状态。

**没有使用真实 GPT 授权、联网调用真实模型、运行或控制真实 Agent、部署/重启线上服务、构建或安装自有 APK。** 没有提交或推送。上述结果不表示真实账号接入、手机后台通知、DSH 控制或全链路已经可用；也不改变旧后端的 Node 运行验证矩阵。

## 助理与 GPT 登录是什么

朋友的助理界面位于手机 App，运行逻辑在[relay 的 assistant 模块](<../../xiaoaixiaoai/apps/relay/src/assistant/assistant.ts>)。手机负责输入/显示和通知，服务器上的助理管理对话、调用模型和工具，电脑端 hostd 连接可操作的 Agent。

这里的“GPT 登录”是主助理调用模型的 OAuth 授权接入，不是我们 App 的用户登录、不是启动 ChatGPT 手机 App，也不是 DSH 会话登录。[驱动](<../../xiaoaixiaoai/apps/relay/src/assistant/gpt-login.ts>)使用显式指定的[凭据存储](<../../xiaoaixiaoai/apps/relay/src/assistant/gpt-login-credentials.ts>)；本轮仅验证合成凭据。没有实现手机内 GPT 登录页面，也没有验证真实账号、套餐权限或真实模型调用。接入 DSH 是另外的电脑端工作。

## 自有 App 的后续工作

总体：品牌改造低难度；应用身份/发布链联动中等；复用现有终端通道接 DSH 中等；直接桥接既有 DSH 工作区较高。完整源码可复用，不需要先重写手机和 relay，但不能只换名称就称自己的成品。

### 1. 应用身份与发行隔离（构建交付前必须完成）

- [移动端配置](<../../xiaoaixiaoai/apps/mobile/app.json#L3-L30>)仍为上游 name/slug/package/scheme。新产品名尚未确定，不在本轮擅自定名。需选择独立 applicationId、scheme、自己的图标/启动图和长期保存的发布签名。
- [共享发布契约](<../../xiaoaixiaoai/packages/protocol/src/index.ts#L1042-L1061>)仍指向原作者仓库；[手机更新器](<../../xiaoaixiaoai/apps/mobile/src/lib/update.ts#L124-L155>)会查原作者 APK。[relay 配对页](<../../xiaoaixiaoai/apps/relay/src/landing.ts#L21-L24>)的浏览器回退和[下载入口](<../../xiaoaixiaoai/apps/relay/src/landing.ts#L67-L72>)也会导向官方版。必须一组切换为自己的发布链；尚无自有发布源时应显式禁用相关检查/下载，不能继续给出官方包。
- 改 APK 文件前缀时，同步发布产物、checksum 解析、手机匹配规则和电脑更新器，不能只改仓库常量。共享 scheme 的解析/生成、网页 intent、原生通知点击与客户端必须一致，避免与官方 App 争抢链接。
- [原生更新器](<../../xiaoaixiaoai/apps/mobile/modules/xiaoaixiaoai-native/android/src/main/java/dev/notifier/xiaoaixiaoai/bridge/Updater.kt#L105-L120>)核对包名，再交系统安装器；独立包 ID 会拒绝官方包作为本 App 的更新，但仍须清理错误更新提示/下载和网页另装入口。不能据源码声称官方 APK 能无条件静默覆盖，也不能在未检查实际签名时保证所有旧包都因签名不同而拒装。
- [现有发布脚本](<../../xiaoaixiaoai/.github/workflows/release.yml#L152-L169>)无自有密钥时只警告并回退公开 debug key。正式自有发布应在缺密钥时失败；不读取/提交真实签名材料。
- [初始服务器为空](<../../xiaoaixiaoai/apps/mobile/src/lib/store.ts#L58-L64>)，并非硬编码连接朋友后端。可保留邀请链接/手填服务器和正常配对；如需默认自有地址，另加可覆盖配置，不在 APK 内置设备 token。
- 保留[AGPL 许可](<../../xiaoaixiaoai/LICENSE>)与原版权，维护[本地修改说明](<../../xiaoaixiaoai/MODIFICATIONS.md>)。不把品牌更名误说成拥有上游全部版权，也不把子树许可自动扩到根历史组件。

### 2. DSH 接入（仍未实现）

- [启动白名单](<../../xiaoaixiaoai/apps/hostd/src/create.ts#L14-L38>)没有 DSH；[续跑白名单](<../../xiaoaixiaoai/apps/hostd/src/create.ts#L319-L327>)也依赖它。
- [活跃 Agent 列表](<../../xiaoaixiaoai/apps/hostd/src/host.ts#L224-L241>)只由 HC/Herdr 生成，Uniflo 仅补充会话信息。DSH 图标或上游 reader 不等于本项目已支持 DSH 展示、发送、工作/等待/完成状态和通知。
- 优先最小路线：先核实公开 CLI 的启动/任务/续跑参数，再为 DSH launcher 与 HC/Uniflo 唯一会话关联补假夹具测试；覆盖同目录多会话不串、同工作追加、状态来源和通知。不能猜测参数或向真实会话发消息验证。
- 若要求独立直连既有 DSH 工作区，需要桥接器、稳定 sessionId 映射、能力/权限路由、读取/发送/中断/流/重连与状态映射；protocol、relay、hostd、mobile、mock 和测试需联动，不能仅增加 source 类型或图标。

### 3. 分阶段验收

1. 本轮完成：GPT 接入的已知测试/类型问题关闭，隔离回归通过；自有发行与 DSH 缺口列清。
2. 下一阶段：确认产品名称与独立身份/发布策略，完成自有客户端源码改造，再构建本地测试包、验证模拟器配对与通知；本轮未做。
3. 其后：完成 DSH 隔离接入，最后在用户明确授权后安排新服务部署、真实账号、电脑与真机验收；不是现在自动操作生产。
