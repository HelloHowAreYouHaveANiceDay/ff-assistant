// Does the VALIDATED handcuff signal earn a roster decision? A/B on the harness: value-min drop (cut
// lowest projection) vs handcuff-aware drop (cut lowest projection + conditional handcuff EV, keeping
// the buried workhorse-backup value-min would discard). The capstone bench test -- the one flavour of
// bench upside (conditional-role) the repo has actually validated. Realized + sim.
//   node --import tsx scripts/inseason-backtest-handcuff.mjs [--seasons 2018-2025] [--model served|floor] [--league <id>]
//
// WHICH LEAGUE (fixed 2026-09-16, D25). This picked its league with `ORDER BY last_synced_at DESC
// LIMIT 1` -- one of the S-1 resolvers the architecture review deleted from `src/`, left behind here.
// With a second league in the store that resolver returns YAHOO 129048, which holds no
// `fact_roster_week` rows at all, so the harness made ZERO decisions and printed
// `diff/decision 0.000 ... (differed 0)` together with a POSITIVE CONTROL of 0.0 -- a dead arbiter
// that reads exactly like a null result. It now resolves the ACTIVE league through the one resolver,
// with `--league <id>` to override, and REFUSES a league with no decisions rather than scoring an
// empty set.
import { openDb } from "../src/db/db.ts";
import { backtestPolicies } from "../src/inseason/backtest/harness.ts";
import { makeSimExpectedScorer } from "../src/inseason/backtest/scorers.ts";
import { makeHandcuffValueFn } from "../src/inseason/backtest/handcuffSignal.ts";
import { valueMinDrop, handcuffAwareDrop, dropBest, hasRealDrop } from "../src/inseason/backtest/policies.ts";
import { resolveLeagueContext, requireLeagueId } from "../src/data/leagueContext.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const seasonsArg = arg("--seasons", "2018-2025");
const [lo, hi] = seasonsArg.split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const model = arg("--model", "served");
const db = openDb(arg("--db", undefined));
const leagueId = requireLeagueId(resolveLeagueContext(db, arg("--league", undefined)), "inseason-backtest-handcuff");

const handcuffOf = makeHandcuffValueFn(db, ["RB"], leagueId);
const run = (scorer) => backtestPolicies(db, {
  leagueId, seasons, model, scorer,
  baseline: valueMinDrop, variant: handcuffAwareDrop(handcuffOf), control: dropBest, admit: hasRealDrop,
});
const line = (r, label) =>
  `  ${label.padEnd(14)} diff/decision ${r.meanDiff.toFixed(3).padStart(7)}  CI [${r.bootstrap.lo.toFixed(2)}, ${r.bootstrap.hi.toFixed(2)}]  P(handcuff better) ${(100 * r.bootstrap.pVariantBetter).toFixed(0)}%  (differed ${r.differed})`;

const t0 = Date.now();
console.log(`\nHANDCUFF-AWARE DROP -- value-min vs keep-the-handcuff, ${model} model, seasons ${seasonsArg}`);
console.log(`  + => keeping the buried workhorse-backup (over value-min's floor pick) helped\n`);
const rr = run(undefined);
// AN EMPTY DECISION SET IS A REFUSAL, NOT A ZERO (D25). `evaluated 0` prints as `0.000` with a
// `0.0` positive control, which is indistinguishable from "the signal does nothing" -- and that is
// exactly what the last-synced league resolver produced for eight months of store history.
if (rr.evaluated === 0) {
  console.error(`\nREFUSED: league ${leagueId} produced ZERO evaluated decisions over ${seasonsArg} ` +
    `(no fact_roster_week / fact_lineup_week rows for it). Nothing was measured -- a printed 0.000 here ` +
    `would be an empty set, not a null result. Pass --league <id> for a league with in-season history.`);
  process.exit(3);
}
console.log(line(rr, "REALIZED"));
console.log(line(run(makeSimExpectedScorer(db, { trials: 200, leagueId })), "SIM (distr.)"));
console.log(`\n  positive control (drop-best): ${rr.control.meanDiff.toFixed(1)} pts  (must be strongly negative)`);
console.log(`\n  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
