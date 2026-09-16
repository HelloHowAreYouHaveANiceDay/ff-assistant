// Best use of a bench spot: A/B on the harness -- VALUE-MIN drop (cut lowest mean, i.e. keep floor)
// vs UPSIDE drop (cut lowest ceiling, i.e. keep the boom stash). They diverge on exactly the low-
// mean/high-variance body a floor view discards, so this tests "spend bench spots on upside, not
// floor". Scored realized (actual history) and sim (over the injury+variance distribution).
//   node --import tsx scripts/inseason-backtest-bench.mjs [--seasons 2018-2025] [--model served|floor] [--league <id>]
//
// WHICH LEAGUE (D-2, 2026-09-16 -- the same fix D25.2 made in inseason-backtest-handcuff.mjs, applied
// to its siblings). This picked its league with `ORDER BY last_synced_at DESC LIMIT 1`, an S-1 resolver
// the architecture review deleted from `src/` and left behind here. On a two-league store that returns
// whichever league synced last -- YAHOO 129048, which holds no `fact_roster_week` rows for these
// seasons -- so the harness evaluated ZERO decisions and printed `0.000` beside a `0.0` positive
// control: a dead arbiter that reads exactly like a null result. It now resolves the ACTIVE league
// through the one resolver, takes `--league <id>`, and REFUSES an empty decision set.
import { openDb } from "../src/db/db.ts";
import { backtestPolicies } from "../src/inseason/backtest/harness.ts";
import { makeSimExpectedScorer, makeCeilingFn } from "../src/inseason/backtest/scorers.ts";
import { valueMinDrop, upsideDrop, dropBest, hasRealDrop } from "../src/inseason/backtest/policies.ts";
import { resolveLeagueContext, requireLeagueId } from "../src/data/leagueContext.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const seasonsArg = arg("--seasons", "2018-2025");
const [lo, hi] = seasonsArg.split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const model = arg("--model", "served");
const db = openDb(arg("--db", undefined));
const leagueId = requireLeagueId(resolveLeagueContext(db, arg("--league", undefined)), "inseason-backtest-bench");

const ceilingOf = makeCeilingFn(db, leagueId);
const run = (scorer) => backtestPolicies(db, {
  leagueId, seasons, model, scorer,
  baseline: valueMinDrop, variant: upsideDrop(ceilingOf), control: dropBest, admit: hasRealDrop,
});
const line = (r, label) =>
  `  ${label.padEnd(14)} diff/decision ${r.meanDiff.toFixed(3).padStart(7)}  CI [${r.bootstrap.lo.toFixed(2)}, ${r.bootstrap.hi.toFixed(2)}]  P(upside better) ${(100 * r.bootstrap.pVariantBetter).toFixed(0)}%  (differed ${r.differed})`;

const t0 = Date.now();
console.log(`\nBENCH USE -- keep FLOOR (value-min) vs keep UPSIDE (drop lowest ceiling), ${model} model, seasons ${seasonsArg}`);
console.log(`  + => keeping the boom stash beat keeping the steady floor player\n`);
const rr = run(undefined);
// AN EMPTY DECISION SET IS A REFUSAL, NOT A ZERO (D25.2). `evaluated 0` prints as `0.000` with a `0.0`
// positive control, which is indistinguishable from "keeping the boom stash does nothing".
if (rr.evaluated === 0) {
  console.error(`\nREFUSED: league ${leagueId} produced ZERO evaluated decisions over ${seasonsArg} ` +
    `(no fact_roster_week / fact_lineup_week rows for it). Nothing was measured -- a printed 0.000 here ` +
    `would be an empty set, not a null result. Pass --league <id> for a league with in-season history.`);
  process.exit(3);
}
console.log(line(rr, "REALIZED"));
console.log(line(run(makeSimExpectedScorer(db, { trials: 200, leagueId })), "SIM (distr.)"));
console.log(`\n  positive control (keep-worst vs drop-best): ${rr.control.meanDiff.toFixed(1)} pts  (must be strongly negative)`);
console.log(`\n  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
