#!/usr/bin/env bash
# Local-source relay installer: native by default; Docker requires an explicit preloaded own image.
#
#   sudo bash scripts/install-relay.sh --source /path/to/xiaoaixiaoai-0.1.0.tar.gz --domain xiaoaixiaoai.example.com
#
# How phones reach the relay (pick one):
#   --domain <host>       HTTPS for your domain through Caddy. Point the DNS record at this server
#                         and open ports 80 and 443 first.
#   --tunnel <token>      Cloudflare Tunnel: no open ports, no certificates. Add --domain <the public
#                         hostname you gave the tunnel> so QR codes carry the right address.
#   --tunnel quick        a temporary https://*.trycloudflare.com address, for trying it out (Docker only;
#                         the address changes when cloudflared restarts).
#   --port <n>            plain HTTP on port n (default 7420): a LAN, or your own reverse proxy in front.
#
# Other options:
#   --docker | --native   force how it runs
#   --dir <path>          install folder (default /opt/xiaoaixiaoai)
#   --version <x.y.z>     legacy option; the local bundle's manifest remains authoritative
#   --image <ref>         required for Docker: explicit own/local image, preloaded separately
#   --public-url <url>    the address phones use, when the flags above don't imply it
#   --source <path>       required: an existing local checkout or bundle (Docker uses its compose file)
#   --with-node           native: use a private Node in <dir>/node even if one is installed
#   --no-start            write everything, start nothing
#
# Running it again changes settings or repairs the install; relay.env (admin token, assistant keys)
# is kept. Afterwards `xiaoaixiaoai-relay status|logs|update|setup` manages it.
#
# This fork has no configured remote release source. HERDR_POCKET_REPO cannot enable one.
# A missing Node runtime may still come from nodejs.org / npmmirror.com, with checksums,
# only after local-source policy passes. Docker images must be preloaded; this script never pulls.
set -euo pipefail
# Also stop on errors inside $(...) where bash supports it (4.4+).
shopt -s inherit_errexit 2>/dev/null || true

NODE_MAJOR=24

say() { printf '\033[1;35m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mx\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
fetch() { curl -fsSL --retry 3 --connect-timeout 20 -o "$2" "$1"; }

# Mainland China by the time zone (TZ, /etc/localtime, /etc/timezone); XIAOAIXIAOAI_MIRROR forces it.
in_china() {
  case "${XIAOAIXIAOAI_MIRROR:-}" in 1 | true | on | yes) return 0 ;; 0 | false | off | no) return 1 ;; esac
  local tz=${TZ:-}
  [ -n "$tz" ] || tz=$(readlink /etc/localtime 2>/dev/null || true)
  [ -n "$tz" ] || tz=$(cat /etc/timezone 2>/dev/null || true)
  case "$tz" in *Asia/Shanghai | *Asia/Chongqing | *Asia/Chungking | *Asia/Harbin | *Asia/Urumqi | *Asia/Kashgar | *PRC) return 0 ;; esac
  return 1
}
CHINA=0
in_china && CHINA=1

sha256() { if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
token() { if have openssl; then openssl rand -hex 24; else head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi; }

# Set KEY=value in an env file, replacing an existing line (keeps the file's mode).
set_env() {
  local f=$1 k=$2 v=$3 tmp
  tmp=$(mktemp)
  if [ -f "$f" ] && grep -q "^$k=" "$f"; then
    awk -v k="$k" -v v="$v" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$f" >"$tmp"
  else
    { [ -f "$f" ] && cat "$f"; echo "$k=$v"; } >"$tmp"
  fi
  cat "$tmp" >"$f"
  rm -f "$tmp"
}
get_env() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | tail -n 1; return 0; }

# Deployment files must come from the explicitly selected local source, never upstream.
repo_file() {
  local path=$1 out=$2 ref
  if [ -n "$SOURCE" ] && [ -d "$SOURCE" ]; then
    cp "$SOURCE/$path" "$out"
  elif [ -n "$SOURCE" ]; then
    tar -xzf "$SOURCE" -O --wildcards "*/$path" >"$out" 2>/dev/null || tar -xzf "$SOURCE" -O "*/$path" >"$out"
  else
    die "Owned release source is not configured; explicit local bundle required (--source)."
  fi
}

