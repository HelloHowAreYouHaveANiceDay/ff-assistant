// Electron main process for Fantasy Mission Control. Creates the window and loads the renderer.
// The renderer is a static dashboard today; IPC to the `ff` engine (draft/roster/news) comes next.
const { app, BrowserWindow, shell } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 680,
    title: "Fantasy Mission Control",
    backgroundColor: "#0e1220",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  // Verification / screenshot hook: set MC_CAPTURE=<png path> to render, snapshot, and quit.
  if (process.env.MC_CAPTURE) {
    win.webContents.on("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, 1600));
      const probe = await win.webContents.executeJavaScript(
        "({rows:document.querySelectorAll('tbody tr').length,nav:document.querySelectorAll('.nv').length,crumb:(document.getElementById('crumb')||{}).textContent,err:window.__err||null})");
      const img = await win.webContents.capturePage();
      const png = img.toPNG();
      require("fs").writeFileSync(process.env.MC_CAPTURE, png);
      console.error("CAPTURE " + JSON.stringify(probe) + " pngBytes=" + png.length + " size=" + JSON.stringify(img.getSize()));
      app.quit();
    });
  }
  // open external links (news articles) in the system browser, not a new app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: "deny" }; }
    return { action: "allow" };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
