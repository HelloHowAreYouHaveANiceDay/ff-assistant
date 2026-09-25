// LEARNING-TO-RANK FOR THE WAIVER POOL, DONE PROPERLY.
//
// Two earlier attempts tested my normalisation rather than the idea:
//
//   v1  returned the raw pairwise score for skill positions and fell back to `proj` for K/DST. The
//       score is a standardised logit (~+/-3) and `proj` is points (~6-25), so the FALLBACK simply
//       outranked every modelled player: the arm picked 57% K and 43% DST and posted the best
//       mix-matched capture in the table (68.7%) with skill -0.2. I attributed that to K/DST having
//       null features; THAT DIAGNOSIS WAS WRONG -- K carries season_line_pg 79% / t4_mean 84% and
//       DST 100% / 94%. They were never scored at all, because the training query filtered them out.
//   v2  put everything on a within-cell PERCENTILE, which fixed the scale and destroyed the signal:
//       a pure within-position rank has no cross-position value in it, so the arm happily takes the
//       best kicker over the third-best running back. 41.3%.
//
// THIS VERSION keeps the ordering the rank loss learns AND restores a common scale:
//
//   1. a SEPARATE pairwise model per position, on the features that position actually carries
//      (DST has no snap share, so DST does not get one), fitted LEAVE-SEASON-OUT;
//   2. each candidate scored against his own (season, week, position) cell -> percentile;
//   3. that percentile mapped back to POINTS through the position's realised ros-ppg quantile
//      function, computed from the OTHER seasons only.
//
// Step 3 is what makes it comparable across positions without re-importing the level bias: the
// ordering within a position comes from the model, and the level comes from what that position's
// pool actually pays out -- measured, not assumed.
//
// Usage: node --import tsx scripts/waiver-rank-loss.mjs [--league 462233]
import Database from "better-sqlite3";
import { backtestWaivers } from "../src/inseason/backtest/waiver.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const LEAGUE = arg("--league", "462233");
const MODEL = arg("--model", "challenger");
const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const db = new Database("data/ff.db");

const ALL = ["season_line_pg", "t4_mean", "prior_snap_share", "td_ts", "rz_share_td"];
const rows = db.prepare(`
  SELECT season, week, pos, player_sk, pts, ${ALL.join(", ")}
    FROM feat_player_week_model
   WHERE season BETWEEN 2018 AND 2025 AND player_sk IS NOT NULL
   ORDER BY season, player_sk, week`).all();

// The label: realised rest-of-season points per game, suffix-summed per (season, player).
{
  const g = new Map();
  for (const r of rows) { const k = `${r.season}|${r.player_sk}`; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  for (const [, a] of g) { let s = 0, n = 0; for (let i = a.length - 1; i >= 0; i--) { s += a[i].pts ?? 0; n++; a[i].y = s / n; } }
}

const POSITIONS = [...new Set(rows.map((r) => r.pos))].filter(Boolean);
// PER-POSITION FEATURE LISTS: a column below half-covered for a position is dropped for it rather
// than median-filled, because filling it makes every man at that position identical on that axis
// and the fit then spends a coefficient on noise.
const featsFor = {};
for (const pos of POSITIONS) {
  const sub = rows.filter((r) => r.pos === pos);
  featsFor[pos] = ALL.filter((f) => sub.filter((r) => r[f] != null).length / sub.length >= 0.5);
}
const med = {};
for (const pos of POSITIONS) {
  med[pos] = {};
  for (const f of featsFor[pos]) {
    const v = rows.filter((r) => r.pos === pos && r[f] != null).map((r) => r[f]).sort((a, b) => a - b);
    med[pos][f] = v.length ? v[Math.floor(v.length / 2)] : 0;
  }
}

function fitRank(train, feats, meds, epochs = 10, lr = 0.05) {
  if (!feats.length || train.length < 200) return null;
  const x = (r) => feats.map((f) => (r[f] ?? meds[f]));
  const mu = feats.map((_, j) => train.reduce((a, r) => a + x(r)[j], 0) / train.length);
  const sd = feats.map((_, j) => {
    const v = Math.sqrt(train.reduce((a, r) => a + (x(r)[j] - mu[j]) ** 2, 0) / train.length);
    return v > 0 ? v : 1;
  });
  const z = (r) => x(r).map((v, j) => (v - mu[j]) / sd[j]);
  const w = new Array(feats.length).fill(0);
  const cells = new Map();
  for (const r of train) { const k = `${r.season}|${r.week}`; if (!cells.has(k)) cells.set(k, []); cells.get(k).push(r); }
  const cl = [...cells.values()].filter((c) => c.length >= 2);
  let seed = 424242;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let e = 0; e < epochs; e++) {
    for (const c of cl) {
      for (let t = 0; t < c.length; t++) {
        const a = c[Math.floor(rnd() * c.length)], b = c[Math.floor(rnd() * c.length)];
        if (a === b || a.y == null || b.y == null || a.y === b.y) continue;
        const d = z(a).map((v, j) => v - z(b)[j]);
        const p = 1 / (1 + Math.exp(-d.reduce((acc, v, j) => acc + v * w[j], 0)));
        const lab = a.y > b.y ? 1 : 0;
        for (let j = 0; j < w.length; j++) w[j] += lr * (lab - p) * d[j];
      }
    }
  }
  return { w, z };
}

