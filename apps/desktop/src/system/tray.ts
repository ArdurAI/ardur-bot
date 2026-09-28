import path from "node:path";
import type { Tray } from "electron";
import { app } from "electron";
import { createDesktopTray } from "../tray.js";

// macOS tints *Template.png images to match the menu bar, so the tray stays
// monochrome there. Windows and Linux panels do not tint, so they carry the
// small clay tile with the paper mark instead, visible on dark and light panels.
function trayAsset(platform: NodeJS.Platform, packaged: boolean): string {
  if (platform === "darwin") return "trayTemplate.png";
  if (platform === "win32") return packaged ? "tray.ico" : "icon.ico";
  return "tray-32.png";
}

export function systemTray(current: Tray | null, enabled: boolean, show: () => void): Tray | null {
  if (!enabled) {
    current?.destroy();
    return null;
  }
  if (current) return current;
  const file = trayAsset(process.platform, app.isPackaged);
  const icon = app.isPackaged
    ? path.join(process.resourcesPath, file)
    : path.join(app.getAppPath(), "assets", file);
  const tray = createDesktopTray(process.platform, icon, show, () => app.quit(), true);
  if (!tray && process.platform === "darwin") throw new Error("Could not show the menu bar item.");
  return tray;
}
