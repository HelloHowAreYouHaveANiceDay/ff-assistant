// Fantasy Mission Control renderer. In Electron the data is read LIVE from the SQLite store via
// window.mc.appData() (the ff engine reads the DB); data.js is the fallback for browser preview.
let DATA = window.PLAYERS || [];
let NEWS = window.NEWS || [];
let CFG = window.CONFIG || { budget: 200, slots: ["QB","RB","RB","WR","WR","TE","FLEX","K","DST","BE","BE","BE"], flex_ok: ["RB","WR","TE"] };
const YR = window.LAST_YR || "LastYr";
let byName = new Map(DATA.map(p => [p.Player, p]));
{ const sp = document.getElementById("s-players"); if (sp) sp.textContent = DATA.length; }

const num = v => (v === "" || v == null || isNaN(v)) ? null : +v;
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
window.openUrl = u => { if (window.mc) window.mc.openExternal(u); else window.open(u, "_blank"); return false; };

/* ---------- my team (persisted) ---------- */
let TEAM = (() => { try { return JSON.parse(localStorage.getItem("mc_team") || "[]"); } catch { return []; } })();
const saveTeam = () => { localStorage.setItem("mc_team", JSON.stringify(TEAM)); if (window.mc && window.mc.teamSet) window.mc.teamSet(TEAM); };
const onTeam = n => TEAM.some(t => t.name === n);
const spent = () => TEAM.reduce((s, t) => s + (+t.price || 0), 0);
function draft(n) { const p = byName.get(n); if (!p || onTeam(n)) return; TEAM.push({ name: n, price: +p["OurValue$"] || 1 }); saveTeam(); syncTeam(); }
function undraft(n) { TEAM = TEAM.filter(t => t.name !== n); saveTeam(); syncTeam(); }
function setPrice(n, v) { const t = TEAM.find(x => x.name === n); if (t) { t.price = Math.max(0, +v || 0); saveTeam(); syncTeam(); } }
function syncTeam() {
  const sr = document.getElementById("s-roster"); if (sr) sr.textContent = `${TEAM.length}/${CFG.slots.length}  $${spent()}`;
  if (cur === "board") drawBody();
  if (cur === "team") views.team();
}
// assign drafted players to roster slots (dedicated -> FLEX -> bench)
function rosterSlots() {
  const slots = CFG.slots.map(s => ({ slot: s, p: null }));
  const players = TEAM.map(t => ({ ...t, pos: (byName.get(t.name) || {}).Pos })).sort((a, b) => (b.price) - (a.price));
  const take = (pred) => { const i = slots.findIndex(s => !s.p && pred(s.slot)); return i; };
  for (const pl of players) {
    let i = take(s => s === pl.pos);
    if (i < 0 && CFG.flex_ok.includes(pl.pos)) i = take(s => s === "FLEX");
    if (i < 0) i = take(s => s === "BE");
    if (i < 0) i = take(() => true);
    if (i >= 0) slots[i].p = pl;
  }
  return slots;
}

/* ---------- view switching ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let cur = "board", curPage = "board";
let ACTIVE_LEAGUE = null; // { leagueId, season, teamId, name }
// Pages under the active league. ESPN pages drive the embedded (logged-in) webview to a league URL;
// the rest render into #view.
const PAGES = [
  { id: "board", name: "Board", kind: "view" },
  { id: "myteam", name: "My Team", kind: "espn", path: l => `team?leagueId=${l.leagueId}&seasonId=${l.season}${l.teamId ? `&teamId=${l.teamId}` : ""}` },
  { id: "scoreboard", name: "Scoreboard", kind: "espn", path: l => `league/scoreboard?leagueId=${l.leagueId}&seasonId=${l.season}` },
  { id: "standings", name: "Standings", kind: "espn", path: l => `league/standings?leagueId=${l.leagueId}&seasonId=${l.season}` },
  { id: "draft", name: "Draft Room", kind: "espn", path: l => `draft?leagueId=${l.leagueId}&seasonId=${l.season}${l.teamId ? `&teamId=${l.teamId}` : ""}` },
  { id: "news", name: "News", kind: "view" },
  { id: "sources", name: "Data", kind: "view" },
  { id: "model", name: "Model", kind: "view" },
  { id: "settings", name: "Setup", kind: "view" },
];
const PAGE_VIEWS = { board: () => views_board(), news: () => views_news(), sources: () => views_sources(), model: () => views_model(), settings: () => views_settings() };
function espnGo(path) { const wv = document.getElementById("espnview"); if (wv && wv.loadURL) wv.loadURL("https://fantasy.espn.com/football/" + path); }
function setPage(id) {
  if (roomTimer) { clearInterval(roomTimer); roomTimer = null; }
  const pg = PAGES.find(p => p.id === id) || PAGES[0];
  curPage = cur = pg.id;
  document.querySelectorAll("#pagetabs .tab").forEach(b => b.classList.toggle("on", b.dataset.page === pg.id));
  const isEspn = pg.kind === "espn" && !!window.mc;
  const wl = document.getElementById("webview-layer"); if (wl) wl.classList.toggle("off", !isEspn);
  if (isEspn) { if (ACTIVE_LEAGUE && ACTIVE_LEAGUE.leagueId) espnGo(pg.path(ACTIVE_LEAGUE)); }
  else (PAGE_VIEWS[pg.id] || views_board)();
}
// legacy: agent tools + the copilot call setView(viewName); map old view names onto pages
const VIEW_TO_PAGE = { board: "board", players: "board", team: "myteam", news: "news", room: "draft", live: "draft", sources: "sources", settings: "settings", copilot: "board" };
function setView(v) { setPage(VIEW_TO_PAGE[v] || "board"); }
function renderPageTabs() {
  const el = document.getElementById("pagetabs"); if (!el) return;
  el.innerHTML = PAGES.map(p => `<button class="tab ${p.id === curPage ? "on" : ""}" data-page="${p.id}">${esc(p.name)}</button>`).join("");
  el.querySelectorAll(".tab").forEach(b => b.onclick = () => setPage(b.dataset.page));
}
async function renderLeagueTabs() {
  const el = document.getElementById("leaguetabs"); if (!el) return;
  let lg = null;
  try { const info = await window.mc?.leagueInfo?.(); lg = info && info.league; if (lg) ACTIVE_LEAGUE = { leagueId: lg.league_id, season: lg.season, teamId: lg.team_id, name: lg.name }; } catch (e) { /* none synced */ }
  el.innerHTML = (lg ? `<button class="tab league on" data-lg="${esc(lg.league_id)}">${esc(lg.name || "My League")}</button>` : `<button class="tab league on">Set up a league →</button>`)
    + `<button class="tab league addleague" id="lg-add">+ league</button>`;
  const add = document.getElementById("lg-add"); if (add) add.onclick = () => setPage("settings");
}

/* ---------- DRAFT BOARD ---------- */
const COLS = [
 ["act","","act"],["Rank","#","num"],["Player","Player","player"],["Pos","Pos","pos"],
 ["Us_Pos","Us","t"],["ECR_Pos","ECR","t"],["ESPN_Pos","ESPN","t"],["Tier","Tier","t"],
 ["Team","Team","team"],["Owner","Owner","owner"],["Bye","Bye","num"],["Age","Age","num"],
 ["OurValue$","Val$","val"],["vsECR","vsECR","delta"],
 ["ADP","ADP","num1"],["vsADP","vsADP","delta"],["Mkt30d","Mkt30d","delta"],
 ["ProjPts","Proj","num1"],["band","Range p10-p90","band"],
 [YR+"Pts",YR+"Pts","num1"],[YR+"Gms",YR+"G","gms"],
 ["ECR","ECR","num1"],["ESPN_Rank","ESPN#","num"],["ESPN_ADP","eADP","num1"],["Rostered%","Own%","num"],
 ["flags","News / Flags","flags"]
];
const LEFT = new Set(["player","pos","flags","t","act","owner"]);
// columns where higher = better -> first click sorts descending (best first); everything else ascending
const DESC_FIRST = new Set(["OurValue$","vsECR","vsADP","Mkt30d","ProjPts","band",YR+"Pts",YR+"Gms","Rostered%"]);
const POS = ["ALL","QB","RB","WR","TE","K","DST"];
let bst = { q:"", pos:"ALL", sleep:false, avail:false, hideDrafted:false, sort:"Rank", dir:1 };
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

