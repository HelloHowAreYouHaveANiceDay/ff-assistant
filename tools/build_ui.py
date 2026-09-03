# Generate a self-contained, double-click INTERACTIVE draft board (ui/draft-board.html) from
# data/player-report.csv. No server, no external deps -- the data is embedded and the table is
# rendered by vanilla JS (search, position filter, click-to-sort, tier coloring, value-vs-consensus
# highlight, injury/buzz badges, clickable news). This is the first UI slice toward the packaged app.
# Run: uv run python tools/build_ui.py
import os, csv, json, html

CSV = "data/player-report.csv"
OUT = "ui/draft-board.html"

with open(CSV, encoding="utf-8", errors="ignore") as f:
    rows = list(csv.DictReader(f))

# coerce numerics so JS can sort correctly
NUM = {"Rank", "Bye", "Age", "Wt", "40yd", "OurValue$", "vsECR", "ProjPts",
       "ECR", "ECR_Best", "ECR_Worst", "ESPN_Rank", "ESPN_ADP", "Rostered%", "Depth"}
for r in rows:
    for k in list(r.keys()):
        if k in NUM and r[k] not in ("", None):
            try:
                r[k] = float(r[k]) if "." in str(r[k]) else int(r[k])
            except ValueError:
                pass
        # last-year columns are named e.g. 2025Pts / 2025Gms
        elif (k.endswith("Pts") or k.endswith("Gms")) and r[k] not in ("", None):
            try:
                r[k] = float(r[k]) if "." in str(r[k]) else int(r[k])
            except ValueError:
                pass

data_json = json.dumps(rows, ensure_ascii=False)
last_yr = next((k[:4] for k in rows[0].keys() if k.endswith("Gms") and k[:4].isdigit()), "LastYr") if rows else "LastYr"

HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FF Draft Board 2026</title>
<style>
 :root{--bg:#0f1420;--panel:#161d2e;--row:#131a29;--row2:#0f1523;--line:#26304a;--tx:#e6ebf5;--mut:#8b98b5;--accent:#4f8cff;--good:#2fbf71;--bad:#e5533d;--warn:#e0a63a}
 *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--tx);font:13px/1.4 system-ui,Segoe UI,Roboto,sans-serif}
 header{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line);padding:10px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
 h1{font-size:15px;margin:0 12px 0 0;font-weight:700} h1 span{color:var(--mut);font-weight:400;font-size:12px}
 input[type=search]{background:var(--row);border:1px solid var(--line);color:var(--tx);border-radius:7px;padding:7px 10px;width:230px;outline:none}
 input[type=search]:focus{border-color:var(--accent)}
 .pills{display:flex;gap:4px} .pill{background:var(--row);border:1px solid var(--line);color:var(--mut);border-radius:14px;padding:5px 11px;cursor:pointer;font-weight:600}
 .pill.on{background:var(--accent);border-color:var(--accent);color:#fff} .pill:hover{color:var(--tx)}
 label.tg{color:var(--mut);display:flex;gap:5px;align-items:center;cursor:pointer;user-select:none}
 .count{color:var(--mut);margin-left:auto}
 .wrap{overflow:auto;height:calc(100vh - 52px)}
 table{border-collapse:collapse;width:100%;white-space:nowrap}
 thead th{position:sticky;top:0;background:#1b2438;color:#c6d0e6;text-align:right;padding:7px 8px;border-bottom:1px solid var(--line);cursor:pointer;font-weight:600;font-size:11px;letter-spacing:.02em}
 thead th.l{text-align:left} thead th:hover{color:#fff} th .ar{color:var(--accent)}
 td{padding:5px 8px;border-bottom:1px solid var(--row2);text-align:right} td.l{text-align:left}
 tbody tr:nth-child(even){background:var(--row2)} tbody tr:hover{background:#1c2740}
 .pl{font-weight:600;color:#fff} .mut{color:var(--mut)}
 .val{font-weight:700} .pos{display:inline-block;min-width:30px;text-align:center;border-radius:4px;padding:1px 5px;font-weight:700;font-size:11px}
 .QB{background:#3b2b52;color:#d3b8ff}.RB{background:#123a2a;color:#8ff0c0}.WR{background:#12314f;color:#9cc7ff}.TE{background:#4a3416;color:#ffca86}.K{background:#33383f;color:#c7d0dc}.DST{background:#402131;color:#ffa8c6}
 .badge{display:inline-block;border-radius:4px;padding:1px 5px;font-size:11px;font-weight:700;margin-left:3px}
 .b-out{background:#4a1c17;color:#ff9a8a}.b-dur{background:#4a3a17;color:#ffd08a}.b-add{background:#123a2a;color:#8ff0c0}.b-drop{background:#4a1c17;color:#ff9a8a}.b-dep{background:#2a3550;color:#a9b8de}
 .pos-hi{color:var(--good);font-weight:700}.neg-hi{color:var(--bad);font-weight:700}
 a{color:#7fb0ff;text-decoration:none} a:hover{text-decoration:underline}
 .news{max-width:340px;overflow:hidden;text-overflow:ellipsis}
</style></head>
<body>
<header>
 <h1>FF Draft Board 2026 <span id="sub"></span></h1>
 <input type="search" id="q" placeholder="Search player...">
 <div class="pills" id="pos"></div>
 <label class="tg"><input type="checkbox" id="sleep"> sleepers (vsECR&gt;5)</label>
 <label class="tg"><input type="checkbox" id="avail"> hide OUT</label>
 <span class="count" id="count"></span>
</header>
<div class="wrap"><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></div>
<script>
const DATA = __DATA__;
const YR = "__YR__";
// columns: [key, label, kind]  kind: t=text l=left num=number, special renderers by key
const COLS = [
 ["Rank","#","num"],["Player","Player","player"],["pos_badge","Pos","pos"],
 ["Us_Pos","Us","t"],["ECR_Pos","ECR","t"],["ESPN_Pos","ESPN","t"],["Tier","Tier","t"],
 ["Team","Tm","t"],["Bye","Bye","num"],["Age","Age","num"],
 ["OurValue$","Val$","val"],["vsECR","vsECR","delta"],["ProjPts","Proj","num1"],
 [YR+"Pts",YR+"Pts","num1"],[YR+"Gms",YR+"G","gms"],
 ["ECR","ECR","num1"],["ESPN_Rank","ESPN#","num"],["ESPN_ADP","ADP","num1"],["Rostered%","Own%","num"],
 ["flags","News / Flags","flags"]
];
const POS = ["ALL","QB","RB","WR","TE","K","DST"];
let state={q:"",pos:"ALL",sleep:false,avail:false,sort:"Rank",dir:1};

const posEl=document.getElementById("pos");
POS.forEach(p=>{const b=document.createElement("div");b.className="pill"+(p==="ALL"?" on":"");b.textContent=p;b.onclick=()=>{state.pos=p;[...posEl.children].forEach(c=>c.classList.toggle("on",c.textContent===p));render()};posEl.appendChild(b)});
document.getElementById("q").oninput=e=>{state.q=e.target.value.toLowerCase();render()};
document.getElementById("sleep").onchange=e=>{state.sleep=e.target.checked;render()};
document.getElementById("avail").onchange=e=>{state.avail=e.target.checked;render()};

function num(v){return (v===""||v==null||isNaN(v))?null:+v}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}

function thead(){
 const tr=COLS.map(([k,l,kind])=>{const isL=(kind==="player"||kind==="pos"||kind==="flags"||kind==="t"||k==="Team"||k==="Tier");
  const ar=state.sort===k?(state.dir>0?" ▲":" ▼"):"";
  return `<th class="${isL?'l':''}" data-k="${k}">${esc(l)}<span class="ar">${ar}</span></th>`}).join("");
 document.getElementById("thead").innerHTML="<tr>"+tr+"</tr>";
 document.querySelectorAll("thead th").forEach(th=>th.onclick=()=>{const k=th.dataset.k;if(state.sort===k)state.dir*=-1;else{state.sort=k;state.dir=(k==="Player"||k==="Team")?1:1} if(["Player","Team","Us_Pos","ECR_Pos","ESPN_Pos","Tier","flags","pos_badge"].includes(k)&&state.sort!==k)state.dir=1; state.sort=k; render()});
}
function sortVal(r,k){
 if(k==="pos_badge")return r.Pos; if(k==="flags")return 0;
 const n=num(r[k]); return n==null?(typeof r[k]==="string"?r[k]:1e9):n;
}
function cell(r,k,kind){
 if(kind==="player")return `<td class="l pl">${esc(r.Player)}</td>`;
 if(kind==="pos")return `<td class="l"><span class="pos ${r.Pos}">${esc(r.Pos)}</span></td>`;
 if(kind==="val")return `<td class="val">$${esc(r["OurValue$"])}</td>`;
 if(kind==="delta"){const v=num(r.vsECR);const c=v>0?"pos-hi":(v<0?"neg-hi":"");const s=v>0?"+"+v:v;return `<td class="${c}">${v==null?"":s}</td>`}
 if(kind==="gms"){const v=num(r[YR+"Gms"]);const c=(v!=null&&v<10)?"neg-hi":"";return `<td class="${c}">${v==null?"":v}</td>`}
 if(kind==="num1"){const v=num(r[k]);return `<td>${v==null?"":(Math.round(v*10)/10)}</td>`}
 if(kind==="num")return `<td>${r[k]===""?"":esc(r[k])}</td>`;
 if(kind==="flags"){
   let b="";const inj=r.Injury||""; // Injury col dropped from CSV in 2026 mode; kept if present
   if(/Out/i.test(inj))b+=`<span class="badge b-out">OUT</span>`;
   const g=num(r[YR+"Gms"]); if(g!=null&&g<10)b+=`<span class="badge b-dur">${g}g ${YR}</span>`;
   if(r.SleeperBuzz==="ADD")b+=`<span class="badge b-add">+ADD</span>`;
   if(r.SleeperBuzz==="DROP")b+=`<span class="badge b-drop">-DROP</span>`;
   if(r.Depth&&+r.Depth>=2)b+=`<span class="badge b-dep">DEPTH ${esc(r.Depth)}</span>`;
   const news=r["Latest News"]||""; const url=r.NewsURL||"";
   const nh=news?(url?`<a href="${esc(url)}" target="_blank">${esc(news)}</a>`:esc(news)):"";
   return `<td class="l"><span>${b}</span> <span class="news mut">${nh}</span></td>`;
 }
 return `<td class="l">${esc(r[k])}</td>`;
}
function render(){
 thead();
 let rs=DATA.filter(r=>{
  if(state.q&&!r.Player.toLowerCase().includes(state.q))return false;
  if(state.pos!=="ALL"&&r.Pos!==state.pos)return false;
  if(state.sleep&&!(num(r.vsECR)>5))return false;
  if(state.avail&&/Out/i.test(r.Injury||""))return false;
  return true;
 });
 rs.sort((a,b)=>{const x=sortVal(a,state.sort),y=sortVal(b,state.sort);return (x<y?-1:x>y?1:0)*state.dir});
 const body=rs.map(r=>"<tr>"+COLS.map(([k,l,kind])=>cell(r,k,kind)).join("")+"</tr>").join("");
 document.getElementById("tbody").innerHTML=body;
 document.getElementById("count").textContent=rs.length+" of "+DATA.length+" players";
 document.getElementById("sub").textContent="· our values vs ECR / ESPN · click a column to sort";
}
render();
</script></body></html>"""

os.makedirs("ui", exist_ok=True)
out = HTML.replace("__DATA__", data_json).replace("__YR__", last_yr)
with open(OUT, "w", encoding="utf-8") as f:
    f.write(out)
print(f"wrote {OUT} ({len(rows)} players, {len(out)//1024} KB self-contained)")
