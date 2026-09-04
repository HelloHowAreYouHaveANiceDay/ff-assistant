// Fantasy Mission Control renderer. In Electron the data is read LIVE from the SQLite store via
// window.mc.appData() (the ff engine reads the DB); data.js is the fallback for browser preview.
let DATA = window.PLAYERS || [];
let NEWS = window.NEWS || [];
let CFG = window.CONFIG || { budget: 200, slots: ["QB","RB","RB","WR","WR","TE","FLEX","K","DST","BE","BE","BE"], flex_ok: ["RB","WR","TE"] };
const YR = window.LAST_YR || "LastYr";
let byName = new Map(DATA.map(p => [p.Player, p]));
document.getElementById("s-players").textContent = DATA.length;

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
  document.getElementById("s-roster").textContent = `${TEAM.length}/${CFG.slots.length}  $${spent()}`;
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
const TITLES = { board: "Players", team: "My Team", news: "News", room: "Draft Room", copilot: "Copilot", live: "Live Draft", sources: "Data Sources", settings: "Settings" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let cur = "board";
function setView(v) {
  if (roomTimer) { clearInterval(roomTimer); roomTimer = null; }
  cur = v;
  document.querySelectorAll(".nv").forEach(b => b.classList.toggle("on", b.dataset.view === v));
  document.getElementById("crumb").textContent = TITLES[v] || "Players";
  // Live Draft = the persistent webview layer (kept mounted so it stays a CDP target); other views
  // render into #view. In browser preview (no window.mc) there's no webview, so fall through.
  const showWebview = v === "live" && !!window.mc;
  const wl = document.getElementById("webview-layer"); if (wl) wl.classList.toggle("off", !showWebview);
  (views[v] || views.board)(); // #view still renders (covered by the webview layer when live)
}
document.querySelectorAll(".nv").forEach(b => b.onclick = () => setView(b.dataset.view));

/* ---------- DRAFT BOARD ---------- */
const COLS = [
 ["act","","act"],["Rank","#","num"],["Player","Player","player"],["Pos","Pos","pos"],
 ["Us_Pos","Us","t"],["ECR_Pos","ECR","t"],["ESPN_Pos","ESPN","t"],["Tier","Tier","t"],
 ["Team","Team","team"],["Bye","Bye","num"],["Age","Age","num"],
 ["OurValue$","Val$","val"],["vsECR","vsECR","delta"],
 ["ADP","ADP","num1"],["vsADP","vsADP","delta"],["Mkt30d","Mkt30d","delta"],
 ["ProjPts","Proj","num1"],
 [YR+"Pts",YR+"Pts","num1"],[YR+"Gms",YR+"G","gms"],
 ["ECR","ECR","num1"],["ESPN_Rank","ESPN#","num"],["ESPN_ADP","eADP","num1"],["Rostered%","Own%","num"],
 ["flags","News / Flags","flags"]
];
const LEFT = new Set(["player","pos","flags","t","act"]);
// columns where higher = better -> first click sorts descending (best first); everything else ascending
const DESC_FIRST = new Set(["OurValue$","vsECR","vsADP","Mkt30d","ProjPts",YR+"Pts",YR+"Gms","Rostered%"]);
const POS = ["ALL","QB","RB","WR","TE","K","DST"];
let bst = { q:"", pos:"ALL", sleep:false, avail:false, hideDrafted:false, sort:"Rank", dir:1 };

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
function sortVal(r,k) { if (k==="flags"||k==="act") return 0; const n = num(r[k]); return n==null ? (typeof r[k]==="string"?r[k]:1e9) : n; }
function cell(r,k,kind) {
  if (kind==="act") { const on = onTeam(r.Player); return `<td class="l"><button class="add ${on?'on':''}" data-add="${esc(r.Player)}" title="${on?'Drafted (click to remove)':'Draft to my team'}">${on?'&#10003;':'+'}</button></td>`; }
  if (kind==="player") return `<td class="l pl">${esc(r.Player)}</td>`;
  if (kind==="pos") return `<td class="l"><span class="pos ${r.Pos}">${esc(r.Pos)}</span></td>`;
  if (kind==="team") return `<td class="l">${teamChip(r.Team)}</td>`;
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
let nst = { cat: "all" };
function views_news() {
  const cats = [["all","All"],["headline","Headlines"],["injury","Injuries"],["trending","Buzz"]];
  const prio = { injury:0, headline:1, trending:2 };
  document.getElementById("view").innerHTML = `
    <div class="toolbar"><div class="pills" id="ncat"></div><span class="count">${NEWS.length} items</span></div>
    <div class="feed" id="feed"></div>`;
  const el = document.getElementById("ncat");
  cats.forEach(([k,l]) => { const b = document.createElement("div"); b.className = "pill"+(k===nst.cat?" on":""); b.textContent = l;
    b.onclick = () => { nst.cat = k; [...el.children].forEach(c=>c.classList.toggle("on",c.textContent===l)); drawFeed(); }; el.appendChild(b); });
  drawFeed();
  function drawFeed() {
    let items = NEWS.filter(n => nst.cat==="all" || n.category===nst.cat);
    items.sort((a,b) => (prio[a.category]-prio[b.category]) || String(b.asof).localeCompare(String(a.asof)));
    document.getElementById("feed").innerHTML = items.slice(0, 400).map(n => {
      const val = (byName.get(n.player)||{})["OurValue$"];
      const tag = n.category==="injury"?`<span class="badge b-out">${esc((n.detail||"").split(" - ")[0])}</span>`
        : n.category==="trending"?`<span class="badge ${/add/.test(n.source)?'b-add':'b-drop'}">${/add/.test(n.source)?'+ADD':'-DROP'}</span>` : "";
      const body = n.url ? `<a href="#" onclick="return openUrl('${esc(n.url)}')">${esc(n.detail)}</a>` : esc(n.detail);
      return `<div class="feeditem"><div class="fhead"><span class="pl">${esc(n.player)}</span> <span class="pos ${n.pos}">${esc(n.pos)}</span>${val?`<span class="mut"> · $${val}</span>`:""} ${tag}<span class="fsrc mut">${esc(n.source)} · ${esc(n.asof)}</span></div><div class="fbody">${body}</div></div>`;
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
    for (const [k, , , , , board] of LEVERS_UI) {
      const el = document.getElementById("lv-" + k); if (!el) continue;
      const v = Number(el.value); patch[k] = v;
      if (board && v !== (CFG.levers?.[k])) boardChanged = true;
    }
    const next = await window.mc.setLevers(patch);
    if (next) CFG.levers = next;
    log.textContent = "Levers saved." + (boardChanged ? " Board levers changed — rebuilding..." : " Bidding/UI levers apply now.");
    if (boardChanged) return build();
    renderLevers(); drawBody && drawBody();
  };
  document.getElementById("reset-levers").onclick = async () => {
    const defaults = { tierBreak: 0.75, maxKDst: 2, starterReserve: 15, benchReserve: 1, maxShare: 0.35, aggr: 1.0, premium: 2, sleeperThreshold: 5 };
    const next = await window.mc?.setLevers?.(defaults); if (next) CFG.levers = next;
    renderLevers(); log.textContent = "Levers reset to defaults. Run Refresh to rebuild the board.";
  };
  loadLeagueStatus();
}

// [key, label, min, max, step, affectsBoard, help]
const LEVERS_UI = [
  ["tierBreak", "Tier break", 0.5, 0.95, 0.01, true, "Lower = fewer, bigger tiers"],
  ["maxKDst", "Max K/DST $", 1, 10, 1, true, "Cap on kicker/defense price"],
  ["starterReserve", "Starter reserve $", 0, 60, 1, false, "Held back for unfilled starters"],
  ["benchReserve", "Bench reserve $", 0, 10, 1, false, "Held back per bench slot"],
  ["maxShare", "Max share", 0.1, 0.7, 0.01, false, "Max fraction of budget on one player"],
  ["aggr", "Aggressiveness", 0.5, 2, 0.05, false, ">1 chases, <1 waits for value"],
  ["premium", "Outbid premium $", 0, 10, 1, false, "Extra $ to win a targeted player"],
  ["sleeperThreshold", "Sleeper cutoff (vsECR)", 1, 20, 1, false, "Min vsECR for the SLEEPERS filter"],
];
function renderLevers() {
  const box = document.getElementById("levers-box"); if (!box) return;
  const lv = CFG.levers || {};
  box.innerHTML = LEVERS_UI.map(([k, label, min, max, step, board, help]) =>
    `<div class="leverrow"><label for="lv-${k}"><b>${label}</b>${board ? ' <span class="tag">board</span>' : ""}<span class="mut"> ${help}</span></label>` +
    `<input id="lv-${k}" type="number" min="${min}" max="${max}" step="${step}" value="${lv[k] ?? ""}"></div>`).join("");
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

let copilotLog = [{ role: "assistant", parts: [{ t: "text", s: "Hi — I’m your draft copilot. Ask me anything about the board: “best available RB”, “is Josh Jacobs a value?”, “who should I target at WR?”. I read the live value board to answer." }] }];
function renderCopilot() {
  const el = document.getElementById("cop-msgs"); if (!el) return;
  el.innerHTML = copilotLog.map(m => {
    if (m.role === "user") return `<div class="cmsg cuser"><div class="cbody">${esc(m.text)}</div></div>`;
    const body = m.parts.map(p => p.t === "text"
      ? `<div class="ctext">${esc(p.s)}</div>`
      : `<div class="ctool"><span class="chip">&#9881;&#65039; ${esc(p.name)}(${esc(fmtArgs(p.args))})</span> <span class="cres mut">${p.res != null ? esc(p.res) : "…"}</span></div>`).join("");
    const pend = m.pending ? `<div class="ctext mut">…thinking</div>` : "";
    return `<div class="cmsg casst"><div class="cbody">${body}${pend}</div></div>`;
  }).join("");
  el.scrollTop = el.scrollHeight;
}
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
  if (cur === "copilot") views_copilot();
}
function renderConnect() {
  const view = document.getElementById("view");
  const sub = MC_AUTH.source === "expired" ? "Your Claude login has expired." : "The Copilot runs on your Claude subscription.";
  view.innerHTML = `
    <div class="connect"><div class="connect-card">
      <div class="connect-h">Connect Claude</div>
      <p class="mut">${sub} Log in with your Claude account (Max or Pro) to enable the draft copilot — it runs locally on your subscription, nothing is sent anywhere else.</p>
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
        <input id="cop-q" placeholder="Ask the copilot…  (e.g. best available RB)" autocomplete="off">
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

const views = { board: views_board, team: views_team, news: views_news, room: views_room, copilot: views_copilot, live: views_live, sources: views_sources, settings: views_settings };

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
// pipeline edges: sources fan into assemble (ECR also drives the projection curve) -> board
const DAG_EDGES = [["ecr", "projections"], ["league", "projections"], ["projections", "assemble"], ["assemble", "board"]]
  .concat(["bio", "advanced", "trade", "weekly", "status", "odds", "boris", "adp", "market", "news", "league"].map(s => [s, "assemble"]));
function views_sources() {
  document.getElementById("view").innerHTML = `<div class="settings">
    <div class="sec"><h2>Data Sources</h2><span class="lbl">pipeline DAG — click a source to update just it</span></div>
    <div id="src-banner" class="setupbanner mut">Loading…</div>
    <div class="btnrow"><button class="pbtn primary" id="src-update">Update all</button><span class="mut" id="src-status"></span></div>
    <div id="dag-wrap"><svg id="dag"></svg></div>
  </div>`;
  document.getElementById("src-update").onclick = async () => {
    if (!window.mc) return; document.getElementById("src-status").textContent = "updating all sources (~5s)…";
    const r = await window.mc.refreshData();
    document.getElementById("src-status").textContent = r.ok ? "all sources updated — reloading…" : "update failed";
    if (r.ok) setTimeout(() => location.reload(), 900);
  };
  loadDag();
}
async function loadDag() {
  const banner = document.getElementById("src-banner"), svg = document.getElementById("dag");
  if (!banner || !window.mc?.dataSources || typeof dagre === "undefined") { if (banner) banner.textContent = "Open inside the app to see the pipeline."; return; }
  const d = await window.mc.dataSources().catch(() => null);
  if (!d) { banner.textContent = "Could not read sources."; return; }
  banner.className = "setupbanner ok";
  banner.innerHTML = `Last full refresh <b>${relTime(d.lastIngest)}</b> · ${d.sources.length} sources → projections → assemble → board`;
  const nodes = {};
  for (const s of d.sources) nodes[s.id] = { ...s, kind: "source" };
  nodes.projections = { id: "projections", name: "projections", sub: "VOR curve", kind: "transform" };
  nodes.assemble = { id: "assemble", name: "assemble", sub: "values · tiers · vsADP", kind: "transform" };
  nodes.board = { id: "board", name: "board", sub: (d.sources.find(s => s.id === "ecr")?.rows || "") && "the Players view", kind: "output" };
  const W = 170, H = 46;
  const g = new dagre.graphlib.Graph(); g.setGraph({ rankdir: "LR", nodesep: 14, ranksep: 66, marginx: 10, marginy: 10 }); g.setDefaultEdgeLabel(() => ({}));
  for (const id in nodes) g.setNode(id, { width: W, height: H });
  for (const [a, b] of DAG_EDGES) if (nodes[a] && nodes[b]) g.setEdge(a, b);
  dagre.layout(g);
  const gw = Math.ceil(g.graph().width), gh = Math.ceil(g.graph().height);
  svg.setAttribute("width", gw); svg.setAttribute("height", gh); svg.setAttribute("viewBox", `0 0 ${gw} ${gh}`);
  let h = "";
  for (const e of g.edges()) h += `<polyline points="${g.edge(e).points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" class="dag-edge"/>`;
  for (const id in nodes) {
    const n = nodes[id], p = g.node(id); if (!p) continue;
    const dot = n.kind === "source" ? freshDot(n.updated) : "";
    const sub = n.kind === "source" ? `${n.rows} · ${relTime(n.updated)}` : n.sub;
    h += `<g class="dag-node ${n.kind}" data-id="${id}" transform="translate(${(p.x - W / 2).toFixed(1)},${(p.y - H / 2).toFixed(1)})">`
      + `<rect width="${W}" height="${H}" rx="7"/>`
      + (dot ? `<circle cx="13" cy="14" r="4" class="dot-${dot}"/>` : "")
      + `<text x="${dot ? 24 : 12}" y="18" class="dag-name">${esc(n.name)}</text>`
      + `<text x="12" y="35" class="dag-sub">${esc(String(sub || ""))}</text></g>`;
  }
  svg.innerHTML = h;
  svg.querySelectorAll(".dag-node.source").forEach(el => el.onclick = () => materialize(el.dataset.id));
}
async function materialize(id) {
  if (!window.mc?.ingestSource) return;
  const el = document.querySelector(`.dag-node[data-id="${id}"]`); if (el) el.classList.add("running");
  const st = document.getElementById("src-status"); if (st) st.textContent = `materializing ${id} → rebuilding board…`;
  const r = await window.mc.ingestSource(id).catch(() => ({ ok: false }));
  if (st) st.textContent = r.ok ? `${id} updated` : `failed to update ${id}`;
  await loadDag(); // refresh freshness dots
  try { const ad = await window.mc.appData(); if (ad?.players?.length) { DATA = ad.players; byName = new Map(DATA.map(p => [p.Player, p])); } } catch (e) { /* keep */ }
}

// Boot: in Electron, pull the live board + news from the SQLite store (via the ff engine) before
// the first paint; otherwise render the embedded data.js fallback. Either way, paint the board.
async function boot() {
  if (window.mc && window.mc.appData) {
    try {
      const d = await window.mc.appData();
      if (d && Array.isArray(d.players) && d.players.length) {
        DATA = d.players; NEWS = Array.isArray(d.news) ? d.news : []; CFG = d.config || CFG;
        byName = new Map(DATA.map(p => [p.Player, p]));
        const sp = document.getElementById("s-players"); if (sp) sp.textContent = DATA.length;
      }
    } catch (e) { /* fall back to embedded data.js */ }
  }
  // team source of truth is the store (my_roster via the helper); localStorage is the browser fallback
  if (window.mc && window.mc.teamGet) {
    try { const t = await window.mc.teamGet(); if (Array.isArray(t)) TEAM = t; } catch (e) { /* keep localStorage */ }
  }
  if (window.mc && window.mc.authStatus) { try { MC_AUTH = await window.mc.authStatus(); } catch (e) { /* keep default */ } }
  wireWebview(); // the persistent ESPN browsing surface (always mounted, always CDP-navigable)
  syncTeam();
  const yr = CFG.season || new Date().getFullYear(); // season label from config, not hardcoded
  const bs = document.getElementById("brand-season"); if (bs) bs.textContent = "Fantasy " + yr;
  const vs = document.getElementById("values-season"); if (vs) vs.textContent = "Values: " + yr;
  // Fresh install (no board yet) lands on Setup so the user onboards; otherwise the Players board.
  const fresh = window.mc && (!DATA || DATA.length === 0);
  setView(fresh ? "settings" : "board");
}
boot();