node_ok() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null
}

# Download Node into $1 (checked against nodejs.org's SHASUMS256) and print the node path.
private_node() {
  local dir=$1 os arch base tmp file want
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) die "no Node build for $(uname -s)" ;; esac
  case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) die "no Node build for $(uname -m)" ;; esac
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  tmp=$(mktemp -d)
  # The checksums from nodejs.org itself; npmmirror's latest-v* list can lag behind.
  fetch "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt" || {
    [ "$CHINA" = 1 ] && fetch "https://npmmirror.com/mirrors/node/latest-v$NODE_MAJOR.x/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
  } || die "could not reach nodejs.org"
  file=$(grep -o "node-v[0-9.]*-$os-$arch\.tar\.gz" "$tmp/SHASUMS256.txt" | head -n 1)
  [ -n "$file" ] || die "nodejs.org lists no $os-$arch build"
  say "downloading $file"
  local ver=${file#node-} mirror
  ver=${ver%%-*}
  mirror="https://npmmirror.com/mirrors/node/$ver/$file"
  if [ "$CHINA" = 1 ]; then
    fetch "$mirror" "$tmp/$file" || fetch "$base/$file" "$tmp/$file"
  else
    fetch "$base/$file" "$tmp/$file" || fetch "$mirror" "$tmp/$file"
  fi || die "downloading $file failed; run the installer again"
  want=$(awk -v f="$file" '$2 == f { print $1 }' "$tmp/SHASUMS256.txt")
  [ "$(sha256 "$tmp/$file")" = "$want" ] || die "checksum mismatch for $file"
  rm -rf "$dir.new" && mkdir -p "$dir.new"
  tar -xzf "$tmp/$file" -C "$dir.new" --strip-components=1 --no-same-owner
  rm -rf "$dir" && mv "$dir.new" "$dir" && rm -rf "$tmp"
  echo "$dir/bin/node"
}

find_node() {
  local n
  if [ "$WITH_NODE" != 1 ]; then
    for n in "$(command -v node 2>/dev/null || true)" /usr/local/bin/node /usr/bin/node; do
      [ -n "$n" ] && [ -x "$n" ] && node_ok "$n" && { echo "$n"; return; }
    done
  fi
  [ -x "$DIR/node/bin/node" ] && node_ok "$DIR/node/bin/node" && { echo "$DIR/node/bin/node"; return; }
  say "no Node >= 22.18 found: installing Node $NODE_MAJOR into $DIR/node"
  private_node "$DIR/node"
}

# Unpack the release bundle into $DIR/releases/<version> and point $DIR/current at it.
install_bundle() {
  local tmp file tag ver want
  tmp=$(mktemp -d)
  if [ -n "$SOURCE" ] && [ -d "$SOURCE" ]; then
    say "packing $SOURCE"
    file=$("$SOURCE/scripts/pack-release.sh" "$tmp")
  elif [ -n "$SOURCE" ]; then
    file=$SOURCE
  else
    die "Owned release source is not configured; explicit local bundle required (--source)."
  fi
  mkdir -p "$tmp/x"
  tar -xzf "$file" -C "$tmp/x" --strip-components=1 --no-same-owner
  ver=$("$NODE" -p "require('$tmp/x/package.json').version")
  mkdir -p "$DIR/releases"
  if [ "$(readlink "$DIR/current" 2>/dev/null || true)" = "releases/$ver" ]; then
    say "小爱小爱 $ver is already installed"
  else
    rm -rf "$DIR/releases/$ver"
    mv "$tmp/x" "$DIR/releases/$ver"
    if [ -L "$DIR/current" ]; then ln -sfn "$(readlink "$DIR/current")" "$DIR/previous"; fi
    ln -sfn "releases/$ver" "$DIR/current"
  fi
  rm -rf "$tmp"
  INSTALLED=$ver
}

