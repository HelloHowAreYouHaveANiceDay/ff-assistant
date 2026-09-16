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
// PURGE/EMBARGO STATUS (v2, BUILT -- WS3). The leak-free per-fold projection artifacts
// (data/fold-artifacts-2b, each season scored by an artifact BLIND to itself) already purge the test
// season from its own training. The EMBARGO -- also excluding the season ADJACENT to a test season
// from that fold's training, because year-N and year-N-1 autocorrelate (career arcs, roster
// continuity) -- is now BUILDABLE via the trainer's `--embargo` flag (tools/train_projection.py) and
// evaluate.ts's `embargo` param. Because training is walk-forward (season < holdout), year N and N+1
// are already excluded as future; --embargo 1 additionally excludes N-1, so an embargoed fold is
// blind to {N-1, N, N+1}. Build the embargoed set once with:
//     npm run ff -- evaluate-projection --seasons <range> --embargo 1 --keep-artifacts data/fold-artifacts-2b-embargo
// then point THIS tool at it with --artifact-dir data/fold-artifacts-2b-embargo (effective only when
// BASE_FLAGS selects the projection artifact). CPCV path construction below is still purely a
// re-partition of already-computed outcomes, so the embargo lives in the ARTIFACTS it consumes, not
// in the path sampling. NOTE: the full 18-fold embargoed regen + a cpcv run on it is the WS6/
// acceptance step; the mechanism is built and unit-/one-fold-tested here, the full regen is heavy.
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
import { parseHoldout, splitSeasons, assertSelectionBlind } from "./lib/holdout.mjs";
import { loadGolden, NoGoldenError } from "./lib/golden.mjs";

// ---- args -------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const BASE_FLAGS = val("--base-flags", "--full --no-lookahead --inflation"); // the shipped flagless arbiter config. GOLDEN MASTER on the PRIMARY axis = 96.0% PLAYOFF (title% ~38.5% is context, D13); BOTH title-edges DEMOTED (consensusBlend=0 D14, benchDiscount=0.25 D15), so the shipped flagless config IS the pre-edge base. Pass --consensus-blend 1 --bench-discount 0.35 --golden 97.0 --golden-title 42.3 to reproduce the old title-tuned posture.
const TREATMENT = val("--treatment", "--no-rookies");                        // the flag(s) to ADD for the treatment arm
const SEASONS = val("--seasons", "1999-2024");
const N = val("--n", "150");
const ARTIFACT_DIR = val("--artifact-dir", "data/fold-artifacts-2b"); // no-op unless --projection artifact / --market ecr is in BASE_FLAGS; passed through per spec
const K = val("--k", null);                       // test-group size; default floor(N/2)
const N_PATHS = Number(val("--paths", "200"));
const PATH_SEED = Number(val("--path-seed", "12345"));
const LEDGER = val("--ledger", "data/experiments.jsonl");
const GOLDEN = Number(val("--golden", "96.0"));   // PRIMARY-axis consistency target = shipped-config PLAYOFF% golden master (D13). 96.0% source: ledger config_hash e625249e (benchDiscount 0.25, consensusBlend 0) full_set_baseline_playoff_pct 96.107. Both title-edges demoted (D14/D15) so this pre-edge base IS the shipped posture. Pass --golden 97.0 (with --consensus-blend 1 --bench-discount 0.35) to check the old title-tuned config.
const GOLDEN_TOL = Number(val("--golden-tol", "3.0")); // +/- pp of Monte-Carlo slack
const GOLDEN_TITLE = Number(val("--golden-title", "38.5")); // SECONDARY/context only -- NOT a gate (title% is the no-skill axis, P16 FAILED). Printed for reference. 38.5% = shipped pre-edge base (ledger e625249e full_set_baseline_pct 38.48); old title-tuned posture was 42.3.
// SELECTION-BLIND HOLDOUT (WS2). A lever/config search must not TUNE on the holdout block: the effect
// that drives the verdict is computed on the SELECTION seasons only, and the holdout is reported once
// as a separate CONFIRM. Locked to the canonical HOLDOUT_SEASONS unless overridden with
// --holdout-seasons (e.g. 2021-2025). CONVENTION: this splits the SELECTION metric (the season-paired
// effect + PBO that produce the verdict) into selection-vs-holdout; the golden-master CONSISTENCY
// check below stays on the FULL set on purpose -- it is a reproducibility check that the dump matches
// the point backtest, NOT a selection decision, so it is not something a search can tune against.
const HOLDOUT = parseHoldout(val("--holdout-seasons", null));
const OUT_DIR = val("--out-dir", "data/trials");
const BASE_LABEL = val("--baseline-label", `shipped[${BASE_FLAGS}]`);
const TREAT_LABEL = val("--treatment-label", `shipped[${BASE_FLAGS}] ${TREATMENT}`);

