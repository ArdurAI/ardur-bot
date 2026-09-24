import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { ArdurBotDesktop, ArdurBotSetup } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";

function runPreload(file: string, ipc: { invoke?: unknown; on?: unknown; off?: unknown } = {}) {
  const invoke =
    (ipc.invoke as ReturnType<typeof vi.fn>) ?? vi.fn(async (channel: string) => ({ channel }));
  const on = (ipc.on as ReturnType<typeof vi.fn>) ?? vi.fn();
  const off = (ipc.off as ReturnType<typeof vi.fn>) ?? vi.fn();
  const exposeInMainWorld = vi.fn();
  const source = readFileSync(path.join(import.meta.dirname, file), "utf8");

  vm.runInNewContext(source, {
    process: { platform: "linux" },
    require(moduleName: string) {
      if (moduleName !== "electron") throw new Error(`Unexpected preload import: ${moduleName}`);
      return {
        contextBridge: { exposeInMainWorld },
        ipcRenderer: { invoke, on, off },
        webUtils: { getPathForFile: (file: { path?: string }) => file.path ?? "" },
      };
    },
  });

  return { invoke, on, off, exposeInMainWorld };
}

describe("desktop preload bridge", () => {
  it("exposes the scoped desktop bridges", async () => {
    const { invoke, exposeInMainWorld } = runPreload("preload.cjs");

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [globalName, bridge] = exposeInMainWorld.mock.calls[0] as [string, ArdurBotDesktop];
    expect(globalName).toBe("ardurbotDesktop");
    expect(bridge.platform).toBe("linux");
    expect(Object.keys(bridge).sort()).toEqual([
      "devices",
      "host",
      "localSettings",
      "memoryFolders",
      "oauth",
      "platform",
      "system",
      "update",
      "window",
    ]);
    expect(Object.keys(bridge.window).sort()).toEqual([
      "close",
      "minimize",
      "setUnsavedChanges",
      "state",
      "toggleMaximize",
    ]);
    expect(Object.keys(bridge.update).sort()).toEqual(["check", "download", "install", "state"]);

    expect(Object.keys(bridge.host!).sort()).toEqual([
      "addDroppedRoot",
      "addRoot",
      "clear",
      "removeRoot",
      "setup",
      "state",
    ]);
    await bridge.oauth.open?.("https://provider.example.com/authorize");
    await bridge.oauth.cancel?.("https://provider.example.com/authorize");
    await bridge.window.close();
    await bridge.window.minimize();
    await bridge.window.toggleMaximize();
    await bridge.window.state();
    await bridge.update.state();
    await bridge.update.check();
    await bridge.update.download();
    await bridge.update.install();
    await bridge.memoryFolders?.available();
    await bridge.memoryFolders?.select("space-fixture");
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "desktop.oauth.open",
      "desktop.oauth.cancel",
      "desktop.window.close",
      "desktop.window.minimize",
      "desktop.window.toggleMaximize",
      "desktop.window.state",
      "desktop.update.state",
      "desktop.update.check",
      "desktop.update.download",
      "desktop.update.install",
      "desktop.memoryFolders.available",
      "desktop.memoryFolders.select",
    ]);
    expect(invoke).toHaveBeenCalledWith("desktop.memoryFolders.select", "space-fixture");
  });

  it("keeps setup off the app bridge so a connected server cannot re-point the app", () => {
    const { exposeInMainWorld } = runPreload("preload.cjs");
    const [, bridge] = exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(bridge).sort()).toEqual([
      "devices",
      "host",
      "localSettings",
      "memoryFolders",
      "oauth",
      "platform",
      "system",
      "update",
      "window",
    ]);
  });

  it("forwards captured codes without leaking the IPC event to the renderer", () => {
    const listeners: Array<(event: unknown, callback: unknown) => void> = [];
    const on = vi.fn((_channel: string, handler: (event: unknown, callback: unknown) => void) => {
      listeners.push(handler);
    });
    const off = vi.fn();
    const { exposeInMainWorld } = runPreload("preload.cjs", { on, off });

    const [, bridge] = exposeInMainWorld.mock.calls[0] as [string, ArdurBotDesktop];
    const received: unknown[] = [];
    const unsubscribe = bridge.oauth.onCallback((callback) => received.push(callback));

    expect(on).toHaveBeenCalledWith("desktop.oauth.callback", expect.any(Function));
    listeners[0]?.({ sender: "ipc-event" }, { code: "ac_123", state: "verifier_456" });
    expect(received).toEqual([{ code: "ac_123", state: "verifier_456" }]);

    unsubscribe();
    expect(off).toHaveBeenCalledWith("desktop.oauth.callback", expect.any(Function));
  });
});

describe("setup preload bridge", () => {
  it("exposes only the first-run setup operations", async () => {
    const { invoke, on, exposeInMainWorld } = runPreload("setup-preload.cjs");

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [globalName, bridge] = exposeInMainWorld.mock.calls[0] as [string, ArdurBotSetup];
    expect(globalName).toBe("ardurbotSetup");
    expect(bridge.platform).toBe("linux");
    expect(Object.keys(bridge).sort()).toEqual([
      "openLink",
      "platform",
      "quit",
      "save",
      "stack",
      "state",
      "test",
    ]);
    expect(Object.keys(bridge.stack).sort()).toEqual(["onChange", "start", "state"]);

    await bridge.state();
    await bridge.test("http://127.0.0.1:5173");
    await bridge.save({ mode: "new", serverUrl: "http://127.0.0.1:5173" });
    await bridge.quit();
    await bridge.openLink("orbstack");
    await bridge.stack.state();
    await bridge.stack.start();
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "desktop.setup.state",
      "desktop.setup.test",
      "desktop.setup.save",
      "desktop.setup.quit",
      "desktop.setup.openLink",
      "desktop.setup.stack.state",
      "desktop.setup.stack.start",
    ]);
    expect(invoke).toHaveBeenCalledWith("desktop.setup.openLink", "orbstack");

    const listener = vi.fn();
    bridge.stack.onChange(listener);
    const [channel, handler] = on.mock.calls.at(-1) as [string, (...args: unknown[]) => void];
    expect(channel).toBe("desktop.setup.stack.changed");
    handler({}, { phase: "pulling" });
    expect(listener).toHaveBeenCalledWith({ phase: "pulling" });
  });
});

it("turns a safe folder reply into a renderer error without logging it again", async () => {
  const invoke = vi.fn(async () => ({ error: "Set up this computer first." }));
  const { exposeInMainWorld } = runPreload("preload.cjs", { invoke });
  const bridge = exposeInMainWorld.mock.calls[0]![1] as ArdurBotDesktop;
  await expect(bridge.host!.addRoot()).rejects.toThrow("Set up this computer first.");
});