function views_board() {
  const view = document.getElementById("view");
  view.innerHTML = `
   <div class="toolbar">
     <input type="search" id="q" placeholder="Search player..." value="${esc(bst.q)}">
     <div class="pills" id="pos"></div>
     <label class="tg"><input type="checkbox" id="sleep" ${bst.sleep?"checked":""}> Sleepers</label>
     <label class="tg"><input type="checkbox" id="avail" ${bst.avail?"checked":""}> Hide OUT</label>
     <label class="tg"><input type="checkbox" id="hd" ${bst.hideDrafted?"checked":""}> Hide drafted</label>
     <span class="count" id="count"></span>
   </div>
   <div class="tblwrap"><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></div>`;
  const posEl = document.getElementById("pos");
  POS.forEach(p => { const b = document.createElement("div"); b.className = "pill" + (p===bst.pos?" on":""); b.textContent = p;
    b.onclick = () => { bst.pos = p; [...posEl.children].forEach(c => c.classList.toggle("on", c.textContent===p)); drawBody(); }; posEl.appendChild(b); });
  let qt; document.getElementById("q").oninput = e => { const v = e.target.value.toLowerCase(); clearTimeout(qt); qt = setTimeout(() => { bst.q = v; drawBody(); }, 90); };
  document.getElementById("sleep").onchange = e => { bst.sleep = e.target.checked; drawBody(); };
  document.getElementById("avail").onchange = e => { bst.avail = e.target.checked; drawBody(); };
  document.getElementById("hd").onchange = e => { bst.hideDrafted = e.target.checked; drawBody(); };
  document.getElementById("tbody").onclick = e => { const b = e.target.closest("[data-add]"); if (b) { const n = b.dataset.add; onTeam(n) ? undraft(n) : draft(n); } };
  thead(); drawBody();
  if (window.mc && window.mc.ownership) window.mc.ownership().then(o => { OWNERSHIP = (o && o.ownership) || {}; drawBody(); }).catch(() => {});
}
function thead() {
  const tr = COLS.map(([k,l,kind]) => { const isL = LEFT.has(kind) || k==="Team" || k==="Tier";
    const ar = bst.sort===k ? (bst.dir>0?" ▲":" ▼") : "";
    return `<th class="${isL?'l':''}" data-k="${k}">${esc(l)}<span class="ar">${ar}</span></th>`; }).join("");
  document.getElementById("thead").innerHTML = "<tr>" + tr + "</tr>";
  document.querySelectorAll("thead th").forEach(th => th.onclick = () => { const k = th.dataset.k; if (k==="flags"||k==="act") return;
    // first click on a "higher = better" column sorts DESCENDING (best first); rank-like columns ascending
    if (bst.sort===k) bst.dir *= -1; else { bst.sort = k; bst.dir = DESC_FIRST.has(k) ? -1 : 1; } thead(); drawBody(); });
}
function sortVal(r,k) {
  if (k==="flags"||k==="act") return 0;
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
  if (kind==="act") { const on = onTeam(r.Player); return `<td class="l"><button class="add ${on?'on':''}" data-add="${esc(r.Player)}" title="${on?'Drafted (click to remove)':'Draft to my team'}">${on?'&#10003;':'+'}</button></td>`; }
  if (kind==="player") return `<td class="l pl">${esc(r.Player)}</td>`;
  if (kind==="pos") return `<td class="l"><span class="pos ${r.Pos}">${esc(r.Pos)}</span></td>`;
  if (kind==="team") return `<td class="l">${teamChip(r.Team)}</td>`;
  if (kind==="owner") { const o = OWNERSHIP[r.Player]; return `<td class="l">${o ? `<span class="owner-chip" title="${esc(o.owner||"")}${o.slot?" · "+esc(o.slot):""}">${esc(o.team||o.owner||"?")}</span>` : '<span class="mut fa">FA</span>'}</td>`; }
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
    if (bst.avail && /Out/i.test(r.Injury||"")) return false;
    if (bst.hideDrafted && onTeam(r.Player)) return false;
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
  tb.innerHTML = rs.map(r => `<tr${onTeam(r.Player)?' class="mine"':''}>` + COLS.map(([k,l,kind]) => cell(r,k,kind)).join("") + "</tr>").join("");
  const c = document.getElementById("count"); if (c) c.textContent = rs.length + " of " + DATA.length;
}

/* ---------- MY TEAM ---------- */
function views_team() {
  const slots = rosterSlots();
  const budget = CFG.budget, sp = spent(), rem = budget - sp;
  const open = slots.filter(s => !s.p).length;
  const proj = TEAM.reduce((s, t) => s + (num((byName.get(t.name)||{}).ProjPts) || 0), 0);
  const maxBid = rem - Math.max(0, open - 1); // $1 reserve per other open slot
  const need = {}; slots.filter(s => !s.p).forEach(s => need[s.slot] = (need[s.slot]||0)+1);
  const rowFor = s => {
    if (!s.p) return `<tr class="empty"><td class="slot">${s.slot}</td><td colspan="3" class="mut">— open —</td></tr>`;
    const p = byName.get(s.p.name) || {};
    return `<tr><td class="slot">${s.slot}</td><td class="l pl">${esc(s.p.name)} <span class="pos ${p.Pos}">${esc(p.Pos)}</span></td>
      <td><input class="price" type="number" value="${s.p.price}" data-name="${esc(s.p.name)}"></td>
      <td class="l"><button class="rm" data-rm="${esc(s.p.name)}">remove</button></td></tr>`;
  };
  document.getElementById("view").innerHTML = `
    <div class="team-wrap">
      <div class="team-stats">
        ${stat("Budget", "$"+budget)}${stat("Spent", "$"+sp)}${stat("Remaining", "$"+rem, rem<0?"bad":"")}
        ${stat("Max bid", "$"+Math.max(0,maxBid), "", "$"+rem+" − $1/open slot")}
        ${stat("Slots", (CFG.slots.length-open)+"/"+CFG.slots.length)}${stat("Proj pts", Math.round(proj))}
      </div>
      <div class="team-body">
        <div class="roster">
          <div class="sec"><h2>Roster</h2><span class="lbl">${open} open</span></div>
          <table class="rtbl">${slots.map(rowFor).join("")}</table>
        </div>
        <div class="needs">
          <div class="sec"><h2>Needs</h2><span class="lbl">open by slot</span></div>
          ${Object.keys(need).length ? Object.entries(need).map(([k,v])=>`<div class="needrow"><span>${k}</span><b>${v}</b></div>`).join("") : '<div class="mut">Roster full.</div>'}
          <div class="sec" style="margin-top:20px"><h2>Best available</h2><span class="lbl">by our value</span></div>
          ${bestAvail(need).map(p=>`<div class="needrow"><span class="l"><span class="pos ${p.Pos}">${p.Pos}</span> ${esc(p.Player)}</span><button class="add" data-add="${esc(p.Player)}">+ $${p["OurValue$"]}</button></div>`).join("") || '<div class="mut">—</div>'}
        </div>
      </div>
      ${TEAM.length? "" : '<div class="hint mut">Add players from the Players tab (the + button) to build your roster here.</div>'}
    </div>`;
  const view = document.getElementById("view");
  view.querySelectorAll(".rm").forEach(b => b.onclick = () => undraft(b.dataset.rm));
  view.querySelectorAll("[data-add]").forEach(b => b.onclick = () => draft(b.dataset.add));
  view.querySelectorAll(".price").forEach(i => i.onchange = () => setPrice(i.dataset.name, i.value));
}
function stat(label, val, cls="", sub="") { return `<div class="tile"><div class="lbl">${label}</div><div class="tval ${cls}">${val}</div>${sub?`<div class="tsub mut">${sub}</div>`:""}</div>`; }
function bestAvail(need) {
  const wantPos = new Set(Object.keys(need).flatMap(s => s==="FLEX"?CFG.flex_ok : s==="BE"?["QB","RB","WR","TE","K","DST"] : [s]));
  return DATA.filter(p => !onTeam(p.Player) && (wantPos.size?wantPos.has(p.Pos):true))
    .sort((a,b)=>(+b["OurValue$"])-(+a["OurValue$"])).slice(0,8);
}

/* ---------- NEWS ---------- */
let nst = { cat: "all", q: "" };
function views_news() {
  const cats = [["all","All"],["headline","Headlines"],["injury","Injuries"],["trending","Buzz"]];
  document.getElementById("view").innerHTML = `
    <div class="toolbar">
      <input type="search" id="nq" placeholder="Search news…" value="${esc(nst.q)}">
      <div class="pills" id="ncat"></div>
      <span class="count" id="ncount"></span>
    </div>
    <div class="newsfeed" id="feed"></div>`;
  const el = document.getElementById("ncat");
  cats.forEach(([k,l]) => { const b = document.createElement("div"); b.className = "pill"+(k===nst.cat?" on":""); b.textContent = l;
    b.onclick = () => { nst.cat = k; [...el.children].forEach(c=>c.classList.toggle("on",c.textContent===l)); drawFeed(); }; el.appendChild(b); });
  let qt; document.getElementById("nq").oninput = e => { const v = e.target.value.toLowerCase(); clearTimeout(qt); qt = setTimeout(() => { nst.q = v; drawFeed(); }, 90); };
  drawFeed();
  function drawFeed() {
    let items = NEWS.filter(n => (nst.cat==="all" || n.category===nst.cat)
      && (!nst.q || `${n.player} ${n.detail} ${n.source}`.toLowerCase().includes(nst.q)));
    items.sort((a,b) => (Date.parse(b.asof) || 0) - (Date.parse(a.asof) || 0)); // latest first
    const cnt = document.getElementById("ncount"); if (cnt) cnt.textContent = `${items.length} items`;
    document.getElementById("feed").innerHTML = items.slice(0, 600).map(n => {
      const val = (byName.get(n.player)||{})["OurValue$"];
      const tag = n.category==="injury"?`<span class="badge b-out">${esc((n.detail||"").split(" - ")[0])}</span>`
        : n.category==="trending"?`<span class="badge ${/add/.test(n.source)?'b-add':'b-drop'}">${/add/.test(n.source)?'+ADD':'-DROP'}</span>` : "";
      const body = n.url ? `<a href="#" onclick="return openUrl('${esc(n.url)}')">${esc(n.detail)}</a>` : esc(n.detail);
      return `<div class="newsrow"><span class="ntime mut" title="${esc(n.asof)}">${esc(relTime(n.asof))}</span>`
        + `<span class="pos ${n.pos}">${esc(n.pos)}</span><span class="pl">${esc(n.player)}</span>`
        + `${val?`<span class="nval mut">$${val}</span>`:""}${tag}`
        + `<span class="ntext">${body}</span><span class="nsrc mut">${esc(n.source)}</span></div>`;
    }).join("") || '<div class="placeholder"><p>No items.</p></div>';
  }
}