let baseDump = val("--baseline-dump", null);
let treatDump = val("--treatment-dump", null);

// ---- WHICH FORMAT IS BEING GATED (F-9, WP7) ---------------------------------------------------
// With no `--league` this is EXACTLY what it always was: the incumbent, `--golden 96.0` /
// `--golden-title 38.5` as parsed above, no store opened, no format key on the ledger row. With
// `--league <id>` the league's format is resolved, `--league` is passed down to the child backtest so
// both arms read that format's target, and the gate numbers come from that format's own golden.json --
// or the run REFUSES BY NAME rather than holding another format's backtest against 96.0%.
const LEAGUE = val("--league", null);
// An EXPLICIT flag always wins over a file -- that is what `--golden 97.0` exists for (the old
// title-tuned posture), and a pinned file must not silently override a deliberate override.
const GOLDEN_FLAGGED = val("--golden", null) != null;
const GOLDEN_TITLE_FLAGGED = val("--golden-title", null) != null;
const GOLDEN_TOL_FLAGGED = val("--golden-tol", null) != null;
let FORMAT_KEY;
let GOLDEN_EFF = GOLDEN, GOLDEN_TITLE_EFF = GOLDEN_TITLE, GOLDEN_TOL_EFF = GOLDEN_TOL, GOLDEN_SRC = "cpcv.mjs defaults (the incumbent's pinned D15 numbers)";
{
  const { INCUMBENT_MODEL, INCUMBENT_SCORING_KEY, resolveFormat } = await import("../src/data/formatResolve.ts").then(async (m) => ({
    ...m, INCUMBENT_SCORING_KEY: (await import("../src/data/formatKey.ts")).INCUMBENT_SCORING_KEY,
  }));
  // NO `--league` MEANS THE INCUMBENT, EXPLICITLY -- not "whichever league is active". Resolving the
  // active league here would stamp the ledger row with a second league's format key for a run whose
  // child backtest read the incumbent's target, which is precisely the mislabelling this stamp exists
  // to prevent.
  let fmt;
  if (LEAGUE == null) {
    fmt = { model: INCUMBENT_MODEL, scoringKey: INCUMBENT_SCORING_KEY, formatKey: null, spec: { draftType: "auction" } };
  } else {
    const { default: Database } = await import("better-sqlite3");
    const gdb = new Database("data/ff.db", { readonly: true });
    try { fmt = resolveFormat(gdb, LEAGUE); } finally { gdb.close(); }
  }
  FORMAT_KEY = fmt.formatKey;
  let g = null;
  try {
    g = loadGolden(fmt.model, fmt.scoringKey);
  } catch (e) {
    if (e instanceof NoGoldenError) {
      // A NAMED REFUSAL, not a fallback. Only for a league that was ASKED for: with no `--league` and
      // no data/golden.json this keeps the historical defaults, so an older checkout still runs.
      if (LEAGUE != null) {
        console.log(`\nREFUSED: ${e.message}`);
        console.log(`\n  league ${LEAGUE} -> scoring ${fmt.scoringKey}, format ${fmt.formatKey}, draft ${fmt.spec.draftType}.`);
        console.log("  Nothing was run and nothing was appended to the ledger.");
        process.exit(2);
      }
      console.log(`  (no golden file for the incumbent; using cpcv.mjs's pinned defaults ${GOLDEN}/${GOLDEN_TITLE})`);
    } else throw e;
  }
  if (g) {
    if (!GOLDEN_FLAGGED) GOLDEN_EFF = g.playoffPct;
    if (!GOLDEN_TITLE_FLAGGED && g.titlePct != null) GOLDEN_TITLE_EFF = g.titlePct;
    if (!GOLDEN_TOL_FLAGGED) GOLDEN_TOL_EFF = g.tolerancePp;
    GOLDEN_SRC = g.path + (GOLDEN_FLAGGED ? " (overridden by --golden)" : "");
  }
  console.log(`format gate: ${LEAGUE != null ? `league ${LEAGUE}` : "no --league (THE INCUMBENT)"} -> scoring ${fmt.scoringKey}, format ${fmt.formatKey ?? "(not resolved -- no league named)"}; ` +
    `golden ${GOLDEN_EFF}% playoffs (+/-${GOLDEN_TOL_EFF}pp) from ${GOLDEN_SRC}`);
}

