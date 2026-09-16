// ADMISSION GATE with an EFFECT-SIZE FLOOR (rigor program WS1).
//
// The trainer's own comment (tools/train_projection.py) warned: "a keep/drop rule with no effect-size
// floor will eventually admit noise" -- and `contract_year` shipped at pinball 12.03 -> 12.02, the
// edge of what the evaluation can resolve. This script turns admission into a MEASURED gate: it runs
// the nested CV twice (baseline, then with --add-features X), takes the per-SEASON trained pinball of
// each, and admits the candidate ONLY if the season-paired improvement clears 2.9*SE -- the same
// smallest-resolvable-effect bar the draft arbiter uses (scripts/lib/arbiter.mjs seasonEffect).
//
// USAGE (heavy -- two full nested-CV runs, the Python trainer per fold each):
//   node --import tsx scripts/admit-feature.mjs --candidate prior_carry_share [--seasons 2008-2025]
//   node --import tsx scripts/admit-feature.mjs --candidate contract_year --remove   # LEAVE-ONE-OUT
//
// --remove flips the gate to leave-one-out for a feature that is ALREADY a default: --add-features on such
// a feature is a no-op (the trainer refuses to duplicate a column), so the only honest test of its worth is
// to fit the design WITHOUT it and see whether the loss clears the floor. KEEP = removing it costs > floor;
// DROP = its contribution is within the floor (noise).
//
// The verdict is the number to quote in the admission trace, not a hand-read 12.03->12.02.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { evaluateProjection, score } from "../src/model/evaluate.ts";
import { admissionVerdict } from "./lib/arbiter.mjs";
import { parseHoldout, splitSeasons, assertSelectionBlind } from "./lib/holdout.mjs";

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const candidate = val("--candidate", null);
// --remove flips the gate to LEAVE-ONE-OUT: measure an ALREADY-SHIPPED default feature's contribution by
// fitting the shipped design MINUS it (baseline) vs the untouched default (candidate). This is the correct
// check for a feature that is already in the default lists -- --add-features on such a feature is a no-op
// (the trainer refuses to duplicate a column), which is why `contract_year` measured 0.0000 under add mode.
const removeMode = argv.includes("--remove");
// --pos <POS> scores pinball on ONE position's rows only. A position-gated feature (an NGS metric,
// qb_changed) moves only its own position's projections; scored POOLED across all positions its real
// effect is diluted ~15x and reads as a false NULL. Screen such a feature on its own position.
const pos = val("--pos", null);
if (!candidate) { console.error("usage: node --import tsx scripts/admit-feature.mjs --candidate <feature> [--remove] [--pos QB] [--seasons 2008-2025]"); process.exit(1); }
const range = val("--seasons", "2008-2025").split("-").map(Number);
const seasons = []; for (let y = range[0]; y <= (range[1] ?? range[0]); y++) seasons.push(y);
const dbPath = val("--db", undefined);
// SELECTION-BLIND HOLDOUT (WS2). The admit/reject DECISION is made only on the SELECTION seasons; the
// held-out block is scored once as a separate CONFIRM number. Override the block with --holdout-seasons
// (e.g. 2021-2025); default is the canonical HOLDOUT_SEASONS. The nested CV itself still runs over ALL
// requested seasons -- each fold fits walk-forward (train on < Y) -- so blinding the DECISION does not
// change what any model FITS; it only prevents the choice from being made on held-out seasons.
const holdout = parseHoldout(val("--holdout-seasons", null));
// --baseline-cache <file>: REUSE OF THE SHARED ARM. Exactly one of the two arms sets no env at all --
// the UNTOUCHED DEFAULT DESIGN (the `cand` arm under --remove, the `base` arm under add mode). Its
// per-season pinball does not depend on the candidate, so a contribution LEDGER over N features would
// otherwise re-fit the identical full-design nested CV N times. The cache keys that arm by everything
// that CAN change it (db, season list, scored position) and by nothing that cannot (the candidate), so
// a cache HIT is byte-identical to the run it replaces. Absent flag = no cache = the original behaviour.
const cachePath = val("--baseline-cache", null);
// --json <file>: dump BOTH arms' per-season pinball plus the verdicts, so a driver can build a per-era /
// per-season table without re-running anything or re-parsing stdout.
const jsonOut = val("--json", null);
const cacheKey = `${dbPath ?? "data/ff.db"}|${seasons[0]}-${seasons[seasons.length - 1]}|${pos ?? "ALL"}`;
function readCache() {
  if (!cachePath || !existsSync(cachePath)) return null;
  try { return JSON.parse(readFileSync(cachePath, "utf8")); } catch { return null; }
}
function cachedFullDesign() {
  const c = readCache();
  const hit = c?.[cacheKey];
  if (!hit) return null;
  return new Map(Object.entries(hit).map(([s, v]) => [Number(s), v]));
}
function storeFullDesign(m) {
  if (!cachePath) return;
  const c = readCache() ?? {};
  c[cacheKey] = Object.fromEntries([...m].map(([s, v]) => [String(s), v]));
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(c, null, 2));
}
/** Run one arm, or serve the FULL-DEFAULT arm from the cache. `isFullDesign` is true only for the arm
 *  that sets no FF_* env -- the one arm a ledger shares across candidates. */
