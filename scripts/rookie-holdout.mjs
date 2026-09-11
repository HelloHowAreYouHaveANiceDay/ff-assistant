// ROOKIE-HOLDOUT VALIDATION -- the gate before wiring prospect features into the projection.
// Rookies never appear in the projection's training set or the historical backtest (both need a
// prior-season finish), so this is the ONLY way to measure whether the college/athletic pillars
// improve a rookie's projection. Question: predicting rookie-season PPG, do athletic_score +
// dominator + breakout_age beat a draft-capital-only baseline, on HELD-OUT rookie classes?
//   node --import tsx scripts/rookie-holdout.mjs
import { openDb } from "../src/db/db.ts";

const db = openDb();
// drafted skill rookies 2016-2024 with a rookie-season PPG (>=4 games) and prospect features.
const rows = db.prepare(`
  WITH ppg AS (
    SELECT player_sk, season, AVG(pts) ppg, COUNT(*) games, MAX(season_line_pg) line
      FROM feat_player_week_model
     WHERE pts IS NOT NULL AND (is_bye=0 OR is_bye IS NULL) AND (inj_out=0 OR inj_out IS NULL)
     GROUP BY player_sk, season)
  SELECT CAST(xr.player_sk AS INTEGER) sk, c.pos, c.draft_year, c.draft_round, c.draft_ovr,
         fp.athletic_score, fp.dominator, fp.breakout_age, p.ppg, p.games, p.line
    FROM raw_combine c
    JOIN player_xref xr ON xr.source='pfr' AND xr.source_id=c.pfr_player_id
    JOIN feat_player_prospect fp ON fp.player_sk = CAST(xr.player_sk AS INTEGER)
    JOIN ppg p ON p.player_sk = CAST(xr.player_sk AS TEXT) AND p.season = c.draft_year
   WHERE c.draft_year BETWEEN 2016 AND 2024 AND c.pos IN ('RB','WR','TE')
     AND c.draft_round IS NOT NULL AND c.draft_ovr IS NOT NULL AND p.games >= 4
`).all();
db.close();

// features
const BASE = ["draft_ovr", "round", "isRB", "isWR", "isTE"];
const PROS = [...BASE, "athletic_score", "dominator", "breakout_age"];
const ONLY = ["isRB", "isWR", "isTE", "athletic_score", "dominator", "breakout_age"]; // no draft capital -- connectivity check
const feat = (r, cols) => cols.map((c) => {
  switch (c) {
    case "draft_ovr": return r.draft_ovr; case "round": return r.draft_round;
    case "isRB": return r.pos === "RB" ? 1 : 0; case "isWR": return r.pos === "WR" ? 1 : 0; case "isTE": return r.pos === "TE" ? 1 : 0;
    case "athletic_score": return r.athletic_score; case "dominator": return r.dominator; case "breakout_age": return r.breakout_age;
    case "line": return r.line;
    default: return null;
  }
});

function solve(A, b) { // Gaussian elimination, partial pivot
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}
function fit(train, cols, lambda = 3) {
  const mean = cols.map((_, j) => { const v = train.map((r) => feat(r, cols)[j]).filter((x) => x != null && Number.isFinite(x)); return v.reduce((a, b) => a + b, 0) / Math.max(1, v.length); });
  const sd = cols.map((_, j) => { const v = train.map((r) => feat(r, cols)[j]).filter((x) => x != null && Number.isFinite(x)); const m = mean[j]; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length)) || 1; });
  const z = (r) => [1, ...feat(r, cols).map((v, j) => ((v == null || !Number.isFinite(v)) ? mean[j] : v - mean[j]) / sd[j])];
  const p = cols.length + 1, XtX = Array.from({ length: p }, () => new Array(p).fill(0)), Xty = new Array(p).fill(0);
  for (const r of train) { const x = z(r); for (let i = 0; i < p; i++) { for (let j = 0; j < p; j++) XtX[i][j] += x[i] * x[j]; Xty[i] += x[i] * r.ppg; } }
  for (let i = 1; i < p; i++) XtX[i][i] += lambda;
  const w = solve(XtX, Xty);
  return (r) => z(r).reduce((s, xi, i) => s + xi * w[i], 0);
}
const mae = (arr, f) => arr.reduce((s, r) => s + Math.abs(f(r) - r.ppg), 0) / arr.length;
const pearson = (arr, f) => { const p = arr.map(f), a = arr.map((r) => r.ppg); const mp = p.reduce((x, y) => x + y, 0) / p.length, ma = a.reduce((x, y) => x + y, 0) / a.length; let n = 0, dp = 0, da = 0; for (let i = 0; i < p.length; i++) { n += (p[i] - mp) * (a[i] - ma); dp += (p[i] - mp) ** 2; da += (a[i] - ma) ** 2; } return n / Math.sqrt(dp * da); };

