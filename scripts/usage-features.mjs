// DOES EVERY POSITION WANT THE SAME USAGE FEATURES? Measured per position, not assumed.
//
//   node --import tsx scripts/usage-features.mjs
//
// The opportunity model defined usage as `receiving first downs + target share` for EVERY position.
// That was wrong for quarterbacks in a way that took twenty seasons to notice: a passer has neither
// column, so his usage was his scrambles, it measured ~0, and the null was written down as a fact
// about quarterbacks and then enforced by a guard. Fixed by measuring him on attempts and rushing
// yards instead (+0.0035 nested, against -0.0060 for the shipped pair).
//
// THE SAME QUESTION IS STILL OPEN FOR THE OTHER THREE. RB, WR and TE all still share one pair, and
// "target share describes a running back's workload" is precisely the kind of claim that has never
// been tested here. A back's job is carries; a tight end's snap is as often a block as a route.
// Sharing a feature set across positions is an assumption, and this measures it.
//
// METHOD, same as the QB probe and for the same reasons:
//   - features RELATIVE to the rank bucket, so nothing re-learns the rank the curve already knows
//   - LOSO for each candidate set, and NESTED with the set CHOSEN INSIDE each fold by inner CV,
//     because picking a set by reading a table and then scoring it measures the picking
//   - a harness control planted before anything is read, since a loop that reports nothing and a
//     loop that is broken print the same page
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { parseCsv, playerWeekUrl } from "../src/data/nflverse.ts";

const POS = ["QB", "RB", "WR", "TE"];
const SEASONS = Array.from({ length: 20 }, (_, i) => 2006 + i);
const BUCKET = 6;
// The rank cutoff is a PARAMETER, not a constant, because the QB answer turned out to depend on it:
// the first probe ran at 40 and found attempts+rushYards clearly ahead, this script at 60 (matching
// what fit-opportunity actually uses) found the opposite. A result that flips sign on a population
// choice is a result about the population, and the only way to see that is to vary it deliberately.
const rankArg = process.argv.indexOf("--maxRank");
const MAX_RANK = rankArg > -1 ? Number(process.argv[rankArg + 1]) : 60;
const CACHE = "data/cache";
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
const N = (x) => { const v = Number(x); return Number.isFinite(v) ? v : 0; };
async function csv(url, tag) {
  const p = `${CACHE}/${tag}.csv.gz`;
  if (existsSync(p)) return parseCsv(gunzipSync(readFileSync(p)).toString("utf8"));
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  writeFileSync(p, gzipSync(Buffer.from(text)));
  return parseCsv(text);
}

