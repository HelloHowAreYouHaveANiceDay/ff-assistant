// DOES QB PASSING VOLUME SURVIVE NESTING? Measure before building anything.
//
//   node --import tsx scripts/qb-usage-probe.mjs
//
// The opportunity model defines usage as receiving_first_downs + rushing_first_downs and
// target_share. A quarterback has no target share and no receiving first downs, so QB usage has
// always been measured on scrambles alone -- it came back at ~0, was recorded as a fact about
// quarterbacks, and models.ts now carries a guard REJECTING any QB amplitude above 0.15 on the
// strength of it. The offensive sweep says the columns that actually describe a quarterback's
// workload (attempts, air yards) correlate with the residual at +0.168 and +0.172, unabsorbed.
//
// That is a mechanism, not just a correlation, which is why it is worth a look. It is not a reason
// to skip the check: the K/DST screen produced better-looking correlations with a plausible story
// attached and every one of them evaporated under nested cross-validation.
//
// So this probe does the cheap decisive thing FIRST -- nested lift for QB with the right columns --
// and touches no schema, no consumer and no shipped model. If it does not clear the bar there is
// nothing to build.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { parseCsv, playerWeekUrl } from "../src/data/nflverse.ts";

const SEASONS = Array.from({ length: 20 }, (_, i) => 2006 + i);
const BUCKET = 6, MAX_RANK = 40;
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
  if (pos === "QB") tot.set(`${Number(s)}|${name}`, { pts: Number(pts), name, season: Number(s) });
}
const seasons = [...new Set([...tot.values()].map((v) => v.season))].sort().filter((s) => s >= 2007);
const rank = new Map();
for (const s of seasons.concat([seasons[0] - 1])) {
  [...tot.entries()].filter(([, v]) => v.season === s)
    .sort((a, b) => b[1].pts - a[1].pts).forEach(([k], i) => rank.set(k, i + 1));
}
const curve = [];
{
  const lists = seasons.map((s) => [...tot.values()].filter((v) => v.season === s).map((v) => v.pts).sort((a, b) => b - a));
  const maxlen = Math.max(0, ...lists.map((l) => l.length));
  for (let k = 0; k < maxlen; k++) {
    let sum = 0, c = 0;
    for (const l of lists) if (k < l.length) { sum += l[k]; c++; }
    curve[k] = c ? sum / c : 0;
  }
}

console.log("aggregating QB seasons ...");
const usage = new Map();
for (const yr of [SEASONS[0] - 1, ...SEASONS]) {
  let raw; try { raw = await csv(playerWeekUrl(yr), `pw-${yr}`); } catch { continue; }
  const agg = new Map();
  for (const r of raw) {
    if (r.season_type !== "REG" || (r.position || "").toUpperCase() !== "QB") continue;
    const name = (r.player_display_name || "").trim(); if (!name) continue;
    let a = agg.get(name); if (!a) { a = { g: 0 }; agg.set(name, a); }
    a.g += 1;
    const add = (k, v) => { a[k] = (a[k] ?? 0) + v; };
    add("att", N(r.attempts)); add("pay", N(r.passing_air_yards)); add("car", N(r.carries));
    add("cmp", N(r.completions)); add("pyd", N(r.passing_yards)); add("ryd", N(r.rushing_yards));
    add("sack", N(r.sacks_suffered));
    // What the model uses TODAY for a quarterback -- the reason its QB signal measured ~0.
    add("fd", N(r.receiving_first_downs) + N(r.rushing_first_downs));
    add("ts", N(r.target_share));
  }
  for (const [name, a] of agg) {
    if (a.g < 4) continue;
    usage.set(`${yr}|${name}`, {
      // the right columns
      attempts: a.att / a.g,
      airYards: a.pay / a.g,
      dropbacks: (a.att + (a.sack ?? 0)) / a.g,
      rushYards: a.ryd / a.g,          // a running quarterback is a different asset at the same rank
      // the columns in the shipped model, kept so the comparison is like for like
      fd: a.fd / a.g,
      ts: a.ts / a.g,
    });
  }
}

