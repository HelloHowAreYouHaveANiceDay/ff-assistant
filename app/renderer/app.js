// Fantasy Mission Control renderer -- THE MINIMAL UI (WP14, 2026-09-16).
//
// WHAT THIS FILE IS NOW. Three pages: BOARD (the dense read surface), BROWSER (the two logged-in
// <webview> guests plus the chrome to drive them), STATUS (is the system healthy, and what will
// Claude Code see). Nothing else. The audit (docs/ui-audit-2026-09-16.md) found ~40% of the previous
// file unreachable -- five whole view functions kept alive only by a registry object nothing indexed
// -- and three controls that were broken rather than merely unused. The rest duplicated an `ff` verb
// or an MCP tool, and the in-app Assistant it was built around is retired (D26).
//
// THE RULE THAT DECIDES WHAT LIVES HERE: keep what a terminal cannot be, cut what a terminal already
// is. The guests and the loopback bridge are irreplaceable (12+ engine modules reach ESPN/Yahoo only
// through the login a human performed in this window). A button that shells `ff refresh` is not.
//
// There is NO data.js fallback any more. It was a 284 KB checked-in snapshot nothing regenerated,
// which rendered identically to live data -- so every failure of the live path degraded silently into
// plausible, old dollar values. Deleting it deletes that whole failure class; a live path that fails
// now says so on screen and the board is empty, which is the honest answer.
let DATA = [];
let CFG = {};   // the engine's config payload; only `levers.sleeperThreshold` is read here
// WHICH SEASON THE "last year" COLUMNS NAME. The board serves them as `<year>Pts` / `<year>Gms`, so
// the column KEY is data-dependent and the engine hands the year over with the payload (`appData`'s
// `lastYr`). This used to read `window.LAST_YR`, a global that only data.js set -- so deleting
// data.js left it on the literal fallback "LastYr", two columns keyed on fields no row has, and a
// header that renders blank and cannot sort. Caught by clicking every sort header live, not by any
// test: the cells were EMPTY, which looks like "no data for these players" rather than "wrong key".
// Hence `setLastYr` below, and hence COLS being built rather than declared.
let YR = "LastYr";

const num = v => (v === "" || v == null || isNaN(v)) ? null : +v;
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
window.openUrl = u => { if (window.mc) window.mc.openExternal(u); else window.open(u, "_blank"); return false; };

/* ---------- page switching ---------- */
let curPage = "board";
let ACTIVE_LEAGUE = null; // { leagueId, season, teamId, name, platform }

// A browser link's URL is PER PLATFORM (P-4). It used to be one ESPN template used for every league,
// so opening "My Team" on the Yahoo league navigated the ESPN webview to a different, REAL ESPN
// league -- and that url, being the longest espn.com one open, then became the page the bridge
// preferred. One builder per platform, taking the active league.
const PAGE_URL = {
  myteam: {
    espn: l => `https://fantasy.espn.com/football/team?leagueId=${l.leagueId}&seasonId=${l.season}${l.teamId ? `&teamId=${l.teamId}` : ""}`,
    yahoo: l => `https://football.fantasysports.yahoo.com/f1/${l.leagueId}${l.teamId ? `/${l.teamId}` : ""}`,
  },
  scoreboard: {
    espn: l => `https://fantasy.espn.com/football/league/scoreboard?leagueId=${l.leagueId}&seasonId=${l.season}`,
    yahoo: l => `https://football.fantasysports.yahoo.com/f1/${l.leagueId}`,
  },
  standings: {
    espn: l => `https://fantasy.espn.com/football/league/standings?leagueId=${l.leagueId}&seasonId=${l.season}`,
    yahoo: l => `https://football.fantasysports.yahoo.com/f1/${l.leagueId}/standings`,
  },
  draft: {
    espn: l => `https://fantasy.espn.com/football/draft?leagueId=${l.leagueId}&seasonId=${l.season}${l.teamId ? `&teamId=${l.teamId}` : ""}`,
    yahoo: l => `https://football.fantasysports.yahoo.com/f1/${l.leagueId}/draftresults`,
  },
};
const BROWSER_LINKS = [["myteam","My Team"],["scoreboard","Scoreboard"],["standings","Standings"],["draft","Draft Room"]];
const PAGES = [
  { id: "board", name: "Board", kind: "view" },
  { id: "browser", name: "Browser", kind: "browser" },
  { id: "status", name: "Status", kind: "view" },
];
const PAGE_VIEWS = { board: () => views_board(), status: () => views_status() };
/** The url for `linkId` on the ACTIVE league's platform, or null when that platform has no such page. */
function pageUrlFor(linkId, l) {
  const byPlat = PAGE_URL[linkId];
  if (!byPlat || !l || !l.leagueId) return null;
  const mk = byPlat[l.platform || "espn"];
  return mk ? mk(l) : null;
}
/** Navigate the ACTIVE platform's webview -- never `#espnview` unconditionally.
 *  The `.catch` is not decoration: a superseded navigation rejects with ERR_ABORTED (-3), and with no
 *  handler each one surfaced as an uncaught rejection in the console (three were captured during the
 *  audit, 3.1). Noise that masks a real load failure is worse than no noise. */
function platformGo(url) {
  const wv = activeWv();
  if (!wv || !wv.loadURL || !url) return;
  const p = wv.loadURL(url);
  if (p && p.catch) p.catch((e) => { if (!/ERR_ABORTED/.test(String(e))) console.warn("navigation failed:", String(e)); });
}
function setPage(id) {
  const pg = PAGES.find(p => p.id === id) || PAGES[0];
  curPage = pg.id;
  document.querySelectorAll("#pagetabs .tab").forEach(b => b.classList.toggle("on", b.dataset.page === pg.id));
  const isBrowser = pg.kind === "browser" && !!window.mc;
  const wl = document.getElementById("webview-layer"); if (wl) wl.classList.toggle("off", !isBrowser);
  if (isBrowser) {
    // SHOW the active league's platform; do NOT navigate. Opening the browser page used to force a
    // url on the guest, which is how every league switch landed on the out-of-season Draft Room
    // (audit 1.2). The link row navigates; the tab only reveals what is already there.
    if (ACTIVE_LEAGUE) setBrowserPlatform(ACTIVE_LEAGUE.platform || "espn");
    renderBrowserLinks();
  }
  else (PAGE_VIEWS[pg.id] || views_board)();
}
function renderPageTabs() {
  const el = document.getElementById("pagetabs"); if (!el) return;
  el.innerHTML = PAGES.map(p => `<button class="tab ${p.id === curPage ? "on" : ""}" data-page="${p.id}">${esc(p.name)}</button>`).join("");
  el.querySelectorAll(".tab").forEach(b => b.onclick = () => setPage(b.dataset.page));
}
function renderBrowserLinks() {
  const el = document.getElementById("lv-links"); if (!el) return;
  el.innerHTML = BROWSER_LINKS.map(([id, name]) =>
    `<button class="pbtn lnk" data-link="${id}">${esc(name)}</button>`).join("");
  el.querySelectorAll("[data-link]").forEach(b => b.onclick = () => {
    const url = pageUrlFor(b.dataset.link, ACTIVE_LEAGUE);
    if (url) platformGo(url);
    else leagueToast(`no "${b.textContent}" page for ${((ACTIVE_LEAGUE && ACTIVE_LEAGUE.platform) || "espn").toUpperCase()}`, "warn");
  });
}

