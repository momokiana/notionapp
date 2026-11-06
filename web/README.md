# H5 事件客户端 — web-001限定FINAL PASS切片

> 独立开发分支 `wip/web-001`，只消费准确23项冻结source-only；同人限定FINAL PASS/F1–F4仅属于新54候选，**原55仍BLOCK，不倒改历史**。来源/逐项source-export哈希与发布者实际复验见 [web-001公开说明](../docs/releases/web-001.md)。不是完整产品稳定版、正式Release或生产部署；不迁签完整T013、T014/source-binding、Android/Native/模型/推送。当前无持久离线重开、草稿/模板，web-002不在本结论内。

React 19.3.1＋TypeScript 5.9.3＋Vite 8.3.6。已有后端保持 Fastify/TypeScript/SQLite，本客户端不重做账本。产品名称未定，工程地图不是本产品页面。

## 运行

> **已知dev私有文件暴露风险，001当前未修。** 作者报告自有合成夹具的Vite dev服务可经`/.local/active-fixture.json`读取合成凭据描述；发布者未复现、未读取正文/token。**`.gitignore`只约束Git，不保护HTTP访问。** dev/preview不得用于生产，不要暴露或转发dev端口；不要把`.local`、凭据、数据库或证据视为已被静态服务隔离。隔离回环与旧测试通过都不证明私有文件访问控制已成立。详见[安全补充](../docs/releases/web-001-dev-private-files.md)。后继002防护已按限定FINAL PASS及准确32源交接在独立提交[`f363d5967a01814bd784277a95653e1f3ae47d0f`](https://github.com/momokiana/notionapp/commit/f363d5967a01814bd784277a95653e1f3ae47d0f)发布，见[002实际复验/边界](https://github.com/momokiana/notionapp/blob/f363d5967a01814bd784277a95653e1f3ae47d0f/docs/releases/web-002.md)。本001分支未合其防护，旧源码仍未修，不迁签002结论。

原23源表及原source/export清单继续绑定首发提交`b2142ef4549f8c45f39a00cb48fdd1869036eaa0`，不回写旧哈希或历史结论；当前后继只更新公开文档与002发布链接，不表示001风险已经修复。

Node **22.23.2**（本次实际验证版本），npm。全部命令在 `web/` 中执行：

```sh
npm ci
npm run check
# 连接管理员现有服务，只用固定同源代理，不改后端CORS
WEB_BACKEND=https://events.example.org WEB_INSTANCE=my-private-install npm run dev
# http://127.0.0.1:4317
```

设置页输入管理员供应的用户设备 token。浏览器只请求 `当前origin/api/v1/...`，Vite 代理只转发到启动时固定的 `WEB_BACKEND` origin。不能在页面输入任意上游或让凭据随重定向外送。仅 HTTPS 上游，开发允许明确回环 HTTP。`WEB_INSTANCE` 必须在换库、恢复旧库、更换上游映射时改变；构建也嵌入上游 origin，任何映射改变须重新构建。它是管理员提供的隔离标识，不是服务当前世代的独立证明。

凭据**仅内存**，刷新需重新输入，URL/持久化/日志无 token。首用需确认没有待恢复原提交后建立本机提交账本。IndexedDB 保存原ID、目标与业务文字，**未加密，不等于 Keystore**；同origin、同浏览器存储分区内用 Web Locks 跨标签页互斥。没有 Web Locks 时保持只读。双marker不一致/损坏/写入失败不自动重建。清除全部浏览器数据、换浏览器或origin后无法判断是否丢了未决，先人工对账，不靠重新初始化救绿。

### 无模型的真实后端隔离演示

只消费公开历史 T013 的64项源码，不复制活动开发树、node_modules、dist、数据或配置。先在源根外取得 `https://github.com/momokiana/notionapp` 的只读镜像，然后在 `web/`：

```sh
WEB_PUBLIC_REPO=/absolute/public-checkout node tools/export-baseline.mjs
npm --prefix .local/baseline/server ci
npm --prefix .local/baseline/server run check
npm run fixture
# 另一终端
npm run dev
```

准确 commit `0a745c88fbba495f145263e5384af24215c394b2`；`initial-export.json` 中 server64 表SHA256 `f05bb7fb4369f07718e3bcca47d177cda34a413edd55802a9381bc15d832e967`。导出器逐Git blob核 source/public 哈希且拒绝覆盖已有副本。公开README不是冻结64项的第65项，公开子集不继承完整历史T013独审结论。已知该后端 native SQLite 的 Node22.13 组合有 SIGSEGV，不能按 engines 外推支持。

夹具新建私有磁盘SQLite、合成身份及两件当前事件，监听 `127.0.0.1:4318`；准确连接材料仅写 `web/.local/active-fixture.json`（0600），手工把其中 user_token 填到连接页，不把文件/内容上传或贴入聊天。可在浏览器选择操作、保存原回应、查看实际历史/回执。夹具不加载 Pi、模型、推送、云端或任何用户资料；服务保存是真API/真SQLite，但来源不是AI收件。Ctrl+C只关闭新进程，保留 `.local/cases` 原数据。

### 构建与浏览器验证

```sh
WEB_BACKEND=https://events.example.org WEB_INSTANCE=my-private-install npm run build
# 本地看生产构建，同一环境变量必须与构建保持一致
WEB_BACKEND=https://events.example.org WEB_INSTANCE=my-private-install npm run preview
npm test
npm run test:browser
# 默认本机生产构建＋4318隔离服务的短闭环（确保4318未被其他进程占用）
npm run test:production
```

`test:browser`需上述独立基线已编译。使用真实Chromium＋实际Fastify socket/磁盘SQLite及故障网关，不用mock页替代API。可指定 `WEB_BASELINE`、`CHROMIUM_EXECUTABLE`、`CHROMIUM_LIBS`（额外动态库目录）、`WEB_EVIDENCE`（输出目录）。默认浏览器路径是本次开发环境缓存；其他机器应使用自己安装的Chromium路径。不会下载安装OS库或读取私人凭据，所有合成测试资料留在 `.local/cases`。测试自动关闭自有浏览器/服务，不清旧工程/数据库。

Vite dev/preview仅供本地开发，不是生产部署。静态 `dist/` 需由自己的 HTTPS origin 提供，并为 `/api/v1/` 配置固定后端反代：去掉 `/api`、禁缓存、禁重定向跟随、不得按请求参数指定上游。其余 `/api` 应拒绝而非SPA回退。保持 `Cache-Control:no-store`、`Referrer-Policy:no-referrer`、CSP（脚本/连接仅self，禁frame/base）和nosniff；不要部署私人 `.local`、源码测试资料或环境文件。本任务没有公网部署。

## 已实现合同与限制

- 收件箱：每页50，本窗口最多100；HTTP读响应有8MiB硬界限，覆盖合法50项Unicode/JSON转义快照页，仍逐字段/条数核限，不截断正文。文字/来源/未读/可回应/事项过滤仅当前窗口。到上限后显式后续窗口，失败保旧页；可回首段。创建升序 `after` **不是**更新订阅，刷新从头重读。
- 详情/历史：当前版本、上下文、按钮/文字回应、服务保存、回应当前资格、来源命令/回执、当前及较早版本通知回执分别展示。历史每页50，本窗口最多200，可换窗/回首段；旧动作不成为新按钮。来源自报结果不等于执行或独立核验。
- 查看不自动已读。明确已读只保存所见版本；事项决定 open/paused/completed/not_tracking 是用户决定，不声称取消在途效果。
- 提交前重GET并核完整所确认事件/交互/动作/目标/期限，任何版本变化要求重新查看确认。Unicode回应最多4000码点，原始空白完整保存，按钮正文为空。
- 出站单槽先IDB严格事务完成，再持久unknown，才HTTP。保存失败零POST。页面/连接generation变化或失前台使新确认失效，不因中断当作取消。身份/部署不同不能接管原槽。
- 回应丢ACK只GET原ID，逐项核原版本/交互/action/text/target/actor（若有权威设备self）；原保存事实先落地，当前详情/历史随后刷新，失败单独显示“已保存，当前结果未知”。404/401不等于未执行。没有自动重发或新ID重试。只有严格`{error:{code,message}}`（无额外字段、正确类型）的错误才可进入首次确定拒绝白名单：409的版本/交互/占用/只读/关闭、410过期、422 INVALID_INPUT。真实413、坏错误结构、其他错误和未知后的拒绝继续保槽；401/403即使错误正文不合合同也撤新写资格，但不当确定无效果。成功ACK也核准确字段/ID/版本/时间，不凭任意200清槽。
- **已读或事项丢ACK的活性限制**：原后端已读无request_id、事项历史不含request_id；读到相同进度/决定不证明原操作成功。本客户端保原unknown并阻止后续新写，不提供清槽或偷偷POST重放。需后续精确恢复合同才能改善，不能宣称完整恢复已完成。
- 静态凭据没有user self，只显示手工指纹，不虚构设备actor。可选managed self支持读取身份，但没有配对/轮换/撤销管理UI；self401不会降级为已核身份。完整静态/受管混合部署未验。

目前只有内存只读旧快照，**未实现持久离线重开、草稿/模板**；后继按既有依赖接续。无原生推送、系统通知、后台/锁屏、Keystore或安卓壳。后续安卓采用 Capacitor WebView/实际需要的原生桥接，复用当前UI/业务，不迁写Compose；本任务不先安装空插件平台。

## 证据层级

原任务/审查只作本地合同索引，不随源码上传。新54候选表`c8274718b4e845d904575eda3e54fc0044eee84bb1d98110d0db0cc39137fd45`、review `c9ea23423ad8cba6bac1e4b5bd2ce96338b405856d2072a90fb105eef90b1c65`及23源表`37306a8d6756b15985721e7e3cf805fa30cc4c7edcae4ff1fc407915fd497089`按原范围独立记录。发布者不复制TASK/review/raw evidence/截图/DB/token/会话/依赖或构建产物，产品执行状态仍由原共享路线单写者更新，不在此代写。

本次桌面Chromium与390×844 viewport、200% CSS缩放只能证明对应浏览器样本，不能代替物理Android、原生WebView、无障碍全面认证、后台/锁屏/生产或“大缓存性能已解决”。前台HTTP不冒充后台推送，隔离合成来源不冒充云端澪/Native收件。未新增付费模型请求，T007已耗尽许可不变。

发布者仅作README公开说明适配，其余22项代码/测试/配置/锁与冻结源同字节。测试脚本内两处默认浏览器/库路径是作者明确同意公开的本机QA示例，未改为新入口；实测用环境变量显式指定已核工具，不把任意机器可移植性算作通过。生产短闭环的4318只在独立网络命名空间内使用，绝不停止或借用已有监听服务。分层结果与保留的环境失败见[发布说明](../docs/releases/web-001.md)。

## 依赖与许可

React/React DOM：MIT；Vite/tsx：MIT；TypeScript、Playwright：Apache-2.0；@types：MIT。版本和传递依赖固定于lock，安装时保留上游许可，不复制第三方二进制进源码。应用自身许可证仍待用户确定，本任务不代选。
