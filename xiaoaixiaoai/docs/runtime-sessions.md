# 项目会话：DSH 与 Codex

手机在「设备 → DSH 项目会话」（多台电脑时也可从设备右侧更多菜单进入）看**全部**和**关注**。授权的是一部手机和一个 DSH profile，不需要逐个把会话加进手机。全部目录支持按项目、标题/ID 搜索和翻页；未分组、归档也单列。查看指标题和状态元数据，不是逐条聊天历史或共享终端。

「关注」是这部手机的收藏，不影响发送或任务通知。也可在爱弥斯输入「关注 DSH 会话名」或「发给 DSH 会话名：消息」：本机打开目录、准备草稿，由你选择并核对真实会话再发送。不交给模型选会话，也不会自动发送。

在电脑上一次开启这部手机的 DSH profile 发送权限，就可以在该 profile 里选任意可投递的普通会话；不需要逐条加白名单。正在工作的会话按 DSH 原生规则排队，不打断当前轮；可以允许显式发送时唤醒同一个还没加载的现有会话。归档、子会话、需要迁移或身份无法核对的会话不可发送。系统不代答审批。

## 谁可以看到、谁可以操作

- 电脑端默认没有开启这个功能。配置必须明确指定**一部已配对手机**的 `viewerId`。DSH 用 `workspaceScope: all` 一次授权当前 profile 的目录；已有 `workspaceIds` 配置不会自动扩权，显示为「已共享」。只知道会话 ID、改请求发件人或另配对一部手机都不能代替授权。重新配对后设备 ID 会变，需重新授权；关注记录和当前配对隔离。
- `--runtime-only` 不启动 Herdr/Uniflo 读取，不提供终端输入、历史、创建、关闭或工具审批；`--read-only` 则额外拒绝发送。仅去掉 `--read-only` 不会开放发送：DSH 插件也必须明确授权。已有逐条白名单仍保留，不会升级时默默扩大。
- 目录按需读取，不广播给其他设备或模型。它只包含项目和会话标题、ID、状态等元数据，不传聊天历史、文件内容或凭据。标题还是可能敏感。**目录查询与任务文本经过你自己的已认证中转服务**（不是端到端加密）。任务正文和搜索字不写进小爱的常规日志；原运行时会依自己规则保存实际收到的消息。
- 每次发送只走一个目标、一个请求，不自动重试。电脑端在本地私有 `runtime-dispatch/` 留请求 ID、摘要和确实收到的回执，用于去重；不存任务正文。回执未知先核对原会话，不要换一个请求再发同一条。

## DSH：在原来的 WSL 中接入

1. 使用 [DSH 0.2.1-rc.3 本机插件指南](<../apps/hostd/integrations/dsh/README.md>)，把桥接插件挂到拥有现有会话的那个 DSH Host，设置 `workspaceScope: all` 和 `enableSend: false`。插件入口仅监听同用户可用的 Unix socket，不转发到公网，不借用 DSH 网页的登录 token。配置前核对当前 profile；不要起第二个 DSH 去争用同一个数据目录，也不要打断正在工作的会话。
2. 本机小爱电脑端应与 DSH 用户及 WSL 发行版一致。先执行 `xiaoaixiaoai login --server https://xiaoaixiaoai.example.com --name "WSL"`（换成自有中转地址），用自己的手机审批这台电脑。`xiaoaixiaoai devices` 只在本机查看受信手机的设备 ID，不把配对码或令牌贴到聊天。
3. 存放在 Linux 本地文件系统的自有 `0700` 目录，配置文件 `0600`。以下是**只读示例**，所有值用自己的；不要写入仓库：

```json
{
  "viewerId": "approved-phone-id",
  "dsh": { "socketPath": "/run/user/12345/xiaoaixiaoai-dsh/bridge.sock" }
}
```

```sh
xiaoaixiaoai run --runtime-only --read-only --runtime-config /absolute/private/runtime.json
```

如果 HTTPS 中转必须通过这台电脑上已有、可信的代理，电脑端可另加 `--relay-proxy http://127.0.0.1:<port>`（需要 Node 24.5+，此参数仅用于 `run` 的 WebSocket）。使用 HTTP CONNECT 隧道，仍校验原中转的 HTTPS 证书；不会改系统代理，也不把 DSH 的本机 socket 或 Codex 接口转出去。初次配对的 HTTP 请求必须另走原有可信网络路径。

