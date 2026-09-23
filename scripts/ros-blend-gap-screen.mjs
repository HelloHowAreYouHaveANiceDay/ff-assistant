// IS HE ON THE FIELD AND NOT BEING THROWN TO? -- the snap/target DIVERGENCE feature.
//
// WHY A NEW FEATURE RATHER THAN MORE OF THE OLD ONES. `ros-blend-usage-screen.mjs` admitted a usage
// correction pooled (+0.1267 RMSE, 12/14 seasons) and then FAILED the case that motivated it:
// Marvin Harrison Jr. moved 7.08 -> 6.91, a -0.17 nudge. The coefficients said why --
//
//     td_ts -6.4202   prior_snap_share +2.8296   ts_x_line +0.4958   line -0.3117
//
// -- snap share carries +2.83 and he plays 79% of snaps, so `snap +2.09` and `line -2.75` nearly
// cancel and the target-share term is left pushing against its own confound. RAW TARGET SHARE AND
// RAW SNAP SHARE ARE HEAVILY CORRELATED: a man who plays more is thrown to more, so an OLS on both
// spends its coefficients separating them instead of measuring what is left over.
//
// THE FEATURE. `ts_gap` = his actual target share MINUS the target share typical of a player at his
// SNAP SHARE and position. Orthogonal to snap share BY CONSTRUCTION, which is the whole point: a
// negative gap is precisely "he is on the field and not being thrown to", and it cannot be re-read
// as "he does not play much" because that has been divided out.
//
// NON-PARAMETRIC, so no functional form is smuggled in: the expectation is the TRAINING FOLD's
// median target share within snap-share deciles, per position. Fitted inside the fold loop, never on
// the held-out season -- an expectation curve built on all seasons would let a season calibrate the
// baseline it is then scored against.
//
// SERVABLE THIS SEASON, which the previous candidate was not: it uses `td_ts` and
// `prior_snap_share` only. `prior_route_share` has 0% coverage in 2026 and any model needing it
// would serve a median fill for every player in the season it would actually be used (the D30
// dark-column failure). This deliberately does not touch it.
//
// SECOND LOOK, AND SAID SO: this is a second candidate screened on the same panel after seeing the
// first one's coefficients. The estimate is optimistic by construction. The honest test is not the
// pooled number, it is whether it moves the case it was designed for AND clears a floor.
//
// Usage: node --import tsx scripts/ros-blend-gap-screen.mjs [--seasons 2012-2025] [--shuffle]
import Database from "better-sqlite3";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const [LO, HI] = val("--seasons", "2012-2025").split("-").map(Number);
const MIN_LINE = Number(val("--min-line", "3"));
const MIN_REMAINING = Number(val("--min-remaining", "3"));
const K = Number(val("--k", "6"));
const SHUFFLE = argv.includes("--shuffle");
const DECILES = 10;

const db = new Database("data/ff.db", { readonly: true });

