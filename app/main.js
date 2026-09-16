// Electron main process for Fantasy Mission Control. Window, the loopback APP BRIDGE the engine
// reaches the logged-in webviews through, the in-season scheduler, and a small read-only IPC surface
// for the renderer. Renderer is sandboxed (contextIsolation, no nodeIntegration).
//
// WP14 (2026-09-16, D26): the in-app Assistant is retired and the minimal UI shipped, so the agent
// control channels (agentAsk/agentStart/agentStop/pause/authLogin/...), the draft-log reader, the
// sheet push and the data-sources reader are gone with the buttons that called them. What remains is
// what a terminal cannot be: the two logged-in guests, the bridge, the league switch, and the reads
// the Board and Status pages render.
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
// Announce WHICH store this window is on. The dev/packaged split (repo data/ vs userData) is exactly
// what made "the scorecard is empty on this clone" hard to diagnose; naming it on boot -- and passing
// the same root as FF_DB and FF_DATA below -- keeps the DB and its sidecars together and visible.
console.log(`[ff] store: ${DB_PATH}  (packaged=${app.isPackaged})`);
// Where the engine writes its runtime files (live-state.json, draft-log-*, PAUSE). Matches FF_DATA
// passed to the engine (userData when packaged -- the install dir isn't writable; REPO/data in dev).
const DATA_DIR = app.isPackaged ? app.getPath("userData") : path.join(REPO, "data");
function ensureDb() {
  // A shipped build carries NO personal database -- a fresh install starts EMPTY and the user onboards
  // (Setup: log into ESPN -> Sync league -> Build board). The engine's openDb creates the schema +
  // default config on first open, so we only need the directory to exist.
  if (app.isPackaged) { try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (_) { /* created on open */ } }
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
    p.on("close", (c) => { res({ ok: c === 0, out: out.slice(-1800) }); noticeBoardChange(); });
    p.on("error", (e) => res({ ok: false, out: String(e) }));
  });
}

// THE IN-SEASON SCHEDULER. A single self-rescheduling loop: each cycle re-reads the schedule config
// (so a change the copilot makes via `schedule-set` takes effect next cycle, with no restart), and if
// it is ON, runs `ff inseason-tick` -- which runs whatever routines the stored config selects, IN THE
// ENGINE, so the app never hardcodes the routine list. The cadence is the config's own `everyMinutes`.
// Living in the app rather than an external Task Scheduler job means it runs exactly while the app is
// open (which is when a live-draft/in-season user is watching) and needs no OS-level setup.
let schedulerTimer = null, tickRunning = false, lastTick = null;
async function schedulerCycle() {
  schedulerTimer = null;
  let cfg = null;
  try { cfg = await rpc("schedule-get"); } catch (_) { /* helper may be restarting; try again next cycle */ }
  const everyMin = Math.max(5, Math.min(720, (cfg && Number(cfg.everyMinutes)) || 15));
  if (cfg && cfg.enabled && !tickRunning) {
    tickRunning = true;
    try {
      const r = await ffRun(["inseason-tick", "--json"]);
      lastTick = { at: new Date().toISOString(), ok: r.ok, out: r.out };
      if (win && !win.isDestroyed()) win.webContents.send("mc:schedulerTick", lastTick);
    } catch (e) { lastTick = { at: new Date().toISOString(), ok: false, out: String(e) }; }
    finally { tickRunning = false; }
  }
  // Always reschedule -- a disabled cycle is a cheap no-op that keeps re-enabling to within one period;
  // an explicit schedule-set also kicks a cycle immediately (see the IPC handler).
  schedulerTimer = setTimeout(schedulerCycle, everyMin * 60000);
}
function startScheduler() {
  if (schedulerTimer) return;
  // First cycle after a short delay so serve + bridge have settled; then it self-schedules.
  schedulerTimer = setTimeout(schedulerCycle, 30000);
}

