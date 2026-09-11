// Compare CHANGE-METRIC encodings (SMA / EWMA / crossover / slope) on the ACCURACY diagnostic -- the
// high-powered test (n in the thousands, not the ~30-divergence decision test). Question: does any
// encoding of role change beat the frozen line's next-week-points accuracy by MORE than the ~2% the
// Phase-2 SMA(3) got, on the role-change players?
//
// RIGOR: (1) the role-change POPULATION is fixed (same player-weeks judged for every metric, defined by
// SMA3 |recent-prior|>0.15) so the comparison is apples-to-apples; (2) the best metric is SELECTED on
// DESIGN seasons and its improvement QUOTED on HELD-OUT seasons -- picking the best of a family on the
// same data it is reported on is the winner's curse this whole experiment is built to avoid.
//   node --import tsx scripts/inseason-change-metrics.mjs
import { openDb } from "../src/db/db.ts";
import { makeRolePriorSeries, makeRoleAggregates } from "../src/inseason/backtest/opportunity.ts";
import { CHANGE_METRICS, multiplierOf } from "../src/inseason/backtest/changeMetrics.ts";

const db = openDb();
const series = makeRolePriorSeries(db);
const agg = makeRoleAggregates(db, { window: 3 });
const PARAMS = { alpha: 0.5, smoothing: 0.1, lo: 0.5, hi: 2.0 };
const GROUPS = { A: [2018, 2019, 2020, 2021], B: [2022, 2023, 2024] };

// per group: frozen abs-err sum + n, and per-metric abs-err sum, on the role-change population.
const stat = {};
for (const g of Object.keys(GROUPS)) stat[g] = { n: 0, frozen: 0, metric: Object.fromEntries(CHANGE_METRICS.map((m) => [m.name, 0])) };

for (const [g, seasons] of Object.entries(GROUPS)) {
  for (const season of seasons) {
    const rows = db.prepare(
      `SELECT player_sk, pos, week, season_line_pg, pts, is_bye, inj_out
         FROM feat_player_week_model
        WHERE season=? AND pos IN ('RB','WR','TE') AND player_sk IS NOT NULL
          AND season_line_pg IS NOT NULL AND pts IS NOT NULL`,
    ).all(season);
    for (const r of rows) {
      if (r.is_bye || r.inj_out || r.week < 4) continue;
      const a = agg(String(r.player_sk), r.pos, season, r.week);
      if (!a || a.games < 3 || a.rolePrior == null) continue;
      if (Math.abs(a.roleRecent - a.rolePrior) <= 0.15) continue;   // FIXED population: material role change
      const prior = series(String(r.player_sk), r.pos, season, r.week);
      if (!prior) continue;
      const s = stat[g];
      s.n++; s.frozen += Math.abs(r.season_line_pg - r.pts);
      for (const m of CHANGE_METRICS) {
        const e = m.est(prior);
        const pred = e ? r.season_line_pg * multiplierOf(e, PARAMS) : r.season_line_pg;
        s.metric[m.name] += Math.abs(pred - r.pts);
      }
    }
  }
}
db.close();

const mae = (g, k) => (k === "frozen" ? stat[g].frozen : stat[g].metric[k]) / stat[g].n;
const impr = (g, k) => mae(g, "frozen") - mae(g, k);   // + => metric beats frozen (lower MAE)

console.log(`\nCHANGE-METRIC ACCURACY on role-change players (alpha ${PARAMS.alpha}). + improvement = lower MAE than frozen.`);
console.log(`  A=2018-2021 (n ${stat.A.n}, frozen MAE ${mae("A","frozen").toFixed(3)})   B=2022-2024 (n ${stat.B.n}, frozen MAE ${mae("B","frozen").toFixed(3)})\n`);
console.log(`  metric            improvement A     improvement B`);
for (const m of CHANGE_METRICS)
  console.log(`  ${m.name.padEnd(16)}  ${impr("A", m.name).toFixed(4).padStart(8)}        ${impr("B", m.name).toFixed(4).padStart(8)}`);

// Holdout-disciplined selection: pick the best metric on DESIGN, quote its HOLDOUT improvement.
const bestOn = (g) => CHANGE_METRICS.map((m) => [m.name, impr(g, m.name)]).sort((a, b) => b[1] - a[1])[0];
const [bestA, bestAval] = bestOn("A"), [bestB, bestBval] = bestOn("B");
console.log(`\n  HOLDOUT-DISCIPLINED:`);
console.log(`    tune on A -> best "${bestA}" (A ${bestAval.toFixed(4)});  its HELD-OUT improvement on B = ${impr("B", bestA).toFixed(4)}`);
console.log(`    tune on B -> best "${bestB}" (B ${bestBval.toFixed(4)});  its HELD-OUT improvement on A = ${impr("A", bestB).toFixed(4)}`);
const ceil = Math.max(impr("B", bestA), impr("A", bestB));
console.log(`\n  Best HELD-OUT accuracy gain any encoding delivers: ${ceil.toFixed(4)} MAE pts on a ~${mae("A","frozen").toFixed(1)} base (${(100 * ceil / mae("A", "frozen")).toFixed(1)}%).`);
console.log(`  ${ceil < 0.15 ? "Still tiny -- the role-signal ceiling is ~2%, robust to the change encoding; conviction is real but not monetizable." : "Materially larger than SMA(3) -- worth promoting this encoding to the decision test."}`);
