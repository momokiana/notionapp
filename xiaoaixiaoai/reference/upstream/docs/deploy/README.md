# 部署与更新

Herdr Pocket 要部署两样东西：

- **中转服务（relay）**：一台手机和电脑都连得上的服务器，整套只要一个。
- **电脑端（`herdr-pocket`）**：每台要在手机上看的电脑装一个，见 [host.md](host.md)。

## 中转服务：选一种

服务器上一条命令装好（Linux；有 Docker 就用 Docker，没有就用 Node + systemd）：

```sh
curl -fsSL https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-relay.sh | sudo bash -s -- --domain pocket.example.com
```

| 方式 | 适合 | 命令或入口 |
|---|---|---|
| Docker + Caddy（推荐） | 有域名，服务器能开 80/443 端口 | `--domain pocket.example.com` |
| Docker + Cloudflare Tunnel | 域名托管在 Cloudflare，服务器不开端口（家里、内网、NAT 后面） | `--tunnel <token> --domain pocket.example.com`，见 [cloudflare-tunnel.md](cloudflare-tunnel.md) |
| 临时试用 | 没有域名，先试一下 | `--tunnel quick`（地址每次重启都会变） |
| 纯 HTTP 端口 | 局域网，或前面已经有自己的 nginx/反代 | `--port 7420` |
| Node + systemd | 不想装 Docker | `--native --domain pocket.example.com`，见 [native.md](native.md) |
| Fly.io | 不想管服务器 | [fly.md](fly.md) |
| Railway / Render / Zeabur / Kubernetes | 已经在用这些平台 | [platforms.md](platforms.md) |
| Windows 上跑中转服务 | 只有 Windows 机器 | 用 Docker Desktop 跑 [docker.md](docker.md) 的 compose，或在 WSL 里按 Linux 装；电脑端本身支持 Windows，见 [host.md](host.md#windows) |

Docker 方式的细节见 [docker.md](docker.md)。Cloudflare Workers 原生部署还没做，可行性评估见 [cloudflare-workers.md](cloudflare-workers.md)。

两条硬要求，所有方式都满足：

- **数据放在持久存储上**。数据库 `relay.db` 存着设备、令牌哈希和助理对话；丢了它，所有设备都要重新配对。
- **只跑一个实例**。在线连接和正在转发的请求都在这一个进程的内存里，开两个实例会互相看不见。

## 第一台设备

新装好的中转服务还没有任何设备时，会生成一个一次性设置码（30 分钟有效）。安装脚本最后会把它和二维码一起打印出来：

- 手机：打开 App 扫这个二维码。
- 先接电脑也行：在电脑上运行安装命令时把那条设置链接带上，见 [host.md](host.md)。

过期了就再生成一个：`sudo herdr-pocket-relay setup --new`。之后加设备都从已经连上的设备邀请（App 里“设备 → 邀请设备”，或电脑上 `herdr-pocket pair`）。

没用安装脚本（自己跑 compose、`docker run` 或在平台上部署）时，设置码在中转服务的启动日志里，找 `[relay] setup code=` 这一行；没设 `POCKET_PUBLIC_URL` 时只有码没有二维码，在 App 里手动填地址和码。

配对不需要管理员令牌。`POCKET_ADMIN_TOKEN` 是可选的，只有 `/admin` 控制台和管理接口用它；安装脚本会生成一个写进 `relay.env`。

## 查看运行情况

- **`/admin` 控制台**：浏览器打开 `https://pocket.example.com/admin`，填 `POCKET_ADMIN_TOKEN`。能看版本、在线设备、助理模型、日志和小羊最近的操作，能吊销设备、切换小羊动手前是否先问。没设这个令牌时控制台用不了，其他功能不受影响。
- **`herdr-pocket logs`**：在任意一台已登记的电脑上查中转服务、电脑和手机记下的日志，用法见 [host.md](host.md#查日志)。
- `sudo herdr-pocket-relay logs`：中转服务进程本身的输出（Docker 方式是容器日志，Node 方式是 journalctl）。

## 更新

- 电脑：`herdr-pocket update`
- 服务器：`sudo herdr-pocket-relay update`（Docker 方式就是拉新镜像重启）
- 手机 App：有新版本时 App 自己提示下载安装

都从 GitHub Releases 取最新版本。细节和发布流程见 [updates.md](updates.md)。
