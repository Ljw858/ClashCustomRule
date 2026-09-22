const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("subscriptionApp", {
  loadState: () => ipcRenderer.invoke("state:load"),
  getSavedToken: () => ipcRenderer.invoke("token:get"),
  saveToken: (payload) => ipcRenderer.invoke("token:save", payload),
  saveState: (state) => ipcRenderer.invoke("state:save", state),
  syncGithub: (state) => ipcRenderer.invoke("github:sync", state),
  runWorkflow: (state) => ipcRenderer.invoke("github:run-workflow", state),
  syncAndRun: (state) => ipcRenderer.invoke("github:sync-and-run", state),
  openExternal: (url) => ipcRenderer.invoke("shell:open", url),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  checkUpdate: () => ipcRenderer.invoke("app:check-update"),
  downloadUpdate: () => ipcRenderer.invoke("app:download-update"),
  installUpdate: () => ipcRenderer.invoke("app:install-update"),
  getWindowState: () => ipcRenderer.invoke("window:get-state"),
  onWindowStateChange: (callback) => {
    ipcRenderer.removeAllListeners("window:state-changed");
    ipcRenderer.on("window:state-changed", (_event, state) => callback(state));
  },
  onUpdaterEvent: (callback) => {
    ipcRenderer.removeAllListeners("updater:event");
    ipcRenderer.on("updater:event", (_event, ...args) => callback(...args));
  }
});
