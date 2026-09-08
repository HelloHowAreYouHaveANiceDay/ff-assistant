// DEPRECATED (Phase 2a, 2026-09-08). SUPERSEDED BY `ff evaluate-projection`.
//
// This script is left in place because docs/validation.md and src/draft/age.ts both cite its
// numbers, and deleting the source of a recorded figure makes the record unverifiable. It is NOT
// migrated onto feat_player_season and it should not be re-run to decide anything:
//
//   - it derives prior-year rank and prior-season usage for itself, from history-points.csv and a
//     fresh nflverse download, joined by NAME -- the derivations Phase 2a consolidated into one
//     table precisely because five copies of them had drifted;
//   - it holds one season out and reports that as the out-of-sample number, which is the single-loop
//     measurement whose selection effect halved both shipped lifts once nested CV saw it;
//   - it scores against the ORDER-STATISTIC curve, which Phase 1 established is the wrong quantity.
//
// Use instead:  npm run ff -- evaluate-projection --seasons 2008-2025
// which runs the SHIPPED projector, re-invokes the trainer per outer fold, and scores against two
// baselines computed by the same code path.
//
//   node --import tsx scripts/feature-value.mjs
//
// This is a MEASURE-BEFORE-BUILD test, and the reason matters. Our projection is prior-season
// positional rank -> historical points at that rank, which is a consensus-shaped predictor. The
// research says the lift is in opportunity (volume) rather than a better ranking, and that aging
// curves peak at 26-29. But adding either blindly risks DOUBLE-COUNTING: expert consensus already
// knows a 33-year-old back declines and already knows who gets the carries. If the information is
// in the rank, a second copy of it makes the model worse, not better.
//
// So: fit next-season points on prior-season rank alone, then add each candidate feature and measure
// the INCREMENTAL R-squared, out of sample by season. A feature earns its place or it does not.
import { readFileSync } from "node:fs";
import { fetchCsv, playerWeekUrl, URLS } from "../src/data/nflverse.ts";

const POS = ["QB", "RB", "WR", "TE"];
const SEASONS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

// --- our history: season totals + prior-season rank ----------------------------------------------
const tot = new Map();   // season|name -> {pos, pts}
for (const line of readFileSync("data/history-points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
  const [s, name, pos, pts] = line.split(",");
  if (!POS.includes(pos)) continue;
  tot.set(`${Number(s)}|${name}`, { pos, pts: Number(pts) });
}
const rank = new Map();
for (const s of SEASONS.concat([2014])) {
  for (const pos of POS) {
    [...tot.entries()].filter(([k, v]) => k.startsWith(`${s}|`) && v.pos === pos)
      .sort((a, b) => b[1].pts - a[1].pts)
      .forEach(([k], i) => rank.set(k, i + 1));
  }
}

// --- birth dates for age -------------------------------------------------------------------------
const bio = new Map();
for (const r of await fetchCsv(URLS.players)) {
  const n = (r.display_name || r.full_name || "").trim();
  if (n && r.birth_date) bio.set(n, r.birth_date);
}

// --- prior-season OPPORTUNITY per player ---------------------------------------------------------
const N = (v) => Number(v ?? 0) || 0;
const opp = new Map();   // season|name -> {g, tgt, car, air, touch}
for (const yr of [2014, ...SEASONS]) {
  let rows;
  try { rows = await fetchCsv(playerWeekUrl(yr)); } catch { continue; }
  const agg = new Map();
  for (const r of rows) {
    if (r.season_type !== "REG") continue;
    const name = (r.player_display_name || "").trim();
    if (!name || !POS.includes((r.position || "").toUpperCase())) continue;
    const a = agg.get(name) ?? { g: 0, tgt: 0, car: 0, air: 0 };
    a.g += 1;
    a.tgt += N(r.targets); a.car += N(r.carries); a.air += N(r.receiving_air_yards);
    agg.set(name, a);
  }
  for (const [name, a] of agg) opp.set(`${yr}|${name}`, { ...a, touch: a.tgt + a.car });
}

// --- build rows: predict season Y points from season Y-1 -----------------------------------------
const rows = [];
for (const s of SEASONS) {
  for (const [k, v] of tot) {
    if (!k.startsWith(`${s}|`)) continue;
    const name = k.slice(String(s).length + 1);
    const pk = `${s - 1}|${name}`;
    const r = rank.get(pk); if (!r || r > 60) continue;
    const o = opp.get(pk); if (!o || o.g < 4) continue;
    const bd = bio.get(name); if (!bd) continue;
    const age = s - Number(String(bd).slice(0, 4));
    if (!Number.isFinite(age) || age < 20 || age > 42) continue;
    rows.push({ season: s, pos: v.pos, y: v.pts, rank: r, age,
      tgtG: o.tgt / o.g, carG: o.car / o.g, airG: o.air / o.g, touchG: o.touch / o.g, games: o.g });
  }
}
const ALL_ROWS = [...rows];
console.log(`${rows.length} player-seasons with prior-year rank, opportunity and age\n`);

// --- OLS with season-held-out scoring -------------------------------------------------------------
function fit(train, cols) {
  const n = train.length, p = cols.length + 1;
  const X = train.map((r) => [1, ...cols.map((c) => c(r))]);
  const y = train.map((r) => r.y);
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b]; }
  }
  for (let a = 0; a < p; a++) XtX[a][a] += 1e-6;   // ridge nudge for stability
  // gaussian elimination
  const M = XtX.map((row, i) => [...row, Xty[i]]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r2 = c + 1; r2 < p; r2++) if (Math.abs(M[r2][c]) > Math.abs(M[piv][c])) piv = r2;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r2 = 0; r2 < p; r2++) {
      if (r2 === c) continue;
      const f = M[r2][c] / M[c][c];
      for (let k2 = c; k2 <= p; k2++) M[r2][k2] -= f * M[c][k2];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[p] / row[i]));
}
function oosR2(cols) {
  let ss = 0, sst = 0;
  for (const hold of SEASONS) {
    const train = rows.filter((r) => r.season !== hold), test = rows.filter((r) => r.season === hold);
    if (train.length < 50 || !test.length) continue;
    const beta = fit(train, cols);
    const mean = train.reduce((a, r) => a + r.y, 0) / train.length;
    for (const r of test) {
      const pred = beta[0] + cols.reduce((a, c, i) => a + beta[i + 1] * c(r), 0);
      ss += (r.y - pred) ** 2; sst += (r.y - mean) ** 2;
    }
  }
  return 1 - ss / sst;
}

