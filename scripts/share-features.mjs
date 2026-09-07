// DO THE OPPORTUNITY *SHARE* METRICS ADD ANYTHING WE DO NOT ALREADY HAVE?
//
//   node --import tsx scripts/share-features.mjs
//
// scripts/feature-value.mjs already tested RAW volume -- targets/game, carries/game, air yards/game
// -- and found +0.0085 after position controls: real but small. That is NOT the same test as this
// one, and conflating them would have closed the question wrongly. nflverse ships SHARE columns we
// have never read:
//
//   target_share      this player's share of his team's targets
//   air_yards_share   his share of the team's air yards
//   wopr              1.5*target_share + 0.7*air_yards_share, the standard opportunity index
//   racr              receiving yards / air yards -- efficiency, not volume
//   receiving_epa     expected points added
//
// The distinction matters. 8 targets a game on a team that throws 40 times is a different player
// from 8 targets on a team that throws 25, and raw volume cannot tell them apart. Shares are also
// the thing the literature says is stable year over year while efficiency regresses -- so this test
// should find volume-shares helping and efficiency (racr, epa) NOT helping. A result where the
// efficiency metrics win would be a reason to distrust the harness, not a discovery.
//
// THE BASELINE HAS TO BE HONEST. Our projection is the rank curve applied at ECR, i.e. consensus.
// Experts already know who gets the targets, so any feature has to beat rank+position, not beat
// nothing. Historical ECR is not something we hold, so prior-season positional rank stands in for
// it -- a limitation worth stating: it makes the baseline slightly WEAKER than what we ship, which
// biases this test TOWARD finding value. Treat a small win here as probably not real.
import { readFileSync } from "node:fs";
import { fetchCsv, playerWeekUrl } from "../src/data/nflverse.ts";

const POS = ["QB", "RB", "WR", "TE"];
const SEASONS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const N = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

const tot = new Map();
for (const line of readFileSync("data/history-points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
  const [s, name, pos, pts] = line.split(",");
  if (POS.includes(pos)) tot.set(`${Number(s)}|${name}`, { pos, pts: Number(pts) });
}
const rank = new Map();
for (const s of [2015, ...SEASONS]) {
  for (const pos of POS) {
    [...tot.entries()].filter(([k, v]) => k.startsWith(`${s}|`) && v.pos === pos)
      .sort((a, b) => b[1].pts - a[1].pts).forEach(([k], i) => rank.set(k, i + 1));
  }
}

// Prior-season per-game shares, averaged over the weeks he actually played.
const feat = new Map();
for (const yr of [2015, ...SEASONS]) {
  let rows;
  try { rows = await fetchCsv(playerWeekUrl(yr)); } catch { continue; }
  const agg = new Map();
  for (const r of rows) {
    if (r.season_type !== "REG") continue;
    const name = (r.player_display_name || "").trim();
    if (!name || !POS.includes((r.position || "").toUpperCase())) continue;
    const a = agg.get(name) ?? { g: 0, tgtShare: 0, aysShare: 0, wopr: 0, racr: 0, epa: 0, ypc: 0, fd: 0, yac: 0 };
    a.g += 1;
    a.tgtShare += N(r.target_share); a.aysShare += N(r.air_yards_share); a.wopr += N(r.wopr);
    a.racr += N(r.racr); a.epa += N(r.receiving_epa) + N(r.rushing_epa);
    a.fd += N(r.receiving_first_downs) + N(r.rushing_first_downs);
    a.yac += N(r.receiving_yards_after_catch);
    agg.set(name, a);
  }
  for (const [name, a] of agg) {
    if (a.g < 4) continue;
    feat.set(`${yr}|${name}`, {
      tgtShare: a.tgtShare / a.g, aysShare: a.aysShare / a.g, wopr: a.wopr / a.g,
      racr: a.racr / a.g, epa: a.epa / a.g, fd: a.fd / a.g, yac: a.yac / a.g, games: a.g,
    });
  }
}

let rows = [];
for (const s of SEASONS) {
  for (const [k, v] of tot) {
    if (!k.startsWith(`${s}|`)) continue;
    const name = k.slice(String(s).length + 1);
    const r = rank.get(`${s - 1}|${name}`); if (!r || r > 60) continue;
    const f = feat.get(`${s - 1}|${name}`); if (!f) continue;
    rows.push({ season: s, pos: v.pos, y: v.pts, rank: r, ...f });
  }
}
console.log(`${rows.length} player-seasons with prior-year rank AND share metrics\n`);

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
    const tr = data.filter((r) => r.season !== hold), te = data.filter((r) => r.season === hold);
    if (tr.length < 50 || !te.length) continue;
    const b = fit(tr, cols);
    const mean = tr.reduce((a, r) => a + r.y, 0) / tr.length;
    for (const r of te) { const p = b[0] + cols.reduce((a, c, i) => a + b[i + 1] * c(r), 0); ss += (r.y - p) ** 2; sst += (r.y - mean) ** 2; }
  }
  return 1 - ss / sst;
}
const BASE = [(r) => r.rank, (r) => r.rank * r.rank,
  (r) => (r.pos === "RB" ? 1 : 0), (r) => (r.pos === "WR" ? 1 : 0), (r) => (r.pos === "TE" ? 1 : 0)];
