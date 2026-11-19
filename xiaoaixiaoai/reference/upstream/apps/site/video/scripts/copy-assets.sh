#!/bin/sh
# Copy the site's compressed assets into video/public (git-ignored) so Remotion's
# staticFile() can serve them. Run `pnpm assets` in ../ first if public/assets is empty.
set -eu
cd "$(dirname "$0")/.."
rm -rf public/assets public/fonts
mkdir -p public/assets public/fonts
cp -R ../public/assets/mascot ../public/assets/call ../public/assets/vendors ../public/assets/brand public/assets/
cp ../src/fonts/*.woff2 public/fonts/
cp ../../mobile/assets/brand/logo.png public/assets/brand/logo-512.png 2>/dev/null || true
echo "copied: $(du -sh public | cut -f1)"
