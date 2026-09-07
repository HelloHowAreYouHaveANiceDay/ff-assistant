// Safe bridge from the renderer to the ff engine (contextIsolation on). The renderer never touches
// Node directly; it calls window.mc.* which the main process fulfils.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mc", {
  // live draft state: the newest data/draft-log-*.json the `ff auto-draft` engine writes (or null)
  draftState: () => ipcRenderer.invoke("mc:draftState"),
  // the agent's per-tick decision (on-block, recommended max bid + reason, our roster/budget)
  liveState: () => ipcRenderer.invoke("mc:liveState"),
  // agent control
  agentStatus: () => ipcRenderer.invoke("mc:agentStatus"),
  agentStart: (mode) => ipcRenderer.invoke("mc:agentStart", mode),
  agentStop: () => ipcRenderer.invoke("mc:agentStop"),
  pause: (on) => ipcRenderer.invoke("mc:pause", on),
  isPaused: () => ipcRenderer.invoke("mc:isPaused"),
  // live board + news + config, read from the SQLite store by the ff engine (replaces data.js)
  appData: () => ipcRenderer.invoke("mc:appData"),
  // Copilot auth (subscription via the `claude` login): status check + best-effort login trigger
  authStatus: () => ipcRenderer.invoke("mc:authStatus"),
  authLogin: () => ipcRenderer.invoke("mc:authLogin"),
  // Copilot: ask the real Agent SDK session; agentAsk resolves when the turn ends, onAgentEvent
  // streams its turns ({t:"text"|"tool"|"done", ...}) as they arrive.
  agentAsk: (message) => ipcRenderer.invoke("mc:agentAsk", message),
  onAgentEvent: (cb) => ipcRenderer.on("mc:agentEvent", (_e, data) => cb(data)),
  // Pushed by main after any engine invocation whose board stamp differs from the last one seen.
  // Carries the stamp itself so the renderer decides, rather than trusting "something happened".
  onBoardChanged: (cb) => ipcRenderer.on("mc:boardChanged", (_e, data) => cb(data)),
  // the drafted team lives in SQLite (my_roster) now -- read/write via the helper (source of truth)
  teamSet: (team) => ipcRenderer.invoke("mc:teamSet", team),
  teamGet: () => ipcRenderer.invoke("mc:teamGet"),
  // onboarding: synced-league status (config + league row + player count), and a one-shot league sync
  leagueInfo: () => ipcRenderer.invoke("mc:leagueInfo"),
  dataSources: () => ipcRenderer.invoke("mc:dataSources"),
  ingestSource: (id) => ipcRenderer.invoke("mc:ingestSource", id),
  // per-league ownership overlay for the board (who owns each player) + a roster resync
  ownership: () => ipcRenderer.invoke("mc:ownership"),
  syncRosters: () => ipcRenderer.invoke("mc:syncRosters"),
  syncLeague: () => ipcRenderer.invoke("mc:syncLeague"),
  // tuning levers: clamped write of a partial {key:value} patch, returns the new levers
  setLevers: (patch) => ipcRenderer.invoke("mc:setLevers", patch),
  // rebuild the values/report + embedded data (renderer reloads on success)
  refreshData: () => ipcRenderer.invoke("mc:refreshData"),
  // push the board to a Google Sheet via bim-cli (id/url optional)
  pushSheet: (id) => ipcRenderer.invoke("mc:pushSheet", id),
  openExternal: (url) => ipcRenderer.invoke("mc:openExternal", url),
});