// Top row = one tab PER LEAGUE (ESPN + Yahoo + ...), the active one highlighted. Clicking a tab makes
// that league active (engine `league-set-active` -> per-league config becomes the store's active
// config) AND switches the embedded browser to that platform's webview, navigated to the league. So
// one click moves both the app's league CONTEXT and the visible browser together.
const LEAGUE_URL = { espn: () => "https://fantasy.espn.com/football/", yahoo: (id) => "https://football.fantasysports.yahoo.com/f1/" + id };
async function renderLeagueTabs() {
  const el = document.getElementById("leaguetabs"); if (!el) return;
  let list = { leagues: [], active: null };
  try { list = (await window.mc?.leagueList?.()) || list; } catch (e) { /* none */ }
  const leagues = list.leagues || [];
  const act = leagues.find((l) => l.league_id === list.active) || leagues[0] || null;
  if (act) ACTIVE_LEAGUE = { leagueId: act.league_id, season: act.season, teamId: act.team_id, name: act.name, platform: act.platform || "espn" };
  el.innerHTML = (leagues.length
    ? leagues.map((l) => `<button class="tab league${l.league_id === (act && act.league_id) ? " on" : ""}" data-lg="${esc(l.league_id)}" data-plat="${esc(l.platform || "espn")}">${esc(l.name || "League")} <span class="platbadge">${esc((l.platform || "espn").toUpperCase())}</span></button>`).join("")
    : `<button class="tab league on">No league synced -- run <code>ff league-sync</code></button>`);
  for (const b of el.querySelectorAll(".tab.league[data-lg]")) b.onclick = () => switchLeague(b.dataset.lg, b.dataset.plat);
}
/** A small corner message for what the ENGINE said about a league switch -- the board stamp it
 *  rebuilt, or the refusal it returned. Rendering nothing there is how a stale board gets read as
 *  the new league's (S-8). */
function leagueToast(msg, kind) {
  if (!msg) return;
  let t = document.getElementById("league-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "league-toast";
    t.style.cssText = "position:fixed;bottom:16px;left:16px;z-index:9999;max-width:520px;color:#fff;" +
      "font:600 12px/1.5 system-ui,sans-serif;padding:8px 14px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.3)";
    document.body.appendChild(t);
  }
  t.style.background = kind === "error" ? "#7f1d1d" : kind === "warn" ? "#78350f" : "#065f46";
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.opacity = "0"; }, kind === "error" ? 12000 : 5000);
}

/**
 * What the ENGINE said about the switch, as [text, kind] -- the same sentence `ff league-set-active`
 * prints. The engine returns `{active, cleared, rebuilt, stamp, reason}` (S-8: the switch clears the
 * single-slot board and rebuilds it under the new league; when the rebuild cannot run the board stays
 * CLEARED and stamped pending, and every board reader then refuses by name). A cleared-but-not-rebuilt
 * board is the case that MUST be visible: rendering nothing there leaves the previous league's dollars
 * on screen under the new league's heading, which is the failure S-8 exists to stop.
 */
function leagueSwitchMessage(res, leagueId) {
  if (!res) return [`league ${leagueId}: the engine returned nothing -- the app's board may still be the previous league's.`, "error"];
  if (res.error) return [String(res.error), "error"];
  const parts = [`active league: ${res.active || leagueId}`];
  if (res.cleared) parts.push(res.rebuilt ? "board rebuilt" : "board CLEARED and PENDING");
  else parts.push("board unchanged");
  if (res.stamp) parts.push("stamp " + (typeof res.stamp === "string" ? res.stamp : JSON.stringify(res.stamp)));
  if (res.reason) parts.push(res.reason);
  return [parts.join(" | "), res.cleared && !res.rebuilt ? "warn" : "ok"];
}

async function switchLeague(leagueId, platform) {
  // ORDER MATTERS, and it was wrong once (P-4). The platform is set BEFORE anything navigates, and
  // ACTIVE_LEAGUE is updated before any url is built, so a switch to the Yahoo league can never drive
  // the hidden ESPN guest to a real, unrelated ESPN league.
  const plat = platform || "espn";
  setBrowserPlatform(plat);
  if (ACTIVE_LEAGUE && ACTIVE_LEAGUE.leagueId === leagueId) ACTIVE_LEAGUE.platform = plat;
  else ACTIVE_LEAGUE = { leagueId, season: (ACTIVE_LEAGUE && ACTIVE_LEAGUE.season) || null, teamId: null, name: null, platform: plat };

  // The ENGINE owns the switch: it stamps/clears/rebuilds the value board for the new league and
  // tells us what it did. Whatever it says is SHOWN -- a refusal ("board not built for league X") is
  // the answer, not something to swallow while leaving the previous league's board on screen.
  let res = null;
  try { res = await window.mc?.leagueSetActive?.(leagueId); } catch (e) { res = { error: String(e) }; }
  leagueToast(...leagueSwitchMessage(res, leagueId));

  await renderLeagueTabs();                                           // ACTIVE_LEAGUE from the engine
  renderBrowserLinks();
  // EXACTLY ONE navigation, to the league HOME. The PAGE does not change: a switch moves the league
  // context, and yanking the user onto a different page (it used to land on the Draft Room, in
  // September) is a second thing they did not ask for.
  const url = LEAGUE_URL[plat] ? LEAGUE_URL[plat](leagueId) : null;
  if (url) platformGo(url);
  // The new league's ownership overlay -- the previous league's owners on the new board would be a
  // quieter version of exactly the S-8 failure above.
  loadOwnership();
  if (curPage === "status") views_status();
}

