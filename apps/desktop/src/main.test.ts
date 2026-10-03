import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { darkTokens, lightTokens } from "@ardurbot/ui-tokens";
import { describe, expect, it, vi } from "vitest";
import { localResetFailure } from "./local-mode.js";
import { MAIN_WINDOW_SHOW_FALLBACK_MS, showMainWindowWhenPainted } from "./main-window-show.js";
import { managedLocalOpenUrl, parseSetupInput } from "./setup-config.js";
import { systemSenderAllowed } from "./system/install.js";
import { UnsavedFiles } from "./unsaved-files.js";
import { browserWindowOptions, windowBackgroundColor } from "./window-options.js";
import type { WindowPlace } from "./window-place.js";
import {
  createWindowPlaceQuitWait,
  restoreWindowPlace,
  watchWindowPlace,
  windowWithRestoredState,
} from "./window-place.js";

class WindowFake extends EventEmitter {
  constructor(readonly options: { backgroundColor?: string; show?: boolean } = {}) {
    super();
    this.visible = options.show !== false;
  }
  destroyed = false;
  webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
  visible = true;
  hide = vi.fn(() => {
    this.visible = false;
  });
  show = vi.fn(() => {
    this.visible = true;
    this.emit("show");
  });
  focus = vi.fn();
  getNormalBounds = () => ({ x: 150, y: 120, width: 1000, height: 700 });
  isMaximized = () => false;
  isFullScreen = () => false;
  isVisible = () => this.visible;
  maximize = vi.fn();
  setFullScreen = vi.fn();
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
    "scheduleLaunchCacheMaintenance",
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
    dockBadge: { attach: vi.fn(), sync: vi.fn() },
    // The shortcut menu follows the active window; the real menu needs Electron, so stub it here.
    Menu: { getApplicationMenu: () => null },
    watchAppShortcutMenu: vi.fn(),
    syncAppShortcutMenu: vi.fn(),
    staysRunning: () => false,
    quitting: false,
    warmWindowTimer: undefined,
    clearTimeout: vi.fn(),
    launchUpdateCheckScheduled: true,
    showMainWindowWhenPainted: vi.fn(),
    // createWindow reads the guided-setup flag and the legacy Compose marker from module scope.
    GUIDED_SETUP_ENABLED: false,
    legacyCompose: false,
    BrowserWindow: WindowFake,
    appWindowTargets: new WeakMap(),
    path,
    __dirname: "/fixture",
    process: { platform: "linux", env: {} },
    developmentIcon: () => undefined,
    browserWindowOptions,
    screen: {
      getDisplayMatching: () => ({ id: 1 }),
      getPrimaryDisplay: () => ({ id: 1 }),
      getAllDisplays: () => [
        {
          id: 1,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        },
      ],
    },
    windowPlace: undefined as { current: WindowPlace; save: ReturnType<typeof vi.fn> } | undefined,
    restoreWindowPlace,
    watchWindowPlace,
    windowWithRestoredState,
    windowBackgroundColor,
    bootSnapshot: undefined as { current: { theme: string; language: string } } | undefined,
    nativeTheme: { shouldUseDarkColors: true },
    markOnce: vi.fn(),
    safeOrigin: (url: string) => new URL(url).origin,
    loadAppUrl: vi.fn(async () => undefined),
    resolveSessionForTarget: vi.fn(async () => ({ value: {}, partition: null })),
    probeDocument: async () => null,
    installBundledRenderer: vi.fn(async () => undefined),
    remoteListener: { stop: vi.fn(async () => undefined) },
    showSetupWindow: vi.fn(),
    openFailureDetail: () => "Unavailable.",
    hostService,
    stop,
    clearOversizedCache: vi.fn(async () => false),
    console: { error: vi.fn() },
  };
  vm.runInNewContext(stripTypeScriptTypes(code), state);
  return state as typeof state & {
    openAppOnce: (
      url: string,
      resolved?: { partition: string | null; value: unknown },
    ) => Promise<boolean>;
    commitPendingAppSwitch: () => void;
    abandonPendingAppSwitch: (setup: null, url: string) => Promise<"restored" | "kept">;
    scheduleLaunchCacheMaintenance: (sessions: unknown[]) => void;
  };
}

