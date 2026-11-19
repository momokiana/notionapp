#!/usr/bin/env bash
# 小爱小爱 for a computer (macOS or Linux): installs the `xiaoaixiaoai` command, registers this
# computer with your relay and keeps it online in the background (launchd, or systemd --user).
# Runs as your user; no sudo.
#
#   bash scripts/install-host.sh --source /path/to/xiaoaixiaoai-0.1.0.tar.gz --server https://xiaoaixiaoai.example.com
#
#   --server <url>      your relay. A phone that is already connected scans the QR code shown and approves.
#   --code <CODE>       register with an invite or setup code instead (first computer on a new relay)
#   <invite link>       the same as one link: https://<server>/p/<CODE> or xiaoaixiaoai://pair?...
#   --name <name>       device name (default: this computer's name)
#   --read-only         phones and other computers may look but not type
#   --version <x.y.z>   legacy option; the local bundle's manifest remains authoritative
#   --dir <path>        install folder (default ~/.local/share/xiaoaixiaoai)
#   --source <path>     required: an existing local checkout or release bundle (not a URL)
#   --with-node         use a private Node in <dir>/node even if one is installed
#   --no-service        install the command only; then run `xiaoaixiaoai up` yourself
#
# This fork has no configured remote release source. HERDR_POCKET_REPO cannot enable one.
# A missing Node runtime may still be fetched from nodejs.org / npmmirror.com, with checksums,
# but only after the explicit local source passes policy. XIAOAIXIAOAI_MIRROR selects that order.
# Remote `xiaoaixiaoai update` stays disabled; use a reviewed local bundle. `status` shows state.
set -euo pipefail
# Also stop on errors inside $(...) where bash supports it (4.4+).
shopt -s inherit_errexit 2>/dev/null || true

NODE_MAJOR=24
LABEL=com.xiaoaixiaoai.hostd
UNIT=xiaoaixiaoai-hostd.service

say() { printf '\033[1;35m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mx\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
fetch() { curl -fsSL --retry 3 --connect-timeout 20 -o "$2" "$1"; }
sha256() { if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

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

node_ok() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null
}

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
    for n in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
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

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
daemon_running() { "$CMD" status 2>/dev/null | grep -q "^daemon *running"; }

# ----------------------------------------------------------------------------------------------------------------------------------

SERVER="" CODE="" LINK="" NAME="" READ_ONLY=0 VERSION="" SOURCE="" WITH_NODE=0 NO_SERVICE=0 INSTALLED=""
DIR="$HOME/.local/share/xiaoaixiaoai"
BIN_DIR="$HOME/.local/bin"

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER=${2:?}; shift 2 ;;
    --code) CODE=${2:?}; shift 2 ;;
    --name) NAME=${2:?}; shift 2 ;;
    --read-only) READ_ONLY=1; shift ;;
    --version) VERSION=${2:?}; shift 2 ;;
    --dir) DIR=${2:?}; shift 2 ;;
    --source) SOURCE=${2:?}; shift 2 ;;
    --with-node) WITH_NODE=1; shift ;;
    --no-service) NO_SERVICE=1; shift ;;
    -h | --help) [ -f "$0" ] && sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) LINK=$1; shift ;;
  esac
done

# Policy must run before directory writes, Node bootstrap, metadata requests or services.
[ -n "$SOURCE" ] || die "Owned release source is not configured; explicit local bundle required (--source)."
case "$SOURCE" in *://* | //*) die "--source must be a local checkout or bundle path, not a URL/network path" ;; esac
[ -d "$SOURCE" ] || [ -f "$SOURCE" ] || die "--source must name an existing local checkout or bundle"
SOURCE=$(cd "$(dirname "$SOURCE")" && pwd -P)/$(basename "$SOURCE")

case "$(uname -s)" in Darwin) OS=macos ;; Linux) OS=linux ;; *) die "小爱小爱 runs on macOS and Linux" ;; esac
[ "$(id -u)" != 0 ] || warn "running as root: the computer is registered for root, not for your user"
have curl || die "curl is needed"
mkdir -p "$DIR" "$BIN_DIR"
DIR=$(cd "$DIR" && pwd -P)

NODE=$(find_node)
install_bundle
say "小爱小爱 $INSTALLED is in $DIR (Node: $NODE)"

# The command: a small script with fixed paths, so it works without Node on PATH.
CMD="$BIN_DIR/xiaoaixiaoai"
if [ -e "$CMD" ] && ! grep -q "install-host.sh" "$CMD" 2>/dev/null; then
  mv "$CMD" "$CMD.bak"
  warn "moved the previous $CMD to $CMD.bak"