const RANK = (r) => r.rank;
const RANK2 = (r) => r.rank * r.rank;
// POSITION CONTROLS. Without these the test is confounded: carries-vs-targets effectively IDENTIFIES
// position, and positions score at different levels, so "opportunity" could win purely by acting as
// a position dummy. That would be a mirage here, because our real curve is ALREADY per-position
// (curve[pos][rank]) -- so the honest baseline has to know the position too.
const IS_RB = (r) => (r.pos === "RB" ? 1 : 0);
const IS_WR = (r) => (r.pos === "WR" ? 1 : 0);
const IS_TE = (r) => (r.pos === "TE" ? 1 : 0);
const BASE = [RANK, RANK2, IS_RB, IS_WR, IS_TE];
const MODELS = [
  ["rank + POSITION (honest baseline)",  BASE],
  ["+ age",                              [...BASE, (r) => r.age]],
  ["+ age + age^2 (a curve)",            [...BASE, (r) => r.age, (r) => r.age * r.age]],
  ["+ touches/game",                     [...BASE, (r) => r.touchG]],
  ["+ targets/game",                     [...BASE, (r) => r.tgtG]],
  ["+ carries/game",                     [...BASE, (r) => r.carG]],
  ["+ air yards/game",                   [...BASE, (r) => r.airG]],
  ["+ games played (durability)",        [...BASE, (r) => r.games]],
  ["+ ALL opportunity",                  [...BASE, (r) => r.tgtG, (r) => r.carG, (r) => r.airG, (r) => r.games]],
  ["+ ALL opportunity + age curve",      [...BASE, (r) => r.tgtG, (r) => r.carG, (r) => r.airG, (r) => r.games, (r) => r.age, (r) => r.age * r.age]],
];
console.log("OUT-OF-SAMPLE R-squared, holding out one season at a time");
console.log("  model                                 R-sq     vs baseline");
const base = oosR2(BASE);
for (const [name, cols] of MODELS) {
  const r2 = oosR2(cols);
  const d = r2 - base;
  const flag = name.startsWith("rank +") ? "" : Math.abs(d) < 0.004 ? "   (no real change)" : d > 0 ? "   <- ADDS SIGNAL" : "   <- HURTS";
  console.log(`  ${name.padEnd(36)} ${r2.toFixed(4)}   ${(d >= 0 ? "+" : "") + d.toFixed(4)}${flag}`);
}
// --- PER-POSITION age test ------------------------------------------------------------------------
// The pooled test says "age helps" but cannot say FOR WHOM, and that matters here. The raw QB age
// cells showed NO monotone pattern (23 -> 1.44, 25 -> 0.98, 28 -> 1.10), and a quadratic will
// happily impose a confident shape on noise. If QB's age effect is not real, the smoothed curve
// swings a 23-year-old QB up ~25% and a 30-year-old down ~6% on nothing -- and QBs sit at the top of
// the board, where a dollar error is largest. So fit and score WITHIN each position.
console.log(`\n\nPER-POSITION: does age add out-of-sample WITHIN each position?`);
console.log(`  pos     n    rank-only   +age curve    delta`);
for (const pos of POS) {
  const sub = ALL_ROWS.filter((r) => r.pos === pos);
  if (sub.length < 120) { console.log(`  ${pos.padEnd(5)} ${String(sub.length).padStart(5)}   too few rows`); continue; }
  rows.length = 0; rows.push(...sub);
  const b0 = oosR2([RANK, RANK2]);
  const b1 = oosR2([RANK, RANK2, (r) => r.age, (r) => r.age * r.age]);
  rows.length = 0; rows.push(...ALL_ROWS);
  const d = b1 - b0;
  const verdict = Math.abs(d) < 0.004 ? "(noise)" : d > 0 ? "<- REAL" : "<- HURTS";
  console.log(`  ${pos.padEnd(5)} ${String(sub.length).padStart(5)}   ${b0.toFixed(4)}      ${b1.toFixed(4)}   ${(d >= 0 ? "+" : "") + d.toFixed(4)}  ${verdict}`);
}

console.log(`\n  A feature only earns its place if it adds out-of-sample. Consensus rank already encodes a`);
console.log(`  lot of what age and opportunity say -- experts know who gets the carries and who is 33 --`);
console.log(`  so a flat result here means the information is ALREADY IN the rank, not that it is`);
console.log(`  worthless in general.`);
