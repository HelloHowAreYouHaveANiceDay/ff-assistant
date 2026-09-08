// Fit an OPPORTUNITY adjustment: does a player's prior-season usage say his rank is wrong?
// Writes data/opportunity-model.json.
//
//   node --import tsx scripts/fit-opportunity.mjs
//
// WHY A MULTIPLIER ON THE RANK CURVE, exactly like the age curve. Our projection is
// curve[pos][rank] -- the mean points historically posted by the k-th best player at that position,
// applied at a player's ECR rank. That curve knows the CONSENSUS view of a player and nothing about
// how he actually got his points. Two receivers ranked WR20 are identical to it, even when one drew
// 28% of his team's targets and the other drew 15% and scored on broken plays.
//
// EARNED ITS PLACE FIRST (scripts/share-features.mjs), out of sample, one season held out at a time,
// WITHIN each position -- because the pooled test says nothing at all here. A single pooled slope is
// forced to mean the same thing for a running back and a receiver, and position dummies move only
// the intercept. Pooled, every share feature lands within +/-0.0007 of baseline. Per position:
//
//   pos    base      target_share   first_downs/g      racr (EFFICIENCY)
//   QB   0.4376        -0.0018        -0.0011              -0.0006
//   RB   0.2452        +0.0121        +0.0371              -0.0041
//   WR   0.2471        +0.0307        +0.0232              -0.0038
//   TE   0.3571        +0.0252        +0.0227              +0.0036
//
// TWO NULL CONTROLS, both predicted before the run rather than read off after it. QB has no target
// share, so nothing should help there -- nothing does. And efficiency should NOT persist while
// volume does -- racr is negative for RB and WR. A run in which racr had won would have been a
// reason to distrust the harness rather than a discovery.
//
// THE FEATURES ARE RELATIVE TO THE RANK, not absolute. A WR5's raw target share is high because he
// is a WR5; that is already in the rank and adding it again would double count. What carries new
// information is whether he had MORE usage than players at his rank typically do. So each feature is
// divided by the mean for that rank bucket, and 1.0 means "exactly what his rank implies".
import { readFileSync, writeFileSync } from "node:fs";
import { fetchCsv, playerWeekUrl } from "../src/data/nflverse.ts";

const POS = ["QB", "RB", "WR", "TE"];
// 2006 onward. An earlier version of this stopped at 2016 for no reason beyond where I started
// typing, and that choice was not harmless: the backtest replays 2005-2024, so with usage baked only
// from 2015 the adjustment was a no-op for two thirds of it and the A/B compared the system against
// ITSELF for ten of nineteen seasons -- the per-season rows came back byte-identical, which is the
// only reason it was noticed. Verified target_share and receiving_first_downs are populated back to
// 2006 before extending; earlier files exist but the derived share columns thin out.
const SEASONS = Array.from({ length: 20 }, (_, i) => 2006 + i);
const MAX_RANK = 60;
const BUCKET = 6;                       // rank bucket width for the "typical at this rank" baseline
const N = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