async function arm(isFullDesign) {
  if (isFullDesign) {
    const hit = cachedFullDesign();
    if (hit) { console.log(`  (full-design arm served from --baseline-cache: ${cacheKey})`); return hit; }
  }
  const m = perSeasonPinball(await evaluateProjection({ dbPath, seasons, log: () => {} }));
  if (isFullDesign) storeFullDesign(m);
  return m;
}

/** Map<season, mean trained pinball> for one nested-CV run. With `pos` set, scores only that
 *  position's rows -- the right metric for a feature the trainer fits for one position family. */
function perSeasonPinball(folds) {
  const m = new Map();
  for (const f of folds) {
    if (!f.trainerOk || !f.rows.trained.length) continue;
    const rows = pos ? f.rows.trained.filter((r) => r.pos === pos) : f.rows.trained;
    if (!rows.length) continue;
    m.set(f.season, score(rows).crps);
  }
  return m;
}

// In BOTH modes the "candidate" arm is the model that HAS the feature and the "baseline" arm is the model
// WITHOUT it, so improvement = pinball(without) - pinball(with) = the feature's own contribution, and the
// verdict semantics (ADMIT = feature clears the floor) are identical. Only which env each arm sets differs:
//   add mode:    base = no env (feature absent);          cand = FF_ADD_FEATURES    (feature added)
//   remove mode: base = FF_REMOVE_FEATURES (feature out); cand = no env             (feature present, default)
delete process.env.FF_ADD_FEATURES; delete process.env.FF_REMOVE_FEATURES;
console.log(`${removeMode ? "LEAVE-ONE-OUT" : "ADMISSION"} GATE: ${candidate}${pos ? ` [${pos} only]` : ""} over seasons ${seasons[0]}-${seasons[seasons.length - 1]}`);

console.log(removeMode ? `baseline run (--remove-features ${candidate}; shipped design MINUS it) ...` : "baseline run (no --add-features) ...");
delete process.env.FF_ADD_FEATURES; delete process.env.FF_REMOVE_FEATURES;
if (removeMode) process.env.FF_REMOVE_FEATURES = candidate;
const base = await arm(!removeMode);

console.log(removeMode ? `candidate run (full default, ${candidate} present) ...` : `candidate run (--add-features ${candidate}) ...`);
delete process.env.FF_ADD_FEATURES; delete process.env.FF_REMOVE_FEATURES;
if (!removeMode) process.env.FF_ADD_FEATURES = candidate;
const cand = await arm(removeMode);

const shared = seasons.filter((s) => base.has(s) && cand.has(s));
// PARTITION the scored seasons into the DECISION set (selection) and the one-shot CONFIRM set
// (holdout). The verdict is the decision on the selection folds; the holdout number is quoted once and
// never feeds the admit/reject choice.
const { selection: selSeasons, holdout: holdoutSeasons } = splitSeasons(shared, holdout);
if (selSeasons.length < 3) { console.error(`only ${selSeasons.length} SELECTION seasons scored (holdout ${holdout.join(",")}) -- cannot decide`); process.exit(1); }
// GUARD: the DECISION must never see a holdout season. Throws rather than silently deciding on all data.
assertSelectionBlind(selSeasons, holdout);
const pooled = (m, ss) => ss.reduce((a, s) => a + m.get(s), 0) / ss.length;

