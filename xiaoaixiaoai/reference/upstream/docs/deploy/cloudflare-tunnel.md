# 通过 Cloudflare Tunnel 部署（不开端口）

服务器主动连到 Cloudflare，手机和电脑经 Cloudflare 访问它。服务器不用开任何入站端口，也不用自己弄证书，放在家里、内网或 NAT 后面都行。需要一个托管在 Cloudflare 的域名。

## 1. 在 Cloudflare 建隧道

1. Cloudflare 控制台 → Zero Trust → Networks → Tunnels → Create a tunnel，类型选 Cloudflared，起个名字。
2. 安装页面会给出一条 `cloudflared ... --token eyJ...` 命令，复制 `--token` 后面那一长串，这就是隧道令牌。不用在服务器上执行那条命令。
3. 给隧道加一个公开主机名（Public Hostname，新版界面叫已发布应用路由）：
   - 子域名和域名：例如 `pocket.example.com`
   - Service 类型 `HTTP`，地址：
     - Docker 方式填 `relay:7420`
     - Node + systemd 方式填 `localhost:7420`

WebSocket 默认就能过隧道，不用额外设置。菜单名称以控制台当前界面为准。

## 2. 服务器上一条命令

```sh
curl -fsSL https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-relay.sh | sudo bash -s -- --tunnel <隧道令牌> --domain pocket.example.com
```

`--domain` 填第 3 步的公开主机名，二维码和邀请链接会带上这个地址。脚本启动中转服务和 cloudflared 两个容器，中转服务只监听本机 `127.0.0.1:7420`。令牌写在 `/opt/herdr-pocket/.env`（权限 600）。

没有 Docker 时脚本走 Node + systemd：如果装了 `cloudflared`，会执行 `cloudflared service install <令牌>`；没装就提示安装方法。

## 只是试试：临时地址

```sh
curl -fsSL https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-relay.sh | sudo bash -s -- --tunnel quick
```

不需要 Cloudflare 账号，会得到一个 `https://xxx.trycloudflare.com` 地址。这个地址在 cloudflared 每次重启后都会变，已配对的设备就连不上了，所以只用来试用。只支持 Docker 方式。

## 排查

- `sudo herdr-pocket-relay status`：本机健康检查是否正常。
- `cd /opt/herdr-pocket && docker compose logs cloudflared`：隧道是否连上（看到 `Registered tunnel connection` 即正常）。
- 公网地址打不开但本机正常：多半是公开主机名的 Service 地址填错了（Docker 方式必须是 `relay:7420`）。