/* ---------- DRAFT BOARD ---------- */
const LEFT = new Set(["player","pos","flags","t","team","owner"]);
function buildCols() {
  return [
   ["Rank","#","num"],["Player","Player","player"],["Pos","Pos","pos"],
   ["Us_Pos","Us","t"],["ECR_Pos","ECR","t"],["ESPN_Pos","ESPN","t"],["Tier","Tier","t"],
   ["Team","Team","team"],["Owner","Owner","owner"],["Bye","Bye","num"],["Age","Age","num"],
   ["OurValue$","Val$","val"],["vsECR","vsECR","delta"],
   ["ADP","ADP","num1"],["vsADP","vsADP","delta"],["Mkt30d","Mkt30d","delta"],
   ["ProjPts","Proj","num1"],["band","Range p10-p90","band"],
   [YR+"Pts",YR+"Pts","num1"],[YR+"Gms",YR+"G","gms"],
   ["ECR","ECR","num1"],["ESPN_Rank","ESPN#","num"],["ESPN_ADP","eADP","num1"],["Rostered%","Own%","num"],
   ["flags","News / Flags","flags"]
  ];
}
// columns where higher = better -> first click sorts descending (best first); everything else ascending
function buildDescFirst() { return new Set(["OurValue$","vsECR","vsADP","Mkt30d","ProjPts","band",YR+"Pts",YR+"Gms","Rostered%"]); }
let COLS = buildCols();
let DESC_FIRST = buildDescFirst();
/** Adopt the season the engine says the "last year" columns are keyed on, and rebuild the two
 *  tables that embed it. A no-op when it has not changed, so calling it on every board load is free. */
function setLastYr(lastYr) {
  const v = lastYr == null || lastYr === "" ? null : String(lastYr);
  if (!v || v === YR) return;
  YR = v; COLS = buildCols(); DESC_FIRST = buildDescFirst();
  if (bst.sort === "Rank" || !COLS.some(c => c[0] === bst.sort)) bst.sort = "Rank";
}
const POS = ["ALL","QB","RB","WR","TE","K","DST"];
// `avail` ("Hide OUT") and `hideDrafted` are GONE, not disabled. The first tested `r.Injury`, a field
// absent from all 529 served rows, so the checkbox was a proven no-op that read as a working filter
// (audit 1.5/3.4); the second filtered against a manual localStorage draft tally that is empty all
// season and is orthogonal to the real synced roster (MCP `read_my_team` / the Owner overlay).
let bst = { q:"", pos:"ALL", sleep:false, sort:"Rank", dir:1 };
let OWNERSHIP = {}; // player name -> {owner, team, slot} for the active league (empty = all free agents)

// NFL primary team colors for the Team chips. Aliases fold old/relocated abbreviations onto the current one.
const TEAM_COLORS = {
  ARI:"#97233F", ATL:"#A71930", BAL:"#241773", BUF:"#00338D", CAR:"#0085CA", CHI:"#0B162A",
  CIN:"#FB4F14", CLE:"#311D00", DAL:"#003594", DEN:"#FB4F14", DET:"#0076B6", GB:"#203731",
  HOU:"#03202F", IND:"#002C5F", JAX:"#006778", KC:"#E31837", LAC:"#0080C6", LAR:"#003594",
  LV:"#000000", MIA:"#008E97", MIN:"#4F2683", NE:"#002244", NO:"#101820", NYG:"#0B2265",
  NYJ:"#125740", PHI:"#004C54", PIT:"#101820", SEA:"#002244", SF:"#AA0000", TB:"#D50A0A",
  TEN:"#0C2340", WAS:"#5A1414",
  // aliases -> canonical color
  JAC:"#006778", LA:"#003594", STL:"#003594", OAK:"#000000", SD:"#0080C6", WSH:"#5A1414", ARZ:"#97233F",
};
function contrastText(hex) { const h = hex.replace("#",""); const r=parseInt(h.slice(0,2),16), g=parseInt(h.slice(2,4),16), b=parseInt(h.slice(4,6),16);
  return (0.299*r + 0.587*g + 0.114*b) > 150 ? "#141414" : "#ffffff"; }
function teamChip(t) { t = (t||"").toUpperCase(); if (!t) return ""; const c = TEAM_COLORS[t] || "#6b6b6b";
  return `<span class="team-chip" style="background:${c};color:${contrastText(c)}">${esc(t)}</span>`; }

/** Who owns a player in the active league, as the string the Owner cell shows -- "" for a free agent.
 *  ONE function, read by both `cell()` and `sortVal()`. The Owner column used to sort on `r.Owner`,
 *  a field the board has never served (ownership is an overlay), so `sortVal` returned the missing
 *  sentinel for all 529 rows and the header sorted the table to itself (audit 1.5, verified
 *  NO-REORDER live). Deriving both the cell and the sort key here is what makes that impossible. */
function ownerOf(r) { const o = OWNERSHIP[r.Player]; return o ? String(o.team || o.owner || "") : ""; }

