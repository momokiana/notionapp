# 连接器候选 A：FINAL BLOCK（F1–F3）

> **最终独审已阻塞，不得作为通过候选使用、合入 main 或部署。** 本分支保留 A 的原业务源码与历史发布提交 `ccd5eb579478f50636e39f182addfef0e8192254`；只更新公开警告与状态，不用 B 替换 A，不重写历史。

## 最终独审缺陷

用户同步的实际最终独审结论为 **FINAL BLOCK**，不是仍待审，也不是 PLAN PASS 可以覆盖的实现通过：

| ID | 阻塞缺陷 |
| --- | --- |
| F1 | 并发数据库 flush 的迟到 ACK 可使状态回退 |
| F2 | 最低支持 Node 22.13 正常 close 漏句柄 |
| F3 | fstat 后文件增长导致无界读取 |

发布者仅整理这一真实审查结论，未冒称独立重跑原审查 probe。此前30项及旧后端拒绝1项的通过记录保留为历史事实，但不覆盖上述缺陷、不构成 FINAL PASS。此轮仅改发布说明/状态，未以重跑旧测试否定 BLOCK。

作者另有修复候选 B 正由同一独审复核；发布者尚未收到可替换 A 的准确新白名单与最终结论，因此本分支没有 B 的代码、回归或测试通过声明。B 的结果不能迁给 A；新后端正常集成仍待其稳定候选。

## 发布定位

本次只将独立冻结的 source-only 候选公开到 **`wip/connectors-candidate-a`**，基于已发布 `main` 的 `0f9489bb316f921f24ad88c949e56e84aee1358c`；不合并或改写 main，不标稳定发行，不创建正式 Release。

首次公开时作者交接报告 PLAN PASS、FINAL待审；本次已按实际最终结论更新为 **FINAL BLOCK（F1–F3）**。新 source-binding 后端正常集成未执行。即使后继候选通过，也须绑定新的准确冻结文件/哈希及适用审查范围，不能迁到本候选字节。

## 准确范围

- 20项白名单：Node.js CLI/库、合成/CLI/进程故障测试、隔离后端测试工具、package/lock、占位配置与合成事件示例、组件README/.gitignore。
- 原始清单 SHA256：`f9646ff838ff0dda7100131c4b75da58d9a9e6a1f72051e48ca551321c0338fe`。
- [逐文件原始/公开哈希](connectors-candidate-a.json) 独立保留，不覆盖 [首轮导出清单](initial-export.json)。只有组件README增加候选警告、BLOCK更正与公开状态入口，业务源码、测试、示例、依赖锁逐字节保持；不把说明更正当源码修复。
- 未读取或修改活跃连接器源码，不修改Server/Pi/Android产品文件。不包含其他系统在制代码、实际配置/身份/会话/数据库/推送端点/部署、raw evidence、产物、依赖和缓存。

## 发布者此前实际复验（历史，不能覆盖 FINAL BLOCK）

以下是首次公开前在全新隔离POSIX目录的实际结果，使用相同冻结源码、空HOME及新TMPDIR，不加载私人配置；没有覆盖F1–F3，不能推导A可靠或已修复：

| 命令 / 检查 | 结果 | 限制 |
| --- | --- | --- |
| 原始清单与20项SHA256 | 全部一致；逐项路径、普通文件/无符号链接核对 | 只绑定这份快照 |
| 安全发布自检 | 核查凭据特征、SSH、私人路径/IP、固定端点/ID及运行/缓存资料；保留明显合成的占位数据 | 不是产品安全审计或FINAL review |
| `npm --prefix connectors ci --ignore-scripts` | 成功；无第三方运行依赖，npm报告0已知漏洞 | 不是全产品依赖结论 |
| `npm --prefix connectors run check` | 语法检查及30项测试全部通过，0失败/skip | 合成协议、真实CLI/本机进程故障层，不是新后端集成 |
| `node connectors/test/integration-runner.mjs <published-T013-server-copy> --legacy` | 1项通过，0失败/skip | 实际Fastify/SQLite旧后端缺协议时零事件写入、绑定POST拒绝；**不是新协议正常发布通过** |

旧后端测试使用与先前公开Server源码一致的独立副本及其测试依赖，工具自身再次按源码/package白名单创建scratch；未构建或改写活跃后端。原始日志/运行材料保留本地，不原样公开。

## 关键不兼容与未验证项

连接器要求 `GET /v1/source/self` 的 `binding_protocol:1`，以及每个写入实际同步门的 `source_binding` 核验。本候选分支继承的公开T013 Server没有该新合同。因此当前正确行为是 fail-closed，而不是删字段、降级或换身份发送；普通 `npm run integration` 不能在此旧后端冒作成功。

候选A的最终独审已明确BLOCK，不再写成仅“等待最终复核”。后继交付仍须修复并复核F1–F3、提供准确新冻结字节与适用最终结论，再补新绑定后端正常/拒绝/丢ACK集成；真实Uniflo daemon/harness、Android/物理设备、生产及完整A15/A16/A29也未验证。观察、服务保存、来源收件、执行与验证继续分层；本连接器没有AI输入/命令领取/回复交付能力。

发布本候选不授予实际Uniflo/云端/设备/收费模型或生产操作许可。产品许可证仍未选择；上游Uniflo公开协议引用及其MIT说明保留，未复制其代码、二进制或私人资料。
