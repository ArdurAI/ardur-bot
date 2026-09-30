#!/usr/bin/env bash
# Run from a repository checkout: bash scripts/release/install-acceptance-mac.sh <dmg-or-app>
set -euo pipefail
[[ $# == 1 && "$(uname -s)" == Darwin ]] || { printf 'FAIL usage: macOS script <dmg-or-app>\n'; exit 1; }
script_dir="$(cd "$(dirname "$0")" && pwd)"
artifact="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
work="$(mktemp -d "${TMPDIR:-/tmp}/ardur-install.XXXXXX")"
logs="${ARDUR_INSTALL_LOG_DIR:-$work/logs}"
mkdir -p "$logs" "$work/Applications" "$work/mount"
logs="$(cd "$logs" && pwd)"
failed=0
pid=''
mounted=0
brew_owned=0
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1
check() {
  local label="$1"; shift
  if "$@"; then printf 'PASS %s\n' "$label" | tee -a "$logs/summary.log";
  else printf 'FAIL %s\n' "$label" | tee -a "$logs/summary.log"; failed=1; fi
}
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then kill -TERM "$pid"; wait "$pid" || true; fi
  if [[ "$brew_owned" == 1 ]]; then
    if ! brew uninstall --cask ardur >> "$logs/brew-uninstall.log" 2>&1; then
      printf 'FAIL Homebrew cleanup\n' | tee -a "$logs/summary.log"; status=1
    fi
  fi
  if [[ "$mounted" == 1 ]]; then hdiutil detach "$work/mount" -quiet || status=1; fi
  # Retain only service logs from this run's isolated profiles, never cluster or secret files.
  for profile in "$work"/profiles/*; do
    if [[ -d "$profile/logs" ]]; then cp -R "$profile/logs" "$logs/$(basename "$profile")-services" || status=1; fi
  done
  # Logs survive; delete only the installation/profile this script created.
  rm -rf "$work/Applications" "$work/BrewApplications" "$work/profiles" "$work/tap" "$work/mount" "$work/input.dmg"
  if [[ "$status" != 0 ]]; then printf 'FAIL macOS install acceptance\n' | tee -a "$logs/summary.log"; fi
  if [[ -f "$logs/summary.log" ]]; then cat "$logs/summary.log"; fi
  printf 'Logs: %s\n' "$logs"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

quarantine="0083;$(printf '%x' "$(date +%s)");Safari;"
if [[ "$artifact" == *.dmg && -f "$artifact" ]]; then
  # Never change attributes on the owner's original download.
  cp "$artifact" "$work/input.dmg"
  xattr -w com.apple.quarantine "$quarantine" "$work/input.dmg"
  hdiutil attach "$work/input.dmg" -mountpoint "$work/mount" -nobrowse -readonly > "$logs/mount.log" 2>&1
  mounted=1
  cp -R "$work/mount/Ardur.app" "$work/Applications/"
elif [[ "$artifact" == *.app && -d "$artifact" ]]; then
  cp -R "$artifact" "$work/Applications/Ardur.app"
else
  check 'artifact exists' false
  exit 1
fi
app="$work/Applications/Ardur.app"
# cp preserves existing attributes; also model Finder's inheritance from a quarantined DMG.
xattr -w com.apple.quarantine "$quarantine" "$app"
xattr -l "$app" > "$logs/quarantine.log"
check 'browser quarantine retained' xattr -p com.apple.quarantine "$app"

arch="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
binary="$app/Contents/MacOS/$arch"
signed=false
evidence="${artifact%.dmg}"
evidence="$(dirname "$artifact")/install-build-mac-${evidence##*-}.json"
if [[ -f "$evidence" ]]; then
  signed="$(python3 - "$evidence" <<'PY'
import json, sys
record = json.load(open(sys.argv[1]))
assert type(record.get('signed')) is bool, 'Invalid build signing evidence'
print(str(record['signed']).lower())
PY
)"
  cp "$evidence" "$logs/build-signing.json"
elif [[ "${CI:-}" == true ]]; then
  check 'build signing evidence present' false
  exit 1
else
  # Hand-run old downloads and --dir builds may predate the evidence record.
  codesign -dv "$app" > "$logs/signature.log" 2>&1 || true
  if grep -q '^Authority=Developer ID Application:' "$logs/signature.log"; then signed=true; fi
  printf 'Manual run: no build record; signature inspection signed=%s\n' "$signed" | tee -a "$logs/summary.log"
fi
printf 'Build signing mode: signed=%s\n' "$signed" | tee -a "$logs/summary.log"
check 'bundle seal (deep strict)' codesign --verify --deep --strict --verbose=1 "$app" > "$logs/codesign.log" 2>&1
cat "$logs/codesign.log"
spctl_status=0
spctl -a -t exec -vv "$app" > "$logs/spctl.log" 2>&1 || spctl_status=$?
cat "$logs/spctl.log"
verdict() {
  ! grep -Eiq 'damaged|no resources|invalid|unsealed|obsolete|internal error' "$logs/spctl.log" || return 1
  if [[ "$signed" == true ]]; then
    [[ "$spctl_status" == 0 ]] && grep -Eq ': accepted$' "$logs/spctl.log" && grep -q '^source=Notarized Developer ID$' "$logs/spctl.log"
  else
    # Some macOS versions print only the verdict for a self-signed app, no "source=" line.
    [[ "$spctl_status" != 0 ]] && grep -Eq ': rejected$' "$logs/spctl.log"
  fi
}
check "Gatekeeper verdict (signed=$signed)" verdict
[[ "$failed" == 0 ]] || exit 1
xattr -dr com.apple.quarantine "$app"

smoke() {
  local label="$1" executable="$2" status=0
  mkdir -p "$work/profiles/$label"
  env -u ELECTRON_RUN_AS_NODE -u ARDURBOT_WEB_URL -u ARDURBOT_LOCAL_WEB_URL \
    ARDUR_INSTALL_SMOKE=1 ARDURBOT_DISABLE_AUTO_UPDATE=1 ARDURBOT_GUIDED_SETUP=0 \
    ARDURBOT_USER_DATA_DIR="$work/profiles/$label" \
    ARDUR_INSTALL_SMOKE_SCREENSHOT="$logs/$label.png" \
    "$executable" > "$logs/$label.stdout.log" 2> "$logs/$label.stderr.log" &
  pid=$!
  local deadline=$((SECONDS + 180))
  while kill -0 "$pid" 2>/dev/null && [[ "$SECONDS" -lt "$deadline" ]]; do sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid"
    for _ in {1..10}; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid"; fi
    wait "$pid" || true; pid=''; return 1
  fi
  wait "$pid" || status=$?
  pid=''
  [[ "$status" == 0 ]] && grep -qx 'ARDUR_INSTALL_SMOKE_PASS' "$logs/$label.stdout.log" &&
    ! grep -Eiq 'Unable to|damaged|FATAL|crashed|Uncaught Exception' "$logs/$label.stderr.log" "$logs/$label.stdout.log"
}
check 'installed bundle opens, health answers, clean exit' smoke bundle "$binary"
if [[ "$artifact" == *.app ]]; then
  printf 'SKIP DMG and Homebrew: directory-build diagnostic only\n' | tee -a "$logs/summary.log"
  exit "$failed"
fi
if ! command -v brew >/dev/null || brew list --cask ardur >/dev/null 2>&1 || [[ -e "$(brew --prefix)/bin/ardur" ]]; then
  check 'Homebrew available without an existing Ardur installation' false
  exit 1
fi
mkdir -p "$work/tap/Casks" "$work/BrewApplications"
# Render the shipped template using the release substitutions, retaining the real launcher.
python3 - "$script_dir/../../homebrew/Casks/ardur.rb" "$work/tap/Casks/ardur.rb" "$work/input.dmg" "$app/Contents/Info.plist" "$signed" <<'PY'
import hashlib, pathlib, plistlib, re, sys
source, output, dmg, info, signed = sys.argv[1:]
version = plistlib.load(open(info, 'rb'))['CFBundleShortVersionString']
assert re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?', version)
text = pathlib.Path(source).read_text()
text = re.sub(r'^# Release workflow replaces[^\n]*\n', '', text)
text = text.replace('@VERSION@', version).replace('@MACOS_CAVEATS@', '')
sha = hashlib.sha256(pathlib.Path(dmg).read_bytes()).hexdigest()
text = text.replace('@ARM64_SHA256@', sha).replace('@X64_SHA256@', sha)
text = re.sub(r'    url "[^\n]+"', '    url "' + pathlib.Path(dmg).as_uri() + '"', text)
pathlib.Path(output).write_text(text)
PY
# This file is outside Homebrew's taps; tap trust does not apply to local cask paths.
# Mark ownership before install so a partially installed cask is removed on failure too.
brew_owned=1
check 'Homebrew local cask install' brew install --cask --appdir="$work/BrewApplications" "$work/tap/Casks/ardur.rb" > "$logs/brew-install.log" 2>&1
cat "$logs/brew-install.log"
if [[ "$failed" == 0 ]]; then
  # New Homebrew versions removed --no-quarantine. The policy verdict was checked above;
  # remove quarantine only from this run's installed copy before testing its launcher.
  check 'Homebrew installed-copy quarantine removal' xattr -dr com.apple.quarantine "$work/BrewApplications/Ardur.app"
  if [[ "$failed" == 0 ]]; then check 'Homebrew ardur wrapper opens, health answers, clean exit' smoke brew "$(brew --prefix)/bin/ardur"; fi
fi
check 'Homebrew silent cleanup' brew uninstall --cask ardur > "$logs/brew-uninstall.log" 2>&1
if [[ "$failed" == 0 ]]; then brew_owned=0; fi
exit "$failed"