// --- season totals + ranks, and the rank curve itself ---------------------------------------------
const tot = new Map();
for (const line of readFileSync("data/history-points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
  const [s, name, pos, pts] = line.split(",");
  if (POS.includes(pos)) tot.set(`${Number(s)}|${name}`, { pos, pts: Number(pts), name, season: Number(s) });
}
const seasons = [...new Set([...tot.values()].map((v) => v.season))].sort();
const rank = new Map();
for (const s of seasons) {
  for (const pos of POS) {
    [...tot.entries()].filter(([, v]) => v.season === s && v.pos === pos)
      .sort((a, b) => b[1].pts - a[1].pts).forEach(([k], i) => rank.set(k, i + 1));
  }
}
const curve = {};
for (const pos of POS) {
  const lists = seasons.map((s) => [...tot.values()].filter((v) => v.season === s && v.pos === pos).map((v) => v.pts).sort((a, b) => b - a));
  const maxlen = Math.max(0, ...lists.map((l) => l.length));
  curve[pos] = [];
  for (let k = 0; k < maxlen; k++) {
    let sum = 0, c = 0;
    for (const l of lists) if (k < l.length) { sum += l[k]; c++; }
    curve[pos][k] = c ? sum / c : 0;
  }
}

// --- prior-season usage ---------------------------------------------------------------------------
const usage = new Map();
for (const yr of [SEASONS[0] - 1, ...SEASONS]) {
  let rows;
  try { rows = await fetchCsv(playerWeekUrl(yr)); } catch { continue; }
  const agg = new Map();
  for (const r of rows) {
    if (r.season_type !== "REG") continue;
    const name = (r.player_display_name || "").trim();
    if (!name || !POS.includes((r.position || "").toUpperCase())) continue;
    const a = agg.get(name) ?? { g: 0, fd: 0, ts: 0, att: 0, ryd: 0 };
    a.g += 1;
    a.fd += N(r.receiving_first_downs) + N(r.rushing_first_downs);
    a.ts += N(r.target_share);
    // QUARTERBACK WORKLOAD. The two fields above describe a pass CATCHER: a quarterback has no target
    // share and no receiving first downs, so for twenty seasons QB "usage" here was his scrambles and
    // nothing else. It measured ~0, that null was recorded as a fact about quarterbacks, and a guard
    // in models.ts was written to enforce it. Measured with the columns that actually describe the
    // job (scripts/qb-usage-probe.mjs), the shipped pair scores -0.0060 and attempts + rushing yards
    // scores +0.0035 nested, chosen by inner CV in 18 of 19 folds.
    a.att += N(r.attempts);
    a.ryd += N(r.rushing_yards);
    agg.set(name, a);
  }
  for (const [name, a] of agg) {
    if (a.g < 4) continue;
    usage.set(`${yr}|${name}`, { fd: a.fd / a.g, ts: a.ts / a.g, attempts: a.att / a.g, rushYards: a.ryd / a.g, g: a.g });
  }
}

/**
 * WHICH FEATURES DESCRIBE USAGE, PER POSITION.
 *
 * This map is the fix. It existed implicitly before as "everyone gets fd and ts", which is correct
 * for the three positions that catch passes and meaningless for the one that throws them. Keeping it
 * explicit means a position whose workload is measured by the wrong columns is now a visible claim
 * rather than an unstated assumption.
 */
const FEATURES = {
  QB: ["attempts", "rushYards"],
  RB: ["fd", "ts"], WR: ["fd", "ts"], TE: ["fd", "ts"],
};
/** Denominator floors, per feature: below these a bucket's mean usage is ~0 and the ratio explodes
 *  into a meaningless number rather than a large one. */
const FLOOR = { fd: 0.05, ts: 0.005, attempts: 1.0, rushYards: 0.5 };

// --- cases: ratio of actual to rank-predicted, plus usage RELATIVE to the rank bucket -------------
const raw = [];
for (const v of tot.values()) {
  if (!SEASONS.includes(v.season)) continue;
  const r = rank.get(`${v.season - 1}|${v.name}`);
  if (!r || r > MAX_RANK) continue;
  const pred = curve[v.pos]?.[r - 1];
  if (!pred || pred < 20) continue;
  const u = usage.get(`${v.season - 1}|${v.name}`);
  if (!u) continue;
  raw.push({
    season: v.season, pos: v.pos, name: v.name, rank: r, ratio: v.pts / pred, y: v.pts,
    fd: u.fd, ts: u.ts, attempts: u.attempts, rushYards: u.rushYards,
  });
}
// bucket means, per position, so "relative to his rank" is well defined
const bucketOf = (r) => Math.floor((r - 1) / BUCKET);
const bmean = {};
for (const pos of POS) {
  bmean[pos] = {};
  const g = raw.filter((x) => x.pos === pos);
  for (const b of new Set(g.map((x) => bucketOf(x.rank)))) {
    const inB = g.filter((x) => bucketOf(x.rank) === b);
    bmean[pos][b] = {};
    for (const c of FEATURES[pos]) bmean[pos][b][c] = inB.reduce((a, x) => a + (x[c] ?? 0), 0) / inB.length;
  }
}
/** A feature RELATIVE to what its rank bucket typically shows. 1.0 = exactly as expected, which is
 *  what keeps this from re-learning the rank the projection is already indexed by. */
const relOf = (x, c, means) => {
  const m = (means ?? bmean[x.pos])[bucketOf(x.rank)]?.[c];
  const v = x[c];
  if (v == null || !Number.isFinite(v) || m == null || !(m > (FLOOR[c] ?? 0))) return 1;
  return v / m;
};
for (const x of raw) x.rel = FEATURES[x.pos].map((c) => relOf(x, c));
console.log(`${raw.length} player-seasons with a prior rank inside ${MAX_RANK} and prior-season usage\n`);

// --- per-position OOS signal, which SETS THE AMPLITUDE --------------------------------------------
// Measured here rather than copied from share-features.mjs, so the amplitude describes the model
// actually being fitted (both features together) instead of the best single feature.
function ols(train, cols) {
  const p = cols.length + 1;
  const X = train.map((r) => [1, ...cols.map((c) => c(r))]), y = train.map((r) => r.y);
  const A = Array.from({ length: p }, () => new Array(p).fill(0)), t = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) for (let a = 0; a < p; a++) { t[a] += X[i][a] * y[i]; for (let b = 0; b < p; b++) A[a][b] += X[i][a] * X[i][b]; }
  for (let a = 0; a < p; a++) A[a][a] += 1e-6;
  const M = A.map((row, i) => [...row, t[i]]);
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
    const b = ols(tr, cols);
    const mean = tr.reduce((a, r) => a + r.y, 0) / tr.length;
    for (const r of te) { const pr = b[0] + cols.reduce((a, c, i) => a + b[i + 1] * c(r), 0); ss += (r.y - pr) ** 2; sst += (r.y - mean) ** 2; }
  }
  return 1 - ss / sst;
}
const RANKC = [(r) => r.rank, (r) => r.rank * r.rank];
const SIGNAL = {};
console.log("PER-POSITION OOS SIGNAL of each position's own usage pair, which sets its amplitude");
console.log("  pos     n    features            rank-only   + usage     delta");
for (const pos of POS) {
  const sub = raw.filter((x) => x.pos === pos);
  if (sub.length < 120) { SIGNAL[pos] = 0; console.log(`  ${pos.padEnd(5)} ${String(sub.length).padStart(5)}   too few`); continue; }
  const cols = FEATURES[pos].map((c, i) => (r) => r.rel[i]);
  const b0 = oosR2(sub, RANKC), b1 = oosR2(sub, [...RANKC, ...cols]);
  SIGNAL[pos] = Math.max(0, b1 - b0);
  console.log(`  ${pos.padEnd(5)} ${String(sub.length).padStart(5)}   ${FEATURES[pos].join(" + ").padEnd(19)} ${b0.toFixed(4)}   ${b1.toFixed(4)}   ${(b1 - b0 >= 0 ? "+" : "") + (b1 - b0).toFixed(4)}`);
}
const MAXSIG = Math.max(...Object.values(SIGNAL)) || 1;
const AMP = Object.fromEntries(POS.map((p) => [p, SIGNAL[p] / MAXSIG]));

