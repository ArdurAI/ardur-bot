import type { Session } from "electron";
import { BrowserWindow, shell } from "electron";
import { safeExternalUrl } from "../setup-config.js";

export function createQuickAccessWindow(input: {
  rendererUrl: string;
  targetUrl: string;
  session: Session;
  preload?: string;
}) {
  const url = new URL(input.rendererUrl);
  if (url.origin !== new URL(input.targetUrl).origin || !safeExternalUrl(url.href))
    throw new Error("Open your home before using quick access.");
  const window = new BrowserWindow({
    width: 560,
    height: 240,
    minWidth: 400,
    minHeight: 180,
    alwaysOnTop: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    title: "Quick access",
    webPreferences: {
      session: input.session,
      ...(input.preload ? { preload: input.preload } : {}),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== url.origin) event.preventDefault();
  });
  window.webContents.on("before-input-event", (event, key) => {
    if (key.type === "keyDown" && key.key === "Escape") {
      event.preventDefault();
      window.close();
    }
  });
  window.once("ready-to-show", () => {
    window.show();
    window.focus();
  });
  void window.loadURL(url.href).catch(() => {
    if (!window.isDestroyed()) window.destroy();
  });
  return window;
}

/** Untrusted sites get neither the app's preload nor its authenticated browser partition. */
export function openLinkViewer(raw: string): BrowserWindow {
  const url = safeExternalUrl(raw);
  if (!url) throw new Error("This link cannot be opened.");
  const window = new BrowserWindow({
    width: 1000,
    height: 760,
    autoHideMenuBar: true,
    title: new URL(url).hostname,
    webPreferences: {
      partition: `system-viewer-${crypto.randomUUID()}`,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = safeExternalUrl(url);
    if (external) void shell.openExternal(external);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!safeExternalUrl(url)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!safeExternalUrl(url)) event.preventDefault();
  });
  void window.loadURL(url).catch(() => {
    if (!window.isDestroyed()) window.destroy();
  });
  return window;
}