// BOARD-CHANGE NOTIFICATION, hung on the CHOKEPOINTS rather than on a list of commands.
//
// Every `ff` invocation the app makes goes through exactly two places: ffRun (one-shot verbs) and
// rpc (the persistent serve helper). The copilot and the MCP tool surface are not exceptions -- the
// agent is itself spawned as `ff agent-ask`, so its work lands here too. Notifying from here rather
// than from each board-mutating tool matters because that tool list would be a hand-maintained
// enumeration of a set that grows: there are 25 MCP tools today, several of which rewrite values
// (set_lever, set_price, league_sync, draft_player), and the next one added would silently not
// notify. A guard built by enumeration is a snapshot of the day it was written.
//
// The renderer is told the STAMP, not "something happened", and decides for itself by comparing
// against what it booted with. So a spurious ping costs nothing, and a ping that never arrives is
// still caught by the renderer's own slow poll -- neither side is load-bearing alone.
let lastBoardStamp = null;
async function noticeBoardChange() {
  try {
    const s = await rpc("board-stamp");
    if (!s || !s.builtAt) return;
    if (lastBoardStamp && s.builtAt !== lastBoardStamp && win && !win.isDestroyed()) {
      win.webContents.send("mc:boardChanged", s);
    }
    lastBoardStamp = s.builtAt;
  } catch (_) { /* the helper may be restarting; the renderer's poll is the backstop */ }
  // THE SAME CHOKEPOINT also watches the lineage graph and the model registry, on the identical
  // principle: a cheap stamp (`lineage-stamp` / `models-stamp`, src/ff.ts), compared against what was
  // last seen, pushed only on a real change. Step 5: the engine's ingest/feature/assemble/scorecard
  // writes and any model artifact write change one of these stamps, and every `ff` invocation this
  // app makes passes through here (see the header comment above) or through `rpc()` below, so there
  // is no second chokepoint list to fall behind.
  try {
    const sl = await rpc("lineage-stamp");
    if (sl && sl.stamp) {
      if (lastLineageStamp && sl.stamp !== lastLineageStamp && win && !win.isDestroyed()) win.webContents.send("mc:lineageChanged", sl);
      lastLineageStamp = sl.stamp;
    }
  } catch (_) { /* same backstop as above */ }
  try {
    const sm = await rpc("models-stamp");
    if (sm && sm.stamp) {
      if (lastModelsStamp && sm.stamp !== lastModelsStamp && win && !win.isDestroyed()) win.webContents.send("mc:modelsChanged", sm);
      lastModelsStamp = sm.stamp;
    }
  } catch (_) { /* same backstop as above */ }
}
let lastLineageStamp = null;
let lastModelsStamp = null;
// `lineage-stamp`/`models-stamp` are noticeBoardChange's OWN probes -- excluded from rpc()'s
// chokepoint below for the same reason `board-stamp` is: without the exclusion, probing here would
// itself trigger another notify, forever.
const SILENT_RPC_METHODS = new Set(["lineage-stamp", "models-stamp"]);

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
  // MC_AGENT_PROBE and MC_CAPTURE were removed with the Assistant (WP14): no script, test or doc in
  // the repo set either variable, and both drove DOM (`.nv[data-view=copilot]`, `#cop-q`, `#s-roster`)
  // that had already been deleted -- so they were harnesses for a surface that no longer existed.
  // MC_CDP_PROBE stays because the question it answers is still load-bearing: whether the embedded
  // guest shows up as an attachable CDP target is exactly what `ff <verb> --app` and the 11 browser
  // MCP tools depend on.
  if (process.env.MC_CDP_PROBE) {
    // Does the embedded ESPN webview show up as an attachable CDP target? Report BOTH the raw CDP
    // target list (with types) and what Playwright's connectOverCDP enumerates as pages.
    win.webContents.on("did-finish-load", async () => {
      await win.webContents.executeJavaScript("setPage('browser')").catch(() => {});
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
}

// --- IPC to the engine ---
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
  })).then((r) => {
    // The second chokepoint. `board-stamp` is excluded because noticeBoardChange() issues it -- a
    // generic hook here without that exclusion is an infinite mutual recursion, not a slow path.
    // `lineage-stamp`/`models-stamp` are its own probes too (SILENT_RPC_METHODS), same reason.
    // Everything else is allowed through regardless of whether it looks like a mutation: the
    // renderer compares stamps and ignores a no-change ping, so over-notifying is free while an
    // under-maintained "which methods mutate?" list is exactly the enumeration bug being avoided.
    if (SILENT_RPC_METHODS.has(method)) { /* own probe -- see noticeBoardChange */ }
    else if (method !== "board-stamp") debouncedNotice();
    return r;
  });
}
let noticeTimer = null;
function debouncedNotice() {
  if (noticeTimer) return;                       // coalesce a burst of calls into one probe
  noticeTimer = setTimeout(() => { noticeTimer = null; noticeBoardChange(); }, 400);
}

