// TRAINER-VARIANT GATE: the WS1 effect-size floor applied to a change in HOW the trainer fits, not in
// WHICH column it fits.
//
// scripts/admit-feature.mjs answers "does adding column X clear 2.9*SE?". The rungs of the
// pre-deep-learning ladder below the feature queue are not columns: sample-size shrinkage of the
// usage ratios, partial pooling of coefficients across positions, a spline or interaction basis, a
// different learner. Each is a trainer FLAG, and each needs exactly the same paired-season verdict
// the feature gate gives -- two nested-CV runs over the same folds, per-season trained pinball,
// improvement = base - cand, ADMIT only above 2.9*SE on the SELECTION seasons, holdout quoted once.
//
//   node --import tsx scripts/gate-variant.mjs --cand "--shrink-k 4" [--base "<args>"] [--seasons 2008-2025]
//
// `--base` defaults to no extra args (the shipped fit). Both arms may also carry --add-features via
// FF_ADD_FEATURES, so a variant can be gated on top of an admitted column. The trainer args reach the
// subprocess through evaluateProjection's `trainerArgs` option, which the report header echoes so a run
// cannot quietly be a different model from the one the reader thinks they are looking at.
import { evaluateProjection, score } from "../src/model/evaluate.ts";
import { admissionVerdict } from "./lib/arbiter.mjs";
import { parseHoldout, splitSeasons, assertSelectionBlind } from "./lib/holdout.mjs";

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const candArgs = val("--cand", null);
if (candArgs == null) { console.error('usage: node --import tsx scripts/gate-variant.mjs --cand "<trainer args>" [--base "<trainer args>"] [--cand-rung challenger] [--pos QB] [--seasons 2008-2025]'); process.exit(1); }
const baseArgs = val("--base", "");
const split = (s) => s.trim() ? s.trim().split(/\s+/) : [];
const range = val("--seasons", "2008-2025").split("-").map(Number);
const seasons = []; for (let y = range[0]; y <= (range[1] ?? range[0]); y++) seasons.push(y);
const dbPath = val("--db", undefined);
// --pos scores one position's rows only (a variant that touches one position's fit is diluted
// ~4x when scored pooled). Default pooled: the shipped model is one artifact, scored as one.
const pos = val("--pos", null);
const holdout = parseHoldout(val("--holdout-seasons", null));
// --cand-rung challenger (rung 5): score the candidate arm's CHALLENGER sidecar rows instead of its
// linear rung, and score BOTH arms on the intersection of rows (the challenger predicts the fitted
// positions only, not K/DST), so the pair is the same men scored two ways.
const candRung = val("--cand-rung", "trained");
// --base-rung challenger: score the BASE arm's sidecar too, so two challenger fits can be paired
// (e.g. the boosted model with and without a column -- the "does a broader lever explain it" check).
const baseRung = val("--base-rung", "trained");
for (const [k, v] of [["--cand-rung", candRung], ["--base-rung", baseRung]]) {
  if (!["trained", "challenger"].includes(v)) { console.error(`${k} must be trained or challenger, got ${v}`); process.exit(1); }
}
const rowsOf = (f, rung) => (rung === "challenger" ? (f.challenger ?? []) : f.rows.trained);
const key = (r) => `${r.pos}|${r.name}`;

function perSeasonPinball(folds, rung, keep) {
  const m = new Map();
  for (const f of folds) {
    if (!f.trainerOk) continue;
    let rows = rowsOf(f, rung);
    if (pos) rows = rows.filter((r) => r.pos === pos);
    if (keep) rows = rows.filter((r) => keep.get(f.season)?.has(key(r)));
    if (!rows.length) continue;
    m.set(f.season, score(rows).crps);
  }
  return m;
}

const addFeatures = (process.env.FF_ADD_FEATURES ?? "").trim();
console.log(`VARIANT GATE${pos ? ` [${pos} only]` : ""}${candRung === "challenger" ? " [candidate = CHALLENGER sidecar, intersected rows]" : ""} over seasons ${seasons[0]}-${seasons[seasons.length - 1]}`);
console.log(`  base arm: trainer args [${split(baseArgs).join(" ") || "(none)"}]${addFeatures ? ` + --add-features ${addFeatures}` : ""}`);
console.log(`  cand arm: trainer args [${split(candArgs).join(" ")}]${addFeatures ? ` + --add-features ${addFeatures}` : ""}`);

console.log("baseline run ...");
const baseFolds = await evaluateProjection({ dbPath, seasons, trainerArgs: split(baseArgs), log: () => {} });
const baseFail = baseFolds.filter((f) => !f.trainerOk);
if (baseFail.length) console.log(`  baseline: ${baseFail.length} fold(s) with trainer failure: ${baseFail.map((f) => `${f.season} (${f.note})`).join("; ")}`);

console.log("candidate run ...");
const candFolds = await evaluateProjection({ dbPath, seasons, trainerArgs: split(candArgs), log: () => {} });
const candFail = candFolds.filter((f) => !f.trainerOk);
if (candFail.length) console.log(`  candidate: ${candFail.length} fold(s) with trainer failure: ${candFail.map((f) => `${f.season} (${f.note})`).join("; ")}`);

