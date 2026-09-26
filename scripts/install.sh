#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
TARGET_VERSION=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --version)
      TARGET_VERSION="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

OS="$(uname -s)"
ARCH="$(uname -m)"

if [[ "$OS" == "Darwin" ]]; then
  PLATFORM="mac"
  if [[ "$ARCH" == "arm64" ]]; then
    ASSET_ARCH="arm64"
  else
    ASSET_ARCH="x64"
  fi
  EXT="dmg"
elif [[ "$OS" == "Linux" ]]; then
  PLATFORM="linux"
  if [[ "$ARCH" == "aarch64" ]]; then
    ASSET_ARCH="arm64"
  else
    ASSET_ARCH="x64"
  fi
  if command -v apt >/dev/null 2>&1; then
    EXT="deb"
  else
    EXT="AppImage"
  fi
else
  echo "Unsupported OS: $OS" >&2
  exit 1
fi

if [[ -z "$TARGET_VERSION" ]]; then
  TARGET_VERSION=$(curl -sL https://api.github.com/repos/ArdurAI/ardur-bot/releases | grep -m 1 '"tag_name":' | cut -d '"' -f 4 || true)
  if [[ -z "$TARGET_VERSION" ]]; then
    echo "Failed to fetch latest release version." >&2
    exit 1
  fi
fi

# Strip 'v' if present for asset name
ASSET_VERSION="${TARGET_VERSION#v}"
ASSET_NAME="ardur-bot-${ASSET_VERSION}-${PLATFORM}-${ASSET_ARCH}.${EXT}"
DOWNLOAD_URL="https://github.com/ArdurAI/ardur-bot/releases/download/${TARGET_VERSION}/${ASSET_NAME}"
CHECKSUM_URL="https://github.com/ArdurAI/ardur-bot/releases/download/${TARGET_VERSION}/checksums.txt"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Plan: Download $ASSET_NAME (version $TARGET_VERSION)"
  echo "Plan: Verify checksum against checksums.txt"
  if [[ "$PLATFORM" == "mac" ]]; then
    echo "Plan: Mount DMG and copy Ardur Bot.app to Applications"
  elif [[ "$EXT" == "deb" ]]; then
    echo "Plan: Install deb via apt"
  else
    echo "Plan: Copy AppImage to ~/.local/bin and chmod +x"
  fi
  exit 0
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading $ASSET_NAME..."
if ! curl -f -sSL "$DOWNLOAD_URL" -o "$TMP_DIR/$ASSET_NAME"; then
  echo "Failed to download $ASSET_NAME." >&2
  exit 1
fi

echo "Downloading checksums.txt..."
if ! curl -f -sSL "$CHECKSUM_URL" -o "$TMP_DIR/checksums.txt"; then
  echo "Failed to download checksums file." >&2
  exit 1
fi

echo "Verifying checksum..."
cd "$TMP_DIR"
if ! grep "$ASSET_NAME" checksums.txt | shasum -a 256 -c > /dev/null 2>&1; then
  echo "Checksum verification failed for $ASSET_NAME." >&2
  exit 1
fi
cd - > /dev/null

echo "Installing..."
if [[ "$PLATFORM" == "mac" ]]; then
  MOUNT_DIR="$TMP_DIR/mnt"
  mkdir -p "$MOUNT_DIR"
  hdiutil attach "$TMP_DIR/$ASSET_NAME" -mountpoint "$MOUNT_DIR" -nobrowse -quiet
  
  if [ -w "/Applications" ]; then
    APP_DIR="/Applications"
  else
    APP_DIR="$HOME/Applications"
    mkdir -p "$APP_DIR"
  fi
  
  rm -rf "$APP_DIR/Ardur Bot.app"
  cp -R "$MOUNT_DIR/Ardur Bot.app" "$APP_DIR/"
  hdiutil detach "$MOUNT_DIR" -quiet
  
  echo "Installed to $APP_DIR/Ardur Bot.app."
  echo "Unsigned preview: Approve the app in Privacy & Security before launching."
elif [[ "$EXT" == "deb" ]]; then
  echo "Installing deb package using apt (sudo required)..."
  sudo apt install -y "$TMP_DIR/$ASSET_NAME"
else
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
  cp "$TMP_DIR/$ASSET_NAME" "$BIN_DIR/ardur-bot.AppImage"
  chmod +x "$BIN_DIR/ardur-bot.AppImage"
  echo "Installed to $BIN_DIR/ardur-bot.AppImage."
  
  # Basic .desktop entry
  DESKTOP_FILE="$HOME/.local/share/applications/ardur-bot.desktop"
  mkdir -p "$HOME/.local/share/applications"
  cat << DESK > "$DESKTOP_FILE"
[Desktop Entry]
Name=Ardur Bot
Exec=$BIN_DIR/ardur-bot.AppImage
Type=Application
Categories=Development;
DESK
fi

echo "Installation complete."
