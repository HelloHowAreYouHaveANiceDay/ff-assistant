// RE-TEST role-trend on ROOKIES -- the population the progressive-projection experiment (#7) silently
// EXCLUDED (it filtered on non-null season_line_pg, which rookies lack). Rookies have the least-reliable
// preseason line and the biggest in-season role changes, so if role-trend pays anywhere it is here.
//
// Baseline = the new weekly rookie fallback (draft-capital per-game line). Candidate = that line
// re-scaled by role (snap/route) trend. Question: does role-trend cut rookie next-week MAE by MORE than
// the ~2% it gave veterans? Point-in-time; role uses only games before week w.
//   node --import tsx scripts/rookie-weekly-roletrend.mjs
import { openDb } from "../src/db/db.ts";
import { fitRookieCurve, rookieWeeklyLines } from "../src/draft/rookieModel.ts";
import { makeRoleAggregates } from "../src/inseason/backtest/opportunity.ts";

const db = openDb();
const curve = fitRookieCurve(db);
const roleAgg = makeRoleAggregates(db, { window: 2 }); // sma2, the best encoding from #7
const SM = 0.1, LO = 0.5, HI = 2.0;
const mult = (agg, alpha) => {
  if (!agg || agg.games < 2) return 1;
  const ratio = (agg.roleRecent + SM) / (agg.roleToDate + SM);
  return Math.min(HI, Math.max(LO, Math.pow(ratio, alpha)));
};

const acc = { all: { froz: 0, r5: 0, r10: 0, n: 0 }, chg: { froz: 0, r5: 0, r10: 0, n: 0 } };
let lineCov = 0, lineErr = 0, lineN = 0;
for (let season = 2016; season <= 2024; season++) {
  const lines = rookieWeeklyLines(db, season, curve); // sk -> per-game fallback line
  const rows = db.prepare(`
    SELECT m.player_sk sk, m.pos, m.week, m.pts, m.is_bye, m.inj_out
      FROM feat_player_week_model m
      JOIN player_xref x ON x.source='pfr' AND CAST(x.player_sk AS TEXT)=m.player_sk
      JOIN raw_nfl_draft_pick d ON d.pfr_player_id=x.source_id AND d.season=m.season
     WHERE m.season=? AND m.pos IN ('RB','WR','TE') AND m.pts IS NOT NULL AND m.player_sk IS NOT NULL`).all(season);
  for (const r of rows) {
    if (r.is_bye || r.inj_out || r.week < 4) continue;
    const line = lines.get(String(r.sk)); if (line == null) continue;
    const agg = roleAgg(String(r.sk), r.pos, season, r.week);
    if (!agg || agg.games < 2) continue;               // need role history to trend
    const fErr = Math.abs(line - r.pts);
    const e5 = Math.abs(line * mult(agg, 0.5) - r.pts);
    const e10 = Math.abs(line * mult(agg, 1.0) - r.pts);
    acc.all.froz += fErr; acc.all.r5 += e5; acc.all.r10 += e10; acc.all.n++;
    lineErr += fErr; lineN++;
    if (agg.rolePrior != null && Math.abs(agg.roleRecent - agg.rolePrior) > 0.15) {
      acc.chg.froz += fErr; acc.chg.r5 += e5; acc.chg.r10 += e10; acc.chg.n++;
    }
  }
  lineCov += lines.size;
}
db.close();

const mae = (b, k) => (b[k] / b.n).toFixed(3);
const pct = (b, k) => (100 * (b.froz - b[k]) / b.froz).toFixed(1);
console.log(`\nROLE-TREND ON ROOKIES -- weekly MAE vs actual points, RB/WR/TE 2016-2024`);
console.log(`  (baseline = draft-capital rookie fallback line; role-trend re-scales it by snap/route trend)\n`);
console.log(`  bucket             n       frozen fallback   role a=0.5 (impr)   role a=1.0 (impr)`);
console.log(`  all rookie-weeks ${String(acc.all.n).padStart(5)}      ${mae(acc.all, "froz")}          ${mae(acc.all, "r5")} (${pct(acc.all, "r5")}%)     ${mae(acc.all, "r10")} (${pct(acc.all, "r10")}%)`);
console.log(`  role CHANGED     ${String(acc.chg.n).padStart(5)}      ${mae(acc.chg, "froz")}          ${mae(acc.chg, "r5")} (${pct(acc.chg, "r5")}%)     ${mae(acc.chg, "r10")} (${pct(acc.chg, "r10")}%)`);
console.log(`\n  the rookie fallback line itself: MAE ${(lineErr / lineN).toFixed(2)} vs actual over ${lineN} rookie-weeks (is the draft-capital line even reasonable?)`);
console.log(`  vs veterans (#7): role-trend gave ~2% on the change subset. Rookies (a=1.0) give ${pct(acc.chg, "r10")}% -- ${Number(pct(acc.chg, "r10")) > 3.5 ? "MATERIALLY LARGER (~2x), the highest-leverage case, as predicted" : "a similar lift"}. Accuracy only; decision conversion (as in #7) is the next gate.`);