/* ---------- DRAFT ROOM (live cockpit / agent copilot) ---------- */
let roomTimer = null;
const valOf = n => { const p = byName.get(n); return p ? ` · our $${p["OurValue$"]}` : ""; };
function views_room() {
  document.getElementById("view").innerHTML = `<div id="room" class="roomwrap"></div>`;
  drawRoom();
  if (window.mc) roomTimer = setInterval(drawRoom, 2000);
}
function ctrlBar(live, paused, running) {
  return `<div class="ctrlbar">
    <span class="astatus"><i class="dot ${live?(paused?'amber':'green'):'red'}"></i> ${live?(paused?'AGENT PAUSED':'AGENT LIVE'):(running?'starting…':'agent idle')}</span>
    <span class="ctrl-sp"></span>
    <button class="pbtn" data-act="practice">Launch practice room</button>
    <button class="pbtn" data-act="${running?'stop':'start'}">${running?'Stop agent':'Start agent'}</button>
    <button class="pbtn" data-act="pause" ${live?'':'disabled'}>${paused?'Resume':'Pause (take the wheel)'}</button>
  </div>`;
}
function wireCtrl(el) {
  el.querySelectorAll(".ctrlbar [data-act]").forEach(b => b.onclick = async () => {
    const a = b.dataset.act; b.disabled = true;
    if (a === "practice") await window.mc.agentStart("practice");
    else if (a === "start") await window.mc.agentStart("auto");
    else if (a === "stop") await window.mc.agentStop();
    else if (a === "pause") { const p = await window.mc.isPaused(); await window.mc.pause(!p); }
    setTimeout(drawRoom, 400);
  });
}
async function drawRoom() {
  const el = document.getElementById("room"); if (!el) return;
  if (!window.mc) {
    setStatus("amber", "Draft: open in the app");
    el.innerHTML = `<div class="placeholder"><div class="big">&#9889;</div><h2>Draft Room</h2>
      <p>The live cockpit runs inside the desktop app — it reads the agent's live decisions and can start/stop/pause it. Launch with <code>cd app &amp;&amp; npm start</code>.</p></div>`;
    return;
  }
  const ls = await window.mc.liveState();
  const status = await window.mc.agentStatus();
  const d = ls && ls.data;
  const live = !!(d && ls.ageSec < 30);
  const paused = !!(d && d.paused);
  const log = await window.mc.draftState();
  const drafted = new Set(((log && log.data && log.data.picks) || (d && d.recentPicks) || []).map(p => p.name));
  const avail = DATA.filter(p => !drafted.has(p.Player)).sort((a,b) => (+b["OurValue$"]) - (+a["OurValue$"]));

  if (!live) {
    setStatus(status.running ? "amber" : "red", status.running ? "Draft: starting" : "Draft: not connected");
    el.innerHTML = ctrlBar(false, false, status.running) + `<div class="placeholder"><div class="big">&#9889;</div><h2>No live draft yet</h2>
      <p>Launch a practice room (or enter the real draft), then Start agent. This panel then shows the agent's live recommended bid, our roster and budget, and the board of best-available players.</p></div>`;
    wireCtrl(el); return;
  }
  setStatus(paused ? "amber" : "green", paused ? "Draft: PAUSED" : `Draft: LIVE (${d.league.picksMade} picks)`);
  const ob = d.onBlock, dec = d.decision || {};
  const ACT = { bid:["BID","a-bid"], pass:["PASS","a-pass"], skip:["SKIP","a-mut"], watch:["WATCH","a-mut"], leading:["HIGH BIDDER","a-lead"], idle:["—","a-mut"], paused:["PAUSED","a-mut"] };
  const [actLabel, actCls] = ACT[dec.action] || ["—","a-mut"];
  const pick = ob ? `
    <div class="pick">
      <div class="pick-l">
        <div class="lbl">On the block</div>
        <div class="pick-name"><span class="pos ${ob.pos||''}">${esc(ob.pos||"")}</span> ${esc(ob.player)}</div>
        <div class="mut">current bid <b>$${ob.currentOffer||0}</b> · ESPN max $${ob.myMax==null?"—":ob.myMax}${valOf(ob.player)}</div>
      </div>
      <div class="pick-r">
        <div class="lbl">Agent recommends</div>
        <div class="pick-bid">$${dec.cap==null?"—":dec.cap} <span class="act ${actCls}">${actLabel}</span></div>
        <div class="mut">${esc(dec.reason||"")}</div>
      </div>
    </div>`
    : `<div class="pick"><div class="pick-l"><div class="lbl">Between nominations</div><div class="pick-name mut">waiting for the next player…</div></div><div class="pick-r"><div class="lbl">Agent</div><div class="pick-bid mut">idle</div></div></div>`;
  const us = d.us || {}, budget = us.budget||0, infl = d.liveInflation ? d.liveInflation.toFixed(2) : "—";
  const roster = (us.roster||[]);
  const openSummary = Object.entries(us.openByBase||{}).filter(([k,v])=>v>0).map(([k,v])=>`${k}×${v}`).concat((us.flexOpen?[`FLEX×${us.flexOpen}`]:[]),(us.benchOpen?[`BE×${us.benchOpen}`]:[])).join("  ");
  const maxBid = budget - Math.max(0, (us.open||1) - 1);
  el.innerHTML = ctrlBar(true, paused, status.running) + pick + `
    <div class="team-stats">
      ${stat("Our budget","$"+budget)}${stat("Spent","$"+(us.spent||0))}${stat("Max bid","$"+Math.max(0,maxBid))}
      ${stat("Inflation",infl,+infl<0.9?"bad":"")}${stat("Filled",(us.filled||0)+"/"+((us.filled||0)+(us.open||0)))}${stat("League $",(d.league.remainingDollars? "$"+d.league.remainingDollars : "—"))}
    </div>
    <div class="team-body">
      <div class="roster"><div class="sec"><h2>Our roster</h2><span class="lbl">${openSummary?("open  "+openSummary):"full"}</span></div>
        <table class="rtbl">${roster.length? roster.map(s=>`<tr><td class="slot">${esc(s.slot)}</td><td class="l pl">${esc(s.player)}</td><td class="val">$${s.price==null?"":s.price}</td></tr>`).join("") : '<tr><td class="mut">no players won yet</td></tr>'}</table>
        <div class="sec" style="margin-top:20px"><h2>Recent picks</h2><span class="lbl">league feed</span></div>
        ${(d.recentPicks||[]).slice().reverse().map(p=>`<div class="needrow"><span class="l">${esc(p.name)} <span class="mut">${esc(p.pos||"")}</span></span><b>$${p.price}</b></div>`).join("")||'<div class="mut">—</div>'}
      </div>
      <div class="needs"><div class="sec"><h2>Best available</h2><span class="lbl">undrafted · our value</span></div>
        <table class="rtbl">${avail.slice(0,20).map(p=>`<tr><td class="l"><span class="pos ${p.Pos}">${p.Pos}</span> <b>${esc(p.Player)}</b></td><td class="val">$${p["OurValue$"]}</td><td class="mut">ECR ${p.ECR}</td></tr>`).join("")}</table>
      </div>
    </div>`;
  wireCtrl(el);
}

/* ---------- SETTINGS / SETUP ---------- */
function views_settings() {
  document.getElementById("view").innerHTML = `
    <div class="settings">
      <div class="sec"><h2>Setup</h2><span class="lbl">connect your ESPN league</span></div>
      <div id="setup-status" class="setupbanner mut">Checking your setup…</div>
      <ol class="setupsteps">
        <li><b>1 · Connect ESPN</b> <button class="pbtn sm" id="su-connect">Open ESPN login</button> <span class="mut">log into your ESPN account in the Live Draft tab</span></li>
        <li><b>2 · Sync your league</b> <button class="pbtn sm" id="su-sync">Sync my league</button> <span class="mut">reads your teams, roster + scoring rules</span></li>
        <li><b>3 · Build your board</b> <button class="pbtn sm" id="su-build">Build board</button> <span class="mut">~5s — values tailored to your league</span></li>
      </ol>
      <pre class="cmd" id="log">Ready.</pre>
      <div class="sec" style="margin-top:24px"><h2>Detected league</h2><span class="lbl">from ESPN sync</span></div>
      <div id="league-kv"><div class="mut">—</div></div>
      <div class="sec" style="margin-top:24px"><h2>Levers</h2><span class="lbl">tuning — the assistant can set these too</span></div>
      <div id="levers-box"><div class="mut">—</div></div>
      <div class="btnrow"><button class="pbtn" id="save-levers">Save levers</button><button class="pbtn" id="reset-levers">Reset to defaults</button></div>
      <div class="sec" style="margin-top:24px"><h2>Data</h2><span class="lbl">refresh</span></div>
      <div class="btnrow">
        <button class="pbtn" id="refresh">Refresh values + news</button>
        <button class="pbtn" id="reteam">Clear my team</button>
      </div>
      ${window.mc?"":'<p class="mut">Setup + refresh run the engine — available when running inside the app.</p>'}
    </div>`;
  const log = document.getElementById("log");
  const build = async () => {
    if (!window.mc) return log.textContent = "Run inside the app to build.";
    log.textContent = "Building your board (nflverse fetch + values, ~5s)...";
    const r = await window.mc.refreshData(); log.textContent = r.out || "done";
    if (r.ok) { log.textContent += "\nReloading..."; setTimeout(() => location.reload(), 900); }
  };
  document.getElementById("su-connect").onclick = () => { setView("live"); };
  document.getElementById("su-sync").onclick = async () => {
    if (!window.mc) return log.textContent = "Run inside the app to sync.";
    log.textContent = "Syncing your league from ESPN (make sure you're logged in)...";
    const r = await window.mc.syncLeague(); log.textContent = r.out || "sync done";
    loadLeagueStatus();
  };
  document.getElementById("su-build").onclick = build;
  document.getElementById("refresh").onclick = build;
  document.getElementById("reteam").onclick = () => { if (confirm("Clear your drafted team?")) { TEAM = []; saveTeam(); syncTeam(); log.textContent = "Team cleared."; } };
  renderLevers();
  document.getElementById("save-levers").onclick = async () => {
    if (!window.mc?.setLevers) return log.textContent = "Run inside the app to save levers.";
    const patch = {}; let boardChanged = false;
    for (const s of LEVER_SPECS_UI) {
      const el = document.getElementById("lv-" + s.key); if (!el) continue;
      const v = Number(el.value); patch[s.key] = v;
      if (s.board && v !== (CFG.levers?.[s.key])) boardChanged = true;
    }
    const next = await window.mc.setLevers(patch);
    if (next) CFG.levers = next;
    log.textContent = "Levers saved." + (boardChanged ? " Board levers changed — rebuilding..." : " Bidding/UI levers apply now.");
    if (boardChanged) return build();
    renderLevers(); drawBody && drawBody();
  };
  document.getElementById("reset-levers").onclick = async () => {
    // Ask the ENGINE for its defaults -- never hardcode them here. This list used to be duplicated
    // in the renderer and went stale (aggr 1.0 / reserve 15 / maxShare 0.35, missing benchDiscount
    // and the positional multipliers), so "Reset levers" would have quietly undone the tuning.
    const next = await window.mc?.setLevers?.({ reset: true }); if (next) CFG.levers = next;
    renderLevers(); log.textContent = "Levers reset to defaults. Run Refresh to rebuild the board.";
  };
  loadLeagueStatus();
}