function views_board() {
  const view = document.getElementById("view");
  view.innerHTML = `
   <div class="toolbar">
     <input type="search" id="q" placeholder="Search player..." value="${esc(bst.q)}">
     <div class="pills" id="pos"></div>
     <label class="tg"><input type="checkbox" id="sleep" ${bst.sleep?"checked":""}> Sleepers</label>
     <span class="count" id="count"></span>
   </div>
   <div class="tblwrap"><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></div>`;
  const posEl = document.getElementById("pos");
  POS.forEach(p => { const b = document.createElement("div"); b.className = "pill" + (p===bst.pos?" on":""); b.textContent = p;
    b.onclick = () => { bst.pos = p; [...posEl.children].forEach(c => c.classList.toggle("on", c.textContent===p)); drawBody(); }; posEl.appendChild(b); });
  let qt; document.getElementById("q").oninput = e => { const v = e.target.value.toLowerCase(); clearTimeout(qt); qt = setTimeout(() => { bst.q = v; drawBody(); }, 90); };
  document.getElementById("sleep").onchange = e => { bst.sleep = e.target.checked; drawBody(); };
  thead(); drawBody();
}
function thead() {
  const tr = COLS.map(([k,l,kind]) => { const isL = LEFT.has(kind) || k==="Tier";
    const ar = bst.sort===k ? (bst.dir>0?" &#9650;":" &#9660;") : "";
    return `<th class="${isL?'l':''}" data-k="${k}">${esc(l)}<span class="ar">${ar}</span></th>`; }).join("");
  document.getElementById("thead").innerHTML = "<tr>" + tr + "</tr>";
  document.querySelectorAll("thead th").forEach(th => th.onclick = () => { const k = th.dataset.k; if (k==="flags") return;
    // first click on a "higher = better" column sorts DESCENDING (best first); rank-like columns ascending
    if (bst.sort===k) bst.dir *= -1; else { bst.sort = k; bst.dir = DESC_FIRST.has(k) ? -1 : 1; } thead(); drawBody(); });
}
function sortVal(r,k) {
  if (k==="flags") return 0;
  // Owner is an OVERLAY, not a row field -- sort it by what the cell actually shows. A free agent
  // sorts last rather than first, because "unowned" is the default state, not a name.
  if (k==="Owner") { const o = ownerOf(r); return o || "zzzz"; }
  // The band column holds no field of its own, so sort it by what it actually shows: WIDTH. That is
  // the useful question ("who is most uncertain?") and without this the header would compare
  // undefined for every row and appear to do nothing when clicked.
  if (k==="band") { const a = num(r.P10), b = num(r.P90); return (a==null||b==null) ? "" : b - a; }
  const n = num(r[k]); return n==null ? (typeof r[k]==="string"?r[k]:1e9) : n;
}
// ---------- PROJECTION BAND ----------
// `ProjPts 319.2` is false precision. Our own measurement puts seasonal projections at 14-26% of
// within-position variance explained (QB, at the top of the board where a dollar error is largest,
// is the WORST at 7-15%), so a tenth of a point invites a comparison the model cannot support. The
// band is p10-p90 of the season total, resampled from the same bootstrap pools the simulator uses.
//
// THE AXIS IS PER POSITION AND SHARED DOWN THE COLUMN. A bar scaled to its own row would make every
// player look identically uncertain, which is the opposite of the point -- the comparison being
// drawn is between players, so the scale has to be too. Positions get separate axes because a QB
// (~400 pts) and a TE (~150) on one scale would flatten the TEs into a stub.
//
// The REPLACEMENT LINE is drawn on that axis because VOR is the entire basis of the dollar values
// and is currently nowhere on screen: a $121 next to a band means little until you can see how much
// of the band sits above the player who would otherwise fill the slot.
let AXIS = null;              // pos -> {lo, hi, repl}
function buildAxis() {
  AXIS = {};
  const byPos = {};
  for (const r of DATA) {
    if (r.P10 === "" || r.P10 == null) continue;
    (byPos[r.Pos] ??= []).push(r);
  }
  const starters = { QB: 16, RB: 40, WR: 48, TE: 16, K: 16, DST: 16 };   // 16 teams x slots incl. flex
  for (const pos in byPos) {
    const list = byPos[pos];
    const lo = Math.min(...list.map(r => num(r.P10) ?? 0));
    const hi = Math.max(...list.map(r => num(r.P90) ?? 0));
    // Replacement = the projection of the last starter at the position, by our own ranking. Derived
    // from the roster shape rather than hardcoded, so a league-settings change moves the line.
    const ranked = list.slice().sort((a, b) => (num(b.ProjPts) ?? 0) - (num(a.ProjPts) ?? 0));
    const idx = Math.min(ranked.length - 1, (starters[pos] ?? 16) - 1);
    AXIS[pos] = { lo, hi, repl: num(ranked[idx]?.ProjPts) ?? null };
  }
}
function bandCell(r) {
  const p10 = num(r.P10), p50 = num(r.P50), p90 = num(r.P90);
  if (p10 == null || p90 == null) {
    // Deliberately blank, not zero-width. These are players whose pool/projection ratio fell outside
    // the [0.5, 2.0] calibration guard -- backups joined to pools posted by players who actually
    // held that rank and actually played. Their raw band would be a different player's band.
    return `<td class="bandcell mut" title="no calibrated band -- projection is far below the historical outcomes at this rank (bench/backup)">--</td>`;
  }
  const ax = (AXIS && AXIS[r.Pos]) || { lo: p10, hi: p90, repl: null };
  const span = (ax.hi - ax.lo) || 1;
  const pct = (v) => Math.max(0, Math.min(100, ((v - ax.lo) / span) * 100));
  const l = pct(p10), rgt = pct(p90), mid = p50 != null ? pct(p50) : (l + rgt) / 2;
  const replPct = ax.repl != null ? pct(ax.repl) : null;
  const title = `p10 ${p10} - p90 ${p90} (median ${p50 != null ? p50 : "?"})` +
    (ax.repl != null ? ` | replacement ${r.Pos} ~${Math.round(ax.repl)}` : "");
  return `<td class="bandcell" title="${esc(title)}"><span class="band">` +
    (replPct != null ? `<i class="repl" style="left:${replPct.toFixed(1)}%"></i>` : "") +
    `<i class="rng" style="left:${l.toFixed(1)}%;width:${Math.max(1, rgt - l).toFixed(1)}%"></i>` +
    `<i class="med" style="left:${mid.toFixed(1)}%"></i>` +
    `</span></td>`;
}
function cell(r,k,kind) {
  if (kind==="band") return bandCell(r);
  if (kind==="player") return `<td class="l pl">${esc(r.Player)}</td>`;
  if (kind==="pos") return `<td class="l"><span class="pos ${r.Pos}">${esc(r.Pos)}</span></td>`;
  if (kind==="team") return `<td class="l">${teamChip(r.Team)}</td>`;
  if (kind==="owner") { const o = OWNERSHIP[r.Player]; return `<td class="l">${o ? `<span class="owner-chip" title="${esc(o.owner||"")}${o.slot?" - "+esc(o.slot):""}">${esc(ownerOf(r)||"?")}</span>` : '<span class="mut fa">FA</span>'}</td>`; }
  if (kind==="val") return `<td class="val">$${esc(r["OurValue$"])}</td>`;
  if (kind==="delta") { const v = num(r[k]); return `<td class="${v>0?'pos-hi':(v<0?'neg-hi':'')}">${v==null?"":(v>0?"+"+v:v)}</td>`; }
  if (kind==="gms") { const v = num(r[YR+"Gms"]); return `<td class="${(v!=null&&v<10)?'neg-hi':''}">${v==null?"":v}</td>`; }
  if (kind==="num1") { const v = num(r[k]); return `<td>${v==null?"":(Math.round(v*10)/10)}</td>`; }
  if (kind==="num") return `<td>${r[k]===""?"":esc(r[k])}</td>`;
  if (kind==="flags") {
    let b = ""; const g = num(r[YR+"Gms"]);
    if (g!=null&&g<10) b += `<span class="badge b-dur">${g}g ${YR}</span>`;
    if (r.SleeperBuzz==="ADD") b += `<span class="badge b-add">+ADD</span>`;
    if (r.SleeperBuzz==="DROP") b += `<span class="badge b-drop">-DROP</span>`;
    if (r.Depth && +r.Depth>=2) b += `<span class="badge b-dep">DEPTH ${esc(r.Depth)}</span>`;
    const news = r["Latest News"]||"", url = r.NewsURL||"";
    const nh = news ? (url ? `<a href="#" onclick="return openUrl('${esc(url)}')">${esc(news)}</a>` : esc(news)) : "";
    return `<td class="l flagcell"><span>${b}</span> <span class="news mut">${nh}</span></td>`;
  }
  return `<td class="l">${esc(r[k])}</td>`;
}
function drawBody() {
  let rs = DATA.filter(r => {
    if (bst.q && !r.Player.toLowerCase().includes(bst.q)) return false;
    if (bst.pos!=="ALL" && r.Pos!==bst.pos) return false;
    if (bst.sleep && !(num(r.vsECR) > (CFG.levers?.sleeperThreshold ?? 5))) return false;
    return true;
  });
  const isNum = !LEFT.has((COLS.find(c=>c[0]===bst.sort)||[])[2]);
  rs.sort((a,b) => {
    const x = sortVal(a,bst.sort), y = sortVal(b,bst.sort);
    // for numeric columns, empty/missing values always sink to the bottom (never float to top when ascending)
    if (isNum) { const xe = x===""||x==null, ye = y===""||y==null; if (xe && ye) return 0; if (xe) return 1; if (ye) return -1; }
    return (x<y?-1:x>y?1:0)*bst.dir;
  });
  buildAxis();   // shared per-position scale + replacement line, recomputed from the current DATA
  const tb = document.getElementById("tbody"); if (!tb) return;
  tb.innerHTML = rs.map(r => "<tr>" + COLS.map(([k,l,kind]) => cell(r,k,kind)).join("") + "</tr>").join("");
  const c = document.getElementById("count"); if (c) c.textContent = rs.length + " of " + DATA.length;
}
/** The per-league ownership overlay, then a repaint if the board is what is on screen. */
function loadOwnership() {
  if (!window.mc || !window.mc.ownership) return;
  window.mc.ownership().then(o => { OWNERSHIP = (o && o.ownership) || {}; if (curPage === "board") drawBody(); }).catch(() => {});
}