// SURFACE THE ERROR, do not collapse it to null. Nine handlers used to end `.catch(() => null)`, and
// the renderer's matching `if (!page) return` discarded it a second time -- which is how a live
// engine fault rendered as three EMPTY SECTION HEADERS with no message for days (audit 1.8). A
// failed read now returns `{error}` and the Status page prints it. "No data" and "the call failed"
// must never look the same.
const rpcOr = (method, params) => rpc(method, params).catch((e) => ({ error: String((e && e.message) || e) }));

ipcMain.handle("mc:appData", () => rpcOr("app-data"));
ipcMain.handle("mc:boardStamp", () => rpcOr("board-stamp"));
ipcMain.handle("mc:leagueInfo", () => rpcOr("league-info"));
ipcMain.handle("mc:leagueList", () => rpc("league-list").catch(() => ({ leagues: [], active: null })));
ipcMain.handle("mc:leagueSetActive", (e, leagueId) => rpc("league-set-active", { leagueId }).catch((err) => ({ error: String(err) })));
ipcMain.handle("mc:modelGraph", () => rpcOr("model-graph"));
// THE DERIVED LINEAGE GRAPH (src/lineage/dag.ts) and THE MODEL PAGE (src/lineage/modelPage.ts) --
// Status renders their freshness and their registry tables as read-only text. The clickable DAG
// canvas and its per-asset materialize buttons were cut: `ff ingest-source <id>` does the same thing
// and does not need a window open (audit 5.2).
ipcMain.handle("mc:lineage", () => rpcOr("lineage"));
ipcMain.handle("mc:modelPage", () => rpcOr("model-page"));
ipcMain.handle("mc:ownership", () => rpcOr("ownership"));
// THE IN-SEASON SCHEDULER, READ-ONLY. The renderer shows the config and the LAST TICK (including a
// failure and its error text); `schedule-set`/`inseason-tick` stay engine verbs the copilot drives,
// because a button for them would be a fourth way to do something `ff` already does.
ipcMain.handle("mc:scheduleGet", async () => { try { return { config: await rpc("schedule-get"), lastTick }; } catch (e) { return { config: null, lastTick, error: String((e && e.message) || e) }; } });
// What Claude Code will be talking to: the loopback bridge, the CDP port, and the store. NO TOKEN --
// the renderer never needs it and publishing it into the page would widen the bridge's surface from
// "a local process that can read data/app-bridge.json" to "anything running in the renderer".
ipcMain.handle("mc:bridgeInfo", () => ({
  port: bridgePort, pid: process.pid, cdpPort: CDP_PORT, db: DB_PATH, repo: REPO,
  file: path.join(DATA_DIR, "app-bridge.json"),
}));
ipcMain.handle("mc:openExternal", (e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });

