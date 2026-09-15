// G1: does blending a position's ORDERING toward the FFToday consensus improve that position's
// projection accuracy, out of sample? READ-ONLY. Mirrors scripts/adjudicate-assemble.mjs: the
// projector comes from the BLIND fold artifact (holdoutSeason must equal the season), realized from
// feat_player_season.pts. For each position we sweep ITS OWN blend weight (all others 0) and measure,
// per season, Spearman(proj, realized) and RMSE(proj, realized) against the baseline (all 0). The
// season is the unit; deltas are paired by season (common blind artifacts), and we report wins/losses
// + mean delta + a season-level bootstrap 95% CI.
//
//   node --import tsx scripts/perpos-blend-accuracy.mjs [artifactDir]
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { boardProjection } from "../src/model/features.ts";
import { loadArtifact } from "../src/model/projector.ts";
import { loadConsensusPct, blendConsensus } from "../src/draft/consensusBlend.ts";

const artDir = process.argv[2] ?? "H:/working/ff-assistant/data/fold-artifacts-d16";
const db = new Database("data/ff.db", { readonly: true });
const POS = ["QB", "RB", "WR", "TE"];
const SEASONS = [];
for (let y = 2013; y <= 2024; y++) SEASONS.push(y);
const WEIGHTS = [0, 0.25, 0.5, 0.75, 1.0];

// -------- stats helpers --------
function rankOf(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2; // average rank for ties (0-based)
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function pearson(a, b) {
  const n = a.length;
  if (n < 2) return NaN;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; dbb += y * y; }
  return da === 0 || dbb === 0 ? NaN : num / Math.sqrt(da * dbb);
}
const spearman = (a, b) => pearson(rankOf(a), rankOf(b));
function rmse(a, b) {
  let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s / a.length);
}

// -------- load per-season projector rows (blind) + realized + consensus --------
const perSeason = new Map(); // season -> { rows: [{name_key,pos,proj,realized}], pctOf }
for (const yr of SEASONS) {
  const raw = JSON.parse(readFileSync(`${artDir}/artifact-${yr}.json`, "utf8"));
  if (Number(raw.holdoutSeason) !== yr) throw new Error(`BLIND VIOLATION: artifact-${yr} holdoutSeason=${raw.holdoutSeason}`);
  const artifact = loadArtifact(raw);
  const proj = new Map(); // player_sk -> mean
  for (const p of boardProjection(db, yr, artifact)) if (p.player_sk != null) proj.set(String(p.player_sk), p.mean);
  const fps = db.prepare(
    `SELECT player_sk, name_key, pos, pts AS realized FROM feat_player_season
      WHERE season=? AND pts IS NOT NULL AND player_sk IS NOT NULL`,
  ).all(yr);
  const rows = [];
  for (const r of fps) {
    if (!POS.includes(r.pos)) continue;
    const pm = proj.get(String(r.player_sk));
    if (pm == null) continue;
    rows.push({ name: r.name_key, pos: r.pos, points: pm, realized: r.realized });
  }
  const pct = loadConsensusPct(db); // keyed season|pos|name_key
  const pctOf = (pos, name) => pct.get(`${yr}|${pos}|${name}`) ?? null;
  perSeason.set(yr, { rows, pctOf });
}
db.close();

// accuracy of a weight map, per position, per season: {season -> {pos -> {spearman, rmse, n}}}
function measure(weights) {
  const out = new Map();
  for (const yr of SEASONS) {
    const { rows, pctOf } = perSeason.get(yr);
    const blended = blendConsensus(rows, pctOf, weights);
    const byPos = {};
    for (let i = 0; i < rows.length; i++) {
      const p = rows[i].pos;
      (byPos[p] ??= { proj: [], real: [] });
      byPos[p].proj.push(blended[i].points);
      byPos[p].real.push(rows[i].realized);
    }
    const m = {};
    for (const p of POS) if (byPos[p]) m[p] = { spearman: spearman(byPos[p].proj, byPos[p].real), rmse: rmse(byPos[p].proj, byPos[p].real), n: byPos[p].proj.length };
    out.set(yr, m);
  }
  return out;
}

// paired season-level bootstrap CI on a delta array
function bootCI(deltas, iters = 5000) {
  const n = deltas.length, means = [];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let it = 0; it < iters; it++) {
    let s = 0; for (let i = 0; i < n; i++) s += deltas[Math.floor(rnd() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * iters)], means[Math.floor(0.975 * iters)]];
}

const base = measure(Object.fromEntries(POS.map((p) => [p, 0])));

console.log(`G1 PER-POSITION BLEND ACCURACY (blind artifacts ${artDir.split("/").pop()}, seasons ${SEASONS[0]}-${SEASONS.at(-1)}, n=${SEASONS.length})`);
console.log(`metric = per-season within-position Spearman(proj,realized) [higher=better] and RMSE [lower=better]; paired by season vs blend 0.\n`);

for (const pos of POS) {
  console.log(`=== ${pos} (sweep ${pos} weight; all other positions 0) ===`);
  const b = SEASONS.map((yr) => base.get(yr)[pos]);
  const bSp = b.reduce((s, m) => s + m.spearman, 0) / b.length;
  const bRm = b.reduce((s, m) => s + m.rmse, 0) / b.length;
  console.log(`  baseline (w=0): mean Spearman ${bSp.toFixed(4)}  mean RMSE ${bRm.toFixed(2)}  (avg n/season ${(b.reduce((s, m) => s + m.n, 0) / b.length).toFixed(0)})`);
  for (const w of WEIGHTS) {
    if (w === 0) continue;
    const weights = Object.fromEntries(POS.map((p) => [p, p === pos ? w : 0]));
    const c = measure(weights);
    const spD = [], rmD = [];
    for (const yr of SEASONS) { spD.push(c.get(yr)[pos].spearman - base.get(yr)[pos].spearman); rmD.push(c.get(yr)[pos].rmse - base.get(yr)[pos].rmse); }
    const mSp = spD.reduce((s, v) => s + v, 0) / spD.length, mRm = rmD.reduce((s, v) => s + v, 0) / rmD.length;
    const spWins = spD.filter((d) => d > 0).length, rmWins = rmD.filter((d) => d < 0).length;
    const spCI = bootCI(spD), rmCI = bootCI(rmD);
    console.log(`  w=${w.toFixed(2)}: dSpearman ${mSp >= 0 ? "+" : ""}${mSp.toFixed(4)} [${spCI[0].toFixed(4)},${spCI[1].toFixed(4)}] (${spWins}/${SEASONS.length} seasons better) | dRMSE ${mRm >= 0 ? "+" : ""}${mRm.toFixed(2)} [${rmCI[0].toFixed(2)},${rmCI[1].toFixed(2)}] (${rmWins}/${SEASONS.length} lower)`);
  }
  console.log("");
}

// WR-unchanged assertion: blending QB must leave WR byte-identical.
const qbOnly = measure({ QB: 1.0, RB: 0, WR: 0, TE: 0 });
let wrIdentical = true;
for (const yr of SEASONS) { const a = base.get(yr).WR, bb = qbOnly.get(yr).WR; if (Math.abs(a.spearman - bb.spearman) > 1e-12 || Math.abs(a.rmse - bb.rmse) > 1e-12) wrIdentical = false; }
console.log(`WR-unchanged check (QB w=1 vs baseline): WR metrics byte-identical = ${wrIdentical}`);
