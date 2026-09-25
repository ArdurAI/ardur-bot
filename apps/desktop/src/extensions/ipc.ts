import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { app, dialog, ipcMain, safeStorage } from "electron";
import type { BundleFile } from "./files.js";
import { BUNDLE_MAX_BYTES, readBundleFolder, validateBundleFiles } from "./files.js";
import { NativePluginStore } from "./plugin-store.js";
import { ExtensionStore } from "./store.js";
import { readBundleZip } from "./zip.js";

type Request = (procedure: string, input?: unknown) => Promise<unknown>;
const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(value))
    throw new Error("Choose an item from this space.");
  return value;
};
function upload(files: BundleFile[]) {
  const result = files.map((file) => ({
    path: file.path,
    content: Buffer.from(file.bytes).toString("base64"),
    executable: file.executable,
  }));
  if (JSON.stringify(result).length > 12_000_000)
    throw new Error("Choose a folder smaller than 9 MB.");
  return result;
}
async function archive(filename: unknown) {
  if (
    typeof filename !== "string" ||
    !path.isAbsolute(filename) ||
    !/\.(mcpb|dxt)$/i.test(filename)
  )
    throw new Error("Choose an MCPB or DXT file.");
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > BUNDLE_MAX_BYTES) throw new Error("The bundle is too large.");
    return readBundleZip(await handle.readFile());
  } finally {
    await handle.close();
  }
}
export function installCustomizationIpc(options: {
  window(): BrowserWindow | null;
  target(): string | null;
}) {
  const stores = new Map<string, { extensions: ExtensionStore; plugins: NativePluginStore }>();
  let tail: Promise<unknown> = Promise.resolve();
  let currentWindowId: number | undefined;
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
      throw new Error("Customization is unavailable here.");
    return { window, target };
  }
  async function scoped(event: IpcMainInvokeEvent, spaceId: unknown) {
    const { window, target } = trusted(event);
    if (currentWindowId !== window.webContents.id) {
      stores.clear();
      currentWindowId = window.webContents.id;
    }
    if (spaceId !== null && spaceId !== undefined) identifier(spaceId);
    const request: Request = async (procedure, input) => {
      // Callers below supply fixed procedures; renderer input never selects a URL or method.
      const response = await window.webContents.session.fetch(
        new URL(`/rpc/${procedure}`, target).href,
        {
          method: "POST",
          credentials: "include",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            ...(spaceId ? { "x-ardurbot-space-id": String(spaceId) } : {}),
          },
          body: JSON.stringify({ json: input }),
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (!response.ok) throw new Error("The request failed. Check the connection and try again.");
      if (!response.body) throw new Error("The response is empty.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 16 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("The response is too large.");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return value.json;
    };
    const identity = (await request("extensions/context")) as { userId: string; spaceId: string };
    identifier(identity.userId);
    identifier(identity.spaceId);
    const key = createHash("sha256")
      .update(`${new URL(target).origin}\0${identity.userId}\0${identity.spaceId}`)
      .digest("hex");
    let store = stores.get(key);
    if (!store) {
      const directory = path.join(app.getPath("userData"), "extensions", key);
      const placement = app.isPackaged ? "host" : "worker";
      const extensions = new ExtensionStore(
        directory,
        safeStorage,
        {
          upsert: async (entry) => {
            await request("extensions/register", {
              managedId: entry.id,
              managedBy: "extension",
              secretValues: entry.secretValues,
              name: entry.name,
              description: entry.description,
              placement,
              ...entry.launch,
            });
          },
          remove: async (id) => {
            await request("extensions/remove", { managedId: id, managedBy: "extension" });
          },
        },
        {
          HOME: app.getPath("home"),
          DESKTOP: app.getPath("desktop"),
          DOCUMENTS: app.getPath("documents"),
          DOWNLOADS: app.getPath("downloads"),
        },
      );
      const plugins = new NativePluginStore(path.join(directory, "plugins"), safeStorage, {
        files: async (previewId) => {
          const data = await request("plugins/files", { previewId });
          if (!Array.isArray(data) || data.length > 1000)
            throw new Error("The plugin files are invalid.");
          const files = data.map((file) => ({
            path: String(file.path),
            bytes: Buffer.from(String(file.content), "base64"),
            executable: file.executable === true,
          }));
          validateBundleFiles(files);
          return files;
        },
        install: async (previewId, nativeRoot, installationId) => {
          await request("plugins/install", { previewId, nativeRoot, installationId, placement });
        },
        uninstall: async (id) => {
          await request("plugins/uninstall", { id });
        },
        installed: async () => {
          const data = (await request("plugins/list")) as {
            installs: { id: string; state: "installing" | "installed" | "removing" }[];
          };
          return data.installs;
        },
      });
      store = { extensions, plugins };
      await extensions.recover();
      await plugins.recover();
      if (stores.size >= 10) stores.delete(stores.keys().next().value!);
      stores.set(key, store);
    }
    return { ...store, request, window };
  }
  function register(
    name: string,
    action: (event: IpcMainInvokeEvent, args: unknown[]) => Promise<unknown>,
  ) {
    ipcMain.handle(`desktop.customization.${name}`, (event, ...args: unknown[]) => {
      const result = tail.then(() => {
        trusted(event);
        return action(event, args);
      });
      tail = result.catch(() => undefined);
      return result;
    });
  }
  register("info", async () => ({ packaged: app.isPackaged }));
  register("list", async (event, [spaceId]) => (await scoped(event, spaceId)).extensions.list());
  register("prepare", async (event, [spaceId]) => {
    const store = await scoped(event, spaceId);
    const selected = await dialog.showOpenDialog(store.window, {
      properties: ["openFile"],
      filters: [{ name: "MCP extensions", extensions: ["mcpb", "dxt"] }],
    });
    return selected.canceled || !selected.filePaths[0]
      ? null
      : store.extensions.prepare(await archive(selected.filePaths[0]));
  });
  register("prepareDrop", async (event, [spaceId, filename]) =>
    (await scoped(event, spaceId)).extensions.prepare(await archive(filename)),
  );
  register("cancel", async (event, [spaceId, id]) =>
    (await scoped(event, spaceId)).extensions.cancel(identifier(id)),
  );
  register("install", async (event, [spaceId, id, values]) =>
    (await scoped(event, spaceId)).extensions.install(identifier(id), values),
  );
  register("configure", async (event, [spaceId, id, values]) =>
    (await scoped(event, spaceId)).extensions.configure(identifier(id), values),
  );
  register("uninstall", async (event, [spaceId, id]) =>
    (await scoped(event, spaceId)).extensions.uninstall(identifier(id)),
  );
  register("selectPaths", async (event, [kind, multiple]) => {
    const { window } = trusted(event);
    if ((kind !== "file" && kind !== "directory") || typeof multiple !== "boolean")
      throw new Error("Choose a configuration field.");
    const selected = await dialog.showOpenDialog(window, {
      properties: [
        kind === "directory" ? "openDirectory" : "openFile",
        ...(multiple ? ["multiSelections" as const] : []),
      ],
    });
    return selected.canceled ? null : selected.filePaths;
  });
  for (const [name, procedure] of [
    ["importSkills", "customizationSkills/import"],
    ["addMarketplace", "plugins/addMarketplace"],
  ] as const)
    register(name, async (event, [spaceId]) => {
      const { window, request } = await scoped(event, spaceId);
      const selected = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
      if (!selected.canceled && selected.filePaths[0])
        await request(procedure, { files: upload(await readBundleFolder(selected.filePaths[0])) });
    });
  register("installPlugin", async (event, [spaceId, id]) =>
    (await scoped(event, spaceId)).plugins.install(identifier(id)),
  );
  register("recoverPlugins", async (event, [spaceId]) =>
    (await scoped(event, spaceId)).plugins.recover(),
  );
  register("uninstallPlugin", async (event, [spaceId, id]) =>
    (await scoped(event, spaceId)).plugins.uninstall(identifier(id)),
  );
  register("applyConfig", async (event, [spaceId, id]) => {
    await (await scoped(event, spaceId)).request("developer/apply", {
      previewId: identifier(id),
      placement: app.isPackaged ? "host" : "worker",
    });
  });
}
