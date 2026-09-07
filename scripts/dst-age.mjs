// A team defense DOES have an age -- it is the usage-weighted mean age of the defenders who play it.
//
//   node --import tsx scripts/dst-age.mjs
//
// scripts/age-value-kdst.mjs concluded "DST has no age" from a 0% birth-date coverage row. That was
// a fact about the PLAYER TABLE, not about the world: a team has no birth date of its own, but every
// DL/LB/DB row in data/history-weekly.csv carries a `team`, so the people who constitute the defense
// are right there and 98% of them have birth years. The earlier script measured the absence of a
// lookup key and reported it as the absence of a concept.
//
// CONSTRUCTION, and it has to stay lookahead-free. The weight is a proxy for snaps, which we do not
// carry; IDP scoring is tackle-dominated and therefore strongly volume-driven, so prior-season IDP
// points are a reasonable stand-in. Both the roster and the weights come from season Y-1 and the age
// is advanced one year -- so every input is knowable before season Y is played. That understates
// free-agency churn, which is the honest limitation: this measures the age of LAST year's defense,
// which is what a preseason projection would actually have.
import { readFileSync } from "node:fs";

const CURVE = JSON.parse(readFileSync("data/age-curve.json", "utf8"));
const IDP = ["DL", "LB", "DB"];
const SEASONS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

// --- per (season, team) IDP usage, from the weekly file (the only one carrying `team`) -----------
const L = readFileSync("data/history-weekly.csv", "utf8").trim().split(/\r?\n/);
const h = L[0].split(",");
const [si, ni, pi, , yi, ti] = ["season", "name", "pos", "week", "points", "team"].map((c) => h.indexOf(c));
const usage = new Map();   // season|team|name -> points
for (const line of L.slice(1)) {
  const f = line.split(",");
  if (!IDP.includes(f[pi])) continue;
  const k = `${f[si]}|${f[ti]}|${f[ni]}`;
  usage.set(k, (usage.get(k) ?? 0) + (Number(f[yi]) || 0));
}
// weighted mean age of season S's defense, evaluated as it would stand in season S+1
const defAge = new Map();      // (S+1)|team -> age
const defCov = new Map();
for (const [k, pts] of usage) {
  const [s, team, name] = k.split("|");
  if (pts <= 0) continue;
  const by = CURVE.birthYear[name];
  const target = `${Number(s) + 1}|${team}`;
  const a = defAge.get(target) ?? { num: 0, den: 0 };
  const c = defCov.get(target) ?? { w: 0, wo: 0 };
  if (by) { a.num += pts * (Number(s) + 1 - by); a.den += pts; c.w += pts; } else { c.wo += pts; }
  defAge.set(target, a); defCov.set(target, c);
}

// --- DST season totals + prior-season rank -------------------------------------------------------
const tot = new Map();
for (const line of readFileSync("data/history-points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
  const [s, name, pos, pts] = line.split(",");
  if (pos === "DST") tot.set(`${Number(s)}|${name}`, { pts: Number(pts), name, season: Number(s) });
}
const rank = new Map();
for (const s of [2014, ...SEASONS]) {
  [...tot.entries()].filter(([, v]) => v.season === s).sort((a, b) => b[1].pts - a[1].pts)
    .forEach(([k], i) => rank.set(k, i + 1));
}

// DST names in history-points.csv vs the `team` codes in history-weekly.csv are two vocabularies.
// Join on the team code carried by that team's OWN DST weekly rows -- do not guess an alias map.
const dstTeam = new Map();     // season|dstName -> team code
for (const line of L.slice(1)) {
  const f = line.split(",");
  if (f[pi] === "DST" && f[ti]) dstTeam.set(`${f[si]}|${f[ni]}`, f[ti]);
}

const rows = [];
let joined = 0, missTeam = 0, missAge = 0;
for (const v of tot.values()) {
  if (!SEASONS.includes(v.season)) continue;
  const r = rank.get(`${v.season - 1}|${v.name}`); if (!r) continue;
  const team = dstTeam.get(`${v.season}|${v.name}`); if (!team) { missTeam++; continue; }
  const a = defAge.get(`${v.season}|${team}`);
  if (!a || a.den <= 0) { missAge++; continue; }
  joined++;
  rows.push({ hold: v.season, y: v.pts, rank: r, age: a.num / a.den });
}
console.log(`DST player-seasons: ${joined} joined, ${missTeam} without a team code, ${missAge} without a prior defense`);
if (rows.length) {
  const ages = rows.map((r) => r.age).sort((a, b) => a - b);
  console.log(`weighted defense age: min ${ages[0].toFixed(1)}  median ${ages[ages.length >> 1].toFixed(1)}  max ${ages[ages.length - 1].toFixed(1)}`);
  console.log(`  (a plausible NFL defense sits around 25-27; a median outside 24-28 means the join is wrong)`);
}

function fit(train, cols) {
  const n = train.length, p = cols.length + 1;
  const X = train.map((r) => [1, ...cols.map((c) => c(r))]), y = train.map((r) => r.y);
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0)), Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b]; }
  for (let a = 0; a < p; a++) XtX[a][a] += 1e-6;
  const M = XtX.map((row, i) => [...row, Xty[i]]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < p; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= p; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[p] / row[i]));
}
function oosR2(data, cols) {
  let ss = 0, sst = 0;
  for (const hold of SEASONS) {
    const train = data.filter((r) => r.hold !== hold), test = data.filter((r) => r.hold === hold);
    if (train.length < 40 || !test.length) continue;
    const beta = fit(train, cols);
    const mean = train.reduce((a, r) => a + r.y, 0) / train.length;
    for (const r of test) {
      const pred = beta[0] + cols.reduce((a, c, i) => a + beta[i + 1] * c(r), 0);
      ss += (r.y - pred) ** 2; sst += (r.y - mean) ** 2;
    }
  }
  return 1 - ss / sst;
}
const RANK = (r) => r.rank, RANK2 = (r) => r.rank * r.rank;
const b0 = oosR2(rows, [RANK, RANK2]);
const b1 = oosR2(rows, [RANK, RANK2, (r) => r.age]);
const b2 = oosR2(rows, [RANK, RANK2, (r) => r.age, (r) => r.age * r.age]);
console.log(`\nOUT-OF-SAMPLE R-squared for DST, one season held out at a time (n=${rows.length})`);
console.log(`  rank only            ${b0.toFixed(4)}`);
console.log(`  + defense age        ${b1.toFixed(4)}   ${(b1 - b0 >= 0 ? "+" : "") + (b1 - b0).toFixed(4)}`);
console.log(`  + defense age curve  ${b2.toFixed(4)}   ${(b2 - b0 >= 0 ? "+" : "") + (b2 - b0).toFixed(4)}`);
const best = Math.max(b1, b2) - b0;
console.log(`\n  ${Math.abs(best) < 0.004 ? "NO SIGNAL -- DST stays out of the age curve, now for a measured reason."
  : best > 0 ? "SIGNAL -- worth building a DST age term." : "HURTS -- DST stays out."}`);