const base = oosR2(rows, BASE);
const CANDIDATES = [
  ["+ target_share",            [(r) => r.tgtShare]],
  ["+ air_yards_share",         [(r) => r.aysShare]],
  ["+ wopr",                    [(r) => r.wopr]],
  ["+ target_share + ays_share", [(r) => r.tgtShare, (r) => r.aysShare]],
  ["+ racr (EFFICIENCY)",       [(r) => r.racr]],
  ["+ epa/game (EFFICIENCY)",   [(r) => r.epa]],
  ["+ first downs/game",        [(r) => r.fd]],
  ["+ YAC/game",                [(r) => r.yac]],
  ["+ games played",            [(r) => r.games]],
  ["+ wopr + games",            [(r) => r.wopr, (r) => r.games]],
  ["+ EVERYTHING",              [(r) => r.tgtShare, (r) => r.aysShare, (r) => r.racr, (r) => r.epa, (r) => r.fd, (r) => r.yac, (r) => r.games]],
];
console.log("OUT-OF-SAMPLE R-squared over rank+position, holding out one season at a time");
console.log(`  baseline (rank + position)            ${base.toFixed(4)}`);
for (const [name, cols] of CANDIDATES) {
  const r2 = oosR2(rows, [...BASE, ...cols]);
  const d = r2 - base;
  const flag = Math.abs(d) < 0.004 ? "(no real change)" : d > 0 ? "<- ADDS" : "<- HURTS";
  console.log(`  ${name.padEnd(36)} ${r2.toFixed(4)}   ${(d >= 0 ? "+" : "") + d.toFixed(4)}  ${flag}`);
}

console.log(`\nPER POSITION, best share feature (wopr) -- shares are a RECEIVING concept, so a pooled`);
console.log(`result could be carried entirely by WR/TE while saying nothing about RB.`);
console.log(`  pos     n    rank-only   + wopr     delta`);
const ALL = rows;
for (const pos of POS) {
  const sub = ALL.filter((r) => r.pos === pos);
  if (sub.length < 120) { console.log(`  ${pos.padEnd(5)} ${String(sub.length).padStart(5)}   too few`); continue; }
  const R = [(r) => r.rank, (r) => r.rank * r.rank];
  const b0 = oosR2(sub, R);
  const cands={wopr:(r)=>r.wopr, tgtShare:(r)=>r.tgtShare, racr:(r)=>r.racr, epa:(r)=>r.epa, fd:(r)=>r.fd};
  const out=[];
  for(const [k,f] of Object.entries(cands)){const d=oosR2(sub,[...R,f])-b0; out.push(k+" "+(d>=0?"+":"")+d.toFixed(4));}
  console.log(`  ${pos.padEnd(5)} ${String(sub.length).padStart(5)}  base ${b0.toFixed(4)}  ` + out.join("  "));
}
