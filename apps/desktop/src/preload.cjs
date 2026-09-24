const { contextBridge, ipcRenderer, webUtils } = require("electron");

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
