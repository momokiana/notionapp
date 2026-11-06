# 公开状态与验证范围

> 本独立`wip/web-002`消费32项冻结H5源码，相对001源9增/8改/15同字节/0删除，锁与backend/API合同不变。68项候选同人限定FINAL PASS、22项证据表及作者零漂移接收分别绑定准确哈希。发布者独立80单元/类型/构建、002真实浏览器10、生产静态3、001套件在002新源上回归10全过、0失败/skip。草稿离线仅为API不可达、静态仍可加载；dev防护仅属于002新配置，不倒签001。详[分层说明](releases/web-002.md)/[source-export清单](releases/web-002.json)。未合main，无完整收件箱/详情/历史持久离线窗口、全网离线冷启动、Native/模型/推送或生产验收；N1及暂停边界不变。

历史`web-001`的23项源与54项候选限定FINAL PASS、F1–F4关闭、原55仍BLOCK，继续绑定原发布字节。发布者当时52单元/类型/构建、浏览器10及生产bundle短闭环1场景；当时原独审额外探针/生产3场景未由发布者复跑。见[001历史说明](releases/web-001.md)/[原清单](releases/web-001.json)/[后继安全警示](releases/web-001-dev-private-files.md)。001当时未交草稿模板，002新增不改变该历史或使001源码获得dev修复。

本仓库为单独的公开开发镜像；未在原开发根初始化 Git，未修改或删除原资料。首次说明提交 `5a9f034`，安卓基线导入 `c9f1fc2`，Server/Pi源码导入 `eb476ea`；完整上传历史见 Git log。这里不宣称正式发行、生产可用或完整产品通过。

## android-002 当前增量

已按不可变63项源表 `e334fd92f5dff032a22f9cea497286ad30159c4722d9a8666910dbad79351c50` 整理缓存区间、明确内容清理和后继owner-ABA隔离修复；相对001为4新增、5修改、0删除。作者已接收同一独审限定FINAL PASS/F1关闭，准确review `2608d081974d62b245cf01c17957dca90effed8d08de721877b4a94db457fad5`。新状态只属于此新源，不抹掉002旧预审BLOCK或迁签001旧范围；见 [002分层验证/历史](releases/android-002.md)、[当前63项源/公开哈希](releases/android-002.json)。发布者已独立核清单/旧公开哈希与delta并扫描；镜像真实socket/JVM **128/128、14类，0失败/error/skip**，三种APK构建成功，双lint各 **0 Error、2 Warning、1 Information**。作者AVD、独审128＋原ABA2/边界3与发布者亲测分别记录；不上传包/报告/原UID，不自行操作设备。

## android-001 历史增量

已按作者独立冻结的59项清单导入本机回应草稿与快捷回复，原始清单 SHA256 `e1647f226f484da676c69e3180f655fb301990b0938ddc77f8cecee85d206afb`；相对首轮源基线6新增、6修改、0删除，不改Server/Pi，不合并连接器WIP或在制后端。具体 [交接/独审范围与本次复验](releases/android-001.md)、[源/公开哈希及增量](releases/android-001.json) 单独记录。发布者已实际复跑111项真实socket/JVM全部通过（0失败/skip），三种APK构建成功，debug/release lint各0 Error、2 Warning、1 Information；产物不上传。作者AVD、独审111项＋3边界与发布者复验分层说明，发布者未操作AVD/真机。此段仅记录001当时结果，不代表002通过或缓存ABA场景已被001验证。

## 公开源码范围

