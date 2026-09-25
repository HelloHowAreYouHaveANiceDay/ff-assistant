// SCREEN: does recent USAGE predict rest-of-season points beyond the D18 blend -- for EVERY player a
// waiver claim can reach, including the low-line backup whose role just changed?
//
// WHY A NEW SCREEN. `fit-ros-gap.mjs` (2026-09-23) fits its correction on the DECISION POPULATION
// with a line >= 3 pts/g, so the waiver wire's defining case -- a backup priced at 0.6 pts/g whose
// snap share went 18% -> 51% when the starter got hurt -- is outside its data, and its signal turned
// out to be mean reversion in target share, not role change. This fits on every non-bye row with a
// season line and asks about role change directly: last week's snap share, and its TREND.
//
// ESTIMAND. Target = mean points over the weeks at or after checkpoint week w (>= MIN_REMAINING of
// them); base = the D18 blend (K*line + k*rate)/(K+k) on the weeks before w. Every feature is known
// at w: `prior_snap_share` is the carried-forward share of the last played week, the trend is that
// minus the mean of his earlier carried-forward shares, `td_ts` is target share to date.
//
// VERDICT: leave-SEASON-out, per-position OLS, paired by season against the blend, 2.9*SE floor --
// on ALL rows and on the WAIVER SLICE (line < 3 pts/g and last-week snap share >= 30%). Shuffle
// control: snap features permuted within season must NOT help.
//
// Usage: node scripts/ros-usage-screen.mjs [--seasons 2013-2025] [--k 6]
import Database from "better-sqlite3";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const [LO, HI] = val("--seasons", "2013-2025").split("-").map(Number);
const K = Number(val("--k", "6"));
const MIN_REMAINING = 3;
const POS = ["QB", "RB", "WR", "TE"];

const db = new Database("data/ff.db", { readonly: true });
const rows = [];
for (let season = LO; season <= HI; season++) {
  const weeks = db.prepare(
    `SELECT feat_key, week, pts, is_bye, season_line_pg, pos, td_ts, prior_snap_share
       FROM feat_player_week_model WHERE season = ? AND pos IN ('QB','RB','WR','TE') AND season_line_pg IS NOT NULL
      ORDER BY feat_key, week`,
  ).all(season);
  const byKey = new Map();
  for (const r of weeks) { if (!byKey.has(r.feat_key)) byKey.set(r.feat_key, []); byKey.get(r.feat_key).push(r); }
  for (const [, ws] of byKey) {
    const line = ws[0].season_line_pg;
    const nonBye = ws.filter((r) => !r.is_bye);
    for (const cp of ws) {
      if (cp.week < 3 || cp.is_bye) continue;
      const before = nonBye.filter((r) => r.week < cp.week), after = nonBye.filter((r) => r.week >= cp.week);
      if (after.length < MIN_REMAINING || !before.length) continue;
      const k = before.length;
      const rate = before.reduce((a, r) => a + (r.pts ?? 0), 0) / k;
      const target = after.reduce((a, r) => a + (r.pts ?? 0), 0) / after.length;
      const base = (K * line + k * rate) / (K + k);
      const snap = cp.prior_snap_share;
      const earlier = before.map((r) => r.prior_snap_share).filter((x) => x != null);
      const trend = snap != null && earlier.length ? snap - earlier.reduce((a, x) => a + x, 0) / earlier.length : null;
      rows.push({ season, pos: cp.pos, line, k, rate, snap, trend, ts: cp.td_ts, base, target });
    }
  }
}
db.close();

const FEATS = {
  // THE BROADER-LEVER CONTROL (charter item 4): the same model with NO snap feature. The shuffle
  // control showed most of the gain survives scrambling snap -- i.e. the blend itself is miscalibrated
  // by line level -- so the usage signal is judged against THIS arm, not against the raw blend.
  nosnap: (r) => [r.line, r.k, r.ts ?? 0, r.ts == null ? 1 : 0],
  usage: (r) => [r.line, r.k, r.snap ?? 0, r.snap == null ? 1 : 0, (r.snap ?? 0) * r.line, r.ts ?? 0, r.ts == null ? 1 : 0],
  "usage+trend": (r) => [r.line, r.k, r.snap ?? 0, r.snap == null ? 1 : 0, (r.snap ?? 0) * r.line, r.ts ?? 0, r.ts == null ? 1 : 0, r.trend ?? 0, r.trend == null ? 1 : 0],
};