const rows = [];
for (let season = LO; season <= HI; season++) {
  const weeks = db.prepare(
    `SELECT feat_key, week, pts, is_bye, season_line_pg, pos, td_ts, prior_snap_share, name
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
      const w = cp.week;
      if (w < 2) continue;
      const before = nonBye.filter((r) => r.week < w), after = nonBye.filter((r) => r.week >= w);
      if (after.length < MIN_REMAINING) continue;
      const k = before.length;
      const rate = k > 0 ? before.reduce((a, r) => a + (r.pts ?? 0), 0) / k : null;
      const target = after.reduce((a, r) => a + (r.pts ?? 0), 0) / after.length;
      const base = rate == null ? line : (K * line + k * rate) / (K + k);
      rows.push({
        season, pos: cp.pos, name: cp.name, line, k, rate, target, base, resid: target - base,
        td_ts: cp.td_ts, prior_snap_share: cp.prior_snap_share,
      });
    }
  }
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const rmse = (rs, f) => Math.sqrt(rs.reduce((a, r) => a + (f(r) - r.target) ** 2, 0) / rs.length);

/**
 * The expectation curve: per position, snap-share decile -> median target share, from TRAIN ONLY.
 * Returns a function giving `ts_gap` for any row, or null when either input is missing.
 */
function gapModel(train) {
  const cuts = new Map();          // pos -> { edges:number[], med:number[] }
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const ok = train.filter((r) => r.pos === pos && r.prior_snap_share != null && r.td_ts != null);
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
    cuts.set(pos, { edges, med });
  }
  return (r) => {
    if (r.prior_snap_share == null || r.td_ts == null) return null;
    const c = cuts.get(r.pos);
    if (!c) return null;
    let b = 0;
    while (b < c.edges.length && r.prior_snap_share >= c.edges[b]) b++;
    return r.td_ts - c.med[b];
  };
}

function fit(train, feats, fill) {
  const p = feats.length + 1;
  const A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
  const col = (j, r) => (j === 0 ? 1 : (r[feats[j - 1]] ?? fill[feats[j - 1]]));
  for (const r of train) for (let j = 0; j < p; j++) {
    b[j] += col(j, r) * r.resid;
    for (let q = 0; q < p; q++) A[j][q] += col(j, r) * col(q, r);
  }
  for (let j = 0; j < p; j++) A[j][j] += 1e-6;
  for (let j = 0; j < p; j++) {
    let piv = j;
    for (let q = j + 1; q < p; q++) if (Math.abs(A[q][j]) > Math.abs(A[piv][j])) piv = q;
    [A[j], A[piv]] = [A[piv], A[j]]; [b[j], b[piv]] = [b[piv], b[j]];
    if (Math.abs(A[j][j]) < 1e-12) continue;
    for (let q = j + 1; q < p; q++) {
      const f2 = A[q][j] / A[j][j];
      for (let l = j; l < p; l++) A[q][l] -= f2 * A[j][l];
      b[q] -= f2 * b[j];
    }
  }
  const c = new Array(p).fill(0);
  for (let j = p - 1; j >= 0; j--) {
    let s = b[j];
    for (let q = j + 1; q < p; q++) s -= A[j][q] * c[q];
    c[j] = Math.abs(A[j][j]) < 1e-12 ? 0 : s / A[j][j];
  }
  return { predict: (r) => c.reduce((s, cj, j) => s + cj * col(j, r), 0), coef: c };
}

const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b);

/** Arms. `gap` is the candidate; `usage` is the previously-admitted set, as the thing to beat. */
const ARMS = {
  gap: ["line", "k", "ts_gap"],
  "gap+snap": ["line", "k", "ts_gap", "prior_snap_share"],
  usage: ["line", "k", "td_ts", "prior_snap_share"],
};

console.log(`\nROS-BLEND SNAP/TARGET DIVERGENCE -- ${LO}-${HI}, K=${K}, n=${rows.length}` +
  `${SHUFFLE ? "   *** SHUFFLED RESIDUALS (control) ***" : ""}`);
console.log(`  ts_gap = target share MINUS the median target share at his snap-share decile and position (train-fold only).\n`);
console.log(`  arm         pos     RMSE K=${K}   arm RMSE    paired d       SE     floor   verdict`);

const lastCoef = {};
for (const [armName, feats] of Object.entries(ARMS)) {
  for (const pos of ["ALL", "WR", "RB", "TE"]) {
    const sub = pos === "ALL" ? rows : rows.filter((r) => r.pos === pos);
    if (sub.length < 2000) continue;
    const per = [];
    for (const ho of seasons) {
      const tr = sub.filter((r) => r.season !== ho);
      let te = sub.filter((r) => r.season === ho);
      if (tr.length < 500 || te.length < 100) continue;
      // The gap curve is fitted on the TRAIN fold and applied to both sides.
      const g = gapModel(rows.filter((r) => r.season !== ho));
      for (const r of tr) r.ts_gap = g(r);
      for (const r of te) r.ts_gap = g(r);
      if (SHUFFLE) {
        const sh = te.map((r) => r.resid).sort(() => Math.random() - 0.5);
        te = te.map((r, i) => ({ ...r, resid: sh[i], target: r.base + sh[i] }));
      }
      const fill = {};
      for (const f of feats) {
        const v = tr.map((r) => r[f]).filter((x) => x != null && Number.isFinite(x));
        fill[f] = v.length ? median(v) : 0;
      }
      const m = fit(tr, feats, fill);
      if (pos === "ALL") lastCoef[armName] = { feats, coef: m.coef, fill };
      per.push({ base: rmse(te, (r) => r.base), cand: rmse(te, (r) => r.base + m.predict(r)) });
    }
    if (per.length < 3) continue;
    const d = per.map((x) => x.base - x.cand);
    const mn = mean(d);
    const sd = Math.sqrt(d.reduce((s, x) => s + (x - mn) ** 2, 0) / Math.max(1, d.length - 1));
    const se = sd / Math.sqrt(d.length);
    const floor = 2.9 * se;
    console.log(`  ${armName.padEnd(11)} ${pos.padEnd(5)} ${mean(per.map((x) => x.base)).toFixed(4).padStart(9)} ${mean(per.map((x) => x.cand)).toFixed(4).padStart(10)}  ` +
      `${((mn >= 0 ? "+" : "") + mn.toFixed(4)).padStart(9)} ${se.toFixed(4).padStart(8)} ${floor.toFixed(4).padStart(9)}   ` +
      `${mn > floor ? "ADMIT" : "REJECT"}  (${d.filter((x) => x > 0).length}/${d.length})`);
  }
  console.log();
}

// ---- FACE VALIDITY: the case this was built for --------------------------------------------------
{
  const g = gapModel(rows);                       // all seasons; this is a DISPLAY fit, not a verdict
  const m = fit(rows.map((r) => ({ ...r, ts_gap: g(r) })), ARMS["gap+snap"],
    Object.fromEntries(ARMS["gap+snap"].map((f) => {
      const v = rows.map((r) => r[f] ?? g(r)).filter((x) => x != null && Number.isFinite(x));
      return [f, v.length ? median(v) : 0];
    })));
  const live = db.prepare(
    `SELECT name, season_line_pg, td_ts, prior_snap_share, pos FROM feat_player_week_model
      WHERE season=2026 AND week=3 AND name IN ('Marvin Harrison Jr.','Chris Godwin Jr.','Michael Pittman Jr.','Jameson Williams')`,
  ).all();
  console.log(`  FACE VALIDITY -- live 2026 week 3 (display fit on all seasons, not a verdict)`);
  console.log(`  ${"player".padEnd(22)} snap    ts    ts_gap    K=6 blend   +gap adj    delta`);
  for (const p of live) {
    const r = { pos: p.pos, line: p.season_line_pg, k: 2, td_ts: p.td_ts, prior_snap_share: p.prior_snap_share };
    const rateRow = db.prepare(`SELECT SUM(COALESCE(pts,0)) s, COUNT(*) n FROM feat_player_week_model WHERE season=2026 AND week<3 AND name=? AND is_bye=0`).get(p.name);
    const rate = rateRow.n ? rateRow.s / rateRow.n : null;
    r.rate = rate;
    const base = rate == null ? r.line : (K * r.line + 2 * rate) / (K + 2);
    r.base = base; r.ts_gap = g(r);
    const adj = m.predict(r);
    console.log(`  ${p.name.padEnd(22)} ${(p.prior_snap_share ?? 0).toFixed(2)}  ${(p.td_ts ?? 0).toFixed(3)}  ${(r.ts_gap ?? 0).toFixed(4).padStart(8)}   ${base.toFixed(2).padStart(9)}   ${(base + adj).toFixed(2).padStart(8)}   ${((adj >= 0 ? "+" : "") + adj.toFixed(2)).padStart(6)}`);
  }
  console.log(`\n  gap+snap coefficients (all-season display fit):`);
  const c = lastCoef["gap+snap"];
  if (c) { console.log(`    intercept ${c.coef[0].toFixed(3)}`); c.feats.forEach((f, i) => console.log(`    ${f.padEnd(20)} ${c.coef[i + 1].toFixed(4)}`)); }
}
