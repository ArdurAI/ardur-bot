import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopReachability, DesktopSetup } from "@ardurbot/contracts";
import { LOCAL_SETTINGS_PAGE } from "@ardurbot/contracts/local-settings";
import type { Session } from "electron";
import { app, BrowserWindow, dialog, ipcMain, Menu, net, session, shell } from "electron";
import type { ElectronAutoUpdater } from "./auto-update.js";
import { DesktopUpdateController, LAUNCH_CHECK_DELAY_MS } from "./auto-update.js";
import { openBrowserAuth } from "./browser-auth.js";
import { cliVersion } from "./cli.js";
import { applySqlMigrationsToDatabase, ensureApplicationDatabase } from "./db-migrate.js";
import { installDevices } from "./devices-ipc.js";
import { DOCKER_INSTALL_LINKS, isDesktopSetupLink, runDocker } from "./docker-cli.js";
import { installCustomizationIpc } from "./extensions/ipc.js";
import { installHostService } from "./host-service-ipc.js";
import {
  focusIntegration,
  integrationReturnId,
  registerIntegrationProtocol,
} from "./integration-return.js";
import { LocalFolders, localFoldersFile } from "./local-folders.js";
import { LocalModeController, localResetFailure, migrationsDir } from "./local-mode.js";
import {
  legacyStackEnvExists,
  loadEmbeddedPostgres,
  loopbackPortAvailable,
  stopWithPgCtl,
} from "./local-postgres.js";
import { requestLocalSettings } from "./local-settings.js";
import {
  allocateLoopbackPort,
  LocalStackController,
  readStackToken,
  readStackWebUrl,
  resolveImageTag,
  stackDir,
  stackResourceDir,
} from "./local-stack.js";
import {
  memoryFolderBridgeAllowed,
  nativeMemoryFolderDependencies,
  registerMemoryFolder,
} from "./memory-folders.js";
import { installDesktopNotifications } from "./notifications.js";
import { oauthCallbackFrom } from "./oauth-callback.js";
import { RemoteListener } from "./remote-listener.js";
import {
  bundledRendererCandidates,
  contentType,
  forwardedRendererRequestInit,
  immutableRendererAsset,
  isRendererAssetMiss,
} from "./renderer-assets.js";
import { installSessionPermissions } from "./session-permissions.js";
import {
  DEFAULT_LOCAL_WEB_URL,
  desktopStackImageTag,
  isArdurBotHealth,
  managedLocalOpenUrl,
  maySendDesktopStackToken,
  normalizeServerUrl,
  parseSetupInput,
  probeFailureMessage,
  readProbeJson,
  resolveStartupTarget,
  safeExternalUrl,
  servesBundledRenderer,
  sessionPartitionForServerUrl,
} from "./setup-config.js";
import { clearSetup, readSetup, writeSetup } from "./setup-store.js";
import { readEnabledRoutines } from "./system/routines.js";
import { installSystemRuntime } from "./system/runtime.js";
import { systemTray } from "./system/tray.js";
import { staysRunning } from "./tray.js";
import { UnsavedFiles } from "./unsaved-files.js";
import { shouldOpenInAppPopup } from "./window-open.js";
import {
  browserWindowOptions,
  developmentIconFile,
  setupWindowOptions,
  warmWindowTtlMs,
} from "./window-options.js";

const versionOutput = cliVersion(process.argv, app.getVersion());
if (versionOutput !== null) {
  process.stdout.write(versionOutput);
  process.exit(0);
}

const PERFORMANCE_USER_DATA =
  process.env.ARDURBOT_USER_DATA_DIR || process.env.ARDURBOT_PERFORMANCE_USER_DATA;
/** Test hook: where the app-managed stack answers. Mode `new` still requires loopback. */
const LOCAL_WEB_URL = process.env.ARDURBOT_LOCAL_WEB_URL?.trim() || DEFAULT_LOCAL_WEB_URL;
const PROBE_TIMEOUT_MS = 8_000;
const DESKTOP_STACK_PROBE_PATH = "/.well-known/ardurbot-desktop-stack";
const DESKTOP_STACK_TOKEN_HEADER = "x-ardurbot-desktop-stack-token";
let desktopTray: ReturnType<typeof systemTray> = null;
let mainWindow: BrowserWindow | null = null;
const unsavedFiles = new UnsavedFiles<BrowserWindow>();
const appWindowTargets = new WeakMap<BrowserWindow, string>();
let setupWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let openingSettings = false;
let settingsCleanup: Promise<void> = Promise.resolve();
let settingsTarget: { origin: string; token: string } | null = null;
const bundledRendererInstallations = new Set<string>();
let currentSetup: DesktopSetup | null = null;
let currentTargetUrl: string | null = null;
let desktopSystem: Awaited<ReturnType<typeof installSystemRuntime>> | undefined;
let setupError: string | null = null;
/** Set when launch opened setup to bring back a saved local instance, not when a person opened it. */
let setupResumesLocal = false;
let serviceFailurePrompt = false;
let setupSaveInProgress = false;
let openAppPromise: Promise<boolean> | null = null;
/** Prior app window kept until setup is persisted (or the switch is abandoned). */
let pendingPreviousWindow: BrowserWindow | null = null;
let quitting = false;
let hostService: ReturnType<typeof installHostService> | undefined;
let warmWindowTimer: NodeJS.Timeout | undefined;
// Number of short-lived hidden probe windows currently alive. On Windows/Linux,
// destroying the last window fires "window-all-closed" -> app.quit(); a probe
// that runs before the first real window exists must not count as "all closed".
let liveProbeWindows = 0;
const WARM_WINDOW_TTL_MS = warmWindowTtlMs(process.env.ARDURBOT_WARM_WINDOW_TTL_MS);

const updaterEnvironment = {
  packaged: app.isPackaged,
  version: app.getVersion(),
  disabled: process.env.ARDURBOT_DISABLE_AUTO_UPDATE === "1",
  downloadOnly: true,
  previewChannel: true,
};
const desktopUpdater = new DesktopUpdateController(
  updaterEnvironment,
  async () => {
    const module = await import("electron-updater");
    return (module.default ?? module).autoUpdater as unknown as ElectronAutoUpdater;
  },
  undefined,
  () => {
    quitting = false;
  },
  (url) => shell.openExternal(url),
);
let launchUpdateCheckScheduled = false;
let localStack: LocalStackController;
let localMode: LocalModeController;
let legacyCompose = false;
let localShutdown: Promise<void> | null = null;
const remoteListener = new RemoteListener();

markOnce("rk:main:module-evaluated");
if (PERFORMANCE_USER_DATA) {
  app.setPath("userData", PERFORMANCE_USER_DATA);
  app.setPath("sessionData", path.join(PERFORMANCE_USER_DATA, "session"));
}
if (!app.requestSingleInstanceLock()) process.exit(0);
let pendingIntegrationReturn: string | null = null;
function returnToIntegration(value: string) {
  const id = integrationReturnId(value);
  if (id === null) return;
  pendingIntegrationReturn = id;
  app.emit("activate");
  focusIntegration(mainWindow, id);
}
app.on("second-instance", (_event, argv) => {
  const link = argv.find((arg) => arg.startsWith("ardurbot:"));
  if (link) returnToIntegration(link);
  else app.emit("activate");
});
app.on("open-url", (event, value) => {
  event.preventDefault();
  returnToIntegration(value);
});

app.once("will-finish-launching", () => markOnce("rk:main:will-finish-launching"));
app.once("ready", () => markOnce("rk:main:ready"));
// Includes fresh partitions and popup-created sessions, before they load remote content.
app.on("session-created", (value) => installSessionPermissions(value, permissionTarget));

