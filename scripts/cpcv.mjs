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

const BASE_FLAGS = val("--base-flags", "--full --no-lookahead --inflation"); // the shipped flagless arbiter config (golden master = 41.3%, consensus blend ON by default; --consensus-blend 0 for the ~38.5% pre-edge base)
const TREATMENT = val("--treatment", "--no-rookies");                        // the flag(s) to ADD for the treatment arm
const SEASONS = val("--seasons", "1999-2024");
const N = val("--n", "150");
const ARTIFACT_DIR = val("--artifact-dir", "data/fold-artifacts-2b"); // no-op unless --projection artifact / --market ecr is in BASE_FLAGS; passed through per spec
const K = val("--k", null);                       // test-group size; default floor(N/2)
const N_PATHS = Number(val("--paths", "200"));
const PATH_SEED = Number(val("--path-seed", "12345"));
const LEDGER = val("--ledger", "data/experiments.jsonl");
const GOLDEN = Number(val("--golden", "41.3"));   // consistency-check target (shipped-config golden master, consensus blend ON; pass --golden 38.5 when BASE_FLAGS pins --consensus-blend 0)
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

// ---- per-season rates for each arm (equal-season weighting = this repo's unit of analysis) ----
// BOTH objectives. PLAYOFFS is PRIMARY -- the season sim has measured skill on the playoff berth and
// ~none on the champion (single-elim among seven is a coin flip; docs/edges.md "objective note"), so a
// lever or an edge is graded on the seed it can actually move, with the title reported alongside.
const bySeason = new Map(); // yr -> {aC,bC,aP,bP,n}
for (const s of seeds) {
  const yr = A.get(s).season;
  if (!bySeason.has(yr)) bySeason.set(yr, { aC: 0, bC: 0, aP: 0, bP: 0, n: 0 });
  const e = bySeason.get(yr);
  e.aC += A.get(s).champ; e.bC += B.get(s).champ;
  e.aP += A.get(s).playoffs; e.bP += B.get(s).playoffs; e.n++;
}
const seasonsArr = [...bySeason.keys()].sort((x, y) => x - y);
const Ntot = seasonsArr.length;
const rateA = new Map(seasonsArr.map((y) => [y, bySeason.get(y).aC / bySeason.get(y).n]));   // champ
const rateB = new Map(seasonsArr.map((y) => [y, bySeason.get(y).bC / bySeason.get(y).n]));
const rateAp = new Map(seasonsArr.map((y) => [y, bySeason.get(y).aP / bySeason.get(y).n]));   // playoffs
const rateBp = new Map(seasonsArr.map((y) => [y, bySeason.get(y).bP / bySeason.get(y).n]));

// ---- CONSISTENCY CHECK: baseline full-set title% must reproduce the point backtest (golden 38.5%) ----
// Pooled over all trials == equal-season mean when n/season is constant, which it is here. This is the
// correctness proof: if the dump-reading/aggregation is wrong, this misses the golden number.
let poolAc = 0, poolBc = 0, poolAp = 0, poolBp = 0, poolN = 0;
for (const s of seeds) { poolAc += A.get(s).champ; poolBc += B.get(s).champ; poolAp += A.get(s).playoffs; poolBp += B.get(s).playoffs; poolN++; }
const fullA = 100 * poolAc / poolN, fullB = 100 * poolBc / poolN;
const fullAp = 100 * poolAp / poolN, fullBp = 100 * poolBp / poolN;
const consistencyOK = Math.abs(fullA - GOLDEN) <= GOLDEN_TOL;
console.log(`\n================ CONSISTENCY CHECK ================`);
console.log(`  baseline full-set title%%: ${fullA.toFixed(2)}%  (golden master ${GOLDEN}% +/- ${GOLDEN_TOL}pp)  -> ${consistencyOK ? "PASS" : "FAIL"}`);
console.log(`  treatment full-set title%: ${fullB.toFixed(2)}%   point delta ${(fullB - fullA >= 0 ? "+" : "")}${(fullB - fullA).toFixed(2)}pp (untrustworthy alone -- see distribution below)`);
console.log(`  baseline / treatment PLAYOFF%: ${fullAp.toFixed(2)}% / ${fullBp.toFixed(2)}%   point delta ${(fullBp - fullAp >= 0 ? "+" : "")}${(fullBp - fullAp).toFixed(2)}pp  <- PRIMARY`);
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
  paths.push({
    // PLAYOFFS (primary) and CHAMP (secondary), each: OOS lift (test group, the honest metric) and IS
    // lift (train group, used only for PBO).
    poTest: 100 * (meanRate(rateBp, test) - meanRate(rateAp, test)),
    poTrain: 100 * (meanRate(rateBp, train) - meanRate(rateAp, train)),
    chTest: 100 * (meanRate(rateB, test) - meanRate(rateA, test)),
    chTrain: 100 * (meanRate(rateB, train) - meanRate(rateA, train)),
  });
}
const M = paths.length;

