// Best use of a bench spot: A/B on the harness -- VALUE-MIN drop (cut lowest mean, i.e. keep floor)
// vs UPSIDE drop (cut lowest ceiling, i.e. keep the boom stash). They diverge on exactly the low-
// mean/high-variance body a floor view discards, so this tests "spend bench spots on upside, not
// floor". Scored realized (actual history) and sim (over the injury+variance distribution).
//   node --import tsx scripts/inseason-backtest-bench.mjs [--seasons 2018-2025] [--model served|floor]
import { openDb } from "../src/db/db.ts";
import { backtestPolicies } from "../src/inseason/backtest/harness.ts";
import { makeSimExpectedScorer, makeCeilingFn } from "../src/inseason/backtest/scorers.ts";
import { valueMinDrop, upsideDrop, dropBest, hasRealDrop } from "../src/inseason/backtest/policies.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const seasonsArg = arg("--seasons", "2018-2025");
const [lo, hi] = seasonsArg.split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const model = arg("--model", "served");
const db = openDb(arg("--db", undefined));
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
if (!lg) { console.error("no league synced"); process.exit(2); }

const ceilingOf = makeCeilingFn(db);
const run = (scorer) => backtestPolicies(db, {
  leagueId: lg.league_id, seasons, model, scorer,
  baseline: valueMinDrop, variant: upsideDrop(ceilingOf), control: dropBest, admit: hasRealDrop,
});
const line = (r, label) =>
  `  ${label.padEnd(14)} diff/decision ${r.meanDiff.toFixed(3).padStart(7)}  CI [${r.bootstrap.lo.toFixed(2)}, ${r.bootstrap.hi.toFixed(2)}]  P(upside better) ${(100 * r.bootstrap.pVariantBetter).toFixed(0)}%  (differed ${r.differed})`;

const t0 = Date.now();
console.log(`\nBENCH USE -- keep FLOOR (value-min) vs keep UPSIDE (drop lowest ceiling), ${model} model, seasons ${seasonsArg}`);
console.log(`  + => keeping the boom stash beat keeping the steady floor player\n`);
const rr = run(undefined);
console.log(line(rr, "REALIZED"));
console.log(line(run(makeSimExpectedScorer(db, { trials: 200 })), "SIM (distr.)"));
console.log(`\n  positive control (keep-worst vs drop-best): ${rr.control.meanDiff.toFixed(1)} pts  (must be strongly negative)`);
console.log(`\n  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
