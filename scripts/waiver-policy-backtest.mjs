// DOES THE ADMITTED WAIVER RANKING BEAT THE ROOM, AND BEAT THE SHIPPED RANKING?
//
// `breakout-screen.mjs` admitted in-season USAGE at WR and the expert consensus (ECR) at WR and QB
// as better POOL RANKINGS than the season line. Those were measured on MY metric (realised
// rest-of-season points per game of a top-K I defined) over a pool I constructed. That is a
// statistic, not an edge: an edge is a ranking that changes what the tool would have claimed, on
// the room's OWN claims, scored by a harness the repo already trusts.
//
// This drives `backtestWaivers` -- the harness that replays every real add this league made and
// scores our top-K against the room's, on realised rest-of-season points. The only thing that
// changes between arms is the SORT KEY; the pool, the choice set (week w-1, 88.4% match rate), the
// scoring window and the top-K size are the harness's and are untouched.
//
// WHAT IS STILL SUBSTITUTED is what the harness header already says: the objective is expected
// points, not the playoff-probability delta `waiverTargets` actually optimises, because no 2019
// SimContext can be built without inventing a 2019 board. So this tests the RANKING, which is
// exactly the thing the screens admitted. It does not test the FAAB rule or the odds objective.
//
// LEAVE-SEASON-OUT. The model that ranks season Y is fitted on every season EXCEPT Y. A model fitted
// on the season it scores would rank the pool using the answer sheet.
//
// Usage: node --import tsx scripts/waiver-policy-backtest.mjs [--model floor|challenger]
import Database from "better-sqlite3";
import { backtestWaivers } from "../src/inseason/backtest/waiver.js";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const MODEL = arg("--model", "challenger");
const LEAGUE = arg("--league", "462233");

const db = new Database("data/ff.db");

const INCUMBENTS = ["season_line_pg", "t4_mean"];
const USAGE = ["prior_snap_share", "prior_route_share", "td_ts", "td_rush_yards", "rz_share_td"];
const ECR = ["ecr_wk_rank", "ecr_missing"];

/** Every feature row we might rank on, keyed (season|week|player_sk). */
const rows = db.prepare(`
  SELECT season, week, pos, player_sk, pts, ecr_wk_rank,
         ${[...INCUMBENTS, ...USAGE].join(", ")}
    FROM feat_player_week_model
   WHERE pos IN ('QB','RB','WR','TE') AND season BETWEEN 2018 AND 2025
   ORDER BY season, player_sk, week
`).all();