// ---- TWO INSTRUMENTS, TWO QUESTIONS. We TARGET CHAMPIONSHIPS, but the engine determined the playoff
// berth is the LEARNABLE proximate target (P(title)=P(playoffs)*P(title|playoffs); the sim has skill on
// the seed, ~none on the single-elim coin flip). So the effect is READ on playoffs, the title reported
// alongside as the goal.
const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;

// (1) EFFECT + CI: the SEASON-LEVEL PAIRED BOOTSTRAP. This is the confidence interval on the effect, and
// the right instrument for a THIN edge. The season is the unit of generalisation (a new year is a new
// draw), CRN makes every trial a matched pair, so the per-season lift (treatment-baseline over the
// shared seeds) is the quantity; the bootstrap resamples SEASONS. It also reports the ~smallest effect
// resolvable at 80% power (2.9*SE) so a null can be read as "truly ~0" vs "below our resolution". This
// matches scripts/paired-analysis.mjs. NOTE: the CPCV path spread is NOT used as the CI -- the paths are
// overlapping subsets and their quantiles do not estimate the SE of the full-sample mean.
function seasonEffect(rateT, rateBase) {
  const diffs = seasonsArr.map((y) => 100 * (rateT.get(y) - rateBase.get(y)));  // per-season lift, pp
  const md = mean(diffs);
  const sd = Math.sqrt(diffs.reduce((s, v) => s + (v - md) ** 2, 0) / (diffs.length - 1));
  const se = sd / Math.sqrt(diffs.length);
  let rng = (PATH_SEED ^ 0x9e3779b9) >>> 0;
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
// (2) OVERFITTING ROBUSTNESS: CPCV PBO (two-config CSCV, Lopez de Prado). For each path pick the IS-BEST
// config (higher train lift), then ask whether it is WORSE out of sample. PBO = fraction of paths where
// the IS winner underperforms OOS. Distinct from the CI: it asks "does the winner TRANSFER across which
// seasons you look at", the guard a thin few-season artifact fails even when its mean CI clears 0.
// WHY a null runs HIGH (~0.8-1.0), not 0.5: with two configs on COMPLEMENTARY splits, liftTrain*(N-k) +
// liftTest*k is fixed, so liftTest DECREASES in liftTrain -- the train winner is pushed below the test
// mean, reversing OOS more than half the time. A robust edge keeps its winner ahead on both halves ->
// PBO toward 0. Read RELATIVELY: near 1 = overfit/null, near 0 = real, transferable.
function pboOf(getTest, getTrain) {
  let overfit = 0, decided = 0;
  for (const p of paths) { const tr = getTrain(p); if (tr === 0) continue; decided++; if ((tr > 0) !== (getTest(p) > 0)) overfit++; }
  return { pbo: decided ? overfit / decided : NaN, overfit, decided };
}
const poE = seasonEffect(rateBp, rateAp), poR = pboOf((p) => p.poTest, (p) => p.poTrain);  // PLAYOFFS (target)
const chE = seasonEffect(rateB, rateA),   chR = pboOf((p) => p.chTest, (p) => p.chTrain);  // championships (goal)

// ---- report ---------------------------------------------------------------------------------------
const fmt = (E, R) => `${E.effect >= 0 ? "+" : ""}${E.effect.toFixed(2)}pp  95% CI [${E.ciLo.toFixed(2)}, ${E.ciHi.toFixed(2)}]  t ${E.t.toFixed(2)}  ${E.wins}/${E.nSeasons} seasons up  PBO ${(100 * R.pbo).toFixed(0)}%   (resolvable >= ~${E.detectable.toFixed(2)}pp)`;
console.log(`\n================ EFFECT (season-paired bootstrap) + PBO (CPCV robustness) ================`);
console.log(`  ${BASE_LABEL}`);
console.log(`  vs ${TREAT_LABEL}`);
console.log(`  ${M} CPCV paths, k=${k}/${Ntot} seasons, path-seed ${PATH_SEED}; effect over ${poE.nSeasons} seasons, ${poolN / Ntot} trials/season`);
console.log(`  PLAYOFFS (proximate target):  ${fmt(poE, poR)}`);
console.log(`  championships (the GOAL):     ${fmt(chE, chR)}`);

// ---- ledger append --------------------------------------------------------------------------------
const configHash = crypto.createHash("sha256").update(JSON.stringify({
  baseFlags: BASE_FLAGS, treatment: TREATMENT, seasons: SEASONS, n: N, artifactDir: ARTIFACT_DIR,
})).digest("hex").slice(0, 16);
// PHASE 4: the dependency fingerprint AT MEASUREMENT TIME. scripts/experiments-status.mjs recomputes it
// later and flags this experiment STALE if it moved. `spec` records the exact command so
// `experiments-status --rerun-stale` can reconstruct and re-run this experiment. A dedicated readonly
// handle so the ledger append never depends on an open db from the arms above.
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
  spec: { base_flags: BASE_FLAGS, treatment: TREATMENT, seasons: SEASONS, n: N, artifact_dir: ARTIFACT_DIR },
  primary: "playoffs",
  // PLAYOFFS -- the proximate target. effect + season-bootstrap CI is the thin-edge instrument; PBO is
  // the overfitting-robustness guard; detectable = ~smallest effect resolvable at 80% power.
  playoff_effect: Number(poE.effect.toFixed(4)),
  playoff_ci_lo: Number(poE.ciLo.toFixed(4)),
  playoff_ci_hi: Number(poE.ciHi.toFixed(4)),
  playoff_se: Number(poE.se.toFixed(4)),
  playoff_t: Number(poE.t.toFixed(3)),
  playoff_seasons_up: poE.wins,
  playoff_detectable: Number(poE.detectable.toFixed(4)),
  playoff_pbo: Number.isNaN(poR.pbo) ? null : Number(poR.pbo.toFixed(4)),
  // CHAMPIONSHIPS -- the goal (single-elim lottery). `mean_lift`/`ci_lo`/`ci_hi`/`pbo` keep their legacy
  // names (championship) so older ledger readers still parse; they are now the SEASON-BOOTSTRAP effect,
  // not the old path-quantile.
  mean_lift: Number(chE.effect.toFixed(4)),
  ci_lo: Number(chE.ciLo.toFixed(4)),
  ci_hi: Number(chE.ciHi.toFixed(4)),
  champ_se: Number(chE.se.toFixed(4)),
  champ_t: Number(chE.t.toFixed(3)),
  champ_detectable: Number(chE.detectable.toFixed(4)),
  pbo: Number.isNaN(chR.pbo) ? null : Number(chR.pbo.toFixed(4)),
  n_paths: M,
  n_seasons: Ntot,
  k_test: k,
  full_set_baseline_pct: Number(fullA.toFixed(3)),
  full_set_treatment_pct: Number(fullB.toFixed(3)),
  full_set_baseline_playoff_pct: Number(fullAp.toFixed(3)),
  full_set_treatment_playoff_pct: Number(fullBp.toFixed(3)),
  seeds: { crn: "s+1+yr*1000", path_rng: PATH_SEED },
};
fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
fs.appendFileSync(LEDGER, JSON.stringify(line) + "\n", "utf8");
console.log(`\nledger += ${LEDGER}`);
console.log(JSON.stringify(line));

