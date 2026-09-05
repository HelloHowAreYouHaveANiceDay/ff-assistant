// How well does the sim's OPPONENT MODEL actually approximate this league's managers?
//
// `ff calibrate` compares simulated positional spend to each owner's historical average -- but the
// PROFILE IS BUILT FROM THAT SAME HISTORY, so it is fitting and scoring on identical data. A profile
// can score perfectly there while carrying no predictive power at all. This asks the out-of-sample
// question instead:
//
//   Does a personalised profile predict an owner's HELD-OUT season better than simply assuming
//   they draft like the league average?
//
// If not, the heterogeneous field is decoration and the bots may as well be identical.
//
// Pulls per-season, per-OWNER draft details through the app's logged-in webview (memberId is stable
// across seasons; team NAMES are not -- only 5 of 48 recur, which is why recaps.json cannot answer
// this).
import { chromium } from "playwright-core";
import Database from "better-sqlite3";

const PORT = process.env.FF_CDP_PORT ?? "9223";
// The league has run since 2012 (docs/league-tendencies.md). cmdScrapeLeague defaults to only the
// last 4 years, which is why the first pass of this test had just 50 cases. Pull everything and let
// the fetch skip seasons that return nothing.
const FROM = Number(process.argv[2] ?? 2012), TO = Number(process.argv[3] ?? 2025);
const SEASONS = Array.from({ length: TO - FROM + 1 }, (_, i) => FROM + i);
const POS = ["QB", "RB", "WR", "TE", "K", "DST"];
const ESPN_POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };
const SLOT_POS = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "DST", 17: "K" };

const db = new Database("data/ff.db", { readonly: true });
const leagueId = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get().league_id;
db.close();

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null);
if (!browser) { console.log("app not running -- start it, then rerun"); process.exit(1); }
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

// public player pools -> playerId -> position (an auction slots most picks to bench, so lineupSlotId
// alone cannot give position)
const posMap = new Map();
for (const yr of SEASONS) {
  try {
    const res = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${yr}/segments/0/leaguedefaults/3?view=kona_player_info`,
      { headers: { "x-fantasy-filter": JSON.stringify({ players: { limit: 1500, sortDraftRanks: { sortPriority: 1, sortAsc: true, value: "STANDARD" } } }) } });
    if (!res.ok) continue;
    const d = await res.json();
    for (const pe of d.players ?? []) { const pl = pe.player ?? {}; if (pl.id != null && !posMap.has(pl.id)) { const p = ESPN_POS[pl.defaultPositionId]; if (p) posMap.set(pl.id, p); } }
  } catch { /* skip */ }
}

// per (owner, season) positional spend shares
const rows = [];
for (const yr of SEASONS) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${yr}/segments/0/leagues/${leagueId}?view=mDraftDetail&view=mTeam`;
  const raw = await wvEval(`fetch(${JSON.stringify(url)},{credentials:'include'}).then(function(r){return r.ok?r.text():('HTTP '+r.status)}).catch(function(e){return 'ERR '+e.message})`);
  let j; try { j = JSON.parse(String(raw)); } catch { console.log(`  ${yr}: no data`); continue; }
  const picks = j.draftDetail?.picks ?? [];
  if (!picks.length) { console.log(`  ${yr}: no draft`); continue; }
  const member = new Map((j.members ?? []).map((m) => [m.id, m.displayName || m.firstName || m.id]));
  const byOwner = new Map();
  for (const p of picks) {
    const owner = member.get(p.memberId) || String(p.memberId);
    const pos = posMap.get(p.playerId) ?? SLOT_POS[p.lineupSlotId] ?? null;
    if (!pos) continue;
    if (!byOwner.has(owner)) byOwner.set(owner, { spend: Object.fromEntries(POS.map((k) => [k, 0])), tot: 0 });
    const e = byOwner.get(owner);
    e.spend[pos] += p.bidAmount || 1; e.tot += p.bidAmount || 1;
  }
  for (const [owner, e] of byOwner) {
    if (e.tot < 50) continue;
    rows.push({ owner, season: yr, share: Object.fromEntries(POS.map((k) => [k, e.spend[k] / e.tot])) });
  }
  console.log(`  ${yr}: ${byOwner.size} owners`);
}
await browser.close();

// league-average share per season (the naive baseline every owner is compared against)
const leagueBy = {};
for (const yr of SEASONS) {
  const r = rows.filter((x) => x.season === yr);
  if (!r.length) continue;
  leagueBy[yr] = Object.fromEntries(POS.map((k) => [k, r.reduce((a, x) => a + x.share[k], 0) / r.length]));
}

// LEAVE-ONE-SEASON-OUT: profile from the owner's OTHER seasons vs the league average, scored on the
// held-out season. Error = mean absolute difference in positional share (percentage points).
const byOwner = new Map();
for (const r of rows) { if (!byOwner.has(r.owner)) byOwner.set(r.owner, []); byOwner.get(r.owner).push(r); }
let nProfile = 0, nLeague = 0, cases = 0, wins = 0;
const detail = [];
for (const [owner, rs] of byOwner) {
  if (rs.length < 2) continue; // need at least one other season to build a profile from
  for (const held of rs) {
    const others = rs.filter((x) => x.season !== held.season);
    const prof = Object.fromEntries(POS.map((k) => [k, others.reduce((a, x) => a + x.share[k], 0) / others.length]));
    const lg = leagueBy[held.season];
    const errP = POS.reduce((a, k) => a + Math.abs(prof[k] - held.share[k]), 0) / POS.length * 100;
    const errL = POS.reduce((a, k) => a + Math.abs(lg[k] - held.share[k]), 0) / POS.length * 100;
    nProfile += errP; nLeague += errL; cases++; if (errP < errL) wins++;
    detail.push({ owner, season: held.season, errP, errL });
  }
}
console.log(`\nLEAVE-ONE-SEASON-OUT: predicting an owner's held-out positional shares`);
console.log(`  cases: ${cases} (owners with 2+ seasons)\n`);
console.log(`  mean abs error, PERSONALISED profile : ${(nProfile / cases).toFixed(2)} pp`);
console.log(`  mean abs error, league-average       : ${(nLeague / cases).toFixed(2)} pp`);
console.log(`  personalised profile wins in ${wins}/${cases} cases (${(wins / cases * 100).toFixed(0)}%)`);
const impr = (nLeague - nProfile) / nLeague * 100;
console.log(`  improvement over the naive baseline: ${impr.toFixed(1)}%`);
console.log(impr > 5
  ? `\n  The heterogeneous field carries real out-of-sample signal.`
  : `\n  The personalised profiles do NOT beat "everyone drafts league-average" out of sample --\n  the heterogeneous field is largely decoration, and per-owner conclusions should not be trusted.`);
const worst = detail.sort((a, b) => (b.errP - b.errL) - (a.errP - a.errL)).slice(0, 5);
console.log(`\n  worst profile misses (profile err vs league err):`);
for (const d of worst) console.log(`    ${d.owner.slice(0, 18).padEnd(19)} ${d.season}  ${d.errP.toFixed(1)} vs ${d.errL.toFixed(1)}`);
