// Electron main process for Fantasy Mission Control. Window + IPC to the ff engine (draft-log,
// data refresh, sheet push). Renderer is sandboxed (contextIsolation, no nodeIntegration).
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");

const REPO = path.join(__dirname, "..");
let win = null;

// CDP endpoint so the ff engine can attach to the embedded ESPN webview (the role bro plays today).
// Must be set before app is ready. Default on (loopback 9223) since driving the embedded browser is
// a core feature; opt out with MC_NO_CDP. It lets local processes control the app on 127.0.0.1.
const CDP_PORT = process.env.MC_NO_CDP ? null : (process.env.MC_CDP_PORT || "9223");
if (CDP_PORT) app.commandLine.appendSwitch("remote-debugging-port", CDP_PORT);

// Run an `ff` subcommand: dev = npm+tsx; packaged = the BUNDLED node.exe running the compiled engine
// bundle (resources/engine/ff.cjs) against its own resources/engine/node_modules (so better-sqlite3
// loads under node's ABI, which its prebuilt matches). The store lives in a writable userData copy.
const NODE_BIN = path.join(process.resourcesPath || "", "runtime", "node.exe");
const ENGINE_JS = path.join(process.resourcesPath || "", "engine", "ff.cjs");
const DB_PATH = app.isPackaged ? path.join(app.getPath("userData"), "ff.db") : path.join(REPO, "data", "ff.db");
// Where the engine writes its runtime files (live-state.json, draft-log-*, PAUSE). Matches FF_DATA
// passed to the engine (userData when packaged -- the install dir isn't writable; REPO/data in dev).
const DATA_DIR = app.isPackaged ? app.getPath("userData") : path.join(REPO, "data");
function ensureDb() {
  // A shipped build carries NO personal database -- a fresh install starts EMPTY and the user onboards
  // (Setup: log into ESPN -> Sync league -> Build board). The engine's openDb creates the schema +
  // default config on first open, so we only need the directory to exist.
  if (app.isPackaged) { try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (_) { /* created on open */ } }
}
// True until the user has synced a league AND built a board (used to show the Setup/onboarding flow).
async function isOnboarded() {
  try { const ad = await rpc("app-data"); return !!(ad && ad.players && ad.players.length > 0); } catch (_) { return false; }
}
function ffSpawn(args, opts = {}) {
  // packaged: NODE_PATH points at the engine's bundled deps (copied as "deps" since electron-builder
  // won't ship a folder literally named node_modules via extraResources)
  return app.isPackaged
    ? cp.spawn(NODE_BIN, [ENGINE_JS, ...args], { env: { ...process.env, FF_DB: DB_PATH, FF_DATA: app.getPath("userData"), NODE_PATH: path.join(process.resourcesPath, "engine", "deps") }, ...opts })
    : cp.spawn("npm", ["--silent", "run", "ff", "--", ...args], { cwd: REPO, shell: true, ...opts });
}
function ffRun(args) {
  return new Promise((res) => {
    const p = ffSpawn(args); let out = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", (c) => res({ ok: c === 0, out: out.slice(-1800) }));
    p.on("error", (e) => res({ ok: false, out: String(e) }));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 680,
    title: "Fantasy Mission Control",
    backgroundColor: "#fafafa",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      webviewTag: true, // the embedded ESPN <webview> in the Live Draft view
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: "deny" }; }
    return { action: "allow" };
  });
  if (process.env.MC_AGENT_PROBE) {
    // Drive the Copilot through a REAL agent turn end-to-end (renderer -> IPC -> ff agent-ask -> SDK).
    win.webContents.on("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, 3000));
      const res = await win.webContents.executeJavaScript(
        "(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));" +
        "document.querySelector('.nv[data-view=\"copilot\"]').click();await sleep(300);" +
        "document.getElementById('cop-q').value='Give me the single best WR value in one line.';document.getElementById('cop-send').click();" +
        "for(let i=0;i<75;i++){await sleep(1000);const b=[...document.querySelectorAll('.cmsg.casst')].pop();if(b&&!b.textContent.includes('thinking')&&b.querySelector('.ctext'))break;}" +
        "const b=[...document.querySelectorAll('.cmsg.casst')].pop();" +
        "return{chips:[...b.querySelectorAll('.chip')].map(c=>c.textContent.trim()),text:[...b.querySelectorAll('.ctext')].map(c=>c.textContent.trim()).join(' | ').slice(0,240),err:window.__err||null};})()");
      console.error("AGENTPROBE " + JSON.stringify(res));
      app.quit();
    });
    return;
  }
  if (process.env.MC_CDP_PROBE) {
    // Does the embedded ESPN webview show up as an attachable CDP target? Report BOTH the raw CDP
    // target list (with types) and what Playwright's connectOverCDP enumerates as pages.
    win.webContents.on("did-finish-load", async () => {
      await win.webContents.executeJavaScript("setView('live')").catch(() => {});
      await new Promise((r) => setTimeout(r, 13000)); // let the webview navigate to ESPN
      const out = { rawTargets: [], pwPages: [], espnRaw: false, espnPw: false, error: null };
      try {
        const list = await fetch("http://127.0.0.1:" + CDP_PORT + "/json/list").then((r) => r.json());
        out.rawTargets = list.map((t) => ({ type: t.type, url: (t.url || "").slice(0, 55) }));
        out.espnRaw = list.some((t) => (t.url || "").includes("espn.com"));
        const { chromium } = require(path.join(REPO, "node_modules", "playwright-core"));
        const b = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
        for (const ctx of b.contexts()) for (const pg of ctx.pages()) out.pwPages.push(pg.url().slice(0, 55));
        out.espnPw = out.pwPages.some((u) => u.includes("espn.com"));
        await b.close();
      } catch (e) { out.error = String(e); }
      console.error("CDPPROBE " + JSON.stringify(out));
      app.quit();
    });
    return;
  }
  if (process.env.MC_CAPTURE) {
    win.webContents.on("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, 4000)); // let boot() pull appData from the DB via the engine
      const probe = await win.webContents.executeJavaScript(
        "(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));const ad=window.mc&&window.mc.appData?await window.mc.appData():null;" +
        "const rows=document.querySelectorAll('tbody tr').length;" +
        "document.querySelector('.nv[data-view=\"live\"]').click();await sleep(13000);" +
        "const wv=document.getElementById('espnview');" +
        "return{rows,sRoster:document.getElementById('s-roster').textContent,nav:document.querySelectorAll('.nv').length,appDataPlayers:ad?ad.players.length:null," +
        "hasWebview:!!wv,wvStatus:wv?wv.dataset.status:null,wvUrl:wv&&wv.getURL?wv.getURL():null,wvTitle:wv&&wv.getTitle?wv.getTitle():null,err:window.__err||null};})()");
      console.error("CAPTURE " + JSON.stringify(probe));
      app.quit();
    });
  }
}

