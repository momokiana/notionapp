# 事件与回应服务（开发快照）

Fastify 5 / TypeScript / better-sqlite3；单进程 SQLite 持久账本。公开源码来自作者单独冻结的 T013 历史基线，不含后续 T014 受控启用在制代码，不继承原完整候选的测试或独审结论。

## 本地构建与启动

当前公开后端只报告 **Node.js 22.23.2、POSIX/Linux（WSL）隔离环境** 的实际验证，npm 10+。`package.json` 的 `engines.node >=22` 是原包声明，不是逐版本支持承诺；不改包/lock来假称补齐矩阵：

```sh
cd server
npm ci
npm run check
npm run dev
# 或 npm run build && npm start
```

`check` = 类型检查 + 合成自动化测试 + 编译；首次安装需能编译或获取 better-sqlite3 的本机模块。**N1：开发/独审同步，当前安装的 better-sqlite3 13.0.3 native 二进制在官方 Node 22.13.0 下连单独 open 也 SIGSEGV；原因未定，不支持该后端或同进程 integration-runner 的22.13组合。** 这不是发布者新复现或所有平台的结论；连接器用内置 `node:sqlite` 的22.13通过不构成本后端证据。原锁包/依赖不变，完整边界见 [运行验证矩阵](../docs/status.md)。

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | 默认只回环 |
| `DATABASE_PATH` | `./data/app.sqlite` | 私有持久账本，不用 `:memory:` |
| `AUTH_FILE` | `./data/credentials.json` | 私有认证注册表，受保护请求重读 |
| `DEVICE_AUTH_PATH` / `DEVICE_AUTH_STORE_ID` | 未配置 | 可选显式初始化的设备认证库及原 store ID；必须同时匹配 |
| `PUSH_ORIGIN` | 未配置 | 可选自托管 ntfy HTTPS origin，无路径/账号/query |
| `PUSH_TOKEN` | 未配置 | 可选私有发布 token，不发送手机、不写日志 |
| `PUSH_ALLOW_LOCAL_HTTP` | 未配置 | 仅 `1` 明确允许隔离回环 HTTP 测试 |

`GET /health` 只报告存储可查询，不验证手机、认证配置、来源输入或推送。没有默认凭据或 AI 输入主机；缺认证配置时 `/v1` 安全拒绝。不要直接暴露到公网，正式部署另需 TLS、ACL 与适用验证。

## 私有认证

`AUTH_FILE` 的严格 JSON 结构为 `principals` 数组。用户项含 `id,kind:"user",owner_id,token`；来源项另含 `source_id,source_epoch,capabilities`。token 须为密码学随机生成的32字节小写hex，不提供共享默认值。以下只表示字段，不是可用配置：

```text
principals:
  user:   id + owner_id + independently generated token
  source: id + owner_id + source_id + source_epoch + token + explicit capabilities
```

能力为 `publish/read_responses/reply`，来源交付另需明确 `deliver`；`reply` 不自动授予 AI 输入。来源重装/改绑须新代次。各设备与来源使用不同凭据；同 token 复制到两台手机不算独立设备。

文件/父目录必须私有；POSIX 要求同 UID 普通非链接文件及受限权限，建议0700目录/0600文件。Windows ACL未完成原生部署验证，设备认证库等POSIX工具不会假称支持。凭据、邀请包、推送端点、DB/WAL/SHM、journal 和备份都不可提交。

可选设备生命周期：构建后 `node dist/device-cli.js init --path /absolute/private/authority.sqlite` 显式创建新认证库，依原输出设置 `DEVICE_AUTH_*`。邀请/轮换/撤销及静态接续以 `src/device-cli.ts`、`device-routes.ts` 为准；不要以新邀请/新 token 绕过原未决操作。

## HTTP 合同导航

以下为实际代码入口，不是冻结的未来全产品协议；严格字段和错误以对应 schema 为准：

| 领域 | 路由 / 实现 |
| --- | --- |
| 事件 | `POST /v1/events`、`GET /v1/events`、`GET /v1/events/{id}` |
| 原事件更新 | `POST /v1/events/{id}/updates` |
| 回应与历史 | `POST /v1/events/{id}/responses`、`GET /v1/responses/{id}`、`GET /v1/events/{id}/history` |
| 已读/事项决定 | `PUT /v1/events/{id}/read-state`、`POST /v1/events/{id}/disposition` |
| 来源命令/关联收件 | `src/delivery-routes.ts`、`delivery.ts`；没有通用HTTP execute入口 |
| 设备配对/生命周期 | `src/device-routes.ts`、`device-authority.ts` |
| 推送登记/分层回执 | `src/notification-routes.ts`、`notifications.ts` |
| 来源运行观察 | `src/source-runtime.ts`；只读，不触发模型或授予执行权 |

请求用各自主体的 Bearer token 认证。用户身份来自认证，不取正文；来源只看自身当前代次。事件/交互版本、期限、当前权限和准确目标由服务核验。回应/占用/历史/幂等事实同事务保存，异内容复用 ID 拒绝。

同原 ID/正文的幂等重放只返回原事实；超时/5xx/401/404不证明未执行。来源命令 unknown 不因重启、租约或换渠道自动重发；独立原生门只由明确拥有的适配器实现，见 [可选 Pi 宿主](../pi-host/README.md)。

事项暂停/完成不取消已发生或在途外部效果。来源自报结果不是执行或独立验证；已读、通知、来源收件分别记录。

## 存储与恢复

普通运行采用已识别事件 v3 / 设备权限 v1；拒绝未知库和不受支持布局，不清空修复。不要复制正在写入的 SQLite 主文件当一致备份。离线恢复只由专用工具在新派生材料中安装冻结格式，不提供 thaw；旧 token、旧预算与未知记录不构成当前运行授权。

测试使用新临时身份/凭据/数据库及本机端口，含事务、撤销、版本、并发、崩溃与幂等相关用例；不操作既有部署，不证明手机/云端/生产通过。此次发布的实际验证见 [公开状态](../docs/status.md)。

## 第三方

直接运行依赖：Fastify（MIT）、better-sqlite3（MIT）；SQLite 采用其上游 public-domain 声明。精确版本/传递依赖见 `package-lock.json`，完整许可见相应 npm 制品；本仓库不发布依赖二进制。产品许可证尚未选择。
