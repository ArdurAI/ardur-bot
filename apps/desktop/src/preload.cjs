const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ardurbotDesktop", {
  platform: process.platform,
  system: {
    state: () => ipcRenderer.invoke("desktop.system.state"),
    set: (key, value) => ipcRenderer.invoke("desktop.system.set", key, value),
    moveStorage: (recommended) => ipcRenderer.invoke("desktop.system.moveStorage", recommended),
    openPermission: (permission) => ipcRenderer.invoke("desktop.system.openPermission", permission),
    quickBot: (identity, botId) => ipcRenderer.invoke("desktop.system.quickBot", identity, botId),
    closeQuick: () => ipcRenderer.invoke("desktop.system.closeQuick"),
    openMain: () => ipcRenderer.invoke("desktop.system.openMain"),
    onShortcut: (listener) => {
      const handler = (_event, action) => {
        if (action === "voice" || action === "dictation") listener(action);
      };
      ipcRenderer.on("desktop.system.shortcut", handler);
      void ipcRenderer.invoke("desktop.system.shortcutReady", true).catch(() => undefined);
      return () => {
        ipcRenderer.off("desktop.system.shortcut", handler);
        void ipcRenderer.invoke("desktop.system.shortcutReady", false).catch(() => undefined);
      };
    },
  },
  host: {
    state: () => ipcRenderer.invoke("desktop.host.state"),
    setup: () => ipcRenderer.invoke("desktop.host.setup"),
    addRoot: () => ipcRenderer.invoke("desktop.host.addRoot"),
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
