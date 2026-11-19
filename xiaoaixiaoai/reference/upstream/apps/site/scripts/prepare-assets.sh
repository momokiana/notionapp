#!/bin/sh
# Copy and compress brand/mascot assets from the app and design sources into
# public/assets. Re-run after the mascot or vendor avatars change.
# Needs: python3 (numpy, Pillow), ffmpeg, cwebp, img2webp, magick.
set -eu
cd "$(dirname "$0")/.."
ROOT=../..
M=$ROOT/apps/mobile/assets
GEN=$ROOT/docs/design/gen/2026-11-14-ui
OUT=public/assets
mkdir -p "$OUT/mascot" "$OUT/call" "$OUT/vendors" "$OUT/brand"

# Vendor avatars and the six animated call faces are already small webp files.
cp "$M"/vendors/*.webp "$OUT/vendors/"
cp "$M"/mascot/call/*.webp "$OUT/call/"
cp "$M"/mascot/anim/working.webp "$OUT/mascot/working.webp"

# Stickers: 300 px tall webp.
for n in default hello sleepy waiting yay; do
  cwebp -quiet -q 84 -alpha_q 92 -resize 0 300 "$M/mascot/$n.png" -o "$OUT/mascot/$n.webp"
done

# Brand: small logo, favicon, touch icon.
cwebp -quiet -q 88 -resize 64 64 "$M/brand/logo.png" -o "$OUT/brand/logo-64.webp"
cwebp -quiet -q 86 -resize 160 160 "$M/brand/logo.png" -o "$OUT/brand/logo-160.webp"
magick "$M/brand/logo.png" -resize 64x64 -strip public/favicon.png
magick "$M/brand/logo.png" -resize 180x180 -strip public/apple-touch-icon.png

# Hero mascot: key the green-screen source clips into 480 px RGBA frames with a
# shared crop (so idle and tap swap without a jump), then encode animated webp.
# The source clips are not published (docs/design/gen is git-ignored), so a
# fresh clone keeps the committed idle.webp, tap.webp and idle-poster.webp.
if [ -f "$GEN/anim/key.py" ]; then
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  CROP=12,0,712,712
  python3 -I "$GEN/anim/key.py" "$GEN/anim/idle-src.mp4" "$TMP/idle" --size 480 --fps 18 --crop $CROP --xfade 6 --aq 4
  python3 -I "$GEN/anim/key.py" "$GEN/anim/tap-src.mp4" "$TMP/tap" --size 480 --fps 18 --crop $CROP --aq 4
  img2webp -loop 0 -lossy -q 72 -m 6 -d 56 "$TMP"/idle/*.png -o "$OUT/mascot/idle.webp"
  img2webp -loop 1 -lossy -q 72 -m 6 -d 56 "$TMP"/tap/*.png -o "$OUT/mascot/tap.webp"
  cwebp -quiet -q 80 -alpha_q 90 "$TMP/idle/000.png" -o "$OUT/mascot/idle-poster.webp"
else
  echo "hero animation sources not found; keeping the committed idle.webp, tap.webp and idle-poster.webp"
fi

du -sh "$OUT"/* public/*.png