4. 要开放整个 profile 的发送，在其插件配置设置 `workspaceScope: all`、`enableSend: true`、`sendScope: profile`；不可和 `sendAllowlist` 同用。要让用户明确发送时也能打开未加载的现有会话，另外设置 `resumeExisting: true`。电脑端仍使用 `--runtime-only` 和 `--allow <该手机的设备 ID>`，去掉 `--read-only`。没有明确的发送操作，浏览和关注都不会打开任何会话。原会话的工具授权仍由 DSH 管理。

## DSH 任务通知（0.1.9）

- 更新电脑端和 DSH 插件、自己的中转和 Android 客户端后，手机在后台也能收到**从这部手机发出、已获接收回执**的 DSH 任务通知。不是对其他设备或桌面发来的任务的全局监控。
- **进展**：真实记录了一个执行步骤。**需决定**：记录到了未立即解决的原生审批或 `ask_user_question`。**结束／停止**：跟踪到这一轮的实际结束原因；结束不等于代码或测试验收成功。点通知按会话 ID 定位；问题和审批仍在原 DSH 中处理。
- 通知经过已认证中转，只送发起任务的手机。它不包含任务原文、模型回复、工具参数及审批内容，也没有写入共享助理历史。中转重连后有限度补送；进程停止、长期离线、系统强行停止或禁用通知时不保证送达。可选「关注」页的前台空闲提醒仍是独立功能。
- 旧中转仍可转发目录和发送，但不支持这类推送。升级时保留原数据库、配对记录、模型独立配置和现有 URL；先备份、验证并准备回退，不要用重新配对代替升级。

## Windows Codex：不要把读取保存记录当接管

独立的 [Codex 连接器指南](<../apps/hostd/integrations/codex/README.md>)适用于**已经拥有目标会话的同一个、可认证的本机 App Server**。电脑端使用 Windows 原生 Node 在和 Codex 相同的一侧运行；不把 WSL 的 `127.0.0.1` 当成 Windows 的 `127.0.0.1`。默认的 Windows Store 桌面程序正在运行，并不能证明它对第三方提供此接口。没有已经核实的同运行时端点，就保持禁用，不读私有历史、猜管道或另起服务抢占旧会话。

用专用的用户私有目录和继承的 Windows ACL 存配置和独立 token 文件；不要放到共享盘或仓库里。默认只读，以下只是给**已核实自有运行时**的格式示意：

```json
{
  "viewerId": "approved-phone-id",
  "codex": {
    "url": "ws://127.0.0.1:4500",
    "tokenFile": "C:\\Private\\XiaoAi\\codex-token.txt",
    "exclusiveWriter": false,
    "threads": [{ "id": "approved-thread-id", "projectId": "test-project", "projectTitle": "指定项目", "canSend": false }]
  }
}
```

