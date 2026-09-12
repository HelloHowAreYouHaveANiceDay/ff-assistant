// THE SHARED ARBITER CORE for the unified evaluation engine (docs/redesign/unified-evaluation-model.md).
// Both the DRAFT arbiter (scripts/cpcv.mjs) and the IN-SEASON arbiter use these primitives, so the two
// harnesses can NEVER diverge on the statistics -- the whole point of the unification. Metric-agnostic:
// everything operates on CRN-paired trial dumps `(season, seed, ...metric columns)`.
//
// The estimator is doubly-robust off-policy evaluation in miniature: CRN pairing gives a low-bias direct
// comparison; a validated surrogate metric (read as a secondary column) gives the low-variance/high-power
// read. The SEASON is the unit of generalisation. See cpcv.mjs for the reader that formats these.
import fs from "node:fs";

/** Load a --dump-trials TSV into Map<seed, {season, ...all numeric columns by header}>. Generalised over
 *  columns so a draft dump (champ/playoffs/...) and an in-season dump (rosWins/playoffDelta/...) both load. */
export function loadDump(path) {
  const lines = fs.readFileSync(path, "utf8").trim().split(/\r?\n/);
  const header = lines[0].split("\t");
  const seedIdx = header.indexOf("seed") >= 0 ? header.indexOf("seed") : 1;
  const m = new Map();
  for (const l of lines.slice(1)) {
    const r = l.split("\t"); const o = {};
    header.forEach((h, i) => { o[h] = Number(r[i]); });
    m.set(r[seedIdx], o);
  }
  return m;
}

/** Seeds present in BOTH arms (CRN pairing requires identical seed sets). */
export function sharedSeeds(A, B) { return [...A.keys()].filter((k) => B.has(k)); }

/** Per-season mean of one metric column over the shared seeds. Equal-season weighting is this repo's
 *  unit of analysis. Returns { seasonsArr, rate: Map<season, mean> } plus the pooled full-set mean. */
export function perSeasonRates(map, seeds, col) {
  const bySeason = new Map();
  let poolSum = 0, poolN = 0;
  for (const s of seeds) {
    const o = map.get(s);
    if (!bySeason.has(o.season)) bySeason.set(o.season, { sum: 0, n: 0 });
    const e = bySeason.get(o.season); e.sum += o[col]; e.n++;
    poolSum += o[col]; poolN++;
  }
  const seasonsArr = [...bySeason.keys()].sort((x, y) => x - y);
  const rate = new Map(seasonsArr.map((y) => [y, bySeason.get(y).sum / bySeason.get(y).n]));
  return { seasonsArr, rate, full: poolN ? poolSum / poolN : 0, poolN };
}

/** Deterministic CPCV test/train subsets: sample nPaths DISTINCT k-season test groups (Fisher-Yates
 *  partial shuffle, LCG seeded by pathSeed) and their complements. A pure re-partition of the seasons;
 *  reproducible from the logged seed. */
export function cpcvSubsets(Ntot, { k, nPaths, pathSeed }) {
  let rng = pathSeed >>> 0;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const sampleSubset = () => {
    const idx = [...Array(Ntot).keys()];
    for (let i = 0; i < k; i++) { const j = i + Math.floor(rand() * (Ntot - i)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    return idx.slice(0, k).sort((x, y) => x - y);
  };
  const subsets = [], seen = new Set();
  let guard = 0;
  while (subsets.length < nPaths && guard < nPaths * 50) {
    guard++;
    const test = sampleSubset(); const key = test.join(",");
    if (seen.has(key)) continue; seen.add(key);
    const testSet = new Set(test);
    subsets.push({ test, train: [...Array(Ntot).keys()].filter((i) => !testSet.has(i)) });
  }
  return subsets;
}

/** OOS (test) and IS (train) lift for ONE metric over the given subsets. scale=100 -> percentage points. */
export function pathLifts(subsets, rateA, rateB, seasonsArr, scale = 100) {
  const meanRate = (rate, idxs) => idxs.reduce((s, i) => s + rate.get(seasonsArr[i]), 0) / idxs.length;
  return subsets.map((p) => ({
    test: scale * (meanRate(rateB, p.test) - meanRate(rateA, p.test)),
    train: scale * (meanRate(rateB, p.train) - meanRate(rateA, p.train)),
  }));
}

/** SEASON-LEVEL PAIRED BOOTSTRAP -- the CI on the effect and the right instrument for a thin edge. The
 *  per-season lift (treatment - baseline over shared seeds) is the quantity; the bootstrap resamples
 *  SEASONS. Reports the ~smallest effect resolvable at 80% power (2.9*SE) so a null reads as "truly ~0"
 *  vs "below resolution". The CPCV path spread is NOT the CI (paths are overlapping, correlated subsets). */
export function seasonEffect(rateT, rateBase, seasonsArr, { pathSeed, scale = 100 } = {}) {
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const diffs = seasonsArr.map((y) => scale * (rateT.get(y) - rateBase.get(y)));
  const md = mean(diffs);
  const sd = Math.sqrt(diffs.reduce((s, v) => s + (v - md) ** 2, 0) / (diffs.length - 1));
  const se = sd / Math.sqrt(diffs.length);
  let rng = (pathSeed ^ 0x9e3779b9) >>> 0;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const boot = [];
  for (let i = 0; i < 20000; i++) { let acc = 0; for (let j = 0; j < diffs.length; j++) acc += diffs[(rand() * diffs.length) | 0]; boot.push(acc / diffs.length); }
  boot.sort((a, b) => a - b);
  return {
    effect: md, sd, se, t: se > 0 ? md / se : 0,
    ciLo: boot[(0.025 * boot.length) | 0], ciHi: boot[(0.975 * boot.length) | 0],
    wins: diffs.filter((d) => d > 0).length, losses: diffs.filter((d) => d < 0).length,
    detectable: 2.9 * se, nSeasons: diffs.length,
  };
}

/** PBO (Probability of Backtest Overfitting), two-config CSCV: fraction of paths where the IS-best config
 *  (higher train lift) is WORSE out of sample. Read RELATIVELY on this two-config engine -- near 1 =
 *  overfit/null (a null runs HIGH here by the complementary-split constraint), near 0 = a real transferable
 *  edge. Train ties carry no info and are excluded. */
export function pboOf(lifts) {
  let overfit = 0, decided = 0;
  for (const p of lifts) { if (p.train === 0) continue; decided++; if ((p.train > 0) !== (p.test > 0)) overfit++; }
  return { pbo: decided ? overfit / decided : NaN, overfit, decided };
}
