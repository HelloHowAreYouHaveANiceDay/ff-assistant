// Electron main process for Fantasy Mission Control. Window + IPC to the ff engine (draft-log,
// data refresh, sheet push). Renderer is sandboxed (contextIsolation, no nodeIntegration).
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");

const REPO = path.join(__dirname, "..");
let win = null;

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
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: "deny" }; }
    return { action: "allow" };
  });
  if (process.env.MC_CAPTURE) {
    win.webContents.on("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, 1600));
      const probe = await win.webContents.executeJavaScript(
        "({rows:document.querySelectorAll('tbody tr').length,nav:document.querySelectorAll('.nv').length,err:window.__err||null})");
      console.error("CAPTURE " + JSON.stringify(probe));
      app.quit();
    });
  }
}

// --- IPC to the engine ---
function newestDraftLog() {
  const dir = path.join(REPO, "data");
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

ipcMain.handle("mc:draftState", () => newestDraftLog());
ipcMain.handle("mc:openExternal", (e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
ipcMain.handle("mc:refreshData", async () => {
  const r1 = await run("uv", ["run", "--with", "nflreadpy", "--with", "polars", "--with", "requests", "tools/build_report.py"]);
  const r2 = await run("uv", ["run", "python", "tools/build_app_data.py"]);
  return { ok: r1.ok && r2.ok, out: (r1.out + "\n" + r2.out).slice(-1800) };
});
ipcMain.handle("mc:pushSheet", async (e, id) => {
  const args = ["run", "python", "tools/push_sheet.py", "--no-rebuild"];
  if (id) args.push("--spreadsheet", id);
  return await run("uv", args);
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