/* ---------- THE EMBEDDED BROWSER (two logged-in guests) ---------- */
// Each PLATFORM is a separate <webview> on its own persistent partition (persist:espn /
// persist:yahoo), so both stay logged in at once; the toolbar acts on whichever is active, and the
// platform tabs toggle which is shown. Both stay mounted (never reload on switch), so each is always
// a CDP target the engine/agent can navigate -- which is what `ff <verb> --app` and the 11 browser
// MCP tools depend on.
const PLATFORM_HOME = { espn: "https://fantasy.espn.com/football/", yahoo: "https://football.fantasysports.yahoo.com/" };
let ACTIVE_PLATFORM = "espn";
function activeWv() { return document.getElementById(ACTIVE_PLATFORM === "yahoo" ? "yahooview" : "espnview"); }
function setBrowserPlatform(plat) {
  if (!PLATFORM_HOME[plat]) return;
  ACTIVE_PLATFORM = plat;
  const esp = document.getElementById("espnview"), yah = document.getElementById("yahooview");
  if (esp) esp.classList.toggle("off", plat !== "espn");
  if (yah) yah.classList.toggle("off", plat !== "yahoo");
  for (const b of document.querySelectorAll("#lv-plat .plat")) b.classList.toggle("on", b.dataset.plat === plat);
  const wv = activeWv(), urlEl = document.getElementById("lv-url");
  if (wv && urlEl && wv.getURL) urlEl.textContent = wv.getURL();
}
function wireWebview() {
  const st = document.getElementById("lv-status"), urlEl = document.getElementById("lv-url");
  const showUrl = (wv) => { if (urlEl && wv === activeWv() && wv.getURL) urlEl.textContent = wv.getURL(); };
  for (const id of ["espnview", "yahooview"]) {
    const wv = document.getElementById(id); if (!wv) continue;
    wv.addEventListener("did-start-loading", () => { wv.dataset.status = "loading"; if (st && wv === activeWv()) st.textContent = "loading..."; });
    wv.addEventListener("dom-ready", () => { wv.dataset.status = "ready"; if (st && wv === activeWv()) st.textContent = ""; showUrl(wv); });
    wv.addEventListener("did-stop-loading", () => { if (st && wv === activeWv()) st.textContent = ""; showUrl(wv); });
    wv.addEventListener("did-navigate", () => showUrl(wv));
    wv.addEventListener("did-fail-load", (e) => { if (e.errorCode === -3) return; wv.dataset.status = "failed:" + e.errorCode; if (st && wv === activeWv()) st.textContent = "load failed (" + e.errorCode + ")"; });
  }
  const rl = document.getElementById("lv-reload"); if (rl) rl.onclick = () => activeWv().reload();
  const bk = document.getElementById("lv-back"); if (bk) bk.onclick = () => { const wv = activeWv(); if (wv.canGoBack && wv.canGoBack()) wv.goBack(); };
  const hm = document.getElementById("lv-home"); if (hm) hm.onclick = () => platformGo(PLATFORM_HOME[ACTIVE_PLATFORM]);
  for (const b of document.querySelectorAll("#lv-plat .plat")) b.onclick = () => setBrowserPlatform(b.dataset.plat);
  renderBrowserLinks();
}

/* ---------- STATUS ---------- */
// THE PAGE THE AUDIT SAID WAS MISSING. Three background facts were true and unsayable in this window:
// the in-app scheduler had been failing every 15 minutes with `RangeError: Missing named parameter
// "fk"` and no surface existed on which `ok:false` could appear (audit 3.7); the model page's three
// registry sections rendered as empty headers because main.js's `.catch(() => null)` and the
// renderer's `if (!page) return` discarded the engine's error twice (audit 1.8); and nothing said
// which store, league, format or bridge port Claude Code would be talking to.
//
// So every read on this page renders its ERROR when it has one. A blank section is the failure mode
// this page exists to remove -- "no data" and "the call failed" must never look the same.
function relTime(iso) {
  if (!iso) return "never";
  const t = Date.parse(iso); if (Number.isNaN(t)) return String(iso).slice(0, 10);
  const s = (Date.now() - t) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}
function freshDot(iso) {
  if (!iso) return "grey";
  const d = (Date.now() - Date.parse(iso)) / 86400000;
  return d < 2 ? "green" : d < 7 ? "amber" : "red";
}
/** The served lineage nodes, unmodified. A top-level function (not an inline `d.nodes`) so
 *  test/dag-derivation.test.ts can assert against it directly and a future change here cannot
 *  quietly start filtering what the engine served. */
function lineageNodes(graph) { return (graph && graph.nodes) || []; }

function views_status() {
  document.getElementById("view").innerHTML = `<div class="settings">
    <div class="sec"><h2>Status</h2><span class="lbl">is the system healthy, and what will Claude Code see</span></div>
    <div id="st-league"><div class="mut">Loading...</div></div>
    <div class="sec" style="margin-top:22px"><h2>Scheduled routines</h2><span class="lbl">the in-app timer -- failures shown, not swallowed</span></div>
    <div id="st-sched"><div class="mut">Loading...</div></div>
    <div class="sec" style="margin-top:22px"><h2>Data freshness</h2><span class="lbl">the lineage graph's newest writes</span></div>
    <div id="st-lineage"><div class="mut">Loading...</div></div>
    <div class="sec" style="margin-top:22px"><h2>Models</h2><span class="lbl">what is fitted, what serves each position, what is frozen</span></div>
    <div id="st-models"><div class="mut">Loading...</div></div>
    <div id="mdl-serve"></div>
    <div id="mdl-scorecard"></div>
    <div class="sec" style="margin-top:22px"><h2>Bridge + Claude Code</h2><span class="lbl">the loopback door the engine knocks on, and how to connect</span></div>
    <div id="st-bridge"><div class="mut">Loading...</div></div>
  </div>`;
  loadStatus();
}
/** Render an engine error where its section's content would be. The whole point of the page. */
function statusError(id, what, err) {
  const el = document.getElementById(id); if (!el) return;
  el.innerHTML = `<div class="setupbanner warn"><b>${esc(what)} failed:</b> <span class="mono">${esc(String(err))}</span>
    <div class="mut" style="margin-top:4px">If you just updated the engine, fully restart the app -- a reload keeps the old <code>ff serve</code> process.</div></div>`;
}
const kvRow = (k, v) => `<div class="kv"><span>${esc(k)}</span><b>${v}</b></div>`;

