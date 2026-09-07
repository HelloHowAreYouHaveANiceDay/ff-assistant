// Does age carry signal for K, DST and the IDP groups -- the positions the age curve currently
// SKIPS? Same out-of-sample test as feature-value.mjs, run on the positions it never covered.
//
//   node --import tsx scripts/age-value-kdst.mjs
//
// Two of these exclusions are NOT the same kind of decision and the code currently makes them look
// identical (ageFactor returns 1 for any position absent from the curve):
//
//   DST has NO AGE. It is a team, not a person, and there is no birth date to look up. Excluding it
//   is a fact about the world, not a measurement. It is included below only as a STRUCTURAL NULL --
//   if this harness reports a "signal" for a position that has no age, the harness is broken.
//
//   K, DL, LB, DB are PEOPLE with birth dates sitting unused in the same table we already load. They
//   were excluded because the first fit only listed four positions, which is an assumption, not a
//   finding. This measures it.
import { readFileSync } from "node:fs";

const CURVE = JSON.parse(readFileSync("data/age-curve.json", "utf8"));
const POS = ["K", "DST", "DL", "LB", "DB"];
const SEASONS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

const tot = new Map();
for (const line of readFileSync("data/history-points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
  const [s, name, pos, pts] = line.split(",");
  if (POS.includes(pos)) tot.set(`${Number(s)}|${name}`, { pos, pts: Number(pts), name, season: Number(s) });
}
const rank = new Map();
for (const s of [2014, ...SEASONS]) {
  for (const pos of POS) {
    [...tot.entries()].filter(([, v]) => v.season === s && v.pos === pos)
      .sort((a, b) => b[1].pts - a[1].pts)
      .forEach(([k], i) => rank.set(k, i + 1));
  }
}

// Age comes from the SAME birthYear table the shipped curve uses, so a position that fails here
// fails for a reason other than a different data source.
let rows = [];
const cov = {};
for (const v of tot.values()) {
  if (!SEASONS.includes(v.season)) continue;
  const r = rank.get(`${v.season - 1}|${v.name}`);
  if (!r || r > 60) continue;
  cov[v.pos] ??= { with: 0, without: 0 };
  const by = CURVE.birthYear[v.name];
  if (!by) { cov[v.pos].without++; continue; }
  const age = v.season - by;
  if (!Number.isFinite(age) || age < 20 || age > 45) { cov[v.pos].without++; continue; }
  cov[v.pos].with++;
  rows.push({ pos: v.pos, y: v.pts, rank: r, age });
}

function fit(train, cols) {
  const n = train.length, p = cols.length + 1;
  const X = train.map((r) => [1, ...cols.map((c) => c(r))]);
  const y = train.map((r) => r.y);
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b]; }
  }
  for (let a = 0; a < p; a++) XtX[a][a] += 1e-6;
  const M = XtX.map((row, i) => [...row, Xty[i]]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= p; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[p] / row[i]));
}
function oosR2(data, cols) {
  let ss = 0, sst = 0;
  for (const hold of SEASONS) {
    const train = data.filter((r) => r.season !== hold && r.hold !== hold), test = data.filter((r) => r.hold === hold);
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

const RANK = (r) => r.rank, RANK2 = (r) => r.rank * r.rank;
const AGE = (r) => r.age, AGE2 = (r) => r.age * r.age;

console.log("BIRTH-YEAR COVERAGE (share of usable player-seasons that have an age at all)");
for (const pos of POS) {
  const c = cov[pos] ?? { with: 0, without: 0 };
  const tot2 = c.with + c.without;
  console.log(`  ${pos.padEnd(4)} ${String(c.with).padStart(5)} / ${String(tot2).padStart(5)}  ${tot2 ? ((100 * c.with) / tot2).toFixed(0) : "0"}%`);
}

console.log(`\nOUT-OF-SAMPLE R-squared WITHIN each position, holding out one season at a time`);
console.log(`  pos      n    rank-only   +age curve    delta`);
for (const pos of POS) {
  const sub = rows.filter((r) => r.pos === pos);
  if (sub.length < 120) { console.log(`  ${pos.padEnd(5)} ${String(sub.length).padStart(5)}   too few rows to test`); continue; }
  // re-tag hold season (rows dropped it); rebuild from tot for the split
  const tagged = [];
  for (const v of tot.values()) {
    if (v.pos !== pos || !SEASONS.includes(v.season)) continue;
    const r = rank.get(`${v.season - 1}|${v.name}`); if (!r || r > 60) continue;
    const by = CURVE.birthYear[v.name]; if (!by) continue;
    const age = v.season - by; if (!Number.isFinite(age) || age < 20 || age > 45) continue;
    tagged.push({ hold: v.season, y: v.pts, rank: r, age });
  }
  const b0 = oosR2(tagged, [RANK, RANK2]);
  const b1 = oosR2(tagged, [RANK, RANK2, AGE, AGE2]);
  const d = b1 - b0;
  const verdict = Math.abs(d) < 0.004 ? "(noise)" : d > 0 ? "<- REAL" : "<- HURTS";
  console.log(`  ${pos.padEnd(5)} ${String(tagged.length).padStart(5)}   ${b0.toFixed(4)}      ${b1.toFixed(4)}   ${(d >= 0 ? "+" : "") + d.toFixed(4)}  ${verdict}`);
}
console.log(`
DST is the STRUCTURAL NULL. A team has no birth date, so its coverage should read 0% and it should
not be testable at all. If it ever shows a number here, this harness is matching team names against
a person table and the whole measurement is suspect.`);