// The lever rows are GENERATED from the engine's registry (src/draft/levers.ts), delivered by
// appData() as `leverSpecs`. Never hardcode a lever table here: this file used to carry its own,
// and it silently drifted to 8 of the 13 levers -- benchDiscount and every positional multiplier
// were missing, so the app could not show or edit the largest measured lever in the config.
let LEVER_SPECS_UI = [];

function renderLevers() {
  const box = document.getElementById("levers-box"); if (!box) return;
  const lv = CFG.levers || {};
  if (!LEVER_SPECS_UI.length) { box.innerHTML = '<span class="mut">Levers load with the board — click Refresh.</span>'; return; }
  // Group so a long list stays readable, in the registry's own order within each group.
  const GROUPS = [["value", "Value"], ["bidding", "Bidding"], ["board", "Board"]];
  box.innerHTML = GROUPS.map(([g, title]) => {
    const rows = LEVER_SPECS_UI.filter((s) => s.group === g);
    if (!rows.length) return "";
    return `<div class="leverGroup"><h3 class="mut">${title}</h3>` + rows.map((s) => {
      const off = Number(lv[s.key]) === Number(s.off);
      return `<div class="leverrow"><label for="lv-${s.key}"><b>${esc(s.label)}</b>` +
        `${s.board ? ' <span class="tag">board</span>' : ""}` +
        `${off ? ' <span class="tag">off</span>' : ""}` +
        `<span class="mut"> ${esc(s.help)}</span></label>` +
        `<input id="lv-${s.key}" type="number" min="${s.min}" max="${s.max}" step="${s.step}" value="${lv[s.key] ?? ""}"></div>`;
    }).join("") + "</div>";
  }).join("");
}

async function loadLeagueStatus() {
  const banner = document.getElementById("setup-status"), kv = document.getElementById("league-kv");
  if (!banner || !window.mc?.leagueInfo) { if (banner) banner.textContent = "Open inside the app to set up."; return; }
  const info = await window.mc.leagueInfo().catch(() => null);
  if (!info) { banner.textContent = "Could not read setup status."; return; }
  const c = info.config || {}, lg = info.league;
  let sr = {}; try { sr = JSON.parse(lg?.scoring_json || "{}"); } catch (_) {}
  if (info.onboarded) {
    banner.className = "setupbanner ok";
    banner.innerHTML = `&#10003; <b>${esc(lg.name || "your league")}</b> synced — ${info.players} players on your board. You're ready to draft.`;
  } else if (lg) {
    banner.className = "setupbanner mut";
    banner.innerHTML = `League <b>${esc(lg.name || "?")}</b> synced — now click <b>Build board</b> (step 3).`;
  } else {
    banner.className = "setupbanner mut";
    banner.innerHTML = `Not set up yet — follow steps 1 → 3 to connect your league.`;
  }
  const rules = c.scoring_rules || {};
  const row = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
  kv.innerHTML = lg
    ? row("League", esc(lg.name || "?")) + row("Season", c.season) + row("Teams", c.teams) + row("Budget", "$" + c.budget)
      + row("Scoring", `${c.scoring} (rec ${rules.rec ?? "?"}, passTD ${rules.passTD ?? "?"})`)
      + row("Roster", (c.slots || []).join(" · ")) + row("My team", esc(lg.team_id ? "id " + lg.team_id : "?")) + row("Players loaded", info.players)
    : `<div class="mut">Sync your league to see its settings here.</div>`;
}

function setStatus(dot, text) { const el = document.getElementById("draftstatus"); if (el) el.innerHTML = `<i class="dot ${dot}"></i> ${esc(text)}`; }

/* ---------- LIVE DRAFT (embedded ESPN) ---------- */
// A real logged-in ESPN session inside the app -- a <webview> (separate WebContents, so ESPN's
// X-Frame-Options don't apply) on a persistent partition, so the login is held across launches
// (the role bro plays today). The ff engine will later attach to this page over CDP to drive it.
// Live Draft renders the persistent #webview-layer (handled by setView). This fn only covers the
// browser-preview case (no window.mc, so no webview).
function views_live() {
  const view = document.getElementById("view");
  if (view) view.innerHTML = `<div class="pad mut">The embedded browser runs only in the desktop app.</div>`;
}
// Wire the ONE persistent webview's toolbar + status (called once at boot). The webview stays mounted
// across view switches, so it's always a CDP target the engine/agent can navigate.
function wireWebview() {
  const wv = document.getElementById("espnview"); if (!wv) return;
  const st = document.getElementById("lv-status"), urlEl = document.getElementById("lv-url");
  const showUrl = () => { if (urlEl && wv.getURL) urlEl.textContent = wv.getURL(); };
  wv.addEventListener("did-start-loading", () => { wv.dataset.status = "loading"; if (st) st.textContent = "loading…"; });
  wv.addEventListener("dom-ready", () => { wv.dataset.status = "ready"; if (st) st.textContent = ""; showUrl(); });
  wv.addEventListener("did-stop-loading", () => { if (st) st.textContent = ""; showUrl(); });
  wv.addEventListener("did-navigate", showUrl);
  wv.addEventListener("did-fail-load", (e) => { if (e.errorCode === -3) return; wv.dataset.status = "failed:" + e.errorCode; if (st) st.textContent = "load failed (" + e.errorCode + ")"; });
  const rl = document.getElementById("lv-reload"); if (rl) rl.onclick = () => wv.reload();
  const bk = document.getElementById("lv-back"); if (bk) bk.onclick = () => { if (wv.canGoBack && wv.canGoBack()) wv.goBack(); };
  const hm = document.getElementById("lv-home"); if (hm) hm.onclick = () => wv.loadURL("https://fantasy.espn.com/football/");
}

/* ---------- COPILOT (agent chat + app-control tool belt) ---------- */
// The tool belt: everything the agent can do to drive the app. This is the SAME surface the real
// Agent SDK session (child process) will call as tools; the stub planner below exercises it end-to-
// end. Deliberately NO real auto-draft tool here -- the agent must not start real bidding.
function findPlayer(name) {
  const q = (name || "").toLowerCase().trim();
  return byName.get(name) || DATA.find(p => p.Player.toLowerCase() === q) || DATA.find(p => p.Player.toLowerCase().includes(q));
}
const AGENT_TOOLS = {
  set_view:        { desc: "Navigate to a view (board|team|news|room|copilot|live|settings)", run: async ({ view }) => { setView(view); return `switched to ${view}`; } },
  search_players:  { desc: "Search the board by player name", run: async ({ query }) => { setView("board"); bst.q = (query || "").toLowerCase(); drawBody(); const el = document.getElementById("q"); if (el) el.value = query || ""; return `${DATA.filter(p => p.Player.toLowerCase().includes(bst.q)).length} match "${query}"`; } },
  filter_position: { desc: "Filter the board to a position", run: async ({ pos }) => { setView("board"); bst.pos = (pos || "ALL").toUpperCase(); drawBody(); return `board filtered to ${bst.pos}`; } },
  read_board:      { desc: "Read the top available players (optionally by position)", run: async ({ pos, limit }) => { let rs = DATA.filter(p => !onTeam(p.Player)); if (pos && pos.toUpperCase() !== "ALL") rs = rs.filter(p => p.Pos === pos.toUpperCase()); rs = rs.sort((a, b) => num(b["OurValue$"]) - num(a["OurValue$"])).slice(0, limit || 8); return rs.map(p => `${p.Player} (${p.Pos} $${p["OurValue$"]})`).join(" | ") || "none available"; } },
  draft_player:    { desc: "Draft a player to my team at a price", run: async ({ name, price }) => { const p = findPlayer(name); if (!p) return `no player matching "${name}"`; draft(p.Player); if (price != null) setPrice(p.Player, price); return `drafted ${p.Player}${price != null ? " for $" + price : ""}`; } },
  read_my_team:    { desc: "Read my roster, budget, and open slots", run: async () => { const sp = spent(), rem = CFG.budget - sp, open = rosterSlots().filter(s => !s.p).length; return `${TEAM.length} drafted, $${sp} spent, $${rem} left, ${open} slots open`; } },
  read_live_state: { desc: "Read the live draft state (on-block player + recommendation)", run: async () => { if (!window.mc) return "desktop app only"; const ls = await window.mc.liveState(); if (!ls || !ls.data) return "engine not running"; const d = ls.data; return d.onBlock ? `on block: ${(d.decision && d.decision.player) || "?"} -- ${(d.decision && d.decision.action) || "?"} up to $${(d.decision && d.decision.cap) ?? "?"}` : "no player on the block"; } },
  start_practice:  { desc: "Open a practice draft room (safe -- never the real league)", run: async () => { if (!window.mc) return "desktop app only"; await window.mc.agentStart("practice"); return "launching a practice room"; } },
};
function fmtArgs(a) { return Object.entries(a || {}).map(([k, v]) => `${k}=${v}`).join(", "); }

