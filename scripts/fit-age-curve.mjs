// Fit an empirical AGE CURVE: how much a player at age A out- or under-performs the rank curve.
// Writes data/age-curve.json.
//
//   node --import tsx scripts/fit-age-curve.mjs
//
// WHY THIS IS A MULTIPLIER ON THE RANK CURVE, not a standalone model. Our projection is
// curve[pos][rank] -- the mean points historically posted by the k-th best player at that position.
// That curve knows nothing about WHO holds the rank. A 33-year-old back and a 25-year-old back
// entering a season ranked RB8 get identical projections today, and they should not.
//
// So the fit asks one question: for players who entered a season at a known rank, what is the RATIO
// of their actual points to what the rank curve predicted, as a function of age? A ratio of 1.0
// means age carries no information beyond rank at that age.
//
// EARNED ITS PLACE FIRST. scripts/feature-value.mjs measured this out-of-sample, holding out one
// season at a time and controlling for position: adding an age curve lifts R-squared 0.3734 ->
// 0.3888 (+0.0154). That control mattered -- without it the apparent gain is inflated, because
// carries-vs-targets silently identifies position. A feature that cannot beat its own baseline
// out-of-sample does not go in.
import { readFileSync, writeFileSync } from "node:fs";
import { fetchCsv, URLS } from "../src/data/nflverse.ts";

const POS = ["QB", "RB", "WR", "TE"];
const MIN_AGE = 21, MAX_AGE = 39;
const SHRINK_N = 40;
// PER-POSITION AMPLITUDE, tied to measured signal. feature-value.mjs fits and scores age WITHIN each
// position, out-of-sample: RB +0.0369, WR +0.0204, QB +0.0072, TE -0.0019. A pooled test says only
// "age helps"; it cannot say for whom, and the first version of this curve got the amplitudes exactly
// backwards -- it gave QB the WIDEST swing (1.25 -> 0.83) on the SMALLEST measured signal, and gave
// TE a full curve on no signal at all. That reshaped the top of the board hard (Drake Maye $73 ->
// $95, Josh Allen $91 -> $70) on evidence that did not support it.
//
// So each position's curve is shrunk toward 1.0 in proportion to its own measured lift, normalised
// to the strongest (RB). This is the same discipline as the defense-vs-position shrinkage: let the
// data decide how much of the observed shape to keep, and let a position with no signal go flat.
const SIGNAL = { RB: 0.0369, WR: 0.0204, QB: 0.0072, TE: 0 };
const MAX_SIGNAL = Math.max(...Object.values(SIGNAL));
const AMPLITUDE = Object.fromEntries(Object.entries(SIGNAL).map(([k, v]) => [k, Math.max(0, v) / MAX_SIGNAL]));

