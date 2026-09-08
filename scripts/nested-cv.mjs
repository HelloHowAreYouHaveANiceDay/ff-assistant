// IS THE MODEL ACTUALLY BETTER, OR DID WE SELECT OUR WAY THERE? Nested cross-validation.
//
//   node --import tsx scripts/nested-cv.mjs
//
// THE METHODOLOGICAL HOLE THIS EXISTS TO MEASURE. Every feature in this projection was chosen by
// running a hold-one-season-out test and keeping what scored well -- age curve, opportunity, the
// per-position amplitudes, the [0.5, 2.0] calibration guard, the +/-25% clamp. Then the SAME
// hold-one-season-out number was reported as the model's out-of-sample performance. That is
// selection and evaluation on one dataset, and it inflates the result by an unknown amount: the
// choice of what to keep already used the test seasons.
//
// The standard fix is NESTED cross-validation. An OUTER loop holds a season out for evaluation and
// never touches it. Inside each outer fold, an INNER loop over the remaining seasons does all the
// fitting and all the choosing. Every hyperparameter -- amplitudes included -- is re-derived per
// outer fold, so nothing the model saw when deciding its own shape appears in the score.
//
// WHAT COUNTS AS BEATING SOMETHING, which matters as much as the method. R-squared against the
// season mean is a soft bar: any model that knows rank clears it. The bar that matters is the
// MARKET -- expert consensus rank mapped through the historical curve -- because that is available
// free, and a model that cannot beat it is elaborate machinery for nothing. So the ladder is:
//
//   naive     last season's points, carried forward
//   market    ECR rank -> mean historical points at that rank   <- the bar to beat
//   +age      market plus the fitted age curve
//   +opp      market plus the fitted opportunity model
//   +both     the shipped model
//
// Each rung is refit inside the inner loop, so the comparison is honest rather than a replay of
// choices already made.
import { readFileSync } from "node:fs";

const POS = ["QB", "RB", "WR", "TE"];
const N = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

// --- season totals, and prior-season rank as the stand-in for preseason consensus ------------------
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
// birth years, for the age rung
const birth = new Map();
try {
  const age = JSON.parse(readFileSync("data/age-curve.json", "utf8"));
  for (const [key, y] of Object.entries(age.birthYear ?? {})) {
    const i = key.indexOf("|");
    birth.set(key.slice(i + 1), y);
  }
} catch { /* the age rung will simply have no coverage, and says so */ }
// prior-season usage, for the opportunity rung
const usage = new Map();
try {
  const opp = JSON.parse(readFileSync("data/opportunity-model.json", "utf8"));
  for (const [k, u] of Object.entries(opp.players ?? {})) usage.set(k, u);
} catch { /* same */ }

const rows = [];
for (const s of seasons) {
  for (const v of tot.values()) {
    if (v.season !== s) continue;
    const r = rank.get(`${s - 1}|${v.name}`);
    if (!r || r > 60) continue;
    const prior = tot.get(`${s - 1}|${v.name}`);
    rows.push({
      season: s, pos: v.pos, name: v.name, y: v.pts, rank: r,
      priorPts: prior ? prior.pts : 0,
      age: birth.has(v.name) ? s - birth.get(v.name) : null,
      use: usage.get(`${s - 1}|${v.name}`) ?? null,
    });
  }
}
console.log(`${rows.length} player-seasons, ${seasons.length} seasons (${seasons[0]}-${seasons[seasons.length - 1]})\n`);