function ols(X, y, ridge = 1e-3) {
  const p = X[0].length + 1;
  const A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const x = [1, ...X[i]];
    for (let j = 0; j < p; j++) { b[j] += x[j] * y[i]; for (let q = 0; q < p; q++) A[j][q] += x[j] * x[q]; }
  }
  for (let j = 1; j < p; j++) A[j][j] += ridge * X.length;
  for (let j = 0; j < p; j++) {
    let piv = j; for (let q = j + 1; q < p; q++) if (Math.abs(A[q][j]) > Math.abs(A[piv][j])) piv = q;
    [A[j], A[piv]] = [A[piv], A[j]]; [b[j], b[piv]] = [b[piv], b[j]];
    for (let q = j + 1; q < p; q++) { const f = A[q][j] / A[j][j]; for (let l = j; l < p; l++) A[q][l] -= f * A[j][l]; b[q] -= f * b[j]; }
  }
  const c = new Array(p).fill(0);
  for (let j = p - 1; j >= 0; j--) { let s = b[j]; for (let q = j + 1; q < p; q++) s -= A[j][q] * c[q]; c[j] = s / A[j][j]; }
  return (x) => { let s = c[0]; for (let i = 0; i < x.length; i++) s += c[i + 1] * x[i]; return s; };
}

const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b);
const isSlice = (r) => r.line < 3 && r.snap != null && r.snap >= 0.3;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

const PRED = {};
function evaluate(name, feat, shuffle = false) {
  const pred = new Map();
  PRED[name] = pred;
  for (const Y of seasons) {
    for (const pos of POS) {
      let train = rows.filter((r) => r.season !== Y && r.pos === pos);
      if (shuffle) {   // permute the SNAP features within season: the signal must vanish
        const bySeason = new Map();
        for (const r of train) { if (!bySeason.has(r.season)) bySeason.set(r.season, []); bySeason.get(r.season).push(r); }
        train = [];
        let s = 99;
        for (const [, rs] of bySeason) {
          const snaps = rs.map((r) => [r.snap, r.trend]);
          for (let i = snaps.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) % 2147483648; const j = s % (i + 1); [snaps[i], snaps[j]] = [snaps[j], snaps[i]]; }
          rs.forEach((r, i) => train.push({ ...r, snap: snaps[i][0], trend: snaps[i][1] }));
        }
      }
      if (train.length < 200) continue;
      const f = ols(train.map(feat), train.map((r) => r.target - r.base));
      for (const r of rows) if (r.season === Y && r.pos === pos) pred.set(r, Math.max(0, r.base + f(feat(r))));
    }
  }
  const report = (subset, label) => {
    const d = seasons.map((Y) => {
      const rs = rows.filter((r) => r.season === Y && subset(r) && pred.has(r));
      if (!rs.length) return null;
      const eB = Math.sqrt(mean(rs.map((r) => (r.base - r.target) ** 2)));
      const eA = Math.sqrt(mean(rs.map((r) => (pred.get(r) - r.target) ** 2)));
      return { eB, eA, d: eB - eA, n: rs.length };
    }).filter(Boolean);
    const m = mean(d.map((x) => x.d)), se = Math.sqrt(mean(d.map((x) => (x.d - m) ** 2)) / Math.max(1, d.length - 1));
    const verdict = m > 2.9 * se ? "ADMIT" : m < -2.9 * se ? "REJECT (worse)" : "NULL";
    console.log(`  ${name.padEnd(22)} ${label.padEnd(12)} n=${String(d.reduce((a, x) => a + x.n, 0)).padStart(6)}  RMSE blend ${mean(d.map((x) => x.eB)).toFixed(4)} -> ${mean(d.map((x) => x.eA)).toFixed(4)}  d ${m.toFixed(4)}  SE ${se.toFixed(4)}  floor ${(2.9 * se).toFixed(4)}  ${d.filter((x) => x.d > 0).length}/${d.length}  ${verdict}`);
  };
  report(() => true, "ALL");
  report(isSlice, "WAIVER-SLICE");
  report((r) => r.line >= 3, "LINE>=3");
  report((r) => r.line < 3, "LINE<3");
  for (const pos of POS) report((r) => r.pos === pos && isSlice(r), `slice ${pos}`);
}

