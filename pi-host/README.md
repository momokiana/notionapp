# 可选独立 Pi App 宿主（开发快照）

在一个 Node 进程运行事件服务和**专用 Pi SDK 会话**，复用同一事件账本与精确来源交付门。不是向当前终端发送消息，不发现或接管私人聊天/工作会话，不调用渠道 `/send` 冒充 AI 输入。

本次是 T013 历史基线的源码子集；不含 T014 受控启用/接续实现，也不是完整产品发行。历史完整候选的独审不迁签本公开副本，实际验证见 [公开状态](../docs/status.md)。

## 安装与检查

包声明要求POSIX、Node.js >=22.19、npm10+；固定 Pi SDK 1.4.0 / session v3。**公开宿主/后端的实际运行验证仅记录 Node 22.23.2（Linux/WSL隔离环境）**，不把engines下限或连接器22.13的内置SQLite结果当作后端兼容证明。后端已报告的22.13 native崩溃组合不受支持，原因未定；详见 [运行验证矩阵](../docs/status.md)。先构建同仓库 server：

```sh
npm --prefix server ci
npm --prefix server run build
npm --prefix pi-host ci --ignore-scripts
npm --prefix pi-host run check
```

`check` 类型检查、编译后运行源码/编译CLI相关合成测试。没有 `NTFY_TEST_BINARY` 时依赖真实 ntfy 软件的可选测试明确 skip，不计作通过。若自行核验官方 ntfy 2.34.0 制品版本/哈希/许可，可显式提供其绝对路径；测试只启动新私有 Unix socket/回环服务，不连接现有平台。

## 显式私有配置示意

以下均为虚构路径/身份；**没有凭据、不自动创建目录/授权，也不是可直接使用的部署配置**。

```json
{
  "data_dir": "/srv/notifier-example/runtime",
  "auth_file": "/srv/notifier-example/credentials.json",
  "initial_prompt_file": "/srv/notifier-example/initial.txt",
  "source": {
    "owner_id": "example-owner",
    "principal_id": "example-source-actor",
    "source_id": "example-source",
    "source_epoch": "example-epoch"
  },
  "model": { "provider": "openai", "id": "gpt-4o", "thinking": "off" },
  "model_budget": { "request_limit": 3, "output": { "mode": "protocol_tokens", "max_tokens": 16384 } },
  "allow_model_calls": false,
  "listen": { "host": "127.0.0.1", "port": 3000 }
}
```

配置/指令/授权须由操作者自行供应，同 UID、私有普通文件且无符号链接；数据及子目录0700、私有文件0600。来源 principal 还须在服务注册表明确具备 `publish/read_responses/reply/deliver`，手机使用独立 user token；没有环境或默认私人资源回退。

模型授权为专门的私有凭据，不能提交。`allow_model_calls` 默认为 false；启用可产生费用，必须先获得准确范围的操作许可。预算/原生会话与身份绑定，未知请求不退款，重启不重置；不得换 ID/目录/凭据绕过耗尽预算。

可选命名身份引用通过 `identity_reference` 显式绑定操作者自己的 persona/settings/credentials 文件与哈希；本仓库不提供任何私人身份/授权/历史。SDK工具仅为有界 `app_question`，不开放shell/文件/MCP/任意回调，不加载用户/项目默认资源。只支持代码中明确允许的物理模型 API；支持类型不是实际厂商验收。

## 初始化与运行

从仓库根执行，每个命令都必须指定自己的私有配置：

```sh
node pi-host/dist/main.js init --config /absolute/private/app-config.json
node pi-host/dist/main.js status --config /absolute/private/app-config.json
node pi-host/dist/main.js preflight --config /absolute/private/app-config.json
node pi-host/dist/main.js serve --config /absolute/private/app-config.json
# 仅暂停专用来源执行；原HTTP/已配置通知仍工作
node pi-host/dist/main.js serve --config /absolute/private/app-config.json --source-paused
```

`init` 不请求模型；`preflight` 不代表未知效果已解决。仅一名写者拥有专用 native/ledger，勿另开 Pi CLI 或 server 指向相同资料。来源回应在实际同步门核原会话/修订/期限/权限后持久写原生去重与回执；公共ACK丢失只核原command/native，不再次输入。模型完整输出才可作来源自报结果，不自动执行/完成或独立验收。

`--source-paused` 不等于备份冻结，不撤回在途效果、不全局冻结通知。恢复需保持原资料和绑定，不能清 journal/native/manifest 或未决 run。

## 离线备份与冻结安装

包含 `backup-create/backup-inspect/backup-stage/restore-install/restore-status` CLI 源码。工具只处理已初始化的专用 App 及明确原路径/私有 scope；不是任意目录备份器，不代停服务，不重建丢失权限，不自动解冻。

- AES-256-GCM 备份使用单独32随机字节私有密钥；密钥不得并入归档，丢失不可恢复。
- 备份固定集含原配置/注册表/指令/manifest/native/一致SQLite映像等，**不自动包含**外部persona/settings/model-auth、推送token、Android密钥、运维邀请包等，须分别保管。
- 操作者须真实停妥原实例及支持的写者；`writers-quiesced`只是明确断言，不是自动停机或同UID恶意代码沙箱。
- 安装使用准确scope和原intent，在新派生映像中设置恢复门并安装冻结事件v4/权限v2；普通运行仍v3/v1。
- 已有冲突、未知sidecar、丢失/变化的原证明均拒绝；保留失败工件，不自动覆盖、换ID或清库。
- 当前完整可读不重建前次fsync ACK；prepared/安装硬链接别名不是独立备份。`execution_enabled:false`，**没有thaw或恢复后受控启用命令**。

不要对生产资料尝试这些开发工具。具体严格输入、大小限制和失败语义以 `src/backup-*.ts`、`restore-*.ts` 及合成测试为准；不是生产恢复演练、完整A27或RTO承诺。

## 隔离工具与第三方

`test/*emulator-fixture*` 为显式新建的本机合成环境，凭据与运行输出保持私有；不自动操作ADB/AVD/真机，不用合成设备回执冒充Android。`deploy/render-units.mjs` 仅生成新unit文本，要求显式路径，拒绝覆盖，**不安装/启动/重启**；公开镜像将历史输出文件名改为通用 `notifier-app-test*`，不包含任何实际部署配置或操作许可。

Pi SDK 1.4.0及固定Pi子包、AJV、undici为MIT；typebox为MIT，完整许可保留于各npm制品和lockfile。ntfy 2.34.0官方Linux测试制品随附Apache-2.0，本仓库不附二进制/用户配置。产品自身许可证尚未选择。