// ---- run the two arms (unless dumps are supplied) ---------------------------------------------
function runArm(extraFlags, dumpPath) {
  // `--league` is passed DOWN, not just used up here: the child backtest must read the same format's
  // history/points as the golden it is being checked against, or the gate compares two different models.
  const leagueFlag = LEAGUE != null ? ` --league ${LEAGUE}` : "";
  const cmd = `npm run -s ff -- backtest ${BASE_FLAGS} ${extraFlags} --seasons ${SEASONS} --n ${N} --artifact-dir ${ARTIFACT_DIR}${leagueFlag} --dump-trials ${dumpPath}`;
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
// PRIMARY GATE = PLAYOFF% (D13). The season sim has MEASURED skill on the playoff berth (Brier 0.2370
// vs uniform 0.2451) and ~NONE on the champion (title Brier 0.0659 vs uniform 0.0652 -- P16 FAILED,
// docs/validation.md). So the ship/no-ship golden-master consistency check keys on the PLAYOFF column;
// title% is reproduced and printed as SECONDARY/context only, never gated.
const consistencyOK = Math.abs(fullAp - GOLDEN_EFF) <= GOLDEN_TOL_EFF;
const titleConsistent = Math.abs(fullA - GOLDEN_TITLE_EFF) <= GOLDEN_TOL_EFF;
console.log(`\n================ CONSISTENCY CHECK (PRIMARY GATE = playoff%) ================`);
console.log(`  baseline full-set PLAYOFF%: ${fullAp.toFixed(2)}%  (golden master ${GOLDEN_EFF}% +/- ${GOLDEN_TOL_EFF}pp, from ${GOLDEN_SRC})  -> ${consistencyOK ? "PASS" : "FAIL"}  <- GATE (D13)`);
console.log(`  treatment full-set PLAYOFF%: ${fullBp.toFixed(2)}%   point delta ${(fullBp - fullAp >= 0 ? "+" : "")}${(fullBp - fullAp).toFixed(2)}pp (untrustworthy alone -- see distribution below)`);
console.log(`  baseline / treatment title% (SECONDARY/context, NOT gated): ${fullA.toFixed(2)}% / ${fullB.toFixed(2)}%   point delta ${(fullB - fullA >= 0 ? "+" : "")}${(fullB - fullA).toFixed(2)}pp   (title golden ~${GOLDEN_TITLE_EFF}% -> ${titleConsistent ? "consistent" : "MOVED"}; informational, no gate)`);
console.log(`  ${Ntot} seasons, ${poolN / Ntot} trials/season, ${poolN} paired trials`);
if (!consistencyOK) {
  console.log(`\n  CONSISTENCY CHECK FAILED -- the dump aggregation does not reproduce the point backtest on the PRIMARY (playoff) axis.`);
  console.log(`  Fix this before trusting any distribution below. Aborting.`);
  process.exit(1);
}

// ---- CPCV paths (shared core: scripts/lib/arbiter.mjs) ----------------------------------------
// Sample the season subsets ONCE (deterministic, path-seed); each metric's OOS/IS lifts are computed on
// the SAME subsets below. Each path holds out k seasons (TEST) vs the complement (TRAIN).
// SELECTION-BLIND SPLIT (WS2). The verdict-driving effect + PBO are computed on the SELECTION seasons
// only; the CPCV paths are re-partitions of the SELECTION seasons, so a config search can never tune
// on the holdout. The holdout seasons are scored separately below as a one-shot CONFIRM.
const { selection: selSeasonsArr, holdout: cfSeasonsArr } = splitSeasons(seasonsArr, HOLDOUT);
assertSelectionBlind(selSeasonsArr, HOLDOUT);
const Nsel = selSeasonsArr.length;
if (Nsel < 3) { console.log(`\nonly ${Nsel} SELECTION seasons after removing the holdout ${HOLDOUT.join(",")} -- cannot form CPCV paths. Aborting.`); process.exit(1); }
const k = K != null ? Number(K) : Math.floor(Nsel / 2);
const subsets = cpcvSubsets(Nsel, { k, nPaths: N_PATHS, pathSeed: PATH_SEED });
const M = subsets.length;

// TWO INSTRUMENTS, TWO QUESTIONS, from the shared core. We TARGET CHAMPIONSHIPS, but the engine
// determined the playoff berth is the LEARNABLE proximate target, so the EFFECT is READ on playoffs with
// the title alongside. seasonEffect = the season-paired bootstrap (effect + CI + power floor, the
// thin-edge instrument); pboOf = overfitting robustness (does the IS winner transfer OOS -- distinct from
// the CI). Both defined once in lib/arbiter.mjs so the in-season arbiter cannot diverge.
const poE = seasonEffect(rateBp, rateAp, selSeasonsArr, { pathSeed: PATH_SEED }), poR = pboOf(pathLifts(subsets, rateAp, rateBp, selSeasonsArr));  // PLAYOFFS (target), SELECTION seasons
const chE = seasonEffect(rateB, rateA, selSeasonsArr, { pathSeed: PATH_SEED }),   chR = pboOf(pathLifts(subsets, rateA, rateB, selSeasonsArr));      // championships (goal), SELECTION seasons
// CONFIRM on the held-out block: the honest, once-quoted number the search never tuned on. Underpowered
// by construction (few seasons); reported for transparency, never gated.
const poCf = cfSeasonsArr.length >= 2 ? seasonEffect(rateBp, rateAp, cfSeasonsArr, { pathSeed: PATH_SEED }) : null;

// ---- report ---------------------------------------------------------------------------------------
const fmt = (E, R) => `${E.effect >= 0 ? "+" : ""}${E.effect.toFixed(2)}pp  95% CI [${E.ciLo.toFixed(2)}, ${E.ciHi.toFixed(2)}]  t ${E.t.toFixed(2)}  ${E.wins}/${E.nSeasons} seasons up  PBO ${(100 * R.pbo).toFixed(0)}%   (resolvable >= ~${E.detectable.toFixed(2)}pp)`;
console.log(`\n================ EFFECT (season-paired bootstrap) + PBO (CPCV robustness) ================`);
console.log(`  ${BASE_LABEL}`);
console.log(`  vs ${TREAT_LABEL}`);
console.log(`  SELECTION-BLIND (WS2): decision on ${selSeasonsArr[0]}-${selSeasonsArr[selSeasonsArr.length - 1]} (${Nsel} seasons); holdout ${HOLDOUT.join(",")} confirmed separately below.`);
console.log(`  ${M} CPCV paths, k=${k}/${Nsel} selection seasons, path-seed ${PATH_SEED}; effect over ${poE.nSeasons} seasons, ${poolN / Ntot} trials/season`);
console.log(`  PLAYOFFS (PRIMARY GATE, D13):  ${fmt(poE, poR)}`);
console.log(`  titles (SECONDARY/context):   ${fmt(chE, chR)}`);
if (poCf) {
  console.log(`  PLAYOFFS CONFIRM on holdout ${cfSeasonsArr[0]}-${cfSeasonsArr[cfSeasonsArr.length - 1]} (${poCf.nSeasons} seasons, once, NOT gated): ` +
    `${poCf.effect >= 0 ? "+" : ""}${poCf.effect.toFixed(2)}pp  95% CI [${poCf.ciLo.toFixed(2)}, ${poCf.ciHi.toFixed(2)}]  ${poCf.wins}/${poCf.nSeasons} up`);
} else {
  console.log(`  PLAYOFFS CONFIRM: ${cfSeasonsArr.length} holdout season(s) in range -- too few to quote a confirm.`);
}

// ---- ledger append --------------------------------------------------------------------------------
const configHash = crypto.createHash("sha256").update(JSON.stringify({
  baseFlags: BASE_FLAGS, treatment: TREATMENT, seasons: SEASONS, n: N, artifactDir: ARTIFACT_DIR,
  ...(LEAGUE != null ? { league: LEAGUE, formatKey: FORMAT_KEY } : {}),
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
  // WHICH FORMAT THIS ROW MEASURED (F-9). Null for a flagless run = the incumbent, which is what every
  // historical row is; a `--league` run stamps the format key so two formats' rows cannot be compared
  // by accident.
  league: LEAGUE,
  format_key: FORMAT_KEY,
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
  // WS2 selection-blind split: the effect above is the SELECTION-season decision; the holdout is the
  // once-quoted confirm the search never tuned on.
  holdout_seasons: HOLDOUT,
  selection_seasons: Nsel,
  playoff_confirm_effect: poCf ? Number(poCf.effect.toFixed(4)) : null,
  playoff_confirm_ci_lo: poCf ? Number(poCf.ciLo.toFixed(4)) : null,
  playoff_confirm_ci_hi: poCf ? Number(poCf.ciHi.toFixed(4)) : null,
  playoff_confirm_seasons: poCf ? poCf.nSeasons : cfSeasonsArr.length,
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

// one-line human summary -- PLAYOFFS is the PRIMARY GATE for the verdict (D13, the axis with measured
// skill); title is SECONDARY/context (the goal we cannot reliably predict, P16 FAILED). A verdict needs
// the CI to clear 0 AND the effect to be transferable (PBO not high). "underpowered" distinguishes a
// true ~0 from an effect below what this many seasons can resolve.
const verdict = (E, R) => {
  if (E.ciLo > 0) return R.pbo <= 0.4 ? "REAL (CI clears 0, PBO low)" : "CI clears 0 but PBO HIGH -- not transferable";
  if (E.ciHi < 0) return "REJECT (CI below 0)";
  return Math.abs(E.effect) < E.detectable ? "NULL / UNDERPOWERED (|effect| below resolution)" : "NULL (CI straddles 0)";
};
const shortLabel = TREAT_LABEL.replace(BASE_LABEL, "").trim() || TREATMENT;
console.log(`\nSUMMARY: ${shortLabel}`);
console.log(`  PLAYOFFS (GATE) ${poE.effect >= 0 ? "+" : ""}${poE.effect.toFixed(2)}pp [${poE.ciLo.toFixed(2)}, ${poE.ciHi.toFixed(2)}] PBO ${(100 * poR.pbo).toFixed(0)}% (res ~${poE.detectable.toFixed(2)}pp) -> ${verdict(poE, poR)}`);
console.log(`  titles (context) ${chE.effect >= 0 ? "+" : ""}${chE.effect.toFixed(2)}pp [${chE.ciLo.toFixed(2)}, ${chE.ciHi.toFixed(2)}] PBO ${(100 * chR.pbo).toFixed(0)}% (res ~${chE.detectable.toFixed(2)}pp) -> ${verdict(chE, chR)}`);
