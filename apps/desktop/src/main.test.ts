import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

class WindowFake extends EventEmitter {
  destroyed = false;
  webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
  hide = vi.fn();
  show = vi.fn();
  focus = vi.fn();
  isVisible = () => true;
  isDestroyed = () => this.destroyed;
  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
}

function fixture() {
  // Execute the real main-process lifecycle functions with window doubles, without booting Electron.
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const names = [
    "createWindow",
    "openAppOnce",
    "commitPendingAppSwitch",
    "abandonPendingAppSwitch",
  ];
  const declarations = [...source.matchAll(/^(?:async )?function (\w+)\(/gm)];
  const functions = declarations.flatMap((match, index) =>
    names.includes(match[1]!) ? [source.slice(match.index, declarations[index + 1]?.index)] : [],
  );
  expect(functions).toHaveLength(names.length);
  const code = functions.join("\n").replaceAll("import.meta.dirname", "__dirname");
  const stop = vi.fn();
  const hostService = {
    keepRunning: false,
    activate: vi.fn(async () => undefined),
    windowClosed: vi.fn(() => {
      if (!hostService.keepRunning) stop();
    }),
  };
  const state = {
    mainWindow: null as WindowFake | null,
    pendingPreviousWindow: null as WindowFake | null,
    setupWindow: null,
    currentSetup: null,
    currentTargetUrl: null as string | null,
    setupError: null,
    desktopSystem: undefined,
    desktopTray: null,
    quitting: false,
    warmWindowTimer: undefined,
    clearTimeout: vi.fn(),
    launchUpdateCheckScheduled: true,
    BrowserWindow: WindowFake,
    appWindowTargets: new WeakMap(),
    path,
    __dirname: "/fixture",
    process: { platform: "linux", env: {} },
    developmentIcon: () => undefined,
    browserWindowOptions: () => ({}),
    markOnce: vi.fn(),
    safeOrigin: (url: string) => new URL(url).origin,
    loadAppUrl: vi.fn(async () => undefined),
    resolveSessionForTarget: async () => ({ value: {}, partition: null }),
    probeDocument: async () => null,
    installBundledRenderer: vi.fn(async () => undefined),
    remoteListener: { stop: vi.fn(async () => undefined) },
    showSetupWindow: vi.fn(),
    openFailureDetail: () => "Unavailable.",
    hostService,
    stop,
  };
  vm.runInNewContext(stripTypeScriptTypes(code), state);
  return state as typeof state & {
    openAppOnce: (url: string) => Promise<boolean>;
    commitPendingAppSwitch: () => void;
    abandonPendingAppSwitch: (setup: null, url: string) => Promise<"restored" | "kept">;
  };
}

const url = "https://app.example.test";
describe("main window host lifecycle", () => {
  it("keeps the reactivated host running when reconnect destroys the previous window", async () => {
    const f = fixture();
    expect(await f.openAppOnce(url)).toBe(true);
    f.commitPendingAppSwitch();
    const previous = f.mainWindow!;
    expect(await f.openAppOnce(url)).toBe(true);
    const active = f.mainWindow!;
    f.commitPendingAppSwitch();
    expect(previous.isDestroyed()).toBe(true);
    expect(active.isDestroyed()).toBe(false);
    expect(f.hostService.activate).toHaveBeenCalledTimes(2);
    expect(f.stop).not.toHaveBeenCalled();
    active.destroy();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.mainWindow).toBeNull();
  });
  it("keeps the host running when a failed save restores the previous window", async () => {
    const f = fixture();
    await f.openAppOnce(url);
    f.commitPendingAppSwitch();
    const previous = f.mainWindow!;
    await f.openAppOnce(url);
    const replacement = f.mainWindow!;
    expect(await f.abandonPendingAppSwitch(null, url)).toBe("restored");
    expect(replacement.isDestroyed()).toBe(true);
    expect(f.mainWindow).toBe(previous);
    expect(f.stop).not.toHaveBeenCalled();
    previous.destroy();
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it("keeps the host running when the replacement window fails to load", async () => {
    const f = fixture();
    await f.openAppOnce(url);
    f.commitPendingAppSwitch();
    const previous = f.mainWindow;
    f.loadAppUrl.mockRejectedValueOnce(new Error("offline"));
    expect(await f.openAppOnce(url)).toBe(false);
    expect(f.mainWindow).toBe(previous);
    expect(f.stop).not.toHaveBeenCalled();
  });
  it("reactivates the restored server before completing a failed setup save", async () => {
    const f = fixture();
    await f.openAppOnce(url);
    f.commitPendingAppSwitch();
    await f.openAppOnce("https://replacement.example.test");
    let finish!: () => void;
    f.hostService.activate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let restored = false;
    const rollback = Promise.resolve(f.abandonPendingAppSwitch(null, url)).then(() => {
      restored = true;
    });
    await Promise.resolve();
    expect(f.hostService.activate).toHaveBeenLastCalledWith(url);
    expect(restored).toBe(false);
    finish();
    await rollback;
    expect(restored).toBe(true);
    expect(f.currentTargetUrl).toBe(url);
  });
  it("leaves keep-running policy to the host service when the active window closes", async () => {
    const f = fixture();
    f.hostService.keepRunning = true;
    await f.openAppOnce(url);
    f.mainWindow!.destroy();
    expect(f.hostService.windowClosed).toHaveBeenCalledOnce();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.mainWindow).toBeNull();
  });
});

describe("local mode failures in the main process", () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

  function serviceFailure(state: { setupOpen: boolean; response: number }) {
    const start = source.indexOf("function showServiceFailure(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\nfunction ", start + 1);
    const showMessageBox = vi.fn(async () => ({ response: state.response }));
    const context = {
      setupWindow: state.setupOpen ? new WindowFake() : null,
      mainWindow: new WindowFake(),
      serviceFailurePrompt: false,
      dialog: { showMessageBox },
      localMode: { start: vi.fn(async () => undefined) },
    };
    vm.runInNewContext(
      `${stripTypeScriptTypes(source.slice(start, end))}\nthis.showServiceFailure = showServiceFailure;`,
      context,
    );
    return context as typeof context & { showServiceFailure: (message: string) => void };
  }

  it("shows a stopped service on the app window after setup, and Retry starts local mode", async () => {
    const f = serviceFailure({ setupOpen: false, response: 0 });
    f.showServiceFailure("The worker stopped.");
    f.showServiceFailure("The worker stopped.");
    expect(f.dialog.showMessageBox).toHaveBeenCalledOnce();
    expect(f.dialog.showMessageBox).toHaveBeenCalledWith(
      f.mainWindow,
      expect.objectContaining({ message: "The worker stopped.", buttons: ["Retry", "Close"] }),
    );
    await vi.waitFor(() => expect(f.localMode.start).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.serviceFailurePrompt).toBe(false));
  });

  it("leaves the sentence to an open setup window and does nothing on Close", async () => {
    const setup = serviceFailure({ setupOpen: true, response: 0 });
    setup.showServiceFailure("The API stopped.");
    expect(setup.dialog.showMessageBox).not.toHaveBeenCalled();
    const closed = serviceFailure({ setupOpen: false, response: 1 });
    closed.showServiceFailure("The API stopped.");
    await vi.waitFor(() => expect(closed.serviceFailurePrompt).toBe(false));
    expect(closed.localMode.start).not.toHaveBeenCalled();
  });

  it("reports local service failures through that sheet", () => {
    const failed = source.slice(source.indexOf("onFailed: (message) =>"));
    expect(failed.slice(0, failed.indexOf("},"))).toContain("showServiceFailure(message)");
  });

  it("loads embedded Postgres only when local mode starts, never before the setup handlers", () => {
    const calls = [...source.matchAll(/\bloadEmbeddedPostgres\(/g)];
    expect(calls).toHaveLength(1);
    const factory = source.indexOf("postgresFactory:");
    expect(calls[0]!.index).toBeGreaterThan(factory);
    expect(calls[0]!.index).toBeLessThan(source.indexOf("allocatePort:", factory));
  });
});
