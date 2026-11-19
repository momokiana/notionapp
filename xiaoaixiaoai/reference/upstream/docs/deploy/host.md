# 电脑端：安装、上线、更新

macOS 和 Linux 都是一条命令，用你自己的用户运行，不需要 sudo（Windows 见[下面](#windows)）：

```sh
curl -fsSL https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-host.sh | bash -s -- --server https://pocket.example.com
```

脚本会：

1. 找一个 Node 22.18 以上；没有就下载 Node 24 到 `~/.local/share/herdr-pocket/node`（校验 SHA256）。
2. 把最新发布包装到 `~/.local/share/herdr-pocket/releases/<版本>`，`current` 指向它。
3. 写好命令 `~/.local/bin/herdr-pocket`（如果这个目录不在 PATH 里会提示怎么加）。
4. 登记这台电脑：终端显示二维码，用已经连上的手机在 App 里“设备 → 扫一扫”扫码并允许。
5. 装成后台服务并启动，开机/登录后自动上线：
   - macOS：`~/Library/LaunchAgents/com.herdr-pocket.hostd.plist`，日志在 `~/Library/Logs/herdr-pocket/hostd.log`
   - Linux：`~/.config/systemd/user/herdr-pocket-hostd.service`，日志 `journalctl --user -u herdr-pocket-hostd -f`；会尝试 `loginctl enable-linger`，让你退出登录后也保持在线

已经登记过的电脑重跑脚本不会重复登记，只更新程序和服务。

## 常用参数

| 参数 | 作用 |
|---|---|
| `--server <地址>` | 你的中转服务 |
| `<设置或邀请链接>` | 直接用链接登记，不用扫码。新中转服务还没有手机时，用它启动时打印的设置链接（`https://<服务器>/p/<码>`） |
| `--code <码>` | 和 `--server` 一起用，效果同上 |
| `--name <名字>` | 设备名，默认是电脑名 |
| `--read-only` | 手机和其他电脑只能看，不能输入 |
| `--no-service` | 只装命令，不装后台服务；之后自己运行 `herdr-pocket up` |
| `--version <x.y.z>` | 装指定版本 |

例如新中转服务上的第一台设备是电脑：

```sh
curl -fsSL https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-host.sh | bash -s -- https://pocket.example.com/p/ABCD-1234
```

## 更新

```sh
herdr-pocket update              # 装最新版本并重启后台服务
herdr-pocket update --check      # 只看有没有新版本
herdr-pocket update --rollback   # 退回上一个版本
herdr-pocket version
```

新版本先解压到 `releases/` 并试启动一次，没问题才切换并重启；失败时原来的版本照常运行。后台运行的 `herdr-pocket` 每天检查一次，有新版本时在日志里提示一行（`HERDR_POCKET_UPDATE_CHECK=0` 关掉）。

用 git 仓库直接运行的（开发用），`update` 会提示改用 `git pull && pnpm install`。

## 查日志

```sh
herdr-pocket logs                          # 最近 1 小时中转服务、电脑和手机记下的日志
herdr-pocket logs --level warn --since 1d  # 只看警告和错误
herdr-pocket logs --device <设备名> -f      # 盯着一台设备
```

`herdr-pocket help` 列出全部过滤参数。这台电脑后台服务自己的输出在上面第 5 步写的位置。

## 服务管理

macOS：

```sh
launchctl kickstart -k gui/$(id -u)/com.herdr-pocket.hostd   # 重启
launchctl bootout gui/$(id -u)/com.herdr-pocket.hostd        # 停止并取消开机启动
```

Linux：

```sh
systemctl --user restart herdr-pocket-hostd
systemctl --user disable --now herdr-pocket-hostd
```

## 卸载

1. 停掉服务（上面的 bootout / disable）并删除 plist 或 unit 文件。
2. 删除 `~/.local/share/herdr-pocket` 和 `~/.local/bin/herdr-pocket`。
3. 在手机 App 的设备列表里删掉这台电脑（或保留 `~/.config/herdr-pocket/hostd.json` 以便以后重装时沿用登记）。

## Windows

Windows 10 1809 以上或 Windows 11（x64 或 ARM64）。在 PowerShell 里运行，用你自己的账户，不需要管理员权限：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-host.ps1))) -Server https://pocket.example.com
```

在中国大陆，把脚本地址换成 `https://ghfast.top/https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-host.ps1`（macOS / Linux 的 `install-host.sh` 也一样）。脚本按时区判断，发布包、Node 和以后的 `herdr-pocket update` 都会先走镜像，见 [updates.md](updates.md#中国大陆)。

