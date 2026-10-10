#!/usr/bin/env bash
# Reproduce el showreel desde cero: música → fotogramas → MP4.
# Requisitos: node ≥ 18 con playwright (Chromium), ffmpeg con libx264.
set -euo pipefail
cd "$(dirname "$0")"
WORK="${WORK:-build}"; mkdir -p "$WORK"
[ -e node_modules ] || ln -s "$(npm root -g)" node_modules   # playwright global
node music.mjs "$WORK/music.wav"
node render.mjs "$WORK/frames" --frames=0-239 --sub=8 --workers="${WORKERS:-3}"
ffmpeg -y -hide_banner -loglevel error \
  -framerate 30 -i "$WORK/frames/f%04d.png" -i "$WORK/music.wav" \
  -vf "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p" \
  -c:v libx264 -preset slow -crf 18 -profile:v high -level 4.1 \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 320k -ar 48000 -t 8 -movflags +faststart \
  showreel.mp4
echo "OK → $(pwd)/showreel.mp4"