// --- IPC to the engine ---
function newestDraftLog() {
  const dir = DATA_DIR;
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => /^draft-log-.*\.json$/.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }));
  } catch (e) { return null; }
  if (!files.length) return null;
  files.sort((a, b) => b.m - a.m);
  const age = Date.now() - files[0].m;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, files[0].f), "utf8"));
    return { file: files[0].f, ageSec: Math.round(age / 1000), data };
  } catch (e) { return null; }
}

function run(cmd, args) {
  return new Promise((res) => {
    const p = cp.spawn(cmd, args, { cwd: REPO, shell: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (c) => res({ ok: c === 0, out: out.slice(-1800) }));
    p.on("error", (e) => res({ ok: false, out: String(e) }));
  });
}

// Run an `ff` subcommand that prints one JSON line to stdout, and parse it. The engine (native
// better-sqlite3, WAL-correct) owns DB reads; Electron just consumes the JSON. Full stdout is
// captured (run() truncates, so it can't be reused for a large payload).
// The persistent helper: ONE long-lived `ff serve` process holding the DB open. Fast reads/writes
// go over its stdin/stdout as NDJSON ({id,method,params} -> {id,ok,result}), so there's no per-op
// process spawn and no native SQLite in Electron. Auto-(re)starts on demand.
let serve = null, serveBuf = "", serveReady = null, serveReadyRes = null, pending = new Map(), reqId = 0;
function startServe() {
  serve = ffSpawn(["serve"]);
  serveReady = new Promise((res) => (serveReadyRes = res));
  serve.stdout.on("data", (d) => {
    serveBuf += d;
    let i;
    while ((i = serveBuf.indexOf("\n")) >= 0) {
      const line = serveBuf.slice(0, i).trim(); serveBuf = serveBuf.slice(i + 1);
      if (!line.startsWith("{")) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.event === "ready") { serveReadyRes && serveReadyRes(); continue; }
      const p = pending.get(o.id);
      if (p) { pending.delete(o.id); o.ok ? p.resolve(o.result) : p.reject(new Error(o.error)); }
    }
  });
  const die = () => { serve = null; for (const p of pending.values()) p.reject(new Error("serve closed")); pending.clear(); };
  serve.on("close", die); serve.on("error", die);
}
function rpc(method, params) {
  if (!serve) startServe();
  return serveReady.then(() => new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    serve.stdin.write(JSON.stringify({ id, method, params: params || {} }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("rpc timeout: " + method)); } }, 30000);
  }));
}