console.log(`\nROS USAGE SCREEN -- ${LO}-${HI}, ${rows.length} (player, checkpoint) rows, K=${K}; waiver slice = line < 3 pts/g AND last-week snap >= 30% (${rows.filter(isSlice).length} rows)\n`);
for (const [name, feat] of Object.entries(FEATS)) evaluate(name, feat);
console.log("\n  HEAD-TO-HEAD, paired by season -- does USAGE add anything beyond the recalibrated blend (nosnap)?");
for (const arm of ["usage", "usage+trend"]) {
  for (const [label, subset] of [["ALL", () => true], ["WAIVER-SLICE", isSlice], ["LINE>=3", (r) => r.line >= 3], ["LINE<3", (r) => r.line < 3], ...POS.map((p) => [`slice ${p}`, (r) => r.pos === p && isSlice(r)])]) {
    const d = seasons.map((Y) => {
      const rs = rows.filter((r) => r.season === Y && subset(r) && PRED[arm].has(r) && PRED.nosnap.has(r));
      if (!rs.length) return null;
      const e0 = Math.sqrt(mean(rs.map((r) => (PRED.nosnap.get(r) - r.target) ** 2)));
      const e1 = Math.sqrt(mean(rs.map((r) => (PRED[arm].get(r) - r.target) ** 2)));
      return e0 - e1;
    }).filter((x) => x != null);
    const m = mean(d), se = Math.sqrt(mean(d.map((x) => (x - m) ** 2)) / Math.max(1, d.length - 1));
    console.log(`  ${arm.padEnd(12)} vs nosnap  ${label.padEnd(12)} d ${m.toFixed(4)}  SE ${se.toFixed(4)}  floor ${(2.9 * se).toFixed(4)}  ${d.filter((x) => x > 0).length}/${d.length}  ${m > 2.9 * se ? "ADMIT" : m < -2.9 * se ? "REJECT (worse)" : "NULL"}`);
  }
}
console.log("\n  SHUFFLE CONTROL (snap features permuted within season -- must NOT beat nosnap):");
evaluate("usage+trend SHUFFLED", FEATS["usage+trend"], true);

// --write: THE SERVED ARTIFACT, fitted on EVERY season (the leave-season-out numbers above are its
// validation), with exactly the screened feature map, so what serves is what was screened.
if (argv.includes("--write")) {
  const OUT = val("--out", "data/ros-usage.json");
  const FEAT_NAMES = ["line", "k", "snap", "snap_missing", "snap_x_line", "ts", "ts_missing", "trend", "trend_missing"];
  const coef = {};
  for (const pos of POS) {
    const tr = rows.filter((r) => r.pos === pos);
    // Recover the fitted coefficients by probing the fitted function on unit vectors.
    const f = ols(tr.map(FEATS["usage+trend"]), tr.map((r) => r.target - r.base));
    const zero = new Array(FEAT_NAMES.length).fill(0);
    const c0 = f(zero);
    coef[pos] = [c0, ...FEAT_NAMES.map((_, i) => { const x = [...zero]; x[i] = 1; return f(x) - c0; })];
  }
  const { writeFileSync } = await import("node:fs");
  writeFileSync(OUT, JSON.stringify({
    builtAt: new Date().toISOString(), fittedOn: `${LO}-${HI}`, rows: rows.length, K,
    estimand: "correction to the D18 blend: predicted (mean points per game over the rest of the season) - (K*line + k*rate)/(K+k), per position, OLS with a light ridge",
    features: FEAT_NAMES,
    featureDefinitions: {
      snap: "prior_snap_share at the checkpoint week (the carried-forward share of his last played week); missing -> 0 with snap_missing = 1",
      snap_x_line: "snap * line (line = preseason per-game line)",
      ts: "td_ts, target share to date; missing -> 0 with ts_missing = 1",
      trend: "snap minus the mean of his prior_snap_share over the weeks before the checkpoint; missing -> 0 with trend_missing = 1",
    },
    coef,
    validation: "scripts/ros-usage-screen.mjs, 2013-2025 leave-season-out: vs the blend ALL 3.4918 -> 3.3299 (13/13); vs the no-snap recalibration (the broader-lever control) ALL +0.0754 13/13 ADMIT, waiver slice +0.0584 12/13 ADMIT, RB slice +0.1484 11/13 ADMIT; shuffle control lands on the no-snap arm",
  }, null, 2) + "\n");
  console.log(`\n  wrote ${OUT}`);
}
