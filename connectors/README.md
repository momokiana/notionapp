# 本地出站连接器 — 004-B显式存储维护，限定FINAL PASS

> 独立分支 `wip/connectors-004` 仅消费004-B准确36项source-only：同一独审§8限定FINAL PASS，**004-A仍BLOCK/F1；B在main创建/SQLite打开前拒绝孤WAL/SHM/journal/storage组，不倒改历史**。显式原路径v2、同SQL完整归档及持久有界扩容不是恢复/轮换或输入授权。详见 [源/公开哈希与实际矩阵](../docs/releases/connectors-004.md)。**不合main/不作联合或正式Release；backend自身FINAL未知，N1不变，真实daemon接收器仍是合成HTTP夹具。**

包声明Node>=22.13，实测仅22.13.0/22.23.2及本页限定POSIX矩阵；内置 `node:sqlite` 提示ExperimentalWarning，无第三方运行依赖。不开放入站端口、不执行shell、不发现私人会话目录。当前backend/in-process runner只按22.23.2验证；现安装better-sqlite3在官方22.13单独open亦SIGSEGV，原因未定，不迁用客户端绿证。

- 脚本、CI、定时任务：把严格 JSON 数据文件入队，连接器主动向同一个事件服务发布。
- Uniflo：显式选择会话，只 GET 当前快照与 NDJSON，映射为无交互只读事件与原事件 progress；不上传会话正文、路径、标题、preview、工具参数、reasoning 或原生 ID。
- 服务端仍是唯一事件／回应／命令／通知账本。本地 SQLite 只存传输原包、发布回执与观察映射／水位；`connector_persisted` 不是服务已保存，`event_saved` 也不是手机或原会话收件、执行或验证。

## 检查

```sh
npm --prefix connectors ci
npm --prefix connectors run check
# 后端/native runner仅限已验22.23.2；正常绑定集成仍待backend自身FINAL
# 本分支继承的T013公开后端未含新绑定，不能当正常联合链路
npm --prefix connectors run integration
# 明确验证旧服务端拒绝绑定发布，不把它称正常新协议集成
node connectors/test/integration-runner.mjs /absolute/public-server-tree --legacy
```

普通测试使用全新私有临时目录和回环 HTTP 合成协议夹具；`integration` 只复制 server/src 和 package/lock 到源外 scratch，前后核 hash，再以实际 Fastify/CoreStore/SQLite 测试。不编译或修改共享 server，不读取 data、生产配置、部署或 evidence。普通check不代表真实 Uniflo daemon、私人 harness、手机或生产验收；真实公开daemon另有下文显式隔离入口。后端原生二进制的实际运行组合独立于连接器最低Node版本：当前已验后端/in-process integration runner为22.23.2，不能在22.13加载现安装better-sqlite3后推定受支持（已观察该组合独立open也SIGSEGV，根因未定）。

## 配置与初始化

将 `examples/config.example.json` 复制到仓库外，替换占位字段。凭据由管理员私下从**准确来源**供应；不能从 Uniflo 文本或脚本正文导入身份。示例 token 是无效占位，不可直接运行。来源服务端配置使用 `publish`；Uniflo 模式必须仅有 publish，不授 reply/deliver。

配置和 spool 使用已存在的 0700 私有父目录，普通文件 0600、服务 UID 所有、非 symlink/hardlink；Windows ACL 未实现，拒绝而非伪称可用。示例路径不是私人部署位置。

```sh
install -d -m 700 /private/app-connector
# 安全编辑 /private/app-connector/config.json，chmod 600；禁止把 token 写入共享终端日志
node connectors/src/cli.mjs init /private/app-connector/config.json
node connectors/src/cli.mjs enqueue /private/app-connector/config.json /path/to/operation.json
node connectors/src/cli.mjs status /private/app-connector/config.json
node connectors/src/cli.mjs flush /private/app-connector/config.json
# 持续出站；SIGTERM/SIGINT 取消本连接器请求、关本库，保留原 pending/unknown
node connectors/src/cli.mjs run /private/app-connector/config.json
```

