import path from "node:path";
import { DESKTOP_FOLDER_ERRORS } from "@ardurbot/contracts/desktop-errors";
import type { BrowserWindow, IpcMainInvokeEvent, Tray } from "electron";
import { app, dialog, ipcMain, safeStorage } from "electron";
import {
  HostLifecyclePreferences,
  HostServiceStore,
  HostServiceSupervisor,
  hostServiceIdentity,
  hostServiceLaunch,
  hostStorageAvailable,
  selectedHostRoot,
} from "./host-service.js";
import type { LocalFolders } from "./local-folders.js";
import { updateHostTray } from "./tray.js";

export function installHostService(options: {
  window(): BrowserWindow | null;
  target(): string | null;
  tray(): Tray | null;
  /** Local mode keeps its own folders; a pairing with another server never applies to it. */
  local: { owns(target: string): boolean; folders: LocalFolders };
}) {
  const directory = path.join(app.getPath("userData"), "host-service");
  const store = new HostServiceStore(directory, safeStorage);
  const lifecycle = new HostLifecyclePreferences(path.join(directory, "lifecycle.json"));
  const ready = lifecycle.load();
  const supervisor = new HostServiceSupervisor(
    hostServiceLaunch({
      packaged: app.isPackaged,
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
    (connected) => updateHostTray(options.tray(), connected),
  );
  let tail = Promise.resolve();
  function trusted(event: IpcMainInvokeEvent) {
    const window = options.window(),
      target = options.target();
    if (
      !window ||
      !target ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== new URL(target).origin
    )
      throw new Error("Host service is unavailable here.");
    return { window, target };
  }
  function register(
    name: string,
    action: (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>,
  ) {
    ipcMain.handle(`desktop.host.${name}`, (event, value: unknown) => {
      const result = tail.then(async () => {
        await ready;
        return action(event, value);
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      if (name !== "addRoot") return result;
      return result.catch((error: unknown) => {
        console.error("Could not add folder.", error);
        const message = error instanceof Error ? error.message : "";
        return {
          error: DESKTOP_FOLDER_ERRORS.some((known) => known === message)
            ? message
            : "Could not add folder. Try again.",
        };
      });
    });
  }
  register("state", async (event) => {
    const { target } = trusted(event);
    if (options.local.owns(target)) {
      return {
        configured: false,
        local: true,
        roots: await options.local.folders.list(),
        keepRunning: lifecycle.keepRunning,
      };
    }
    const config = await store.read();
    return {
      configured: config?.apiUrl === target,
      registrationId: config?.apiUrl === target ? hostServiceIdentity(config) : undefined,
      roots: config?.apiUrl === target ? config.hostRoots : [],
      keepRunning: lifecycle.keepRunning,
    };
  });
  register("setKeepRunning", async (event, value) => {
    trusted(event);
    if (typeof value !== "boolean") throw new Error("Choose whether to keep working.");
    await lifecycle.setKeepRunning(value);
  });
  register("setup", async (event) => {
    const { window, target } = trusted(event);
    if (options.local.owns(target)) throw new Error("Host service is unavailable here.");
    if (
      new URL(target).protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(target).hostname)
    )
      throw new Error("Connect through HTTPS first.");
    if (!hostStorageAvailable(safeStorage))
      throw new Error("Unlock secure storage, then try again.");
    const existing = await store.read();
    const response = await window.webContents.session.fetch(
      new URL("/api/host-bridge/pair", target).toString(),
      { method: "POST", credentials: "include", redirect: "error" },
    );
    if (response.status === 409 && existing?.apiUrl === target) {
      supervisor.start(existing);
      return;
    }
    if (!response.ok) throw new Error("Disconnect the existing computer, then try again.");
    const result: unknown = await response.json();
    if (
      !result ||
      typeof result !== "object" ||
      !("token" in result) ||
      typeof result.token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(result.token)
    )
      throw new Error("Could not connect this computer.");
    const config = {
      apiUrl: target,
      token: result.token,
      root: path.join(directory, "workspaces"),
      hostRoots: [],
    };
    await store.write(config);
    supervisor.start(config);
  });
  async function pickFolder(window: BrowserWindow, value: unknown) {
    const selected = await dialog.showOpenDialog(window, {
      properties: ["openDirectory"],
      ...(typeof value === "string" && path.isAbsolute(value) ? { defaultPath: value } : {}),
    });
    if (selected.canceled || !selected.filePaths[0]) return null;
    return selectedHostRoot(selected.filePaths[0]);
  }
  register("addRoot", async (event, value) => {
    const { window, target } = trusted(event);
    if (options.local.owns(target)) {
      const root = await pickFolder(window, value);
      if (root !== null) await options.local.folders.add(root);
      return root;
    }
    const config = await store.read();
    if (!config || config.apiUrl !== target) throw new Error("Set up this computer first.");
    const root = await pickFolder(window, value);
    if (root === null) return null;
    config.hostRoots = [...new Set([...config.hostRoots, root])];
    if (config.hostRoots.length > 32) throw new Error("Remove a folder before adding another.");
    await store.write(config);
    supervisor.start(config);
    return root;
  });
  register("removeRoot", async (event, value) => {
    const { target } = trusted(event);
    if (options.local.owns(target)) {
      if (typeof value !== "string") throw new Error("Folder unavailable.");
      await options.local.folders.remove(value);
      return;
    }
    const config = await store.read();
    if (!config || config.apiUrl !== target || typeof value !== "string")
      throw new Error("Folder unavailable.");
    config.hostRoots = config.hostRoots.filter((root) => root !== value);
    await store.write(config);
    supervisor.start(config);
  });
  register("clear", async (event) => {
    trusted(event);
    supervisor.stop();
    await store.clear();
  });
  return {
    get keepRunning() {
      return lifecycle.keepRunning;
    },
    windowClosed() {
      if (!lifecycle.keepRunning) supervisor.stop();
    },
    async activate(target: string) {
      await ready;
      const config = options.local.owns(target) ? null : await store.read();
      if (config?.apiUrl === target) supervisor.start(config);
      else supervisor.stop();
    },
    stop() {
      supervisor.stop();
    },
  };
}