// --- THE APP BRIDGE: a door the engine can knock on -------------------------------------------
//
// The engine runs as a SEPARATE OS PROCESS. The app spawns it and talks to it over stdio (ff serve),
// which is app -> engine. But roster sync and the league adaptor need the other direction: reach
// INTO the app to run a fetch inside the webview that holds the ESPN login. CDP was the only wire
// for that, and it is a bad fit three ways -- it depends on a remote-debugging-port switch that can
// silently fail to bind (it did, for hours), it exposes the ENTIRE app to any local process, and it
// pulls in playwright-core just to make one authenticated HTTP request.
//
// The app already owns the webview natively. So it opens a minimal loopback endpoint instead: one
// route, bound to 127.0.0.1 only, gated by a random token written to a file alongside the port. The
// engine reads that file to discover both. No debug port, no playwright, and the surface is one
// function rather than the whole renderer.
// Resolve the ESPN <webview> GUEST webContents directly, rather than via `win` +
// getElementById("espnview"). Measured 2026-09-13: those resolved a DIFFERENT guest than the one the
// CDP-driven tools (and the user) are actually looking at -- the bridge landed on fantasy.espn.com's
// home while the visible view was the clubhouse -- so a click or frame-read hit the wrong page. The
// full webContents list is the source of truth: take the <webview> guests, prefer those on espn.com,
// and among those the MOST SPECIFIC url (longest -- a clubhouse with a query string beats the bare
// home), or the one matching `urlIncludes` when the caller names it.
// Resolve a <webview> GUEST by HOST (platform). Each platform is its own webview on its own partition,
// so the bridge must say WHICH -- host defaults to espn.com for backward compatibility. Among the
// guests on that host, take the one matching `urlIncludes` if named, else the MOST SPECIFIC url
// (longest -- a clubhouse with a query beats the bare home). See the 2026-09-13 note: the full
// webContents list is the source of truth, not getElementById on the win.
//
// NO FALLBACK TO ANOTHER GUEST (P-3, fixed 2026-09-16). This used to end
// `const pool = onHost.length ? onHost : guests`, so with no guest on the requested host it picked
// ANY webview -- which, now that the app mounts one guest per platform, means a /read-frame or /click
// meant for ESPN silently acted on the YAHOO webview, and vice versa. A wrong-SITE read is not a
// degraded read: it returns a plausible page from the wrong league on the wrong platform, and nothing
// anywhere reports an error. So a host with no guest returns null and the route says so by name.
function guestWebContents({ host = "espn.com", urlIncludes } = {}) {
  const { webContents } = require("electron");
  let guests;
  try { guests = webContents.getAllWebContents().filter((wc) => { try { return wc.getType && wc.getType() === "webview" && !wc.isDestroyed(); } catch (_) { return false; } }); }
  catch (_) { return null; }
  const url = (wc) => { try { return wc.getURL() || ""; } catch (_) { return ""; } };
  const re = new RegExp(String(host).replace(/[.]/g, "\\."));
  const pool = guests.filter((wc) => re.test(url(wc)));
  if (!pool.length) return null;
  if (urlIncludes) { const m = pool.find((wc) => url(wc).includes(urlIncludes)); if (m) return m; }
  pool.sort((a, b) => url(b).length - url(a).length);
  return pool[0] || null;
}
// (A back-compat `espnGuestWebContents(urlIncludes)` wrapper lived here. Its own comment claimed
// "the existing ESPN routes call this", and a grep found ZERO call sites -- every route had already
// been converted to guestWebContents({host}). Removed in WP14, audit 2.3.)

// THE PER-PLATFORM ALLOWLIST lives in its own dependency-free module so it is unit-testable without
// Electron (app/bridgeHosts.js, test/platform-bridge-allowlist.test.ts). A `host` that is not a key
// there is refused before any guest is resolved; an omitted one means espn.com, so every pre-existing
// caller is unchanged.
const { BRIDGE_HOSTS, resolveBridgeHost } = require("./bridgeHosts.js");

