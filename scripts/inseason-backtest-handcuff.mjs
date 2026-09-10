// Does the VALIDATED handcuff signal earn a roster decision? A/B on the harness: value-min drop (cut
// lowest projection) vs handcuff-aware drop (cut lowest projection + conditional handcuff EV, keeping
// the buried workhorse-backup value-min would discard). The capstone bench test -- the one flavour of
// bench upside (conditional-role) the repo has actually validated. Realized + sim.
//   node --import tsx scripts/inseason-backtest-handcuff.mjs [--seasons 2018-2025] [--model served|floor]
import { openDb } from "../src/db/db.ts";
import { backtestPolicies } from "../src/inseason/backtest/harness.ts";
import { makeSimExpectedScorer } from "../src/inseason/backtest/scorers.ts";
import { makeHandcuffValueFn } from "../src/inseason/backtest/handcuffSignal.ts";
import { valueMinDrop, handcuffAwareDrop, dropBest, hasRealDrop } from "../src/inseason/backtest/policies.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const seasonsArg = arg("--seasons", "2018-2025");
const [lo, hi] = seasonsArg.split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const model = arg("--model", "served");
const db = openDb(arg("--db", undefined));
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
if (!lg) { console.error("no league synced"); process.exit(2); }

const handcuffOf = makeHandcuffValueFn(db);
const run = (scorer) => backtestPolicies(db, {
  leagueId: lg.league_id, seasons, model, scorer,
  baseline: valueMinDrop, variant: handcuffAwareDrop(handcuffOf), control: dropBest, admit: hasRealDrop,
});
const line = (r, label) =>
  `  ${label.padEnd(14)} diff/decision ${r.meanDiff.toFixed(3).padStart(7)}  CI [${r.bootstrap.lo.toFixed(2)}, ${r.bootstrap.hi.toFixed(2)}]  P(handcuff better) ${(100 * r.bootstrap.pVariantBetter).toFixed(0)}%  (differed ${r.differed})`;

const t0 = Date.now();
console.log(`\nHANDCUFF-AWARE DROP -- value-min vs keep-the-handcuff, ${model} model, seasons ${seasonsArg}`);
console.log(`  + => keeping the buried workhorse-backup (over value-min's floor pick) helped\n`);
const rr = run(undefined);
console.log(line(rr, "REALIZED"));
console.log(line(run(makeSimExpectedScorer(db, { trials: 200 })), "SIM (distr.)"));
console.log(`\n  positive control (drop-best): ${rr.control.meanDiff.toFixed(1)} pts  (must be strongly negative)`);
console.log(`\n  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
