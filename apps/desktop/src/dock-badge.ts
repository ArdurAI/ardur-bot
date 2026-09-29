import type { BrowserWindow, IpcMainInvokeEvent, Tray, WebContents } from "electron";
import { app, ipcMain } from "electron";
import { systemSenderAllowed } from "./system/sender.js";

/** Whole numbers the Dock can show. Anything else is ignored. */
export function validBadgeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 999;
}

function sameOrigin(pageUrl: string, target: string): boolean {
  try {
    return new URL(pageUrl).origin === new URL(target).origin;
  } catch {
    return false;
  }
}

function paint(count: number, tray: Tray | null): void {
  if (process.platform !== "darwin") return;
  app.setBadgeCount(count);
  if (!tray || tray.isDestroyed()) return;
  tray.setTitle(count > 0 ? String(count) : "");
}

/**
 * macOS Dock badge, and the same number beside the menu bar icon.
 * Other platforms do nothing.
 *
 * Each page keeps its own count. A switch clears the badge for the new page,
 * and coming back puts the previous page's count on screen again. A count that
 * arrives before that page is attached waits until the server matches.
 */
export function installDockBadge(options: {
  window: () => BrowserWindow | null;
  tray: () => Tray | null;
}): { attach(contents: WebContents, url: string): void; sync(): void } {
  const pageUrls = new WeakMap<WebContents, string>();
  const counts = new WeakMap<WebContents, number>();
  const waiting = new WeakMap<WebContents, number>();

  const current = () => {
    const window = options.window();
    return window && !window.isDestroyed() ? window : null;
  };

  const paintCurrent = () => {
    const window = current();
    const tray = options.tray();
    paint(window ? (counts.get(window.webContents) ?? 0) : 0, tray);
  };

  ipcMain.handle("desktop.dock.waiting", (event: IpcMainInvokeEvent, value: unknown) => {
    if (!validBadgeCount(value)) return;
    const window = current();
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      return;
    const url = pageUrls.get(window.webContents);
    if (!url) {
      waiting.set(window.webContents, value);
      return;
    }
    if (!systemSenderAllowed(event, window, url)) return;
    waiting.delete(window.webContents);
    counts.set(window.webContents, value);
    paint(value, options.tray());
  });

  return {
    attach(contents, url) {
      pageUrls.set(contents, url);
      const queued = waiting.get(contents);
      const count = queued !== undefined && sameOrigin(contents.mainFrame.url, url) ? queued : 0;
      waiting.delete(contents);
      counts.set(contents, count);
      contents.on("did-start-navigation", (event) => {
        if (!event.isMainFrame || event.isSameDocument) return;
        waiting.delete(contents);
        counts.set(contents, 0);
        if (current()?.webContents === contents) paint(0, options.tray());
      });
      if (current()?.webContents === contents) paint(count, options.tray());
    },
    sync() {
      paintCurrent();
    },
  };
}
