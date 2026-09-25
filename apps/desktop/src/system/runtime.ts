import type { BrowserWindow, IpcMainInvokeEvent, Session } from "electron";
import { app, ipcMain, shell } from "electron";
import type { ShortcutAction } from "./contract.js";
import type { SystemDependencies } from "./controller.js";
import { installDesktopSystem, systemSenderAllowed } from "./install.js";
import { QuickAccessStore, quickIdentity } from "./quick-access.js";
import { createQuickAccessWindow, openLinkViewer } from "./windows.js";

export async function installSystemRuntime(
  options: Pick<SystemDependencies, "mode" | "dataFolder" | "routines" | "menuBar"> & {
    window(): BrowserWindow | null;
    target(): string | null;
    openMain(): Promise<BrowserWindow | null>;
    preload: string;
  },
) {
  let quick: BrowserWindow | null = null;
  let lastSession: { target: string; session: Session } | null = null;
  let openingQuick = false;
  const ready = new WeakSet<BrowserWindow>();
  const windowTargets = new WeakMap<BrowserWindow, string>();
  let disposed = false;
  let pending: ShortcutAction | null = null;
  const store = new QuickAccessStore(app.getPath("userData"));
  async function invoke(action: ShortcutAction) {
    if (disposed) return;
    if (action === "quickAccess") {
      if (openingQuick) return;
      if (quick && !quick.isDestroyed()) {
        quick.show();
        quick.focus();
        return;
      }
      openingQuick = true;
      try {
        const target = options.target();
        if (!target) {
          await options.openMain();
          return;
        }
        let session = lastSession?.target === target ? lastSession.session : null;
        if (!session) {
          const window = await options.openMain();
          if (window && windowTargets.get(window) === target) session = window.webContents.session;
        }
        if (disposed || !session || options.target() !== target) return;
        const created = createQuickAccessWindow({
          rendererUrl: new URL("/desktop/quick-access", target).href,
          targetUrl: target,
          session,
          preload: options.preload,
        });
        quick = created;
        created.once("closed", () => {
          if (quick === created) quick = null;
        });
      } finally {
        openingQuick = false;
      }
      return;
    }
    const window = action === "voice" ? await options.openMain() : options.window();
    if (disposed || !window || window.isDestroyed()) return;
    if (ready.has(window)) window.webContents.send("desktop.system.shortcut", action);
    else pending = action;
  }
  const installed = await installDesktopSystem({
    ...options,
    shortcut: (action) => {
      void invoke(action).catch(() => undefined);
    },
  });
  function requireQuick(event: IpcMainInvokeEvent) {
    if (
      !systemSenderAllowed(event, quick, options.target()) ||
      new URL(event.senderFrame!.url).pathname !== "/desktop/quick-access"
    )
      throw new Error("Open quick access in the desktop app.");
    return new URL(options.target()!).origin;
  }
  ipcMain.handle("desktop.system.shortcutReady", (event, listening: unknown) => {
    const window = options.window();
    if (!window || !systemSenderAllowed(event, window, windowTargets.get(window) ?? null)) return;
    if (listening === true) {
      ready.add(window);
      if (pending) {
        window.webContents.send("desktop.system.shortcut", pending);
        pending = null;
      }
    } else ready.delete(window);
  });
  ipcMain.handle("desktop.system.quickBot", async (event, identity: unknown, botId?: unknown) => {
    const origin = requireQuick(event),
      who = quickIdentity(identity);
    if (botId !== undefined) await store.set(origin, who, botId);
    return store.get(origin, who);
  });
  ipcMain.handle("desktop.system.closeQuick", (event) => {
    requireQuick(event);
    quick?.close();
  });
  ipcMain.handle("desktop.system.openMain", async (event) => {
    requireQuick(event);
    quick?.close();
    await options.openMain();
  });
  app.once("will-quit", () => {
    disposed = true;
    pending = null;
    quick?.destroy();
    for (const name of ["shortcutReady", "quickBot", "closeQuick", "openMain"])
      ipcMain.removeHandler(`desktop.system.${name}`);
  });
  return {
    controller: installed.controller,
    attachWindow(window: BrowserWindow, target: string) {
      windowTargets.set(window, target);
      if (lastSession?.target !== target) {
        const previous = quick;
        quick = null;
        previous?.close();
        pending = null;
      }
      lastSession = { target, session: window.webContents.session };
      window.webContents.on("did-start-navigation", (event) => {
        if (event.isMainFrame && !event.isSameDocument) ready.delete(window);
      });
      window.webContents.on("render-process-gone", () => ready.delete(window));
      window.on("hide", () => {
        pending = null;
      });
      window.webContents.on("before-input-event", (event, input) => {
        if (window === options.window() && installed.controller.shortcuts.handleInput(input))
          event.preventDefault();
      });
    },
    openLink(url: string) {
      if (installed.controller.openLinksInBrowser) openLinkViewer(url);
      else void shell.openExternal(url);
    },
  };
}
