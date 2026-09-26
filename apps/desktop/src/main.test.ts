import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { localResetFailure } from "./local-mode.js";
import { managedLocalOpenUrl, parseSetupInput } from "./setup-config.js";
import { UnsavedFiles } from "./unsaved-files.js";

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
    const end = source.slice(start + 1).search(/\n(?:async )?function /u) + start + 1;
    const responses = [state.response];
    const showMessageBox = vi.fn(async () => ({ response: responses.shift() ?? 2 }));
    const context = {
      setupWindow: state.setupOpen ? new WindowFake() : null,
      mainWindow: new WindowFake(),
      serviceFailurePrompt: false,
      dialog: { showMessageBox },
      localMode: { start: vi.fn(async () => undefined) },
      resetLocalDataAndStart: vi.fn(async () => true),
    };
    vm.runInNewContext(
      `${stripTypeScriptTypes(source.slice(start, end))}\nthis.showServiceFailure = showServiceFailure;`,
      context,
    );
    return context as typeof context & {
      showServiceFailure: (message: string, offerReset?: boolean) => void;
    };
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

  it("offers Reset local data when only a reset clears the failure", async () => {
    const sentence =
      "The app's database settings are missing. Choose Reset local data, or restore secrets.env from a backup.";
    const f = serviceFailure({ setupOpen: false, response: 1 });
    f.showServiceFailure(sentence, true);
    expect(f.dialog.showMessageBox).toHaveBeenCalledWith(
      f.mainWindow,
      expect.objectContaining({
        message: sentence,
        buttons: ["Retry", "Reset local data", "Close"],
        cancelId: 2,
      }),
    );
    await vi.waitFor(() => expect(f.resetLocalDataAndStart).toHaveBeenCalledWith(f.mainWindow));
    expect(f.localMode.start).not.toHaveBeenCalled();
  });

  it("resets only after the same confirmation the setup window uses, then starts fresh", async () => {
    const start = source.indexOf("async function resetLocalDataAndStart(");
    expect(start).toBeGreaterThan(-1);
    const end = source.slice(start + 1).search(/\n(?:async )?function /u) + start + 1;
    const context = {
      confirmLocalReset: vi.fn(async () => false),
      showSetupWindow: vi.fn(),
      showServiceFailure: vi.fn(),
      localResetFailure,
      localMode: { start: vi.fn(async () => undefined) },
    };
    vm.runInNewContext(
      `${stripTypeScriptTypes(source.slice(start, end))}\nthis.reset = resetLocalDataAndStart;`,
      context,
    );
    const reset = (context as typeof context & { reset: (win: unknown) => Promise<boolean> }).reset;
    const win = new WindowFake();
    expect(await reset(win)).toBe(false);
    expect(context.confirmLocalReset).toHaveBeenCalledWith(win);
    expect(context.localMode.start).not.toHaveBeenCalled();
    context.confirmLocalReset.mockResolvedValue(true);
    expect(await reset(win)).toBe(true);
    expect(context.showSetupWindow).toHaveBeenCalledWith(null, { resume: true });
    expect(context.localMode.start).toHaveBeenCalledOnce();
    expect(context.showServiceFailure).not.toHaveBeenCalled();
  });

  it("says so when the reset fails, offers it again, and starts nothing", async () => {
    const start = source.indexOf("async function resetLocalDataAndStart(");
    const end = source.slice(start + 1).search(/\n(?:async )?function /u) + start + 1;
    const context = {
      confirmLocalReset: vi.fn(async () => {
        throw new Error("EBUSY: resource busy or locked");
      }),
      showSetupWindow: vi.fn(),
      showServiceFailure: vi.fn(),
      localResetFailure,
      localMode: { start: vi.fn(async () => undefined) },
    };
    vm.runInNewContext(
      `${stripTypeScriptTypes(source.slice(start, end))}\nthis.reset = resetLocalDataAndStart;`,
      context,
    );
    const reset = (context as typeof context & { reset: (win: unknown) => Promise<boolean> }).reset;
    expect(await reset(new WindowFake())).toBe(false);
    expect(context.showServiceFailure).toHaveBeenCalledWith(
      "Could not reset local data. Try again.",
      true,
    );
    expect(context.showSetupWindow).not.toHaveBeenCalled();
    expect(context.localMode.start).not.toHaveBeenCalled();
  });
});

