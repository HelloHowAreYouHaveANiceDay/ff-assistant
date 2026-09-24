// DOES AN OPPONENT COLUMN CARRY QB SIGNAL THE MARKET BLOCK DOES NOT ALREADY HAVE?
//
// The charter's Rule 2: a candidate earns the expensive paired-season screen only after a cheap
// orthogonality/predictiveness check. This is that check, for the QB segment specifically.
//
// THE HYPOTHESIS UNDER TEST is NOT "does defence matter" -- of course it does. It is the much
// narrower "does a measured defence column beat the BETTING MARKET at saying so", because the
// served QB head already carries spread_line, total_line and implied_team_total, and the market
// prices the opponent faster and more completely than a rolling average can. D19 dropped
// defence-versus-position for exactly this reason (neutral under boosting). A raw correlation with
// points would ADMIT every one of these columns for the wrong reason, which is the `prior_vol`
// mistake in a new costume.
//
// So the statistic is the PARTIAL correlation of the candidate with realised points, controlling
// for the incumbent block. Reported alongside:
//   - the RAW correlation, so the gap between raw and partial is visible rather than inferred;
//   - a PER-SEASON SIGN COUNT, because the unit of analysis here is the season, not the row;
//   - a POSITIVE CONTROL (implied_team_total held out of its own controls) -- a harness that cannot
//     find the market is not measuring anything, and a dead lever and a real null are the same
//     flat line;
//   - a NEGATIVE CONTROL (the candidate shuffled across opponents within a season) -- which must
//     come back at ~0 or the partialling is leaking.
//
// LIMIT, STATED NOT BURIED: this is a LINEAR partial correlation and the served head is boosted.
// A column that is useless linearly but useful in interaction would be understated here. That is
// an argument for not treating a near-zero as proof of nothing -- it is a pre-filter, and the
// paired-season screen is the arbiter.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

const ART = JSON.parse(readFileSync("data/weekly-artifact.json", "utf8"));
const POS = process.argv.includes("--pos") ? process.argv[process.argv.indexOf("--pos") + 1] : "QB";
const FROM = 2012, TO = 2025; // the weekly trainer's fitted window (2010-2011 cannot be fitted blind)

// The incumbent block: what the served head for this position already reads that a defence column
// would have to beat. Anchors + form + the whole market block + venue.
//
// `implied_team_total` IS DELIBERATELY ABSENT AND ITS ABSENCE COSTS NOTHING. It is an EXACT linear
// function of the other two: implied_team_total = (total_line + spread_line) / 2, verified over
// 17329 QB rows at max deviation 0.0000000000. Including all three makes the normal equations
// EXACTLY SINGULAR -- which is how the first run of this script returned a null partial for every
// single candidate and would have read as "no opponent signal anywhere" if the solve had not
// refused. The span of the market block is unchanged by dropping it, so the controls are just as
// strong; only the redundancy is gone. (The served head still carries all three, which is fine --
// trees do not invert anything.)
const CONTROLS = [
  "season_line_pg", "td_ppg", "t4_mean", "td_games",
  "spread_line", "total_line", "home", "days_rest", "week_no",
];
const CANDIDATES = [
  "opp_pa_pos", "opp_def_sacks_pg", "opp_def_takeaways_pg",
  "opp_pass_yds_allowed_pg", "opp_rush_yds_allowed_pg",
  "opp_off_sacks_allowed_pg", "opp_off_giveaways_pg",
  "opp_implied_total", "roof_dome",
];

const db = new Database("data/ff.db", { readonly: true });
const minLine = ART.trainMinLine ?? 0;

const rows = db.prepare(
  `SELECT m.season, m.week, m.opponent, m.pts,
          m.season_line_pg, m.td_ppg, m.t4_mean, m.td_games,
          m.spread_line, m.total_line, m.implied_team_total, m.home, m.days_rest,
          ${CANDIDATES.map((c) => `s.${c}`).join(", ")}
     FROM feat_player_week_model m
     JOIN feat_player_week_stream s
       ON s.season=m.season AND s.week=m.week AND s.feat_key=m.feat_key
    WHERE m.pos=? AND m.season BETWEEN ? AND ?
      AND m.pts IS NOT NULL AND m.season_line_pg > ?`,
).all(POS, FROM, TO, minLine);

for (const r of rows) r.week_no = r.week;

// ---- linear algebra: OLS by Gaussian elimination with partial pivoting -------------------------
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null; // singular -- refuse rather than return garbage
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  // `row[i]`, NOT `row[i][i]`. The latter indexes into a NUMBER, yields undefined, and makes every
  // solution NaN -- which `residualize`'s finite-check then reported as "SINGULAR" for every
  // candidate at once. That produced a clean, plausible "PASSED PRE-FILTER: (none)" table on a
  // solver that could not solve x=[1,2,3]. Hence SELF_TEST below: this function is now proved to
  // return the RIGHT ANSWER on a known system before it is allowed to return a null on a real one.
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * POSITIVE CONTROL FOR THE SOLVER ITSELF, run at import. A predicate that can only ever say "no"
 * reads exactly like one that is passing, and a null-returning solver reads exactly like a
 * degenerate design. Prove it can say YES on a system whose answer is known.
 */
