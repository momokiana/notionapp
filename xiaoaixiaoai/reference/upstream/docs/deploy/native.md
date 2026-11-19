# 用 Node + systemd 部署中转服务

不想装 Docker 时用这种方式。需要 Linux 和 systemd。

## 一条命令

```sh
curl -fsSL https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-relay.sh | sudo bash -s -- --native --domain pocket.example.com
```

没有 Docker 的机器上不加 `--native` 也会走这条路。脚本会：

| 位置 | 内容 |
|---|---|
| `/opt/herdr-pocket/releases/<版本>` | 程序（发布包，已带依赖），`current` 指向正在用的版本，`previous` 指向上一个 |
| `/opt/herdr-pocket/node` | 只有系统里没有 Node 22.18 以上时才会下载到这里（Node 24，校验 SHA256） |
| `/etc/herdr-pocket/relay.env` | 设置和管理员令牌，权限 600 |
| `/var/lib/herdr-pocket` | 数据库，只属于系统用户 `herdr-pocket` |
| `/etc/systemd/system/herdr-pocket-relay.service` | 服务，以 `herdr-pocket` 用户运行，只能写数据目录 |
| `/usr/local/bin/herdr-pocket-relay` | 管理命令 |

HTTPS：
- 装了 Caddy（`/etc/caddy/Caddyfile` 存在）时，脚本把 `pocket.example.com { reverse_proxy 127.0.0.1:7420 }` 加进去并重载 Caddy。
- 没装 Caddy 时脚本打印这段配置，装好 Caddy（https://caddyserver.com/docs/install）后自己加上。
- 也可以用 Cloudflare Tunnel：`--tunnel <令牌> --domain ...`，见 [cloudflare-tunnel.md](cloudflare-tunnel.md)。

## 管理

```sh
sudo herdr-pocket-relay status
sudo herdr-pocket-relay logs                # journalctl -u herdr-pocket-relay -f
sudo herdr-pocket-relay restart             # 改了 relay.env 之后
sudo herdr-pocket-relay update              # 装最新版本并重启
sudo herdr-pocket-relay update --rollback   # 退回上一个版本
sudo herdr-pocket-relay setup               # 还没有设备时再显示设置码
```

`update` 先把新版本解压到 `releases/` 里并试启动一次，没问题才切换 `current` 再重启服务；失败时原来的版本不受影响。

`logs` 是服务进程的输出；设备、助理和各端日志在 `/admin` 控制台和 `herdr-pocket logs` 里看，见 [README.md](README.md#查看运行情况)。

## 不用脚本（git clone）

仓库里的 [deploy/herdr-pocket-relay.service](../../deploy/herdr-pocket-relay.service)、[deploy/Caddyfile](../../deploy/Caddyfile) 和 [deploy/relay.env.example](../../deploy/relay.env.example) 就是手动部署用的：

```sh
git clone https://github.com/Crosery/herdr-pocket /opt/herdr-pocket && cd /opt/herdr-pocket && pnpm install --prod
sudo useradd -r herdr-pocket && sudo mkdir -p /var/lib/herdr-pocket /etc/herdr-pocket
sudo chown herdr-pocket /var/lib/herdr-pocket
sudo cp deploy/relay.env.example /etc/herdr-pocket/relay.env   # 改域名
sudo cp deploy/herdr-pocket-relay.service /etc/systemd/system/ && sudo systemctl enable --now herdr-pocket-relay
```

这种安装用 `git pull && pnpm install --prod && sudo systemctl restart herdr-pocket-relay` 更新；`herdr-pocket-relay update` 只管安装脚本装的副本。
