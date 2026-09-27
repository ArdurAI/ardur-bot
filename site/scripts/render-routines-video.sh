#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: site/scripts/render-routines-video.sh <capture.webm> <shots.json>" >&2
  exit 2
fi
for command in ffmpeg ffprobe node; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is missing: $command" >&2
    exit 2
  fi
done

input=$1
shots=$2
if [[ ! -f "$input" || ! -f "$shots" ]]; then
  echo "The capture WebM and shots JSON must both exist." >&2
  exit 2
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
output_dir=${SITE_VIDEO_OUTPUT_DIR:-"${root}/site/media"}
frame_size=${SITE_VIDEO_FRAME_SIZE:-1920x1080}
mkdir -p "$output_dir"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

node --import tsx "${root}/site/scripts/routines-video-timeline.ts" \
  "$shots" "$work/filter.txt" "$work/captions.vtt" "$frame_size"

size_limit=8000000
encoded=false
for crf in 30 34 38 42 46 50; do
  vp9_crf=$((crf + 8))
  ffmpeg -hide_banner -loglevel error -y -i "$input" \
    -filter_complex_script "$work/filter.txt" \
    -map '[mp4]' -an -c:v libx264 -preset medium -crf "$crf" \
    -pix_fmt yuv420p -r 30 -movflags +faststart "$work/routines-demo.mp4" \
    -map '[webm]' -an -c:v libvpx-vp9 -deadline good -cpu-used 4 \
    -b:v 0 -crf "$vp9_crf" -pix_fmt yuv420p -r 30 "$work/routines-demo.webm"
  mp4_size=$(wc -c < "$work/routines-demo.mp4" | tr -d ' ')
  webm_size=$(wc -c < "$work/routines-demo.webm" | tr -d ' ')
  if (( mp4_size <= size_limit && webm_size <= size_limit )); then
    encoded=true
    echo "Encoding fits the 8 MB cap at H.264 CRF $crf and VP9 CRF $vp9_crf."
    break
  fi
  echo "Encoding exceeds 8 MB at H.264 CRF $crf and VP9 CRF $vp9_crf; retrying."
done
if [[ "$encoded" != true ]]; then
  echo "Could not fit both video files under 8 MB without exceeding the allowed CRF range." >&2
  exit 1
fi

duration=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$work/routines-demo.mp4")
echo "Measured total duration: ${duration}s"
poster_time=$(node -e 'const value = Number(process.argv[1]); if (!Number.isFinite(value) || value < 7) process.exit(1); console.log(value - 2)' "$duration")
ffmpeg -hide_banner -loglevel error -y -ss "$poster_time" -i "$work/routines-demo.mp4" \
  -frames:v 1 -q:v 3 "$work/routines-demo.jpg"

for file in routines-demo.mp4 routines-demo.webm routines-demo.jpg captions.vtt; do
  bytes=$(wc -c < "$work/$file" | tr -d ' ')
  if (( bytes > size_limit )); then
    echo "$file exceeds the 8 MB site asset limit ($bytes bytes)." >&2
    exit 1
  fi
done

mv "$work/routines-demo.mp4" "$output_dir/routines-demo.mp4"
mv "$work/routines-demo.webm" "$output_dir/routines-demo.webm"
mv "$work/routines-demo.jpg" "$output_dir/routines-demo.jpg"
mv "$work/captions.vtt" "$output_dir/routines-demo.en.vtt"

for file in routines-demo.mp4 routines-demo.webm; do
  echo "$file:"
  ffprobe -v error -select_streams v:0 -show_entries stream=width,height \
    -show_entries format=duration -of default=noprint_wrappers=1 \
    "$output_dir/$file"
done

if [[ -z "${SITE_VIDEO_OUTPUT_DIR:-}" ]]; then
  (cd "$root" && pnpm site:facts)
fi
