# 公开状态与验证范围

本仓库为单独的公开开发镜像；未在原开发根初始化 Git，未修改或删除原资料。首次说明提交 `5a9f034`，安卓基线导入 `c9f1fc2`；完整上传历史见 Git log。这里不宣称正式发行、生产可用或完整产品通过。

## 公开源码范围

| 组件 | 冻结输入 | 本次边界 |
| --- | --- | --- |
| Android | 作者独立冻结的53文件既有基线 | 源码、合成测试/工具、依赖锁、Gradle引导、第三方声明；README公开改写；不含android-001草稿/模板 |
| Server | 实际作者从T013历史候选冻结的64文件 | 源码、合成测试、npm锁及TypeScript配置；不含T014 |
| Pi宿主 | 同一来源65文件，另明确加入1个通用renderer | 源码/测试/锁/配置；无T014受控启用；无实际部署配置 |
| 本地连接器 | 当前尚无可发布源码 | 仍在合同/规划，不虚构模块或功能 |

准确183项导入白名单、原始和公开字节哈希见 [导出清单](releases/initial-export.json)。Android来源清单SHA256为 `b02c8fd3505eaae16fd74f6e322bdd111d0d3937b4c147ecc249d0a7da7c76eb`；Server/Pi的129项来源清单为 `0a8c2ff81c91d59f603549346a24c4726f5268962fd85e2dca751cea33de7135`。新写的公开说明不在导入文件计数内。

公开适配仅为：Android README重写；Pi的`check`先build再typecheck以支持干净源码引导；通用renderer及对应合成测试将历史unit输出名改为`notifier-app-test*`。其余导入项逐字节保持；原开发目录未改。额外renderer来自同一冻结历史基线，不含其部署README。

**子集抽取、说明净化或构建适配不继承原完整候选的独审结论。** T014 C04在原项目仍未验证，不在此导出；历史148/165或后续179/225不能直接冒作公开镜像通过记录。下表只记录本次实际重跑。

## 本次验证（2026-11-01）

| 层级 / 命令 | 实际结果 | 不证明什么 |
| --- | --- | --- |
| 文件/发布自检 | 183项来源与公开hash核验；按白名单检查凭据特征、SSH/私人路径地址、设备/原生会话、固定URL/ID、运行资料/缓存；未发现需上传的私人材料 | 不是完整产品安全审计或无秘密的数学保证 |
| Gradle wrapper | JAR SHA256 `81a82aaea5abcc8ff68b3dfcb58b3c3c429378efd98e7433460610fecd7ae45f` 与官方8.13值一致；保留第三方声明 | 不替代依赖及平台许可核对 |
| Android `app:testDebugUnitTest app:assembleDebug app:lintDebug` | 显式使用JDK17/SDK35/Gradle8.13，在独立镜像缓存/输出目录成功；JVM共92项，84通过、8依赖socket夹具的测试skip，0失败 | 不把skip算通过；debug APK不发布，不证明后台/真机/生产 |
| Server `npm ci` + `npm run check` | 新POSIX验证目录安装；类型检查/编译成功，148测试通过，0失败/skip | 仅合成与本机集成，不是手机或生产 |
| Pi `npm ci --ignore-scripts` + `npm run check` | 同一公开字节、新POSIX验证目录，先Server后Pi；类型检查/编译成功，165项中161通过、4明确skip、0失败 | 4项真实ntfy软件/其安卓夹具因未提供NTFY_TEST_BINARY跳过；无模型费用、设备或生产验证 |
| Android真实本机socket合同 | 正在本次独立镜像复验，结果尚未计作通过 | 夹具是新临时身份/库/回环端口，不是物理设备或真实来源接入 |

保留真实初次失败：Android最初无JAVA_HOME/java，未进入构建；显式选择已核工具后上述构建成功。Pi干净源码初次check因两个crash fixture导入尚不存在的dist/main.js而TS2307失败；仅调整检查顺序后完整复跑得到上述结果。未隐瞒失败、删除测试或伪造skip。

发布自检保留了明确合成的fixture身份、无效示例域名、回环端口及负例路径/假凭据；它们不是私人运行标识。本次不操作ADB/AVD、物理设备、云端工作会话、收费模型、现有推送平台或生产。原始运行/测试日志保留本地，不在公开库原样上传。

## 已知依赖安全项

本次npm安装审计：Server报告0已知漏洞；Pi报告2个中危受影响节点（`minimatch`及依赖它的`@earendil-works/pi-coding-agent`），不是两条独立漏洞。实际公告为 [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)：globparts放大可导致拒绝服务，锁定minimatch 10.2.6落在 `<11.0.1` 范围；npm报告 `fixAvailable:false`。

未擅自改动已冻结SDK/lock或假称产品已不受影响。依赖修复/SDK兼容与调用面评估须后续作者处理，当前不建议据此快照直接投入生产。审计是执行时的已知公告观察，不保证以后没有新问题。

## 排除项与后续增量

不上传私人部署/SSH、私人IP/路径/人格/真实聊天、凭据和授权、设备/原生会话ID、DB/WAL/SHM、运行native/journal、推送端点、备份/密钥/邀请包、原始evidence日志/图片、APK/签名材料、AVD、node_modules、dist及Gradle/构建缓存。构建所需官方Gradle wrapper是单独核验的唯一引导JAR，不附第三方APK/服务二进制。

后续各实际作者交付新的独立冻结白名单/哈希与准确测试、审查、在制范围，发布作者比对此清单串行增量；不从正在写入的目录盲取，不覆盖远端未知提交、不force-push。产品许可证仍未选择；[第三方声明](../THIRD_PARTY_NOTICES.md)保留，不擅自附MIT等产品LICENSE。