// The listening port, so `mc:bridgeInfo` can tell the Status page what the engine is knocking on
// (the token stays here and in data/app-bridge.json; it never reaches the renderer).
let bridgePort = null;
function startBridge() {
  const http = require("http");
  const crypto = require("crypto");
  const token = crypto.randomBytes(24).toString("hex");
  const server = http.createServer((req, res) => {
    const reply = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers["x-ff-token"] !== token) return reply(403, { error: "bad token" });
    // /read -- render ANY public page in a real browser and return its text.
    //
    // Deliberately a SEPARATE ROUTE with a SEPARATE SESSION PARTITION rather than a wider allowlist
    // on /fetch. /fetch exists to reuse the ESPN login and must stay narrow; research pages have no
    // business receiving those cookies, and a single route doing both would send them to whatever
    // host the caller named. This one runs in an off-the-record partition, so it carries no
    // credentials anywhere.
    //
    // The point of using the app at all is that this is a real Chromium: it executes JavaScript and
    // presents a genuine browser fingerprint, so pages that refuse a plain HTTP fetch render here.
    if (req.method === "POST" && req.url === "/read") {
      let body2 = "";
      req.on("data", (d) => { body2 += d; if (body2.length > 1e6) req.destroy(); });
      req.on("end", async () => {
        let url, waitMs;
        try { const j = JSON.parse(body2); url = j.url; waitMs = Math.min(15000, Number(j.waitMs) || 2500); }
        catch { return reply(400, { error: "bad json" }); }
        if (!/^https?:\/\//i.test(String(url))) return reply(400, { error: "url must be http(s)" });
        let w = null;
        try {
          w = new BrowserWindow({
            show: false, width: 1280, height: 900,
            webPreferences: { partition: "research-ephemeral", contextIsolation: true, nodeIntegration: false, javascript: true },
          });
          await w.loadURL(String(url));
          await new Promise((r) => setTimeout(r, waitMs));   // let client-side rendering settle
          const text = await w.webContents.executeJavaScript(
            `(() => ({ title: document.title, url: location.href, text: (document.body && document.body.innerText || "").slice(0, 200000) }))()`);
          return reply(200, text);
        } catch (e) {
          return reply(200, { error: String((e && e.message) || e) });
        } finally { if (w && !w.isDestroyed()) w.destroy(); }
      });
      return;
    }
    // /read-frame -- read text from a NESTED FRAME of the ESPN guest (e.g. the Fantasy Chat / direct-
    // message iframe). /fetch and the DOM readers cannot reach it: they run in the guest's TOP
    // document via `wv.executeJavaScript`, and a cross-origin child iframe is walled off from the top
    // document by same-origin policy. The MAIN PROCESS is the embedder, so it can enumerate the
    // guest's whole frame tree and run a read INSIDE the chosen frame -- the one place that wall does
    // not apply. Strictly READ-ONLY, like /read and /fetch: it does not accept caller-supplied JS,
    // only a URL substring to pick the frame and an optional CSS selector to scope the text.
    //   { }                          -> lists every frame's url, so the caller can pick one
    //   { match, selector? }         -> innerText of the first frame whose url contains `match`
    if (req.method === "POST" && req.url === "/read-frame") {
      let fbody = "";
      req.on("data", (d) => { fbody += d; if (fbody.length > 1e6) req.destroy(); });
      req.on("end", async () => {
        let match, selector, waitMs, scrollUp, anchorText, host;
        try { const j = JSON.parse(fbody); match = j.match; selector = j.selector; waitMs = Math.min(10000, Number(j.waitMs) || 0); scrollUp = !!j.scrollUp; anchorText = j.anchorText; host = j.host; }
        catch { return reply(400, { error: "bad json" }); }
        const fhost = resolveBridgeHost(host);
        if (!fhost) return reply(400, { error: `unknown host "${host}" -- known: ${Object.keys(BRIDGE_HOSTS).join(", ")}` });
        if (anchorText != null && typeof anchorText !== "string") return reply(400, { error: "anchorText must be a string" });
        if (selector != null && typeof selector !== "string") return reply(400, { error: "selector must be a string" });
        if (match != null && typeof match !== "string") return reply(400, { error: "match must be a string" });
        try {
          const guest = guestWebContents({ host: fhost });
          if (!guest || guest.isDestroyed()) return reply(200, { error: `no guest on ${fhost} (open that platform's browser tab first) -- refusing to read another platform's webview instead` });
          if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
          const frames = guest.mainFrame.framesInSubtree.map((f) => ({ url: f.url, name: f.name }));
          if (!match) return reply(200, { frames });
          const frame = guest.mainFrame.framesInSubtree.find((f) => (f.url || "").includes(match));
          if (!frame) return reply(200, { error: `no frame url contained "${match}"`, frames });
          // Chat message lists are virtualized -- only rows near the viewport are in the DOM. When
          // asked, wheel the largest scrollable element up to load earlier messages before scraping.
          if (scrollUp) {
            // A virtualized message THREAD lazy-loads earlier rows only when ITS OWN scroller reaches
            // the top. Scrolling every scrollable element is too blunt -- it moves the conversation
            // LIST and collapses the view. So find the scroller that actually holds the messages: the
            // scrollable ancestor of an element whose text marks a message (a proposal card says
            // "Receives"/"Trade Proposal"; anchorText lets a caller name another marker), and wheel
            // only that one to the top, repeatedly, letting each load settle.
            const marker = JSON.stringify(anchorText || "Receives");
            for (let pass = 0; pass < 6; pass++) {
              await frame.executeJavaScript(
                "(function(){var m=" + marker + ";var all=document.querySelectorAll('*');var anchor=null;" +
                "for(var i=all.length-1;i>=0;i--){var e=all[i];if((e.textContent||'').indexOf(m)>=0&&e.children.length<=3){anchor=e;break;}}" +
                "if(!anchor)return false;var s=anchor;while(s&&!(s.scrollHeight>s.clientHeight+20))s=s.parentElement;" +
                "if(!s)return false;try{s.dispatchEvent(new WheelEvent('wheel',{deltaY:-1500,bubbles:true,cancelable:true}));}catch(_){}s.scrollTop=0;return true;})()");
              await new Promise((r) => setTimeout(r, 700));
            }
          }
          const scrape = selector
            ? `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e ? (e.innerText || "").slice(0, 200000) : "__NOSEL__"; })()`
            : `(() => ((document.body && document.body.innerText) || "").slice(0, 200000))()`;
          const text = await frame.executeJavaScript(scrape);
          return reply(200, { url: frame.url, name: frame.name, text });
        } catch (e) { return reply(200, { error: String((e && e.message) || e) }); }
      });
      return;
    }
    // /click -- the HARDENED clicker for the ESPN guest. `click_page`'s plain `el.click()` is enough
    // for a real <button> (espnAuction's bid/Select buttons), but NOT for a React onClick on a
    // chrome-less toggle like the Fantasy Chat launcher: that node has no button role and a bare
    // .click() does not drive React's synthetic system. So this dispatches the full bubbling sequence
    // -- pointerover/enter, pointerdown+mousedown, focus, pointerup+mouseup -- and then ONE click via
    // el.click() (which also fires a link/button default action). Exactly one click event: dispatching
    // a synthetic click on top of el.click() double-fired and double-toggled toggle controls.
    // Same lesson as fill_page, which learned React ignores anything but real {bubbles:true} events.
    // Narrow like its siblings: it takes a CSS selector OR visible text, never caller JS.
    // KEEP THE SEQUENCE IN SYNC with click_page in src/agent/agent.ts.
    if (req.method === "POST" && req.url === "/click") {
      let cbody = "";
      req.on("data", (d) => { cbody += d; if (cbody.length > 1e6) req.destroy(); });
      req.on("end", async () => {
        let selector, textMatch, nth, frameMatch, chost;
        try { const j = JSON.parse(cbody); selector = j.selector; textMatch = j.text; nth = Math.max(0, Number(j.nth) || 0); frameMatch = j.frame; chost = j.host; }
        catch { return reply(400, { error: "bad json" }); }
        const clickHost = resolveBridgeHost(chost);
        if (!clickHost) return reply(400, { error: `unknown host "${chost}" -- known: ${Object.keys(BRIDGE_HOSTS).join(", ")}` });
        if (selector != null && typeof selector !== "string") return reply(400, { error: "selector must be a string" });
        if (textMatch != null && typeof textMatch !== "string") return reply(400, { error: "text must be a string" });
        if (frameMatch != null && typeof frameMatch !== "string") return reply(400, { error: "frame must be a string" });
        if (!selector && !textMatch) return reply(400, { error: "give a selector or text" });
        try {
          const guest = guestWebContents({ host: clickHost });
          if (!guest || guest.isDestroyed()) return reply(503, { error: `no guest on ${clickHost} (open that platform's browser tab first) -- refusing to click in another platform's webview instead` });
          // Click in a NESTED frame when asked (the chat lives in a cross-origin iframe); else the top document.
          let targetFrame = guest.mainFrame;
          if (frameMatch) {
            const f = guest.mainFrame.framesInSubtree.find((fr) => (fr.url || "").includes(frameMatch));
            if (!f) return reply(200, { ok: false, err: `no frame url contained "${frameMatch}"` });
            targetFrame = f;
          }
          const spec = JSON.stringify({ selector: selector || "", text: textMatch || "", nth });
          const inner =
            "(function(){var a=" + spec + ";" +
            "window.__ffOpen=null;if(!window.__ffPatched){window.__ffPatched=1;" +
            "window.open=function(u){try{window.__ffOpen=String(u||'');}catch(e){}return {closed:false,focus:function(){},blur:function(){},close:function(){},postMessage:function(){}};};}" +
            "function vis(e){var r=e.getBoundingClientRect();var s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}" +
            "var c=[];" +
            "if(a.selector){c=Array.prototype.slice.call(document.querySelectorAll(a.selector)).filter(vis);}" +
            "else{var t=a.text.toLowerCase();c=Array.prototype.slice.call(document.querySelectorAll('a,button,input,[role=button],div,span,td')).filter(function(e){var x=(e.innerText||e.value||'').trim().toLowerCase();return x&&x.indexOf(t)>=0&&vis(e);}).sort(function(p,q){return (p.innerText||'').length-(q.innerText||'').length;});}" +
            "if(!c.length)return JSON.stringify({ok:false,err:'NOMATCH'});" +
            "var el=c[Math.min(a.nth,c.length-1)];" +
            "var label=(el.innerText||el.value||el.tagName||'').trim().slice(0,60);" +
            "el.scrollIntoView({block:'center'});" +
            "var r=el.getBoundingClientRect();var o={bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0};" +
            "function P(ty){try{el.dispatchEvent(new PointerEvent(ty,o));}catch(e){}}" +
            "function M(ty){try{el.dispatchEvent(new MouseEvent(ty,o));}catch(e){}}" +
            "P('pointerover');M('mouseover');P('pointerenter');" +
            "P('pointerdown');M('mousedown');try{if(el.focus)el.focus();}catch(e){}" +
            "P('pointerup');M('mouseup');" +
            // Exactly ONE click event: el.click(). A synthetic MouseEvent('click') here TOO double-fired
            // and double-toggled a click-driven toggle (the Pending Moves link opened then closed). The
            // pointer/mouse down+up above still fire for components that open on those instead of click.
            "try{if(typeof el.click==='function')el.click();}catch(e){}" +
            "return JSON.stringify({ok:true,clicked:label});})()";
          const raw = await targetFrame.executeJavaScript(inner);
          let out; try { out = JSON.parse(String(raw || "{}")); } catch { out = { ok: false, err: "unparseable result" }; }
          // Surface a captured popup URL the same way click_page does, so a caller can follow it.
          try {
            const popped = await targetFrame.executeJavaScript("String(window.__ffOpen||'')");
            if (popped && popped !== "null") out.popup = String(popped);
          } catch (_) { /* popup capture is best-effort */ }
          return reply(200, out);
        } catch (e) { return reply(200, { ok: false, err: String((e && e.message) || e) }); }
      });
      return;
    }
    // /write-transaction -- the ONLY write route, kept separate from /fetch on purpose: /fetch is a GET
    // reader and must never carry a body that mutates the league. This one accepts ONLY the ESPN
    // league-transactions write URL and POSTs the given JSON body through the authenticated webview.
    // It is reached only by `ff propose-trade --send`, which itself dry-runs by default. A trade
    // proposal is visible to another manager, so this stays as narrow as the read route it sits beside.
    if (req.method === "POST" && req.url === "/write-transaction") {
      let wbody = "";
      req.on("data", (d) => { wbody += d; if (wbody.length > 1e6) req.destroy(); });
      req.on("end", async () => {
        let url, tbody;
        try { const j = JSON.parse(wbody); url = j.url; tbody = j.body; } catch { return reply(400, { error: "bad json" }); }
        // Only the ESPN transactions WRITE endpoint. Not lm-api-reads, not any other espn path.
        if (!/^https:\/\/lm-api-writes\.fantasy\.espn\.com\/apis\/v3\/games\/ffl\/seasons\/\d+\/segments\/0\/leagues\/\d+\/transactions\/?$/i.test(String(url))) {
          return reply(400, { error: "url must be the ESPN league-transactions write endpoint" });
        }
        if (typeof tbody !== "string" || tbody.length > 1e5) return reply(400, { error: "body must be a JSON string" });
        try {
          // RESOLVE THE GUEST BY HOST, like every sibling route (fixed WP14; audit 2.3). This was the
          // LAST route still doing `win.webContents.executeJavaScript(... getElementById("espnview"))`
          // -- exactly the pattern the 2026-09-13 note above says resolved the WRONG guest, and the
          // one route the P-3 no-fallback fix missed when its five siblings were converted. Same
          // shape as "two of three callers fixed". It stays ESPN-ONLY on purpose: the url allowlist
          // below is a single ESPN write endpoint, so there is no Yahoo write to serve and a `host`
          // parameter here would only invite one.
          const guest = guestWebContents({ host: "espn.com" });
          if (!guest || guest.isDestroyed()) return reply(503, { error: "no guest on espn.com (open the ESPN browser tab and sign in) -- refusing to write with another platform's session" });
          const initJson = JSON.stringify({ method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: tbody });
          const inner = `fetch(${JSON.stringify(url)},${initJson})` +
            `.then(function(r){ return r.text().then(function(t){ return { status: r.status, body: t }; }); })` +
            `.catch(function(e){ return { error: String((e && e.message) || e) }; })`;
          const out = await guest.executeJavaScript(inner);
          return reply(200, out ?? { error: "no result" });
        } catch (e) { return reply(500, { error: String((e && e.message) || e) }); }
      });
      return;
    }
    if (req.method !== "POST" || req.url !== "/fetch") return reply(404, { error: "no such route" });
    let body = "";
    req.on("data", (d) => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on("end", async () => {
      let url, headers, host;
      try { const j = JSON.parse(body); url = j.url; headers = j.headers || {}; host = j.host; } catch { return reply(400, { error: "bad json" }); }
      // ONE LOGIN PER PLATFORM, and a url allowlist PER PLATFORM. The bridge exists to reuse a login,
      // not to become a general-purpose proxy that any local process can point anywhere with the app's
      // cookies attached -- and now that there are two logins, "allowed" is a per-host question: a
      // Yahoo url must not be requested with the ESPN guest's cookies or the other way round.
      // `host` omitted = espn.com, so every pre-existing caller behaves exactly as before.
      const fetchHost = resolveBridgeHost(host);
      if (!fetchHost) return reply(400, { error: `unknown host "${host}" -- known: ${Object.keys(BRIDGE_HOSTS).join(", ")}` });
      if (!BRIDGE_HOSTS[fetchHost].test(String(url))) return reply(400, { error: `url must be https and on ${fetchHost}` });
      try {
        // Resolve the GUEST by host (never `win` + getElementById -- see the 2026-09-13 note above),
        // with no fallback: if that platform's webview is not mounted, say so.
        const guest = guestWebContents({ host: fetchHost });
        if (!guest || guest.isDestroyed()) return reply(503, { error: `no guest on ${fetchHost} (open that platform's browser tab and sign in) -- refusing to fetch with another platform's session` });
        // Built by JSON-encoding the url and init separately so nothing the caller sends can break
        // out of the string literal it lands in -- this is code being assembled, not data.
        const initJson = JSON.stringify({ credentials: "include", headers: headers || {} });
        const inner = `fetch(${JSON.stringify(url)},${initJson})` +
          `.then(function(r){ return r.text().then(function(t){ return { status: r.status, body: t }; }); })` +
          `.catch(function(e){ return { error: String((e && e.message) || e) }; })`;
        const out = await guest.executeJavaScript(inner);
        return reply(200, out ?? { error: "no result" });
      } catch (e) { return reply(500, { error: String((e && e.message) || e) }); }
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const port = bridgePort = server.address().port;
    const f = path.join(DATA_DIR, "app-bridge.json");
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ port, token, pid: process.pid, started: new Date().toISOString() }));
      // Stale-file safety: the engine checks the pid is alive, but removing it on exit is cheaper
      // than a false "app is up" that costs a confusing failure downstream.
      app.on("before-quit", () => { try { fs.unlinkSync(f); } catch (_) { /* already gone */ } });
      console.error(`[bridge] listening on 127.0.0.1:${port}`);
    } catch (e) { console.error(`[bridge] could not publish ${f}: ${e.message}`); }
  });
}

app.whenReady().then(() => {
  ensureDb();   // packaged first-run: copy the seeded store into writable userData
  startServe(); // one long-lived DB helper for the whole session
  startBridge();// loopback door so the engine can use the app's authenticated webview
  startScheduler(); // in-season routine timer (obeys the stored schedule; OFF by default)
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("before-quit", () => {
  if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null; }
  try { if (serve && serve.pid) cp.execSync(`taskkill /F /T /PID ${serve.pid}`); } catch (_) { /* gone */ }
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
