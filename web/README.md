# H5 事件客户端

> 独立公开WIP `wip/web-002`，只消费冻结32项源码。已接收同人限定FINAL PASS；发布者独立复验与公开适配的source/export哈希见[002说明](../docs/releases/web-002.md)/[准确清单](../docs/releases/web-002.json)。不合main或未审后端，不是正式发行或生产许可。001历史结论不迁签本版，002的dev防护也不倒签001。

React 19.3.1＋TypeScript 5.9.3＋Vite 8.3.6。已有后端保持 Fastify/TypeScript/SQLite，本客户端不重做账本。产品名称未定，工程地图不是本产品页面。

## 运行

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
# 草稿/模板：实际API故障、静态可达重载、IDB迁移/两tab等
npm run test:drafts-browser
# 自有随机端口，构建+preview的静态UI草稿链
npm run test:drafts-production
```

`test:browser`需上述独立基线已编译。使用真实Chromium＋实际Fastify socket/磁盘SQLite及故障网关，不用mock页替代API。可指定 `WEB_BASELINE`、`CHROMIUM_EXECUTABLE`、`CHROMIUM_LIBS`（额外动态库目录）、`WEB_EVIDENCE`（输出目录）。默认浏览器路径是本次开发环境缓存；其他机器应使用自己安装的Chromium路径。不会下载安装OS库或读取私人凭据，所有合成测试资料留在 `.local/cases`。测试自动关闭自有浏览器/服务，不清旧工程/数据库。

Vite dev/preview仅供本地开发，不是生产部署。静态 `dist/` 需由自己的 HTTPS origin 提供，并为 `/api/v1/` 配置固定后端反代：去掉 `/api`、禁缓存、禁重定向跟随、不得按请求参数指定上游。其余 `/api` 应拒绝而非SPA回退。保持 `Cache-Control:no-store`、`Referrer-Policy:no-referrer`、CSP（脚本/连接仅self，禁frame/base）和nosniff；不要部署私人 `.local`、源码测试资料或环境文件。dev已显式用`server.fs.deny`拒绝`.local`（包括`/@fs`入口）及原默认环境/密钥路径，不能只依赖.gitignore来保护开发夹具。preview只提供dist/本次指定构建目录，不提供整个工程。本任务没有公网部署。

## 已实现合同与限制

- 收件箱：每页50，本窗口最多100；HTTP读响应有8MiB硬界限，覆盖合法50项Unicode/JSON转义快照页，仍逐字段/条数核限，不截断正文。文字/来源/未读/可回应/事项过滤仅当前窗口。到上限后显式后续窗口，失败保旧页；可回首段。创建升序 `after` **不是**更新订阅，刷新从头重读。
- 详情/历史：当前版本、上下文、按钮/文字回应、服务保存、回应当前资格、来源命令/回执、当前及较早版本通知回执分别展示。历史每页50，本窗口最多200，可换窗/回首段；旧动作不成为新按钮。来源自报结果不等于执行或独立核验。
- 查看不自动已读。明确已读只保存所见版本；事项决定 open/paused/completed/not_tracking 是用户决定，不声称取消在途效果。
- 提交前重GET并核完整所确认事件/交互/动作/目标/期限，任何版本变化要求重新查看确认。Unicode回应最多4000码点，原始空白完整保存，按钮正文为空。
- 出站单槽先IDB严格事务完成，再持久unknown，才HTTP。保存失败零POST。页面/连接generation变化或失前台使新确认失效，不因中断当作取消。身份/部署不同不能接管原槽。
- 回应丢ACK只GET原ID，逐项核原版本/交互/action/text/target/actor（若有权威设备self）；原保存事实先落地，当前详情/历史随后刷新，失败单独显示“已保存，当前结果未知”。404/401不等于未执行。没有自动重发或新ID重试。只有严格`{error:{code,message}}`（无额外字段、正确类型）的错误才可进入首次确定拒绝白名单：409的版本/交互/占用/只读/关闭、410过期、422 INVALID_INPUT。真实413、坏错误结构、其他错误和未知后的拒绝继续保槽；401/403即使错误正文不合合同也撤新写资格，但不当确定无效果。成功ACK也核准确字段/ID/版本/时间，不凭任意200清槽。
- **已读或事项丢ACK的活性限制**：原后端已读无request_id、事项历史不含request_id；读到相同进度/决定不证明原操作成功。本客户端保原unknown并阻止后续新写，不提供清槽或偷偷POST重放。需后续精确恢复合同才能改善，不能宣称完整恢复已完成。
- 静态凭据没有user self，只显示手工指纹，不虚构设备actor。可选managed self支持读取身份，但没有配对/轮换/撤销管理UI；self401不会降级为已核身份。完整静态/受管混合部署未验。

## 本机草稿与快捷回复

- 已查看的问题可明确保存按钮/文字草稿，最多8份；只有点击保存才持久，未保存编辑离页丢失。原namespace/root/部署instance/凭据指纹、准确owner/source/epoch/session/target/期限/交互/action及完整原文都保留，不能换身份接管。
- **离线仅指事件API不可达，静态HTML/JS/CSS仍能实际加载。** 重开后输入原凭据即可在本机重建准确namespace并看草稿，不要求API或device self先成功；这不表示已认证。全网离线的浏览器冷启动/冷重载未实现，无SW/PWA，不把IDB持久化当作离线app-shell。
- 原schema1读取不伪称已迁移。首次明确保存草稿/模板时，原锁内同一严格IDB事务迁到schema2，保store_id/marker、原pending和outcome。坏根/未知布局/不一致不重建。旧001客户端对schema2只读拒绝，不降级删字段。
- 最多12条本机全局快捷回复，标题40/正文1000码点；草稿文字最多4000码点。追加只在编辑器末尾插入换行与完整模板，不覆盖原文、不自动保存或发送。修改/删除均比对原id/revision，另一页修改会拒绝迟到操作。
- schema2仍共享**128KiB整根预算**，包括未决、草稿快照/恢复材料和模板；数量上限不保证最大字段同时装入。超限明确拒绝新修改、保旧根，不截断。
- “联网核对草稿”只GET准确原事件。换目标/期限/交互/action或失去资格就保原草稿拒绝；普通进展允许展示原版本→当前版本、当前问题/正文/操作/完整待交原文后再次确认。尚未保存的编辑、模板插入、取消、离页/设置、失前台、连接ABA、跨tab revision变化都会使确认失效。
- 真正“确认提交此回应”才在同一原Web Lock中重读草稿/重GET当前事件，**同一事务**移走原草稿并建立prepared Pending（带不可变恢复材料），再持久unknown才POST。不会嵌套申请相同锁。第一事务失败原草稿在；第二事务失败材料在原prepared槽，均0POST且不自动复活第二份草稿。
- 仅当前首次fetch直接收到001严格白名单拒绝时，才可同事务恢复原草稿/清原槽；不能因stage叫unknown或后来GET拒绝推断旧POST无效果。丢ACK/重开仅核原response_id，成功后不复活草稿；恢复连接或核对本身0POST。其他本机草稿/模板编辑不改原pending/outcome。

完整收件箱/详情/历史目前仍只有内存只读旧快照，**未实现完整有界持久离线窗口**，按后继接续。`test/legacy-v1/`是本项目已审schema1源的精确兼容性夹具，不进入生产bundle。无原生推送、系统通知、后台/锁屏、Keystore或安卓壳。后续安卓采用 Capacitor WebView/实际需要的原生桥接，复用当前UI/业务，不迁写Compose；本任务不先安装空插件平台。

## 证据层级

原32项source表、68项候选表、22项独审证据表及最终审查以准确SHA256绑定，原始TASK/review/证据不上传。此公开README单独适配，其余31项源码逐字节保持；[公开清单](../docs/releases/web-002.json)分列source/export哈希。发布者实际运行80单元/类型/构建、002浏览器10、生产静态3及001浏览器在002新字节上的回归10，全部0失败/skip；父测试计入相应套件数量，不把原独审额外6项探针冒称本次复跑。dev普通路径和`/@fs`私有路径请求拒绝；自有7个请求变体未返回私有标记，其中编码斜杠请求为200 SPA回退，不能声称全部403。

本次桌面Chromium与390×844 viewport、200% CSS缩放只能证明对应浏览器样本，不能代替物理Android、原生WebView、无障碍全面认证、后台/锁屏/生产或“大缓存性能已解决”。前台HTTP不冒充后台推送，隔离合成来源不冒充云端澪/Native收件。未新增模型调用、云端或生产操作，不扩张任何既有授权。

## 依赖与许可

React/React DOM：MIT；Vite/tsx：MIT；TypeScript、Playwright：Apache-2.0；@types：MIT。版本和传递依赖固定于lock，安装时保留上游许可，不复制第三方二进制进源码。应用自身许可证仍待用户确定，本任务不代选。
