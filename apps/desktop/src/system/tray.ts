import path from "node:path";
import type { Tray } from "electron";
import { app } from "electron";
import { createDesktopTray } from "../tray.js";

export function systemTray(current: Tray | null, enabled: boolean, show: () => void): Tray | null {
  if (!enabled) {
    current?.destroy();
    return null;
  }
  if (current) return current;
  const icon = app.isPackaged
    ? path.join(process.resourcesPath, process.platform === "win32" ? "tray.ico" : "tray.png")
    : path.join(app.getAppPath(), "assets", process.platform === "win32" ? "icon.ico" : "icon.png");
  const tray = createDesktopTray(process.platform, icon, show, () => app.quit(), true);
  if (!tray && process.platform === "darwin") throw new Error("Could not show the menu bar item.");
  return tray;
}