wait_health() {
  local url=$1
  for _ in $(seq 1 60); do
    if curl -fsS -m 3 "$url/v1/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# ----------------------------------------------------------------------------------------------------------------------------------

ARGS="$*"
DOMAIN="" TUNNEL="" PORT="" MODE="" DIR="/opt/xiaoaixiaoai" VERSION="" IMAGE="" PUBLIC_URL="" SOURCE=""
WITH_NODE=0 NO_START=0 REACH_GIVEN=0 INSTALLED=""

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=${2:?}; REACH_GIVEN=1; shift 2 ;;
    --tunnel) TUNNEL=${2:?}; REACH_GIVEN=1; shift 2 ;;
    --port) PORT=${2:?}; REACH_GIVEN=1; shift 2 ;;
    --public-url) PUBLIC_URL=${2:?}; REACH_GIVEN=1; shift 2 ;;
    --docker) MODE=docker; shift ;;
    --native) MODE=native; shift ;;
    --dir) DIR=${2:?}; shift 2 ;;
    --version) VERSION=${2:?}; shift 2 ;;
    --image) IMAGE=${2:?}; shift 2 ;;
    --source) SOURCE=${2:?}; shift 2 ;;
    --with-node) WITH_NODE=1; shift ;;
    --no-start) NO_START=1; shift ;;
    -h | --help) [ -f "$0" ] && sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# Fail before directory writes, Node bootstrap, Docker probing or remote metadata.
[ -n "$SOURCE" ] || die "Owned release source is not configured; explicit local bundle required (--source)."
case "$SOURCE" in *://* | //*) die "--source must be a local checkout or bundle path, not a URL/network path" ;; esac
[ -d "$SOURCE" ] || [ -f "$SOURCE" ] || die "--source must name an existing local checkout or bundle"
SOURCE=$(cd "$(dirname "$SOURCE")" && pwd -P)/$(basename "$SOURCE")
# Do not probe a Docker daemon just to choose an install mode. Native is the default.
if [ -z "$MODE" ]; then
  if [ -n "$IMAGE" ]; then MODE=docker; else MODE=native; fi
