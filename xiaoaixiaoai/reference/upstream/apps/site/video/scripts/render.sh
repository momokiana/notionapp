#!/bin/sh
# Render the intro film, its poster frame and the social card into ../public.
# Uses an installed Chrome/Chromium when REMOTION_BROWSER is set or Google Chrome
# is found, so no headless-shell download is needed.
set -eu
cd "$(dirname "$0")/.."
BROWSER=${REMOTION_BROWSER:-}
if [ -z "$BROWSER" ] && [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
fi
# The Chrome path has spaces, so pass it through the positional parameters.
if [ -n "$BROWSER" ]; then set -- "--browser-executable=$BROWSER"; else set --; fi
mkdir -p out ../public/video
npx remotion render src/index.ts Intro out/intro.mp4 "$@" --codec=h264 --crf=24 --pixel-format=yuv420p --concurrency="${CONCURRENCY:-4}" --log=error
npx remotion still src/index.ts Intro out/poster.png --frame="${POSTER_FRAME:-540}" "$@" --log=error
npx remotion still src/index.ts Og out/og.png "$@" --log=error
# web-friendly copies
ffmpeg -v error -y -i out/intro.mp4 -c copy -movflags +faststart ../public/video/intro.mp4
# 720p copy for phones and slow connections (about a third of the size)
ffmpeg -v error -y -i out/intro.mp4 -vf scale=1280:-2 -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart ../public/video/intro-720.mp4
cwebp -quiet -q 82 -resize 1280 0 out/poster.png -o ../public/video/intro-poster.webp
magick out/og.png -strip -quality 86 ../public/og.jpg
du -sh ../public/video/* ../public/og.jpg
