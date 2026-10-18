#!/usr/bin/env bash
# Renders selected slides of release/demo/slides.html to site/public/slides/*.webp for the docs site.
# Needs google-chrome and ffmpeg. Re-run when the slides change.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
deck="$here/../release/demo/slides.html"
out="$here/public/slides"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out"
# slide number → file name
for pair in 3:how-it-works 4:unattended 5:safety 6:built-itself; do
  n="${pair%%:*}"; name="${pair#*:}"
  google-chrome --headless=old --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1920,1080 --screenshot="$tmp/$name.png" "file://$deck?s=$n" >/dev/null 2>&1 || true
  [ -s "$tmp/$name.png" ] || { echo "render-slides: no frame for slide $n" >&2; exit 1; }
  ffmpeg -v error -y -i "$tmp/$name.png" -vf scale=1600:-1 -c:v libwebp -quality 82 "$out/$name.webp"
  echo "$name.webp $(du -k "$out/$name.webp" | cut -f1) KB"
done
