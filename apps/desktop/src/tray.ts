import { app, Menu, Tray } from "electron";

/** The dock already provides this entry point on macOS. */
const trayActions = new WeakMap<Tray, { show: () => void; quit: () => void }>();

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
    trayActions.set(tray, { show, quit });
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

export function staysRunning(platform: NodeJS.Platform, hasTray: boolean, keepRunning = true) {
  return keepRunning && (platform === "darwin" || hasTray);
}

export function updateHostTray(tray: Tray | null, connected: boolean) {
  const state = {
    label: connected ? "Host service: Connected" : "Host service: Not running",
    enabled: false,
  };
  if (process.platform === "darwin") {
    // macOS uses the dock in place of a tray.
    app?.dock?.setMenu(Menu.buildFromTemplate([state]));
  }
  if (!tray) return;
  const actions = trayActions.get(tray);
  if (!actions) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Ardur Bot", click: actions.show },
      state,
      { type: "separator" },
      { label: "Quit", click: actions.quit },
    ]),
  );
}
