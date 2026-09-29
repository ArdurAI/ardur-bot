import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

export function systemSenderAllowed(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  window: BrowserWindow | null,
  target: string | null,
): boolean {
  if (
    !window ||
    window.isDestroyed() ||
    !target ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    return false;
  try {
    return new URL(event.senderFrame.url).origin === new URL(target).origin;
  } catch {
    return false;
  }
}