// The TARGET the ranker is fitted on: realised rest-of-season points per game, exactly as the
// harness scores. Suffix sums per (season, player).
const groups = new Map();
for (const r of rows) { const k = `${r.season}|${r.player_sk}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
for (const [, g] of groups) {
  let sum = 0, cnt = 0;
  for (let i = g.length - 1; i >= 0; i--) { sum += g[i].pts ?? 0; cnt++; g[i].ros_pts = sum; g[i].ros_games = cnt; }
}
for (const r of rows) r.y = r.ros_games ? r.ros_pts / r.ros_games : null;

// ECR missingness, encoded per (season, week, pos) cell exactly as the screen does.
{
  const byCell = new Map();
  for (const r of rows) { const k = `${r.season}|${r.week}|${r.pos}`; if (!byCell.has(k)) byCell.set(k, []); byCell.get(k).push(r); }
  for (const [, cell] of byCell) {
    const ranked = cell.map((x) => x.ecr_wk_rank).filter((v) => v != null);
    const worst = ranked.length ? Math.max(...ranked) : 0;
    for (const r of cell) { r.ecr_missing = r.ecr_wk_rank == null ? 1 : 0; if (r.ecr_wk_rank == null) r.ecr_wk_rank = worst + 1; }
  }
}

const byKey = new Map(rows.map((r) => [`${r.season}|${r.week}|${r.player_sk}`, r]));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

function fit(train, feats, fill) {
  const p = feats.length + 1;
  const A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
  const col = (j, r) => (j === 0 ? 1 : (r[feats[j - 1]] ?? fill[feats[j - 1]]));
  for (const r of train) for (let j = 0; j < p; j++) {
    b[j] += col(j, r) * r.y;
    for (let k = 0; k < p; k++) A[j][k] += col(j, r) * col(k, r);
  }
  for (let j = 0; j < p; j++) A[j][j] += 1e-6;
  for (let j = 0; j < p; j++) {
    let piv = j;
    for (let k = j + 1; k < p; k++) if (Math.abs(A[k][j]) > Math.abs(A[piv][j])) piv = k;
    [A[j], A[piv]] = [A[piv], A[j]]; [b[j], b[piv]] = [b[piv], b[j]];
    if (Math.abs(A[j][j]) < 1e-12) continue;
    for (let k = j + 1; k < p; k++) {
      const f = A[k][j] / A[j][j];
      for (let l = j; l < p; l++) A[k][l] -= f * A[j][l];
      b[k] -= f * b[j];
    }
  }
  const c = new Array(p).fill(0);
  for (let j = p - 1; j >= 0; j--) {
    let s = b[j];
    for (let k = j + 1; k < p; k++) s -= A[j][k] * c[k];
    c[j] = Math.abs(A[j][j]) < 1e-12 ? 0 : s / A[j][j];
  }
  return (r) => c.reduce((s, cj, j) => s + cj * col(j, r), 0);
}

/**
 * A ranker per (held-out season, position). Positions the screens did NOT admit fall back to the
 * projection, by design: shipping a fitted ranking at RB because it was convenient would be
 * promoting a REJECT, and the fallback is what makes the arms differ only where the evidence does.
 */
function buildRanker(feats, admittedPos) {
  const cache = new Map();
  return (p, season, week, proj) => {
    if (!admittedPos.has(p.pos)) return null;
    const key = `${season}|${p.pos}`;
    if (!cache.has(key)) {
      const train = rows.filter((r) => r.season !== season && r.pos === p.pos && r.y != null
        && INCUMBENTS.every((f) => r[f] != null));
      if (train.length < 300) { cache.set(key, null); }
      else {
        const fill = {};
        for (const f of feats) {
          const v = train.map((r) => r[f]).filter((x) => x != null && Number.isFinite(x));
          fill[f] = v.length ? median(v) : 0;
        }
        cache.set(key, { f: fit(train, feats, fill), fill });
      }
    }
    const m = cache.get(key);
    if (!m) return null;
    const r = byKey.get(`${season}|${week}|${p.player_sk}`);
    if (!r) return null;                       // no feature row -> fall back to the projection
    const v = m.f(r);
    return Number.isFinite(v) ? v : null;
  };
}

const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

/**
 * THE ARM THAT MATTERS, added after the first run inverted every expectation.
 *
 * The harness's baseline `proj` is NOT the season line -- it is the WEEKLY PROJECTOR ARTIFACT, the
 * D27/D30 26-feature gradient-boosted model, which ALREADY carries prior_snap_share,
 * prior_route_share, td_ts, td_rush_yards, ecr_wk_rank and ecr_wk_sd. Every feature the screens
 * "found" is already in it. So the screens' arm A (`season_line_pg`) is what PRODUCTION
 * `waiverTargets` ranks on -- it sorts the free-agent pool by value-over-replacement on the BOARD's
 * SEASON projection -- while this harness ranks on something far stronger that the repo already
 * computes every week.
 *
 * That makes the decisive experiment not "does my OLS beat the artifact" (it does not, and should
 * not) but "does the artifact beat the SEASON LINE inside this harness" -- i.e. how much is
 * production leaving on the table by ranking its shortlist with the weaker of two models it already
 * has in hand.
 */
const seasonLineRanker = (p, season, week) => {
  const r = byKey.get(`${season}|${week}|${p.player_sk}`);
  return r?.season_line_pg ?? null;
};

/**
 * THE SAME THING WITH PRODUCTION'S POSITIONAL ADJUSTMENT, because a raw season line is NOT what
 * `waiverTargets` sorts on -- it sorts on VALUE OVER REPLACEMENT, and the whole point of that (per
 * its own docstring) is that season totals are not comparable across positions. Leaving it out would
 * hand production a ranking it does not use and inflate the gap this script reports.
 *
 * `ctx.replacement` is the per-position weekly points freely available off waivers. Reconstructed
 * here as the season line of the man at that position's rostered-depth cutoff in that week -- the
 * same depths the wide screen calibrated from this league's real pool.
 */
const DEPTH = { QB: 22, RB: 48, WR: 57, TE: 22 };
const replCache = new Map();
const replacementFor = (season, week, pos) => {
  const k = `${season}|${week}|${pos}`;
  if (!replCache.has(k)) {
    const at = rows.filter((r) => r.season === season && r.week === week && r.pos === pos
      && r.season_line_pg != null).map((r) => r.season_line_pg).sort((a2, b2) => b2 - a2);
    replCache.set(k, at.length ? (at[Math.min(DEPTH[pos] ?? 40, at.length - 1)] ?? 0) : 0);
  }
  return replCache.get(k);
};
const vorRanker = (p, season, week) => {
  const r = byKey.get(`${season}|${week}|${p.player_sk}`);
  if (r?.season_line_pg == null) return null;
  return r.season_line_pg - replacementFor(season, week, p.pos);
};

const ARMS = [
  { name: "PRODUCTION proxy (season line)", ranker: seasonLineRanker },
  { name: "PRODUCTION proxy (season line VOR)", ranker: vorRanker },
  { name: "shipped (projection)", ranker: undefined },
  { name: "usage @ WR", ranker: buildRanker([...INCUMBENTS, ...USAGE], new Set(["WR"])) },
  { name: "usage+ECR @ WR,QB", ranker: buildRanker([...INCUMBENTS, ...USAGE, ...ECR], new Set(["WR", "QB"])) },
  // A DELIBERATE OVER-REACH, reported so the discipline is visible: the same model applied at ALL
  // four positions, including the two the screens REJECTED. If this beats the admitted-only arm the
  // screens were too conservative; if it does not, the rejections were doing real work.
  { name: "usage+ECR @ ALL (incl. rejected)", ranker: buildRanker([...INCUMBENTS, ...USAGE, ...ECR], new Set(["WR", "QB", "RB", "TE"])) },
];

console.log(`\nWAIVER POLICY BACKTEST -- league ${LEAGUE}, model ${MODEL}, seasons ${SEASONS[0]}-${SEASONS[SEASONS.length - 1]}`);
console.log(`  Replays the room's REAL adds; only the SORT KEY differs between arms.\n`);
console.log(`  arm                                our ppg   room ppg    edge  weeks won   n adds`);
const perArm = [];

for (const a of ARMS) {
  const { summary: s } = backtestWaivers(db, LEAGUE, { seasons: SEASONS, model: MODEL, ranker: a.ranker });
  const our = s.ourPpg, room = s.roomPpg;
  console.log(`  ${a.name.padEnd(34)} ${our.toFixed(2).padStart(8)} ${room.toFixed(2).padStart(10)} ` +
    `${((our - room >= 0 ? "+" : "") + (our - room).toFixed(2)).padStart(8)}` +
    `${(100 * s.weeksWon).toFixed(0).padStart(10)}%` +
    `${String(s.ourAdds).padStart(9)}`);
  perArm.push({ name: a.name, seasons: s.seasons });
}
console.log(`\n  The shipped arm is the control: it must reproduce the number this harness already`);
console.log(`  records, or the seam changed something it was not supposed to.`);
