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
//
// The verdict is the number to quote in the admission trace, not a hand-read 12.03->12.02.
import { evaluateProjection, score } from "../src/model/evaluate.ts";
import { admissionVerdict } from "./lib/arbiter.mjs";

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const candidate = val("--candidate", null);
if (!candidate) { console.error("usage: node --import tsx scripts/admit-feature.mjs --candidate <feature> [--seasons 2008-2025]"); process.exit(1); }
const range = val("--seasons", "2008-2025").split("-").map(Number);
const seasons = []; for (let y = range[0]; y <= (range[1] ?? range[0]); y++) seasons.push(y);
const dbPath = val("--db", undefined);

/** Map<season, mean trained pinball> for one nested-CV run. */
function perSeasonPinball(folds) {
  const m = new Map();
  for (const f of folds) {
    if (!f.trainerOk || !f.rows.trained.length) continue;
    m.set(f.season, score(f.rows.trained).crps);
  }
  return m;
}

console.log(`ADMISSION GATE: ${candidate} over seasons ${seasons[0]}-${seasons[seasons.length - 1]}`);
console.log("baseline run (no --add-features) ...");
delete process.env.FF_ADD_FEATURES;
const base = perSeasonPinball(evaluateProjection({ dbPath, seasons, log: () => {} }));
console.log(`candidate run (--add-features ${candidate}) ...`);
process.env.FF_ADD_FEATURES = candidate;
const cand = perSeasonPinball(evaluateProjection({ dbPath, seasons, log: () => {} }));

const shared = seasons.filter((s) => base.has(s) && cand.has(s));
if (shared.length < 3) { console.error(`only ${shared.length} shared seasons scored -- cannot gate`); process.exit(1); }
const v = admissionVerdict(cand, base, shared);
const pooled = (m) => shared.reduce((a, s) => a + m.get(s), 0) / shared.length;
console.log(`\n  seasons scored: ${shared.length}  (${shared[0]}-${shared[shared.length - 1]})`);
console.log(`  pinball  baseline ${pooled(base).toFixed(3)}  ->  +${candidate} ${pooled(cand).toFixed(3)}`);
console.log(`  season-paired improvement ${v.improvement.toFixed(4)} +/- SE ${v.se.toFixed(4)}  (wins ${v.wins}/${v.nSeasons})`);
console.log(`  effect-size floor (2.9*SE) = ${v.floor.toFixed(4)}`);
console.log(`\n  VERDICT: ${v.pass ? "ADMIT" : "REJECT"} -- improvement ${v.pass ? "clears" : "is within"} the floor.`);
process.exit(v.pass ? 0 : 2);