| 组件 | 冻结输入 | 本次边界 |
| --- | --- | --- |
| Android | 作者独立冻结的63项android-002 | 缓存区间/内容清理/后继缓存隔离修复，保留001草稿/快捷回复及原依赖锁/第三方声明；限定FINAL PASS按新交接范围记录；无未就绪新对话/媒体 |
| Server | 实际作者从T013历史候选冻结的64文件 | 源码、合成测试、npm锁及TypeScript配置；不含T014 |
| Pi宿主 | 同一来源65文件，另明确加入1个通用renderer | 源码/测试/锁/配置；无T014受控启用；无实际部署配置 |
| 本地连接器 | 未合入main | A原代码仅保留于[独立WIP分支](https://github.com/momokiana/notionapp/tree/wip/connectors-candidate-a)，已FINAL BLOCK/F1–F3；不采用B结果或待审新后端作为本次稳定增量 |

首轮183项导入白名单、原始和公开字节哈希见 [历史导出清单](releases/initial-export.json)，绑定首轮上传而非变更后的当前Android；001的59项/6新增6修改保留于 [001历史清单](releases/android-001.json)；当前002的63项/4新增5修改见 [002新清单](releases/android-002.json)。Android来源清单SHA256为 `b02c8fd3505eaae16fd74f6e322bdd111d0d3937b4c147ecc249d0a7da7c76eb`；Server/Pi的129项来源清单为 `0a8c2ff81c91d59f603549346a24c4726f5268962fd85e2dca751cea33de7135`。新写的公开说明不在导入文件计数内。

首轮及本轮公开适配保留为说明层差异：Android README重写；Pi的`check`先build再typecheck以支持干净源码引导；通用renderer及对应合成测试将历史unit输出名改为`notifier-app-test*`。其余导入项逐字节保持；原开发目录未改。额外renderer来自同一冻结历史基线，不含其部署README。

**子集抽取、说明净化或构建适配不继承原完整候选的独审结论。** T014和新后端绑定接口未作为本次稳定增量导入；其作者自测/交审不等于公开稳定交付。android-001限定独审与发布复验单列，未覆盖物理设备/生产。下表保留首轮实际重跑，不把历史92项迁成新111项。

## 首轮验证（2026-11-01，绑定0f9489b基线）

| 层级 / 命令 | 实际结果 | 不证明什么 |
| --- | --- | --- |
| 文件/发布自检 | 183项来源与公开hash核验；按白名单检查凭据特征、SSH/私人路径地址、设备/原生会话、固定URL/ID、运行资料/缓存；未发现需上传的私人材料 | 不是完整产品安全审计或无秘密的数学保证 |
| Gradle wrapper | JAR SHA256 `81a82aaea5abcc8ff68b3dfcb58b3c3c429378efd98e7433460610fecd7ae45f` 与官方8.13值一致；保留第三方声明 | 不替代依赖及平台许可核对 |
| Android `app:testDebugUnitTest app:assembleDebug app:lintDebug` | 显式使用JDK17/SDK35/Gradle8.13，在独立镜像缓存/输出目录成功；JVM共92项，84通过、8依赖socket夹具的测试skip，0失败 | 不把skip算通过；debug APK不发布，不证明后台/真机/生产 |
| Server `npm ci` + `npm run check` | 新POSIX验证目录安装；类型检查/编译成功，148测试通过，0失败/skip | 仅合成与本机集成，不是手机或生产 |
| Pi `npm ci --ignore-scripts` + `npm run check` | 同一公开字节、新POSIX验证目录，先Server后Pi；类型检查/编译成功，165项中161通过、4明确skip、0失败 | 4项真实ntfy软件/其安卓夹具因未提供NTFY_TEST_BINARY跳过；无模型费用、设备或生产验证 |
| Android真实本机socket合同 | 相同公开字节的Server构建 + `contract-fixture.mjs` + 镜像Gradle `app:testDebugUnitTest --rerun-tasks`成功；92项全部通过，0失败/skip | 新临时身份/库/回环端口，包括真实HTTP丢ACK/撤销/原请求恢复；不是Android硬件、后台或真实来源接入 |

保留真实初次失败：Android最初无JAVA_HOME/java，未进入构建；显式选择已核工具后上述构建成功。Pi干净源码初次check因两个crash fixture导入尚不存在的dist/main.js而TS2307失败；仅调整检查顺序后完整复跑得到上述结果。未隐瞒失败、删除测试或伪造skip。

发布自检保留了明确合成的fixture身份、无效示例域名、回环端口及负例路径/假凭据；它们不是私人运行标识。本次不操作ADB/AVD、物理设备、云端工作会话、收费模型、现有推送平台或生产。原始运行/测试日志保留本地，不在公开库原样上传。另已核对Git实际提交中的183项导入blob与公开清单哈希一致、193个提交文件无禁入运行/缓存路径、公开Markdown无失效本地链接；仅说明发布对象完整性，不扩大产品验收。

## 已知安卓缓存隔离限制

001及更早缓存的逐页临时凭据/末尾namespace旧模式，以及001限定PASS不能证明跨owner **A→B→A** 并发隔离，继续作为[旧范围更正](releases/android-001.md)保留。后继002旧预审曾BLOCK/F1，即使旧127项绿也不能覆盖反例；最终e334新源在现有身份门内完成六处缓存GET，按同一独审限定FINAL PASS/F1关闭另行公开。**新修复与新结论仅属于002准确字节，不追认旧源已修复/通过**，不删除旧历史或上传私有原始证据。

## Node.js 运行验证矩阵（N1）

| 对象 / 运行时 | 实际观察与范围 | 证据归属 / 不可外推 |
| --- | --- | --- |
| 公开Server/Pi宿主：Node **22.23.2**，Linux/WSL隔离环境 | 发布者实际执行的Server148项、Pi161通过＋4可选skip，以及后续Android真实socket夹具均在此运行时 | 仅这些公开字节与本机环境，不表示所有Node22小版本/Node24或其他平台均通过 |
| 当前安装的后端native二进制：官方Node **22.13.0** | 开发/独审同步：better-sqlite3 13.0.3连单独open亦SIGSEGV；**原因未定，不支持该后端或同进程integration-runner的22.13组合** | 不是发布者本轮重现，也不能扩展为所有平台/所有重新构建的二进制必然失败 |
| 连接器客户端22.13.0/22.23.2 → **独立后端22.23.2** | 连接器B交接报告该分进程HTTP组合已验证；客户端使用内置node:sqlite | 不是backend在22.13的证据，更不能替代source-binding后端自身FINAL；B与后端尚未作为联合稳定代码合入main |

包内engines范围是原始声明，不是上述实际支持矩阵。当前仅推荐已验证的后端22.23.2复现环境；其他后端运行时未取得本公开矩阵的通过结论。已观察本机driver的binding.gyp设置 `NAPI_VERSION=10`，但这仅为构建配置事实，**不是SIGSEGV根因证明或所有平台结论**。此次只更正文档，不运行已知崩溃组合、不修改package/lock、安装的native依赖或构建参数，不为“兼容”漂移候选。

## 已知依赖安全项

本次npm安装审计：Server报告0已知漏洞；Pi报告2个中危受影响节点（`minimatch`及依赖它的`@earendil-works/pi-coding-agent`），不是两条独立漏洞。实际公告为 [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)：globparts放大可导致拒绝服务，锁定minimatch 10.2.6落在 `<11.0.1` 范围；npm报告 `fixAvailable:false`。

未擅自改动已冻结SDK/lock或假称产品已不受影响。依赖修复/SDK兼容与调用面评估须后续作者处理，当前不建议据此快照直接投入生产。审计是执行时的已知公告观察，不保证以后没有新问题。

## 排除项与后续增量

不上传私人部署/SSH、私人IP/路径/人格/真实聊天、凭据和授权、设备/原生会话ID、DB/WAL/SHM、运行native/journal、推送端点、备份/密钥/邀请包、原始evidence日志/图片、APK/签名材料、AVD、node_modules、dist及Gradle/构建缓存。构建所需官方Gradle wrapper是单独核验的唯一引导JAR，不附第三方APK/服务二进制。

后续各实际作者交付新的独立冻结白名单/哈希与准确测试、审查、在制范围，发布作者比对此清单串行增量；不从正在写入的目录盲取，不覆盖远端未知提交、不force-push。产品许可证仍未选择；[第三方声明](../THIRD_PARTY_NOTICES.md)保留，不擅自附MIT等产品LICENSE。