async function loadStatus() {
  loadStatusLeague();
  loadStatusScheduler();
  loadStatusLineage();
  loadStatusModels();
  loadStatusBridge();
}

async function loadStatusLeague() {
  const el = document.getElementById("st-league"); if (!el || !window.mc) return;
  const info = await window.mc.leagueInfo().catch((e) => ({ error: String(e) }));
  if (!info || info.error) return statusError("st-league", "league-info", (info && info.error) || "no result");
  const stamp = await window.mc.boardStamp().catch((e) => ({ error: String(e) }));
  const c = info.config || {}, lg = info.league;
  const s = (stamp && !stamp.error && stamp.stamp) || null;
  el.innerHTML =
    kvRow("Active league", lg ? `${esc(lg.name || "?")} <span class="mut">${esc(lg.league_id)}</span>` : '<span class="mut">none</span>') +
    kvRow("Platform", esc(String((ACTIVE_LEAGUE && ACTIVE_LEAGUE.platform) || "espn").toUpperCase())) +
    kvRow("Season / teams / budget", `${esc(String(c.season ?? "?"))} &middot; ${esc(String(c.teams ?? "?"))} &middot; $${esc(String(c.budget ?? "?"))}`) +
    kvRow("Scoring", esc(String(c.scoring ?? "?"))) +
    kvRow("Scoring key", s ? `<span class="mono">${esc(String(s.scoringKey ?? "?"))}</span>` : '<span class="mut">no board stamp</span>') +
    kvRow("Board", stamp && stamp.error
      ? `<span class="bad">${esc(String(stamp.error))}</span>`
      : `${esc(String((stamp && stamp.players) ?? 0))} players &middot; built ${esc(relTime((stamp && stamp.builtAt) || (s && s.builtAt)))}`) +
    kvRow("Board league", s ? `<span class="mono">${esc(String(s.leagueId ?? "?"))}</span>${lg && String(s.leagueId) !== String(lg.league_id) ? ' <span class="bad">does not match the active league</span>' : ""}` : '<span class="mut">--</span>') +
    kvRow("Rows this window is showing", `${DATA.length}${DATA_SOURCE.live ? "" : ' <span class="bad">not live: ' + esc(DATA_SOURCE.why) + "</span>"}`);
}

async function loadStatusScheduler() {
  const el = document.getElementById("st-sched"); if (!el || !window.mc) return;
  const r = await window.mc.scheduleGet().catch((e) => ({ error: String(e) }));
  if (!r || r.error) return statusError("st-sched", "schedule-get", (r && r.error) || "no result");
  renderSchedulerTick(r.config, r.lastTick);
}
/** The tick, with `ok:false` IMPOSSIBLE to miss. This ran red for days behind no surface at all. */
function renderSchedulerTick(config, lastTick) {
  const el = document.getElementById("st-sched"); if (!el) return;
  const cfg = config || {};
  const head = cfg.enabled
    ? `every ${esc(String(cfg.everyMinutes ?? "?"))} min &middot; ${esc((cfg.routines || []).join(", ") || "no routines")}`
    : `<span class="mut">disabled</span>`;
  if (!lastTick) {
    el.innerHTML = kvRow("Schedule", head) + kvRow("Last tick", '<span class="mut">none since this window opened</span>');
    return;
  }
  const ok = !!lastTick.ok;
  el.innerHTML = kvRow("Schedule", head) +
    kvRow("Last tick", `${esc(relTime(lastTick.at))} <span class="${ok ? "ok-hi" : "bad"}">${ok ? "OK" : "FAILED"}</span>`) +
    `<pre class="cmd ${ok ? "" : "bad"}">${esc(String(lastTick.out || "").trim() || "(no output)")}</pre>`;
}

async function loadStatusLineage() {
  const el = document.getElementById("st-lineage"); if (!el || !window.mc) return;
  const d = await window.mc.lineage().catch((e) => ({ error: String(e) }));
  if (!d || d.error) return statusError("st-lineage", "lineage", (d && d.error) || "no result");
  const nodes = lineageNodes(d);
  const dated = nodes.filter((n) => n.updated).sort((a, b) => (a.updated < b.updated ? 1 : -1));
  const nSources = nodes.filter((n) => n.kind === "external").length;
  const nTables = nodes.filter((n) => n.kind !== "external" && n.kind !== "artifact").length;
  const rows = dated.slice(0, 14).map((n) =>
    `<tr><td><span class="ck-dot ${freshDot(n.updated)}"></span> <b>${esc(n.id)}</b></td>
      <td class="mut">${esc(n.kind)}</td><td class="num">${esc(String(n.rows == null ? "?" : n.rows))}</td>
      <td class="num">${esc(relTime(n.updated))}</td></tr>`).join("");
  el.innerHTML = `<div class="setupbanner mut">${(d.producers || []).length} declared producers &middot; ${nSources} sources &middot; ${nTables} tables/artifacts
      &middot; oldest of the ${Math.min(14, dated.length)} shown: ${esc(relTime(dated[Math.min(13, dated.length - 1)] && dated[Math.min(13, dated.length - 1)].updated))}</div>
    <div class="mdl-scroll"><table class="tbl"><thead><tr><th>asset</th><th>layer</th><th class="num">rows</th><th class="num">written</th></tr></thead>
    <tbody>${rows || '<tr><td class="mut" colspan="4">the graph carried no dated node</td></tr>'}</tbody></table></div>
    <div class="mut">Re-materialize from a terminal: <code>ff ingest-source &lt;id&gt;</code>, or the whole warehouse with <code>ff refresh</code>.</div>`;
}

