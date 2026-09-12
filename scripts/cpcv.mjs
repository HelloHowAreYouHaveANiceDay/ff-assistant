// CPCV arbiter core + experiment ledger (redesign Phase 2, spec: docs/redesign/experimentation-redesign.md A1/A2/A3.1).
//
// WHY THIS EXISTS. The championship backtest prints ONE number (e.g. 38.5%). Two configs that differ
// by 0.2pp are indistinguishable from noise at that resolution -- the thing that made 0.2343-vs-0.2345
// untrustworthy. This tool turns that fragile point delta into a DISTRIBUTION, cheaply, by exploiting
// a property the backtest already has: seeds are COMMON RANDOM NUMBERS (seed = s+1+yr*1000, a function
// of season and trial index only), so a given season+index means the SAME market noise and the SAME
// bot seats in BOTH arms. Every trial is a matched pair, and the per-SEASON champion outcomes are
// already dumped by `--dump-trials`.
//
// THE CPCV INSIGHT (why it is nearly free): we do NOT re-run the backtest per path. We run each config
// ONCE (with --dump-trials, identical seeds = CRN), then generate Combinatorial Purged CV PATHS =
// subsets of the N seasons, and recompute the title metric on each subset from the dumped outcomes.
// N choose k paths -> a distribution of the title lift, an honestly-powered replacement for the delta.
//
// OUTPUT per change: `lift = +X pp titles over M paths, P(lift>0)=.., path SD=.., PBO=..` plus a ledger
// line appended to data/experiments.jsonl.
//
// PURGE/EMBARGO STATUS (v1 limit, deliberate). The leak-free per-fold projection artifacts
// (data/fold-artifacts-2b, each season scored by an artifact BLIND to itself) already purge the test
// season from its own training. The EMBARGO -- also excluding seasons ADJACENT to a test season from
// that fold's training, because year-N and year-N+1 autocorrelate (career arcs, roster continuity) --
// is NOT applied here: it needs a per-fold REFIT (an artifact blind to {test, test+/-1}), which is a
// v2 enhancement. CPCV path construction below is purely a re-partition of already-computed outcomes,
// so it cannot add an embargo the artifacts do not carry. Noted, not built.
//
// USAGE
//   node scripts/cpcv.mjs                              # baseline=shipped, treatment=--no-rookies (the reference null)
//   node scripts/cpcv.mjs --treatment "--scarcity"     # flip a different flag
//   node scripts/cpcv.mjs --baseline-dump A.tsv --treatment-dump B.tsv --treatment "--no-rookies"  # reuse dumps (fast iteration)
//   node scripts/cpcv.mjs --k 12 --paths 200 --n 150 --seasons 1999-2024
//
// Run from the repo root (better-sqlite3 only resolves there).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fingerprintDraftArbiter } from "./lib/deps.mjs";

// ---- args -------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const BASE_FLAGS = val("--base-flags", "--full --no-lookahead --inflation"); // the shipped flagless arbiter config (golden master = 38.5%)
const TREATMENT = val("--treatment", "--no-rookies");                        // the flag(s) to ADD for the treatment arm
const SEASONS = val("--seasons", "1999-2024");
const N = val("--n", "150");
const ARTIFACT_DIR = val("--artifact-dir", "data/fold-artifacts-2b"); // no-op unless --projection artifact / --market ecr is in BASE_FLAGS; passed through per spec
const K = val("--k", null);                       // test-group size; default floor(N/2)
const N_PATHS = Number(val("--paths", "200"));
const PATH_SEED = Number(val("--path-seed", "12345"));
const LEDGER = val("--ledger", "data/experiments.jsonl");
const GOLDEN = Number(val("--golden", "38.5"));   // consistency-check target (shipped-config golden master)
const GOLDEN_TOL = Number(val("--golden-tol", "3.0")); // +/- pp of Monte-Carlo slack
const OUT_DIR = val("--out-dir", "data/trials");
const BASE_LABEL = val("--baseline-label", `shipped[${BASE_FLAGS}]`);
const TREAT_LABEL = val("--treatment-label", `shipped[${BASE_FLAGS}] ${TREATMENT}`);

