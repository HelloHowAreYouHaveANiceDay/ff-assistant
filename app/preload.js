// Safe bridge from the renderer to the ff engine (contextIsolation on). The renderer never touches
// Node directly; it calls window.mc.* which the main process fulfils.
//
// WP14 (2026-09-16): 36 APIs -> 16 (12 invoke + 4 push). Six were invoked by NOTHING and nine only by renderer code that
// had become unreachable (docs/ui-audit-2026-09-16.md 2.4). The rest went with the pages the minimal
// UI cut -- every one of them had an `ff` verb or an MCP tool behind it, which is the whole point of
// D26: Claude Code is the control surface, this window is the login/bridge/board cockpit.
//
// EVERY CHANNEL HERE MUST HAVE A HANDLER IN main.js AND BE INVOKED BY THE RENDERER. Both directions
// are asserted mechanically by test/app-ipc-map.test.ts -- the audit built that map by hand once, and
// a hand-built map is a snapshot of the day it was written.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mc", {
  // live board + config, read from the SQLite store by the ff engine
  appData: () => ipcRenderer.invoke("mc:appData"),
  // whose board is on screen: {builtAt, players, season, stamp:{leagueId, scoringKey, ...}}
  boardStamp: () => ipcRenderer.invoke("mc:boardStamp"),
  // onboarding/status readout: config + league row + player count
  leagueInfo: () => ipcRenderer.invoke("mc:leagueInfo"),
  // multi-league: list all known leagues (+ which is active) and switch the active one
  leagueList: () => ipcRenderer.invoke("mc:leagueList"),
  leagueSetActive: (leagueId) => ipcRenderer.invoke("mc:leagueSetActive", leagueId),
  // the derived lineage graph (src/lineage/dag.ts) -- Status reads its freshness, not its topology
  lineage: () => ipcRenderer.invoke("mc:lineage"),
  // the model registry + the model page's serve table and scorecard (src/lineage/modelPage.ts)
  modelGraph: () => ipcRenderer.invoke("mc:modelGraph"),
  modelPage: () => ipcRenderer.invoke("mc:modelPage"),
  // per-league ownership overlay for the board (who owns each player)
  ownership: () => ipcRenderer.invoke("mc:ownership"),
  // the in-season scheduler's config + LAST TICK. Read-only: the copilot changes the schedule through
  // the engine (`ff schedule`), and the app's job is to make a failing tick visible -- it ran red for
  // days behind a renderer that never called this (audit 3.7).
  scheduleGet: () => ipcRenderer.invoke("mc:scheduleGet"),
  onSchedulerTick: (cb) => ipcRenderer.on("mc:schedulerTick", (_e, data) => cb(data)),
  // the loopback bridge + CDP port + store path, so Status can say what Claude Code will talk to.
  // Deliberately WITHOUT the bridge token: the renderer has no business holding it.
  bridgeInfo: () => ipcRenderer.invoke("mc:bridgeInfo"),
  // Pushed by main after any engine invocation whose board/lineage/model stamp differs from the last
  // one seen. Carries the stamp itself so the renderer decides, rather than trusting "something
  // happened" (app/main.js's ffRun + rpc chokepoints).
  onBoardChanged: (cb) => ipcRenderer.on("mc:boardChanged", (_e, data) => cb(data)),
  onLineageChanged: (cb) => ipcRenderer.on("mc:lineageChanged", (_e, data) => cb(data)),
  onModelsChanged: (cb) => ipcRenderer.on("mc:modelsChanged", (_e, data) => cb(data)),
  openExternal: (url) => ipcRenderer.invoke("mc:openExternal", url),
});
