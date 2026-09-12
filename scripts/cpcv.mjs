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
import { loadDump, sharedSeeds, perSeasonRates, cpcvSubsets, pathLifts, seasonEffect, pboOf } from "./lib/arbiter.mjs";

// ---- args -------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const BASE_FLAGS = val("--base-flags", "--full --no-lookahead --inflation"); // the shipped flagless arbiter config (golden master = 42.3%, consensus blend ON by default; --consensus-blend 0 + --bench-discount 0.25 for the pre-edge base)
const TREATMENT = val("--treatment", "--no-rookies");                        // the flag(s) to ADD for the treatment arm
const SEASONS = val("--seasons", "1999-2024");
const N = val("--n", "150");
const ARTIFACT_DIR = val("--artifact-dir", "data/fold-artifacts-2b"); // no-op unless --projection artifact / --market ecr is in BASE_FLAGS; passed through per spec
const K = val("--k", null);                       // test-group size; default floor(N/2)
const N_PATHS = Number(val("--paths", "200"));
const PATH_SEED = Number(val("--path-seed", "12345"));
const LEDGER = val("--ledger", "data/experiments.jsonl");
const GOLDEN = Number(val("--golden", "42.3"));   // consistency-check target (shipped-config golden master, consensus blend ON; pass --golden 38.5 when BASE_FLAGS pins --consensus-blend 0)
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

// ---- load + pair (shared arbiter core: scripts/lib/arbiter.mjs) --------------------------------
const A = loadDump(baseDump), B = loadDump(treatDump);
const seeds = sharedSeeds(A, B);
if (seeds.length !== A.size || seeds.length !== B.size) {
  console.log(`\nWARNING: seed sets differ (baseline ${A.size}, treatment ${B.size}, shared ${seeds.length}).`);
  console.log(`The arms are then NOT CRN-paired and every number below is invalid -- re-run both with`);
  console.log(`the same --seasons and --n.`);
}

// ---- per-season rates for each metric (equal-season weighting = this repo's unit of analysis) ----
// PLAYOFFS is PRIMARY -- the season sim has measured skill on the playoff berth and ~none on the champion
// (single-elim coin flip; docs/edges.md objective note); the title is reported alongside as the goal.
const chA = perSeasonRates(A, seeds, "champ"), chB = perSeasonRates(B, seeds, "champ");
const poA = perSeasonRates(A, seeds, "playoffs"), poB = perSeasonRates(B, seeds, "playoffs");
const seasonsArr = chA.seasonsArr;
const Ntot = seasonsArr.length;
const rateA = chA.rate, rateB = chB.rate, rateAp = poA.rate, rateBp = poB.rate;

// ---- CONSISTENCY CHECK: baseline full-set title% must reproduce the point backtest. Pooled == equal-
// season mean when n/season is constant. If the dump aggregation is wrong, this misses the golden number.
const poolN = chA.poolN;
const fullA = 100 * chA.full, fullB = 100 * chB.full;
const fullAp = 100 * poA.full, fullBp = 100 * poB.full;
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

// ---- CPCV paths (shared core: scripts/lib/arbiter.mjs) ----------------------------------------
// Sample the season subsets ONCE (deterministic, path-seed); each metric's OOS/IS lifts are computed on
// the SAME subsets below. Each path holds out k seasons (TEST) vs the complement (TRAIN).
const k = K != null ? Number(K) : Math.floor(Ntot / 2);
const subsets = cpcvSubsets(Ntot, { k, nPaths: N_PATHS, pathSeed: PATH_SEED });
const M = subsets.length;

// TWO INSTRUMENTS, TWO QUESTIONS, from the shared core. We TARGET CHAMPIONSHIPS, but the engine
// determined the playoff berth is the LEARNABLE proximate target, so the EFFECT is READ on playoffs with
// the title alongside. seasonEffect = the season-paired bootstrap (effect + CI + power floor, the
// thin-edge instrument); pboOf = overfitting robustness (does the IS winner transfer OOS -- distinct from
// the CI). Both defined once in lib/arbiter.mjs so the in-season arbiter cannot diverge.
const poE = seasonEffect(rateBp, rateAp, seasonsArr, { pathSeed: PATH_SEED }), poR = pboOf(pathLifts(subsets, rateAp, rateBp, seasonsArr));  // PLAYOFFS (target)
const chE = seasonEffect(rateB, rateA, seasonsArr, { pathSeed: PATH_SEED }),   chR = pboOf(pathLifts(subsets, rateA, rateB, seasonsArr));      // championships (goal)

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