`enqueue` 不联网，成功后才表示本地持久；输入文件只读，不执行其内容。`flush` 每次至多 100 包，常驻每轮继续。`observe` 单独做一轮快照／流采集，不发事件服务 POST；流断开以失败退出且持久 disconnected，供隔离诊断。`run` 会持续重连；事件服务不可达时只要仍有本地容量，就可继续观察；已知背压则先处理旧传输并暂停新采集，不轮询来源、不递增观察代次。已保存传输仍保留，flush成功不承诺腾出新准入额度。

配置固定服务根、owner、actor、source、epoch、installation 及 token 摘要；Uniflo origin／选择／token 摘要也固定。更换这些字段不能接管旧 spool。不得为了绕过阻塞换 ID、身份、新 spool 或服务根转投原未决内容。轮换与旧 spool 备份恢复尚无自动接续工具；先停发送并按原 ID／服务权威事实对账，不删除旧库。旧快照不能证明现在没发布过。

HTTP 只显式允许公网 HTTPS 根；开发 HTTP 需 `allow_loopback_http:true` 且准确 IP 回环。Uniflo 只接受固定 IP 回环 origin，不使用 DNS／任意 callback URL，不跟随重定向；token 仅在 Authorization。管理员批准的服务根及其 TLS 是信任边界，不宣称客户端能防恶意服务器。

## 绑定协议，不能降级

需要服务端 `backend-next-source-binding`：

1. GET `/v1/source/self` 严格协议 `binding_protocol:1`，核准确 owner/actor/source/epoch 与当前 publish。404／旧协议／错身份零 POST。
2. 每个 POST 同时固定携带 header `x-notionapp-source-binding` 和 JSON `source_binding`，值为小写 SHA256（UTF-8 `JSON.stringify([owner_id,id,source_id,source_epoch])`）。producer 不可自选此字段。
3. 服务端实际同步门重读当前认证并核绑定，先于原事务／旧幂等回执；然后剥离传输字段，不改变旧业务幂等摘要。GET 不是写许可。
4. 即便预检后到达旧版，旧严格 schema 仍因额外正文绑定字段 422、零业务写入；**不能删字段或只保请求头降级**。

正文固定后才发请求，注入字段后的完整 HTTP 包仍 ≤65536 字节。断网、5xx、ACK 丢失或本机记录失败，只能用完全相同的路径／ID／正文重放**服务端数据库发布**，不代表外部动作可重试。4xx／版本冲突持久 blocked，FIFO 后续不越过阻塞；不会按新版本自动 rebase。回执须准确关联原 event/version 才记录保存，不凭 HTTP 200 标来源收件。

## 脚本／自动化输入

见 `examples/create.json`、`examples/update.json`。顶层只允许 `id,kind,payload`，update 另需准确 `event_id`。payload 沿用事件服务字段／交互／期限合同，额外字段拒绝。create 固定原 session_ref、target_revision；update 固定原 expected_event_version。稳定 producer ID 的同内容重入队返回原状态，异内容冲突；不是按相同文字永久去重。

没有 Webhook 入站、任意 URL／shell／工具插件执行或命令领取接口。脚本可以创建可回应卡片，但回应仍留服务端，只有原合同下已核实的来源执行门才能交付；本连接器不把 HTTP validate、read_responses、Uniflo 观察或 `/send` 当 AI 输入权。

## Uniflo 只读与断流边界

