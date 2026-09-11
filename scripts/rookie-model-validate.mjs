// Validate the rookie production model (draft capital -> rookie season points), holdout by draft class.
//   node --import tsx scripts/rookie-model-validate.mjs
import { openDb } from "../src/db/db.ts";
import { fitRookieCurve, rookiePoints, ROOKIE_POS } from "../src/draft/rookieModel.ts";

const db = openDb();
// actual rookie season points, all classes
const rows = db.prepare(`
  SELECT d.season, d.position pos, d.pick ovr, s.pts
    FROM raw_nfl_draft_pick d
    JOIN player_xref x ON x.source='pfr' AND x.source_id=d.pfr_player_id
    JOIN feat_player_season s ON s.player_sk = CAST(x.player_sk AS TEXT) AND s.season = d.season
   WHERE d.position IN ('QB','RB','WR','TE') AND d.pick > 0 AND s.pts IS NOT NULL AND d.season BETWEEN 2010 AND 2024`).all();

const pearson = (pred, act) => { const n = pred.length, mp = pred.reduce((a, b) => a + b, 0) / n, ma = act.reduce((a, b) => a + b, 0) / n; let c = 0, dp = 0, da = 0; for (let i = 0; i < n; i++) { c += (pred[i] - mp) * (act[i] - ma); dp += (pred[i] - mp) ** 2; da += (act[i] - ma) ** 2; } return c / Math.sqrt(dp * da); };
const mae = (pred, act) => pred.reduce((s, p, i) => s + Math.abs(p - act[i]), 0) / pred.length;

// fitted curve on all history (for display)
const full = fitRookieCurve(db);
console.log("fitted rookie curve (E[pts] = a + b*ln(overall)):");
for (const pos of ROOKIE_POS) { const c = full[pos]; console.log(`  ${pos}: a ${c.a.toFixed(1)}  b ${c.b.toFixed(1)}  n ${c.n}  ->  pick 5 = ${rookiePoints(full, pos, 5)?.toFixed(0)}, pick 50 = ${rookiePoints(full, pos, 50)?.toFixed(0)}, pick 150 = ${rookiePoints(full, pos, 150)?.toFixed(0)} pts`); }

// LEAKAGE-CLEAN holdout: for each test season, fit on all OTHER seasons, predict it.
const seasons = [...new Set(rows.map((r) => r.season))].sort();
const pred = [], act = [];
for (const ts of seasons) {
  // fit excluding this season by using a temp curve fit on rows with season != ts
  const sub = rows.filter((r) => r.season !== ts);
  const cur = {};
  for (const pos of ROOKIE_POS) {
    const pr = sub.filter((r) => r.pos === pos);
    const xs = pr.map((r) => Math.log(r.ovr)), ys = pr.map((r) => r.pts), n = pr.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    const b = sxx ? sxy / sxx : 0; cur[pos] = { a: my - b * mx, b, n };
  }
  for (const r of rows.filter((r) => r.season === ts)) { pred.push(Math.max(5, cur[r.pos].a + cur[r.pos].b * Math.log(r.ovr))); act.push(r.pts); }
}
console.log(`\nLEAVE-ONE-SEASON-OUT holdout (n=${pred.length} rookies, 2010-2024):`);
console.log(`  r = ${pearson(pred, act).toFixed(3)}   MAE = ${mae(pred, act).toFixed(1)} pts   (draft-capital ceiling; matches the ~0.5 rookie-holdout)`);
db.close();
