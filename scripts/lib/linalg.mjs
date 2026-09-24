// OLS, RESIDUALIZATION AND PARTIAL CORRELATION -- in ONE place, with the self-test attached.
//
// This lived inline in qb-opponent-prefilter.mjs and shipped a bug that made every solve return
// NaN, which the caller then reported as "SINGULAR" for every candidate at once -- a clean,
// plausible, entirely false table. The rule this repo keeps paying to relearn is "when you fix one
// caller of a contract, grep for every other one in the same breath"; the cheaper version is to not
// have a second copy. Anything that needs a partial correlation imports this.
//
// The SELF-TEST runs at import. A solver that can only return null reads exactly like a degenerate
// design, so it is proved to return the RIGHT ANSWER on a known system before it is trusted to
// return a null on a real one.

/** Solve A x = b by Gauss-Jordan with partial pivoting. Null if singular. */
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

(function selfTest() {
  const x = solve([[2, 1, 1], [1, 3, 2], [1, 0, 4]], [7, 13, 13]); // x = [1, 2, 3]
  if (!x || x.some((v, i) => !Number.isFinite(v) || Math.abs(v - (i + 1)) > 1e-9)) {
    throw new Error(`linalg solve() self-test FAILED: expected [1,2,3], got ${JSON.stringify(x)}`);
  }
})();

export const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
export const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1));
};

export function corr(a, b) {
  const ma = mean(a), mb = mean(b);
  let sa = 0, sb = 0, sab = 0;
  for (let i = 0; i < a.length; i++) { const da = a[i] - ma, dbv = b[i] - mb; sa += da * da; sb += dbv * dbv; sab += da * dbv; }
  return sa <= 0 || sb <= 0 ? 0 : sab / Math.sqrt(sa * sb);
}

/**
 * Residual of `y` after regressing on `cols` (plus an intercept). Null if singular.
 *
 * COLUMNS ARE STANDARDIZED FIRST. Normal equations square the condition number, and on raw weekly
 * columns spanning 0.06 to 63.5 that alone was enough to fail an elimination on a design that is
 * NOT rank deficient. Standardizing changes no residual -- the column span is identical -- it only
 * lets the arithmetic survive.
 */
export function residualize(data, y, cols) {
  const n = data.length, p = cols.length + 1;
  const mu = cols.map((c) => mean(data.map((r) => Number(r[c]))));
  const sds = cols.map((c, j) => {
    const v = Math.sqrt(data.reduce((a, r) => a + (Number(r[c]) - mu[j]) ** 2, 0) / n);
    return v > 0 ? v : 1;
  });
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  const xs = data.map((r) => [1, ...cols.map((c, j) => (Number(r[c]) - mu[j]) / sds[j])]);
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    for (let j = 0; j < p; j++) { b[j] += x[j] * y[i]; for (let k = 0; k < p; k++) A[j][k] += x[j] * x[k]; }
  }
  const beta = solve(A, b);
  if (!beta || beta.some((v) => !Number.isFinite(v))) return null;
  return y.map((v, i) => v - xs[i].reduce((a, xv, j) => a + xv * beta[j], 0));
}

/**
 * Partial correlation of `cand` with `yKey`, controlling for `controls`.
 *
 * ROWS WITH ANY MISSING VALUE ARE DROPPED, NOT FILLED. Filling an uncovered column with `undefined`
 * NaN-poisoned the normal equations in an earlier screen here and produced an exactly-negated rho
 * that looked like a finding. The surviving `n` is returned so a candidate that only survives on a
 * thin slice is visible rather than inferred.
 *
 * `why` says WHY there is no number: a singular design and an absent column both yield null and
 * call for opposite responses (fix the controls, or drop the candidate).
 */
export function partial(data, cand, controls, yKey = "pts", minN = 200) {
  const need = [cand, ...controls, yKey];
  const use = data.filter((r) => need.every((k) => r[k] != null && Number.isFinite(Number(r[k]))));
  if (use.length < minN) return { n: use.length, raw: null, part: null, why: "thin" };
  const y = use.map((r) => Number(r[yKey]));
  const c = use.map((r) => Number(r[cand]));
  const ry = residualize(use, y, controls), rc = residualize(use, c, controls);
  if (!ry || !rc) return { n: use.length, raw: corr(c, y), part: null, why: "SINGULAR" };
  return { n: use.length, raw: corr(c, y), part: corr(ry, rc), why: null };
}

/**
 * The empirical noise floor for a partial correlation: permute `col` within each season `reps`
 * times and return the spread of |partial| under that null.
 *
 * A single shuffle is one draw and says nothing about scale. The p95 of this distribution IS the
 * bar a candidate has to clear, which beats picking a round number out of the air.
 */
export function shuffleNull(rows, col, controls, yKey, reps = 25, seed0 = 987654321) {
  let seed = seed0;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const parts = [];
  for (let rep = 0; rep < reps; rep++) {
    const sh = rows.map((r) => ({ ...r }));
    const byS = new Map();
    sh.forEach((r, i) => { if (!byS.has(r.season)) byS.set(r.season, []); byS.get(r.season).push(i); });
    for (const [, idx] of byS) {
      const vals = idx.map((i) => sh[i][col]);
      for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
      idx.forEach((i, k) => { sh[i][col] = vals[k]; });
    }
    const p = partial(sh, col, controls, yKey);
    if (p.part != null) parts.push(Math.abs(p.part));
  }
  if (!parts.length) return { reps: 0, mean: null, p95: null, max: null };
  parts.sort((a, b) => a - b);
  return {
    reps: parts.length, mean: mean(parts),
    p95: parts[Math.floor(parts.length * 0.95)] ?? parts[parts.length - 1],
    max: parts[parts.length - 1],
  };
}
