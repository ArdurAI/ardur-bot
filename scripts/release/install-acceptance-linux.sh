#!/usr/bin/env bash
# bash scripts/release/install-acceptance-linux.sh <deb-or-AppImage>
set -euo pipefail
[[ $# == 1 ]] || { printf 'FAIL usage: Linux script <deb-or-AppImage>\n'; exit 1; }
artifact="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
case "$artifact" in
  *.deb) kind=deb ;;
  *.AppImage) kind=AppImage ;;
  *) printf 'FAIL expected deb or AppImage\n'; exit 1 ;;
esac
[[ -f "$artifact" ]] || { printf 'FAIL artifact missing\n'; exit 1; }
work="$(mktemp -d "${TMPDIR:-/tmp}/ardur-install.XXXXXX")"
logs="${ARDUR_INSTALL_LOG_DIR:-$work/logs}/$kind"
mkdir -p "$logs"
logs="$(cd "$logs" && pwd)"
# Only this newly created evidence directory is writable by the container's unprivileged user.
chmod 0777 "$logs"
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -s "$work/container-id" ]]; then
    docker stop "$(< "$work/container-id")" >/dev/null 2>&1 || true
  fi
  rm -f "$work/container-id"
  printf 'Logs: %s\n' "$logs"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' INT TERM
printf 'Clean image: ubuntu:24.04; non-root desktop launch\n' | tee "$logs/summary.log"
chmod 0666 "$logs/summary.log"
status=0
docker run --rm --cidfile "$work/container-id" \
  --mount "type=bind,source=$artifact,target=/input/ardur.$kind,readonly" \
  --mount "type=bind,source=$logs,target=/evidence" \
  ubuntu:24.04 bash -s -- "$kind" > "$logs/container.log" 2>&1 <<'CONTAINER' || status=$?
set -euo pipefail
kind="$1"
fail() { printf 'FAIL %s\n' "$1" | tee -a /evidence/summary.log; exit 1; }
pass() { printf 'PASS %s\n' "$1" | tee -a /evidence/summary.log; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
# The base has no display, session bus, namespace probe or Electron libraries.
apt-get install -y --no-install-recommends xvfb xauth dbus-x11 util-linux \
  libgtk-3-0 libnss3 libasound2t64 libgbm1 libnotify4 libxss1 libxtst6 libdrm2 libx11-xcb1
useradd --create-home --shell /bin/bash install-test
if [[ "$kind" == deb ]]; then
  apt-get install -y /input/ardur.deb || fail 'deb dependencies and install'
  command -v ardur >/dev/null || fail 'installed ardur command'
  pass 'deb dependencies and install'
else
  cp /input/ardur.AppImage /home/install-test/ardur.AppImage
  chmod +x /home/install-test/ardur.AppImage
  chown install-test:install-test /home/install-test/ardur.AppImage
  pass 'AppImage executable install'
fi
runuser -u install-test -- bash -s -- "$kind" <<'LAUNCH'
set -euo pipefail
kind="$1"
export HOME=/home/install-test XDG_RUNTIME_DIR=/home/install-test/runtime
mkdir -p "$XDG_RUNTIME_DIR" "$HOME/profile"
chmod 0700 "$XDG_RUNTIME_DIR"
args=()
if ! unshare --user --map-root-user true >/dev/null 2>&1; then
  printf 'Container user namespaces unavailable (unshare denied by Docker seccomp/kernel); using --no-sandbox.\n' | tee -a /evidence/summary.log
  args+=(--no-sandbox)
else
  printf 'User namespaces available; Chromium sandbox remains enabled.\n' | tee -a /evidence/summary.log
fi
if [[ "$kind" == deb ]]; then
  executable="$(command -v ardur)"
else
  executable="$HOME/ardur.AppImage"
  if [[ ! -c /dev/fuse || ! -r /dev/fuse || ! -w /dev/fuse ]]; then
    printf 'FUSE unavailable in this container; using --appimage-extract-and-run.\n' | tee -a /evidence/summary.log
    args=(--appimage-extract-and-run "${args[@]}")
  fi
fi
export ARDUR_INSTALL_SMOKE=1 ARDURBOT_DISABLE_AUTO_UPDATE=1 ARDURBOT_GUIDED_SETUP=0
export ARDURBOT_USER_DATA_DIR="$HOME/profile" ARDUR_INSTALL_SMOKE_SCREENSHOT=/evidence/window.png
xvfb-run --auto-servernum dbus-run-session -- "$executable" "${args[@]}" > /evidence/app.stdout.log 2> /evidence/app.stderr.log &
pid=$!
# The container owns all descendants; --rm tears them down even on a hung launch.
trap 'kill -TERM "$pid" 2>/dev/null || true' EXIT
status=0
deadline=$((SECONDS + 180))
while kill -0 "$pid" 2>/dev/null && [[ "$SECONDS" -lt "$deadline" ]]; do sleep 1; done
if kill -0 "$pid" 2>/dev/null; then
  printf 'FAIL installed app timed out\n' | tee -a /evidence/summary.log
  exit 1
fi
wait "$pid" || status=$?
trap - EXIT
if [[ "$status" != 0 ]] || ! grep -qx 'ARDUR_INSTALL_SMOKE_PASS' /evidence/app.stdout.log ||
  grep -Eiq 'FATAL|Unable to|damaged|crashed|Uncaught Exception' /evidence/app.stderr.log /evidence/app.stdout.log; then
  printf 'FAIL installed app health/window/clean exit (status=%s)\n' "$status" | tee -a /evidence/summary.log
  exit 1
fi
printf 'PASS installed app opens, health answers, clean exit\n' | tee -a /evidence/summary.log
LAUNCH
CONTAINER
cat "$logs/container.log"
if [[ "$status" != 0 ]]; then
  printf 'FAIL %s clean-container acceptance\n' "$kind" | tee -a "$logs/summary.log"
else
  printf 'PASS %s clean-container acceptance\n' "$kind" | tee -a "$logs/summary.log"
fi
exit "$status"