async function loadStatusModels() {
  const el = document.getElementById("st-models"); if (!el || !window.mc) return;
  const d = await window.mc.modelGraph().catch((e) => ({ error: String(e) }));
  if (!d || d.error) statusError("st-models", "model-graph", (d && d.error) || "no result");
  else {
    const models = d.models || [];
    const bad = models.filter((m) => m.problem);
    el.innerHTML = `<div class="setupbanner ${bad.length ? "warn" : "ok"}">` + (bad.length
      ? `<b>${bad.length} model(s) failing their own check:</b> ${bad.map((m) => `${esc(m.key)} -- ${esc(m.problem)}`).join(" &middot; ")}`
      : `${models.filter((m) => m.present).length} fitted models present and passing &middot; ${esc(String(d.sim?.scoring || "?"))} scoring &middot; ${esc(String(d.sim?.teams ?? "?"))} teams &middot; ${esc(String(d.sim?.playoffTeams ?? "?"))} make the playoffs`)
      + `</div><div class="mut">The full fitted-models table, nested lift and value trace live in <code>ff model-page --json</code> and docs/validation.md.</div>`;
  }
  // The two registry sections that used to render as EMPTY HEADERS because the error was discarded
  // twice. They are here because they answer "what will Claude Code's weekly/stream answers come
  // from" and "is the forward record still being written" -- and the second is exactly what the
  // scheduler's scorecard routine was failing to do.
  const page = await window.mc.modelPage().catch((e) => ({ error: String(e) }));
  if (!page || page.error) return statusError("mdl-serve", "model-page", (page && page.error) || "no result");
  renderWeeklyServe(page);
  renderScorecardSection(page);
}
function renderWeeklyServe(page) {
  const el = document.getElementById("mdl-serve");
  if (!el) return;
  const rows = (page.weeklyServe || []).map(r => `<tr class="${r.shipped ? "" : "mut"}">
      <td><b>${esc(r.pos)}</b></td><td>${esc(r.artifact)}</td>
      <td class="prose">${r.shipped ? "shipped -- passed its gate" : "not shipped -- serves the floor"}</td></tr>`).join("");
  el.innerHTML = `<div class="lbl" style="margin:10px 0 4px">What serves each position</div>
    <div class="mdl-scroll"><table class="tbl"><thead><tr><th>position</th><th>artifact</th><th>status</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <div class="mut" style="margin-top:6px">challenger series starts week ${esc(String(page.challengerFirstWeek ?? "?"))}</div>`;
}
function renderScorecardSection(page) {
  const el = document.getElementById("mdl-scorecard");
  if (!el) return;
  const scores = page.scorecardScores || {};
  const rows = (page.scorecard || []).map(k => {
    const models = (k.models || []).map(m => {
      const s = scores[m] || [];
      const metrics = s.map(x => `${esc(x.kind)}/${esc(x.metric)}=${esc(String(x.value))} (n=${esc(String(x.n))})`).join(", ");
      return `${esc(m)}${metrics ? ` [${metrics}]` : ""}`;
    }).join("; ") || '<span class="mut">none frozen</span>';
    return `<tr><td><b>${esc(k.kind)}</b></td><td class="num">${esc(String(k.weeksFrozen))}</td><td class="num">${esc(String(k.weeksScored))}</td><td class="prose">${models}</td></tr>`;
  }).join("");
  el.innerHTML = `<div class="lbl" style="margin:14px 0 4px">Scorecard -- the forward record</div>
    <div class="mdl-scroll"><table class="tbl"><thead><tr><th>kind</th><th class="num">weeks frozen</th><th class="num">weeks scored</th><th>models &amp; live scores</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

async function loadStatusBridge() {
  const el = document.getElementById("st-bridge"); if (!el || !window.mc) return;
  const b = await window.mc.bridgeInfo().catch((e) => ({ error: String(e) }));
  if (!b || b.error) return statusError("st-bridge", "bridge-info", (b && b.error) || "no result");
  // Each guest's CURRENT url, and whether it is on the platform it is supposed to be. A guest that
  // has drifted off its own host is exactly what the bridge's no-fallback refusal reports as "no
  // guest on <host>" -- better to see it here than as a failed engine call.
  const guest = (id, host) => {
    const wv = document.getElementById(id);
    let url = ""; try { url = (wv && wv.getURL && wv.getURL()) || ""; } catch (e) { url = ""; }
    const on = url.includes(host);
    return kvRow(id, url
      ? `<span class="mono">${esc(url.slice(0, 96))}</span> <span class="${on ? "ok-hi" : "bad"}">${on ? "on " + esc(host) : "OFF " + esc(host)}</span>`
      : '<span class="bad">not mounted</span>');
  };
  const mcpLine = `claude mcp add ff-draft -- npx tsx ${(b.repo || "<repo>").replace(/\\/g, "/")}/src/ff.ts mcp`;
  el.innerHTML =
    kvRow("Bridge", b.port ? `127.0.0.1:${esc(String(b.port))} <span class="mut">pid ${esc(String(b.pid))}</span>` : '<span class="bad">not listening</span>') +
    kvRow("CDP port", b.cdpPort ? `<span class="mono">${esc(String(b.cdpPort))}</span>` : '<span class="bad">off (MC_NO_CDP)</span>') +
    kvRow("Store", `<span class="mono">${esc(String(b.db || "?"))}</span>`) +
    guest("espnview", "espn.com") +
    guest("yahooview", "fantasysports.yahoo.com") +
    `<div class="lbl" style="margin:14px 0 4px">Connect Claude Code</div>
     <pre class="cmd">${esc(mcpLine)}</pre>
     <div class="mut">Then <code>ff-draft</code>'s tools drive THIS window's guests. Only ONE app instance may run: the
     MCP browser tools attach to a fixed CDP port and the bridge file is whatever the newest instance wrote.</div>`;
}

/* ---------- BOOT ---------- */
// In Electron, pull the live board + news from the SQLite store (via the ff engine) before the first
// paint. There is no snapshot fallback any more (see the file header): if the live path loses, the
// board is EMPTY and a banner says which way it lost. An empty board is legible; a plausible old one
// is not.
let DATA_SOURCE = { live: false, why: "not attempted" };

// THE OTHER HALF OF THE SAME PROBLEM. The banner below catches "the renderer never had live data".
// This catches "the renderer HAD live data and it went out of date underneath it": the board is
// loaded once at boot, so a `ff refresh` run from a terminal (or an MCP tool call) rewrites SQLite
// while the window keeps serving the numbers it read at startup. Nothing was broken in that case and
// nothing said anything -- which is exactly why a rebuilt board appears not to have rebuilt. Poll the
// engine's cheap builtAt stamp and apply the new board when it moves.
function watchForRebuild(seenAt) {
  if (!seenAt || !window.mc || !window.mc.appData) return;
  let applying = false;
  // APPLY THE NEW BOARD IN PLACE. Asking the user to click a bar was the wrong default: the app
  // knows the values changed and can just show them. A reload is only the fallback for the case
  // where re-fetching fails, and the toast exists because a board that changes underneath you with
  // no acknowledgement is the same silence this whole mechanism was built to remove -- values are
  // what trades get priced off, so a change in them should be stated, not merely performed.
  const apply = async (stamp) => {
    if (!stamp || stamp === seenAt || applying) return;
    applying = true;
    try {
      const d = await window.mc.appData();
      if (d && Array.isArray(d.players) && d.players.length) {
        DATA = d.players; CFG = d.config || CFG; setLastYr(d.lastYr);
        seenAt = d.builtAt || stamp;              // adopt the new baseline; do not re-fire on it
        // FOLLOW AN OUT-OF-BAND LEAGUE SWITCH (QA finding, 2026-09-16). `ff league-set-active` from a
        // terminal or an MCP call rebuilds the board, which lands here -- but ACTIVE_LEAGUE was only
        // ever assigned by a tab CLICK, so the tab row and the Status page's Platform row kept naming
        // the previous league while every engine-sourced field named the new one. Under D26 the CLI
        // switch is the primary path, so re-read the active league from the engine before re-rendering.
        await renderLeagueTabs();
        // Re-render the current page -- EXCEPT the BROWSER page, whose setPage would re-reveal the
        // webview layer and re-run its platform switch under whoever is watching it.
        //
        // THE KIND IS "browser", NOT "espn" (renamed 2026-09-16 when page urls became per-platform).
        // This guard still said "espn" for one build, so it stopped matching anything and the board
        // watcher re-navigated the guest on every rebuild -- observed right after a league switch,
        // which fires a rebuild. A guard keyed on a NAME keeps passing after the name changes, and
        // nothing anywhere reports it.
        const pg = PAGES.find(p => p.id === curPage);
        if (!pg || pg.kind !== "browser") setPage(curPage);
        toastRebuild(`Board updated -- ${DATA.length} players reloaded`);
      } else {
        showRebuiltBar();                          // engine answered with nothing; let the user decide
      }
    } catch (e) {
      showRebuiltBar();                            // could not fetch; offer the manual path
    } finally { applying = false; }
  };
  const check = (stamp) => { apply(stamp); };
  function toastRebuild(msg) {
    let t = document.getElementById("rebuilt-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "rebuilt-toast";
      t.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:9999;background:#065f46;color:#fff;" +
        "font:600 12px/1.5 system-ui,sans-serif;padding:8px 14px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.3)";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.opacity = "0"; }, 4000);
  }
  function showRebuiltBar() {
    if (document.getElementById("rebuilt-bar")) return;
    const b = document.createElement("div");
    b.id = "rebuilt-bar";
    b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:#065f46;color:#fff;" +
      "font:600 12px/1.5 system-ui,sans-serif;padding:6px 12px;text-align:center;cursor:pointer";
    b.textContent = "Board rebuilt -- click to load the new values";
    b.onclick = () => location.reload();
    document.body.appendChild(b);
    document.body.style.paddingTop = "28px";
  }
  // PUSH is the fast path: main notifies after any engine invocation (including every MCP tool call,
  // since the agent is itself spawned through that chokepoint), so a rebuild surfaces in under a
  // second rather than on the next poll.
  if (window.mc.onBoardChanged) window.mc.onBoardChanged((s) => check(s && s.builtAt));
  // POLL is the backstop, and it stays even though push covers the normal case: push depends on main
  // being wired correctly, and the whole class of bug here is a notification path that quietly is
  // not connected. Both compare the SAME stamp, so whichever notices first wins and the other is a
  // no-op. Slow, because it is only insurance.
  setInterval(async () => {
    try { const d = await window.mc.appData(); check(d && d.builtAt); }
    catch (e) { /* a transient engine hiccup is not worth a banner */ }
  }, 60000);
}

// A persistent, unmissable bar. Not a toast and not a console line: the whole failure mode is that
// nobody notices, so it must survive on screen for as long as the empty board does.
//
// It used to say "SNAPSHOT DATA from <date>", because a 284 KB checked-in data.js silently took over
// when the live path lost. That file is gone (WP14), so this states the simpler and more useful
// thing: there is NO board on screen, and here is exactly which way the engine call failed.
function showNoBoardBanner(src) {
  if (document.getElementById("no-board-banner")) return;
  const b = document.createElement("div");
  b.id = "no-board-banner";
  b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:#7f1d1d;color:#fff;" +
    "font:600 12px/1.5 system-ui,sans-serif;padding:6px 12px;text-align:center;letter-spacing:.02em";
  b.textContent = `NO LIVE BOARD -- this window is showing nothing, not old values. Reason: ${src.why}`;
  document.body.appendChild(b);
  document.body.style.paddingTop = "28px";
}
async function boot() {
  if (window.mc && window.mc.appData) {
    try {
      const d = await window.mc.appData();
      if (d && Array.isArray(d.players) && d.players.length) {
        DATA = d.players; CFG = d.config || CFG; setLastYr(d.lastYr);
        DATA_SOURCE = { live: true, why: "", builtAt: d.builtAt || null };
        watchForRebuild(d.builtAt || null);
      } else {
        // The call SUCCEEDED and returned nothing. Distinct from a throw, and the likelier bug:
        // appDataPayload queries `board` for config.season, so a season with no rows yields an
        // empty array rather than an error. `d.error` is main.js's rpc failure, now surfaced
        // instead of collapsing to null (audit FIX 1).
        DATA_SOURCE.why = (d && d.error)
          ? `engine error: ${d.error}`
          : `engine returned ${d && d.players ? d.players.length : 0} players for season ${(d && d.config && d.config.season) || "?"}`;
      }
    } catch (e) {
      DATA_SOURCE.why = `engine call failed: ${e && e.message ? e.message : e}`;
    }
  } else {
    DATA_SOURCE.why = "no engine bridge (window.mc) -- this is a browser preview, not the app";
  }
  if (!DATA_SOURCE.live) showNoBoardBanner(DATA_SOURCE);
  // PUSH for the Status page, same principle as watchForRebuild's board push: refresh it in place if
  // it happens to be the one open when the engine's lineage/model stamp moves.
  if (window.mc && window.mc.onLineageChanged) window.mc.onLineageChanged(() => { if (curPage === "status") loadStatusLineage(); });
  if (window.mc && window.mc.onModelsChanged) window.mc.onModelsChanged(() => { if (curPage === "status") loadStatusModels(); });
  // THE SCHEDULER TICK, LIVE. main has pushed this on every tick since the scheduler was written,
  // into a renderer that never listened -- which is why a routine could fail every 15 minutes for
  // days with nothing on screen (audit 3.7).
  if (window.mc && window.mc.onSchedulerTick) window.mc.onSchedulerTick((t) => {
    // main holds the tick, so re-reading scheduleGet is the single source rather than a second copy.
    if (curPage === "status") loadStatusScheduler();
    if (t && !t.ok) leagueToast(`scheduled routine FAILED -- see Status`, "error");
  });
  wireWebview();          // the persistent browsing surface (always mounted, always CDP-navigable)
  await renderLeagueTabs(); // top row: the league(s); sets ACTIVE_LEAGUE
  renderPageTabs();       // second row: Board / Browser / Status
  loadOwnership();        // who-owns-what for the active league (empty pre-draft)
  setPage("board");
}
boot();