function permissionTarget() {
  if (mainWindow === null || mainWindow.isDestroyed()) return null;
  const url = appWindowTargets.get(mainWindow);
  return url === undefined ? null : { webContents: mainWindow.webContents, url };
}

function markOnce(name: string) {
  if (performance.getEntriesByName(name).length === 0) performance.mark(name);
}

function windowFrom(event: Electron.IpcMainInvokeEvent) {
  return BrowserWindow.fromWebContents(event.sender);
}

function fromMainWindow(event: Electron.IpcMainInvokeEvent) {
  return mainWindow !== null && windowFrom(event) === mainWindow;
}

/** Dock/taskbar icon for unpackaged launches; packaged builds get theirs from electron-builder. */
function developmentIcon() {
  if (app.isPackaged) return undefined;
  const icon = path.join(app.getAppPath(), "assets", developmentIconFile(process.platform));
  return existsSync(icon) ? icon : undefined;
}

function sessionPartitionKey(targetUrl: string) {
  return sessionPartitionForServerUrl(targetUrl);
}

function legacyDefaultSessionFlag(partition: string) {
  return path.join(
    app.getPath("userData"),
    `legacy-default-${partition.replace(/[^a-zA-Z0-9_-]/g, "_")}.flag`,
  );
}

/**
 * Prefer the default session when that origin already has cookies or site
 * storage there, so upgrades keep localStorage/IndexedDB. Fresh origins get
 * an isolated partition.
 */
async function resolveSessionForTarget(targetUrl: string) {
  const partition = sessionPartitionKey(targetUrl);
  if (partition === null) {
    return { partition: null, value: session.defaultSession };
  }
  if (existsSync(legacyDefaultSessionFlag(partition))) {
    return { partition: null, value: session.defaultSession };
  }
  const origin = safeOrigin(targetUrl);
  if (origin !== null) {
    try {
      const defaultCookies = await session.defaultSession.cookies.get({ url: origin });
      if (defaultCookies.length > 0) {
        await writeFile(legacyDefaultSessionFlag(partition), new Date().toISOString(), "utf8");
        return { partition: null, value: session.defaultSession };
      }
    } catch {
      // Continue with a storage probe when the profile looks pre-partition.
    }
    if (defaultSessionProfileExists() && (await defaultSessionHasOriginData(origin))) {
      try {
        await writeFile(legacyDefaultSessionFlag(partition), new Date().toISOString(), "utf8");
      } catch {
        // Flag is best-effort; still stay on the default session this launch.
      }
      return { partition: null, value: session.defaultSession };
    }
  }
  return { partition, value: session.fromPartition(partition) };
}

function defaultSessionProfileExists() {
  const root = app.getPath("userData");
  return (
    existsSync(path.join(root, "Local Storage")) ||
    existsSync(path.join(root, "IndexedDB")) ||
    existsSync(path.join(root, "Cookies")) ||
    existsSync(path.join(root, "Network", "Cookies")) ||
    existsSync(path.join(root, "Cache Storage"))
  );
}

/** Page storage in the default session means a pre-partition install for this origin. */
async function defaultSessionHasOriginData(origin: string): Promise<boolean> {
  const probe = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  // Increment only after construction succeeds so a throw cannot leave the
  // counter stuck > 0 and permanently block quit on Windows/Linux.
  liveProbeWindows++;
  try {
    await probe.loadURL(origin);
    return (await probe.webContents.executeJavaScript(`(async () => {
      if (localStorage.length > 0 || sessionStorage.length > 0) return true;
      if (typeof indexedDB !== "undefined" && indexedDB.databases) {
        try {
          const databases = await indexedDB.databases();
          if (databases.length > 0) return true;
        } catch {}
      }
      if (typeof caches !== "undefined") {
        try {
          const keys = await caches.keys();
          if (keys.length > 0) return true;
        } catch {}
      }
      return false;
    })()`)) as boolean;
  } catch {
    return false;
  } finally {
    if (!probe.isDestroyed()) probe.destroy();
    liveProbeWindows--;
  }
}

function createWindow(url: string, partition: string | null) {
  markOnce("rk:main:window-create-start");
  const icon = developmentIcon();
  const win = new BrowserWindow({
    ...browserWindowOptions(process.platform),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Deliver completion and approval notifications while the tray keeps work alive.
      backgroundThrottling: false,
      ...(partition === null ? {} : { partition }),
    },
  });
  mainWindow = win;
  appWindowTargets.set(win, url);
  desktopSystem?.attachWindow(win, url);
  const targetOrigin = safeOrigin(url);
  // Intentional OAuth flows open the provider's authorize page via a named
  // window; give those and same-origin popups a normal frame. Everything else
  // uses the selected link viewer so a connected server cannot navigate us away.
  // Hoisted for loopback OAuth capture so MCP/in-app localhost callbacks are skipped.
  const appOrigin = targetOrigin ?? safeOrigin(url);
  win.webContents.setWindowOpenHandler(({ url: childUrl, frameName }) => {
    if (shouldOpenInAppPopup(appOrigin, childUrl, frameName)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: oauthPopupWindowOptions(),
      };
    }
    const external = safeExternalUrl(childUrl);
    if (external !== null) {
      if (desktopSystem) desktopSystem.openLink(external);
      else void shell.openExternal(external);
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, navigationUrl) => {
    if (targetOrigin !== null && safeOrigin(navigationUrl) === targetOrigin) return;
    event.preventDefault();
    const external = safeExternalUrl(navigationUrl);
    if (external !== null) {
      if (desktopSystem) desktopSystem.openLink(external);
      else void shell.openExternal(external);
    }
  });
  // The popup has no address bar, so a loopback redirect would otherwise strand
  // the user on a blank window holding the authorization code in a URL they
  // cannot read. Capture it here and hand it to the app instead.
  win.webContents.on("did-create-window", (popup) => {
    const capture = (details: {
      preventDefault: () => void;
      url: string;
      isMainFrame?: boolean;
    }) => {
      // will-redirect can fire for iframes; only the top-level callback counts.
      if (details.isMainFrame === false) return;
      const callback = oauthCallbackFrom(details.url, {
        excludeOrigins: appOrigin !== null ? [appOrigin] : [],
      });
      if (!callback) return;
      details.preventDefault();
      if (!win.isDestroyed()) win.webContents.send("desktop.oauth.callback", callback);
      if (!popup.isDestroyed()) popup.close();
    };
    popup.webContents.on("will-redirect", (details) => capture(details));
    popup.webContents.on("will-navigate", (details) => capture(details));
  });
  win.webContents.on("will-prevent-unload", (event) => {
    if (quitting && !unsavedFiles.has(win)) {
      event.preventDefault();
      return;
    }
    const discard =
      dialog.showMessageBoxSync(win, {
        type: "question",
        message: "Unsaved changes",
        buttons: ["Cancel", "Discard"],
        defaultId: 0,
        cancelId: 0,
      }) === 1;
    if (discard) {
      unsavedFiles.set(win, false);
      event.preventDefault();
    } else quitting = false;
  });
  win.on("close", (event) => {
    if (
      staysRunning(process.platform, desktopTray !== null, hostService?.keepRunning) &&
      !quitting &&
      process.env.ARDURBOT_DISABLE_WARM_WINDOW !== "1"
    ) {
      event.preventDefault();
      win.hide();
      clearTimeout(warmWindowTimer);
      warmWindowTimer = setTimeout(() => {
        // The hidden renderer continues the authenticated notification feed while work continues.
        if (
          !hostService?.keepRunning &&
          mainWindow === win &&
          !win.isDestroyed() &&
          !win.isVisible() &&
          !unsavedFiles.has(win)
        )
          win.destroy();
      }, WARM_WINDOW_TTL_MS);
    }
  });
  win.once("closed", () => {
    if (mainWindow === win) {
      clearTimeout(warmWindowTimer);
      mainWindow = null;
      hostService?.windowClosed();
    }
  });
  markOnce("rk:main:window-created");
  if (win.isVisible()) markOnce("rk:main:window-shown");
  win.once("show", () => markOnce("rk:main:window-shown"));
  win.once("ready-to-show", () => markOnce("rk:main:ready-to-show"));
  win.webContents.once("dom-ready", () => markOnce("rk:main:dom-ready"));
  win.webContents.once("did-finish-load", () => markOnce("rk:main:did-finish-load"));
  win.webContents.once("did-stop-loading", () => markOnce("rk:main:did-stop-loading"));
  markOnce("rk:main:load-url-start");
  const loaded = loadAppUrl(win, url).then(
    () => markOnce("rk:main:load-url-resolved"),
    (error: unknown) => {
      markOnce("rk:main:load-url-rejected");
      throw error;
    },
  );
  if (!launchUpdateCheckScheduled) {
    launchUpdateCheckScheduled = true;
    setTimeout(() => void desktopUpdater.check(false), LAUNCH_CHECK_DELAY_MS).unref();
    setInterval(() => void desktopUpdater.check(false), 60 * 60 * 1_000).unref();
  }
  return { loaded, win };
}

