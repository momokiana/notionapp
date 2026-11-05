# connector-003-B：8MiB保留预算、只读诊断与安全背压

本次在已公开002提交 `067021094ae65511a8335a77b47794358beebabf` 上增量到独立分支 **`wip/connectors-003`**：30项准确source-only，较002 **3新增／7修改／20同字节／0删除**；lock、transport、validation不变。**main仍`0a745c88fbba495f145263e5384af24215c394b2`，不合联合主线、不创建正式Release，不触暂停核心或生产。**

## 暂停后的准确恢复，不冒充旧快照仍在

- 暂停前的原作者、原独审、原公开导出三个临时目录已失效；本次没有使用它们，也没有从活树取未验字节冒充旧候选。
- 原作者提供了明确的**新恢复重建导出**：先核持久原31项候选清单及原review指纹，再确认对应31项字节全部匹配，复制到新验证副本并首末复核。发布者独立核31项重建副本与原清单一致，从中只消费30项源码，不复制TASK。
- 原31项清单SHA256 `287e20c51fa4866fc1475a75d188997e5823ed20a04d265b4b3cc68caa2ac40b`；原30项源表仍为 **`8ce77962b0424acd961316551956dc77728338ceab4495aeb2cddc04e21619d0`**，不是一个新版本或重新审查结果。
- 同一独审原§7的限定FINAL PASS仅属**003-B**：review SHA256 **`77df68b1f41869d6200f407aa1fbed4d0cfc6599dd5dd7d6a3d585cdf6c31b56`**；TASK SHA256 `99691e3e5eea0371a410f0fbddfdc256608b2b9c24f5d5e339bb2ec6fb11ecf2`。发布者只核指纹和消费矩阵，不重审/重派已通过任务、不代签产品独审，不复制原TASK/review上下文。
- [当前30项source/public哈希和delta](connectors-003.json) 单列。组件README只加公开banner/范围与N1，29项其余文件与恢复导出逐字节保持，源表未改。公开30项表SHA256为 `79583997ddadc2d41dca928de8b8984c3b0ff8c3b1c575efa69ab825ea4a13ca`；README源哈希 `5f755257ed209e288d0d3da30d13289f5500df5a4753db3bc072da7bf7521afe`、公开哈希 `40de6cd40de8d60eedd920ef9075592aa094db3d93e30b5f6abe7e54032f61f1`。两表均可按JSON文件数组顺序将对应SHA＋两空格＋路径＋LF重建；不含新写release/root说明，不能把公开改写哈希冒作原源哈希。

## 能力与正确性边界

1. 固定累计10000操作（saved/blocked也计入）和 **8MiB逻辑保留预算**。按实际UTF-8 payload、未来wire/ACK、map/meta及行余量保守保留；真正准入仍在IMMEDIATE事务内核验，不是文件大小或所有上限可同时装满的保证。
2. 逻辑满不主动阻断eligible旧包prepare、固定wire处理、准确ACK保存；合法v1旧库超新预算只标`retained_over_limit`，不删事实、不迁移schema。物理FULL/EIO或WAL余量不足仍可能停住旧传输，不能假ACK。
3. 观察近满先背压，不轮询来源或刷generation/游标；新轮次不预清旧map水位，只有当前代次首次成功snapshot才原子重基线，流内不回退，旧错误收尾不覆盖新代次。
4. `status` 独立SQL只读连接，在同一read snapshot验证格式/binding及聚合，输出≤8KiB。文件stat是附近时点，不与SQL提交全局原子；lock只表示present/absent，不证明进程存活。超物理界只stat、不打开SQLite，业务计数null、scope未核。
5. **只读诊断不是物理零写取证**：SQLite可创建/使用私有SHM。`diagnostic_only:true`、`persistence_ack:false`；SQL里可读saved行不证明本次fsync或当前授权/来源在线，不补耐久ACK、输入权或执行许可。
6. run分别抑制采集、发布、容量阶段的重复固定原因；只有对应阶段实际成功才重置其警告，采集进展不能冒充发布恢复。没有GC、迁移、凭据轮换、reset/force/clear或新库恢复工具；flush不保证腾出额度。

后续容量扩展/迁移/归档和旧快照恢复仍须另行准确设计，保全原ID、payload/wire/目标/回执/map/version/digest/watermark及pending/unknown，不得换库、清表、删事实或改绑身份来制造恢复。此页不新增这些功能或治理门。