let baseDump = val("--baseline-dump", null);
let treatDump = val("--treatment-dump", null);

// ---- run the two arms (unless dumps are supplied) ---------------------------------------------
function runArm(extraFlags, dumpPath) {
  const cmd = `npm run -s ff -- backtest ${BASE_FLAGS} ${extraFlags} --seasons ${SEASONS} --n ${N} --artifact-dir ${ARTIFACT_DIR} --dump-trials ${dumpPath}`;
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
  if (!fs.existsSync(dumpPath)) throw new Error(`backtest did not write ${dumpPath}`);
  return dumpPath;
}

if (!baseDump || !treatDump) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = Date.now();
  if (!baseDump) baseDump = runArm("", path.join(OUT_DIR, `cpcv-baseline-${stamp}.tsv`));
  if (!treatDump) treatDump = runArm(TREATMENT, path.join(OUT_DIR, `cpcv-treatment-${stamp}.tsv`));
} else {
  console.log(`reusing dumps:\n  baseline  ${baseDump}\n  treatment ${treatDump}`);
}

// ---- load + pair ------------------------------------------------------------------------------
// dump columns: season \t seed \t champ \t playoffs \t wins \t regPoints
const load = (p) => {
  const rows = fs.readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split("\t"));
  const m = new Map();
  for (const r of rows) m.set(r[1], { season: Number(r[0]), champ: Number(r[2]), playoffs: Number(r[3]) });
  return m;
};
const A = load(baseDump), B = load(treatDump);
const seeds = [...A.keys()].filter((k) => B.has(k));
if (seeds.length !== A.size || seeds.length !== B.size) {
  console.log(`\nWARNING: seed sets differ (baseline ${A.size}, treatment ${B.size}, shared ${seeds.length}).`);
  console.log(`The arms are then NOT CRN-paired and every number below is invalid -- re-run both with`);
  console.log(`the same --seasons and --n.`);
}

// ---- per-season title% for each arm (equal-season weighting = this repo's unit of analysis) ----
const bySeason = new Map(); // yr -> {aC,bC,n}
for (const s of seeds) {
  const yr = A.get(s).season;
  if (!bySeason.has(yr)) bySeason.set(yr, { aC: 0, bC: 0, n: 0 });
  const e = bySeason.get(yr);
  e.aC += A.get(s).champ; e.bC += B.get(s).champ; e.n++;
}
const seasonsArr = [...bySeason.keys()].sort((x, y) => x - y);
const Ntot = seasonsArr.length;
const rateA = new Map(seasonsArr.map((y) => [y, bySeason.get(y).aC / bySeason.get(y).n]));
const rateB = new Map(seasonsArr.map((y) => [y, bySeason.get(y).bC / bySeason.get(y).n]));

// ---- CONSISTENCY CHECK: baseline full-set title% must reproduce the point backtest (golden 38.5%) ----
// Pooled over all trials == equal-season mean when n/season is constant, which it is here. This is the
// correctness proof: if the dump-reading/aggregation is wrong, this misses the golden number.
let poolAc = 0, poolBc = 0, poolN = 0;
for (const s of seeds) { poolAc += A.get(s).champ; poolBc += B.get(s).champ; poolN++; }
const fullA = 100 * poolAc / poolN, fullB = 100 * poolBc / poolN;
const consistencyOK = Math.abs(fullA - GOLDEN) <= GOLDEN_TOL;
console.log(`\n================ CONSISTENCY CHECK ================`);
console.log(`  baseline full-set title%%: ${fullA.toFixed(2)}%  (golden master ${GOLDEN}% +/- ${GOLDEN_TOL}pp)  -> ${consistencyOK ? "PASS" : "FAIL"}`);
console.log(`  treatment full-set title%: ${fullB.toFixed(2)}%   point delta ${(fullB - fullA >= 0 ? "+" : "")}${(fullB - fullA).toFixed(2)}pp (untrustworthy alone -- see distribution below)`);
console.log(`  ${Ntot} seasons, ${poolN / Ntot} trials/season, ${poolN} paired trials`);
if (!consistencyOK) {
  console.log(`\n  CONSISTENCY CHECK FAILED -- the dump aggregation does not reproduce the point backtest.`);
  console.log(`  Fix this before trusting any distribution below. Aborting.`);
  process.exit(1);
}

