// ONE-WEEK STREAMING: does our served pick beat the board out of the REAL free-agent pool, and does
// the matchup adjustment (dvp_mult) that HELPS the one-week decision get correctly KEPT here?
//
//   node --import tsx scripts/stream-horizon.mjs [--seasons 2018-2025]
//
// This is the one-week counterpart to scripts/waiver-horizon.mjs. The waiver decision is multi-week
// (scored on rest-of-season) and there the matchup tilt is noise. The STREAMING decision is a single
// week -- "of the men nobody rosters, who do I start at this position THIS week" -- and the
// matchup-adjusted number should help. This measures both:
//
//   1. FRONTIER #3: does the served weekly model beat the SEASON-LINE board pick out of the real pool
//      (fact_fa_pool_week), per position, at picking the week's actual-highest scorer?
//   2. HORIZON SYMMETRY: does the matchup-adjusted challenger beat its own matchup-NEUTRAL copy on
//      the one-week actual score? (The mirror of the waiver test, where neutral won marginally.)
//
// POINT-IN-TIME: features are as-of the day before kickoff (the weekly feature contract). The pool is
// Track B's real fact_fa_pool_week -- who sixteen managers ACTUALLY left unrostered that week. The
// artifact coefficients are the shipped in-sample ones (fitted 2012-2025); that is the SAME
// in-sample posture as the existing waiver backtest (Backtest 2 loads the shipped challenger too),
// and it is shared identically by every arm, so the dvp-vs-neutral and pick-vs-board comparisons are
// clean paired contrasts. Noted, not hidden.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { loadWeeklyArtifact, projectWeekly } from "../src/weekly/projector.ts";
import { loadWeeklyRows } from "../src/weekly/features.ts";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const [lo, hi] = arg("--seasons", "2018-2025").split("-").map(Number);
const seasons = []; for (let y = lo; y <= hi; y++) seasons.push(y);
const POS = ["QB", "RB", "WR", "TE", "K", "DST"];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const db = new Database("data/ff.db", { readonly: true });

// ---- --league <id>, default the store's active league (mirrors activeLeagueId in src/db/db.ts) --
function resolveLeague(explicit) {
  if (explicit) return String(explicit);
  const sel = db.prepare("SELECT value FROM settings WHERE key='active_league'").get();
  if (sel && sel.value && db.prepare("SELECT 1 FROM league WHERE league_id=?").get(sel.value)) return String(sel.value);
  const r = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
  return r ? String(r.league_id) : null;
}
const leagueId = resolveLeague(arg("--league", null));
if (!leagueId) { console.error("stream-horizon: no league found -- run a league sync first"); process.exit(1); }
console.log(`league ${leagueId}`);

const challenger = loadWeeklyArtifact(JSON.parse(readFileSync("data/weekly-artifact.json", "utf8")));
const neutralJson = JSON.parse(readFileSync("data/weekly-artifact.json", "utf8"));
let zeroed = 0;
for (const pos of Object.keys(neutralJson.coef ?? {})) {
  for (const head of Object.keys(neutralJson.coef[pos])) {
    const c = neutralJson.coef[pos][head];
    if (Object.prototype.hasOwnProperty.call(c, "dvp_mult")) { c.dvp_mult = 0; zeroed++; }
  }
}
const neutral = loadWeeklyArtifact(neutralJson, { checkGolden: false });
console.log(`matchup-neutral artifact: zeroed ${zeroed} dvp_mult coefficients.`);

// per (pos): arrays of per-week picked-actual for each arm; and per-season sums for bootstrap
const cells = [];   // {season, week, pos, chall, neutral, board, chosenChangedDvp}
let poolWeeks = 0, changedByDvp = 0;

