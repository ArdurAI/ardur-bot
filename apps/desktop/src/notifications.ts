import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { ipcMain, Notification } from "electron";

export function validDesktopNotification(
  value: unknown,
): value is { title: string; body: string; threadId: string } {
  if (!value || typeof value !== "object") return false;
  return (
    "title" in value &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    value.title.length <= 200 &&
    "body" in value &&
    typeof value.body === "string" &&
    value.body.length <= 1024 &&
    "threadId" in value &&
    typeof value.threadId === "string" &&
    value.threadId.length <= 200
  );
}

export function installDesktopNotifications(options: {
  window: () => BrowserWindow | null;
  target: () => string | null;
}) {
  const active = new Set<Notification>();
  function trusted(event: IpcMainInvokeEvent) {
    const window = options.window();
    const target = options.target();
    return (
      !!window &&
      !!target &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      new URL(event.senderFrame.url).origin === new URL(target).origin
    );
  }
  ipcMain.handle(
    "desktop.notifications.supported",
    (event) => trusted(event) && Notification.isSupported(),
  );
  ipcMain.handle("desktop.notifications.show", async (event, value: unknown) => {
    if (!trusted(event) || !Notification.isSupported() || !validDesktopNotification(value))
      return false;
    const notification = new Notification({ title: value.title, body: value.body });
    active.add(notification);
    notification.once("close", () => active.delete(notification));
    notification.once("click", () => {
      options.window()?.show();
      options.window()?.focus();
      active.delete(notification);
    });
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        active.delete(notification);
        resolve(false);
      }, 3000);
      notification.once("show", () => {
        clearTimeout(timer);
        resolve(true);
      });
      notification.once("failed", () => {
        clearTimeout(timer);
        active.delete(notification);
        resolve(false);
      });
      notification.show();
    });
  });
}
