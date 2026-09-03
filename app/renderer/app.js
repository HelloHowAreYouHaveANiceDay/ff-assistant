// Fantasy Mission Control renderer. Data is injected by data.js (window.PLAYERS, window.LAST_YR).
const DATA = window.PLAYERS || [];
const YR = window.LAST_YR || "LastYr";
document.getElementById("s-players").textContent = DATA.length;

const COLS = [
 ["Rank","#","num"],["Player","Player","player"],["Pos","Pos","pos"],
 ["Us_Pos","Us","t"],["ECR_Pos","ECR","t"],["ESPN_Pos","ESPN","t"],["Tier","Tier","t"],
 ["Team","Tm","t"],["Bye","Bye","num"],["Age","Age","num"],
 ["OurValue$","Val$","val"],["vsECR","vsECR","delta"],["ProjPts","Proj","num1"],
 [YR+"Pts",YR+"Pts","num1"],[YR+"Gms",YR+"G","gms"],
 ["ECR","ECR","num1"],["ESPN_Rank","ESPN#","num"],["ESPN_ADP","ADP","num1"],["Rostered%","Own%","num"],
 ["flags","News / Flags","flags"]
];
const LEFT = new Set(["player","pos","flags","t"]);
const POS = ["ALL","QB","RB","WR","TE","K","DST"];
let st = {q:"",pos:"ALL",sleep:false,avail:false,sort:"Rank",dir:1};

const num=v=>(v===""||v==null||isNaN(v))?null:+v;
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

// ---- views ----
const views = {
  board: renderBoard,
  team: ()=>placeholder("&#127944;","My Team","Live roster + budget + starting-lineup optimizer. Wires to `ff roster` / the draft engine next."),
  news: ()=>placeholder("&#128240;","News","The aggregated player-news feed (injuries, depth, headlines, Sleeper buzz) with source links. Backed by `data/player-news.csv`."),
  room: ()=>placeholder("&#9889;","Draft Room","The live cockpit: current nomination, our recommended max bid + reasoning, budget and slots, updating as the draft runs. Wires to the copresent draft engine."),
  settings: ()=>placeholder("&#9881;","Settings","League + strategy config (values source, reserve/max-share, avoids/targets), Google-Sheet push, and data refresh."),
};
function placeholder(icon,title,body){
  document.getElementById("view").innerHTML =
   `<div class="placeholder"><div class="big">${icon}</div><h2>${title}</h2><p>${body}</p></div>`;
}
const TITLES={board:"Draft Board",team:"My Team",news:"News",room:"Draft Room",settings:"Settings"};
function setView(v){
  document.querySelectorAll(".nv").forEach(b=>b.classList.toggle("on",b.dataset.view===v));
  document.getElementById("crumb").textContent = TITLES[v]||"Draft Board";
  (views[v]||views.board)();
}
document.querySelectorAll(".nv").forEach(b=>b.onclick=()=>setView(b.dataset.view));