for (const season of seasons) {
  const poolStmt = db.prepare("SELECT week, player_sk FROM fact_fa_pool_week WHERE league_id=? AND season=?");
  const poolByWeek = new Map();
  for (const r of poolStmt.all(leagueId, season)) {
    let s = poolByWeek.get(r.week); if (!s) { s = new Set(); poolByWeek.set(r.week, s); }
    s.add(r.player_sk);
  }
  const actualStmt = db.prepare("SELECT feat_key, pts, is_bye, season_line_pg FROM feat_player_week_model WHERE season=? AND week=?");
  for (const [week, pool] of poolByWeek) {
    const rows = loadWeeklyRows(db, season, week);
    if (!rows.length) continue;
    const cMean = new Map(), nMean = new Map();
    for (const p of projectWeekly({ artifact: challenger, rows })) cMean.set(p.feat_key, p.mean);
    for (const p of projectWeekly({ artifact: neutral, rows })) nMean.set(p.feat_key, p.mean);
    const meta = new Map();
    for (const r of actualStmt.all(season, week)) meta.set(r.feat_key, r);
    // bucket pool members by position
    const byPos = new Map();
    for (const r of rows) {
      if (!pool.has(r.feat_key)) continue;
      const m = meta.get(r.feat_key);
      if (!m || m.is_bye) continue;            // a bye man is not a startable streamer
      if (m.season_line_pg == null) continue;  // needs a board line to have a board pick
      let l = byPos.get(r.pos); if (!l) { l = []; byPos.set(r.pos, l); }
      l.push({ key: r.feat_key, actual: m.pts ?? 0, line: m.season_line_pg, c: cMean.get(r.feat_key), n: nMean.get(r.feat_key) });
    }
    for (const pos of POS) {
      const list = (byPos.get(pos) ?? []).filter((x) => x.c != null && x.n != null);
      if (list.length < 2) continue;   // no decision to make
      poolWeeks++;
      const bestBy = (f) => list.reduce((a, b) => (a == null || f(b) > f(a) ? b : a), null);
      const cPick = bestBy((x) => x.c), nPick = bestBy((x) => x.n), bPick = bestBy((x) => x.line);
      if (cPick.key !== nPick.key) changedByDvp++;
      cells.push({ season, week, pos, chall: cPick.actual, neutral: nPick.actual, board: bPick.actual, changed: cPick.key !== nPick.key });
    }
  }
}
console.log(`FAULT INJECTION: matchup adjustment changed the one-week pick in ${changedByDvp} of ${poolWeeks} pos-weeks. ` +
  (changedByDvp > 0 ? "CONNECTED." : "*** DISCONNECTED ***"));

// per position table
console.log("\n=== ONE-WEEK STREAMING out of the REAL pool: mean ACTUAL points of the picked man ===");
console.log("  pos    n     board   challenger  neutral   chall-board  chall-neutral  winVsBoard(chall)");
for (const pos of POS) {
  const c = cells.filter((x) => x.pos === pos);
  if (!c.length) continue;
  const b = mean(c.map((x) => x.board)), ch = mean(c.map((x) => x.chall)), ne = mean(c.map((x) => x.neutral));
  const winB = c.filter((x) => x.chall > x.board).length / c.length;
  console.log(`  ${pos.padEnd(4)} ${String(c.length).padStart(5)}  ${b.toFixed(2).padStart(7)}   ${ch.toFixed(2).padStart(8)}  ${ne.toFixed(2).padStart(7)}   ` +
    `${((ch - b) >= 0 ? "+" : "") + (ch - b).toFixed(2)}       ${((ch - ne) >= 0 ? "+" : "") + (ch - ne).toFixed(3)}         ${(100 * winB).toFixed(0)}%`);
}

// paired season bootstrap helper
function pairedBoot(perSeasonA, perSeasonB, iters = 4000, seed = 12345) {
  const diffs = seasons.map((s) => (perSeasonA.get(s) ?? 0) - (perSeasonB.get(s) ?? 0)).filter((x) => Number.isFinite(x));
  let rng = seed; const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const boot = [];
  for (let i = 0; i < iters; i++) { let acc = 0; for (let k = 0; k < diffs.length; k++) acc += diffs[Math.floor(rand() * diffs.length)]; boot.push(acc / diffs.length); }
  boot.sort((x, y) => x - y);
  return { mean: mean(diffs), lo: boot[Math.floor(0.05 * boot.length)], hi: boot[Math.floor(0.95 * boot.length)], p: boot.filter((x) => x > 0).length / boot.length };
}
const perSeasonMean = (sel) => {
  const m = new Map();
  for (const s of seasons) { const c = cells.filter((x) => x.season === s); if (c.length) m.set(s, mean(c.map(sel))); }
  return m;
};
console.log("\n=== PAIRED SEASON BOOTSTRAP (pooled over all positions, per-season mean actual, 90% CI) ===");
const chS = perSeasonMean((x) => x.chall), neS = perSeasonMean((x) => x.neutral), bS = perSeasonMean((x) => x.board);
for (const [label, A, B] of [
  ["challenger - board  ", chS, bS],
  ["neutral    - board  ", neS, bS],
  ["challenger - neutral", chS, neS],
]) {
  const r = pairedBoot(A, B);
  console.log(`  ${label}  mean ${(r.mean >= 0 ? "+" : "") + r.mean.toFixed(3)}  CI [${r.lo.toFixed(2)}, ${r.hi.toFixed(2)}]  P(first>second) ${(100 * r.p).toFixed(0)}%`);
}
db.close();
