#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"

echo "Testing install.sh dry-run"
"$root/scripts/install.sh" --dry-run --version v0.1.0 | grep "Plan: Download"

echo "Testing install.sh checksum failure"
TMP_DIR=$(mktemp -d)
# Create a dummy checksums file and dummy asset
mkdir -p "$TMP_DIR/mnt"
echo "badhash  ardur-bot-0.1.0-mac-arm64.dmg" > "$TMP_DIR/checksums.txt"
echo "badhash  ardur-bot-0.1.0-mac-x64.dmg" >> "$TMP_DIR/checksums.txt"
echo "badhash  ardur-bot-0.1.0-linux-x64.deb" >> "$TMP_DIR/checksums.txt"
echo "badhash  ardur-bot-0.1.0-linux-x64.AppImage" >> "$TMP_DIR/checksums.txt"
echo "badhash  ardur-bot-0.1.0-linux-arm64.deb" >> "$TMP_DIR/checksums.txt"
echo "badhash  ardur-bot-0.1.0-linux-arm64.AppImage" >> "$TMP_DIR/checksums.txt"

export PATH="$TMP_DIR:$PATH"
cat << 'MOCK' > "$TMP_DIR/curl"
#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do
  case $1 in
    -o)
      OUT="$2"
      shift 2
      ;;
    *)
      if [[ "$1" == *checksums.txt* ]]; then
        URL="checksums.txt"
      elif [[ "$1" == *ardur-bot-* ]]; then
        URL="ardur-bot"
      fi
      shift
      ;;
  esac
done
if [[ "$URL" == "checksums.txt" ]]; then
  cp checksums.txt "$OUT"
else
  echo "dummy" > "$OUT"
fi
MOCK
chmod +x "$TMP_DIR/curl"

cd "$TMP_DIR"
if "$root/scripts/install.sh" --version v0.1.0; then
  echo "Expected install.sh to fail on bad checksum!" >&2
  exit 1
fi
echo "Successfully rejected bad checksum."
cd "$root"
rm -rf "$TMP_DIR"

echo "Testing install.sh on Linux without shasum"
LINUX_DIR=$(mktemp -d)
BIN_DIR=$(mktemp -d)

for cmd in bash grep cut mktemp rm cat mkdir cp chmod sha256sum; do
  p="$(command -v "$cmd" || true)"
  if [[ -n "$p" ]]; then
    ln -s "$p" "$BIN_DIR/$cmd"
  fi
done

cat << 'MOCK' > "$BIN_DIR/uname"
#!/usr/bin/env bash
if [[ "$1" == "-s" ]]; then
  echo "Linux"
elif [[ "$1" == "-m" ]]; then
  echo "x86_64"
else
  echo "Linux"
fi
MOCK
chmod +x "$BIN_DIR/uname"

cat << 'MOCK' > "$BIN_DIR/curl"
#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do
  case $1 in
    -o)
      OUT="$2"
      shift 2
      ;;
    *)
      if [[ "$1" == *checksums.txt* ]]; then
        URL="checksums.txt"
      elif [[ "$1" == *ardur-bot-* ]]; then
        URL="ardur-bot"
      fi
      shift
      ;;
  esac
done
if [[ "$URL" == "checksums.txt" ]]; then
  cp checksums.txt "$OUT"
else
  echo "dummy" > "$OUT"
fi
MOCK
chmod +x "$BIN_DIR/curl"

echo "badhash  ardur-bot-0.1.0-linux-x64.AppImage" > "$LINUX_DIR/checksums.txt"
echo "badhash  ardur-bot-0.1.0-linux-x64.deb" >> "$LINUX_DIR/checksums.txt"

cd "$LINUX_DIR"
if PATH="$BIN_DIR" "$root/scripts/install.sh" --version v0.1.0 2>/dev/null; then
  echo "Expected install.sh to fail on bad checksum on Linux without shasum!" >&2
  exit 1
fi

DUMMY_SHA=$(printf "dummy\n" | "$BIN_DIR/sha256sum" | cut -d ' ' -f 1)
echo "${DUMMY_SHA}  ardur-bot-0.1.0-linux-x64.AppImage" > "$LINUX_DIR/checksums.txt"
echo "${DUMMY_SHA}  ardur-bot-0.1.0-linux-x64.deb" >> "$LINUX_DIR/checksums.txt"

HOME="$LINUX_DIR/home" PATH="$BIN_DIR" "$root/scripts/install.sh" --version v0.1.0 >/dev/null
if [[ ! -x "$LINUX_DIR/home/.local/bin/ardur-bot.AppImage" ]]; then
  echo "Expected AppImage to be installed on Linux without shasum!" >&2
  exit 1
fi
echo "Successfully verified Linux without shasum uses sha256sum."
cd "$root"
rm -rf "$LINUX_DIR" "$BIN_DIR"

echo "Testing dev script does not call docker compose"
# Just grep dev.ts
if grep -q "docker compose" "$root/scripts/dev.ts"; then
  echo "dev.ts should not call docker compose" >&2
  exit 1
fi