fi
if [ "$MODE" = docker ]; then
  [ -n "$IMAGE" ] || die "Docker requires an explicit own/local --image, preloaded separately"
  case "$IMAGE" in -* | *://* | *[!A-Za-z0-9._:/@-]*) die "--image must be a plain Docker image reference" ;; esac
  image_lc=$(printf '%s' "$IMAGE" | tr '[:upper:]' '[:lower:]')
  case "$image_lc" in ghcr.io/crosery/* | ghcr.io:443/crosery/*) die "The upstream official image is not this fork's release source" ;; esac
  # Compose volumes are scoped by project name. Never overwrite an unknown existing project.
  if [ -e "$DIR/compose.yml" ] && ! grep -Eq '^name:[[:space:]]+xiaoaixiaoai[[:space:]]*$' "$DIR/compose.yml"; then
    die "Existing Compose project is not xiaoaixiaoai; use a fresh --dir or plan a backed-up migration. No files changed."
  fi
fi

have curl || die "curl is needed"
DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN%%/*}
# What the address looks like from outside, and who sits in front of the relay.
if [ -n "$TUNNEL" ]; then
  FRONT=tunnel; [ "$TUNNEL" = quick ] && FRONT=quicktunnel
elif [ -n "$DOMAIN" ] && [ -z "$PORT" ]; then
  FRONT=caddy
else
  FRONT=plain
fi
PORT=${PORT:-7420}
if [ -z "$PUBLIC_URL" ]; then
  case "$FRONT" in
    caddy | tunnel) [ -n "$DOMAIN" ] && PUBLIC_URL="https://$DOMAIN" ;;
    plain) [ -n "$DOMAIN" ] && PUBLIC_URL="http://$DOMAIN:$PORT" ;;
  esac
fi
[ "$FRONT" = tunnel ] && [ -z "$DOMAIN" ] && warn "no --domain: QR codes will lack the address; pass the tunnel's public hostname with --domain"

if [ "$(id -u)" != 0 ] && { [ "$MODE" = native ] || [ ! -w "$(dirname "$DIR")" ]; }; then
  die "run this saved local installer as root with the same explicit --source and reviewed options; do not fetch a remote bootstrap script"
fi
mkdir -p "$DIR"
DIR=$(cd "$DIR" && pwd -P)
say "installing the 小爱小爱 relay in $DIR ($MODE, $FRONT)"

# ----------------------------------------------------------------------------------------------------------------------------------

link_command() {
  # The management command: $DIR/xiaoaixiaoai-relay, linked into /usr/local/bin when possible.
  chmod 755 "$DIR/xiaoaixiaoai-relay"
  if [ "$(id -u)" = 0 ] && mkdir -p /usr/local/bin; then
    ln -sfn "$DIR/xiaoaixiaoai-relay" /usr/local/bin/xiaoaixiaoai-relay
    MANAGE=xiaoaixiaoai-relay
  else
    MANAGE="$DIR/xiaoaixiaoai-relay"
  fi
}

new_relay_env() {
  # Secrets and relay settings; kept on later runs.
  local f=$1
  (umask 077 && cat >"$f" <<EOF
# 小爱小爱 relay settings. Every option (assistant models and keys, voice calls):
# deploy/relay.env.example and docs/config.md in the repository.
# After editing: xiaoaixiaoai-relay restart
# Optional: only the /admin dashboard and the admin APIs use it; pairing does not.
POCKET_ADMIN_TOKEN=$(token)

# Assistant: models in order, plus the keys of their providers, for example
#   POCKET_ASSISTANT_MODELS=deepseek:deepseek-flash
#   POCKET_DEEPSEEK_API_KEY=sk-...
POCKET_ASSISTANT_MODELS=
EOF
  )
}

run_docker() {
  have docker || die "Docker is not installed (use --native, or install Docker first)"
  docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is missing (docker compose)"
  local image bind
  repo_file deploy/docker/compose.yml "$DIR/compose.yml"
  [ -f "$DIR/relay.env" ] || new_relay_env "$DIR/relay.env"
  chmod 600 "$DIR/relay.env"
  image=$IMAGE
  # Override inherited POCKET_IMAGE too; a legacy environment cannot replace the reviewed image.
  export POCKET_IMAGE="$image"
  if [ "$REACH_GIVEN" = 1 ] || [ ! -f "$DIR/.env" ]; then
    bind=127.0.0.1
    [ "$FRONT" = plain ] && bind=0.0.0.0
    (umask 077 && cat >"$DIR/.env" <<EOF
# Docker Compose settings written by install-relay.sh (see compose.yml).
POCKET_IMAGE=$image
COMPOSE_PROFILES=$([ "$FRONT" = plain ] || echo "$FRONT")
RELAY_BIND=$bind
RELAY_PORT=$PORT
POCKET_DOMAIN=$DOMAIN
TUNNEL_TOKEN=$([ "$FRONT" = tunnel ] && echo "$TUNNEL")
EOF
    )
    set_env "$DIR/relay.env" POCKET_TRUST_PROXY "$([ "$FRONT" = plain ] && echo 0 || echo 1)"
    [ -n "$PUBLIC_URL" ] && set_env "$DIR/relay.env" POCKET_PUBLIC_URL "$PUBLIC_URL"
  else
    [ -n "$IMAGE$VERSION" ] && set_env "$DIR/.env" POCKET_IMAGE "$image"
    PORT=$(get_env "$DIR/.env" RELAY_PORT)
    FRONT=$(get_env "$DIR/.env" COMPOSE_PROFILES); FRONT=${FRONT:-plain}
  fi
  PUBLIC_URL=$(get_env "$DIR/relay.env" POCKET_PUBLIC_URL)
  chmod 600 "$DIR/.env"

  cat >"$DIR/xiaoaixiaoai-relay" <<EOF
#!/bin/sh
# Manage the 小爱小爱 relay in $DIR (Docker). Written by install-relay.sh.
set -e
cd "$DIR"
export POCKET_IMAGE="$image"
case "\${1:-help}" in
  update)
    echo 'Remote image updates are disabled: no owned release source is configured. Load a reviewed own image and rerun the local installer with --source and --image.' >&2
    exit 1 ;;
  status) docker compose ps; curl -fsS http://127.0.0.1:$PORT/v1/health; echo ;;
  logs) exec docker compose logs -f --tail=100 relay ;;
  restart) docker compose up -d --pull never --force-recreate relay ;;
  stop) exec docker compose stop ;;
  start) exec docker compose up -d --pull never ;;
  setup | version) exec docker compose exec -T relay xiaoaixiaoai-relay "\$@" ;;
  *) echo "usage: xiaoaixiaoai-relay update | status | logs | restart | stop | start | setup [--new] | version [--check]" ;;
esac
EOF
  link_command
  [ "$NO_START" = 1 ] && return 0

  say "starting containers"
  (cd "$DIR" && docker compose up -d --pull never --remove-orphans --force-recreate)
  wait_health "http://127.0.0.1:$PORT" || { (cd "$DIR" && docker compose logs --tail=40 relay) >&2; die "the relay did not become healthy"; }
  if [ "$FRONT" = quicktunnel ]; then
    say "waiting for the trycloudflare.com address"
    local url=""
    for _ in $(seq 1 45); do
      url=$(cd "$DIR" && docker compose logs quicktunnel 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -n 1 || true)
      [ -n "$url" ] && break
      sleep 2
    done
    if [ -n "$url" ]; then
      PUBLIC_URL=$url
      set_env "$DIR/relay.env" POCKET_PUBLIC_URL "$url"
      (cd "$DIR" && docker compose up -d --pull never --force-recreate relay)
      wait_health "http://127.0.0.1:$PORT" || die "the relay did not come back"
    else
      warn "no trycloudflare.com address yet: see xiaoaixiaoai-relay logs, or docker compose logs quicktunnel"
    fi
  fi
  SETUP_CMD=(sh -c "cd '$DIR' && docker compose exec -T relay xiaoaixiaoai-relay setup")
}

run_native() {
  [ "$(uname -s)" = Linux ] || die "native installs are for Linux with systemd; use --docker elsewhere"
  [ "$FRONT" = quicktunnel ] && die "--tunnel quick needs Docker; use a tunnel token, or --docker"
  NODE=$(find_node)
  install_bundle
  say "小爱小爱 $INSTALLED is in $DIR/current (Node: $NODE)"

  local user=xiaoaixiaoai data=/var/lib/xiaoaixiaoai env=/etc/xiaoaixiaoai/relay.env host=0.0.0.0
  if ! id "$user" >/dev/null 2>&1; then
    if have useradd; then useradd --system --home-dir "$data" --shell /usr/sbin/nologin "$user"
    else adduser -S -D -H -h "$data" "$user"; fi
  fi
  mkdir -p "$data" /etc/xiaoaixiaoai
  chown "$user:$(id -gn "$user")" "$data"
  chmod 700 "$data"
  [ -f "$env" ] || new_relay_env "$env"
  chmod 600 "$env"
  if [ "$REACH_GIVEN" = 1 ] || [ -z "$(get_env "$env" POCKET_PORT)" ]; then
    [ "$FRONT" = plain ] || host=127.0.0.1
    set_env "$env" POCKET_HOST "$host"
    set_env "$env" POCKET_PORT "$PORT"
    set_env "$env" POCKET_TRUST_PROXY "$([ "$FRONT" = plain ] && echo 0 || echo 1)"
    [ -n "$PUBLIC_URL" ] && set_env "$env" POCKET_PUBLIC_URL "$PUBLIC_URL"
  fi
  set_env "$env" POCKET_DB "$data/relay.db"
  PORT=$(get_env "$env" POCKET_PORT)
  PUBLIC_URL=$(get_env "$env" POCKET_PUBLIC_URL)

  mkdir -p /etc/systemd/system
  cat >/etc/systemd/system/xiaoaixiaoai-relay.service <<EOF
# Written by install-relay.sh. Settings: $env
[Unit]
Description=小爱小爱 relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$user
WorkingDirectory=$DIR/current
EnvironmentFile=$env
ExecStart=$NODE --no-warnings $DIR/current/apps/relay/src/main.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$data

[Install]
WantedBy=multi-user.target
EOF

  local as_user="runuser -u $user --"
  have runuser || as_user="sudo -E -u $user"
  # The database belongs to the service user: `setup` and `run` act as that user.
  cat >"$DIR/xiaoaixiaoai-relay" <<EOF
#!/bin/sh
# Manage the 小爱小爱 relay in $DIR (Node + systemd). Written by install-relay.sh.
set -e
if [ -r $env ]; then set -a; . $env; set +a; fi
cli="$NODE --no-warnings $DIR/current/apps/relay/src/cli.ts"
case "\${1:-help}" in
  update | version) exec \$cli "\$@" ;;
  setup) exec $as_user \$cli "\$@" ;;
  status) systemctl status xiaoaixiaoai-relay --no-pager || true; curl -fsS "http://127.0.0.1:\${POCKET_PORT:-7420}/v1/health"; echo ;;
  logs) exec journalctl -u xiaoaixiaoai-relay -f -n 100 ;;
  restart | stop | start) exec systemctl "\$1" xiaoaixiaoai-relay ;;
  run) exec $as_user $NODE --no-warnings $DIR/current/apps/relay/src/main.ts ;;
  *) echo "usage: xiaoaixiaoai-relay update [--check|--rollback] | status | logs | restart | stop | start | setup [--new] | version [--check] | run" ;;
esac
EOF
  link_command

  if [ "$FRONT" = caddy ]; then
    if have caddy && [ -f /etc/caddy/Caddyfile ]; then
      if ! grep -q "^$DOMAIN" /etc/caddy/Caddyfile; then
        printf '\n%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT" >>/etc/caddy/Caddyfile
        [ "$NO_START" = 1 ] || systemctl reload caddy || warn "reload Caddy yourself: systemctl reload caddy"
      fi
    else
      warn "Caddy is not installed. Install it (https://caddyserver.com/docs/install), then add to /etc/caddy/Caddyfile:"
      printf '    %s {\n        reverse_proxy 127.0.0.1:%s\n    }\n' "$DOMAIN" "$PORT" >&2
    fi
  elif [ "$FRONT" = tunnel ]; then
    if have cloudflared; then
      [ "$NO_START" = 1 ] || cloudflared service install "$TUNNEL" >/dev/null 2>&1 || warn "cloudflared service install failed (already installed?)"
    else
      warn "cloudflared is not installed: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ then: sudo cloudflared service install <token>"
    fi
  fi

  [ "$NO_START" = 1 ] && return 0
  if [ -d /run/systemd/system ]; then
    systemctl daemon-reload
    systemctl enable xiaoaixiaoai-relay >/dev/null 2>&1
    systemctl restart xiaoaixiaoai-relay
  else
    warn "systemd is not running here: run the relay in the foreground with  $DIR/xiaoaixiaoai-relay run"
    return 0
  fi
  wait_health "http://127.0.0.1:$PORT" || { journalctl -u xiaoaixiaoai-relay -n 40 --no-pager >&2 || true; die "the relay did not become healthy"; }
  SETUP_CMD=("$DIR/xiaoaixiaoai-relay" setup)
}

SETUP_CMD=() MANAGE=xiaoaixiaoai-relay
if [ "$MODE" = docker ]; then run_docker; else run_native; fi

if [ "$NO_START" = 1 ]; then
  say "files are in place; nothing was started (--no-start)"
  exit 0
fi
[ ${#SETUP_CMD[@]} -gt 0 ] || exit 0

version=$(curl -fsS "http://127.0.0.1:$PORT/v1/health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
echo >&2
say "小爱小爱 relay ${version:-} is running ($MODE, $FRONT)"
if [ -n "$PUBLIC_URL" ] && [ "$FRONT" != plain ]; then
  if wait_health "$PUBLIC_URL"; then
    say "reachable at $PUBLIC_URL"
  else
    warn "$PUBLIC_URL does not answer yet (DNS, firewall, or the certificate is still being issued)"
  fi
fi
echo >&2
# First start: a one-time code (and QR when the address is known) for the first phone or computer.
phone="Install the 小爱小爱 app and scan the QR code above (or enter the address and code)."
"${SETUP_CMD[@]}" || phone="Invite more from a connected device: App -> 设备 -> 邀请设备, or xiaoaixiaoai pair."
address=${PUBLIC_URL:-"<this relay's address>"}
settings=/etc/xiaoaixiaoai/relay.env
[ "$MODE" = docker ] && settings="$DIR/relay.env"
cat >&2 <<EOF

Next
  Phone      $phone
  Computers  On each computer:
               Install a reviewed local host bundle using this source tree's scripts/install-host.sh --source <local-bundle>.
               Then run: xiaoaixiaoai up --server $address
             It shows a QR code that a connected phone approves. A computer that comes first
             (no phone yet) uses the setup link above instead of --server.
  Settings   $settings (admin token, assistant keys), then: $MANAGE restart
  Dashboard  $address/admin with POCKET_ADMIN_TOKEN from $settings
  Manage     $MANAGE status | logs | update | setup
EOF