// model[season][pos] -- fitted WITHOUT that season, on that position's rows only.
const model = new Map();
// quant[season][pos] -- that position's realised ros-ppg quantiles, from the OTHER seasons only.
const quant = new Map();
for (const s of SEASONS) {
  const byPos = new Map(), qPos = new Map();
  for (const pos of POSITIONS) {
    const train = rows.filter((r) => r.pos === pos && r.season !== s && r.y != null);
    byPos.set(pos, fitRank(train, featsFor[pos], med[pos]));
    qPos.set(pos, train.map((r) => r.y).sort((a, b) => a - b));
  }
  model.set(s, byPos); quant.set(s, qPos);
}

const cellCache = new Map();
/** Percentile of this man within his (season, week, position) cell, then mapped to POINTS through
 *  his position's out-of-season realised quantile function. Null when the cell or model is absent,
 *  so the harness falls back to the projection for him rather than to a number on another scale. */
function rankPoints(season, week, pos, sk) {
  const key = `${season}|${week}|${pos}`;
  let cell = cellCache.get(key);
  if (!cell) {
    const m = model.get(season)?.get(pos);
    const members = rows.filter((r) => r.season === season && r.week === week && r.pos === pos);
    if (!m || members.length < 2) { cellCache.set(key, new Map()); return null; }
    const scored = members
      .map((r) => ({ sk: r.player_sk, s: m.z(r).reduce((a, v, j) => a + v * m.w[j], 0) }))
      .sort((a, b) => a.s - b.s);
    const q = quant.get(season)?.get(pos) ?? [];
    cell = new Map(scored.map((v, i) => {
      const pct = scored.length > 1 ? i / (scored.length - 1) : 0.5;
      const idx = Math.min(q.length - 1, Math.max(0, Math.round(pct * (q.length - 1))));
      return [v.sk, q.length ? q[idx] : null];
    }));
    cellCache.set(key, cell);
  }
  return cell.get(sk) ?? null;
}

/**
 * THE CONTROL THAT MAKES THIS A TEST OF THE LOSS AND NOT OF CAPACITY.
 *
 * Comparing a 5-feature linear pairwise model against the shipped 26-feature gradient-boosted
 * projection answers "is my small model worse than the big one", which needs no experiment. To ask
 * whether the RANK LOSS helps, the comparison partner must differ ONLY in the objective: same five
 * features, same per-position split, same leave-season-out folds, same percentile-to-points
 * mapping. `fitOls` is that partner -- least squares on the realised rest-of-season ppg.
 */
