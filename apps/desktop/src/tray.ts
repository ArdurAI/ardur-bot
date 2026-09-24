import { Menu, Tray } from "electron";

/** The dock already provides this entry point on macOS. */
export function createDesktopTray(
  platform: NodeJS.Platform,
  icon: string,
  show: () => void,
  quit: () => void,
): Tray | null {
  if (platform !== "win32" && platform !== "linux") return null;
  try {
    const tray = new Tray(icon);
    tray.setToolTip("Ardur Bot");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Ardur Bot", click: show },
        { type: "separator" },
        { label: "Quit", click: quit },
      ]),
    );
    tray.on("click", show);
    tray.on("double-click", show);
    return tray;
  } catch {
    // If the host cannot create a tray, closing the last window must still quit.
    return null;
  }
}

export function staysRunning(platform: NodeJS.Platform, hasTray: boolean) {
  return platform === "darwin" || hasTray;
}