ipcMain.handle("mc:appData", () => rpc("app-data").catch(() => null));
ipcMain.handle("mc:authStatus", () => rpc("auth-status").catch(() => ({ authenticated: false, source: "none" })));
// Best-effort: open a terminal to complete the Claude subscription login; the user then re-checks.
// (A full in-app OAuth flow ships with the packaged build; dev-run uses the CLI login.)
ipcMain.handle("mc:authLogin", () => {
  try { cp.spawn("cmd", ["/c", "start", "\"Claude Login\"", "cmd", "/k", "claude"], { cwd: REPO, shell: true, detached: true }); } catch (_) { /* best-effort */ }
  return { ok: true };
});

// Mirror the app's team into SQLite (my_roster) so the agent can read it. Through the helper now.
ipcMain.handle("mc:teamSet", (e, team) => rpc("my-roster-set", { roster: Array.isArray(team) ? team : [] }).then(() => ({ ok: true })).catch(() => ({ ok: false })));

// Real Copilot: spawn the Agent SDK session (ff agent-ask, subscription auth via `claude`), pipe the
// question in on stdin, and stream its JSON events to the renderer as they arrive. Resolves on close.
ipcMain.handle("mc:agentAsk", (e, message) => new Promise((resolve) => {
  const p = ffSpawn(["agent-ask", "--json"]);
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line.startsWith("{")) { try { if (win && !win.isDestroyed()) win.webContents.send("mc:agentEvent", JSON.parse(line)); } catch (_) { /* ignore */ } }
    }
  });
  p.on("close", () => resolve({ ok: true }));
  p.on("error", (err) => resolve({ ok: false, out: String(err) }));
  p.stdin.write(String(message) + "\n");
  p.stdin.end();
}));
ipcMain.handle("mc:draftState", () => newestDraftLog());
ipcMain.handle("mc:teamGet", () => rpc("my-roster-get").catch(() => []));
ipcMain.handle("mc:liveState", async () => {
  // prefer the store (via the helper); fall back to the file if the engine hasn't written the DB yet
  try { const r = await rpc("live-state"); if (r) return r; } catch (_) { /* fall back */ }
  const f = path.join(DATA_DIR, "live-state.json");
  try {
    const m = fs.statSync(f).mtimeMs;
    return { ageSec: Math.round((Date.now() - m) / 1000), data: JSON.parse(fs.readFileSync(f, "utf8")) };
  } catch (e) { return null; }
});

