// Fantasy Mission Control renderer. Data injected by data.js; engine bridge on window.mc (Electron).
const DATA = window.PLAYERS || [];
const NEWS = window.NEWS || [];
const CFG = window.CONFIG || { budget: 200, slots: ["QB","RB","RB","WR","WR","TE","FLEX","K","DST","BE","BE","BE"], flex_ok: ["RB","WR","TE"] };
const YR = window.LAST_YR || "LastYr";
const byName = new Map(DATA.map(p => [p.Player, p]));
document.getElementById("s-players").textContent = DATA.length;

const num = v => (v === "" || v == null || isNaN(v)) ? null : +v;
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
window.openUrl = u => { if (window.mc) window.mc.openExternal(u); else window.open(u, "_blank"); return false; };

/* ---------- my team (persisted) ---------- */
let TEAM = (() => { try { return JSON.parse(localStorage.getItem("mc_team") || "[]"); } catch { return []; } })();
const saveTeam = () => localStorage.setItem("mc_team", JSON.stringify(TEAM));
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
const TITLES = { board: "Draft Board", team: "My Team", news: "News", room: "Draft Room", settings: "Settings" };
let cur = "board";
function setView(v) {
  if (roomTimer) { clearInterval(roomTimer); roomTimer = null; }
  cur = v;
  document.querySelectorAll(".nv").forEach(b => b.classList.toggle("on", b.dataset.view === v));
  document.getElementById("crumb").textContent = TITLES[v] || "Draft Board";
  (views[v] || views.board)();
}
document.querySelectorAll(".nv").forEach(b => b.onclick = () => setView(b.dataset.view));

