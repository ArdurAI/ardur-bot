import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, value?: unknown) => unknown>(),
  show: vi.fn(),
  supported: true,
  fail: false,
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, value?: unknown) => unknown) =>
      fake.handlers.set(name, handler),
  },
  Notification: class extends EventEmitter {
    static isSupported() {
      return fake.supported;
    }
    show() {
      fake.show();
      this.emit(fake.fail ? "failed" : "show");
    }
  },
}));

import { installDesktopNotifications, validDesktopNotification } from "./notifications.js";

beforeEach(() => {
  vi.clearAllMocks();
  fake.handlers.clear();
  fake.supported = true;
  fake.fail = false;
});
it("accepts bounded notification content and rejects untrusted IPC senders", async () => {
  const frame = { url: "https://app.example.test/app" };
  const contents = { mainFrame: frame };
  const window = {
    webContents: contents,
    show: vi.fn(),
    focus: vi.fn(),
  } as unknown as BrowserWindow;
  installDesktopNotifications({ window: () => window, target: () => "https://app.example.test" });
  const message = { title: "Finished", body: "", threadId: "thread" };
  expect(validDesktopNotification({ ...message, title: "x".repeat(201) })).toBe(false);
  const show = fake.handlers.get("desktop.notifications.show")!;
  expect(await show({ sender: {}, senderFrame: frame } as IpcMainInvokeEvent, message)).toBe(false);
  expect(
    await show(
      {
        sender: contents,
        senderFrame: { url: "https://other.example.test" },
      } as IpcMainInvokeEvent,
      message,
    ),
  ).toBe(false);
  expect(fake.show).not.toHaveBeenCalled();
  expect(await show({ sender: contents, senderFrame: frame } as IpcMainInvokeEvent, message)).toBe(
    true,
  );
  fake.fail = true;
  expect(await show({ sender: contents, senderFrame: frame } as IpcMainInvokeEvent, message)).toBe(
    false,
  );
});