// --- the model: ratio ~ relFd + relTs, per position, NORMALISED then amplitude-scaled -------------
//
// The normalisation is not optional and the age curve learned it the hard way: the mean of
// actual/rank-predicted is about 0.87, NOT 1.0, and that gap is REGRESSION TO THE MEAN rather than
// anything to do with usage. A player who finished RB8 got partly lucky and undershoots curve[RB8]
// next year at every level of opportunity. Shipping the raw fit would deflate every projection ~13%
// -- invisible in VOR, where a uniform scale cancels in the dollar split, and very much not
// invisible to the season simulator, whose bootstrap pools are calibrated against real point levels.
const model = {
  fittedFrom: "share-features.mjs + qb-usage-probe.mjs + this",
  bucket: BUCKET, maxRank: MAX_RANK, schema: 2, features: FEATURES, floor: FLOOR,
  pos: {}, amplitude: AMP, players: {},
};
console.log("\nFITTED COEFFICIENTS (on the ratio actual/rank-predicted), normalised to mean 1.0");
console.log("  pos    features            coefficients        amplitude   factor at 0.7x / 1.0x / 1.4x");
for (const pos of POS) {
  const sub = raw.filter((x) => x.pos === pos);
  if (sub.length < 120 || AMP[pos] <= 0) { model.pos[pos] = null; console.log(`  ${pos.padEnd(5)}  (flat -- no measured signal)`); continue; }
  const feats = FEATURES[pos];
  const b = ols(sub.map((x) => ({ ...x, y: x.ratio })), feats.map((c, i) => (r) => r.rel[i]));
  const val = (rels) => b[0] + rels.reduce((a, v, i) => a + v * b[i + 1], 0);
  const mean = sub.reduce((a, x) => a + val(x.rel), 0) / sub.length;
  model.pos[pos] = { feats, b, mean, amp: AMP[pos] };
  const f = (r) => {
    const shape = Math.max(0.75, Math.min(1.25, val(feats.map(() => r)) / (mean || 1)));
    return 1 + (shape - 1) * AMP[pos];
  };
  console.log(`  ${pos.padEnd(5)} ${feats.join(" + ").padEnd(19)} ${b.slice(1).map((x) => x.toFixed(4)).join(", ").padEnd(19)} ${(100 * AMP[pos]).toFixed(0).padStart(6)}%   ${f(0.7).toFixed(3)} / ${f(1.0).toFixed(3)} / ${f(1.4).toFixed(3)}`);
}