// one-line human summary -- PLAYOFFS is the proximate target read for the verdict, title the goal.
// A verdict needs the CI to clear 0 AND the effect to be transferable (PBO not high). "underpowered"
// distinguishes a true ~0 from an effect below what this many seasons can resolve.
const verdict = (E, R) => {
  if (E.ciLo > 0) return R.pbo <= 0.4 ? "REAL (CI clears 0, PBO low)" : "CI clears 0 but PBO HIGH -- not transferable";
  if (E.ciHi < 0) return "REJECT (CI below 0)";
  return Math.abs(E.effect) < E.detectable ? "NULL / UNDERPOWERED (|effect| below resolution)" : "NULL (CI straddles 0)";
};
const shortLabel = TREAT_LABEL.replace(BASE_LABEL, "").trim() || TREATMENT;
console.log(`\nSUMMARY: ${shortLabel}`);
console.log(`  PLAYOFFS ${poE.effect >= 0 ? "+" : ""}${poE.effect.toFixed(2)}pp [${poE.ciLo.toFixed(2)}, ${poE.ciHi.toFixed(2)}] PBO ${(100 * poR.pbo).toFixed(0)}% (res ~${poE.detectable.toFixed(2)}pp) -> ${verdict(poE, poR)}`);
console.log(`  titles   ${chE.effect >= 0 ? "+" : ""}${chE.effect.toFixed(2)}pp [${chE.ciLo.toFixed(2)}, ${chE.ciHi.toFixed(2)}] PBO ${(100 * chR.pbo).toFixed(0)}% (res ~${chE.detectable.toFixed(2)}pp) -> ${verdict(chE, chR)}`);
