#!/usr/bin/env bash
# Build the relay + host bundle a release ships, xiaoaixiaoai-<version>.tar.gz: the runtime
# sources with production node_modules, so installs and `update` need neither git nor pnpm.
# The dependencies are plain JavaScript, so one bundle serves macOS and Linux on any CPU.
#
# Usage: scripts/pack-release.sh [out-dir]     (default dist/; version from package.json,
#                                              stamp it first with scripts/set-version.mjs)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
version=$(node -p "require('$root/package.json').version")
out="${1:-$root/dist}"
mkdir -p "$out"
out=$(cd "$out" && pwd)
name="xiaoaixiaoai-$version"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
stage="$tmp/$name"
mkdir -p "$stage"

# Copy a folder without tests, local state or installed deps.
copy() {
  mkdir -p "$stage/$1"
  (cd "$root/$1" && COPYFILE_DISABLE=1 tar -cf - --exclude=node_modules --exclude=test --exclude=data \
    --exclude='*.db' --exclude='*.db-*' --exclude='.env' --exclude='.DS_Store' .) | (cd "$stage/$1" && tar -xf -)
}

for f in package.json pnpm-lock.yaml pnpm-workspace.yaml LICENSE NOTICE.md README.md MODIFICATIONS.md; do
  [ -e "$root/$f" ] && cp "$root/$f" "$stage/"
done
for d in "$root"/packages/*/; do copy "packages/$(basename "$d")"; done
copy apps/relay
copy apps/hostd
if [ -d "$root/apps/web/dist" ]; then
  copy apps/web/dist
fi
mkdir -p "$stage/docs"
cp "$root/docs/runtime-sessions.md" "$stage/docs/"
copy deploy
copy scripts
(cd "$stage" && pnpm install --prod --frozen-lockfile --ignore-scripts --config.confirmModulesPurge=false \
  --filter "@xiaoaixiaoai/relay..." --filter "@xiaoaixiaoai/hostd..." >/dev/null)

# Allow the service account to read the copied files and installed dependencies,
# including when the packager has a restrictive umask. pnpm can hard-link
# packages from its global store; break those links before chmod can alter it.
copytree="$tmp/normalized"
mkdir -m 700 "$copytree"
cp -a -- "$stage" "$copytree/"
stage="$copytree/$name"
chmod -R u+rwX,go+rX,go-w "$stage"

# Both CLIs must start from the staged copy before it is packed.
[ "$(node --no-warnings "$stage/apps/hostd/src/cli.ts" --version)" = "$version" ]
[ "$(node --no-warnings "$stage/apps/relay/src/cli.ts" selftest)" = "$version" ]

file="$out/$name.tar.gz"
if tar --version 2>/dev/null | grep -q GNU; then
  tar -czf "$file" -C "$copytree" --owner=0 --group=0 --numeric-owner --sort=name "$name"
else
  COPYFILE_DISABLE=1 tar -czf "$file" -C "$copytree" --uid 0 --gid 0 --numeric-owner "$name"
fi
echo "$file"