// --- bake the CURRENT usage in, so neither consumer makes a network call --------------------------
// Same contract as data/age-curve.json: the values used to APPLY the model are exactly the ones used
// to FIT it, and the board build stays offline.
// EVERY season, keyed `season|name`, not just the latest. The backtest replays two decades and must
// apply the SAME adjustment the live board applies -- a harness that validates a different system
// than the one shipped is worse than no harness, and this codebase has already paid for that lesson
// once with the age curve. Age got away with a season-independent key (birth year); usage does not,
// so the year goes in the key and the consumer looks up season-1.
const latest = Math.max(...SEASONS);
let baked = 0;
for (const [k, u] of usage) {
  // ALL four fields, not just the pair a given position uses. The key is `season|name` and carries no
  // position, so a row that stored only one position's features would silently hand a quarterback a
  // receiver's usage the moment a name appeared at both -- and the consumer, which looks up by
  // position, would find the wrong two numbers and adjust on them.
  model.players[k] = {
    fd: Math.round(u.fd * 1000) / 1000,
    ts: Math.round(u.ts * 10000) / 10000,
    attempts: Math.round(u.attempts * 1000) / 1000,
    rushYards: Math.round(u.rushYards * 1000) / 1000,
  };
  baked++;
}
model.bucketMeans = bmean;
model.season = latest;
writeFileSync("data/opportunity-model.json", JSON.stringify(model, null, 2));
console.log(`\nwrote data/opportunity-model.json -- ${baked} player-seasons of usage baked in (latest ${latest})`);
console.log(`  A player with no prior-season usage (rookie, or under 4 games) gets a factor of exactly`);
console.log(`  1.0 -- never a guess. That is the same rule the age curve uses for an unknown birth date.`);
