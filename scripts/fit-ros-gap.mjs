// FIT THE SNAP/TARGET DIVERGENCE CORRECTION TO THE D18 BLEND -> data/ros-gap.json
//
// Screened in `ros-blend-gap-screen.mjs` (docs/validation.md 2026-09-23): the D18 blend
// `(K*line + k*rate)/(K+k)` is a pure POINTS blend and cannot see a man who is on the field and not
// being thrown to. Adding `ts_gap` -- target share minus the median target share at his SNAP-SHARE
// DECILE and position -- cuts held-out RMSE 4.3557 -> 4.2276 (paired +0.1281, floor 0.0555, 13/14
// seasons), with the shuffle control correctly negative at 0/14.
//
// THE SIGN IS THE OPPOSITE OF THE HYPOTHESIS AND THAT IS THE POINT. `ts_gap` carries a NEGATIVE
// coefficient: being UNDER-targeted for your snap share predicts doing BETTER than the blend says.
// It is mean reversion in target share, verified raw (mean blend residual by ts_gap decile is
// monotone at WR, RB and TE), not the role-collapse detector it was designed as.
//
// WHAT THIS WRITES is fitted on ALL seasons -- the artifact that would SERVE. The leave-season-out
// numbers above are the validation; a served artifact that held a season out would be throwing away
// evidence for no reason. Both are stated so the two are not confused.
//
// Usage: node --import tsx scripts/fit-ros-gap.mjs [--seasons 2012-2025] [--out data/ros-gap.json]
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const [LO, HI] = val("--seasons", "2012-2025").split("-").map(Number);
const MIN_LINE = Number(val("--min-line", "3"));
const MIN_REMAINING = Number(val("--min-remaining", "3"));
const K = Number(val("--k", "6"));
const OUT = val("--out", "data/ros-gap.json");
const DECILES = 10;
const POS = ["QB", "RB", "WR", "TE"];
const FEATS = ["line", "k", "ts_gap", "prior_snap_share"];

const db = new Database("data/ff.db", { readonly: true });
const rows = [];
for (let season = LO; season <= HI; season++) {
  const weeks = db.prepare(
    `SELECT feat_key, week, pts, is_bye, season_line_pg, pos, td_ts, prior_snap_share
       FROM feat_player_week_model
      WHERE season = ? AND in_population = 1 AND pos IN ('QB','RB','WR','TE')
      ORDER BY feat_key, week`,
  ).all(season);
  const byKey = new Map();
  for (const r of weeks) { if (!byKey.has(r.feat_key)) byKey.set(r.feat_key, []); byKey.get(r.feat_key).push(r); }
  for (const [, ws] of byKey) {
    const line = ws[0].season_line_pg;
    if (line == null || line < MIN_LINE) continue;
    const nonBye = ws.filter((r) => !r.is_bye);
    for (const cp of ws) {
      if (cp.week < 2) continue;
      const before = nonBye.filter((r) => r.week < cp.week), after = nonBye.filter((r) => r.week >= cp.week);
      if (after.length < MIN_REMAINING) continue;
      const k = before.length;
      const rate = k > 0 ? before.reduce((a, r) => a + (r.pts ?? 0), 0) / k : null;
      const target = after.reduce((a, r) => a + (r.pts ?? 0), 0) / after.length;
      const base = rate == null ? line : (K * line + k * rate) / (K + k);
      rows.push({ pos: cp.pos, line, k, td_ts: cp.td_ts, prior_snap_share: cp.prior_snap_share, resid: target - base });
    }
  }
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** Per position: snap-share decile edges and the median target share inside each. */
const curve = {};
for (const pos of POS) {
  const ok = rows.filter((r) => r.pos === pos && r.prior_snap_share != null && r.td_ts != null);
  if (ok.length < 200) continue;
  const snaps = ok.map((r) => r.prior_snap_share).sort((a, b) => a - b);
  const edges = [];
  for (let i = 1; i < DECILES; i++) edges.push(snaps[Math.floor((i * snaps.length) / DECILES)]);
  const med = [];
  for (let b = 0; b < DECILES; b++) {
    const lo = b === 0 ? -Infinity : edges[b - 1], hi = b === DECILES - 1 ? Infinity : edges[b];
    const cell = ok.filter((r) => r.prior_snap_share >= lo && r.prior_snap_share < hi);
    med.push(cell.length >= 20 ? median(cell.map((r) => r.td_ts)) : median(ok.map((r) => r.td_ts)));
  }
  curve[pos] = { edges, median: med };
}
const gapOf = (r) => {
  if (r.prior_snap_share == null || r.td_ts == null) return null;
  const c = curve[r.pos];
  if (!c) return null;
  let b = 0;
  while (b < c.edges.length && r.prior_snap_share >= c.edges[b]) b++;
  return r.td_ts - c.median[b];
};
for (const r of rows) r.ts_gap = gapOf(r);

const fill = {};
for (const f of FEATS) {
  const v = rows.map((r) => r[f]).filter((x) => x != null && Number.isFinite(x));
  fill[f] = v.length ? median(v) : 0;
}
const p = FEATS.length + 1;
const A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
const col = (j, r) => (j === 0 ? 1 : (r[FEATS[j - 1]] ?? fill[FEATS[j - 1]]));
for (const r of rows) for (let j = 0; j < p; j++) {
  b[j] += col(j, r) * r.resid;
  for (let q = 0; q < p; q++) A[j][q] += col(j, r) * col(q, r);
}
for (let j = 0; j < p; j++) A[j][j] += 1e-6;
for (let j = 0; j < p; j++) {
  let piv = j;
  for (let q = j + 1; q < p; q++) if (Math.abs(A[q][j]) > Math.abs(A[piv][j])) piv = q;
  [A[j], A[piv]] = [A[piv], A[j]]; [b[j], b[piv]] = [b[piv], b[j]];
  for (let q = j + 1; q < p; q++) {
    const f2 = A[q][j] / A[j][j];
    for (let l = j; l < p; l++) A[q][l] -= f2 * A[j][l];
    b[q] -= f2 * b[j];
  }
}
const coef = new Array(p).fill(0);
for (let j = p - 1; j >= 0; j--) {
  let s = b[j];
  for (let q = j + 1; q < p; q++) s -= A[j][q] * coef[q];
  coef[j] = s / A[j][j];
}

console.log(`fit on ${rows.length} (season, player, checkpoint) rows, ${LO}-${HI}, K=${K}`);
console.log(`  intercept ${coef[0].toFixed(4)}`);
FEATS.forEach((f, i) => console.log(`  ${f.padEnd(20)} ${coef[i + 1].toFixed(4)}`));

writeFileSync(OUT, JSON.stringify({
  builtAt: new Date().toISOString(),
  fittedOn: `${LO}-${HI}`, rows: rows.length, K, deciles: DECILES,
  estimand: "correction to the D18 blend: predicted (target - blend) from line, weeks elapsed, snap share, and ts_gap",
  tsGapDefinition: "td_ts minus the median td_ts at this player's snap-share decile and position",
  sign: "ts_gap coefficient is NEGATIVE: under-targeted for your snap share predicts OUTPERFORMING the blend (mean reversion in target share), which is the OPPOSITE of the role-collapse hypothesis it was built to test",
  validation: "leave-season-out held-out RMSE 4.3557 -> 4.2276, paired +0.1281, floor 0.0555, 13/14 seasons; shuffle control negative 0/14. See docs/validation.md 2026-09-23.",
  feats: FEATS, coef, fill, curve,
}, null, 2) + "\n");
console.log(`  wrote ${OUT}`);