// Does the SHIPPED projection (season_line_pg) use draft capital optimally for rookies?
const SHIP = ["line"];
const SHIP_DC = ["line", "draft_ovr", "round"];

// holdout by draft-year parity, both directions
const even = rows.filter((r) => r.draft_year % 2 === 0), odd = rows.filter((r) => r.draft_year % 2 === 1);
console.log(`ROOKIE-HOLDOUT: predict rookie-season PPG, drafted RB/WR/TE 2016-2024, >=4 games. n=${rows.length}`);
console.log(`  coverage: athletic ${rows.filter((r) => r.athletic_score != null).length}, dominator ${rows.filter((r) => r.dominator != null).length}, breakout ${rows.filter((r) => r.breakout_age != null).length}, shipped-line ${rows.filter((r) => r.line != null).length}\n`);
for (const [train, test, label] of [[even, odd, "train even yrs -> test odd"], [odd, even, "train odd yrs -> test even"]]) {
  const fB = fit(train, BASE), fP = fit(train, PROS), fO = fit(train, ONLY);
  console.log(`  ${label} (test n=${test.length}):`);
  console.log(`    draft-capital only:  MAE ${mae(test, fB).toFixed(3)}   r ${pearson(test, fB).toFixed(3)}`);
  console.log(`    + prospect features: MAE ${mae(test, fP).toFixed(3)}   r ${pearson(test, fP).toFixed(3)}`);
  console.log(`    prospect ONLY (connectivity, no draft capital): r ${pearson(test, fO).toFixed(3)}`);
  // the SHIPPED projection, and what draft capital adds to it
  const withLine = rows.filter((r) => r.line != null);
  const trainL = withLine.filter((r) => train.includes(r)), testL = withLine.filter((r) => test.includes(r));
  if (testL.length >= 15) {
    const fShip = fit(trainL, SHIP), fShipDc = fit(trainL, SHIP_DC);
    console.log(`    shipped line only (n=${testL.length}):        r ${pearson(testL, fShip).toFixed(3)}`);
    console.log(`    shipped line + draft capital:        r ${pearson(testL, fShipDc).toFixed(3)}   <- does draft capital add over the shipped projection?`);
  } else console.log(`    shipped line: only ${testL.length} rookies have a season_line_pg -- historical rookies are largely UNPRICED`);
}

// Where draft capital is COARSE: Day 3 / undrafted-adjacent (overall pick >= 100). Does college
// production disambiguate the late picks the way the analytics community claims?
console.log(`\n  LATE PICKS (overall >= 100):`);
for (const [train, test, label] of [[even, odd, "test odd"], [odd, even, "test even"]]) {
  const lt = test.filter((r) => r.draft_ovr >= 100);
  if (lt.length < 15) { console.log(`    ${label}: only ${lt.length} late picks -- skip`); continue; }
  const fB = fit(train, BASE), fP = fit(train, PROS);
  console.log(`    ${label} (n=${lt.length}): draft-capital r ${pearson(lt, fB).toFixed(3)}  vs +prospect r ${pearson(lt, fP).toFixed(3)}`);
}