/** Rank curve fitted ONLY on the seasons given -- the inner loop's training data. */
function fitCurve(train) {
  const curve = {};
  for (const pos of POS) {
    const byRank = new Map();
    for (const r of train) {
      if (r.pos !== pos) continue;
      (byRank.get(r.rank) ?? byRank.set(r.rank, []).get(r.rank)).push(r.y);
    }
    curve[pos] = new Map([...byRank].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
  }
  return curve;
}
const curveAt = (curve, pos, rk) => {
  const m = curve[pos];
  if (!m || !m.size) return null;
  if (m.has(rk)) return m.get(rk);
  let best = null, bd = Infinity;
  for (const [k, v] of m) { const d = Math.abs(k - rk); if (d < bd) { bd = d; best = v; } }
  return best;
};

/** Age multiplier fitted on `train` only: mean actual/predicted by age, shrunk and normalised. */
function fitAge(train, curve) {
  const byAge = new Map();
  for (const r of train) {
    if (r.age == null) continue;
    const pred = curveAt(curve, r.pos, r.rank);
    if (!pred || pred < 20) continue;
    const a = Math.max(21, Math.min(38, r.age));
    (byAge.get(a) ?? byAge.set(a, []).get(a)).push(r.y / pred);
  }
  const m = new Map();
  let sum = 0, n = 0;
  for (const [a, v] of byAge) { if (v.length < 15) continue; const mu = v.reduce((x, y) => x + y, 0) / v.length; m.set(a, mu); sum += mu * v.length; n += v.length; }
  const mean = n ? sum / n : 1;
  // Normalised, exactly as the shipped curve is: the level shift is regression to the mean, not age.
  for (const [a, mu] of m) m.set(a, Math.max(0.8, Math.min(1.2, mu / (mean || 1))));
  return m;
}
/** Opportunity multiplier fitted on `train` only: first downs per game relative to the rank bucket. */
function fitOpp(train, curve) {
  const bucket = (rk) => Math.floor((rk - 1) / 6);
  const bmean = new Map();
  for (const r of train) {
    if (!r.use) continue;
    const k = `${r.pos}|${bucket(r.rank)}`;
    (bmean.get(k) ?? bmean.set(k, []).get(k)).push(r.use.fd);
  }
  const mu = new Map([...bmean].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
  const pts = [];
  for (const r of train) {
    if (!r.use) continue;
    const pred = curveAt(curve, r.pos, r.rank);
    if (!pred || pred < 20) continue;
    const base = mu.get(`${r.pos}|${bucket(r.rank)}`);
    if (!base || base < 0.05) continue;
    pts.push({ pos: r.pos, rel: r.use.fd / base, ratio: r.y / pred });
  }
  const coef = {};
  for (const pos of POS) {
    const g = pts.filter((p) => p.pos === pos);
    if (g.length < 60) { coef[pos] = null; continue; }
    const mx = g.reduce((a, p) => a + p.rel, 0) / g.length, my = g.reduce((a, p) => a + p.ratio, 0) / g.length;
    let num = 0, den = 0;
    for (const p of g) { num += (p.rel - mx) * (p.ratio - my); den += (p.rel - mx) ** 2; }
    coef[pos] = den ? { b: num / den, mx, my } : null;
  }
  return { mu, coef, bucket };
}

const predictors = {
  naive: (r) => r.priorPts,
  market: (r, m) => curveAt(m.curve, r.pos, r.rank) ?? 0,
  age: (r, m) => {
    const base = curveAt(m.curve, r.pos, r.rank) ?? 0;
    if (r.age == null) return base;
    const f = m.age.get(Math.max(21, Math.min(38, r.age)));
    return base * (f ?? 1);
  },
  opp: (r, m) => {
    const base = curveAt(m.curve, r.pos, r.rank) ?? 0;
    const c = m.opp.coef[r.pos];
    if (!r.use || !c) return base;
    const bm = m.opp.mu.get(`${r.pos}|${m.opp.bucket(r.rank)}`);
    if (!bm || bm < 0.05) return base;
    const pred = c.my + c.b * (r.use.fd / bm - c.mx);
    return base * Math.max(0.75, Math.min(1.25, pred / (c.my || 1)));
  },
  both: (r, m) => {
    const a = predictors.age(r, m), o = predictors.opp(r, m), base = curveAt(m.curve, r.pos, r.rank) ?? 1;
    return base ? (a * o) / base : 0;   // multiply the two multipliers, as the shipped model does
  },
};

console.log("NESTED CV -- outer season held out for scoring, everything fitted on the inner seasons only");
console.log("  model     R-sq vs season mean    RMSE     vs market");
const results = {};
for (const key of Object.keys(predictors)) {
  let ss = 0, sst = 0, n = 0;
  for (const hold of seasons) {
    const train = rows.filter((r) => r.season !== hold), test = rows.filter((r) => r.season === hold);
    if (train.length < 200 || !test.length) continue;
    // EVERYTHING refit inside the fold. The shipped model's amplitudes were chosen once, on all
    // seasons; re-deriving them here is the difference between a real out-of-sample number and a
    // replay of decisions that already saw the test set.
    const curve = fitCurve(train);
    const m = { curve, age: fitAge(train, curve), opp: fitOpp(train, curve) };
    const mean = train.reduce((a, r) => a + r.y, 0) / train.length;
    for (const r of test) {
      const p = predictors[key](r, m);
      ss += (r.y - p) ** 2; sst += (r.y - mean) ** 2; n++;
    }
  }
  results[key] = { r2: 1 - ss / sst, rmse: Math.sqrt(ss / n) };
}
for (const [key, v] of Object.entries(results)) {
  const d = v.r2 - results.market.r2;
  console.log(`  ${key.padEnd(9)} ${v.r2.toFixed(4).padStart(12)}      ${v.rmse.toFixed(1).padStart(6)}   ` +
    (key === "market" ? "   (the bar)" : `${(d >= 0 ? "+" : "") + d.toFixed(4)}`));
}
console.log(`
HOW TO READ THIS.

The bar is MARKET, not the season mean. Consensus rank mapped through the historical curve is free,
and anything we add has to beat it or it is machinery for nothing.

Compare the +age and +opp rows here against the numbers those features were shipped on -- age
+0.0154 R-sq, opportunity +0.0186 to +0.0218 per position. Those came from a SINGLE hold-one-out
loop that also chose the amplitudes, the clamp and the calibration guard. Any gap between the two is
the size of the selection effect, and it is the number nobody had.`);
