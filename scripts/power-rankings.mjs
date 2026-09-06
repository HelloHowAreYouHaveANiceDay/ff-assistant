// Post-draft POWER RANKINGS for the real league.
//
// Pulls the completed draft from ESPN (credentialed, through the app's logged-in webview), maps
// every team's roster onto OUR projections, and scores each with the REAL lineup optimizer -- the
// same one the backtest uses -- so the ranking is "best starting lineup by our board", not vibes.
//
// Honest framing, stated up front because it bounds everything below: this ranks teams by OUR
// projection. It is the same view that drove our bidding, so it is not an independent judge of our
// own draft -- if our board is wrong about a player, this is wrong the same way. Treat the spread
// between teams as more meaningful than any single team's absolute number.
//
//   node scripts/power-rankings.mjs [season]
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import Database from "better-sqlite3";
import { optimalLineup } from "../src/inseason/lineup.ts";

const PORT = process.env.FF_CDP_PORT ?? "9223";
const ESPN_POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };
const SLOT_POS = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "DST", 17: "K" };

const db = new Database("data/ff.db", { readonly: true });
const cfg = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='config'").get().value);
const lg = db.prepare("SELECT league_id, name, team_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
db.close();
const season = Number(process.argv[2] ?? cfg.season);

// OUR projections + values, the same artifacts the agent drafted from.
const readCsv = (p) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
const nameKey = (s) => String(s).toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b/g, " ").replace(/\bd\/?st\b/g, " ").replace(/[^a-z]/g, "");
const proj = new Map(), pos = new Map();
for (const f of readCsv("data/points.csv")) { const k = nameKey(f[0]); proj.set(k, Number(f[2])); pos.set(k, f[1].trim().toUpperCase()); }
const ourVal = new Map();
for (const f of readCsv("data/values.csv")) ourVal.set(nameKey(f[0]), Number(f[2]));

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null);
if (!browser) { console.log("app not running -- open it, then rerun"); process.exit(1); }
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file://"));
if (!page) { console.log("renderer not found"); await browser.close(); process.exit(1); }
const wvEval = (js) => page.evaluate(async (code) => {
  const wv = document.getElementById("espnview");
  if (!wv?.executeJavaScript) return "";
  try { return await wv.executeJavaScript(code); } catch (e) { return "ERR:" + (e?.message ?? e); }
}, js);
if (!/fantasy\.espn\.com/.test(String(await wvEval("location.href")))) {
  await page.evaluate(() => { const w = window; if (w.setView) w.setView("live"); const wv = document.getElementById("espnview"); if (wv?.loadURL) wv.loadURL("https://fantasy.espn.com/football/"); });
  await page.waitForTimeout(4000);
}