// Stub planner: maps a plain-English message to tool calls and streams the turn. The real Agent SDK
// session replaces THIS function; the tool belt and the chat sink stay identical.
async function stubAgentTurn(msg, sink) {
  const m = msg.toLowerCase().trim();
  const calls = []; let d;
  if (d = m.match(/^(?:draft|add|buy|get)\s+(.+?)(?:\s+for\s+\$?(\d+))?$/)) calls.push(["draft_player", { name: d[1].trim(), price: d[2] ? +d[2] : null }]);
  else if (d = m.match(/best (?:available )?(qb|rb|wr|te|k|dst)?/)) calls.push(["read_board", { pos: d[1] ? d[1].toUpperCase() : "ALL", limit: 8 }]);
  else if (d = m.match(/^(?:search|find|look up)\s+(.+)/)) calls.push(["search_players", { query: d[1].trim() }]);
  else if (/(my team|my roster|budget|how much.*left)/.test(m)) calls.push(["read_my_team", {}]);
  else if (/(on the block|recommend|what should i bid|nomination|live state)/.test(m)) calls.push(["read_live_state", {}]);
  else if (d = m.match(/(?:go to|open|show)\s+(board|players|team|news|room|copilot|live|settings|draft room|live draft)/)) { const v = { players: "board", "draft room": "room", "live draft": "live" }[d[1]] || d[1]; calls.push(["set_view", { view: v }]); }
  else if (/practice/.test(m)) calls.push(["start_practice", {}]);
  else if (d = m.match(/^(qb|rb|wr|te|k|dst)s?$/)) calls.push(["filter_position", { pos: d[1].toUpperCase() }]);

  if (!calls.length) {
    await sink.text('I can drive the draft for you. Try: "best available RB", "search Gibbs", "draft Bijan for $90", "show my team", "who’s on the block", "open live draft", or "start practice".');
    return sink.done();
  }
  await sink.text("On it.");
  for (const [name, args] of calls) { sink.tool(name, args); const res = await AGENT_TOOLS[name].run(args); await sink.result(res); }
  sink.done();
}

let copilotLog = [{ role: "assistant", parts: [{ t: "text", s: "Hi — I’m your draft assistant. Ask me anything about the board: “best available RB”, “is Josh Jacobs a value?”, “who should I target at WR?”. I read the live value board to answer." }] }];
// ---------- DRAFT COCKPIT (replaces the chat Assistant in the left rail) ----------
// One job: show, at a glance, whether the agent is alive and what it is about to do -- so a human
// can decide to step in. Everything here is READ-ONLY; intervening means bidding yourself in the
// draft room, changing a lever in Setup (auto-draft re-reads them every tick), or `touch data/PAUSE`.
const money = (n) => "$" + (Number(n) || 0);
function cockpitAlerts(d, ageSec) {
  const a = [];
  // Staleness is the alarm that matters: if auto-draft died or lost the room, this panel is the ONLY
  // on-screen sign -- ESPN's own UI looks completely normal while our bidder is gone.
  // Thresholds are set off MEASURED cadence, not the tick rate: the state file is rewritten only on
  // ticks that see a block, so ~11s between writes is normal and quiet stretches happen between
  // nominations. 25s = worth a glance, 45s = something is actually wrong. Tuned deliberately high --
  // a panel that cries wolf gets ignored, and this one has to be believed at 10am.
  if (ageSec == null) a.push(["bad", "No agent data -- auto-draft has not started"]);
  else if (ageSec > 45) a.push(["bad", `Agent silent ${ageSec}s -- likely dead or out of the room. CHECK IT.`]);
  else if (ageSec > 25) a.push(["warn", `No update for ${ageSec}s (normal between nominations)`]);
  if (d && d.paused) a.push(["warn", "PAUSED (data/PAUSE present) -- not bidding; delete the file to resume"]);
  const us = d && d.us;
  if (us && us.open === 0) a.push(["ok", `Roster complete -- ${us.filled} slots, ${money(us.spent)} spent`]);
  // Late and rich: the room is nearly out of money and we still hold most of ours. Not a fault --
  // it is the shape of this strategy -- but it is the moment a human might want to spend faster.
  if (us && d && d.league && us.open > 0) {
    const ourLeft = 200 - (us.spent || 0);
    if ((d.league.remainingDollars || 0) < 600 && ourLeft > 80) {
      a.push(["warn", `${money(ourLeft)} unspent with ${us.open} slots open and the room down to ${money(d.league.remainingDollars)}`]);
    }
  }
  // Click health: the agent can be deciding perfectly and still not land bids (button re-render
  // race). Nothing else on screen would show it -- the roster just mysteriously fails to grow.
  const ck = d && d.clicks;
  if (ck && ck.attempts >= 5) {
    const pct = Math.round((ck.fails / ck.attempts) * 100);
    if (pct >= 25) a.push(["bad", `${ck.fails}/${ck.attempts} bid clicks FAILED (${pct}%) -- bid manually if this keeps up`]);
    else if (pct >= 10) a.push(["warn", `${ck.fails}/${ck.attempts} bid clicks failed (${pct}%)`]);
  }
  return a;
}
function renderCockpit() {
  const el = document.getElementById("cockpit"); if (!el) return;
  const st = COCKPIT, d = st && st.data, ageSec = st ? st.ageSec : null;
  const alerts = cockpitAlerts(d, ageSec);
  const badge = ageSec == null ? `<span class="ck-dot bad"></span>OFFLINE`
    : ageSec > 45 ? `<span class="ck-dot bad"></span>STALE ${ageSec}s`
    : (d && d.paused) ? `<span class="ck-dot warn"></span>PAUSED`
    : ageSec > 25 ? `<span class="ck-dot warn"></span>${ageSec}s`
    : `<span class="ck-dot ok"></span>LIVE`;
  if (!d) {
    el.innerHTML = `<div class="ck-status">${badge}</div>` +
      alerts.map(([k, t]) => `<div class="ck-alert ${k}">${esc(t)}</div>`).join("") +
      `<div class="ck-empty mut">Start the draft:<br><code>ff enter-draft --app</code><br><code>ff auto-draft --app</code></div>`;
    return;
  }
  const b = d.onBlock, dec = d.decision, us = d.us || {}, lg = d.league || {};
  const ourLeft = 200 - (us.spent || 0);
  // The single most useful line: what is up, what we think it is worth, and are we in or out.
  const blockHtml = b && b.player ? `
    <div class="ck-block ${dec && dec.action === "bid" ? "in" : "out"}">
      <div class="ck-name">${esc(b.player)} <span class="mut">${esc(b.pos || "")}</span></div>
      <div class="ck-row"><span>offer</span><b>${money(b.currentOffer)}</b></div>
      <div class="ck-row"><span>our cap</span><b>${dec ? money(dec.cap) : "--"}</b></div>
      <div class="ck-verdict">${dec ? (dec.action === "bid" ? "BIDDING" : "PASS") : "--"}</div>
      <div class="ck-why mut">${dec ? esc(dec.reason || "") : ""}</div>
    </div>` : `<div class="ck-block idle mut">nobody on the block</div>`;
  const rosterHtml = (us.roster || []).length
    ? `<table class="ck-tbl">${us.roster.map(p => `<tr><td class="mut">${esc(p.pos || "")}</td><td>${esc(p.name || "")}</td><td class="r">${money(p.price)}</td></tr>`).join("")}</table>`
    : `<div class="mut">no players won yet</div>`;
  const recent = (d.recentPicks || []).slice(-6).reverse().map(p =>
    `<tr><td>${esc(p.name)}</td><td class="mut">${esc(p.pos || "")}</td><td class="r">${money(p.price)}</td></tr>`).join("");
  el.innerHTML = `
    <div class="ck-status">${badge} <span class="mut">r${d.round ?? "--"} &middot; infl ${d.liveInflation != null ? d.liveInflation.toFixed(2) : "--"}</span></div>
    ${alerts.map(([k, t]) => `<div class="ck-alert ${k}">${esc(t)}</div>`).join("")}
    ${blockHtml}
    <div class="ck-h">Us</div>
    <div class="ck-row"><span>budget left</span><b>${money(ourLeft)}</b></div>
    <div class="ck-row"><span>max legal bid</span><b>${b && b.myMax != null ? money(b.myMax) : "--"}</b></div>
    <div class="ck-row"><span>roster</span><b>${us.filled ?? 0}/${(us.filled ?? 0) + (us.open ?? 0)}</b></div>
    ${rosterHtml}
    <div class="ck-h">Room</div>
    <div class="ck-row"><span>money left</span><b>${money(lg.remainingDollars)}</b></div>
    <div class="ck-row"><span>picks made</span><b>${lg.picksMade ?? 0}</b></div>
    <div class="ck-h">Recent picks</div>
    <table class="ck-tbl">${recent || `<tr><td class="mut">none yet</td></tr>`}</table>`;
}
let COCKPIT = null;
async function pollCockpit() {
  try { if (window.mc && window.mc.liveState) COCKPIT = await window.mc.liveState(); } catch (e) { COCKPIT = null; }
  renderCockpit();
}
// 1.5s ~= the agent's own tick, so the panel is never more than one decision behind.
setInterval(pollCockpit, 1500);
pollCockpit();

function renderCopilot() { /* Assistant retired -- Claude Code drives the app over CDP instead. */ }
// While a real-agent turn streams, its events route to this message. Set up ONE persistent listener.
let curAgent = null;
if (window.mc && window.mc.onAgentEvent) window.mc.onAgentEvent((e) => {
  if (!curAgent) return;
  const a = curAgent.a; a.pending = false;
  if (e.t === "text") a.parts.push({ t: "text", s: e.s });
  else if (e.t === "tool") a.parts.push({ t: "tool", name: e.name, args: e.args, res: "called" });
  renderCopilot(); // "done" is handled by the agentAsk promise resolving
});