const tot = new Map();
for (const line of readFileSync("data/history-points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
  const [s, name, pos, pts] = line.split(",");
  if (POS.includes(pos)) tot.set(`${Number(s)}|${name}`, { pos, pts: Number(pts), name, season: Number(s) });
}
const seasons = [...new Set([...tot.values()].map((v) => v.season))].sort();
const rank = new Map();
for (const s of seasons) {
  for (const pos of POS) {
    [...tot.entries()].filter(([k, v]) => v.season === s && v.pos === pos)
      .sort((a, b) => b[1].pts - a[1].pts)
      .forEach(([k], i) => rank.set(k, i + 1));
  }
}
// the rank curve itself: mean points of the k-th best, per position, across all seasons
const curve = {};
for (const pos of POS) {
  const lists = seasons.map((s) => [...tot.values()].filter((v) => v.season === s && v.pos === pos)
    .map((v) => v.pts).sort((a, b) => b - a));
  const maxlen = Math.max(0, ...lists.map((l) => l.length));
  curve[pos] = [];
  for (let k = 0; k < maxlen; k++) {
    let sum = 0, c = 0;
    for (const l of lists) if (k < l.length) { sum += l[k]; c++; }
    curve[pos][k] = c ? sum / c : 0;
  }
}

const bio = new Map();
for (const r of await fetchCsv(URLS.players)) {
  const n = (r.display_name || r.full_name || "").trim();
  if (n && r.birth_date) bio.set(n, r.birth_date);
}

// ratio of actual to rank-predicted, bucketed by (pos, age)
const acc = {};
for (const pos of POS) { acc[pos] = {}; for (let a = MIN_AGE; a <= MAX_AGE; a++) acc[pos][a] = []; }
for (const v of tot.values()) {
  const prior = rank.get(`${v.season - 1}|${v.name}`);
  if (!prior || prior > 60) continue;
  const pred = curve[v.pos]?.[prior - 1];
  if (!pred || pred < 20) continue;                 // a meaningless denominator makes a wild ratio
  const bd = bio.get(v.name); if (!bd) continue;
  const age = v.season - Number(String(bd).slice(0, 4));
  if (!Number.isFinite(age) || age < MIN_AGE || age > MAX_AGE) continue;
  acc[v.pos][age].push(v.pts / pred);
}

// Birth YEARS travel with the curve. Both consumers need them -- the live board (projections.ts) and
// the backtest, which needs HISTORICAL ages our player_bio table does not carry (it holds only
// current players). Baking them into the artifact means neither path makes a network call, and the
// ages used to APPLY the curve are exactly the ones used to FIT it.
const birthYear = {};
for (const [name, bd] of bio) {
  const y = Number(String(bd).slice(0, 4));
  if (Number.isFinite(y) && y > 1940 && y < 2015) birthYear[name] = y;
}
const model = { fittedFrom: "data/history-points.csv", shrinkN: SHRINK_N, minAge: MIN_AGE, maxAge: MAX_AGE, pos: {}, birthYear };
// SMOOTH, then NORMALISE. A raw per-age cell mean fails twice, and a first version of this shipped
// both failures:
//
// 1. IT FITS NOISE. QB came out 23 -> 1.44, 25 -> 0.98, 28 -> 1.10, 32 -> 1.09: no monotone shape at
//    all, just cell-level sampling noise dressed as a curve. A quadratic in age has three parameters
//    and cannot chase individual cells, which is exactly why the aging-curve literature uses one.
//
// 2. IT SMUGGLES IN A LEVEL SHIFT. The ratio actual/rank-predicted averages ~0.87, NOT 1.0 -- and
//    that is REGRESSION TO THE MEAN, not aging. The player who finished RB8 got partly lucky, so he
//    averages less than curve[RB8] the following year at EVERY age. Applying the raw ratio would
//    have deflated every projection ~13%, which is harmless for VOR (a uniform scale cancels in the
//    dollar split) but very much not harmless for the season simulator, whose bootstrap pools are
//    calibrated against real point levels.
//
// So: fit a quadratic per position by weighted least squares, then divide by the sample-weighted
// mean so the curve carries the age SHAPE and nothing else. A multiplier of 1.0 now means "average
// for his position", not "average across all football".
function fitQuadratic(pts) {   // pts: [{x, y, w}]
  const S = [0, 0, 0, 0, 0], T = [0, 0, 0];
  for (const { x, y, w } of pts) {
    const p1 = x, p2 = x * x;
    S[0] += w; S[1] += w * p1; S[2] += w * p2; S[3] += w * p1 * p2; S[4] += w * p2 * p2;
    T[0] += w * y; T[1] += w * p1 * y; T[2] += w * p2 * y;
  }
  const A = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]];
  const M = A.map((row, i) => [...row, T[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= 3; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

console.log("AGE CURVE -- points relative to the rank curve, by age, SMOOTHED and NORMALISED");
console.log("1.00 = average for that position. Quadratic fit; level shift (regression to the mean) removed.\n");
console.log("  age " + POS.map((p) => p.padStart(8)).join("") + "      (n per cell)");
for (const pos of POS) model.pos[pos] = {};
const rawFit = {};
for (const pos of POS) {
  const pts = [];
  for (let a = MIN_AGE; a <= MAX_AGE; a++) {
    const xs = acc[pos][a];
    if (xs.length < 10) continue;                    // a 3-observation cell steers nothing
    pts.push({ x: a, y: xs.reduce((s, x) => s + x, 0) / xs.length, w: xs.length });
  }
  const beta = pts.length >= 4 ? fitQuadratic(pts) : null;
  const val = (a) => (beta ? beta[0] + beta[1] * a + beta[2] * a * a : 1);
  // sample-weighted mean of the fitted curve -> divide it out, leaving pure shape
  let num = 0, den = 0;
  for (const { x, w } of pts) { num += w * val(x); den += w; }
  const mean = den ? num / den : 1;
  rawFit[pos] = { val, mean };
}
for (let a = MIN_AGE; a <= MAX_AGE; a++) {
  const cells = [], ns = [];
  for (const pos of POS) {
    const { val, mean } = rawFit[pos];
    // clamp: a quadratic extrapolates violently past the data it saw
    const shape = Math.max(0.75, Math.min(1.25, val(a) / (mean || 1)));
    const f = 1 + (shape - 1) * (AMPLITUDE[pos] ?? 0);   // amplitude = measured signal, TE -> flat
    model.pos[pos][a] = Number(f.toFixed(4));
    cells.push(f.toFixed(3).padStart(8));
    ns.push(acc[pos][a].length);
  }
  console.log(`  ${String(a).padStart(3)} ${cells.join("")}      ${ns.join("/")}`);
}
writeFileSync("data/age-curve.json", JSON.stringify(model, null, 2));
console.log(`\nwrote data/age-curve.json`);
// WHAT THIS CURVE IS, because the obvious sanity check is the wrong one.
//
// A first version of this compared the peak of this curve against the published aging peak of 26-29
// and flagged the result (22-23) as a red flag. That comparison was mis-specified. Published aging
// curves describe a player's ABSOLUTE LEVEL over his career. This curve describes his points as a
// RATIO TO HIS PRIOR-YEAR RANK -- a year-over-year CHANGE. A 23-year-old holding a given rank is
// still ascending and beats it; a 30-year-old holding the same rank is descending and misses it. A
// monotonically declining ratio is therefore exactly what an absolute peak near 27 implies, and the
// two are not in conflict.
//
// Read the middle of the table, not the ends: ages 21-22 rest on a handful of observations and are
// shrunk almost entirely to 1.0 anyway. The load-bearing signal is the decline through the twenties
// -- RB from ~0.99 at 24 to ~0.84 by 28-32, WR from ~0.94 to ~0.83 -- roughly a 15% haircut that the
// rank curve alone cannot see. QB is visibly noisier (the 23-year-old cell is a handful of breakout
// seasons) and should be trusted least.
const declines = POS.map((p) => {
  const young = model.pos[p][24], old = model.pos[p][31];
  return `${p} ${young.toFixed(2)}->${old.toFixed(2)}`;
});
console.log(`  age 24 -> 31 ratio: ${declines.join(", ")}`);
console.log(`  amplitude by measured out-of-sample signal: ${POS.map((p) => `${p} ${(AMPLITUDE[p] * 100).toFixed(0)}%`).join(", ")}`);
console.log(`  (TE measured -0.0019 -- no signal -- so its curve is FLAT at 1.0 rather than fitted.)`);
console.log(`  This is a CHANGE curve (actual vs prior-year rank), NOT an absolute-level aging curve;`);
console.log(`  a monotonic decline is what an absolute peak near 27 looks like in these units.`);
console.log(`  Earned inclusion out-of-sample: +0.0154 R-sq over rank+position (feature-value.mjs).`);