const tot = new Map();
for (const line of readFileSync("data/history-points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
  const [s, name, pos, pts] = line.split(",");
  if (POS.includes(pos)) tot.set(`${Number(s)}|${name}`, { pos, pts: Number(pts), name, season: Number(s) });
}
const seasons = [...new Set([...tot.values()].map((v) => v.season))].sort().filter((s) => s >= 2007);
const rank = new Map();
for (const s of seasons.concat([seasons[0] - 1])) {
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

console.log("aggregating prior-season usage ...");
const usage = new Map();
for (const yr of [SEASONS[0] - 1, ...SEASONS]) {
  let raw; try { raw = await csv(playerWeekUrl(yr), `pw-${yr}`); } catch { continue; }
  const agg = new Map();
  for (const r of raw) {
    if (r.season_type !== "REG") continue;
    const name = (r.player_display_name || "").trim();
    if (!name || !POS.includes((r.position || "").toUpperCase())) continue;
    let a = agg.get(name); if (!a) { a = { g: 0 }; agg.set(name, a); }
    a.g += 1;
    const add = (k, v) => { a[k] = (a[k] ?? 0) + v; };
    add("att", N(r.attempts)); add("sack", N(r.sacks_suffered));
    add("car", N(r.carries)); add("tgt", N(r.targets)); add("rec", N(r.receptions));
    add("ryd", N(r.rushing_yards)); add("recyd", N(r.receiving_yards)); add("pay", N(r.passing_air_yards));
    add("ray", N(r.receiving_air_yards));
    add("rfd", N(r.rushing_first_downs)); add("recfd", N(r.receiving_first_downs));
    add("ts", N(r.target_share)); add("ays", N(r.air_yards_share)); add("wopr", N(r.wopr));
    add("rtd", N(r.rushing_tds)); add("rectd", N(r.receiving_tds));
  }
  for (const [name, a] of agg) {
    if (a.g < 4) continue;
    const per = (k) => (a[k] ?? 0) / a.g;
    usage.set(`${yr}|${name}`, {
      // what ships today for the pass catchers
      fd: per("rfd") + per("recfd"),
      ts: per("ts"),
      // volume, the thing a rank cannot express
      carries: per("car"), targets: per("tgt"), receptions: per("rec"),
      touches: per("car") + per("rec"),
      attempts: per("att"), dropbacks: per("att") + per("sack"),
      // yardage and share
      rushYards: per("ryd"), recYards: per("recyd"), airYards: per("ray"), passAirYards: per("pay"),
      airYardsShare: per("ays"), wopr: per("wopr"),
      // scoring opportunity, distinct from volume: goal-line work is not the same as touches
      tds: per("rtd") + per("rectd"),
    });
  }
}

const cases = {};
for (const pos of POS) cases[pos] = [];
for (const v of tot.values()) {
  if (!seasons.includes(v.season)) continue;
  const r = rank.get(`${v.season - 1}|${v.name}`);
  if (!r || r > MAX_RANK) continue;
  const pred = curve[v.pos]?.[r - 1];
  if (!pred || pred < 20) continue;
  const u = usage.get(`${v.season - 1}|${v.name}`);
  if (!u) continue;
  cases[v.pos].push({ season: v.season, name: v.name, rank: r, ratio: v.pts / pred, pts: v.pts, u });
}

// CANDIDATE SETS, per position. Each list includes what SHIPS today, so the question the run answers
// is "does anything beat what we already do" rather than "is there any signal at all".
const SETS = {
  QB: [
    // QB now ships attempts+rushYards; fd+ts is kept as the PRIOR shipped pair so the change that
    // was made can keep being re-checked rather than becoming unquestionable once merged.
    ["prior fd + ts", ["fd", "ts"]],
    ["SHIPPED attempts + rushYards", ["attempts", "rushYards"]],
    ["dropbacks + rushYards", ["dropbacks", "rushYards"]],
    ["attempts + passAirYards", ["attempts", "passAirYards"]],
    ["attempts", ["attempts"]],
  ],
  RB: [
    ["SHIPPED fd + ts", ["fd", "ts"]],
    ["carries + targets", ["carries", "targets"]],
    ["touches", ["touches"]],
    ["touches + tds", ["touches", "tds"]],
    ["carries + receptions", ["carries", "receptions"]],
    ["carries + ts", ["carries", "ts"]],
    ["touches + ts", ["touches", "ts"]],
  ],
  WR: [
    ["SHIPPED fd + ts", ["fd", "ts"]],
    ["ts + airYardsShare", ["ts", "airYardsShare"]],
    ["wopr", ["wopr"]],
    ["targets + airYards", ["targets", "airYards"]],
    ["ts + wopr", ["ts", "wopr"]],
    ["targets + ts", ["targets", "ts"]],
  ],
  TE: [
    ["SHIPPED fd + ts", ["fd", "ts"]],
    ["ts + airYardsShare", ["ts", "airYardsShare"]],
    ["wopr", ["wopr"]],
    ["targets + receptions", ["targets", "receptions"]],
    ["targets + ts", ["targets", "ts"]],
    ["ts + tds", ["ts", "tds"]],
  ],
};

const bucketOf = (r) => Math.floor((r - 1) / BUCKET);
function bucketMeans(data, feats) {
  const bm = {};
  for (const b of new Set(data.map((x) => bucketOf(x.rank)))) {
    const inB = data.filter((x) => bucketOf(x.rank) === b);
    bm[b] = {};
    for (const c of feats) {
      const vals = inB.map((x) => x.u[c]).filter((v) => v != null && Number.isFinite(v));
      bm[b][c] = vals.length ? vals.reduce((a, x) => a + x, 0) / vals.length : null;
    }
  }
  return bm;
}
// Floors guard the denominator: a bucket whose mean usage is ~0 makes the ratio meaningless rather
// than large, and every position has at least one feature that is legitimately zero for it.
const FLOOR = { fd: 0.05, ts: 0.005, ays: 0.005, airYardsShare: 0.005, wopr: 0.01, carries: 0.5, targets: 0.3,
  receptions: 0.2, touches: 0.5, attempts: 1, dropbacks: 1, rushYards: 0.5, recYards: 1, airYards: 1,
  passAirYards: 1, tds: 0.01 };
const rel = (x, c, bm) => {
  const m = bm[bucketOf(x.rank)]?.[c], v = x.u[c];
  if (v == null || !Number.isFinite(v) || m == null || !(m > (FLOOR[c] ?? 0))) return 1;
  return v / m;
};
function ols(X, y) {
  const p = X[0].length;
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
// RANK CONTROLS. fit-opportunity measures a position's signal as the INCREMENT over a rank-quadratic
// baseline, not over a constant -- and the two disagree for QB, which is why this is a flag rather
// than a choice buried in one script. The ratio is already actual/rank-predicted, but it retains
// residual rank dependence, so "does usage add beyond rank" and "does usage beat a constant" are
// genuinely different questions and can give opposite answers.
const RANKCTL = process.argv.includes("--rankControls");
// TARGET. fit-opportunity scores its per-position signal on SEASON POINTS with rank controls; this
// script defaults to the rank-normalised RATIO. That difference alone explains a sign flip on QB,
// and it went unnoticed because both are defensible and neither script said which it used. Points +
// rank controls is the configuration that actually sets the shipped amplitudes.
const TARGET_POINTS = process.argv.includes("--points");
const yOf = (x) => (TARGET_POINTS ? x.pts : x.ratio);
function loso(data, feats) {
  let ss = 0, sst = 0;
  for (const hold of seasons) {
    const tr = data.filter((x) => x.season !== hold), te = data.filter((x) => x.season === hold);
    if (tr.length < 60 || !te.length) continue;
    const bm = bucketMeans(tr, feats);
    const row = (x) => RANKCTL
      ? [1, x.rank, x.rank * x.rank, ...feats.map((c) => rel(x, c, bm))]
      : [1, ...feats.map((c) => rel(x, c, bm))];
    const b = ols(tr.map(row), tr.map(yOf));
    const mu = tr.reduce((a, x) => a + yOf(x), 0) / tr.length;
    // With rank controls the BASELINE is rank-only, so the number reported is the incremental lift
    // usage adds -- the same quantity fit-opportunity uses to set each amplitude.
    let bb = null, mub = mu;
    if (RANKCTL) {
      const rowB = (x) => [1, x.rank, x.rank * x.rank];
      bb = ols(tr.map(rowB), tr.map(yOf));
    }
    for (const x of te) {
      const pr = row(x).reduce((a, v, i) => a + v * b[i], 0);
      const base = bb ? [1, x.rank, x.rank * x.rank].reduce((a, v, i) => a + v * bb[i], 0) : mub;
      ss += (yOf(x) - pr) ** 2; sst += (yOf(x) - base) ** 2;
    }
  }
  return 1 - ss / sst;
}
/** Nested: the SET is chosen by an inner LOSO on training seasons only. */
function nested(data, sets) {
  let ss = 0, sst = 0;
  const picks = [];
  for (const hold of seasons) {
    const outer = data.filter((x) => x.season !== hold), te = data.filter((x) => x.season === hold);
    if (outer.length < 60 || !te.length) continue;
    let best = null;
    for (const [label, feats] of sets) {
      const r2 = loso(outer, feats);
      if (!best || r2 > best.r2) best = { label, feats, r2 };
    }
    picks.push(best.label);
    // MUST mirror loso exactly -- same target, same rank controls, same baseline. It did not: the
    // target and rank-control changes were made in loso and not here, so nested silently predicted
    // the RATIO while every set above was scored on POINTS, and reported -0.0068 while each
    // individual set was positive. An internally impossible pair of numbers is the only reason it
    // was caught; a nested figure that merely looked low would have been believed.
    const bm = bucketMeans(outer, best.feats);
    const row = (x) => RANKCTL
      ? [1, x.rank, x.rank * x.rank, ...best.feats.map((c) => rel(x, c, bm))]
      : [1, ...best.feats.map((c) => rel(x, c, bm))];
    const b = ols(outer.map(row), outer.map(yOf));
    const mu = outer.reduce((a, x) => a + yOf(x), 0) / outer.length;
    const bb = RANKCTL ? ols(outer.map((x) => [1, x.rank, x.rank * x.rank]), outer.map(yOf)) : null;
    for (const x of te) {
      const pr = row(x).reduce((a, v, i) => a + v * b[i], 0);
      const base = bb ? [1, x.rank, x.rank * x.rank].reduce((a, v, i) => a + v * bb[i], 0) : mu;
      ss += (yOf(x) - pr) ** 2; sst += (yOf(x) - base) ** 2;
    }
  }
  const freq = {};
  for (const p of picks) freq[p] = (freq[p] ?? 0) + 1;
  return { r2: 1 - ss / sst, picks: Object.entries(freq).sort((a, b) => b[1] - a[1]) };
}

for (const pos of POS) {
  const data = cases[pos];
  console.log(`\n${"=".repeat(74)}`);
  console.log(`${pos} -- ${data.length} player-seasons`);
  console.log(`${"=".repeat(74)}`);
  // Harness control FIRST. Everything below can legitimately print "the shipped pair is fine", which
  // is also what a mis-wired loop prints.
  for (const x of data) x.u.__leak = yOf(x) + (Math.random() - 0.5) * (TARGET_POINTS ? 120 : 0.9);
  const ctrl = loso(data, ["__leak"]);
  console.log(`  harness control (planted signal): R2 ${ctrl.toFixed(4)} -- ${ctrl > 0.2 ? "the loop can detect a lift" : "*** BROKEN, ignore this position ***"}`);
  for (const x of data) delete x.u.__leak;

  console.log(`\n  feature set                      LOSO R2`);
  const scored = SETS[pos].map(([label, feats]) => ({ label, feats, r2: loso(data, feats) }));
  const shipped = scored.find((s) => s.label.startsWith("SHIPPED"));
  for (const s of scored.sort((a, b) => b.r2 - a.r2)) {
    const mark = s.label.startsWith("SHIPPED") ? "  <- ships today" : "";
    console.log(`  ${s.label.padEnd(32)} ${s.r2.toFixed(4).padStart(8)}${mark}`);
  }
  const nst = nested(data, SETS[pos]);
  console.log(`\n  NESTED (set chosen inside each fold): ${nst.r2.toFixed(4)}`);
  console.log(`  chosen per fold: ${nst.picks.map(([k, v]) => `${k} x${v}`).join(", ")}`);
  const best = scored[0];
  const gain = best.r2 - shipped.r2;
  console.log(`  best-vs-shipped on LOSO: ${gain >= 0 ? "+" : ""}${gain.toFixed(4)}` +
    `${best.label.startsWith("SHIPPED") ? "  -- nothing beats what ships" : `  -- ${best.label} beats the shipped pair`}`);
}

console.log(`
${"-".repeat(74)}
A set only earns a change if it wins the NESTED column AND is chosen stably across folds. A set that
wins on LOSO but is picked in 8 of 19 folds is the fold-to-fold instability that sank the K/DST
attempt, where the whole-data screen and the per-fold selector disagreed and none of it survived.`);