// ---- draft board ----
function renderBoard(){
  document.getElementById("view").innerHTML = `
   <div class="toolbar">
     <input type="search" id="q" placeholder="Search player..." value="${esc(st.q)}">
     <div class="pills" id="pos"></div>
     <label class="tg"><input type="checkbox" id="sleep" ${st.sleep?"checked":""}> sleepers (vsECR&gt;5)</label>
     <label class="tg"><input type="checkbox" id="avail" ${st.avail?"checked":""}> hide OUT</label>
     <span class="count" id="count"></span>
   </div>
   <div class="tblwrap"><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></div>`;
  const posEl=document.getElementById("pos");
  POS.forEach(p=>{const b=document.createElement("div");b.className="pill"+(p===st.pos?" on":"");b.textContent=p;
    b.onclick=()=>{st.pos=p;[...posEl.children].forEach(c=>c.classList.toggle("on",c.textContent===p));draw()};posEl.appendChild(b)});
  document.getElementById("q").oninput=e=>{st.q=e.target.value.toLowerCase();draw()};
  document.getElementById("sleep").onchange=e=>{st.sleep=e.target.checked;draw()};
  document.getElementById("avail").onchange=e=>{st.avail=e.target.checked;draw()};
  draw();
}
function thead(){
  const tr=COLS.map(([k,l,kind])=>{const isL=LEFT.has(kind)||k==="Team"||k==="Tier";
    const ar=st.sort===k?(st.dir>0?" ▲":" ▼"):"";
    return `<th class="${isL?'l':''}" data-k="${k}">${esc(l)}<span class="ar">${ar}</span></th>`}).join("");
  document.getElementById("thead").innerHTML="<tr>"+tr+"</tr>";
  document.querySelectorAll("thead th").forEach(th=>th.onclick=()=>{const k=th.dataset.k;if(k==="flags")return;
    if(st.sort===k)st.dir*=-1;else{st.sort=k;st.dir=1}draw()});
}
function sortVal(r,k){if(k==="flags")return 0;const n=num(r[k]);return n==null?(typeof r[k]==="string"?r[k]:1e9):n}
function cell(r,k,kind){
  if(kind==="player")return `<td class="l pl">${esc(r.Player)}</td>`;
  if(kind==="pos")return `<td class="l"><span class="pos ${r.Pos}">${esc(r.Pos)}</span></td>`;
  if(kind==="val")return `<td class="val">$${esc(r["OurValue$"])}</td>`;
  if(kind==="delta"){const v=num(r.vsECR);const c=v>0?"pos-hi":(v<0?"neg-hi":"");return `<td class="${c}">${v==null?"":(v>0?"+"+v:v)}</td>`}
  if(kind==="gms"){const v=num(r[YR+"Gms"]);return `<td class="${(v!=null&&v<10)?'neg-hi':''}">${v==null?"":v}</td>`}
  if(kind==="num1"){const v=num(r[k]);return `<td>${v==null?"":(Math.round(v*10)/10)}</td>`}
  if(kind==="num")return `<td>${r[k]===""?"":esc(r[k])}</td>`;
  if(kind==="flags"){
    let b="";const inj=r.Injury||"";
    if(/Out/i.test(inj))b+=`<span class="badge b-out">OUT</span>`;
    const g=num(r[YR+"Gms"]);if(g!=null&&g<10)b+=`<span class="badge b-dur">${g}g ${YR}</span>`;
    if(r.SleeperBuzz==="ADD")b+=`<span class="badge b-add">+ADD</span>`;
    if(r.SleeperBuzz==="DROP")b+=`<span class="badge b-drop">-DROP</span>`;
    if(r.Depth&&+r.Depth>=2)b+=`<span class="badge b-dep">DEPTH ${esc(r.Depth)}</span>`;
    const news=r["Latest News"]||"",url=r.NewsURL||"";
    const nh=news?(url?`<a href="${esc(url)}" target="_blank">${esc(news)}</a>`:esc(news)):"";
    return `<td class="l"><span>${b}</span> <span class="news mut">${nh}</span></td>`;
  }
  return `<td class="l">${esc(r[k])}</td>`;
}
function draw(){
  thead();
  let rs=DATA.filter(r=>{
    if(st.q&&!r.Player.toLowerCase().includes(st.q))return false;
    if(st.pos!=="ALL"&&r.Pos!==st.pos)return false;
    if(st.sleep&&!(num(r.vsECR)>5))return false;
    if(st.avail&&/Out/i.test(r.Injury||""))return false;
    return true;
  });
  rs.sort((a,b)=>{const x=sortVal(a,st.sort),y=sortVal(b,st.sort);return (x<y?-1:x>y?1:0)*st.dir});
  document.getElementById("tbody").innerHTML=rs.map(r=>"<tr>"+COLS.map(([k,l,kind])=>cell(r,k,kind)).join("")+"</tr>").join("");
  document.getElementById("count").textContent=rs.length+" of "+DATA.length;
}
setView("board");