(function selfTest() {
  const x = solve([[2, 1, 1], [1, 3, 2], [1, 0, 4]], [7, 13, 13]); // x = [1, 2, 3]
  if (!x || x.some((v, i) => !Number.isFinite(v) || Math.abs(v - (i + 1)) > 1e-9)) {
    throw new Error(`solve() self-test FAILED: expected [1,2,3], got ${JSON.stringify(x)}`);
  }
})();

/**
 * Residual of `y` after regressing on `cols` (plus an intercept). Null if the system is singular.
 *
 * COLUMNS ARE STANDARDIZED BEFORE THE SOLVE. Normal equations SQUARE the condition number, and on
 * raw columns spanning 0.06 (season_line_pg) to 63.5 (total_line) that was enough to make the
 * elimination fail on a design that is NOT rank deficient -- the standardized Gram's smallest
 * pivot/n is 1.0e-1, nowhere near singular. Standardizing does not change the residual (the column
 * span is identical), it only makes the arithmetic survive it.
 */
function residualize(data, y, cols) {
  const n = data.length, p = cols.length + 1;
  const mu = cols.map((c) => data.reduce((a, r) => a + Number(r[c]), 0) / n);
  const sd = cols.map((c, j) => {
    const v = Math.sqrt(data.reduce((a, r) => a + (Number(r[c]) - mu[j]) ** 2, 0) / n);
    return v > 0 ? v : 1; // a constant column contributes nothing; do not divide by zero
  });
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  const xs = data.map((r) => [1, ...cols.map((c, j) => (Number(r[c]) - mu[j]) / sd[j])]);
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    for (let j = 0; j < p; j++) { b[j] += x[j] * y[i]; for (let k = 0; k < p; k++) A[j][k] += x[j] * x[k]; }
  }
  const beta = solve(A, b);
  if (!beta || beta.some((v) => !Number.isFinite(v))) return null;
  return y.map((v, i) => v - xs[i].reduce((a, xv, j) => a + xv * beta[j], 0));
}

function corr(a, b) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sa = 0, sb = 0, sab = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, dbv = b[i] - mb; sa += da * da; sb += dbv * dbv; sab += da * dbv; }
  return sa <= 0 || sb <= 0 ? 0 : sab / Math.sqrt(sa * sb);
}

/**
 * Partial correlation of `cand` with points, controlling for `controls`.
 *
 * ROWS WITH ANY MISSING VALUE ARE DROPPED, NOT FILLED. An earlier screen in this repo filled an
 * uncovered column with `undefined`, which NaN-poisoned the normal equations and produced an
 * exactly-negated rho -- a number that looked like a finding. Dropping is honest and the surviving
 * `n` is printed so a column that only survives on a thin slice is visible.
 */
function partial(data, cand, controls) {
  const use = data.filter((r) => [cand, ...controls, "pts"].every((k) => r[k] != null && Number.isFinite(Number(r[k]))));
  if (use.length < 200) return { n: use.length, raw: null, part: null, why: "thin" };
  const y = use.map((r) => Number(r.pts));
  const c = use.map((r) => Number(r[cand]));
  const ry = residualize(use, y, controls), rc = residualize(use, c, controls);
  // SAY WHY, rather than returning a bare null. A singular design and a genuinely absent column
  // both produce "no number", and the two call for opposite responses: fix the controls, or drop
  // the candidate. The first run of this script conflated them for every candidate at once.
  if (!ry || !rc) return { n: use.length, raw: corr(c, y), part: null, why: "SINGULAR" };
  return { n: use.length, raw: corr(c, y), part: corr(ry, rc), why: null };
}

const seasons = [...new Set(rows.map((r) => r.season))].sort();
console.log(`pos ${POS} | seasons ${FROM}-${TO} | rows ${rows.length} | trainMinLine ${minLine}`);
console.log(`controls (${CONTROLS.length}): ${CONTROLS.join(", ")}`);

// ---- POSITIVE CONTROL: can this harness find signal at all? ------------------------------------
//
// NOT `implied_team_total`. That was the first choice and it is DEGENERATE: it is exactly spanned
// by spread_line + total_line, so its residual is identically zero and its partial is -0.0000 no
// matter how well the harness works. A control that must return zero cannot prove anything. The
// honest control holds out a column that genuinely carries QB signal and is NOT spanned.
for (const ctl of ["total_line", "td_ppg"]) {
  const c = partial(rows, ctl, CONTROLS.filter((x) => x !== ctl));
  console.log(`\nPOSITIVE CONTROL  ${ctl} vs the rest: raw ${c.raw?.toFixed(4)}  PARTIAL ${c.part?.toFixed(4)}  (n=${c.n})`);
}
console.log("  (a harness that cannot find these is not measuring anything)");