// position map from the public pool (an auction slots most picks to bench, so lineupSlotId alone
// cannot give position)
const posById = new Map();
try {
  const res = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`,
    { headers: { "x-fantasy-filter": JSON.stringify({ players: { limit: 2000, sortDraftRanks: { sortPriority: 1, sortAsc: true, value: "STANDARD" } } }) } });
  if (res.ok) for (const pe of (await res.json()).players ?? []) { const pl = pe.player ?? {}; if (pl.id != null) posById.set(pl.id, { pos: ESPN_POS[pl.defaultPositionId], name: pl.fullName }); }
} catch { /* fall back to slot ids */ }

const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${lg.league_id}?view=mDraftDetail&view=mTeam&view=mRoster`;
const raw = await wvEval(`fetch(${JSON.stringify(url)},{credentials:'include'}).then(function(r){return r.ok?r.text():('HTTP '+r.status)}).catch(function(e){return 'ERR '+e.message})`);
await browser.close();
let j; try { j = JSON.parse(String(raw)); } catch { console.log("could not read the league:", String(raw).slice(0, 160)); process.exit(1); }
const picks = j.draftDetail?.picks ?? [];
if (!picks.length) { console.log("no draft picks found -- has the draft completed?"); process.exit(1); }

const teamName = new Map((j.teams ?? []).map((t) => [t.id, (t.name || `${t.location ?? ""} ${t.nickname ?? ""}`).trim() || `Team ${t.id}`]));
const byTeam = new Map();
for (const p of picks) {
  const meta = posById.get(p.playerId) || {};
  const nm = meta.name || `#${p.playerId}`;
  const k = nameKey(nm);
  const position = meta.pos || SLOT_POS[p.lineupSlotId] || pos.get(k) || "?";
  if (!byTeam.has(p.teamId)) byTeam.set(p.teamId, []);
  byTeam.get(p.teamId).push({ name: nm, pos: position, price: p.bidAmount || 1, proj: proj.get(k) ?? 0, val: ourVal.get(k) ?? 0 });
}

const rows = [];
for (const [teamId, roster] of byTeam) {
  const players = roster.map((r) => ({ name: r.name, pos: r.pos, proj: r.proj, available: true }));
  const starters = optimalLineup(players, cfg.slots).starters;
  const startPts = starters.reduce((a, s) => a + (roster.find((r) => r.name === s.name)?.proj ?? 0), 0);
  const spend = roster.reduce((a, r) => a + r.price, 0);
  const surplus = roster.reduce((a, r) => a + (r.val - r.price), 0);
  const byPos = {};
  for (const r of roster) byPos[r.pos] = (byPos[r.pos] || 0) + 1;
  rows.push({ teamId, name: teamName.get(teamId) ?? `Team ${teamId}`, roster, startPts, spend, surplus, byPos,
    top: [...roster].sort((a, b) => b.price - a.price).slice(0, 3) });
}
rows.sort((a, b) => b.startPts - a.startPts);

const us = String(lg.team_id ?? "");
console.log(`POWER RANKINGS -- ${lg.name} ${season}, ${rows.length} teams, ${picks.length} picks`);
console.log(`Scored with the real lineup optimizer on OUR projections (data/points.csv).\n`);
console.log("  #  team                        startPts  spend  surplus  QB RB WR TE  top buys");
rows.forEach((r, i) => {
  const mine = String(r.teamId) === us ? " <<< US" : "";
  const p = r.byPos;
  console.log(`  ${String(i + 1).padStart(2)} ${r.name.slice(0, 26).padEnd(26)} ${r.startPts.toFixed(0).padStart(7)} ${("$" + r.spend).padStart(6)} ${(r.surplus >= 0 ? "+" : "") + r.surplus}`.padEnd(72) +
    `${String(p.QB || 0)} ${String(p.RB || 0).padStart(2)} ${String(p.WR || 0).padStart(2)} ${String(p.TE || 0).padStart(2)}  ` +
    r.top.map((t) => `${t.name.split(" ").slice(-1)[0]} $${t.price}`).join(", ") + mine);
});

const ourRow = rows.find((r) => String(r.teamId) === us);
if (ourRow) {
  const rank = rows.indexOf(ourRow) + 1;
  const mean = rows.reduce((a, r) => a + r.startPts, 0) / rows.length;
  console.log(`\nOUR TEAM: #${rank} of ${rows.length}  --  ${ourRow.startPts.toFixed(0)} projected starter pts (league mean ${mean.toFixed(0)}), spent $${ourRow.spend}, surplus ${ourRow.surplus >= 0 ? "+" : ""}${ourRow.surplus} vs our own book`);
  console.log(`  roster:`);
  for (const p of [...ourRow.roster].sort((a, b) => b.price - a.price)) {
    console.log(`    ${p.pos.padEnd(4)} ${p.name.slice(0, 24).padEnd(25)} $${String(p.price).padStart(3)}  our val $${String(p.val).padStart(3)}  proj ${p.proj.toFixed(0)}`);
  }
}
console.log(`\nCAVEAT: ranked by OUR projection -- the same board we bid from, so this is not an`);
console.log(`independent grade of our own draft. Read the SPREAD between teams, not the absolutes.`);