async function sendCopilot(text) {
  copilotLog.push({ role: "user", text });
  const a = { role: "assistant", parts: [] }; copilotLog.push(a);
  renderCopilot();
  if (window.mc && window.mc.agentAsk) { // real Agent SDK session (desktop app)
    a.pending = true; renderCopilot();
    await new Promise((resolve) => {
      curAgent = { a, resolve };
      const fin = () => { a.pending = false; curAgent = null; renderCopilot(); resolve(); };
      window.mc.agentAsk(text).then(fin).catch((err) => { a.parts.push({ t: "text", s: "error: " + String(err) }); fin(); });
    });
    return;
  }
  // stub fallback (browser preview -- no Electron bridge)
  const sink = {
    text: async (s) => { a.parts.push({ t: "text", s }); renderCopilot(); await sleep(120); },
    tool: (name, args) => { a.parts.push({ t: "tool", name, args, res: null }); renderCopilot(); },
    result: async (res) => { const p = [...a.parts].reverse().find(x => x.t === "tool" && x.res === null); if (p) p.res = res; renderCopilot(); await sleep(180); },
    done: () => renderCopilot(),
  };
  try { await stubAgentTurn(text, sink); } catch (e) { a.parts.push({ t: "text", s: "error: " + String(e) }); renderCopilot(); }
}
let MC_AUTH = { authenticated: true }; // default true so browser preview shows the (stub) chat
async function recheckAuth() {
  if (window.mc && window.mc.authStatus) { try { MC_AUTH = await window.mc.authStatus(); } catch (e) { /* keep */ } }
  renderCopilot(); // the copilot is always mounted in the left bar
}
function renderConnect() {
  const view = document.getElementById("view");
  const sub = MC_AUTH.source === "expired" ? "Your Claude login has expired." : "The Assistant runs on your Claude subscription.";
  view.innerHTML = `
    <div class="connect"><div class="connect-card">
      <div class="connect-h">Connect Claude</div>
      <p class="mut">${sub} Log in with your Claude account (Max or Pro) to enable the draft assistant — it runs locally on your subscription, nothing is sent anywhere else.</p>
      <div class="connect-actions">
        <button class="pbtn primary" id="cn-login">Log in with Claude</button>
        <button class="pbtn" id="cn-check">Check again</button>
      </div>
      <p class="connect-note mut">A terminal opens — complete the login there, then click “Check again”.</p>
    </div></div>`;
  document.getElementById("cn-login").onclick = () => { if (window.mc && window.mc.authLogin) window.mc.authLogin(); };
  document.getElementById("cn-check").onclick = () => recheckAuth();
}
function views_copilot() {
  if (window.mc && !MC_AUTH.authenticated) return renderConnect(); // gate the Copilot behind auth
  const view = document.getElementById("view");
  view.innerHTML = `
    <div class="copilot">
      <div class="cop-msgs" id="cop-msgs"></div>
      <div class="cop-input">
        <input id="cop-q" placeholder="Ask the assistant…  (e.g. best available RB)" autocomplete="off">
        <button class="pbtn" id="cop-send">Send</button>
      </div>
    </div>`;
  renderCopilot();
  const q = document.getElementById("cop-q");
  const send = () => { const t = q.value.trim(); if (!t) return; q.value = ""; sendCopilot(t); };
  document.getElementById("cop-send").onclick = send;
  q.onkeydown = e => { if (e.key === "Enter") send(); };
  q.focus();
}

const views = { board: views_board, team: views_team, news: views_news, room: views_room, copilot: views_copilot, live: views_live, sources: views_sources, model: views_model, settings: views_settings };

/* ---------- DATA SOURCES ---------- */
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
// --- Data-warehouse lineage: RENDERED FROM THE ENGINE'S OWN COMPUTED GRAPH, NOT A CURATED LIST ---
//
// Phase 2d made the node LIST derived (from `data-sources`' served table names); this pass finishes
// the job by making the GRAPH itself -- every node, every edge, every layer grouping, and the
// click-to-rebuild id on each node -- come from `window.mc.lineage()`, which is
// `src/lineage/dag.ts`'s `computeLineage()` computed from the ingest registry (src/data/ingest.ts)
// and the feature/trainer registry (src/lineage/registry.ts). There is no WH_CURATED, WH_DERIVE or
// WH_EDGES here any more: this file does not know what a table is FOR, only how to lay out and label
// whatever the engine hands it. Register a producer's reads/writes in one of those two registries and
// the node, its layer, its freshness, and (for an ingest-source asset) its rebuild button all appear
// here with no renderer change.
//
// `lineageNodes`/`lineageEdges` are pure pass-throughs (with a defensive dangling-edge filter) so
// test/dag-derivation.test.ts can prove nothing here silently drops what the engine served.
const LINEAGE_LAYERS = ["external", "raw", "staging", "identity", "feature", "artifact", "table", "consumer", "mart", "scorecard", "model"];
function lineageLayerRank(kind) { const i = LINEAGE_LAYERS.indexOf(kind); return i < 0 ? LINEAGE_LAYERS.length : i; }

/** The served nodes, unmodified. A top-level function (not an inline `d.nodes`) so the test can
 *  assert against it directly and a future change here cannot quietly start filtering. */
function lineageNodes(graph) { return (graph && graph.nodes) || []; }

/** The served edges, dropping only an edge that names a node NOT in `nodes` (defensive against a
 *  partial/fixture graph) -- never dropping one both of whose endpoints exist. */
function lineageEdges(graph, nodes) {
  const ids = new Set((nodes || lineageNodes(graph)).map((n) => n.id));
  return ((graph && graph.edges) || [])
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e) => [e.from, e.to]);
}

function views_sources() {
  document.getElementById("view").innerHTML = `<div class="settings">
    <div class="sec"><h2>Data Warehouse</h2><span class="lbl">lineage DAG, computed from the ingest + feature registries — click a table to re-materialize it</span></div>
    <div id="src-banner" class="setupbanner mut">Loading…</div>
    <div class="btnrow"><button class="pbtn primary" id="src-update">Rebuild all</button><span class="mut" id="src-status"></span></div>
    <div id="dag-wrap"><svg id="dag"></svg></div>
  </div>`;
  document.getElementById("src-update").onclick = async () => {
    if (!window.mc) return; document.getElementById("src-status").textContent = "rebuilding the whole warehouse (~5s)…";
    const r = await window.mc.refreshData();
    document.getElementById("src-status").textContent = r.ok ? "rebuilt — reloading…" : "rebuild failed";
    if (r.ok) setTimeout(() => location.reload(), 900);
  };
  loadDag();
}
async function loadDag() {
  const banner = document.getElementById("src-banner"), svg = document.getElementById("dag");
  if (!banner || !window.mc?.lineage || typeof dagre === "undefined") { if (banner) banner.textContent = "Open inside the app to see the warehouse."; return; }
  const d = await window.mc.lineage().catch(() => null);
  if (!d) { banner.textContent = "Could not read the warehouse."; return; }
  const nodes = lineageNodes(d);
  const edges = lineageEdges(d, nodes);
  const nTables = nodes.filter((n) => n.kind !== "external" && n.kind !== "artifact").length;
  const nSources = nodes.filter((n) => n.kind === "external").length;
  const maxUpdated = nodes.reduce((m, n) => (n.updated && n.updated > m ? n.updated : m), "");
  banner.className = "setupbanner ok";
  banner.innerHTML = `${(d.producers || []).length} declared producers · ${nSources} sources → ${nTables} tables/artifacts → board`
    + (maxUpdated ? ` · freshest write <b>${relTime(maxUpdated)}</b>` : "");
  const W = 156, H = 42;
  const g = new dagre.graphlib.Graph(); g.setGraph({ rankdir: "LR", nodesep: 10, ranksep: 58, marginx: 10, marginy: 10 }); g.setDefaultEdgeLabel(() => ({}));
  const ordered = nodes.slice().sort((a, b) => lineageLayerRank(a.kind) - lineageLayerRank(b.kind) || a.id.localeCompare(b.id));
  for (const n of ordered) g.setNode(n.id, { width: W, height: H });
  for (const [a, b] of edges) g.setEdge(a, b);
  dagre.layout(g);
  const gw = Math.ceil(g.graph().width), gh = Math.ceil(g.graph().height);
  svg.setAttribute("width", gw); svg.setAttribute("height", gh); svg.setAttribute("viewBox", `0 0 ${gw} ${gh}`);
  let h = "";
  for (const e of g.edges()) h += `<polyline points="${g.edge(e).points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" class="dag-edge"/>`;
  for (const n of ordered) {
    const p = g.node(n.id); if (!p) continue;
    const hasDot = n.kind !== "external" && n.kind !== "artifact";
    const dot = hasDot ? freshDot(n.updated) : "";
    const sub = hasDot
      ? `${n.rows == null ? "?" : n.rows} rows${n.updated ? ` · ${relTime(n.updated)}` : ""}`
      : n.kind;
    h += `<g class="dag-node ${n.kind}${n.materialize ? " clickable" : ""}" data-mat="${n.materialize || ""}" data-id="${n.id}" transform="translate(${(p.x - W / 2).toFixed(1)},${(p.y - H / 2).toFixed(1)})">`
      + `<rect width="${W}" height="${H}" rx="6"/>`
      + (dot ? `<circle cx="12" cy="13" r="3.5" class="dot-${dot}"/>` : "")
      + `<text x="${dot ? 22 : 11}" y="17" class="dag-name">${esc(n.id)}</text>`
      + `<text x="11" y="32" class="dag-sub">${esc(String(sub || ""))}</text></g>`;
  }
  svg.innerHTML = h;
  svg.querySelectorAll(".dag-node.clickable").forEach(el => el.onclick = () => materialize(el.dataset.mat, el.dataset.id));
}
// --- MODEL: how a projection is built, and what every fitted piece is worth -----------------------
//
// The Data page shows where a ROW came from and stops at the board -- which is where the interesting
// part starts. A projection is a rank-curve value multiplied by fitted factors, and that product is
// then fed to a simulator that turns points into a title probability. None of it was visible, so a
// number on the board had to be taken on trust.
//
// Trust was misplaced three times in one week. A quarterback was scored on receiving columns for
// twenty seasons and measured ~0 as a result. Sixteen rosters silently lost their defense to a
// nickname-vs-abbreviation join. An unfillable slot scored zero, charging a penalty nobody pays.
// Each was invisible on every screen this app had. That is the argument for the page: a model you
// cannot see is a model nobody checks.
// THE GRAPH IS SERVED, NOT HARDCODED HERE. The engine's src/lineage/modelGraph.ts derives the node
// list from the model registry (so a new model gets a box with no renderer change) and carries the
// curated edges; these two functions are pure pass-throughs, the same contract the Data page's
// lineageNodes/lineageEdges hold. The previous hardcoded MODEL_NODES/MODEL_EDGES drew the pre-Phase-2b
// topology -- age-curve and opportunity feeding a `proj` box labelled "curve x age x opportunity",
// with no node for the trained projection or any weekly/pricing model -- and stayed that way because
// nothing tied it to the registry. See test/model-graph-derivation.test.ts.
function modelGraphNodes(d) { return (d && d.graph && d.graph.nodes) || []; }

