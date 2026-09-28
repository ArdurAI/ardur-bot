#!/bin/bash
set -e
files=(
  "apps/web/public/favicon-16x16.png"
  "apps/web/public/favicon-32x32.png"
  "apps/web/public/apple-touch-icon.png"
  "apps/web/public/icon-192.png"
  "apps/web/public/icon-512.png"
  "apps/www/public/favicon-16x16.png"
  "apps/www/public/favicon-32x32.png"
  "apps/www/public/apple-touch-icon.png"
  "apps/www/public/icon-192.png"
  "apps/www/public/icon-512.png"
  "apps/desktop/assets/icon.png"
  "apps/desktop/assets/trayTemplate.png"
  "apps/desktop/assets/icon-macos.png"
  "apps/desktop/assets/icon.ico"
  "apps/mobile/assets/icon.png"
  "apps/mobile/assets/splash-icon.png"
  "apps/mobile/assets/adaptive-icon.png"
  "apps/mobile/assets/monochrome-icon.png"
  "apps/mobile/assets/icon-background.png"
  "apps/mobile/assets/favicon.png"
  "apps/mobile/assets/notification-icon.png"
  "apps/web/public/favicon.ico"
  "apps/www/public/favicon.ico"
  "apps/web/public/favicon.svg"
  "apps/www/public/favicon.svg"
)
for f in "${files[@]}"; do
  if [ ! -f "$f" ]; then
    echo "Missing $f"
    exit 1
  fi
done
echo "All icons exist."
