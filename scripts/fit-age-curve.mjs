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
const SHRINK_N = 40;   // ratios shrink toward 1.0 with this pseudo-count -- thin ages must not swing

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

const model = { fittedFrom: "data/history-points.csv", shrinkN: SHRINK_N, minAge: MIN_AGE, maxAge: MAX_AGE, pos: {} };
console.log("AGE CURVE -- actual points as a multiple of what the RANK curve predicts");
console.log("1.00 = age adds nothing beyond rank. Shrunk toward 1.0 by sample size.\n");
console.log("  age " + POS.map((p) => p.padStart(8)).join("") + "      (n per cell)");
for (const pos of POS) model.pos[pos] = {};
for (let a = MIN_AGE; a <= MAX_AGE; a++) {
  const cells = [], ns = [];
  for (const pos of POS) {
    const xs = acc[pos][a];
    // SHRINKAGE, per the research: an age with 5 observations must not move the projection.
    // ratio = (sum + SHRINK_N * 1.0) / (n + SHRINK_N) -- pulls toward 1.0 exactly as far as the
    // sample is thin, and equals the raw mean once n is large.
    const raw = xs.length ? xs.reduce((s, x) => s + x, 0) : 0;
    const val = (raw + SHRINK_N * 1) / (xs.length + SHRINK_N);
    model.pos[pos][a] = Number(val.toFixed(4));
    cells.push(val.toFixed(3).padStart(8));
    ns.push(xs.length);
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
console.log(`  This is a CHANGE curve (actual vs prior-year rank), NOT an absolute-level aging curve;`);
console.log(`  a monotonic decline is what an absolute peak near 27 looks like in these units.`);
console.log(`  Earned inclusion out-of-sample: +0.0154 R-sq over rank+position (feature-value.mjs).`);