// ---- NEGATIVE CONTROL: shuffle a candidate across opponents within each season ------------------
const byS = new Map();
for (const r of rows) { if (!byS.has(r.season)) byS.set(r.season, []); byS.get(r.season).push(r); }
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

/**
 * THE NOISE FLOOR, MEASURED RATHER THAN ASSUMED. A single shuffle gives one draw and says nothing
 * about scale. Repeat it and the spread of |partial| under the null IS the bar a real candidate
 * has to clear -- which beats picking a round number like 0.02 out of the air.
 */
function shuffleNull(col, reps) {
  const parts = [];
  for (let rep = 0; rep < reps; rep++) {
    const sh = rows.map((r) => ({ ...r }));
    const idxByS2 = new Map();
    sh.forEach((r, i) => { if (!idxByS2.has(r.season)) idxByS2.set(r.season, []); idxByS2.get(r.season).push(i); });
    for (const [, idx] of idxByS2) {
      const vals = idx.map((i) => sh[i][col]);
      for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
      idx.forEach((i, k) => { sh[i][col] = vals[k]; });
    }
    const p = partial(sh, col, CONTROLS);
    if (p.part != null) parts.push(Math.abs(p.part));
  }
  parts.sort((a, b) => a - b);
  const mean = parts.reduce((a, b) => a + b, 0) / parts.length;
  return { reps: parts.length, mean, p95: parts[Math.floor(parts.length * 0.95)] ?? parts[parts.length - 1], max: parts[parts.length - 1] };
}
// Shuffle WITHIN the copied array, by index. An earlier version looked the original row up in the
// copy with indexOf, which is always -1 because the copies are different objects -- so it shuffled
// nothing and the negative control would have been a copy of the real one.
const shuffled = rows.map((r) => ({ ...r }));
const idxByS = new Map();
shuffled.forEach((r, i) => {
  if (!idxByS.has(r.season)) idxByS.set(r.season, []);
  idxByS.get(r.season).push(i);
});
for (const [, idx] of idxByS) {
  const vals = idx.map((i) => shuffled[i].opp_pa_pos);
  for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
  idx.forEach((i, k) => { shuffled[i].opp_pa_pos = vals[k]; });
}
const negCtl = partial(shuffled, "opp_pa_pos", CONTROLS);
console.log(`\nNEGATIVE CONTROL  opp_pa_pos shuffled within season:       raw ${negCtl.raw?.toFixed(4)}  PARTIAL ${negCtl.part?.toFixed(4)}  (n=${negCtl.n})`);
const NULLDIST = shuffleNull("opp_pa_pos", 25);
console.log(`NULL DISTRIBUTION over ${NULLDIST.reps} shuffles: mean|partial| ${NULLDIST.mean.toFixed(4)}  p95 ${NULLDIST.p95.toFixed(4)}  max ${NULLDIST.max.toFixed(4)}`);
console.log("  (this is the empirical noise floor -- the bar below is set FROM it, not guessed)");
const BAR = Math.max(0.02, NULLDIST.p95);

// ---- THE CANDIDATES ----------------------------------------------------------------------------
console.log("\ncandidate                   n      raw      PARTIAL   seasons same-sign   verdict");
const out = [];
for (const cand of CANDIDATES) {
  const all = partial(rows, cand, CONTROLS);
  if (all.part == null) { console.log(`${cand.padEnd(26)} ${String(all.n).padStart(6)}   -- ${all.why} --`); continue; }
  let same = 0, seen = 0;
  for (const s of seasons) {
    const p = partial(byS.get(s), cand, CONTROLS);
    if (p.part == null) continue;
    seen++;
    if (Math.sign(p.part) === Math.sign(all.part)) same++;
  }
  // The bar: a partial correlation that is both bigger than the negative control's noise AND
  // consistent in sign across seasons. Neither alone is enough.
  const strong = Math.abs(all.part) >= BAR && same / Math.max(1, seen) >= 0.79;
  out.push({ cand, ...all, same, seen, strong });
  console.log(
    cand.padEnd(26), String(all.n).padStart(6),
    all.raw.toFixed(4).padStart(9), all.part.toFixed(4).padStart(9),
    `      ${String(same).padStart(2)}/${seen}`.padEnd(14),
    strong ? "  SCREEN" : "  skip",
  );
}

const winners = out.filter((o) => o.strong);
console.log(`\nPASSED PRE-FILTER: ${winners.length ? winners.map((w) => w.cand).join(", ") : "(none)"}`);
console.log(`bar: |partial| >= ${BAR.toFixed(4)} (the shuffle null p95) AND same-sign in >= 79% of seasons (11/14).`);
console.log("A pass is NOT an admission -- it buys a paired-season 2.9*SE screen, nothing more.");
db.close();
