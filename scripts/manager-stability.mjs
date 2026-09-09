// How well does the sim's OPPONENT MODEL actually approximate this league's managers?
//
//   node --import tsx scripts/manager-stability.mjs [firstSeason] [lastSeason]
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
// IT READS THE STORE, NOT THE LIVE LEAGUE. It used to open the ESPN adaptor and fetch history over
// the network, which meant the answer depended on the desktop app being open and on however many
// seasons that call happened to return. `fact_draft_pick` + `fact_team_season` hold nine seasons of
// the same picks with the owner already attached, so the measurement is reproducible offline and
// covers every season the league has played.
//
// Keyed on OWNER, never on team id or team name: both get reused and renamed across seasons, and a
// profile attached to the wrong human is worse than no profile.
import Database from "better-sqlite3";

const POS = ["QB", "RB", "WR", "TE"];
const db = new Database("data/ff.db", { readonly: true });

const bounds = db.prepare("SELECT MIN(season) lo, MAX(season) hi FROM fact_draft_pick").get();
if (!bounds || bounds.lo == null) { console.log("fact_draft_pick is empty -- run `ff build-picks`"); process.exit(1); }
const first = Number(process.argv[2] ?? bounds.lo);
const last = Number(process.argv[3] ?? bounds.hi);

console.log(`MANAGER STABILITY -- seasons ${first}-${last}, from fact_draft_pick`);

const picks = db.prepare(
  `SELECT p.season, p.team_id, p.pos, p.price, t.owner
     FROM fact_draft_pick p LEFT JOIN fact_team_season t ON t.season = p.season AND t.team_id = p.team_id
    WHERE p.season BETWEEN ? AND ? ORDER BY p.season, p.pick_order`,
).all(first, last);
db.close();

// --- per (owner, season) positional spend shares -------------------------------------------------
const bySeasonOwner = new Map();
let unattributed = 0;
for (const p of picks) {
  if (!POS.includes(p.pos)) continue;
  if (!p.owner) { unattributed++; continue; }
  const k = `${p.season}|${p.owner}`;
  const e = bySeasonOwner.get(k) ?? bySeasonOwner.set(k, { owner: p.owner, season: p.season, spend: Object.fromEntries(POS.map((x) => [x, 0])), tot: 0 }).get(k);
  const price = p.price || 1;
  e.spend[p.pos] += price;
  e.tot += price;
}
const rows = [];
for (const e of bySeasonOwner.values()) {
  if (e.tot < 50) continue;   // a partial/abandoned draft is not a tendency
  rows.push({ owner: e.owner, season: e.season, share: Object.fromEntries(POS.map((k) => [k, e.spend[k] / e.tot])) });
}
const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b);
for (const s of seasons) console.log(`  ${s}: ${rows.filter((r) => r.season === s).length} owners`);
if (unattributed) console.log(`  ${unattributed} picks with no owner row -- excluded, never attributed to a placeholder`);
if (rows.length < 4) { console.log("\nnot enough seasons of draft history to run the test."); process.exit(0); }

// league-average share per season (the naive baseline every owner is compared against)
const leagueBy = {};
for (const yr of seasons) {
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
  if (rs.length < 2) continue;   // need at least one other season to build a profile from
  for (const held of rs) {
    const others = rs.filter((x) => x.season !== held.season);
    const prof = Object.fromEntries(POS.map((k) => [k, others.reduce((a, x) => a + x.share[k], 0) / others.length]));
    const base = leagueBy[held.season];
    if (!base) continue;
    const errP = POS.reduce((a, k) => a + Math.abs(prof[k] - held.share[k]), 0) / POS.length * 100;
    const errL = POS.reduce((a, k) => a + Math.abs(base[k] - held.share[k]), 0) / POS.length * 100;
    nProfile += errP; nLeague += errL; cases++;
    if (errP < errL) wins++;
    detail.push({ owner, season: held.season, errP, errL });
  }
}
if (!cases) { console.log("\nno owner has 2+ seasons of draft history -- cannot run the held-out test."); process.exit(0); }

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