const url = "https://app.example.test";

describe("main window colour before the first paint", () => {
  it("uses the saved theme, and the system theme when nothing is saved", async () => {
    const f = fixture();
    await f.openAppOnce(url);
    expect(f.mainWindow!.options.backgroundColor).toBe(darkTokens.background);
    f.nativeTheme.shouldUseDarkColors = false;
    await f.openAppOnce(url);
    expect(f.mainWindow!.options.backgroundColor).toBe(lightTokens.background);

    f.bootSnapshot = { current: { theme: "dark" } };
    await f.openAppOnce(url);
    expect(f.mainWindow!.options.backgroundColor).toBe(darkTokens.background);
    f.nativeTheme.shouldUseDarkColors = true;
    f.bootSnapshot = { current: { theme: "light" } };
    await f.openAppOnce(url);
    expect(f.mainWindow!.options.backgroundColor).toBe(lightTokens.background);
  });
});

describe("first-launch setup dispatch", () => {
  it.each([
    { guided: false, legacy: false, forced: false, starts: true },
    { guided: true, legacy: false, forced: false, starts: false },
    { guided: false, legacy: false, forced: true, starts: false },
    { guided: false, legacy: true, forced: false, starts: false },
  ])(
    "keeps the local-mode start decision for $guided/$legacy/$forced",
    ({ guided, legacy, forced, starts }) => {
      const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
      const start = source.indexOf('if (target.kind === "setup") {');
      const end = source.indexOf('} else if (target.source === "saved") {', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const localStart = vi.fn();
      const showSetupWindow = vi.fn();
      vm.runInNewContext(source.slice(start, end + 1), {
        target: { kind: "setup" },
        showSetupWindow,
        legacyCompose: legacy,
        GUIDED_SETUP_ENABLED: guided,
        process: { env: { ARDURBOT_FORCE_SETUP: forced ? "1" : undefined } },
        localMode: { start: localStart },
      });
      expect(showSetupWindow).toHaveBeenCalledOnce();
      expect(localStart).toHaveBeenCalledTimes(starts ? 1 : 0);
    },
  );
});

describe("guided setup service handoff", () => {
  it("leaves the guided form when opening an already complete account", async () => {
    const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const start = source.indexOf("openAccount: async (step) => {");
    const end = source.indexOf("\n      },", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const loadURL = vi.fn(async () => undefined);
    const mainWindow = {
      webContents: { getURL: () => "http://127.0.0.1:3333/guided-onboarding?step=model" },
      loadURL,
      isDestroyed: () => false,
      show: vi.fn(),
      focus: vi.fn(),
    };
    const context = {
      guidedEngine: { snapshot: () => ({ accountReady: true }) },
      setupWindow: { hide: vi.fn() },
      mainWindow,
      currentTargetUrl: "http://127.0.0.1:3333",
      openGuidedAccount: vi.fn(),
      waitForMountedAppDocument: vi.fn(async () => undefined),
      URL,
    };
    vm.runInNewContext(
      `this.openAccount = async (step) => {${source.slice(start + "openAccount: async (step) => {".length, end)}\n}`,
      context,
    );
    await (
      context as typeof context & { openAccount: (step: string) => Promise<void> }
    ).openAccount("finish");
    expect(loadURL).toHaveBeenCalledWith("http://127.0.0.1:3333/app");
    expect(mainWindow.show).toHaveBeenCalledOnce();
    expect(context.openGuidedAccount).not.toHaveBeenCalled();
  });
  it.each([
    { resume: true, document: "setup.html" },
    { resume: false, document: "guided-setup.html" },
  ])("loads $document when setup resume is $resume", ({ resume, document }) => {
    const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const start = source.indexOf("function createSetupWindow(");
    const end = source.indexOf("/**\n * After setup", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const loadFile = vi.fn(async () => undefined);
    class SetupWindow extends WindowFake {
      loadFile = loadFile;
      reload = vi.fn();
    }
    const context = {
      BrowserWindow: SetupWindow,
      setupWindow: null,
      mainWindow: null,
      setupError: null,
      setupResumesLocal: false,
      guidedEngine: { running: () => false },
      path,
      __dirname: "/fixture",
      process: { platform: "linux" },
      developmentIcon: () => undefined,
      setupWindowOptions: () => ({}),
      restoreAppWindowAfterSetup: vi.fn(),
      markOnce: vi.fn(),
    };
    vm.runInNewContext(
      stripTypeScriptTypes(source.slice(start, end)).replaceAll("import.meta.dirname", "__dirname"),
      context,
    );
    (
      context as typeof context & {
        showSetupWindow: (error: null, options: { resume: boolean }) => void;
      }
    ).showSetupWindow(null, { resume });
    expect(loadFile).toHaveBeenCalledWith(path.join("/fixture", document));
  });

  it("starts local services only after fresh pilot verification", () => {
    const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const start = source.indexOf('ipcMain.handle("desktop.setup.stack.start"');
    const end = source.indexOf("// Register before startup awaits", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const handlers = new Map<string, (event: unknown) => unknown>();
    const localStart = vi.fn();
    const pilot = { ready: false };
    const context = {
      ipcMain: {
        handle: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler),
      },
      fromSetupWindow: () => true,
      guidedEngine: { pilotReady: () => pilot.ready },
      currentSetup: null,
      localMode: { start: localStart, state: () => ({ phase: "idle" }) },
      legacyCompose: false,
      setupResumesLocal: false,
    };
    vm.runInNewContext(source.slice(start, end), context);
    const handler = handlers.get("desktop.setup.stack.start")!;
    expect(handler({})).toBeNull();
    expect(localStart).not.toHaveBeenCalled();
    expect(context.setupResumesLocal).toBe(false);
    pilot.ready = true;
    expect(handler({})).toEqual({ phase: "idle" });
    expect(localStart).toHaveBeenCalledOnce();
    expect(context.setupResumesLocal).toBe(true);
  });

  it("retries failed startup from the resumed saved-local setup window", async () => {
    const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const start = source.indexOf('ipcMain.handle("desktop.setup.stack.start"');
    const end = source.indexOf("// Register before startup awaits", start);
    const handlers = new Map<string, (event: unknown) => unknown>();
    let phase = "idle";
    const localMode = {
      start: vi.fn(async () => {
        phase = phase === "idle" ? "failed" : "migrations";
      }),
      state: () => ({ phase }),
    };
    const context = {
      ipcMain: {
        handle: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler),
      },
      fromSetupWindow: () => true,
      guidedEngine: { pilotReady: () => false },
      currentSetup: { mode: "new" },
      localMode,
      legacyCompose: false,
      setupResumesLocal: true,
    };
    vm.runInNewContext(source.slice(start, end), context);
    await localMode.start(); // Automatic launch has failed before setup.html offers Retry.
    expect(localMode.state().phase).toBe("failed");

    const retry = handlers.get("desktop.setup.stack.start")!;
    expect(retry({})).toEqual({ phase: "migrations" });
    expect(localMode.start).toHaveBeenCalledTimes(2);
    context.setupResumesLocal = false;
    expect(retry({})).toBeNull();
    context.setupResumesLocal = true;
    context.currentSetup.mode = "existing";
    expect(retry({})).toBeNull();
    expect(localMode.start).toHaveBeenCalledTimes(2);
  });

  it("allows only the app page in the main window to save the boot snapshot", async () => {
    const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const start = source.indexOf('ipcMain.handle("desktop.boot.save"');
    const end = source.indexOf("currentSetup = await readSetup", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const handlers = new Map<string, (event: unknown, snapshot: unknown) => Promise<unknown>>();
    const boot = { save: vi.fn(async () => true) };
    const mainFrame = { url: "https://app.ardur.ai/chat" };
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { mainFrame },
    };
    const context = {
      ipcMain: {
        handle: (name: string, handler: (event: unknown, snapshot: unknown) => Promise<unknown>) =>
          handlers.set(name, handler),
      },
      boot,
      mainWindow,
      permissionTarget: () => ({ url: "https://app.ardur.ai/chat" }),
      systemSenderAllowed,
    };
    vm.runInNewContext(stripTypeScriptTypes(source.slice(start, end)), context);
    const handler = handlers.get("desktop.boot.save")!;
    expect(handler).toBeDefined();

    // 1. The main window's own main frame saves successfully.
    await handler({ sender: mainWindow.webContents, senderFrame: mainFrame }, { theme: "dark" });
    expect(boot.save).toHaveBeenCalledWith({ theme: "dark" });
    boot.save.mockClear();

    // 2. A subframe in the main window is ignored.
    const subframe = { url: "https://app.ardur.ai/chat" };
    await handler({ sender: mainWindow.webContents, senderFrame: subframe }, { theme: "dark" });
    expect(boot.save).not.toHaveBeenCalled();

    // 3. Another window is ignored.
    const otherContents = { mainFrame: { url: "https://app.ardur.ai/chat" } };
    await handler(
      { sender: otherContents, senderFrame: otherContents.mainFrame },
      { theme: "dark" },
    );
    expect(boot.save).not.toHaveBeenCalled();

    // 4. Another origin in the main window is ignored.
    const otherOriginFrame = { url: "https://evil.example.com/chat" };
    await handler(
      { sender: mainWindow.webContents, senderFrame: otherOriginFrame },
      { theme: "dark" },
    );
    expect(boot.save).not.toHaveBeenCalled();
  });
});

describe("main window host lifecycle", () => {
  it("keeps the reactivated host running when reconnect destroys the previous window", async () => {
    const f = fixture();
    expect(await f.openAppOnce(url)).toBe(true);
    expect(f.dockBadge.attach).toHaveBeenCalledOnce();
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
    expect(f.dockBadge.sync).toHaveBeenCalled();
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
    expect(f.dockBadge.sync).toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
  });
  it("attaches the dock count to the window server before that server is published", async () => {
    const f = fixture();
    let published: string | null = "unset";
    f.loadAppUrl.mockImplementationOnce(async () => {
      published = f.currentTargetUrl;
    });
    await f.openAppOnce(url);
    expect(f.dockBadge.attach).toHaveBeenCalledWith(expect.anything(), url);
    expect(published).toBeNull();
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

  function serviceFailure(state: { setupOpen: boolean; setupVisible?: boolean; response: number }) {
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
    if (context.setupWindow) context.setupWindow.isVisible = () => state.setupVisible ?? true;
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

  it("offers recovery when a completed checklist is retained but hidden", async () => {
    const f = serviceFailure({ setupOpen: true, setupVisible: false, response: 0 });
    f.showServiceFailure("The API stopped.", true);
    expect(f.dialog.showMessageBox).toHaveBeenCalledWith(
      f.mainWindow,
      expect.objectContaining({ buttons: ["Retry", "Reset local data", "Close"] }),
    );
  });

  it("reactivates the app when the retained checklist is hidden", () => {
    const start = source.indexOf('  app.on("activate", () => {');
    const end = source.indexOf("\n  });", start) + "\n  });".length;
    const setupWindow = new WindowFake();
    setupWindow.isVisible = () => false;
    const mainWindow = new WindowFake();
    let activate: (() => void) | undefined;
    const context = {
      app: {
        on: (_event: string, handler: () => void) => {
          activate = handler;
        },
      },
      setupWindow,
      mainWindow,
      clearTimeout: vi.fn(),
      warmWindowTimer: undefined,
    };
    vm.runInNewContext(source.slice(start, end), context);
    activate?.();
    expect(mainWindow.show).toHaveBeenCalledOnce();
    expect(setupWindow.show).not.toHaveBeenCalled();
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
      showResetFailure: vi.fn(),
      localResetFailure,
      localMode: { start: vi.fn(async () => undefined), state: () => ({ phase: "ready" }) },
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
    expect(context.showResetFailure).not.toHaveBeenCalled();
  });

  function failedResetFixture(priorPhase: "ready" | "failed") {
    const start = source.indexOf("async function resetLocalDataAndStart(");
    const end = source.slice(start + 1).search(/\n(?:async )?function /u) + start + 1;
    const context = {
      confirmLocalReset: vi.fn(async () => {
        throw new Error("EBUSY: resource busy or locked");
      }),
      showSetupWindow: vi.fn(),
      showResetFailure: vi.fn(),
      localResetFailure,
      localMode: { start: vi.fn(async () => undefined), state: () => ({ phase: priorPhase }) },
    };
    vm.runInNewContext(
      `${stripTypeScriptTypes(source.slice(start, end))}\nthis.reset = resetLocalDataAndStart;`,
      context,
    );
    const reset = (context as typeof context & { reset: (win: unknown) => Promise<boolean> }).reset;
    return { context, reset };
  }

  it("says so when the reset fails, and restarts the working stack it disturbed", async () => {
    const { context, reset } = failedResetFixture("ready");
    const win = new WindowFake();
    expect(await reset(win)).toBe(false);
    expect(context.showResetFailure).toHaveBeenCalledWith(
      "Could not reset local data. Try again.",
      win,
    );
    expect(context.showSetupWindow).not.toHaveBeenCalled();
    // Nothing had already failed, so the stack the reset disturbed is not left dead.
    expect(context.localMode.start).toHaveBeenCalledOnce();
  });

  it("says so when the reset fails, and starts nothing when a failure was already showing", async () => {
    const { context, reset } = failedResetFixture("failed");
    const win = new WindowFake();
    expect(await reset(win)).toBe(false);
    expect(context.showResetFailure).toHaveBeenCalledWith(
      "Could not reset local data. Try again.",
      win,
    );
    expect(context.showSetupWindow).not.toHaveBeenCalled();
    // An earlier failure is what asked for the reset; today's behaviour is unchanged.
    expect(context.localMode.start).not.toHaveBeenCalled();
  });

  function resetFailure(state: { setupOpen: boolean; response: number }) {
    const start = source.indexOf("function showResetFailure(");
    expect(start).toBeGreaterThan(-1);
    const end = source.slice(start + 1).search(/\n(?:async )?function /u) + start + 1;
    const responses = [state.response];
    const showMessageBox = vi.fn(async () => ({ response: responses.shift() ?? 1 }));
    const context = {
      setupWindow: state.setupOpen ? new WindowFake() : null,
      serviceFailurePrompt: false,
      dialog: { showMessageBox },
      resetLocalDataAndStart: vi.fn(async () => true),
    };
    vm.runInNewContext(
      `${stripTypeScriptTypes(source.slice(start, end))}\nthis.showResetFailure = showResetFailure;`,
      context,
    );
    return context as typeof context & {
      showResetFailure: (message: string, parent: WindowFake) => void;
    };
  }

  it("offers only Reset local data again for a failed reset, never Retry of the old data", async () => {
    const sentence = "A local data file is in use; close whatever is using it and try again.";
    const f = resetFailure({ setupOpen: false, response: 0 });
    const win = new WindowFake();
    f.showResetFailure(sentence, win);
    expect(f.dialog.showMessageBox).toHaveBeenCalledWith(
      win,
      expect.objectContaining({
        message: sentence,
        buttons: ["Reset local data", "Close"],
        cancelId: 1,
      }),
    );
    await vi.waitFor(() => expect(f.resetLocalDataAndStart).toHaveBeenCalledWith(win));
  });

  it("does nothing on Close, and leaves the sentence to an open setup window", async () => {
    const sentence = "Could not reset local data. Try again.";
    const closed = resetFailure({ setupOpen: false, response: 1 });
    const win = new WindowFake();
    closed.showResetFailure(sentence, win);
    await vi.waitFor(() => expect(closed.serviceFailurePrompt).toBe(false));
    expect(closed.resetLocalDataAndStart).not.toHaveBeenCalled();

    const setup = resetFailure({ setupOpen: true, response: 0 });
    setup.showResetFailure(sentence, new WindowFake());
    expect(setup.dialog.showMessageBox).not.toHaveBeenCalled();
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
      guidedEngine: null,
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
    const beforeQuitPrefix = 'app.on("before-quit", ';
    const beforeStart = source.indexOf(`${beforeQuitPrefix}(event) => {`);
    expect(beforeStart).toBeGreaterThan(-1);
    const beforeEnd = source.indexOf("\n});\n", beforeStart);
    const beforeQuitHandler = source.slice(beforeStart + beforeQuitPrefix.length, beforeEnd + 2);

    const willQuitPrefix = 'app.on("will-quit", ';
    const willStart = source.indexOf(`${willQuitPrefix}(event) => {`);
    expect(willStart).toBeGreaterThan(-1);
    const willEnd = source.indexOf("\n});\n", willStart);
    const willQuitHandler = source.slice(willStart + willQuitPrefix.length, willEnd + 2);

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
    const context = {
      quitting: false,
      mainWindow: new WindowFake() as WindowFake | null,
      unsavedFiles: new UnsavedFiles<WindowFake>(),
      dialog: { showMessageBoxSync: vi.fn(() => 0) },
      windowPlace: undefined,
      windowPlaceQuitWait: undefined,
      createWindowPlaceQuitWait,
      legacyCompose: false,
      guidedEngine: null,
      guidedIpcCleanup: null,
      localShutdown: null as Promise<void> | null,
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
    vm.runInNewContext(
      `this.beforeQuit = ${stripTypeScriptTypes(beforeQuitHandler)};\nthis.willQuit = ${stripTypeScriptTypes(willQuitHandler)};`,
      context,
    );
    const { beforeQuit, willQuit } = context as typeof context & {
      beforeQuit: (event: unknown) => void;
      willQuit: (event: unknown) => void;
    };
    /**
     * Models Electron's real order: before-quit, then, once every window has actually
     * closed, will-quit. A window that declines to close (an unsaved-changes prompt
     * refused) means will-quit, and the stop it owns, never runs.
     */
    const quit = ({ windowCloses = true }: { windowCloses?: boolean } = {}) => {
      const beforeEvent = { preventDefault: vi.fn() };
      beforeQuit(beforeEvent);
      if (beforeEvent.preventDefault.mock.calls.length > 0) return "held";
      if (context.mainWindow) {
        if (!windowCloses) return "window-open";
        context.mainWindow.destroy();
        context.mainWindow = null;
      }
      const willEvent = { preventDefault: vi.fn() };
      willQuit(willEvent);
      return willEvent.preventDefault.mock.calls.length > 0 ? "held" : "quits";
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
    expect(f.mainWindow).toBeNull();
    expect(f.quit()).toBe("held");
    expect(f.localMode.stop).toHaveBeenCalledOnce();
    await f.finishStop();
    expect(f.quit()).toBe("quits");
    expect(f.localStack.abort).toHaveBeenCalledOnce();
  });

  it("never stops local mode when a window declines to close during quit", () => {
    const f = quitFixture();
    expect(f.quit({ windowCloses: false })).toBe("window-open");
    expect(f.localMode.stop).not.toHaveBeenCalled();
    expect(f.localMode.running()).toBe(true);
    expect(f.mainWindow).not.toBeNull();
  });
});

describe("cache limits wiring in the main process", () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

  it("caps the disk cache before the app is ready", () => {
    // Electron ignores `--disk-cache-size` once the app has already become ready.
    const capIndex = source.indexOf("capDiskCacheSize(app.commandLine)");
    const readyIndex = source.indexOf("app.whenReady()");
    expect(capIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeGreaterThan(-1);
    expect(capIndex).toBeLessThan(readyIndex);
  });

  it("schedules the oversized-cache cleanup without waiting for it, so a slow cleanup never blocks the caller", async () => {
    const f = fixture();
    let resolveCleanup!: () => void;
    const slow = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    const order: string[] = [];
    f.clearOversizedCache.mockImplementation(async () => {
      await slow;
      order.push("cleanup");
      return true;
    });
    f.loadAppUrl.mockImplementation(async () => {
      order.push("loaded");
    });
    // The window is created and fully loaded before the cleanup is even scheduled here,
    // matching where `scheduleLaunchCacheMaintenance` is called after the startup dispatch.
    expect(await f.openAppOnce(url)).toBe(true);
    f.scheduleLaunchCacheMaintenance([{}]);
    expect(order).toEqual(["loaded"]);
    resolveCleanup();
    await vi.waitFor(() => expect(order).toEqual(["loaded", "cleanup"]));
  });

  it("logs a failed cleanup instead of letting it surface", async () => {
    const f = fixture();
    const error = new Error("disk full");
    f.clearOversizedCache.mockRejectedValueOnce(error);
    f.scheduleLaunchCacheMaintenance([{}]);
    await vi.waitFor(() =>
      expect(f.console.error).toHaveBeenCalledWith("Could not clear an oversized cache.", error),
    );
  });

  it("wires the storage IPC handlers to the shared cache-clearing and usage helpers", () => {
    expect(source).toContain('ipcMain.handle("desktop.storage.usage"');
    expect(source).toContain('ipcMain.handle("desktop.storage.clearCaches"');
    expect(source).toContain("clearAppCaches(win.webContents.session)");
    expect(source).toContain("collectStorageUsage({");
  });

  it("never re-resolves the session when the caller already resolved it for this URL", async () => {
    const f = fixture();
    const resolved = { partition: null, value: {} };
    expect(await f.openAppOnce(url, resolved)).toBe(true);
    expect(f.resolveSessionForTarget).not.toHaveBeenCalled();
  });

  it("resolves its own session when the caller has none, unchanged from before", async () => {
    const f = fixture();
    expect(await f.openAppOnce(url)).toBe(true);
    expect(f.resolveSessionForTarget).toHaveBeenCalledExactlyOnceWith(url);
  });
});

describe("main window ready-to-show wiring", () => {
  it("shows the new window once on ready-to-show and still records the mark", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.showMainWindowWhenPainted = showMainWindowWhenPainted;
      expect(await f.openAppOnce(url)).toBe(true);
      const win = f.mainWindow!;
      expect(win.show).not.toHaveBeenCalled();
      win.emit("ready-to-show");
      expect(win.show).toHaveBeenCalledOnce();
      expect(win.focus).toHaveBeenCalledOnce();
      expect(f.markOnce).toHaveBeenCalledWith("rk:main:ready-to-show");
      win.emit("ready-to-show");
      vi.advanceTimersByTime(MAIN_WINDOW_SHOW_FALLBACK_MS);
      expect(win.show).toHaveBeenCalledOnce();
      expect(win.focus).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("main window placement wiring", () => {
  it("passes restored normal bounds into the real createWindow before any reveal", async () => {
    const f = fixture();
    f.windowPlace = {
      save: vi.fn().mockResolvedValue(undefined),
      current: {
        x: 150,
        y: 120,
        width: 1000,
        height: 700,
        maximized: true,
        fullScreen: true,
        displayId: 1,
      },
    };
    expect(await f.openAppOnce(url)).toBe(true);
    expect(f.mainWindow!.options).toMatchObject({
      x: 150,
      y: 120,
      width: 1000,
      height: 700,
      show: false,
    });
    expect(f.mainWindow!.maximize).not.toHaveBeenCalled();
    expect(f.mainWindow!.setFullScreen).not.toHaveBeenCalled();
    expect(f.showMainWindowWhenPainted).toHaveBeenCalledOnce();
  });

  it("opens safely after the saved display is unplugged", async () => {
    const f = fixture();
    f.windowPlace = {
      save: vi.fn().mockResolvedValue(undefined),
      current: {
        x: 9000,
        y: 120,
        width: 1000,
        height: 700,
        maximized: false,
        fullScreen: false,
        displayId: 2,
      },
    };
    expect(await f.openAppOnce(url)).toBe(true);
    expect(f.mainWindow!.options).toMatchObject({
      x: 240,
      y: 70,
      width: 1440,
      height: 900,
      show: false,
    });
  });
});

describe("main placement lifecycle regressions", () => {
  it("captures the current main window on close through the production watcher", async () => {
    const f = fixture();
    f.windowPlace = {
      current: {
        x: 150,
        y: 120,
        width: 1000,
        height: 700,
        maximized: false,
        fullScreen: false,
        displayId: 1,
      },
      save: vi.fn().mockResolvedValue(undefined),
    };
    await f.openAppOnce(url);
    f.mainWindow!.emit("close", { preventDefault: vi.fn() });
    expect(f.windowPlace.save).toHaveBeenCalledExactlyOnceWith(f.windowPlace.current);
  });

  it.each(["ready-to-show", "fallback", "activation"])(
    "applies saved maximized state at first %s reveal",
    async (trigger) => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        f.showMainWindowWhenPainted = showMainWindowWhenPainted;
        f.windowPlace = {
          current: {
            x: 150,
            y: 120,
            width: 1000,
            height: 700,
            maximized: true,
            fullScreen: false,
            displayId: 1,
          },
          save: vi.fn().mockResolvedValue(undefined),
        };
        await f.openAppOnce(url);
        const win = f.mainWindow!;
        expect(win.maximize).not.toHaveBeenCalled();
        expect(win.show).not.toHaveBeenCalled();
        if (trigger === "ready-to-show") win.emit("ready-to-show");
        if (trigger === "fallback") vi.advanceTimersByTime(MAIN_WINDOW_SHOW_FALLBACK_MS);
        if (trigger === "activation") win.show();
        expect(win.isVisible()).toBe(true);
        expect(win.maximize).toHaveBeenCalledOnce();
        win.emit("ready-to-show");
        vi.advanceTimersByTime(MAIN_WINDOW_SHOW_FALLBACK_MS);
        expect(win.maximize).toHaveBeenCalledOnce();
        win.emit("closed");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("awaits placement load in the actual startup callback before dispatching windows", async () => {
    // Run the real callback only as far as host installation. No Electron or service starts.
    const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const prefix = "const startup = app.whenReady().then(";
    const startIndex = source.indexOf(prefix);
    expect(startIndex).toBeGreaterThan(-1);
    const endIndex = source.indexOf("\n});", startIndex);
    expect(endIndex).toBeGreaterThan(startIndex);
    const callback = source.slice(startIndex + prefix.length, endIndex + 2);
    let finish!: () => void;
    const saved = {
      x: 150,
      y: 120,
      width: 1000,
      height: 700,
      maximized: true,
      fullScreen: false,
      displayId: 1,
    };
    const store = {
      current: null as WindowPlace | null,
      load: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        store.current = saved;
      }),
    };
    const reached = new Error("startup boundary reached");
    const installHostService = vi.fn(() => {
      throw reached;
    });
    const context = {
      app: { getPath: () => "/fixture" },
      process: { argv: [] },
      installSmokeProgress: undefined,
      registerIntegrationProtocol: vi.fn(),
      installCustomizationIpc: vi.fn(),
      installDesktopNotifications: vi.fn(),
      installDockBadge: vi.fn(),
      WindowPlaceStore: class {
        get current() {
          return store.current;
        }
        load = store.load;
      },
      windowPlace: undefined,
      windowPlaceQuitWait: undefined,
      createWindowPlaceQuitWait,
      dockBadge: undefined,
      hostService: undefined,
      installHostService,
      localModeOwns: vi.fn(),
      LocalFolders: class {},
      localFoldersFile: vi.fn(),
    };
    const start = vm.runInNewContext(
      stripTypeScriptTypes(`(${callback})`.replaceAll("import.meta.dirname", '"/fixture"')),
      context,
    ) as () => Promise<void>;
    const pending = start();
    const stopped = expect(pending).rejects.toBe(reached);
    expect(store.load).toHaveBeenCalledOnce();
    expect(installHostService).not.toHaveBeenCalled();
    expect(store.current).toBeNull();
    finish();
    await stopped;
    expect(installHostService).toHaveBeenCalledOnce();
    expect(context.windowPlace).toMatchObject({ current: saved, load: store.load });
    expect(store.current).toEqual(saved);
  });
});