/* ---------- DRAFT BOARD ---------- */
const COLS = [
 ["act","","act"],["Rank","#","num"],["Player","Player","player"],["Pos","Pos","pos"],
 ["Us_Pos","Us","t"],["ECR_Pos","ECR","t"],["ESPN_Pos","ESPN","t"],["Tier","Tier","t"],
 ["Team","Tm","t"],["Bye","Bye","num"],["Age","Age","num"],
 ["OurValue$","Val$","val"],["vsECR","vsECR","delta"],["ProjPts","Proj","num1"],
 [YR+"Pts",YR+"Pts","num1"],[YR+"Gms",YR+"G","gms"],
 ["ECR","ECR","num1"],["ESPN_Rank","ESPN#","num"],["ESPN_ADP","ADP","num1"],["Rostered%","Own%","num"],
 ["flags","News / Flags","flags"]
];
const LEFT = new Set(["player","pos","flags","t","act"]);
const POS = ["ALL","QB","RB","WR","TE","K","DST"];
let bst = { q:"", pos:"ALL", sleep:false, avail:false, hideDrafted:false, sort:"Rank", dir:1 };

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
  document.getElementById("q").oninput = e => { bst.q = e.target.value.toLowerCase(); drawBody(); };
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
    if (bst.sort===k) bst.dir *= -1; else { bst.sort = k; bst.dir = 1; } thead(); drawBody(); });
}
function sortVal(r,k) { if (k==="flags"||k==="act") return 0; const n = num(r[k]); return n==null ? (typeof r[k]==="string"?r[k]:1e9) : n; }
function cell(r,k,kind) {
  if (kind==="act") { const on = onTeam(r.Player); return `<td class="l"><button class="add ${on?'on':''}" data-add="${esc(r.Player)}" title="${on?'Drafted (click to remove)':'Draft to my team'}">${on?'&#10003;':'+'}</button></td>`; }
  if (kind==="player") return `<td class="l pl">${esc(r.Player)}</td>`;
  if (kind==="pos") return `<td class="l"><span class="pos ${r.Pos}">${esc(r.Pos)}</span></td>`;
  if (kind==="val") return `<td class="val">$${esc(r["OurValue$"])}</td>`;
  if (kind==="delta") { const v = num(r.vsECR); return `<td class="${v>0?'pos-hi':(v<0?'neg-hi':'')}">${v==null?"":(v>0?"+"+v:v)}</td>`; }
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
    return `<td class="l"><span>${b}</span> <span class="news mut">${nh}</span></td>`;
  }
  return `<td class="l">${esc(r[k])}</td>`;
}
function drawBody() {
  let rs = DATA.filter(r => {
    if (bst.q && !r.Player.toLowerCase().includes(bst.q)) return false;
    if (bst.pos!=="ALL" && r.Pos!==bst.pos) return false;
    if (bst.sleep && !(num(r.vsECR)>5)) return false;
    if (bst.avail && /Out/i.test(r.Injury||"")) return false;
    if (bst.hideDrafted && onTeam(r.Player)) return false;
    return true;
  });
  rs.sort((a,b) => { const x = sortVal(a,bst.sort), y = sortVal(b,bst.sort); return (x<y?-1:x>y?1:0)*bst.dir; });
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
      ${TEAM.length? "" : '<div class="hint mut">Draft players from the Draft Board (the + button) to build your roster here.</div>'}
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

/* ---------- DRAFT ROOM (live cockpit) ---------- */
let roomTimer = null;
function views_room() {
  document.getElementById("view").innerHTML = `<div id="room"></div>`;
  drawRoom();
  if (window.mc) roomTimer = setInterval(drawRoom, 4000);
}
async function drawRoom() {
  const el = document.getElementById("room"); if (!el) return;
  const st = window.mc ? await window.mc.draftState() : null;
  const live = st && st.data && st.ageSec < 120;
  setStatus(live ? "green" : "amber", live ? `Draft: LIVE (${st.data.picksMade||0} picks)` : "Draft: not connected");
  if (!st || !st.data) {
    el.innerHTML = `<div class="placeholder"><div class="big">&#9889;</div><h2>Draft Room</h2>
      <p>No live draft detected. Start the engine, then this fills with live state, the board of best-available players, and live inflation.</p>
      <pre class="cmd">cd H:/working/ff-assistant
npm run ff -- launch-practice   # or enter-draft for the real league
npm run ff -- auto-draft --csv data/values.csv</pre>
      ${window.mc?"":'<p class="mut">(Live state reads the draft-log the engine writes — available when running inside the app.)</p>'}</div>`;
    return;
  }
  const d = st.data;
  const drafted = new Set((d.picks||[]).map(p => p.name));
  const avail = DATA.filter(p => !drafted.has(p.Player)).sort((a,b)=>(+b["OurValue$"])-(+a["OurValue$"]));
  const infl = d.liveInflation ? d.liveInflation.toFixed(2) : "—";
  const recent = (d.picks||[]).slice(-12).reverse();
  el.innerHTML = `
    <div class="team-stats">
      ${stat("Picks made", d.picksMade||(d.picks||[]).length)}${stat("League $ left", "$"+(d.remainingDollars||0))}
      ${stat("Inflation", infl, +infl<0.9?"bad":(+infl>1.1?"":"" ))}${stat("Log age", st.ageSec+"s")}
    </div>
    <div class="team-body">
      <div class="roster"><div class="sec"><h2>Best available</h2><span class="lbl">undrafted · by our value</span></div>
        <table class="rtbl">${avail.slice(0,18).map(p=>`<tr><td class="l"><span class="pos ${p.Pos}">${p.Pos}</span> <b>${esc(p.Player)}</b></td><td class="val">$${p["OurValue$"]}</td><td class="mut">ECR ${p.ECR}</td></tr>`).join("")}</table>
      </div>
      <div class="needs"><div class="sec"><h2>Recent picks</h2><span class="lbl">live feed</span></div>
        ${recent.map(p=>`<div class="needrow"><span class="l">${esc(p.name)} <span class="mut">${esc(p.pos||"")}</span></span><b>$${p.price}</b></div>`).join("")||'<div class="mut">—</div>'}
      </div>
    </div>`;
}

/* ---------- SETTINGS ---------- */
function views_settings() {
  document.getElementById("view").innerHTML = `
    <div class="settings">
      <div class="sec"><h2>League</h2><span class="lbl">config</span></div>
      <div class="kv"><span>Season</span><b>${CFG.season||2026}</b></div>
      <div class="kv"><span>Budget</span><b>$${CFG.budget}</b></div>
      <div class="kv"><span>Roster</span><b>${CFG.slots.join(" · ")}</b></div>
      <div class="kv"><span>Players loaded</span><b>${DATA.length}</b></div>
      <div class="sec" style="margin-top:24px"><h2>Data</h2><span class="lbl">refresh · publish</span></div>
      <div class="btnrow">
        <button class="pbtn" id="refresh">Refresh values + news</button>
        <button class="pbtn" id="push">Push to Google Sheet</button>
        <button class="pbtn" id="reteam">Clear my team</button>
      </div>
      <pre class="cmd" id="log">Ready.</pre>
      ${window.mc?"":'<p class="mut">Refresh/Push run the engine tools — available when running inside the app.</p>'}
    </div>`;
  const log = document.getElementById("log");
  document.getElementById("reteam").onclick = () => { if (confirm("Clear your drafted team?")) { TEAM = []; saveTeam(); syncTeam(); log.textContent = "Team cleared."; } };
  document.getElementById("refresh").onclick = async () => {
    if (!window.mc) return log.textContent = "Run inside the app to refresh.";
    log.textContent = "Rebuilding values + report + app data (nflverse fetch, ~2 min)...";
    const r = await window.mc.refreshData(); log.textContent = r.out || "done";
    if (r.ok) { log.textContent += "\nReloading..."; setTimeout(() => location.reload(), 800); }
  };
  document.getElementById("push").onclick = async () => {
    if (!window.mc) return log.textContent = "Run inside the app to push.";
    log.textContent = "Pushing to Google Sheet via bim-cli..."; const r = await window.mc.pushSheet(""); log.textContent = r.out || "done";
  };
}

function setStatus(dot, text) { const el = document.getElementById("draftstatus"); if (el) el.innerHTML = `<i class="dot ${dot}"></i> ${esc(text)}`; }

const views = { board: views_board, team: views_team, news: views_news, room: views_room, settings: views_settings };
syncTeam();
setView("board");