参数和上面一样，写法换成 PowerShell 的：`-Server`、`-Link <设置或邀请链接>`、`-Code`、`-Name`、`-ReadOnly`、`-NoService`、`-Version`、`-Dir`、`-From <发布包>`。用 `irm … | iex` 时没法带参数，先设 `$env:HERDR_POCKET_SERVER = "https://pocket.example.com"`。

脚本会：

1. 下载 Node 24 到 `%LOCALAPPDATA%\Programs\herdr-pocket\node`（校验 SHA256；总是用这一份，不碰系统里的 Node）。
2. 把发布包装到同一目录的 `releases\<版本>`，`current` 是指向它的目录联接（junction，普通用户就能建）。
3. 写好命令 `bin\herdr-pocket.cmd`，并把 `bin` 加进你的用户 PATH（新开的终端生效）。
4. 登记这台电脑：终端显示二维码，用已经连上的手机扫码并允许。
5. 装成登录自启的后台服务：`HKCU\...\Run` 里的 `HerdrPocket` 项在你登录时用 `wscript` 隐藏启动一个看护进程，看护进程再运行 `herdr-pocket run`，退出了就自动重启，全程没有窗口。它跑在你自己的会话里，所以从手机启动的 agent 用的还是你的登录凭据。

设置在 `%APPDATA%\herdr-pocket\hostd.json`，日志和手机发来的图片在 `%LOCALAPPDATA%\herdr-pocket`。电脑上要先装好 herdr（`hc`）；装在 `%LOCALAPPDATA%\Programs\herdr-core` 时不用加 PATH 也能找到。

Windows 上的 herdr 只有 herdr-core，没有桌面 app，所以没有空间。手机新建 agent 时只选程序和文件夹，电脑用 `hc run` 在那个文件夹里开一个独立终端来启动它；在电脑上用 `hc ls` 找到它，`hc attach <地址>` 接手（Ctrl+\ 离开）。手机上看对话需要电脑上运行 Uniflo（它有 Windows 安装脚本）；没有 Uniflo 时，只能看终端屏幕。

后台服务：

```powershell
herdr-pocket service status     # 是否登录自启、看护进程和 herdr-pocket 的进程号、日志位置
herdr-pocket service restart    # 重启（换到 current 指向的版本）
herdr-pocket service stop       # 停止，下次登录还会启动
herdr-pocket service remove     # 停止并取消登录自启
herdr-pocket service install    # 重新装上（可加 --read-only）
```

`herdr-pocket update` 在 Windows 上一样用：新版本解压到 `releases\`、试启动、切换 `current`，再让后台服务换到新版本。

卸载：`herdr-pocket service remove`，然后删掉 `%LOCALAPPDATA%\Programs\herdr-pocket`、`%LOCALAPPDATA%\herdr-pocket`，并从用户 PATH 里去掉它的 `bin`；想保留登记就留着 `%APPDATA%\herdr-pocket\hostd.json`。

注意：`herdr-pocket.cmd` 经过 cmd.exe，它会在 `&` 处把参数截断。要用链接登记时，用 `https://<服务器>/p/<码>` 这种形式，别用带 `&` 的 `herdrpocket://` 链接（安装脚本自己的 `-Link` 不受影响）。