// --- DECISION (selection seasons only) -----------------------------------------------------------
const v = admissionVerdict(cand, base, selSeasons);
// DEGENERATE-ARM GUARD (2026-09-16, M1 format-edge screen). Two candidates (`prior_cpoe` QB, `prior_ryoe`
// RB) returned exactly 0.0000 +/- 0.0000 with 0 wins under BOTH targets, and printed the same `REJECT` a
// real null prints. They were not null: the NGS columns cover ~40-50 rows a season, under the trainer's
// 200-row coverage floor, so the candidate never entered the fit and the two arms were the SAME model. A
// verdict on two identical arms is silence read as agreement, so it is refused by name instead.
// The test is on the DECISION seasons, because that is where the verdict is made: `prior_cpoe` QB is
// identical on every 2013-2020 fold (NGS starts 2016 and clears the floor only recently) while its
// 2021-2025 holdout arms DO differ -- so "identical on every scored season" would have let the
// meaningless REJECT through. Fault-injected 2026-09-16 on exactly that candidate.
const identicalDecisionArms = selSeasons.every((s) => Math.abs(cand.get(s) - base.get(s)) < 1e-12);
// --json dump. Written in BOTH exits (including DEGENERATE) so a driver never has to infer a missing
// file's meaning: a degenerate row is reported as DEGENERATE, not as a zero.
function dumpJson(extra) {
  if (!jsonOut) return;
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify({
    candidate, pos, removeMode, db: dbPath ?? "data/ff.db",
    seasons: shared, selectionSeasons: selSeasons, holdoutSeasons,
    perSeason: shared.map((s) => ({ season: s, base: base.get(s), cand: cand.get(s), contribution: base.get(s) - cand.get(s) })),
    ...extra,
  }, null, 2));
}
if (identicalDecisionArms) {
  dumpJson({ status: "DEGENERATE" });
  const holdoutDiffers = holdoutSeasons.some((s) => Math.abs(cand.get(s) - base.get(s)) >= 1e-12);
  console.error(`\n  DEGENERATE: the baseline and candidate arms are IDENTICAL on every DECISION season (${selSeasons[0]}-${selSeasons[selSeasons.length - 1]}) ` +
    `-- ${candidate} never entered the fit there (most likely below the trainer's per-position row-coverage floor on those seasons, ` +
    `or not in EXT_ALLOWED for --pos).` +
    (holdoutDiffers ? ` The held-out block DOES differ, so the column only reaches coverage in recent seasons -- a regime the decision block cannot see; screen it with --holdout-seasons / a later --seasons window and say so.` : "") +
    ` No verdict: this is neither ADMIT nor REJECT.`);
  process.exit(3);
}
console.log(`\n  holdout block (never used to decide): ${holdout.join(", ")}`);
console.log(`  DECISION seasons: ${selSeasons.length}  (${selSeasons[0]}-${selSeasons[selSeasons.length - 1]})`);
console.log(removeMode
  ? `  pinball  without ${candidate} ${pooled(base, selSeasons).toFixed(3)}  ->  with (default) ${pooled(cand, selSeasons).toFixed(3)}`
  : `  pinball  baseline ${pooled(base, selSeasons).toFixed(3)}  ->  +${candidate} ${pooled(cand, selSeasons).toFixed(3)}`);
console.log(`  season-paired improvement ${v.improvement.toFixed(4)} +/- SE ${v.se.toFixed(4)}  (wins ${v.wins}/${v.nSeasons})   [${removeMode ? "the feature's own contribution" : "benefit of adding"}]`);
console.log(`  effect-size floor (2.9*SE) = ${v.floor.toFixed(4)}`);
console.log(removeMode
  ? `  DECISION VERDICT: ${v.pass ? "KEEP" : "DROP"} -- removing ${candidate} ${v.pass ? "costs more than" : "is within"} the floor${v.pass ? "" : " (its contribution is noise; safe to drop from the default lists)"}.`
  : `  DECISION VERDICT: ${v.pass ? "ADMIT" : "REJECT"} -- improvement ${v.pass ? "clears" : "is within"} the floor.`);

// --- CONFIRM (held-out seasons, quoted ONCE, not part of the decision) ---------------------------
if (holdoutSeasons.length >= 3) {
  const c = admissionVerdict(cand, base, holdoutSeasons);
  console.log(`\n  CONFIRM on held-out ${holdoutSeasons[0]}-${holdoutSeasons[holdoutSeasons.length - 1]} (${holdoutSeasons.length} seasons, quoted once):`);
  console.log(removeMode
    ? `    pinball  without ${candidate} ${pooled(base, holdoutSeasons).toFixed(3)}  ->  with (default) ${pooled(cand, holdoutSeasons).toFixed(3)}`
    : `    pinball  baseline ${pooled(base, holdoutSeasons).toFixed(3)}  ->  +${candidate} ${pooled(cand, holdoutSeasons).toFixed(3)}`);
  console.log(`    improvement ${c.improvement.toFixed(4)} +/- SE ${c.se.toFixed(4)}  (wins ${c.wins}/${c.nSeasons})  floor ${c.floor.toFixed(4)}  -> ${c.pass ? "confirmed" : "NOT confirmed"}`);
} else {
  console.log(`\n  CONFIRM: only ${holdoutSeasons.length} held-out season(s) scored -- too few for an honest confirm (need >= 3). Report the decision as unconfirmed.`);
}
console.log(`\n  The ADMIT/REJECT decision is the DECISION verdict (selection seasons); the confirm is reported, not gated.`);
dumpJson({
  status: "OK",
  decision: { improvement: v.improvement, se: v.se, t: v.t, floor: v.floor, wins: v.wins, nSeasons: v.nSeasons, ciLo: v.ciLo, ciHi: v.ciHi, pass: v.pass },
  confirm: holdoutSeasons.length >= 3
    ? (() => { const c = admissionVerdict(cand, base, holdoutSeasons); return { improvement: c.improvement, se: c.se, t: c.t, floor: c.floor, wins: c.wins, nSeasons: c.nSeasons, pass: c.pass }; })()
    : null,
});
process.exit(v.pass ? 0 : 2);
