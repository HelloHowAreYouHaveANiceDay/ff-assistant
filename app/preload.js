// Safe bridge from the renderer to the ff engine (contextIsolation on). The renderer never touches
// Node directly; it calls window.mc.* which the main process fulfils.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mc", {
  // live draft state: the newest data/draft-log-*.json the `ff auto-draft` engine writes (or null)
  draftState: () => ipcRenderer.invoke("mc:draftState"),
  // rebuild the values/report + embedded data (renderer reloads on success)
  refreshData: () => ipcRenderer.invoke("mc:refreshData"),
  // push the board to a Google Sheet via bim-cli (id/url optional)
  pushSheet: (id) => ipcRenderer.invoke("mc:pushSheet", id),
  openExternal: (url) => ipcRenderer.invoke("mc:openExternal", url),
});
