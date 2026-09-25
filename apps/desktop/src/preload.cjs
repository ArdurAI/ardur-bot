const { contextBridge, ipcRenderer, webUtils } = require("electron");

async function addHostRoot(path) {
  const result = await ipcRenderer.invoke("desktop.host.addRoot", path);
  if (result && typeof result === "object" && typeof result.error === "string")
    throw new Error(result.error);
  return result;
}

contextBridge.exposeInMainWorld("ardurbotDesktop", {
  platform: process.platform,
  customization: {
    info: (...args) => ipcRenderer.invoke("desktop.customization.info", ...args),
    list: (...args) => ipcRenderer.invoke("desktop.customization.list", ...args),
    prepare: (...args) => ipcRenderer.invoke("desktop.customization.prepare", ...args),
    cancel: (...args) => ipcRenderer.invoke("desktop.customization.cancel", ...args),
    install: (...args) => ipcRenderer.invoke("desktop.customization.install", ...args),
    configure: (...args) => ipcRenderer.invoke("desktop.customization.configure", ...args),
    uninstall: (...args) => ipcRenderer.invoke("desktop.customization.uninstall", ...args),
    selectPaths: (...args) => ipcRenderer.invoke("desktop.customization.selectPaths", ...args),
    importSkills: (...args) => ipcRenderer.invoke("desktop.customization.importSkills", ...args),
    addMarketplace: (...args) =>
      ipcRenderer.invoke("desktop.customization.addMarketplace", ...args),
    installPlugin: (...args) => ipcRenderer.invoke("desktop.customization.installPlugin", ...args),
    recoverPlugins: (...args) =>
      ipcRenderer.invoke("desktop.customization.recoverPlugins", ...args),
    uninstallPlugin: (...args) =>
      ipcRenderer.invoke("desktop.customization.uninstallPlugin", ...args),
    applyConfig: (...args) => ipcRenderer.invoke("desktop.customization.applyConfig", ...args),
    prepareDrop: (spaceId, file) =>
      ipcRenderer.invoke(
        "desktop.customization.prepareDrop",
        spaceId,
        webUtils.getPathForFile(file),
      ),
  },

  notifications: {
    supported: () => ipcRenderer.invoke("desktop.notifications.supported"),
    show: (message) => ipcRenderer.invoke("desktop.notifications.show", message),
  },
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
    setKeepRunning: (enabled) => ipcRenderer.invoke("desktop.host.setKeepRunning", enabled),
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
    setUnsavedChanges: (dirty) => ipcRenderer.invoke("desktop.window.unsaved", dirty),
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
  integrations: {
    open: (url) => ipcRenderer.invoke("desktop.integrations.open", url),
    focus: () => ipcRenderer.invoke("desktop.integrations.focus"),
    onReturn: (listener) => {
      const handler = (_event, id) => {
        if (typeof id === "string") listener(id);
      };
      ipcRenderer.on("desktop.integrations.return", handler);
      void ipcRenderer.invoke("desktop.integrations.ready").catch(() => undefined);
      return () => ipcRenderer.off("desktop.integrations.return", handler);
    },
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