独立按公开协议实现，核对 `Crosery/uniflo@4dbda948068e2f8ce288dc2c2e56777ca88274e0`：
[API](https://github.com/Crosery/uniflo/blob/4dbda948068e2f8ce288dc2c2e56777ca88274e0/docs/api.md)、[schema v1](https://github.com/Crosery/uniflo/blob/4dbda948068e2f8ce288dc2c2e56777ca88274e0/docs/schema.md)。上游 MIT，未复制其代码、二进制或私人材料；本项目许可证仍由用户另定。

每次启动／重连先 GET health/schema=1，再 GET 各**显式 key**快照；不扫描 sessions/discovery 或历史消息。首连为每个明确选择建一张只读基线卡，后续同事件追加。session_ref 为安装绑定派生不透明引用，不是写回定位证据。

按每个快照 `x-uniflo-seq` 水位，以最小水位订阅；hello 是当前 head，不可据它跳过其后的 replay。按各来源水位去重；过滤导致全局跳号不是必然丢包。水位／metadata／outbox 同事务；新轮次不预清原maps水位，已知近满先背压；低seq重基线只在当前代次的首次成功snapshot事务接受，同代live仍不回退。满队列不越过未保存观察。未知 v1 类型忽略，UTF-8 分块有界解码，超长／非法／不完整行断流。

lagged、daemon 回退、EOF、元数据缺失／404 后的 event、解析失败都持久记录 gap/disconnected，下次重新快照；新快照只能补当前状态，**不证明丢失期间每条历史已恢复**。idle／turn_end 不是停工或完成，removed 只追加观察，不删服务事件，不重开用户完成／停止跟踪。上游 snapshot/seq 原子性和 replay 完整性仍依赖固定上游合同；真实公开daemon的有限复现矩阵见下文，不扩展为私人会话或所有harness支持。

## 真实公开 daemon 隔离复现（opt-in）

```sh
UNIFLO_BIN=/absolute/path/to/verified/uniflo npm --prefix connectors run uniflo:real
# 指定另一已核官方Node工具时直接运行同一runner，不加载backend/native addon：
UNIFLO_BIN=/absolute/path/to/verified/uniflo /absolute/path/to/node test/real-uniflo-runner.mjs
# 上一行在connectors目录运行；仓库根则用 connectors/test/real-uniflo-runner.mjs
```

`UNIFLO_BIN`必须是官方v0.2.6 Linux x86_64 musl二进制，完整SHA256 **`e5d8c89633bac3f08d7f3a2ef8dec702579aceaf63878b79bc254c4894e7c996`**。对应[官方归档](https://github.com/Crosery/uniflo/releases/download/v0.2.6/uniflo-0.2.6-x86_64-unknown-linux-musl.tar.gz) SHA256 **`3787f11f7a46581a86eb6101dd9b5905ad0a28d80cc96ae2806d16a62b631973`**，同release SHA256SUMS核对；固定表在 `test/real-uniflo-artifact.mjs`。不自动下载、安装、运行setup/update或安装脚本，二进制及其第三方notice不进本仓库。

这是Linux专用测试，不是用户生产daemon管理器。需要可用的 `/usr/bin/bwrap` 与源码中列明的必要系统库布局；工具缺失、摘要不符、隔离不成立或测试失败均非零退出，**不skip／不fallback到宿主运行**。实际环境矩阵限定WSL2 Linux6.6 x86_64、bwrap0.11.1、官方Uniflo上述二进制、Node22.13.0／22.23.2及自写Claude/Codex JSONL布局；不是所有Node／发行版／macOS／Windows支持声明。

runner新建0700合成case，只挂精确公共Node／必要库／固定Uniflo／源码allowlist副本；新user/mount/PID/proc/net/IPC/UTS及固定hostname，网络只有内部loopback。宿主home/mnt/项目／部署不挂入，环境clearenv，root/proc/dev/程序只读，工作与临时数据都在新case。外层先故意让自己的合成canary进入worker stdin/fd3；worker再只向bwrap提供 `/dev/null` stdin及新的有界stdout/stderr管道，内层实核canary inode不可见。daemon同样不继承宿主FD/环境；隔离断言失败不会继续启动daemon。

实际前台daemon固定read-only/no-cache/no-update-check/no-price-sync/no-fts，随机测试Bearer只在私有env/请求头。test-only的准确synthetic transcript GET校验两个decoder的Unicode，以及带正确Bearer/写header的空cleanup-plan只读403对照，不是连接器新增历史读取／写入能力。连接器实际请求仍只有health／显式snapshot／NDJSON。

覆盖快照之间真实文件变化、实际hello/backlog与不同水位、两种格式实时追加、未选择来源、纯metadata隐私、正常断流／同spool重启、只杀自己准确child的SIGKILL故障后非主动abort的gap／再次重启。原映射只追加current snapshot，不把离线期间全部历史补称连续。上游SIGINT采用graceful drain：runner发送SIGINT后显式取消自己的长流再等正常退出；不会将超时后的SIGKILL伪装为graceful成功。

**发布接收器只是内部合成HTTP协议夹具，不是实际backend／独立来源回执。** 原backend接缝验证另见其入口和项目路线；本测试不在22.13加载better-sqlite3，不代表AI/Claude/Codex程序实际运行、live-PID附着、模型／工具执行、33种harness、真实用户会话、手机或生产。case资料留在测试输出的私有临时目录；仅源码/安全合成fixtures可公开，不上传raw日志、spool或工具。

## 容量、崩溃与诊断

- 未显式升级的v1：最多16个明确Uniflo选择、累计10000个操作（含saved/blocked）、**8MiB逻辑保留预算**；SQLite页上限按实际page_size折算32MiB，主库/WAL/SHM/journal各32MiB检查。每行按实际UTF-8 payload、至少payload+256的未来wire、至少1024的ACK、映射及行余量保守收费，另留binding/meta/map余量；不是当前文件大小或能同时装满各上限的保证。v1的WAL/journal距硬边界不足1MiB即保守停止写入，不手动删/截WAL、不猜checkpoint成功；真正存储失败可使已有传输也暂时不能处理。
- 新准入在IMMEDIATE事务内核准，满时旧同ID同内容仍可按原耐久屏障对账，异内容仍冲突。新逻辑限额不挡已有eligible prepare/原wire重放/准确ACK保存；过新预算的合法v1库保留为retained_over_limit，不清旧事实。容量投影是预测，具体包仍由事务核准；v1 CLI固定产品限额，库的更小测试限额仅当前实例；v2重开/诊断消费持久存储policy，不能由producer/来源文本修改；观察另按每个所选来源16KiB与一个行位保守预留，近满即暂停，不反复开始注定放不下的新轮次。没有GC/VACUUM/自动新库；v1仍可能一直耗尽，v2可用下述显式维护回收工作额度/有限扩容。跨文件迁移/轮换、保留期仍是后继，不可删pending/unknown/旧映射/已用事实来恢复。
- 配置／producer 读取本身最多分配并读取限额+1字节，即使 fstat 后文件增长也不全量读入。正文 65536 字节，响应回执／self 各 4 KiB，snapshot／NDJSON 行各 64 KiB。HTTP 5 秒，单观察流 60 秒后按 gap 重连。没有永远在线／完整历史恢复承诺。
- 单写者独占 `.lock` 贯穿异步 flush／observe；同一库实例的并发flush或observe明确拒绝，旧轮次错误收尾不覆盖新代次，迟到／重复旧ACK也不覆盖较新映射。实际 SQLite 关闭成功才释放 lock（重复 close 幂等，不依赖新版本 isOpen getter）。正常关闭释放；SIGKILL 残留保守拒绝。操作员必须先**正面核实原精确进程已退出且无使用者**，保留原库后仅移走其旧 lock；本程序不根据 PID 重用／不存在或超时自动抢锁。测试只在已观察自有 child SIGKILL 后显式移除夹具锁。
- 未知 appID／schema／损坏库、空既有文件、路径替换与权限不符拒绝；不清库、不创建替代身份。配置／目录和同账户管理员是信任边界，不宣称抵御恶意同 UID 修改。
- `status`用独立SQL只读连接，不取/移除写者lock、不建缺库、不联网，在同一read snapshot先验格式/binding再输出≤8KiB聚合（计数、保留/实际payload-wire-ACK字节、限额、首未结项、观察与文件stat）。文件stat是附近时点，不与SQL提交全局原子；lock只报present/absent、不证明存活。无合法当前存储标记时超32MiB仅stat；合法当前v2标记仅允许256MiB以内有限打开，仍须SQL核格式/完整binding/policy，超绝对界仍仅stat、scope_validation:not_checked/业务null/0 SQLite打开。错误身份/格式/路径/权限非零拒绝。SQL只读可能使用/新建私有SHM，不是物理零写取证工具。
- 诊断标diagnostic_only:true/persistence_ack:false：可读saved行不证明本次目录fsync或来源在线，不补发持久ACK，不授当前发送/回应/执行权。原保存/重复回执仍走写者耐久屏障。终端仅固定原因，不输出token/摘要、原URL/key/正文/路径或上游/SQL异常；run分别按采集/发布/容量阶段及原因抑制重复日志，只由对应阶段实际成功重置；新采集不伪造发布恢复。blocked/unknown须按原ID/原目标对账；没有reset/force/clear按钮。

## 长期使用：显式本地存储维护

v1普通运行/init**不自动迁移**。显式init只有整组确无旧材料才可新建：main缺失但WAL/SHM/rollback-journal/storage任一残留（包括坏类型或悬空链接）即在创建main/打开SQLite前以ORPHAN_SPOOL_FILES拒绝，原组保持；已有lock仍拒绝，不删除/自动重接孤组，不用init当恢复工具。维护只针对config中的同一私有原文件、原binding与writer lock，0HTTP/模型/原生输入；先正常停止你自己准确的连接器，不是Uniflo/真实harness/生产服务。已有run持锁时维护拒绝，不抢锁、不杀进程。备份的当前性不是本工具能证明的，不把旧备份当当前库接续，也不要用换路径/新ID/移除标记假恢复。

```sh
# 显式升级当前原文件；不改原queue/maps/observer和原ID/wire/ACK
node connectors/src/cli.mjs upgrade /private/app-connector/config.json
# 严格JSON选项示例：max_rows 1..100, include_blocked false（默认仅归档saved）
node connectors/src/cli.mjs archive-plan /private/app-connector/config.json connectors/examples/archive-options.json
node connectors/src/cli.mjs archive /private/app-connector/config.json connectors/examples/archive-options.json
# 可选：四项逐项只增/相等，实际持久policy见status；示例不是无限扩容
node connectors/src/cli.mjs resize /private/app-connector/config.json connectors/examples/storage-limits.json
node connectors/src/cli.mjs status /private/app-connector/config.json
```

v2还是一个私有SQLite传输命名空间，新增archive表：**全部十一原字段完整保留**，同事务复制/核对/移出工作queue，不遗忘ID/指纹/原包/receipt。pending/unknown绝不归档。相同ID/内容在两表返回原状态，异内容冲突；序号取两表全局max+1；旧ACK不倒退map。`include_blocked:true`可回收其工作额度，但blocked仍在全局FIFO阻断后面发布，**不代表已保存/可以跳过/可以改目标重试**。没有解除阻塞/清事实按钮。

- 初始工作额度10000行/8MiB保留费，archive独立100000行/64MiB完整事实费；resize硬顶分别100000/32MiB、1000000/128MiB，字段必须正安全整数且只增。Archive费用含实际UTF-8全部字段及固定索引余量，不再给终态虚留未来wire/ACK；counts是两表全历史，capacity.usage.operations是工作行位，archive单列，不把搬走当没发生。
- v2页/各文件硬界256MiB，普通写者保守16MiB WAL/journal余量。维护每次先用SQLite自己的TRUNCATE checkpoint并核0/0/0；读者阻塞就报告MAINTENANCE_BUSY，不驱逐读者/不手删WAL。归档再按实际批次、页尺寸/编码的保守写放大估计限制批量，可能少于max_rows；preview给所选费用/释放工作费/事务物理余量，apply重算，不接受preview当预留票据。归档释放的是**工作额度和可重用页**，不保证文件变小，不做VACUUM/压缩。各预算先到者停止，不能保证同时填满/永远有磁盘空间。
- `.storage`是≤4KiB的私有格式意图，绑定当前原db dev/inode/原binding摘要：先持久upgrading才提高页界/提交v2，SQL和目录耐久后才ready。它不是来源授权/业务账本；标记正确仍要核SQL。过渡只可诊断/明确upgrade恢复，不能普通发布；坏/缺/错scope/inode/矛盾状态拒绝，不自动覆盖。旧003遇真正v2拒绝，不要以旧程序/删除标记接续。普通新命令也不提供导入、还原、轮换或替代路径。
- 维护COMMIT后本机屏障失败可能已有事实，返回无成功并保留；新执行须按当前两表/标记实核。维护不增加request_id账本，重跑archive可能选下一批，也可能moved=0，不是第一次不可变ACK。不得为恢复外观反向回滚已提交事实。

总archive/物理界耗尽仍须保留事实、明确背压；有限工具不是无限运行/旧快照恢复保证。跨文件冷存储、备份当前性/恢复、轮换和保留期另有后继，不据此授Native输入、后台执行或生产操作权。

本轮交接指纹、004-A原BLOCK/F1、004-B限定结论与发布者双Node各92＋严格v2/archive daemon2矩阵见 [004发布说明](../docs/releases/connectors-004.md)；逐项source/public SHA256单列，不改原源表。TASK/review/raw CASE/spool/storage标记/工具/凭据均不上传；旧003及更早历史保留，当前成功不补签其他层级或暂停工作。