// The rows both arms are scored on. Identical by construction for a linear-vs-linear gate; for the
// challenger it is the intersection, and its size is printed so a thin sidecar cannot hide.
let keep = null;
if (candRung === "challenger" || baseRung === "challenger") {
  keep = new Map();
  for (const f of candFolds) {
    const b = baseFolds.find((g) => g.season === f.season);
    if (!b) continue;
    const bk = new Set(rowsOf(b, baseRung).map(key));
    keep.set(f.season, new Set(rowsOf(f, candRung).map(key).filter((k) => bk.has(k))));
  }
  for (const [label, folds, rung] of [["candidate", candFolds, candRung], ["base", baseFolds, baseRung]]) {
    if (rung !== "challenger") continue;
    const missing = folds.filter((f) => f.trainerOk && !(f.challenger?.length)).map((f) => f.season);
    if (missing.length) console.log(`  WARNING: no ${label} challenger sidecar for ${missing.join(", ")} -- those folds are not scored`);
  }
  console.log(`  intersected rows per season: ${[...keep.entries()].map(([s, k]) => `${s}:${k.size}`).join(" ")}`);
  // CONSISTENCY CHECK: when the arms differ only by the challenger flag, the candidate arm's LINEAR
  // rung must equal the baseline's. When the arms also differ in features or flags it legitimately
  // differs, and the line says so rather than warning.
  const a = perSeasonPinball(baseFolds, "trained", keep), b = perSeasonPinball(candFolds, "trained", keep);
  const drift = [...a.keys()].filter((s) => b.has(s) && Math.abs(a.get(s) - b.get(s)) > 1e-9);
  console.log(drift.length ? `  note: linear rung differs between arms in ${drift.length} season(s) (expected iff the arms differ beyond --challenger)` : "  linear rung identical across arms (as it must be when only --challenger differs)");
}
const base = perSeasonPinball(baseFolds, baseRung, keep);
const cand = perSeasonPinball(candFolds, candRung, keep);

const shared = seasons.filter((s) => base.has(s) && cand.has(s));
const { selection: selSeasons, holdout: holdoutSeasons } = splitSeasons(shared, holdout);
if (selSeasons.length < 3) { console.error(`only ${selSeasons.length} SELECTION seasons scored -- cannot decide`); process.exit(1); }
assertSelectionBlind(selSeasons, holdout);
const pooled = (m, ss) => ss.reduce((a, s) => a + m.get(s), 0) / ss.length;

const v = admissionVerdict(cand, base, selSeasons);
console.log(`\n  holdout block (never used to decide): ${holdout.join(", ")}`);
console.log(`  DECISION seasons: ${selSeasons.length}  (${selSeasons[0]}-${selSeasons[selSeasons.length - 1]})`);
console.log(`  pinball  base ${pooled(base, selSeasons).toFixed(3)}  ->  cand ${pooled(cand, selSeasons).toFixed(3)}`);
console.log(`  season-paired improvement ${v.improvement.toFixed(4)} +/- SE ${v.se.toFixed(4)}  (wins ${v.wins}/${v.nSeasons})`);
console.log(`  effect-size floor (2.9*SE) = ${v.floor.toFixed(4)}`);
console.log(`  DECISION VERDICT: ${v.pass ? "ADMIT" : "REJECT"} -- improvement ${v.pass ? "clears" : "is within"} the floor.`);
// Per-season detail, because a pooled number hides a variant that helps three seasons and hurts nine.
console.log("  per season (base -> cand):");
for (const s of shared) console.log(`    ${s}  ${base.get(s).toFixed(3)} -> ${cand.get(s).toFixed(3)}  ${(base.get(s) - cand.get(s) >= 0 ? "+" : "") + (base.get(s) - cand.get(s)).toFixed(4)}${holdout.includes(s) ? "  [holdout]" : ""}`);

if (holdoutSeasons.length >= 3) {
  const c = admissionVerdict(cand, base, holdoutSeasons);
  console.log(`\n  CONFIRM on held-out ${holdoutSeasons[0]}-${holdoutSeasons[holdoutSeasons.length - 1]} (${holdoutSeasons.length} seasons, quoted once):`);
  console.log(`    pinball  base ${pooled(base, holdoutSeasons).toFixed(3)}  ->  cand ${pooled(cand, holdoutSeasons).toFixed(3)}`);
  console.log(`    improvement ${c.improvement.toFixed(4)} +/- SE ${c.se.toFixed(4)}  (wins ${c.wins}/${c.nSeasons})  floor ${c.floor.toFixed(4)}  -> ${c.pass ? "confirmed" : "NOT confirmed"}`);
} else {
  console.log(`\n  CONFIRM: only ${holdoutSeasons.length} held-out season(s) scored -- too few (need >= 3).`);
}
console.log(`\n  The ADMIT/REJECT decision is the DECISION verdict (selection seasons); the confirm is reported, not gated.`);
process.exit(v.pass ? 0 : 2);
