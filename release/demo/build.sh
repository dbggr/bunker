#!/usr/bin/env bash
# Builds release/demo/out/bunker-demo.mp4 (1920x1080, H.264 + AAC) from slides.html and narration.json.
#
# Needs: google-chrome, ffmpeg/ffprobe, jq, and Piper with a voice:
#   python3 -m venv ~/.cache/bunker-demo/piper-venv && ~/.cache/bunker-demo/piper-venv/bin/pip install piper-tts
#   cd ~/.cache/bunker-demo && piper-venv/bin/python -m piper.download_voices en_US-lessac-medium
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/out"
cache="${BUNKER_DEMO_CACHE:-$HOME/.cache/bunker-demo}"
piper="$cache/piper-venv/bin/piper"
voice="$cache/en_US-lessac-medium.onnx"
lead_in=0.6   # silence before each slide's narration
tail_out=0.9  # silence after it
fade=0.5      # crossfade between slides

for tool in google-chrome ffmpeg ffprobe jq bc; do command -v "$tool" >/dev/null || { echo "build.sh: $tool is missing" >&2; exit 1; }; done
[ -x "$piper" ] && [ -f "$voice" ] || { echo "build.sh: Piper or the voice is missing; see the header of this script" >&2; exit 1; }

rm -rf "$out" && mkdir -p "$out"
n=$(jq length "$here/narration.json")
slides=$(grep -c "<section class=\"slide" "$here/slides.html")
[ "$n" -eq "$slides" ] || { echo "build.sh: $slides slides but $n narration entries" >&2; exit 1; }

for i in $(seq 1 "$n"); do
  # Frame: exactly 1920x1080 at device scale 1. --headless=old: =new hangs on --screenshot here.
  google-chrome --headless=old --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1920,1080 --screenshot="$out/slide-$i.png" "file://$here/slides.html?s=$i" >/dev/null 2>&1 || true
  [ -s "$out/slide-$i.png" ] || { echo "build.sh: no frame for slide $i" >&2; exit 1; }

  # Voice, padded with silence at both ends, as 48 kHz stereo.
  jq -r ".[$((i - 1))]" "$here/narration.json" | "$piper" -m "$voice" -f "$out/voice-$i.wav" >/dev/null 2>&1
  ffmpeg -v error -y -i "$out/voice-$i.wav" -af "adelay=${lead_in}s:all=1,apad=pad_dur=${tail_out},aresample=48000" -ac 2 "$out/audio-$i.wav"

  # Clip: the frame held for the padded narration (+ the fade, which the next transition eats).
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out/audio-$i.wav")
  len=$(echo "$dur + $fade" | bc)
  ffmpeg -v error -y -loop 1 -framerate 30 -t "$len" -i "$out/slide-$i.png" -i "$out/audio-$i.wav" \
    -filter_complex "[0:v]scale=1920:1080,format=yuv420p,setsar=1[v];[1:a]apad=whole_dur=${len}[a]" \
    -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 18 -tune stillimage -c:a aac -b:a 192k -shortest "$out/clip-$i.mp4"
  echo "slide $i: ${dur}s"
done

# Chain the clips with crossfades (video xfade + audio acrossfade).
inputs=(); for i in $(seq 1 "$n"); do inputs+=(-i "$out/clip-$i.mp4"); done
filter=""; prev_v="[0:v]"; prev_a="[0:a]"; offset=0
for i in $(seq 2 "$n"); do
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out/clip-$((i - 1)).mp4")
  offset=$(echo "$offset + $d - $fade" | bc)
  filter+="${prev_v}[$((i - 1)):v]xfade=transition=fade:duration=${fade}:offset=${offset}[v$i];"
  filter+="${prev_a}[$((i - 1)):a]acrossfade=d=${fade}[a$i];"
  prev_v="[v$i]"; prev_a="[a$i]"
done
ffmpeg -v error -y "${inputs[@]}" -filter_complex "${filter%;}" -map "$prev_v" -map "$prev_a" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -r 30 -c:a aac -b:a 192k -movflags +faststart "$out/bunker-demo.mp4"

ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name -show_entries format=duration -of compact "$out/bunker-demo.mp4"
echo "build.sh: wrote $out/bunker-demo.mp4"
