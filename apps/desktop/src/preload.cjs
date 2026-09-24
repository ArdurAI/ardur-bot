const { contextBridge, ipcRenderer, webUtils } = require("electron");

async function addHostRoot(path) {
  const result = await ipcRenderer.invoke("desktop.host.addRoot", path);
  if (result && typeof result === "object" && typeof result.error === "string")
    throw new Error(result.error);
  return result;
}

contextBridge.exposeInMainWorld("ardurbotDesktop", {
  platform: process.platform,
  host: {
    state: () => ipcRenderer.invoke("desktop.host.state"),
    setup: () => ipcRenderer.invoke("desktop.host.setup"),
    addRoot: () => addHostRoot(),
    addDroppedRoot: (file) => {
      const path = webUtils.getPathForFile(file);
      if (!path) return Promise.resolve(null);
      return addHostRoot(path);
    },
    removeRoot: (root) => ipcRenderer.invoke("desktop.host.removeRoot", root),
    clear: () => ipcRenderer.invoke("desktop.host.clear"),
  },
  devices: {
    state: () => ipcRenderer.invoke("desktop.devices.state"),
    setEnabled: (enabled) => ipcRenderer.invoke("desktop.devices.setEnabled", enabled),
  },
  memoryFolders: {
    available: () => ipcRenderer.invoke("desktop.memoryFolders.available"),
    select: (spaceId) => ipcRenderer.invoke("desktop.memoryFolders.select", spaceId),
  },
  localSettings: {
    request: (pathname, body) =>
      ipcRenderer.invoke("desktop.localSettings.request", pathname, body),
  },
  window: {
    close: () => ipcRenderer.invoke("desktop.window.close"),
    minimize: () => ipcRenderer.invoke("desktop.window.minimize"),
    toggleMaximize: () => ipcRenderer.invoke("desktop.window.toggleMaximize"),
    state: () => ipcRenderer.invoke("desktop.window.state"),
  },
  update: {
    state: () => ipcRenderer.invoke("desktop.update.state"),
    check: () => ipcRenderer.invoke("desktop.update.check"),
    download: () => ipcRenderer.invoke("desktop.update.download"),
    install: () => ipcRenderer.invoke("desktop.update.install"),
  },
  oauth: {
    open: (url) => ipcRenderer.invoke("desktop.oauth.open", url),
    cancel: (url) => ipcRenderer.invoke("desktop.oauth.cancel", url),
    onCallback: (listener) => {
      // The IpcRendererEvent stays in the preload: the renderer only sees the code.
      const handler = (_event, callback) => listener(callback);
      ipcRenderer.on("desktop.oauth.callback", handler);
      return () => ipcRenderer.off("desktop.oauth.callback", handler);
    },
  },
});