/** The served edges, dropping only an edge naming a node NOT in `nodes` (defensive against a
 *  partial/fixture graph) -- never one both of whose endpoints exist. Edges arrive as [from, to]. */
function modelGraphEdges(d, nodes) {
  const ids = new Set((nodes || modelGraphNodes(d)).map((n) => n.id));
  return ((d && d.graph && d.graph.edges) || [])
    .filter((e) => ids.has(e[0]) && ids.has(e[1]))
    .map((e) => [e[0], e[1]]);
}

function views_model() {
  document.getElementById("view").innerHTML = `<div class="settings">
    <div class="sec"><h2>Model</h2><span class="lbl">how a projection is built, and what each fitted piece measured</span></div>
    <div id="mdl-banner" class="setupbanner mut">Loading…</div>
    <div id="mdl-dag-wrap"><svg id="mdl-dag"></svg></div>
    <div class="sec"><h2>Fitted models</h2><span class="lbl">out-of-sample lift under NESTED cross-validation — the honest number</span></div>
    <div id="mdl-table"></div>
    <div class="sec"><h2>Value trace</h2><span class="lbl">the multiplication behind a projection, per player</span></div>
    <div class="btnrow" id="mdl-postabs"></div>
    <div id="mdl-trace"></div>
    <div class="sec"><h2>What serves each position</h2><span class="lbl">the weekly/streaming split -- which artifact answers a start/sit or stream question</span></div>
    <div id="mdl-serve"></div>
    <div class="sec"><h2>Scorecard</h2><span class="lbl">the forward record: predictions frozen before kickoff, and what has been scored so far</span></div>
    <div id="mdl-scorecard"></div>
    <div class="sec"><h2>Prediction ledger</h2><span class="lbl">every pre-registered P&lt;n&gt;/W&lt;n&gt; prediction, transcribed from docs/redesign-2026-09.md</span></div>
    <div id="mdl-ledger"></div>
  </div>`;
  loadModel();
}
let MODEL_DATA = null, MODEL_POS = "QB";
async function loadModel() {
  const banner = document.getElementById("mdl-banner");
  if (!window.mc?.modelGraph) { banner.textContent = "Open inside the app to see the model."; return; }
  const d = await window.mc.modelGraph().catch(() => null);
  if (!d) { banner.textContent = "Could not read the model."; return; }
  MODEL_DATA = d;
  const bad = (d.models || []).filter(m => m.problem);
  // A page about the model must say when the model is BROKEN, not merely draw it. A failing check is
  // the whole reason the registry exists.
  banner.className = "setupbanner " + (bad.length ? "warn" : "ok");
  banner.innerHTML = bad.length
    ? `<b>${bad.length} model(s) failing their own check:</b> ${bad.map(m => `${esc(m.key)} — ${esc(m.problem)}`).join(" · ")}`
    : `${(d.models || []).filter(m => m.present).length} fitted models present and passing · ${esc(String(d.sim?.scoring || ""))} scoring · ${d.sim?.teams || "?"} teams · ${d.sim?.playoffTeams || "?"} make the playoffs`;
  drawModelDag(d);
  drawModelTable(d);
  const positions = [...new Set((d.trace || []).map(t => t.pos))];
  document.getElementById("mdl-postabs").innerHTML = positions
    .map(p => `<button class="pbtn${p === MODEL_POS ? " primary" : ""}" data-pos="${esc(p)}">${esc(p)}</button>`).join("");
  document.querySelectorAll("#mdl-postabs .pbtn").forEach(b => b.onclick = () => {
    MODEL_POS = b.dataset.pos;
    document.querySelectorAll("#mdl-postabs .pbtn").forEach(x => x.classList.toggle("primary", x.dataset.pos === MODEL_POS));
    drawTrace(MODEL_DATA);
  });
  if (!positions.includes(MODEL_POS)) MODEL_POS = positions[0];
  drawTrace(d);
  loadModelPage();
}

// --- THE REGISTRY SECTIONS: serve table, scorecard, ledger -- entirely from window.mc.modelPage() ---
//
// Written 2026-09-08 as static prose describing "a curve times two multipliers", which fell behind
// the moment the projection became a trained artifact with five siblings, a per-position serve table,
// a live scorecard, and a prediction ledger. These three renderers carry NO number of their own: every
// figure comes from the `page` argument (src/lineage/modelPage.ts's JSON). See test/model-page.test.ts.
async function loadModelPage() {
  if (!window.mc?.modelPage) return;
  const page = await window.mc.modelPage().catch(() => null);
  if (!page) return;
  renderWeeklyServe(page);
  renderScorecardSection(page);
  renderLedgerSection(page);
}
function renderWeeklyServe(page) {
  const el = document.getElementById("mdl-serve");
  if (!el) return;
  const rows = (page.weeklyServe || []).map(r => `<tr class="${r.shipped ? "" : "mut"}">
      <td><b>${esc(r.pos)}</b></td><td>${esc(r.artifact)}</td>
      <td class="prose">${r.shipped ? "shipped -- passed its gate" : "not shipped -- serves the floor"}</td></tr>`).join("");
  el.innerHTML = `<div class="mdl-scroll"><table class="tbl"><thead><tr><th>position</th><th>artifact</th><th>status</th></tr></thead>
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
  el.innerHTML = `<div class="mdl-scroll"><table class="tbl"><thead><tr><th>kind</th><th class="num">weeks frozen</th><th class="num">weeks scored</th><th>models &amp; live scores</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}
function renderLedgerSection(page) {
  const el = document.getElementById("mdl-ledger");
  if (!el) return;
  const ledger = page.ledger || { rows: [], counts: {} };
  const counts = ledger.counts || {};
  const summary = Object.entries(counts).map(([k, v]) => `${esc(k)}: ${esc(String(v))}`).join(" · ");
  const rows = (ledger.rows || []).map(r => `<tr class="${r.outcome === "failed" ? "bad" : ""}">
      <td><b>${esc(r.id)}</b></td><td class="prose">${esc(r.claim)}</td><td>${esc(r.outcome)}</td><td class="prose">${esc(r.measured)}</td></tr>`).join("");
  el.innerHTML = `<div class="mut" style="margin-bottom:6px">${summary}</div>
    <div class="mdl-scroll"><table class="tbl"><thead><tr><th>id</th><th>claim</th><th>outcome</th><th>measured</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}
function drawModelDag(d) {
  const svg = document.getElementById("mdl-dag");
  if (typeof dagre === "undefined") { svg.outerHTML = '<div class="mut">Graph library unavailable.</div>'; return; }
  const nodes = modelGraphNodes(d);
  const edges = modelGraphEdges(d, nodes);
  // An EMPTY graph is not a blank canvas -- it means the engine served no topology (an older `ff
  // serve` process still running from before the graph was added, most often). Say so, rather than
  // painting nothing and leaving the reader to guess whether the page or the model is broken.
  if (!nodes.length) {
    svg.outerHTML = '<div class="mut" id="mdl-dag">The engine returned no model graph. If you just updated, fully restart the app (a reload keeps the old engine process).</div>';
    return;
  }
  const byKey = Object.fromEntries((d.models || []).map(m => [m.key, m]));
  const W = 158, H = 44;
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 12, ranksep: 62, marginx: 10, marginy: 10 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: W, height: H });
  for (const [a, b] of edges) g.setEdge(a, b);
  dagre.layout(g);
  const gw = Math.ceil(g.graph().width), gh = Math.ceil(g.graph().height);
  svg.setAttribute("width", gw); svg.setAttribute("height", gh); svg.setAttribute("viewBox", `0 0 ${gw} ${gh}`);
  let h = "";
  for (const e of g.edges()) h += `<polyline points="${g.edge(e).points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" class="dag-edge"/>`;
  for (const n of nodes) {
    const p = g.node(n.id); if (!p) continue;
    const m = byKey[n.id];
    // A model node shows its OWN measured lift, so the graph cannot show a confident box for a
    // component that measured nothing.
    let sub = n.sub;
    if (m) sub = m.problem ? "FAILING CHECK" : (m.nestedLift != null ? `nested R2 +${m.nestedLift.toFixed(4)}` : n.sub);
    const cls = m && m.problem ? "failing" : n.kind;
    h += `<g class="dag-node ${cls}" transform="translate(${(p.x - W / 2).toFixed(1)},${(p.y - H / 2).toFixed(1)})">`
      + `<rect width="${W}" height="${H}" rx="6"/>`
      + `<text x="11" y="17" class="dag-name">${esc(n.name)}</text>`
      + `<text x="11" y="32" class="dag-sub">${esc(String(sub || ""))}</text></g>`;
  }
  svg.innerHTML = h;
}
function drawModelTable(d) {
  const rows = (d.models || []).map(m => {
    // CLAIMED vs MEASURED side by side, permanently. Both shipped models were described at roughly
    // double their real lift for weeks, because the loop that scored them had also chosen them.
    const lift = m.nestedLift != null
      ? `+${m.nestedLift.toFixed(4)}${m.claimedLift != null && Math.abs(m.claimedLift - m.nestedLift) > 1e-6 ? ` <span class="mut">(claimed +${m.claimedLift.toFixed(4)})</span>` : ""}`
      : `<span class="mut">n/a — not a predictive model</span>`;
    return `<tr class="${m.problem ? "bad" : ""}">
      <td><b>${esc(m.key)}</b>${m.required ? "" : ' <span class="mut">optional</span>'}</td>
      <td class="prose">${esc(m.what)}</td>
      <td class="num">${lift}</td>
      <td class="num">${m.present ? `${m.sizeKb}kb · ${m.ageDays}d old${m.seasons ? ` · ${esc(m.seasons)}` : ""}` : '<span class="mut">missing</span>'}</td>
      <td>${m.problem ? `<b>${esc(m.problem)}</b>` : "ok"}</td></tr>`;
  }).join("");
  // Negative results belong on the page too. Without them "K and DST are unfitted" reads as an
  // unfinished task, and the next person spends the same week finding the same nothing.
  const rej = (d.rejected || []).map(r => `<tr class="mut">
      <td><b>${esc(r.key)}</b> <span class="mut">not shipped</span></td>
      <td class="prose">${esc(r.positions.join(" · "))} — screened, fitted, rejected. ${esc(r.why.slice(0, 160))}…</td>
      <td class="num">${Object.entries(r.nestedLift).map(([k, v]) => `${esc(k)} ${v > 0 ? "+" : ""}${v.toFixed(4)}`).join(" · ")}</td>
      <td class="num">${esc(r.date)}</td>
      <td>—</td></tr>`).join("");
  document.getElementById("mdl-table").innerHTML =
    `<div class="mdl-scroll"><table class="tbl"><thead><tr><th>model</th><th>what it measures</th><th class="num">nested lift</th><th class="num">artifact</th><th>check</th></tr></thead>
     <tbody>${rows}${rej}</tbody></table></div>`;
}
function drawTrace(d) {
  const t = (d.trace || []).filter(x => x.pos === MODEL_POS);
  if (!t.length) { document.getElementById("mdl-trace").innerHTML = '<div class="mut">No trace for this position.</div>'; return; }
  const pct = (f) => `${f >= 1 ? "+" : ""}${((f - 1) * 100).toFixed(1)}%`;
  const cell = (f) => `<td class="num ${Math.abs(f - 1) < 0.0005 ? "mut" : f > 1 ? "up" : "down"}">${f.toFixed(3)} <span class="mut">${pct(f)}</span></td>`;
  document.getElementById("mdl-trace").innerHTML =
    `<div class="mdl-scroll"><table class="tbl"><thead><tr><th class="num">#</th><th>player</th><th class="num">rank curve</th><th class="num">age</th><th class="num">opportunity</th><th class="num">projection</th><th class="num">net</th></tr></thead><tbody>` +
    t.map(x => `<tr><td class="num mut">${x.rank}</td><td><b>${esc(x.name)}</b></td>
      <td class="num">${x.base.toFixed(1)}</td>${cell(x.age)}${cell(x.opp)}
      <td class="num"><b>${x.final.toFixed(1)}</b></td>
      <td class="num ${x.final >= x.base ? "up" : "down"}">${(x.final - x.base >= 0 ? "+" : "")}${(x.final - x.base).toFixed(1)}</td></tr>`).join("") +
    `</tbody></table></div>
     <div class="mut" style="margin-top:8px">
       A factor of exactly 1.000 means the model had no opinion — an unknown birth date, a rookie with
       no prior usage, or a position it measured no signal for. That is deliberate: a missing input
       produces no adjustment rather than a guess.
     </div>`;
}

