# 连接器候选 A：待最终审查／待新后端集成

## 发布定位

本次只将独立冻结的 source-only 候选公开到 **`wip/connectors-candidate-a`**，基于已发布 `main` 的 `0f9489bb316f921f24ad88c949e56e84aee1358c`；不合并或改写 main，不标稳定发行，不创建正式 Release。

作者交接报告 PLAN PASS；**实现 FINAL 仍审查中，发布者没有代签或复用独审结论。新 source-binding 后端的正常集成未执行。** 即使后续作者宣布完成，也须绑定新的准确冻结文件/哈希及适用审查范围，不能自动迁到本候选字节。

## 准确范围

- 20项白名单：Node.js CLI/库、合成/CLI/进程故障测试、隔离后端测试工具、package/lock、占位配置与合成事件示例、组件README/.gitignore。
- 原始清单 SHA256：`f9646ff838ff0dda7100131c4b75da58d9a9e6a1f72051e48ca551321c0338fe`。
- [逐文件原始/公开哈希](connectors-candidate-a.json) 独立保留，不覆盖 [首轮导出清单](initial-export.json)。只有组件README增加候选警告与公开状态入口，业务源码、测试、示例、依赖锁逐字节保持。
- 未读取或修改活跃连接器源码，不修改Server/Pi/Android产品文件。不包含其他系统在制代码、实际配置/身份/会话/数据库/推送端点/部署、raw evidence、产物、依赖和缓存。

## 发布者实际复验

在全新隔离POSIX目录，使用相同冻结源码、空HOME及新TMPDIR，不加载私人配置：

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

待补：新绑定后端正常/拒绝/丢ACK集成、最终独立复核、真实Uniflo daemon/harness、Android/物理设备、生产及完整A15/A16/A29。观察、服务保存、来源收件、执行与验证继续分层；本连接器没有AI输入/命令领取/回复交付能力。

发布本候选不授予实际Uniflo/云端/设备/收费模型或生产操作许可。产品许可证仍未选择；上游Uniflo公开协议引用及其MIT说明保留，未复制其代码、二进制或私人资料。