fi
cat >"$CMD" <<EOF
#!/bin/sh
# Written by install-host.sh. Update with: xiaoaixiaoai update
exec "$NODE" --no-warnings "$DIR/current/apps/hostd/src/cli.ts" "\$@"
EOF
chmod 755 "$CMD"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR is not on your PATH: add  export PATH=\"$BIN_DIR:\$PATH\"  to your shell profile" ;; esac

# Register unless this computer already is (with the same relay).
config="${XIAOAIXIAOAI_HOME:-$HOME/.config/xiaoaixiaoai}/hostd.json"
registered=0
if [ -f "$config" ] && [ -z "$LINK$CODE" ]; then
  current_server=$("$NODE" -p "try{require('$config').server||''}catch{''}")
  wanted=${SERVER%/}
  case "$wanted" in "" | http://* | https://*) ;; *) wanted="https://$wanted" ;; esac
  if [ -n "$current_server" ] && { [ -z "$wanted" ] || [ "$wanted" = "$current_server" ]; }; then
    registered=1
    say "already registered with $current_server"
  fi
fi
if [ "$registered" = 0 ]; then
  if [ -n "$SERVER$LINK$CODE" ]; then
    args=()
    [ -n "$LINK" ] && args+=("$LINK")
    [ -n "$SERVER" ] && args+=(--server "$SERVER")
    [ -n "$CODE" ] && args+=(--code "$CODE")
    [ -n "$NAME" ] && args+=(--name "$NAME")
    # Under `curl | bash` stdin is the script; give the login the terminal when there is one.
    if (: </dev/tty) 2>/dev/null; then "$CMD" login "${args[@]}" </dev/tty; else "$CMD" login "${args[@]}"; fi
    registered=1
  else
    warn "no --server given: the command is installed, this computer is not registered yet"
  fi
fi

run_args=(run)
[ "$READ_ONLY" = 1 ] && run_args+=(--read-only)

if [ "$NO_SERVICE" = 1 ] || [ "$registered" = 0 ]; then
  cat >&2 <<EOF

Next
  xiaoaixiaoai up${SERVER:+ --server $SERVER}     register (if needed) and keep this computer online
  Remote updates are disabled; install another reviewed local bundle with --source.
EOF
  exit 0
fi

if [ "$OS" = macos ]; then
  # A daemon started by hand would make the service exit with "already running".
  if daemon_running && ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    warn "xiaoaixiaoai is already running in a terminal: stop it (Ctrl+C) so the background service can take over"
  fi
  plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  log_dir="$HOME/Library/Logs/xiaoaixiaoai"
  mkdir -p "$(dirname "$plist")" "$log_dir"
  {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by install-host.sh: keeps 小爱小爱 online. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>--no-warnings</string>
    <string>$(xml "$DIR")/current/apps/hostd/src/cli.ts</string>
EOF
    for a in "${run_args[@]}"; do printf '    <string>%s</string>\n' "$a"; done
    cat <<EOF
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(xml "$(dirname "$NODE"):$PATH")</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml "$log_dir")/hostd.log</string>
  <key>StandardErrorPath</key><string>$(xml "$log_dir")/hostd.log</string>
</dict>
</plist>
EOF
  } >"$plist"
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  logs="$log_dir/hostd.log"
else
  if daemon_running && ! systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
    warn "xiaoaixiaoai is already running in a terminal: stop it (Ctrl+C) so the background service can take over"
  fi
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unit_dir"
  cat >"$unit_dir/$UNIT" <<EOF
# Written by install-host.sh: keeps 小爱小爱 online.
[Unit]
Description=小爱小爱 host
After=network-online.target

[Service]
ExecStart=$NODE --no-warnings $DIR/current/apps/hostd/src/cli.ts ${run_args[*]}
Environment="PATH=$(dirname "$NODE"):$PATH"
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null 2>&1
  systemctl --user restart "$UNIT"
  # Keep it running after you log out.
  loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || warn "to keep it online after logout: sudo loginctl enable-linger $(id -un)"
  logs="journalctl --user -u $UNIT -f"
fi

for _ in $(seq 1 10); do
  daemon_running && break
  sleep 1
done
echo >&2
"$CMD" status || true
cat >&2 <<EOF

小爱小爱 runs in the background and starts with your session.
  Logs     $logs
  Update   rerun this saved installer with --source <reviewed-local-bundle> (remote updates disabled)
  Invite   xiaoaixiaoai pair     (QR code for a phone or another computer)
EOF
