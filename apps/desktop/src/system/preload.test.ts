import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import type { SystemBridge } from "./bridge.js";

it("exposes fixed System IPC methods and strips native events from shortcut callbacks", async () => {
  const invoke = vi.fn(async () => undefined),
    on = vi.fn(),
    off = vi.fn();
  let system: SystemBridge | undefined;
  runInNewContext(await readFile(new URL("../preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "darwin" },
    require: () => ({
      ipcRenderer: { invoke, on, off },
      contextBridge: {
        exposeInMainWorld: (_: string, value: { system: SystemBridge }) => {
          system = value.system;
        },
      },
    }),
  });
  await system!.set("keepAwake", true);
  expect(invoke).toHaveBeenCalledWith("desktop.system.set", "keepAwake", true);
  const listener = vi.fn(),
    cleanup = system!.onShortcut!(listener);
  on.mock.calls[0]![1]({ secretNativeEvent: true }, "voice");
  on.mock.calls[0]![1]({}, "unknown");
  expect(listener).toHaveBeenCalledExactlyOnceWith("voice");
  cleanup();
  expect(off).toHaveBeenCalledWith("desktop.system.shortcut", on.mock.calls[0]![1]);
  expect(invoke).toHaveBeenCalledWith("desktop.system.shortcutReady", false);
});