## 失败历史与限定关闭

**003-A仍BLOCK/F1**，不能因其旧50项普通/2项daemon绿而迁为通过。该F1是run日志阶段错误重置：发布持续失败时不能由新采集进展反复重新打警告；不要与更早001-A的F1–F3或其他系统F1混淆。

正式交接报告：003-B仅在A的CLI、容量测试与README作普通修复，其余27项源码同字节；同一独审核原反例三模式，连续self503或POST503各仅1次发布警告，真实发布恢复后再次失败出现2次，原wire/unknown/pending保留。发布者没有导出或重审003-A，也不冒称对未收到的旧A逐文件复核；本次53项实际消费包含这三种受控模式。

更早 [001-A BLOCK历史](https://github.com/momokiana/notionapp/tree/wip/connectors-candidate-a)、[001-B限定结论](https://github.com/momokiana/notionapp/tree/wip/connectors-candidate-b)和[002固定daemon限定验证](connectors-002.md)保持原提交/原哈希，不回写为003结果。

## 本次分层复验（2026-11-05）

| 执行方 | 准确范围 / 结果 | 不能扩大为 |
| --- | --- | --- |
| 原作者/同一独审交接 | Node22.13.0、22.23.2各普通53/53、严格固定daemon2/2；独审另各6组旧库/UTF-8/stat-only及原F1三模式 | 发布者没有重跑私有独审额外脚本或代签§7 |
| 发布者来源/安全自检 | 持久原31表、review指纹、重建31字节与30源表逐项核验；独算3/7/20/0；扫描凭据、SSH、私人路径/IP、真实会话/设备ID、运行材料及许可边界，未发现需公开的私人材料 | 不是新的产品独审或绝对无秘密保证；仅使用重建冻结导出，不取活树 |
| 发布者普通矩阵 | 新持久POSIX验证副本、空HOME及新TMPDIR；两个Node各源码语法检查＋**53/53，0失败/skip、命令退出0**；安装报告0已知漏洞 | 只属于准确003-B本地层，不是后端、手机、生产或持久化事故全覆盖 |
| 发布者严格daemon | 两个Node各**2/2，0失败/skip、runner退出0**；固定官方Uniflo0.2.6、Bubblewrap0.11.1、WSL2 Linux6.6.87.2 x86_64；新CASE、无宿主fallback | 真实daemon读两种合成Claude/Codex JSONL；发布接收器仍为合成HTTP夹具，**不是实际backend/native receipt** |

保持固定制品约束：Uniflo Linux x86_64 musl，18720856字节，SHA256 `e5d8c89633bac3f08d7f3a2ef8dec702579aceaf63878b79bc254c4894e7c996`。恢复后的官方Node22.13工具已核原binary SHA256 `af8d5d1e234beb26b3095e6bebf80edc781f79c9435553a383037eccec2716f8`；发布者未执行安装器或修改全局运行时/依赖。隔离工具缺失、摘要错误、隔离拒绝均失败，不skip、不降级到宿主；原始日志、CASE、spool、工具均留在公开树之外。

```sh
npm --prefix connectors ci --ignore-scripts
npm --prefix connectors run check
UNIFLO_BIN=/absolute/path/to/verified/uniflo npm --prefix connectors run uniflo:real
# 另一已核Node使用同一普通测试/严格runner，绝不在22.13加载backend native
```

## 未覆盖与发布排除

N1不变：后端只记录22.23.2已验证组合；当前安装better-sqlite3在官方22.13单独open亦SIGSEGV，原因未定，不能迁用connector内置SQLite绿证。backend自身原FINAL未知/原拒绝不重试、不换通道或提供方，**不因003通过合联合main/正式Release**。

无实际宿主ENOSPC/断电、私人harness/model/live-PID、全部OS/FS/33种harness、手机/推送/生产、完整A25/A26/A29结论；测试中的SQLite FULL/注入EIO/文件stat边界不冒充物理断电实验。source保持publish-only、0原生输入/执行权。

只上传明确30项源码和安全说明；TASK/review/raw evidence、CASE/spool、工具binary、私有配置/授权/凭据、实际会话与部署资料不上传。许可证仍未选择，原上游/第三方许可声明保留。不恢复全产品发布，也不触暂停核心；后续只消费当前获准两线的准确通过增量。