const cases = [];
for (const v of tot.values()) {
  if (!seasons.includes(v.season)) continue;
  const r = rank.get(`${v.season - 1}|${v.name}`);
  if (!r || r > MAX_RANK) continue;
  const pred = curve[r - 1];
  if (!pred || pred < 20) continue;
  const u = usage.get(`${v.season - 1}|${v.name}`);
  if (!u) continue;
  cases.push({ season: v.season, name: v.name, rank: r, ratio: v.pts / pred, u });
}
console.log(`${cases.length} QB seasons with a prior rank inside ${MAX_RANK} and prior-season usage\n`);

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
const rel = (x, c, bm) => {
  const m = bm[bucketOf(x.rank)]?.[c], v = x.u[c];
  if (v == null || !Number.isFinite(v) || m == null || Math.abs(m) < 1e-6) return 1;
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
/** Leave-one-season-out R2 against the constant baseline, with the bucket normalisation refitted
 *  inside each fold so it cannot leak the held-out season. */
function loso(feats) {
  let ss = 0, sst = 0;
  for (const hold of seasons) {
    const tr = cases.filter((x) => x.season !== hold), te = cases.filter((x) => x.season === hold);
    if (tr.length < 60 || !te.length) continue;
    const bm = bucketMeans(tr, feats);
    const b = ols(tr.map((x) => [1, ...feats.map((c) => rel(x, c, bm))]), tr.map((x) => x.ratio));
    const mean = tr.reduce((a, x) => a + x.ratio, 0) / tr.length;
    for (const x of te) {
      const pr = [1, ...feats.map((c) => rel(x, c, bm))].reduce((a, v, i) => a + v * b[i], 0);
      ss += (x.ratio - pr) ** 2; sst += (x.ratio - mean) ** 2;
    }
  }
  return 1 - ss / sst;
}
/** The same, but the FEATURE CHOICE is remade inside every fold from a candidate pool. */
function nested(pool, k) {
  let ss = 0, sst = 0;
  const picks = [];
  for (const hold of seasons) {
    const tr = cases.filter((x) => x.season !== hold), te = cases.filter((x) => x.season === hold);
    if (tr.length < 60 || !te.length) continue;
    const bm = bucketMeans(tr, pool);
    const y = tr.map((x) => x.ratio);
    const my = y.reduce((a, v) => a + v, 0) / y.length;
    const score = (c) => {
      const xs = tr.map((x) => rel(x, c, bm));
      const mx = xs.reduce((a, v) => a + v, 0) / xs.length;
      let n = 0, dx = 0, dy = 0;
      for (let i = 0; i < xs.length; i++) { n += (xs[i] - mx) * (y[i] - my); dx += (xs[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
      return dx > 0 && dy > 0 ? Math.abs(n / Math.sqrt(dx * dy)) : 0;
    };
    const feats = [...pool].map((c) => ({ c, r: score(c) })).sort((a, b) => b.r - a.r).slice(0, k).map((x) => x.c);
    picks.push(feats.join("+"));
    const b = ols(tr.map((x) => [1, ...feats.map((c) => rel(x, c, bm))]), y);
    for (const x of te) {
      const pr = [1, ...feats.map((c) => rel(x, c, bm))].reduce((a, v, i) => a + v * b[i], 0);
      ss += (x.ratio - pr) ** 2; sst += (x.ratio - my) ** 2;
    }
  }
  const freq = {};
  for (const p of picks) freq[p] = (freq[p] ?? 0) + 1;
  return { r2: 1 - ss / sst, picks: Object.entries(freq).sort((a, b) => b[1] - a[1]) };
}

// HARNESS CONTROL first, for the reason the K/DST run needed one: a loop that reports nothing and a
// loop that is broken produce the same page.
for (const x of cases) x.u.__leak = x.ratio + (Math.random() - 0.5) * 0.9;
console.log(`HARNESS CONTROL: planted signal scores R2 ${loso(["__leak"]).toFixed(4)} -- ` +
  `${loso(["__leak"]) > 0.2 ? "the loop can detect a lift" : "*** BROKEN, nothing below is readable ***"}`);
for (const x of cases) delete x.u.__leak;

console.log(`\n${"=".repeat(72)}`);
console.log("QB OPPORTUNITY: what the model measures now vs what it should");
console.log(`${"=".repeat(72)}`);
console.log("  feature set                                    LOSO R2");
const SETS = [
  ["SHIPPED: fd + ts (receiving stats, for a QB)", ["fd", "ts"]],
  ["attempts", ["attempts"]],
  ["air yards", ["airYards"]],
  ["attempts + air yards", ["attempts", "airYards"]],
  ["dropbacks", ["dropbacks"]],
  ["attempts + rush yards", ["attempts", "rushYards"]],
  ["attempts + air yards + rush yards", ["attempts", "airYards", "rushYards"]],
];
for (const [label, feats] of SETS) {
  console.log(`  ${label.padEnd(46)} ${loso(feats).toFixed(4).padStart(8)}`);
}

// PROPER NESTED CV: the inner loop chooses the FEATURE SET by cross-validation on the training
// seasons, not by marginal correlation.
//
// This matters because a greedy top-k-by-correlation selector is weak, and a weak selector makes the
// nested number a statement about the selector rather than about the data. Above it picks
// dropbacks+airYards in 13 of 19 folds while the best-scoring set in the table is
// attempts+rushYards -- so a 0.0000 from that loop cannot distinguish "no signal" from "my selector
// could not find it". Here each outer fold runs a full inner LOSO over the candidate sets, takes the
// winner, and is scored on the season it never saw.
function nestedSets(sets) {
  let ss = 0, sst = 0;
  const picks = [];
  for (const hold of seasons) {
    const outer = cases.filter((x) => x.season !== hold), te = cases.filter((x) => x.season === hold);
    if (outer.length < 60 || !te.length) continue;
    const inner = seasons.filter((s) => s !== hold);
    let best = null;
    for (const [label, feats] of sets) {
      let iss = 0, isst = 0;
      for (const ih of inner) {
        const tr = outer.filter((x) => x.season !== ih), ite = outer.filter((x) => x.season === ih);
        if (tr.length < 50 || !ite.length) continue;
        const bm = bucketMeans(tr, feats);
        const b = ols(tr.map((x) => [1, ...feats.map((c) => rel(x, c, bm))]), tr.map((x) => x.ratio));
        const mu = tr.reduce((a, x) => a + x.ratio, 0) / tr.length;
        for (const x of ite) {
          const pr = [1, ...feats.map((c) => rel(x, c, bm))].reduce((a, v, i) => a + v * b[i], 0);
          iss += (x.ratio - pr) ** 2; isst += (x.ratio - mu) ** 2;
        }
      }
      const r2 = 1 - iss / isst;
      if (!best || r2 > best.r2) best = { label, feats, r2 };
    }
    picks.push(best.label);
    const bm = bucketMeans(outer, best.feats);
    const b = ols(outer.map((x) => [1, ...best.feats.map((c) => rel(x, c, bm))]), outer.map((x) => x.ratio));
    const mu = outer.reduce((a, x) => a + x.ratio, 0) / outer.length;
    for (const x of te) {
      const pr = [1, ...best.feats.map((c) => rel(x, c, bm))].reduce((a, v, i) => a + v * b[i], 0);
      ss += (x.ratio - pr) ** 2; sst += (x.ratio - mu) ** 2;
    }
  }
  const freq = {};
  for (const p of picks) freq[p] = (freq[p] ?? 0) + 1;
  return { r2: 1 - ss / sst, picks: Object.entries(freq).sort((a, b) => b[1] - a[1]) };
}

const POOL = ["attempts", "airYards", "dropbacks", "rushYards", "fd", "ts"];
const nst = nested(POOL, 2);
console.log(`\n  NESTED (selection remade inside every fold, from ${POOL.length} candidates): ${nst.r2.toFixed(4)}`);
console.log(`  features chosen per fold: ${nst.picks.map(([k, v]) => `${k} x${v}`).join(", ")}`);
const nst2 = nestedSets(SETS.filter(([, f]) => !(f.length === 2 && f[0] === "fd")));
console.log(`\n  NESTED with INNER-CV model selection: ${nst2.r2.toFixed(4)}`);
console.log(`  set chosen per fold: ${nst2.picks.map(([k, v]) => `${k} x${v}`).join(", ")}`);
console.log(`
  The nested number is the one that decides. For reference the two shipped models measure
  +0.0069 (age) and +0.0095 (opportunity, driven by RB/WR) under the same treatment, and the
  K/DST attempt measured -0.0073 and -0.0041 and was not shipped.`);