只有能确保同一 App Server、同一已加载且空闲的线程、且在授权期间不存在其他写入者，才可在受控环境开启 `exclusiveWriter: true`，并按线程设 `canSend: true`。Codex 官方 `turn/start` 无原子空闲前置条件；**默认 Windows 桌面正在与其他客户端并用时，不应打开此项**。要立即从手机接续桌面现有 Codex 会话，可以按 [官方 Remote connections 指南](https://learn.chatgpt.com/docs/remote-connections.md)确认账号是否有该入口；这是 ChatGPT 的功能，不是小爱已经接管。

## 验证边界

- 固定版本 DSH 的 Cordis Loader 已在隔离测试中加载/卸载此插件。使用临时 socket 与合成会话验证权限和调用，不启动真实会话、不发真实测试消息。
- 测试环境使用实际小爱电脑端及本机中转，验证同一身份投递、请求去重、任务事件归属、通知补送及撤销授权。部署状态与隔离测试分开记录。
- Codex 使用受鉴权的本机 App Server 夹具验证协议；用 Windows 原生 Node 解包电脑端预览，15 项连接器、范围和去重测试通过。真实 Windows Codex 桌面的可接管性未验证。没有在真实电脑会话发送测试任务，也未安装到真实手机。

## 会话消息查看与手机端回答（0.2.0）

- 通过新增的 `runtimeSessions.detail` RPC，手机端点击任意可见的 DSH / Codex / Antigravity 会话的「查看对话」，可按需拉取最近一页脱敏消息记录（默认 60 条，仅返回正文、工具调用名与时间，不传环境变量或系统提示前缀），无需在电脑前也能了解会话进展。
- 对于 DSH 中触发 `ask_user_question` 的会话，支持通过 `runtimeSessions.answer` 直接在手机端提交单选、多选及自定义补充回答：
  - **前台等待中（`open`）**：小爱插件监听 `user-questions/request`；若桌面 UI 可用，手机与电脑任一端先提交即生效，另一端自动结束；若当前无桌面等待器（`NO_PROVIDER`），直接由手机端回答接续。
  - **超时挂起（`continued`）**：若问题已超时转为后台挂起，只要该会话处于可发送授权且 `userQuestions.answer` 可用，手机端提交答案后会从挂起点续跑；历史记录或只读会话中的问题仅显示为 `readonly` 预览。

## Windows 本机 Codex 与 Antigravity 接入（0.2.0）

在 Windows 原生环境中以独立电脑端（如 `"Windows 桌面"`）配合 `--runtime-only --runtime-config <path>` 运行时，可通过以下私有配置同时接入本机 Codex 与 Antigravity（文件权限仅当前用户可读）：

```json
{
  "viewerId": "approved-phone-id",
  "codexLocal": {
    "codexHome": "C:\\Users\\<User>\\.codex",
    "enableSend": true
  },
  "antigravity": {
    "brainDir": "C:\\Users\\<User>\\.gemini\\antigravity\\brain"
  }
}
```

- **Codex 本机接入（`codexLocal`）**：以只读模式读取 `state_5.sqlite` `threads` 索引，并通过尾部有限字节窗口（不整文件读入大日志）解析近期 rollout 对话消息与运行状态；仅当 `enableSend: true`、会话未归档、非运行态且原工作目录存在时，才允许从手机经本机 `codex.exe app-server --listen stdio://` 发起一轮续跑（支持经 `RuntimeTaskEvent` 发送进展/需确认/结束通知；与旧版显式 `codex` WS 配置互斥）。
- **Antigravity 只读接入（`antigravity`）**：扫描 `brain/*/transcript.jsonl` 头部项目信息和尾部步骤窗口，提取用户请求、工具调用、助手回复及未解决的 `ask_question` 问题选项（状态标记为 `attention`）。Antigravity 会话始终强制为只读（`canSend: false`），禁止手机端注入消息或代答。

## 中转加速检查更新（0.2.0）

- 手机端每隔 4 小时或在「设置 → 检查更新」手动检查最新版本（指向 `momokiana/notionapp` 发布产物）：优先请求已配对中转站的 `/v1/releases/SHA256SUMS` 与 `/v1/releases/<apk>`，不可用时回退到 GitHub Releases / 镜像站，并在下载后强制校验 APK 的 SHA-256 摘要再交由系统安装器安装。
- 说明：`0.1.9` 版本中发布仓库默认关闭，因此需要手动安装一次 `0.2.0` APK 后，后续版本才可直接在应用内自动检测并一键下载更新。

## 统一会话池与爱弥斯联动（0.2.2）

- 如需将各电脑端共享的 DSH、Codex、Antigravity 会话统一发布到手机端首页 Agent 池并开放给中转站助理（爱弥斯）检索、读消息与下发任务，可在私有运行时配置中显式开启 `"publishAgents": true` 与 `"allowAssistant": true`，并在启动参数 `--allow` 中同时包含 `<approved-phone-id>,assistant`：

```json
{
  "viewerId": "approved-phone-id",
  "publishAgents": true,
  "allowAssistant": true
}
```

- **统一聊天与底栏发送**：DSH、Codex、Antigravity 会话在手机端首页统一按「需要你 / 工作中 / 已完成 / 空闲」状态和所属工程展示；点击任意会话即进入原生对话页（隐藏不适用的终端 PTY 标签），底部常驻输入框可直接向可写 DSH / Codex 会话发消息，遇到单选/多选问题时会在底栏上方呈现交互式答题卡片。
- **爱弥斯跨端检索与安全边界**：爱弥斯可通过 `sessions.list`、`sessions.search`、`read_agent`（支持「反重力」「DSH」「Codex」等别名与关键词检索）统一查看三端会话并替可写会话传话或盯进度；Antigravity 会话继续强制保持只读（`canSend: false`），无论是手机底部栏还是爱弥斯下发均只查看不写入。
