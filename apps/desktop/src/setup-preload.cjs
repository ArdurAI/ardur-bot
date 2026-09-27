const { contextBridge, ipcRenderer } = require("electron");

const guidedSetup = process.argv?.includes("--ardurbot-guided-setup")
  ? {
      snapshot: () => ipcRenderer.invoke("desktop.guidedSetup.snapshot"),
      start: () => ipcRenderer.invoke("desktop.guidedSetup.start"),
      retry: (stepId) => ipcRenderer.invoke("desktop.guidedSetup.retry", stepId),
      skip: (stepId) => ipcRenderer.invoke("desktop.guidedSetup.skip", stepId),
      cancel: () => ipcRenderer.invoke("desktop.guidedSetup.cancel"),
      resume: () => ipcRenderer.invoke("desktop.guidedSetup.resume"),
      onChange: (listener) => {
        const handler = (_event, snapshot) => listener(snapshot);
        ipcRenderer.on("desktop.guidedSetup.changed", handler);
        return () => ipcRenderer.removeListener("desktop.guidedSetup.changed", handler);
      },
    }
  : undefined;

contextBridge.exposeInMainWorld("ardurbotSetup", {
  ...(guidedSetup ? { guidedSetup } : {}),
  platform: process.platform,
  state: () => ipcRenderer.invoke("desktop.setup.state"),
  test: (url) => ipcRenderer.invoke("desktop.setup.test", url),
  save: (setup) => ipcRenderer.invoke("desktop.setup.save", setup),
  quit: () => ipcRenderer.invoke("desktop.setup.quit"),
  openLink: (link) => ipcRenderer.invoke("desktop.setup.openLink", link),
  stack: {
    state: () => ipcRenderer.invoke("desktop.setup.stack.state"),
    start: () => ipcRenderer.invoke("desktop.setup.stack.start"),
    reset: () => ipcRenderer.invoke("desktop.setup.stack.reset"),
    onChange: (listener) => {
      ipcRenderer.on("desktop.setup.stack.changed", (_event, state) => listener(state));
    },
  },
});
