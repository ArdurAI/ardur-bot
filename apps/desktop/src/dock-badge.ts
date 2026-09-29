import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron";
import { app, ipcMain } from "electron";

/** Whole numbers the Dock can show. Anything else is ignored. */
export function validBadgeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 999;
}

export function applyDockBadge(
  platform: string,
  count: number,
  setBadgeCount: (count: number) => void,
): void {
  if (platform !== "darwin") return;
  setBadgeCount(count);
}

function senderAllowed(
  event: IpcMainInvokeEvent,
  window: BrowserWindow | null,
  target: string | null,
): boolean {
  const frame = event.senderFrame;
  if (
    !window ||
    window.isDestroyed() ||
    !target ||
    event.sender !== window.webContents ||
    !frame ||
    frame !== window.webContents.mainFrame
  )
    return false;
  try {
    return new URL(frame.url).origin === new URL(target).origin;
  } catch {
    return false;
  }
}

/** macOS Dock badge for bots waiting on the owner. Other platforms do nothing. */
export function installDockBadge(options: {
  window: () => BrowserWindow | null;
  target: () => string | null;
  platform?: string;
  setBadgeCount?: (count: number) => void;
}): { attach(contents: WebContents): void } {
  const platform = options.platform ?? process.platform;
  const setBadgeCount = options.setBadgeCount ?? ((count: number) => app.setBadgeCount(count));
  const clear = () => applyDockBadge(platform, 0, setBadgeCount);
  ipcMain.handle("desktop.dock.waiting", (event, value: unknown) => {
    if (!senderAllowed(event, options.window(), options.target()) || !validBadgeCount(value))
      return;
    applyDockBadge(platform, value, setBadgeCount);
  });
  return {
    attach(contents) {
      clear();
      // A reload replaces the page, which sends the count again.
      // Same-document navigations keep the current count.
      contents.on("did-start-navigation", (event) => {
        if (event.isMainFrame && !event.isSameDocument) clear();
      });
    },
  };
}
