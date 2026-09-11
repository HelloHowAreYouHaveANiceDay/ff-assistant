// DIAGNOSTIC (not a decision test): is the progressive role-trend projection more ACCURATE than the
// frozen line at predicting a player's points -- especially on the role-change players it fires on?
// This separates "no signal exists" from "signal exists but the waiver decision can't monetize it."
// Point-in-time: prediction for week w uses only data through w-1; scored against week-w actual.
//   node --import tsx scripts/inseason-progressive-accuracy.mjs [--seasons 2018-2024]
import { openDb } from "../src/db/db.ts";
import { makeProgressiveProjector, makeRegimeProjector } from "../src/inseason/backtest/progressive.ts";
import { makeRoleAggregates } from "../src/inseason/backtest/opportunity.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const [lo, hi] = arg("--seasons", "2018-2024").split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const db = openDb(arg("--db", undefined));

const prog = makeProgressiveProjector(db, { alpha: 0.5 });
const regime = makeRegimeProjector(db, { alpha: 0.5 });
const roleAgg = makeRoleAggregates(db, { window: 3 });

// buckets: all covered rows, and the subset where role materially changed (|recent - prior| > 0.15).
const acc = { all: { frozen: 0, prog: 0, regime: 0, n: 0 }, change: { frozen: 0, prog: 0, regime: 0, n: 0 } };
for (const season of seasons) {
  const rows = db.prepare(
    `SELECT player_sk, name, pos, week, season_line_pg, pts, is_bye, inj_out
       FROM feat_player_week_model
      WHERE season=? AND pos IN ('RB','WR','TE') AND player_sk IS NOT NULL
        AND season_line_pg IS NOT NULL AND pts IS NOT NULL`,
  ).all(season);
  for (const r of rows) {
    if (r.is_bye || r.inj_out || r.week < 4) continue;   // need a played week and some prior history
    const agg = roleAgg(String(r.player_sk), r.pos, season, r.week);
    if (!agg || agg.games < 3) continue;                  // only where the model has a role signal
    const m = { playerSk: String(r.player_sk), name: r.name, pos: r.pos, proj: r.season_line_pg };
    const fErr = Math.abs(r.season_line_pg - r.pts);
    const pErr = Math.abs(prog(m, season, r.week) - r.pts);
    const gErr = Math.abs(regime(m, season, r.week) - r.pts);
    acc.all.frozen += fErr; acc.all.prog += pErr; acc.all.regime += gErr; acc.all.n++;
    if (agg.rolePrior != null && Math.abs(agg.roleRecent - agg.rolePrior) > 0.15) {
      acc.change.frozen += fErr; acc.change.prog += pErr; acc.change.regime += gErr; acc.change.n++;
    }
  }
}
db.close();

const mae = (b, k) => (b.n ? b[k] / b.n : 0).toFixed(3);
console.log(`\nACCURACY DIAGNOSTIC -- mean abs error vs actual weekly points, RB/WR/TE, ${arg("--seasons", "2018-2024")}`);
console.log(`  (lower is better; the question is whether role-trend beats the frozen line where role CHANGES)\n`);
console.log(`  bucket                 n       frozen MAE   progressive MAE   regime MAE`);
console.log(`  all role-covered   ${String(acc.all.n).padStart(5)}      ${mae(acc.all, "frozen")}         ${mae(acc.all, "prog")}            ${mae(acc.all, "regime")}`);
console.log(`  role CHANGED (>15%)${String(acc.change.n).padStart(5)}      ${mae(acc.change, "frozen")}         ${mae(acc.change, "prog")}            ${mae(acc.change, "regime")}`);
const better = (b) => `frozen ${mae(b, "frozen")} vs prog ${mae(b, "prog")} vs regime ${mae(b, "regime")}`;
console.log(`\n  On role-change players: ${better(acc.change)}`);
const fz = acc.change.frozen / acc.change.n, pg = acc.change.prog / acc.change.n, rg = acc.change.regime / acc.change.n;
console.log(`  => ${Math.min(pg, rg) < fz
  ? "role-trend IS more accurate on role-change players -- signal exists; the waiver decision just can't monetize it."
  : "role-trend is NOT more accurate even where role changed -- the signal is genuinely absent, conviction refuted."}`);
