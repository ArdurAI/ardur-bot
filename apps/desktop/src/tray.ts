import { app, Menu, nativeImage, Tray } from "electron";

let lastHostConnected = false;
const trayActions = new WeakMap<Tray, { show: () => void; quit: () => void }>();

export function createDesktopTray(
  platform: NodeJS.Platform,
  icon: string,
  show: () => void,
  quit: () => void,
  macEnabled = false,
): Tray | null {
  if (platform !== "win32" && platform !== "linux" && !(platform === "darwin" && macEnabled))
    return null;
  try {
    const image =
      platform === "darwin"
        ? nativeImage.createFromPath(icon).resize({ width: 18, height: 18 })
        : icon;
    if (typeof image !== "string") image.setTemplateImage(true);
    const tray = new Tray(image);
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
    if (platform === "darwin") updateHostTray(tray, lastHostConnected);
    return tray;
  } catch {
    // If the host cannot create a tray, closing the last window must still quit.
    return null;
  }
}

export function staysRunning(platform: NodeJS.Platform, hasTray: boolean) {
  return platform === "darwin" || hasTray;
}

export function updateHostTray(tray: Tray | null, connected: boolean) {
  lastHostConnected = connected;
  const state = {
    label: connected ? "Host service: Connected" : "Host service: Not running",
    enabled: false,
  };
  if (process.platform === "darwin") {
    // Keep the dock status available when the optional menu bar item is hidden.
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