// --- agent control: start (auto-draft / practice), pause via the PAUSE file, stop (kill tree) ---
let agent = null;
ipcMain.handle("mc:agentStatus", () => ({ running: !!agent, pid: agent ? agent.pid : null }));
ipcMain.handle("mc:agentStart", (e, mode) => {
  const portArgs = CDP_PORT ? ["--port", CDP_PORT] : []; // drive the EMBEDDED webview, not bro
  if (mode === "practice") { // quick launcher: drives the embedded webview into an ESPN mock room
    ffSpawn(["launch-practice", ...portArgs]);
    return { ok: true, mode };
  }
  if (agent) return { ok: false, out: "agent already running" };
  // No --csv, so the engine reads values from the SQLite store (player_value).
  agent = ffSpawn(["auto-draft", ...portArgs]);
  agent.on("close", () => { agent = null; });
  agent.on("error", () => { agent = null; });
  return { ok: true, mode, pid: agent.pid };
});
ipcMain.handle("mc:agentStop", () => {
  if (!agent) return { ok: false, out: "not running" };
  const pid = agent.pid;
  try { cp.execSync(`taskkill /F /T /PID ${pid}`); } catch (e) { /* may already be gone */ }
  agent = null;
  return { ok: true };
});
ipcMain.handle("mc:pause", (e, on) => {
  const f = path.join(DATA_DIR, "PAUSE");
  try {
    if (on) fs.writeFileSync(f, "paused");
    else if (fs.existsSync(f)) fs.unlinkSync(f);
    return { ok: true, paused: !!on };
  } catch (err) { return { ok: false, out: String(err) }; }
});
ipcMain.handle("mc:isPaused", () => {
  try { return fs.existsSync(path.join(DATA_DIR, "PAUSE")); } catch (e) { return false; }
});
ipcMain.handle("mc:openExternal", (e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
ipcMain.handle("mc:leagueInfo", () => rpc("league-info").catch(() => null));
ipcMain.handle("mc:dataSources", () => rpc("data-sources").catch(() => null));
ipcMain.handle("mc:setLevers", (e, patch) => rpc("levers-set", { patch: patch || {} }).catch(() => null));
// Onboarding sync: discover the user's ESPN leagues + sync the active one (format, scoring model, my
// team) into config. Runs the existing agent tools (discover_leagues -> league_sync) as one turn and
// resolves when it finishes, so the Setup UI can then refresh status + build the board.
ipcMain.handle("mc:syncLeague", () => new Promise((resolve) => {
  const p = ffSpawn(["agent-ask", "--json"]);
  let buf = "", lastText = "";
  p.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("{")) continue;
      try { const o = JSON.parse(line); if (o.t === "text" && o.text) lastText = String(o.text); } catch (_) { /* ignore */ }
    }
  });
  p.on("close", () => resolve({ ok: true, out: lastText }));
  p.on("error", (err) => resolve({ ok: false, out: String(err) }));
  p.stdin.write("Run discover_leagues, then league_sync. Reply with ONLY the one-line result from league_sync.\n");
  p.stdin.end();
}));
ipcMain.handle("mc:refreshData", async () => {
  // ALL TS now, no Python: ingest reference+news -> project curve -> assemble value/board.
  const r = await ffRun(["refresh"]);
  return { ok: r.ok, out: r.out };
});
ipcMain.handle("mc:pushSheet", async (e, id) => {
  const args = ["run", "python", "tools/push_sheet.py", "--no-rebuild"];
  if (id) args.push("--spreadsheet", id);
  return await run("uv", args);
});

app.whenReady().then(() => {
  ensureDb();   // packaged first-run: copy the seeded store into writable userData
  startServe(); // one long-lived DB helper for the whole session
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("before-quit", () => { try { if (serve && serve.pid) cp.execSync(`taskkill /F /T /PID ${serve.pid}`); } catch (_) { /* gone */ } });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