function fitOls(train, feats, meds) {
  if (!feats.length || train.length < 200) return null;
  const x = (r) => [1, ...feats.map((f) => (r[f] ?? meds[f]))];
  const p = feats.length + 1;
  const A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
  for (const r of train) {
    const v = x(r);
    for (let i = 0; i < p; i++) { b[i] += v[i] * r.y; for (let j = 0; j < p; j++) A[i][j] += v[i] * v[j]; }
  }
  for (let i = 0; i < p; i++) A[i][i] += 1e-6;
  for (let i = 0; i < p; i++) {
    let piv = i;
    for (let k = i + 1; k < p; k++) if (Math.abs(A[k][i]) > Math.abs(A[piv][i])) piv = k;
    [A[i], A[piv]] = [A[piv], A[i]]; [b[i], b[piv]] = [b[piv], b[i]];
    if (Math.abs(A[i][i]) < 1e-12) continue;
    for (let k = 0; k < p; k++) {
      if (k === i) continue;
      const f = A[k][i] / A[i][i];
      for (let l = i; l < p; l++) A[k][l] -= f * A[i][l];
      b[k] -= f * b[i];
    }
  }
  const w = A.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : b[i] / row[i]));
  return { z: (r) => x(r), w };
}
const olsModel = new Map();
for (const s of SEASONS) {
  const byPos = new Map();
  for (const pos of POSITIONS) {
    byPos.set(pos, fitOls(rows.filter((r) => r.pos === pos && r.season !== s && r.y != null), featsFor[pos], med[pos]));
  }
  olsModel.set(s, byPos);
}
const olsCache = new Map();
function olsPoints(season, week, pos, sk) {
  const key = `${season}|${week}|${pos}`;
  let cell = olsCache.get(key);
  if (!cell) {
    const m = olsModel.get(season)?.get(pos);
    const members = rows.filter((r) => r.season === season && r.week === week && r.pos === pos);
    if (!m || members.length < 2) { olsCache.set(key, new Map()); return null; }
    const scored = members
      .map((r) => ({ sk: r.player_sk, s: m.z(r).reduce((a, v, j) => a + v * m.w[j], 0) }))
      .sort((a, b) => a.s - b.s);
    const q = quant.get(season)?.get(pos) ?? [];
    cell = new Map(scored.map((v, i) => {
      const pct = scored.length > 1 ? i / (scored.length - 1) : 0.5;
      const idx = Math.min(q.length - 1, Math.max(0, Math.round(pct * (q.length - 1))));
      return [v.sk, q.length ? q[idx] : null];
    }));
    olsCache.set(key, cell);
  }
  return cell.get(sk) ?? null;
}

const arms = [
  { name: "shipped (projection, 26-feat GBM)", opts: {} },
  {
    name: "B0 CONTROL: OLS, same 5 feats, same map",
    opts: { ranker: (p, season, week) => olsPoints(season, week, p.pos, p.player_sk) },
  },
  {
    name: "B rank-loss, same 5 feats, same map",
    opts: { ranker: (p, season, week) => rankPoints(season, week, p.pos, p.player_sk) },
  },
];
console.log(`\nLEARNING-TO-RANK, PROPERLY -- league ${LEAGUE}, ${SEASONS[0]}-${SEASONS[SEASONS.length - 1]}`);
console.log(`  per-position features: ${POSITIONS.map((p) => `${p}[${featsFor[p].length}]`).join("  ")}\n`);
console.log("  arm                                          raw ppg   MIX-MATCHED capture   skill   QB share");
for (const a of arms) {
  const { summary: s } = backtestWaivers(db, LEAGUE, { seasons: SEASONS, model: MODEL, ...a.opts });
  const qb = s.mix.ours.byPos.find((b) => b.pos === "QB")?.share ?? 0;
  console.log(
    `  ${a.name.padEnd(44)} ${s.ourPpg.toFixed(2).padStart(7)} ${(100 * s.ourCaptureAtMix).toFixed(1).padStart(18)}% ` +
    `${s.mix.ours.skill.toFixed(2).padStart(7)} ${(100 * qb).toFixed(0).padStart(9)}%`,
  );
  if (a.name.startsWith("shipped")) {
    console.log(`  ${"THE ROOM (reference)".padEnd(44)} ${s.roomPpg.toFixed(2).padStart(7)} ${(100 * s.roomCaptureAtMix).toFixed(1).padStart(18)}% ` +
      `${s.mix.room.skill.toFixed(2).padStart(7)} ${(100 * (s.mix.room.byPos.find((b) => b.pos === "QB")?.share ?? 0)).toFixed(0).padStart(9)}%`);
  } else {
    console.log(`     its mix: ${s.mix.ours.byPos.map((b) => `${b.pos} ${(100 * b.share).toFixed(0)}%`).join("  ")}`);
  }
}
console.log("\n  Read capture BESIDE the mix: a capture that rises while raw ppg falls is mix until");
console.log("  shown otherwise (K/DST headroom 1.42/1.48 vs 1.66-1.76 for the rest).");
db.close();