describe("choosing an existing instance while local mode runs", () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const local = "http://127.0.0.1:40123";
  const team = "https://team.example.test";

  function saveSetupFixture(reachable: boolean) {
    const start = source.indexOf("async function saveSetup(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\nfunction ", start + 1);
    const calls: string[] = [];
    const context = {
      setupSaveInProgress: false,
      currentSetup: { mode: "new", serverUrl: local },
      currentTargetUrl: local,
      legacyCompose: false,
      parseSetupInput,
      managedLocalOpenUrl,
      localMode: {
        origin: () => local,
        state: () => ({ phase: "ready" }),
        stop: vi.fn(async () => {
          calls.push("stop local mode");
        }),
      },
      probeServer: vi.fn(async () => {
        calls.push("check");
        return reachable ? { ok: true } : { ok: false, error: "Nothing is listening there." };
      }),
      openApp: vi.fn(async () => {
        calls.push("open");
        return true;
      }),
      mainWindow: null,
      watchRendererUntilCommitted: () => null,
      writeSetup: vi.fn(async () => {
        calls.push("save");
      }),
      commitPendingAppSwitch: vi.fn(),
      destroySetupWindow: vi.fn(),
      recoverFromCrashedSave: vi.fn(),
      abandonPendingAppSwitch: vi.fn(),
    };
    vm.runInNewContext(
      `${stripTypeScriptTypes(source.slice(start, end))}\nthis.saveSetup = saveSetup;`,
      context,
    );
    return Object.assign(context, { calls }) as typeof context & {
      calls: string[];
      saveSetup: (payload: unknown, userDataDir: string) => Promise<{ ok: boolean }>;
    };
  }

  it("keeps local mode running when the new server does not answer", async () => {
    const f = saveSetupFixture(false);
    expect(await f.saveSetup({ mode: "existing", serverUrl: team }, "/fixture")).toMatchObject({
      ok: false,
    });
    expect(f.calls).toEqual(["check"]);
    expect(f.localMode.stop).not.toHaveBeenCalled();
  });

  it("stops local mode only after the new server answered, opened, and was saved", async () => {
    const f = saveSetupFixture(true);
    expect(await f.saveSetup({ mode: "existing", serverUrl: team }, "/fixture")).toEqual({
      ok: true,
    });
    expect(f.calls).toEqual(["check", "open", "save", "stop local mode"]);
  });
});

describe("quitting while local mode runs", () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

  function quitFixture() {
    const prefix = 'app.on("before-quit", ';
    const start = source.indexOf(`${prefix}(event) => {`);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n});\n", start);
    const handler = source.slice(start + prefix.length, end + 2);
    let running = true;
    let finishStop: (() => void) | undefined;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStop = () => {
            running = false;
            resolve();
          };
        }),
    );
    const mainWindow = new WindowFake();
    const context = {
      quitting: false,
      mainWindow,
      unsavedFiles: new UnsavedFiles<WindowFake>(),
      dialog: { showMessageBoxSync: vi.fn(() => 0) },
      legacyCompose: false,
      localShutdown: null,
      localMode: {
        running: () => running,
        start: () => {
          running = true;
        },
        stop,
        quit: stop,
      },
      app: { quit: vi.fn() },
      hostService: { stop: vi.fn() },
      desktopTray: null,
      warmWindowTimer: undefined,
      clearTimeout: vi.fn(),
      remoteListener: { stop: vi.fn(async () => undefined) },
      localStack: { abort: vi.fn() },
    };
    vm.runInNewContext(`this.beforeQuit = ${stripTypeScriptTypes(handler)};`, context);
    const beforeQuit = (context as typeof context & { beforeQuit: (event: unknown) => void })
      .beforeQuit;
    const quit = () => {
      const event = { preventDefault: vi.fn() };
      beforeQuit(event);
      return event.preventDefault.mock.calls.length > 0 ? "held" : "quits";
    };
    return Object.assign(context, {
      quit,
      finishStop: async () => {
        finishStop?.();
        await vi.waitFor(() => expect(context.app.quit).toHaveBeenCalled());
        context.app.quit.mockClear();
      },
    });
  }

  it("stops local mode first, then quits", async () => {
    const f = quitFixture();
    expect(f.quit()).toBe("held");
    expect(f.quit()).toBe("held");
    expect(f.localMode.stop).toHaveBeenCalledOnce();
    await f.finishStop();
    expect(f.quit()).toBe("quits");
    expect(f.localStack.abort).toHaveBeenCalledOnce();
  });

  it("stops and quits again after the follow-up quit was cancelled and local mode started again", async () => {
    const f = quitFixture();
    expect(f.quit()).toBe("held");
    // A file was edited while local mode stopped; the person keeps it.
    f.unsavedFiles.set(f.mainWindow, true);
    await f.finishStop();
    expect(f.quit()).toBe("held");
    expect(f.dialog.showMessageBoxSync).toHaveBeenCalledOnce();
    expect(f.localShutdown).toBeNull();

    f.unsavedFiles.set(f.mainWindow, false);
    f.localMode.start();
    expect(f.quit()).toBe("held");
    expect(f.localMode.stop).toHaveBeenCalledTimes(2);
    await f.finishStop();
    expect(f.quit()).toBe("quits");
  });
});