async function materialize(mat, nodeId) {
  if (!window.mc?.ingestSource || !mat) return;
  document.querySelectorAll(`.dag-node[data-mat="${mat}"]`).forEach(el => el.classList.add("running"));
  const st = document.getElementById("src-status"); if (st) st.textContent = `materializing ${nodeId} → rebuilding board…`;
  const r = await window.mc.ingestSource(mat).catch(() => ({ ok: false }));
  if (st) st.textContent = r.ok ? `${nodeId} + board re-materialized` : `failed to materialize ${nodeId}`;
  await loadDag(); // refresh freshness across the warehouse
  try { const ad = await window.mc.appData(); if (ad?.players?.length) { DATA = ad.players; byName = new Map(DATA.map(p => [p.Player, p])); } } catch (e) { /* keep */ }
}

// Boot: in Electron, pull the live board + news from the SQLite store (via the ff engine) before
// the first paint; otherwise render the embedded data.js fallback. Either way, paint the board.
//
// THE FALLBACK MUST ANNOUNCE ITSELF. data.js is a checked-in snapshot that nothing regenerates any
// more (the engine replaced it -- see the note at src/ff.ts `app-data`), and it renders IDENTICALLY
// to live data. So every way the live path can fail -- opened in a browser with no window.mc, engine
// crash, empty board, a season in config that the board has no rows for -- used to degrade in
// silence to a snapshot whose numbers are entirely plausible and simply old. That is how a rebuilt
// board "does not update": it did update, and the UI was never reading it. The stale numbers even
// look right, which is what makes it expensive. Record WHICH source won and say so on screen.
let DATA_SOURCE = { live: false, why: "not attempted", stamp: window.DATA_JS_STAMP || "unknown" };

// THE OTHER HALF OF THE SAME PROBLEM. The banner below catches "the renderer never had live data".
// This catches "the renderer HAD live data and it went out of date underneath it": the board is
// loaded once at boot, so a `ff refresh` run from a terminal rewrites SQLite while the window keeps
// serving the numbers it read at startup. Nothing was broken in that case and nothing said anything
// -- which is exactly why a rebuilt board appears not to have rebuilt. Poll the engine's cheap
// builtAt stamp and offer a reload when it moves.
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
        DATA = d.players; NEWS = Array.isArray(d.news) ? d.news : []; CFG = d.config || CFG;
        byName = new Map(DATA.map(p => [p.Player, p]));
        const sp = document.getElementById("s-players"); if (sp) sp.textContent = DATA.length;
        seenAt = d.builtAt || stamp;              // adopt the new baseline; do not re-fire on it
        // Re-render the current page -- EXCEPT an ESPN page, whose setPage re-navigates the webview
        // and would yank the draft room out from under whoever is watching it.
        const pg = PAGES.find(p => p.id === curPage);
        if (!pg || pg.kind !== "espn") setPage(curPage);
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
// nobody notices, so it must survive on screen for as long as the stale data does.
function showStaleBanner(src) {
  if (document.getElementById("stale-banner")) return;
  const b = document.createElement("div");
  b.id = "stale-banner";
  b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:#7f1d1d;color:#fff;" +
    "font:600 12px/1.5 system-ui,sans-serif;padding:6px 12px;text-align:center;letter-spacing:.02em";
  b.textContent = `SNAPSHOT DATA from ${src.stamp} -- NOT the live board. Rebuilds will not appear here. Reason: ${src.why}`;
  document.body.appendChild(b);
  document.body.style.paddingTop = "28px";
}
async function boot() {
  if (window.mc && window.mc.appData) {
    try {
      const d = await window.mc.appData();
      if (d && Array.isArray(d.players) && d.players.length) {
        DATA = d.players; NEWS = Array.isArray(d.news) ? d.news : []; CFG = d.config || CFG;
        if (Array.isArray(d.leverSpecs)) LEVER_SPECS_UI = d.leverSpecs; // engine owns the lever table
        byName = new Map(DATA.map(p => [p.Player, p]));
        const sp = document.getElementById("s-players"); if (sp) sp.textContent = DATA.length;
        DATA_SOURCE = { live: true, why: "", stamp: "", builtAt: d.builtAt || null };
        watchForRebuild(d.builtAt || null);
      } else {
        // The call SUCCEEDED and returned nothing. Distinct from a throw, and the likelier bug:
        // appDataPayload queries `board` for config.season, so a season with no rows yields an
        // empty array rather than an error.
        DATA_SOURCE.why = `engine returned ${d && d.players ? d.players.length : 0} players for season ${(d && d.config && d.config.season) || "?"}`;
      }
    } catch (e) {
      DATA_SOURCE.why = `engine call failed: ${e && e.message ? e.message : e}`;
    }
  } else {
    DATA_SOURCE.why = "no engine bridge (window.mc) -- this is a browser preview, not the app";
  }
  if (!DATA_SOURCE.live) showStaleBanner(DATA_SOURCE);
  // team source of truth is the store (my_roster via the helper); localStorage is the browser fallback
  if (window.mc && window.mc.teamGet) {
    try { const t = await window.mc.teamGet(); if (Array.isArray(t)) TEAM = t; } catch (e) { /* keep localStorage */ }
  }
  if (window.mc && window.mc.authStatus) { try { MC_AUTH = await window.mc.authStatus(); } catch (e) { /* keep default */ } }
  // PUSH for the Data/Model pages, same principle as watchForRebuild's board push: refresh the page
  // in place if it happens to be the one open when the engine's lineage/model stamp moves, rather
  // than making the user notice it went stale and reload.
  if (window.mc.onLineageChanged) window.mc.onLineageChanged(() => { if (curPage === "sources") loadDag(); });
  if (window.mc.onModelsChanged) window.mc.onModelsChanged(() => { if (curPage === "model") loadModel(); });
  wireWebview(); // the persistent ESPN browsing surface (always mounted, always CDP-navigable)
  syncTeam();
  initCopilot();          // the Copilot lives in the left bar now -- always present
  await renderLeagueTabs(); // top row: the league(s); sets ACTIVE_LEAGUE for the ESPN pages
  renderPageTabs();       // second row: Board + ESPN pages for the active league
  // sync who-owns-what for the active league (empty pre-draft), then refresh the board overlay
  if (window.mc && window.mc.syncRosters && ACTIVE_LEAGUE) {
    window.mc.syncRosters().then(() => window.mc.ownership()).then(o => { OWNERSHIP = (o && o.ownership) || {}; if (cur === "board") drawBody(); }).catch(() => {});
  }
  // (Assistant subtitle stays "Mission Control" -- it's app-wide, not tied to one league.)
  // Fresh install (no board yet) lands on Setup so the user onboards; otherwise the Board.
  const fresh = window.mc && (!DATA || DATA.length === 0);
  setPage(fresh ? "settings" : "board");
}
// The Copilot chat is mounted once in #agent (always present). Wire its input + paint the log.
function initCopilot() {
  renderCopilot();
  const q = document.getElementById("cop-q"); if (!q) return;
  const send = () => { const t = q.value.trim(); if (!t) return; q.value = ""; sendCopilot(t); };
  const sb = document.getElementById("cop-send"); if (sb) sb.onclick = send;
  q.onkeydown = e => { if (e.key === "Enter") send(); };
}
boot();