async function probeDocument(url: string): Promise<string | null> {
  // Test/dev harnesses may load data: or file: documents; only probe real servers.
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
  try {
    const response = await net.fetch(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Allow 3xx (e.g. / → /login); reject hard HTTP errors before opening a window.
    if (response.status >= 400) {
      // The local API does not serve the UI. The bundled renderer does, after this probe.
      if (response.status === 404 && localModeOwns(url)) return null;
      return `The server answered with HTTP ${response.status}.`;
    }
    return null;
  } catch (error) {
    return probeFailureMessage(error);
  }
}

/**
 * loadURL alone treats many HTTP error documents as success. Reject main-frame
 * failures, renderer crashes during load, HTTP 4xx/5xx main-frame responses, and
 * shells that never mount application content.
 */
function loadAppUrl(win: BrowserWindow, url: string): Promise<void> {
  const contents = win.webContents;
  const targetSession = contents.session;
  let mainStatus: number | undefined;

  targetSession.webRequest.onCompleted({ urls: ["*://*/*"] }, (details) => {
    if (details.webContentsId === contents.id && details.resourceType === "mainFrame") {
      mainStatus = details.statusCode;
    }
  });

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      contents.removeListener("did-fail-load", onFail);
      // Keep render-process-gone until document readiness finishes so a crash
      // during mount still fails the switch.
      targetSession.webRequest.onCompleted(null);
      if (error) {
        contents.removeListener("render-process-gone", onGone);
        reject(error);
        return;
      }
      if (mainStatus !== undefined && mainStatus >= 400) {
        contents.removeListener("render-process-gone", onGone);
        reject(new Error(`The server answered with HTTP ${mainStatus}.`));
        return;
      }
      void waitForMountedAppDocument(contents)
        .then(() => {
          contents.removeListener("render-process-gone", onGone);
          if (contents.isCrashed()) {
            reject(new Error("Renderer stopped after load."));
            return;
          }
          resolve();
        })
        .catch((inspectError: unknown) => {
          contents.removeListener("render-process-gone", onGone);
          reject(inspectError instanceof Error ? inspectError : new Error(String(inspectError)));
        });
    };

    const onFail = (
      _event: Electron.Event,
      _errorCode: number,
      errorDescription: string,
      _validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame) settle(new Error(errorDescription || "Page failed to load."));
    };
    const onGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
      settle(new Error(`Renderer stopped (${details.reason}).`));
    };

    contents.on("did-fail-load", onFail);
    contents.on("render-process-gone", onGone);
    void contents.loadURL(url).then(
      async () => {
        // onCompleted can lag loadURL; wait briefly for the main-frame status.
        const deadline = Date.now() + 500;
        while (mainStatus === undefined && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
        settle();
      },
      (error: unknown) => {
        settle(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Empty `#root` shells and session-pending skeletons count as loaded HTML but are
 * not a usable app. After session resolves, wait for a bootstrapped shell
 * (`data-ready` / shell-ready mark) or an auth/welcome/onboarding surface so a
 * bare Suspense fallback or pre-bootstrap ShellPage cannot pass. Plain e2e
 * fixtures omit the Ardur Bot app-state marker.
 */
async function waitForMountedAppDocument(contents: Electron.WebContents) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (contents.isCrashed()) throw new Error("Renderer stopped after load.");
    const ready = (await contents.executeJavaScript(`(() => {
      const appState =
        document.querySelector("[data-ardurbot-app-state]")?.getAttribute("data-ardurbot-app-state") ??
        null;
      if (appState === "session-pending") return false;

      const shell = document.querySelector('[data-testid="shell-root"]');
      const shellBootstrapped = Boolean(
        (shell && shell.getAttribute("data-ready") === "true") ||
          performance.getEntriesByName("rk:renderer:shell-ready").length > 0,
      );
      const authOrWelcomeSurface = Boolean(
        document.querySelector('[data-ardurbot-surface="welcome"]') ||
          document.querySelector(
            'form input[type="email"], form input[name="email"], form input#email',
          ) ||
          Array.from(document.querySelectorAll("button")).some((button) =>
            /sign\\s*in/i.test((button.textContent || "").trim()),
          ) ||
          document.querySelector(
            '[aria-label="Model"], [aria-label="Model id"], [aria-label="Models from server"]',
          ),
      );
      const surfaceReady = shellBootstrapped || authOrWelcomeSurface;
      const sessionReady =
        appState === "ready" ||
        performance.getEntriesByName("rk:renderer:session-committed").length > 0;
      if (sessionReady && surfaceReady) return true;

      // Desktop e2e fixtures mount a plain page without Ardur Bot app-state markers.
      if (appState === null) {
        const bodyText = (document.body?.innerText || "").trim();
        if (bodyText.includes("Opening your Space")) return false;
        if (bodyText === "Loading…" || bodyText === "Loading...") return false;
        const mainText = (document.querySelector("main")?.textContent || "").trim();
        const rootChildren = document.getElementById("root")?.childElementCount ?? 0;
        return mainText.length > 0 || rootChildren > 0;
      }
      return false;
    })()`)) as boolean;
    if (ready) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("The server page did not become ready.");
}

async function installBundledRenderer(
  targetUrl: string,
  targetSession: Session,
  partition: string | null,
) {
  const localRenderer = localModeOwns(targetUrl);
  if ((!app.isPackaged && !localRenderer) || process.env.ARDURBOT_DISABLE_BUNDLED_RENDERER === "1")
    return;
  if (!servesBundledRenderer(targetUrl)) return;
  const webUrl = new URL(targetUrl);
  const installationKey = `${partition ?? "default"}:${webUrl.protocol}`;
  if (bundledRendererInstallations.has(installationKey)) return;
  const root = app.isPackaged
    ? path.join(process.resourcesPath, "web")
    : path.resolve(app.getAppPath(), "../web/dist");

  await targetSession.protocol.handle(webUrl.protocol.slice(0, -1), async (request) => {
    const forward = () => {
      return targetSession.fetch(request, forwardedRendererRequestInit(request, webUrl.origin));
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      return forward();
    }
    const acceptsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
    const candidates = bundledRendererCandidates(root, request.url, webUrl.origin, acceptsHtml);
    if (!candidates) return forward();
    for (const file of candidates) {
      let body: Buffer | null = null;
      try {
        if (request.method === "HEAD") {
          if (!(await stat(file)).isFile()) continue;
        } else {
          body = await readFile(file);
        }
      } catch (error) {
        if (isRendererAssetMiss(error)) continue;
        throw error;
      }
      const headers = new Headers({
        "cache-control": immutableRendererAsset(file)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "content-type": contentType(file),
        "x-content-type-options": "nosniff",
      });
      return new Response(body, { headers });
    }
    return forward();
  });
  bundledRendererInstallations.add(installationKey);
  markOnce("rk:main:bundled-renderer-ready");
}

function oauthPopupWindowOptions() {
  return {
    width: 560,
    height: 720,
    frame: true,
    titleBarStyle: "default" as const,
    autoHideMenuBar: true,
    backgroundColor: "#0B0C0E",
    webPreferences: {
      preload: "",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  };
}

function createSetupWindow() {
  const icon = developmentIcon();
  const win = new BrowserWindow({
    ...setupWindowOptions(process.platform),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(import.meta.dirname, "setup-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // A long pull runs while this window sits behind others; throttled timers would freeze it.
      backgroundThrottling: false,
    },
  });
  setupWindow = win;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("closed", () => {
    if (setupWindow === win) setupWindow = null;
    // Closing setup without saving restores a connected session (Change Server cancel).
    restoreAppWindowAfterSetup();
  });
  void win.loadFile(path.join(import.meta.dirname, "setup.html"));
  markOnce("rk:main:setup-window-created");
  return win;
}

/** Hide the app while setup is open; do not clear the saved target until a new one opens. */
function showSetupWindow(error: string | null = null, options: { resume?: boolean } = {}) {
  setupError = error;
  setupResumesLocal = options.resume === true;

  let win: BrowserWindow;
  if (setupWindow !== null && !setupWindow.isDestroyed()) {
    if (error !== null) setupWindow.reload();
    win = setupWindow;
  } else {
    win = createSetupWindow();
  }
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.hide();
  win.show();
  win.focus();
  return win;
}

/**
 * After setup, a stopped local service is a sheet on the app window with Retry, and with
 * Reset local data when only a reset clears it. An open setup window already shows the
 * same sentence and its own buttons.
 */
function showServiceFailure(message: string, offerReset = false) {
  if (setupWindow !== null && !setupWindow.isDestroyed()) return;
  const win = mainWindow;
  if (win === null || win.isDestroyed() || serviceFailurePrompt) return;
  serviceFailurePrompt = true;
  const buttons = offerReset ? ["Retry", "Reset local data", "Close"] : ["Retry", "Close"];
  void dialog
    .showMessageBox(win, {
      type: "warning",
      message,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    })
    .finally(() => {
      serviceFailurePrompt = false;
    })
    .then(({ response }) => {
      if (response === 0) void localMode.start();
      else if (offerReset && response === 1) void resetLocalDataAndStart(win);
    });
}

/** Moves local mode's database, files and settings aside once the person confirms. */
async function confirmLocalReset(parent: BrowserWindow): Promise<boolean> {
  const { response } = await dialog.showMessageBox(parent, {
    type: "warning",
    message: "Reset local data?",
    detail:
      "Bots, conversations and files on this computer move to a backup folder, and Ardur Bot starts fresh.",
    buttons: ["Cancel", "Reset"],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return false;
  await localMode.resetData();
  return true;
}

/**
 * A failed reset moved nothing, so the old data is untouched, but starting it back up is
 * not what "Retry" should mean here: only Reset local data (with its own confirmation)
 * clears this sentence.
 */
function showResetFailure(message: string, parent: BrowserWindow) {
  if (setupWindow !== null && !setupWindow.isDestroyed()) return;
  if (parent.isDestroyed() || serviceFailurePrompt) return;
  serviceFailurePrompt = true;
  void dialog
    .showMessageBox(parent, {
      type: "warning",
      message,
      buttons: ["Reset local data", "Close"],
      defaultId: 0,
      cancelId: 1,
    })
    .finally(() => {
      serviceFailurePrompt = false;
    })
    .then(({ response }) => {
      if (response === 0) void resetLocalDataAndStart(parent);
    });
}

/**
 * Once the person confirms, moves local data aside and starts fresh behind the setup window.
 * A reset that failed moved nothing; the sheet says why and offers it again.
 */
async function resetLocalDataAndStart(parent: BrowserWindow): Promise<boolean> {
  try {
    if (!(await confirmLocalReset(parent))) return false;
  } catch (error) {
    showResetFailure(localResetFailure(error), parent);
    return false;
  }
  showSetupWindow(null, { resume: true });
  void localMode.start();
  return true;
}

function restoreAppWindowAfterSetup() {
  if (quitting) return;
  if (setupWindow !== null && !setupWindow.isDestroyed()) return;
  if (mainWindow === null || mainWindow.isDestroyed() || currentTargetUrl === null) return;
  clearTimeout(warmWindowTimer);
  mainWindow.show();
  mainWindow.focus();
}

async function showLocalSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  if (openingSettings) return;
  openingSettings = true;
  try {
    const url = localStack.webUrl();
    const token = await readStackToken(stackDir(app.getPath("userData")));
    if (!token || !(await localStack.matchesDesiredStack(url))) {
      await dialog.showMessageBox({
        message: "Start the local server before opening its settings.",
        type: "info",
      });
      return;
    }
    await settingsCleanup;
    const partition = "local-server-settings";
    const targetSession = session.fromPartition(partition);
    installSessionPermissions(targetSession, () => null);
    await installBundledRenderer(url, targetSession, partition);
    const win = new BrowserWindow({
      ...browserWindowOptions(process.platform),
      title: "Local Server Settings",
      frame: true,
      titleBarStyle: "default",
      trafficLightPosition: undefined,
      webPreferences: {
        preload: path.join(import.meta.dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition,
      },
    });
    settingsWindow = win;
    const origin = new URL(url).origin;
    settingsTarget = { origin, token };
    win.webContents.setWindowOpenHandler(({ url: externalUrl }) => {
      const external = safeExternalUrl(externalUrl);
      if (external) void shell.openExternal(external);
      return { action: "deny" };
    });
    const preventNavigation = (event: Electron.Event, target: string) => {
      if (target === `${origin}${LOCAL_SETTINGS_PAGE}`) return;
      event.preventDefault();
    };
    win.webContents.on("will-navigate", preventNavigation);
    win.webContents.on("will-redirect", preventNavigation);
    win.once("closed", () => {
      if (settingsWindow === win) {
        settingsWindow = null;
        settingsTarget = null;
      }
      const protocol = new URL(url).protocol;
      if (bundledRendererInstallations.delete(`${partition}:${protocol}`)) {
        targetSession.protocol.unhandle(protocol.slice(0, -1));
      }
      settingsCleanup = targetSession.clearStorageData().catch(() => undefined);
    });
    await win.loadURL(`${origin}${LOCAL_SETTINGS_PAGE}`);
  } catch {
    settingsWindow?.close();
    await dialog.showMessageBox({
      message: "Could not open local server settings. Try again.",
      type: "error",
    });
  } finally {
    openingSettings = false;
  }
}

function installApplicationMenu() {
  const localSettings: Electron.MenuItemConstructorOptions = {
    id: "local-server-settings",
    label: "Local Server Settings…",
    accelerator: "CmdOrCtrl+,",
    click: () => {
      void showLocalSettings();
    },
  };
  const changeServer: Electron.MenuItemConstructorOptions = {
    id: "change-ardurbot-server",
    label: "Change Ardur Bot Server…",
    accelerator: "CmdOrCtrl+Shift+K",
    click: () => showSetupWindow(),
  };
  const stopStack: Electron.MenuItemConstructorOptions = {
    id: "stop-local-stack",
    label: "Stop Local Stack",
    // The stack keeps running after quit (bots are always on); this is the explicit off switch.
    click: () => {
      if (currentSetup?.mode !== "new") return;
      if (legacyCompose) void localStack.stop();
      else void localMode.stop();
    },
  };
  const template: Electron.MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              localSettings,
              changeServer,
              stopStack,
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          { role: "editMenu" },
          { role: "windowMenu" },
        ]
      : [
          {
            label: "File",
            submenu: [
              localSettings,
              changeServer,
              stopStack,
              { type: "separator" },
              { role: "quit" },
            ],
          },
          { role: "editMenu" },
          { role: "windowMenu" },
        ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Setup IPC must only answer the setup window, never a connected Ardur Bot server. */
function fromSetupWindow(event: Electron.IpcMainInvokeEvent) {
  return (
    setupWindow !== null && !setupWindow.isDestroyed() && event.sender === setupWindow.webContents
  );
}

async function probeServer(rawUrl: string, signal?: AbortSignal): Promise<DesktopReachability> {
  const url = normalizeServerUrl(rawUrl);
  if (url === null) return { ok: false, error: "Enter a valid http:// or https:// address." };
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);

  try {
    const response = await net.fetch(`${url}/rpc/health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: {} }),
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        status: response.status,
        url,
        error: "That address redirects elsewhere. Enter the final Ardur Bot server address.",
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        url,
        error: `The server answered with HTTP ${response.status}.`,
      };
    }
    const health = await readProbeJson(response);
    if (!isArdurBotHealth(health)) {
      return {
        ok: false,
        status: response.status,
        url,
        error: "That address did not respond like a Ardur Bot server.",
      };
    }
    return {
      ok: true,
      status: response.status,
      url,
    };
  } catch (error) {
    return { ok: false, url, error: probeFailureMessage(error) };
  }
}

/** A public health response is not enough: another checkout may own the same fixed port. */
async function probeManagedStack(
  rawUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const url = normalizeServerUrl(rawUrl);
  // Never put the private stack token on a cleartext LAN or .local hop.
  if (url === null || !maySendDesktopStackToken(url)) return null;
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    const response = await net.fetch(`${url}${DESKTOP_STACK_PROBE_PATH}`, {
      method: "GET",
      headers: { [DESKTOP_STACK_TOKEN_HEADER]: token },
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!response.ok) return null;
    return desktopStackImageTag(await readProbeJson(response));
  } catch {
    return null;
  }
}

function openApp(targetUrl: string) {
  if (openAppPromise !== null) return openAppPromise;
  openAppPromise = openAppOnce(targetUrl).finally(() => {
    openAppPromise = null;
  });
  return openAppPromise;
}

function openFailureDetail(error: unknown): string {
  if (error instanceof Error) {
    const { message } = error;
    if (
      message.startsWith("The server answered with HTTP") ||
      message.startsWith("The server page loaded empty") ||
      message.startsWith("The server page did not become ready") ||
      message.startsWith("Renderer stopped") ||
      message.startsWith("Page failed to load")
    ) {
      return message;
    }
  }
  return probeFailureMessage(error);
}

async function openAppOnce(targetUrl: string) {
  const target = await resolveSessionForTarget(targetUrl);
  const previous = mainWindow;
  let win: BrowserWindow | null = null;
  try {
    const documentError = await probeDocument(targetUrl);
    if (documentError !== null) {
      throw new Error(documentError);
    }
    await installBundledRenderer(targetUrl, target.value, target.partition);
    const created = createWindow(targetUrl, target.partition);
    win = created.win;
    await created.loaded;
    if (currentTargetUrl !== targetUrl) await remoteListener.stop();
    currentTargetUrl = targetUrl;
    void desktopSystem?.controller.refreshRoutines();
    await hostService?.activate(targetUrl);
    setupError = null;
    // Keep the previous window until the caller commits (after setup.json is written).
    pendingPreviousWindow =
      previous !== null && !previous.isDestroyed() && previous !== win ? previous : null;
    if (pendingPreviousWindow !== null) pendingPreviousWindow.hide();
    return true;
  } catch (error) {
    pendingPreviousWindow = null;
    // Keep the previous app window so Cancel / close can restore it.
    if (previous !== null && !previous.isDestroyed()) mainWindow = previous;
    // Show the setup window BEFORE destroying the failed one: on Windows/Linux,
    // destroying the last window fires "window-all-closed" -> app.quit() before
    // showSetupWindow() runs, so the app silently exits instead of showing this error.
    showSetupWindow(`Could not open that server. ${openFailureDetail(error)}`);
    if (win !== null && !win.isDestroyed()) win.destroy();
    return false;
  }
}

/** Drop the previous app window after the new server is opened and persisted. */
function commitPendingAppSwitch() {
  const previous = pendingPreviousWindow;
  pendingPreviousWindow = null;
  if (previous !== null && !previous.isDestroyed() && previous !== mainWindow) previous.destroy();
}

/**
 * Undo an open that could not be persisted. When a prior session exists, restore
 * it. On first run keep the connected window so the user can retry save.
 */
async function abandonPendingAppSwitch(
  previousSetup: DesktopSetup | null,
  previousUrl: string | null,
): Promise<"restored" | "kept"> {
  const previous = pendingPreviousWindow;
  pendingPreviousWindow = null;
  if (previous !== null && !previous.isDestroyed()) {
    const failed = mainWindow;
    mainWindow = previous;
    if (failed !== null && !failed.isDestroyed() && failed !== previous) failed.destroy();
    currentSetup = previousSetup;
    currentTargetUrl = previousUrl;
    if (previousUrl !== null) await hostService?.activate(previousUrl);
    // If setup was already closed (e.g. during a slow write), make the restored
    // session visible — otherwise macOS can be left with no shown window.
    if (setupWindow === null || setupWindow.isDestroyed()) {
      clearTimeout(warmWindowTimer);
      previous.show();
      previous.focus();
    }
    return "restored";
  }
  return "kept";
}

/** Watch for a renderer crash until setup is persisted (or the switch is abandoned). */
function watchRendererUntilCommitted(win: BrowserWindow) {
  let crashed = false;
  const onGone = () => {
    crashed = true;
  };
  win.webContents.once("render-process-gone", onGone);
  return {
    crashed: () => crashed || (!win.isDestroyed() && win.webContents.isCrashed()),
    dispose: () => {
      if (!win.isDestroyed()) win.webContents.removeListener("render-process-gone", onGone);
    },
  };
}

function destroySetupWindow() {
  const setup = setupWindow;
  setupWindow = null;
  if (setup !== null && !setup.isDestroyed()) setup.destroy();
}

/** Best-effort restore of setup.json after a failed save that already wrote disk. */
async function rollbackSetupFile(userDataDir: string, previousSetup: DesktopSetup | null) {
  try {
    if (previousSetup !== null) await writeSetup(userDataDir, previousSetup);
    else await clearSetup(userDataDir);
  } catch {
    // Disk rollback is best-effort; callers already restored in-memory state when possible.
  }
}

/**
 * After a renderer crash around save: restore prior setup when possible, otherwise
 * drop the crashed first-run window so setup remains the only recovery surface.
 */
async function recoverFromCrashedSave(
  userDataDir: string,
  previousSetup: DesktopSetup | null,
  previousUrl: string | null,
): Promise<string> {
  const outcome = await abandonPendingAppSwitch(previousSetup, previousUrl);
  await rollbackSetupFile(userDataDir, previousSetup);
  if (outcome === "kept") {
    if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.destroy();
    mainWindow = null;
    currentSetup = previousSetup;
    currentTargetUrl = previousUrl;
  }
  const message =
    previousSetup !== null
      ? "Could not open that server. Renderer stopped. The previous instance was restored for the next launch."
      : "Could not open that server. Renderer stopped.";
  showSetupWindow(message);
  return message;
}

/**
 * Opens the chosen server before saving it. Local mode keeps running until an existing
 * server answered, opened, and was saved, so a mistyped address leaves it untouched.
 */
async function saveSetup(payload: unknown, userDataDir: string) {
  if (setupSaveInProgress) return { ok: false, error: "A connection attempt is already running." };
  setupSaveInProgress = true;
  const previousSetup = currentSetup;
  const previousUrl = currentTargetUrl;
  try {
    const setup = parseSetupInput(payload);
    if (setup === null) {
      return {
        ok: false,
        error:
          "Enter a valid server address. Public servers require HTTPS; a new local instance must use localhost.",
      };
    }

    // Only open the exact origin selected and authenticated by the managed stack.
    let openSetup = setup;
    if (setup.mode === "new") {
      const managedBase = legacyCompose ? localStack.webUrl() : localMode.origin();
      const managedUrl = managedLocalOpenUrl(setup.serverUrl, managedBase);
      const ready = legacyCompose
        ? managedUrl !== null && (await localStack.matchesDesiredStack())
        : managedUrl !== null && localMode.state().phase === "ready";
      if (!ready || managedUrl === null) {
        return {
          ok: false,
          error: "The app-managed Ardur Bot services are not ready. Retry setup.",
        };
      }
      openSetup = { mode: "new", serverUrl: managedUrl };
    }

    const reachability = await probeServer(openSetup.serverUrl);
    if (!reachability.ok) return { ok: false, error: reachability.error };

    // Open before persisting so a failed renderer load keeps the last working setup.
    currentSetup = openSetup;
    const opened = await openApp(openSetup.serverUrl);
    if (!opened) {
      currentSetup = previousSetup;
      return {
        ok: false,
        error: "Could not open that server. The previous instance was left unchanged.",
      };
    }

    const appWindow = mainWindow;
    const rendererWatch =
      appWindow !== null && !appWindow.isDestroyed()
        ? watchRendererUntilCommitted(appWindow)
        : null;
    try {
      await writeSetup(userDataDir, openSetup);
      if (rendererWatch?.crashed()) {
        const message = await recoverFromCrashedSave(userDataDir, previousSetup, previousUrl);
        return { ok: false, error: message };
      }
      // Commit while the crash listener is still armed.
      commitPendingAppSwitch();
      if (rendererWatch?.crashed()) {
        const message = await recoverFromCrashedSave(userDataDir, previousSetup, previousUrl);
        return { ok: false, error: message };
      }
      destroySetupWindow();
      // Final check after setup closes — a crash in this gap still rolls back.
      if (rendererWatch?.crashed()) {
        const message = await recoverFromCrashedSave(userDataDir, previousSetup, previousUrl);
        return { ok: false, error: message };
      }
      if (openSetup.mode === "existing" && !legacyCompose) void localMode.stop();
      return { ok: true };
    } catch {
      const outcome = await abandonPendingAppSwitch(previousSetup, previousUrl);
      return {
        ok: false,
        error:
          outcome === "restored"
            ? "Could not save setup. The previous instance was restored."
            : "Connected, but could not save setup for the next launch. Try Continue again.",
      };
    } finally {
      rendererWatch?.dispose();
    }
  } finally {
    setupSaveInProgress = false;
  }
}

function localModeOwns(targetUrl: string): boolean {
  if (legacyCompose || localMode === undefined) return false;
  const origin = localMode.origin();
  if (origin === "") return false;
  try {
    return new URL(targetUrl).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function safeOrigin(targetUrl: string) {
  try {
    return new URL(targetUrl).origin;
  } catch {
    return null;
  }
}

app.whenReady().then(async () => {
  registerIntegrationProtocol(app);
  const initialLink = process.argv.find((arg) => arg.startsWith("ardurbot:"));
  if (initialLink) pendingIntegrationReturn = integrationReturnId(initialLink);
  installCustomizationIpc({ window: () => mainWindow, target: () => currentTargetUrl });
  installDesktopNotifications({ window: () => mainWindow, target: () => currentTargetUrl });
  const userDataDir = app.getPath("userData");
  hostService = installHostService({
    window: () => mainWindow,
    target: () => currentTargetUrl,
    tray: () => desktopTray,
    local: { owns: localModeOwns, folders: new LocalFolders(localFoldersFile(userDataDir)) },
  });
  installSessionPermissions(session.defaultSession, permissionTarget);
  localStack = new LocalStackController({
    platform: process.platform,
    env: process.env,
    exists: existsSync,
    run: runDocker,
    stackDir: stackDir(userDataDir),
    resourceDir: stackResourceDir({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
    localWebUrl:
      process.env.ARDURBOT_LOCAL_WEB_URL?.trim() ||
      (await readStackWebUrl(stackDir(userDataDir), LOCAL_WEB_URL)),
    imageTag: resolveImageTag({
      version: app.getVersion(),
      packaged: app.isPackaged,
      override: process.env.ARDURBOT_IMAGE_TAG,
    }),
    probe: (url, signal, token) => probeManagedStack(url, token, signal),
    randomHex: (bytes) => randomBytes(bytes).toString("hex"),
    onState: (state) => {
      if (setupWindow !== null && !setupWindow.isDestroyed()) {
        setupWindow.webContents.send("desktop.setup.stack.changed", state);
      }
    },
  });
  legacyCompose = await legacyStackEnvExists(userDataDir);
  let binaries: Awaited<ReturnType<typeof loadEmbeddedPostgres>> | undefined;
  // Loaded when local mode first starts: a Compose launch never needs these binaries,
  // and a missing package becomes one sentence in a window whose handlers exist.
  const postgresBinaries = async () => {
    binaries ??= await loadEmbeddedPostgres({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    });
    return binaries;
  };
  localMode = new LocalModeController({
    userDataDir,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    execPath: process.execPath,
    platform: process.platform,
    env: process.env,
    spawn,
    fetch: (url, init) => net.fetch(url, init),
    migrate: async ({ adminUrl, databaseUrl, signal }) => {
      await ensureApplicationDatabase({ adminUrl, databaseUrl, signal });
      await applySqlMigrationsToDatabase({
        connectionString: databaseUrl,
        signal,
        migrationsDir: migrationsDir({
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath(),
        }),
      });
    },
    postgresFactory: async (options) => new (await postgresBinaries()).EmbeddedPostgres(options),
    stopAdoptedPostgres: async (databaseDir) =>
      stopWithPgCtl((await postgresBinaries()).pgCtl, databaseDir),
    allocatePort: allocateLoopbackPort,
    portAvailable: loopbackPortAvailable,
    randomHex: (bytes) => randomBytes(bytes).toString("hex"),
    now: () => Date.now(),
    onState: (state) => {
      if (setupWindow !== null && !setupWindow.isDestroyed()) {
        setupWindow.webContents.send("desktop.setup.stack.changed", state);
      }
    },
    onFailed: (message, offerReset) => {
      setupError = message;
      showServiceFailure(message, offerReset);
    },
  });
  currentSetup = await readSetup(userDataDir);
  const target = resolveStartupTarget({
    envUrl: process.env.ARDURBOT_WEB_URL,
    saved: currentSetup,
    forceSetup: process.env.ARDURBOT_FORCE_SETUP === "1",
  });
  if (process.env.ARDURBOT_PERFORMANCE_CLEAR_CACHE === "1") {
    const cacheSessions = new Set<Session>([session.defaultSession]);
    if (target.kind === "app") {
      cacheSessions.add((await resolveSessionForTarget(target.url)).value);
    }
    await Promise.all(
      [...cacheSessions].flatMap((value) => [value.clearCache(), value.clearCodeCaches({})]),
    );
    markOnce("rk:main:caches-cleared");
  }

  const icon = developmentIcon();
  if (process.platform === "darwin" && icon) app.dock?.setIcon(icon);
  installApplicationMenu();
  const browserAuthAttempts = new Map<string, AbortController>();
  const cancelBrowserAuth = () => {
    for (const attempt of browserAuthAttempts.values()) attempt.abort();
    browserAuthAttempts.clear();
  };
  app.on("before-quit", cancelBrowserAuth);
  ipcMain.handle("desktop.integrations.open", async (event, value: unknown) => {
    if (
      !fromMainWindow(event) ||
      event.senderFrame !== event.sender.mainFrame ||
      typeof value !== "string" ||
      value.length > 16384
    )
      throw new Error("Invalid sign-in request.");
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Invalid sign-in address.");
    await shell.openExternal(url.href);
  });
  ipcMain.handle("desktop.integrations.focus", (event) => {
    if (fromMainWindow(event) && event.senderFrame === event.sender.mainFrame)
      focusIntegration(mainWindow, "");
  });
  ipcMain.handle("desktop.integrations.ready", (event) => {
    if (!fromMainWindow(event) || event.senderFrame !== event.sender.mainFrame) return;
    if (pendingIntegrationReturn !== null) {
      focusIntegration(mainWindow, pendingIntegrationReturn);
      pendingIntegrationReturn = null;
    }
  });
  ipcMain.handle("desktop.oauth.open", async (event, url: unknown) => {
    if (
      (!fromMainWindow(event) &&
        !(settingsWindow !== null && windowFrom(event) === settingsWindow)) ||
      event.senderFrame !== event.sender.mainFrame ||
      typeof url !== "string" ||
      url.length > 16_384
    )
      throw new Error("Invalid sign-in request.");
    if (browserAuthAttempts.has(url) || browserAuthAttempts.size >= 8) {
      throw new Error("A sign-in attempt is already active. Cancel it and retry.");
    }
    const controller = new AbortController();
    browserAuthAttempts.set(url, controller);
    const stop = () => controller.abort();
    const expiry = setTimeout(stop, 10 * 60_000);
    expiry.unref();
    event.sender.once("destroyed", stop);
    event.sender.once("did-navigate", stop);
    controller.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(expiry);
        event.sender.removeListener("destroyed", stop);
        event.sender.removeListener("did-navigate", stop);
        if (browserAuthAttempts.get(url) === controller) browserAuthAttempts.delete(url);
      },
      { once: true },
    );
    try {
      await openBrowserAuth(url, {
        signal: controller.signal,
        onClose: stop,
        openExternal: (target) => shell.openExternal(target),
        onCallback: (callback) => {
          if (!event.sender.isDestroyed()) event.sender.send("desktop.oauth.callback", callback);
        },
      });
    } catch {
      controller.abort();
      throw new Error("Could not open browser sign-in. Close other sign-in attempts and retry.");
    }
  });
  ipcMain.handle("desktop.oauth.cancel", (event, url: unknown) => {
    if (
      (!fromMainWindow(event) &&
        !(settingsWindow !== null && windowFrom(event) === settingsWindow)) ||
      event.senderFrame !== event.sender.mainFrame ||
      typeof url !== "string"
    )
      return;
    browserAuthAttempts.get(url)?.abort();
  });
  ipcMain.handle(
    "desktop.localSettings.request",
    async (event, pathname: unknown, body: unknown) => {
      if (
        !settingsWindow ||
        windowFrom(event) !== settingsWindow ||
        event.senderFrame !== event.sender.mainFrame ||
        !settingsTarget ||
        event.senderFrame.url !== `${settingsTarget.origin}${LOCAL_SETTINGS_PAGE}`
      ) {
        throw new Error("Local settings are not active");
      }
      return requestLocalSettings(settingsTarget, pathname, body, (input, init) =>
        net.fetch(input instanceof URL ? input.href : input, {
          ...init,
          bypassCustomProtocolHandlers: true,
        }),
      );
    },
  );
  installDevices({
    window: () => mainWindow,
    target: () => currentTargetUrl,
    mode: () => currentSetup?.mode,
    stack: localStack,
    listener: remoteListener,
  });
  ipcMain.handle("desktop.platform", () => process.platform);
  ipcMain.handle("desktop.memoryFolders.available", (event) =>
    memoryFolderBridgeAllowed({
      mainWindow: fromMainWindow(event),
      mainFrame: event.senderFrame === event.sender.mainFrame,
      mode: currentSetup?.mode,
      frameUrl: event.senderFrame?.url ?? "",
      localUrl: localStack.webUrl(),
    }),
  );
  let selectingMemoryFolder = false;
  ipcMain.handle("desktop.memoryFolders.select", async (event, spaceId: unknown) => {
    if (
      !memoryFolderBridgeAllowed({
        mainWindow: fromMainWindow(event),
        mainFrame: event.senderFrame === event.sender.mainFrame,
        mode: currentSetup?.mode,
        frameUrl: event.senderFrame?.url ?? "",
        localUrl: localStack.webUrl(),
      }) ||
      typeof spaceId !== "string" ||
      selectingMemoryFolder
    )
      throw new Error("Memory folders require the local desktop stack.");
    selectingMemoryFolder = true;
    try {
      return await registerMemoryFolder(
        spaceId,
        nativeMemoryFolderDependencies(
          stackDir(userDataDir),
          async () => {
            const selected = await dialog.showOpenDialog({
              title: "Choose an empty memory folder",
              properties: ["openDirectory", "createDirectory"],
            });
            return selected.canceled ? null : (selected.filePaths[0] ?? null);
          },
          () => localStack.applyMemoryFolders(),
        ),
      );
    } finally {
      selectingMemoryFolder = false;
    }
  });
  ipcMain.handle("desktop.window.unsaved", (event, dirty: unknown) => {
    const win = fromMainWindow(event) ? mainWindow : null;
    if (
      !win ||
      event.senderFrame !== win.webContents.mainFrame ||
      safeOrigin(event.senderFrame.url) !== safeOrigin(appWindowTargets.get(win) ?? "")
    )
      throw new Error("Window is unavailable here.");
    unsavedFiles.set(win, dirty);
  });
  ipcMain.handle("desktop.window.close", (event) => {
    windowFrom(event)?.close();
  });
  ipcMain.handle("desktop.window.minimize", (event) => {
    windowFrom(event)?.minimize();
  });
  ipcMain.handle("desktop.window.toggleMaximize", (event) => {
    const win = windowFrom(event);
    if (!win) return;
    if (win.isMaximized() || win.isFullScreen()) {
      win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
    } else {
      win.maximize();
    }
  });
  ipcMain.handle("desktop.window.state", (event) => {
    const win = windowFrom(event);
    return {
      minimized: win?.isMinimized() ?? false,
      maximized: win?.isMaximized() ?? false,
      fullScreen: win?.isFullScreen() ?? false,
    };
  });
  ipcMain.handle("desktop.update.state", () => desktopUpdater.state());
  ipcMain.handle("desktop.update.check", (event) =>
    fromMainWindow(event) ? desktopUpdater.check(true) : desktopUpdater.state(),
  );
  ipcMain.handle("desktop.update.download", (event) =>
    fromMainWindow(event) ? desktopUpdater.download() : desktopUpdater.state(),
  );
  ipcMain.handle("desktop.update.install", async (event) => {
    if (!fromMainWindow(event) || desktopUpdater.state().phase !== "ready") {
      return desktopUpdater.state();
    }
    quitting = true;
    const state = await desktopUpdater.install();
    // A failed install stays ready for retry but reports a message. Restore normal
    // window behavior while the user keeps working after that failure.
    if (state.phase !== "ready" || state.message !== null) quitting = false;
    return state;
  });
  ipcMain.handle("desktop.setup.state", (event) => {
    if (!fromSetupWindow(event)) return null;
    return {
      defaultLocalUrl: legacyCompose ? localStack.webUrl() : localMode.origin(),
      saved: currentSetup,
      resume: setupResumesLocal,
      // A local mode failure is already the stack line; show that sentence once.
      error: (setupError !== localMode.state().message && setupError) || undefined,
    };
  });

  ipcMain.handle("desktop.setup.test", async (event, url: unknown) => {
    if (!fromSetupWindow(event)) return { ok: false, error: "Setup is not active." };
    if (typeof url !== "string") return { ok: false, error: "Enter a server address." };
    return probeServer(url);
  });

  ipcMain.handle("desktop.setup.save", async (event, payload: unknown) => {
    if (!fromSetupWindow(event)) return { ok: false, error: "Setup is not active." };
    return saveSetup(payload, userDataDir);
  });

  ipcMain.handle("desktop.setup.quit", (event) => {
    if (fromSetupWindow(event)) app.quit();
  });
  ipcMain.handle("desktop.setup.openLink", async (event, link: unknown) => {
    if (!fromSetupWindow(event) || !isDesktopSetupLink(link)) return;
    await shell.openExternal(DOCKER_INSTALL_LINKS[link]);
  });
  ipcMain.handle("desktop.setup.stack.state", (event) => {
    if (!fromSetupWindow(event)) return null;
    return legacyCompose ? localStack.state() : localMode.state();
  });
  ipcMain.handle("desktop.setup.stack.reset", async (event) => {
    if (!fromSetupWindow(event) || legacyCompose || setupWindow === null) return false;
    // A reset that failed moved nothing; the setup window shows the sentence.
    return confirmLocalReset(setupWindow).catch(localResetFailure);
  });
  ipcMain.handle("desktop.setup.stack.start", (event) => {
    if (!fromSetupWindow(event)) return null;
    // Respond right away; the setup window polls `stack.state` until a terminal phase.
    if (legacyCompose) {
      void localStack.start();
      return localStack.state();
    }
    void localMode.start();
    return localMode.state();
  });

  // Register before startup awaits so macOS dock clicks during probe/open are handled.
  app.on("activate", () => {
    if (setupWindow !== null && !setupWindow.isDestroyed()) {
      setupWindow.show();
      setupWindow.focus();
      return;
    }
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      clearTimeout(warmWindowTimer);
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    if (openAppPromise !== null) return;
    if (currentTargetUrl === null) showSetupWindow(setupError);
    else
      void openApp(currentTargetUrl).then((opened) => {
        if (opened) commitPendingAppSwitch();
      });
  });

  const setMenuBar = (enabled: boolean) => {
    desktopTray = systemTray(desktopTray, enabled, () => {
      app.emit("activate");
    });
  };
  desktopSystem = await installSystemRuntime({
    window: () => mainWindow,
    target: () => currentTargetUrl,
    mode: () => currentSetup?.mode ?? "existing",
    // Local mode keeps its database and files in the app data folder; Compose, in volumes.
    dataFolder: () => (!legacyCompose && currentSetup?.mode === "new" ? userDataDir : null),
    localData: {
      available: () => currentTargetUrl !== null && localModeOwns(currentTargetUrl),
      reset: async () => {
        if (mainWindow === null || mainWindow.isDestroyed()) return false;
        return resetLocalDataAndStart(mainWindow);
      },
    },
    preload: path.join(import.meta.dirname, "preload.cjs"),
    menuBar: setMenuBar,
    routines: async () => {
      if (
        currentSetup?.mode !== "new" ||
        !currentTargetUrl ||
        new URL(currentTargetUrl).origin !== new URL(localStack.webUrl()).origin
      )
        return 0;
      const token = await readStackToken(stackDir(app.getPath("userData")));
      if (!token) return 0;
      return readEnabledRoutines(localStack.webUrl(), token, (url, init) =>
        net.fetch(url instanceof URL ? url.href : url, {
          ...init,
          bypassCustomProtocolHandlers: true,
        }),
      );
    },
    openMain: async () => {
      if (mainWindow === null || mainWindow.isDestroyed()) {
        if (!currentTargetUrl) {
          showSetupWindow();
          return null;
        }
        if (await openApp(currentTargetUrl)) commitPendingAppSwitch();
      }
      clearTimeout(warmWindowTimer);
      mainWindow?.show();
      mainWindow?.focus();
      return mainWindow;
    },
  });
  if (process.platform !== "darwin") setMenuBar(true);

  if (target.kind === "setup") {
    showSetupWindow();
    if (!legacyCompose && process.env.ARDURBOT_FORCE_SETUP !== "1") void localMode.start();
  } else if (target.source === "saved") {
    if (currentSetup?.mode === "new" && !legacyCompose) {
      showSetupWindow(null, { resume: true });
      void localMode.start();
    } else if (currentSetup?.mode === "new") {
      const managedUrl = managedLocalOpenUrl(target.url, localStack.webUrl());
      const managedStackReady =
        managedUrl !== null ? await localStack.matchesDesiredStack() : false;
      if (managedStackReady && managedUrl !== null) {
        if (await openApp(managedUrl)) {
          commitPendingAppSwitch();
          destroySetupWindow();
        }
      } else {
        // Missing, stale, foreign, or owned by another process: reconcile the
        // app-managed stack before any API or computer traffic is allowed.
        void localStack.start();
        showSetupWindow(null, { resume: true });
      }
    } else {
      const reachability = await probeServer(target.url);
      if (reachability.ok) {
        if (await openApp(target.url)) {
          commitPendingAppSwitch();
          destroySetupWindow();
        }
      } else {
        showSetupWindow(`Could not reconnect to the saved server. ${reachability.error}`);
      }
    }
  } else {
    if (await openApp(target.url)) {
      commitPendingAppSwitch();
      destroySetupWindow();
    }
  }
});

// A normal quit has already stopped them; this covers SIGTERM and crashes.
process.once("exit", () => localMode?.signalServicesNow());

app.on("window-all-closed", () => {
  // A hidden session probe (defaultSessionHasOriginData) can be the only window
  // during startup; its teardown must not quit the app.
  if (liveProbeWindows > 0) return;
  if (!staysRunning(process.platform, desktopTray !== null, hostService?.keepRunning)) app.quit();
});

app.on("before-quit", (event) => {
  quitting = true;
  if (mainWindow && unsavedFiles.has(mainWindow)) {
    const discard =
      dialog.showMessageBoxSync(mainWindow, {
        type: "question",
        message: "Unsaved changes",
        buttons: ["Cancel", "Discard"],
        defaultId: 0,
        cancelId: 0,
      }) === 1;
    if (!discard) {
      event.preventDefault();
      quitting = false;
      return;
    }
    unsavedFiles.set(mainWindow, false);
  }
});

/**
 * Every window is closed and the quit is certain by the time this fires: a quit a window's
 * own close cancelled never reaches it, so local mode is never stopped behind a window that
 * is still open and usable.
 */
app.on("will-quit", (event) => {
  if (!legacyCompose && (localShutdown !== null || localMode?.running())) {
    event.preventDefault();
    quitting = false;
    // Cleared once the stop settles, so a later quit stops again if this one is cancelled.
    const settled = () => {
      localShutdown = null;
      app.quit();
    };
    localShutdown ??= localMode.quit().then(settled, settled);
    return;
  }
  hostService?.stop();
  desktopTray?.destroy();
  desktopTray = null;
  clearTimeout(warmWindowTimer);
  // Compose containers keep running; only an in-flight pull/up is cut short.
  // Local mode already stopped its worker, API, and database above.
  void remoteListener.stop();
  localStack?.abort();
});