// ---- CPCV paths -------------------------------------------------------------------------------
// Each path holds out k seasons as the TEST group; the complement (N-k) is the TRAIN group. C(25,12)
// is 5.2M, so we SAMPLE distinct subsets rather than enumerate. Deterministic RNG (path-seed) for
// reproducibility -- the seed is logged.
const k = K != null ? Number(K) : Math.floor(Ntot / 2);
let rng = PATH_SEED >>> 0;
const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const sampleSubset = () => {                 // Fisher-Yates partial shuffle -> k distinct indices
  const idx = [...Array(Ntot).keys()];
  for (let i = 0; i < k; i++) { const j = i + Math.floor(rand() * (Ntot - i)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(0, k).sort((x, y) => x - y);
};
const meanRate = (rate, idxs) => idxs.reduce((s, i) => s + rate.get(seasonsArr[i]), 0) / idxs.length;

const paths = [];
const seen = new Set();
let guard = 0;
while (paths.length < N_PATHS && guard < N_PATHS * 50) {
  guard++;
  const test = sampleSubset();
  const key = test.join(",");
  if (seen.has(key)) continue;               // distinct test groups (matters when C(N,k) is not enormous)
  seen.add(key);
  const testSet = new Set(test);
  const train = [...Array(Ntot).keys()].filter((i) => !testSet.has(i));
  const baseTest = meanRate(rateA, test), treatTest = meanRate(rateB, test);
  const baseTrain = meanRate(rateA, train), treatTrain = meanRate(rateB, train);
  paths.push({
    liftTest: 100 * (treatTest - baseTest),   // OOS lift (pp) -- the honest metric
    liftTrain: 100 * (treatTrain - baseTrain), // IS lift (pp)  -- used only for PBO
  });
}
const M = paths.length;

// ---- lift distribution ------------------------------------------------------------------------
const lifts = paths.map((p) => p.liftTest).sort((a, b) => a - b);
const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
const meanLift = mean(lifts);
const sdLift = Math.sqrt(lifts.reduce((s, v) => s + (v - meanLift) ** 2, 0) / (lifts.length - 1));
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
const ciLo = q(lifts, 0.025), ciHi = q(lifts, 0.975);
const pGt0 = paths.filter((p) => p.liftTest > 0).length / M;

// ---- PBO (Probability of Backtest Overfitting) ------------------------------------------------
// Two-config CSCV (Lopez de Prado). For each path: pick the IS-BEST config (higher train title%),
// then ask whether that same config is WORSE out-of-sample (lower test title%). PBO = fraction of
// paths where the in-sample winner underperforms out-of-sample.
//
// HOW TO READ IT (and why a null does NOT give 0.5 here). The classic 0.5 null-PBO is the asymptotic
// for MANY strategies with the IS winner's OOS RANK uniform. With only TWO configs on COMPLEMENTARY
// splits it is different, and the difference is the whole point: train and test partition a FIXED set
// of seasons, so liftTrain*(N-k) + liftTest*k is constant -- liftTest is a DECREASING function of
// liftTrain. When there is no persistent edge, whichever arm happens to win the train half is pushed
// BELOW the mean on the test half by that constraint, so the IS winner reverses OOS far more than half
// the time and PBO runs HIGH (toward ~0.8-1.0). That high value is the correct null signature: "the
// in-sample winner is a fluke that reverses out of sample." A ROBUST real edge (e.g. value-curve
// on/off, ~+11pp) keeps its IS winner ahead on BOTH halves and drives PBO toward 0. So interpret PBO
// RELATIVELY on this two-config engine: near 1 = pure overfit/null, near 0 = a real, transferable edge.
// (The A3.1 budget experiment pins the known-large references and will calibrate the ship threshold.)
// Ties on the train split carry no information and are excluded from the denominator.
let overfit = 0, decided = 0;
for (const p of paths) {
  if (p.liftTrain === 0) continue;                        // train tie: no IS winner
  decided++;
  const treatIsBestIS = p.liftTrain > 0;                  // treatment better in-sample?
  const treatIsBestOOS = p.liftTest > 0;                  // treatment better out-of-sample?
  if (treatIsBestIS !== treatIsBestOOS) overfit++;        // IS winner is the OOS loser -> overfit
}
const pbo = decided ? overfit / decided : NaN;

// ---- report -----------------------------------------------------------------------------------
console.log(`\n================ CPCV LIFT DISTRIBUTION (treatment - baseline) ================`);
console.log(`  ${BASE_LABEL}`);
console.log(`  vs ${TREAT_LABEL}`);
console.log(`  ${M} paths, k=${k} test seasons / ${Ntot - k} train seasons, path-seed ${PATH_SEED}`);
console.log(`  mean lift  ${meanLift >= 0 ? "+" : ""}${meanLift.toFixed(2)} pp`);
console.log(`  95% CI     [${ciLo.toFixed(2)}, ${ciHi.toFixed(2)}] pp   (path SD ${sdLift.toFixed(2)})`);
console.log(`  P(lift>0)  ${(100 * pGt0).toFixed(1)}%`);
console.log(`  PBO        ${(100 * pbo).toFixed(1)}%   (${overfit}/${decided} paths; IS winner underperforms OOS)`);

// ---- ledger append ----------------------------------------------------------------------------
const configHash = crypto.createHash("sha256").update(JSON.stringify({
  baseFlags: BASE_FLAGS, treatment: TREATMENT, seasons: SEASONS, n: N, artifactDir: ARTIFACT_DIR,
})).digest("hex").slice(0, 16);
// PHASE 4: the dependency fingerprint AT MEASUREMENT TIME. scripts/experiments-status.mjs recomputes it
// later and flags this experiment STALE if it moved. A dedicated readonly handle so the ledger append
// never depends on an open db from the arms above.
let depsHash = null, depsParts = null;
try {
  const { default: Database } = await import("better-sqlite3");
  const ddb = new Database("data/ff.db", { readonly: true });
  const fp = fingerprintDraftArbiter(ddb);
  depsHash = fp.hash; depsParts = fp.parts;
  ddb.close();
} catch (e) { console.log(`  (deps fingerprint skipped: ${e.message})`); }
const line = {
  timestamp: new Date().toISOString(),
  baseline_label: BASE_LABEL,
  treatment_label: TREAT_LABEL,
  config_hash: configHash,
  deps_hash: depsHash,
  deps_parts: depsParts,
  mean_lift: Number(meanLift.toFixed(4)),
  ci_lo: Number(ciLo.toFixed(4)),
  ci_hi: Number(ciHi.toFixed(4)),
  p_gt0: Number(pGt0.toFixed(4)),
  pbo: Number.isNaN(pbo) ? null : Number(pbo.toFixed(4)),
  n_paths: M,
  n_seasons: Ntot,
  k_test: k,
  full_set_baseline_pct: Number(fullA.toFixed(3)),
  full_set_treatment_pct: Number(fullB.toFixed(3)),
  seeds: { crn: "s+1+yr*1000", path_rng: PATH_SEED },
};
fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
fs.appendFileSync(LEDGER, JSON.stringify(line) + "\n", "utf8");
console.log(`\nledger += ${LEDGER}`);
console.log(JSON.stringify(line));

// one-line human summary
const verdict = ciLo > 0 ? "SHIP-candidate (CI clears 0)" : ciHi < 0 ? "REJECT (CI below 0)" : "NULL / undecided (CI straddles 0)";
console.log(`\nSUMMARY: ${TREAT_LABEL.replace(BASE_LABEL, "").trim() || TREATMENT}: ${meanLift >= 0 ? "+" : ""}${meanLift.toFixed(2)}pp titles ` +
  `[${ciLo.toFixed(1)}, ${ciHi.toFixed(1)}], P(>0)=${(100 * pGt0).toFixed(0)}%, PBO=${(100 * pbo).toFixed(0)}% -> ${verdict}`);
