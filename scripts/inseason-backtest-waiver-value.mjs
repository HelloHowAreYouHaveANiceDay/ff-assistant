// Does ONE waiver claim pay? A/B on the decision harness: STAND PAT (baseline) vs ADD-BEST-FREE-AGENT
// (drop value-min, add the highest-projected FA when he beats the dropped man), scored over the rest
// of the season -- realized (actual history) and sim (over the injury distribution).
//   node --import tsx scripts/inseason-backtest-waiver-value.mjs [--seasons 2018-2025] [--model served|floor]
import { openDb } from "../src/db/db.ts";
import { backtestPolicies } from "../src/inseason/backtest/harness.ts";
import { makeSimExpectedScorer } from "../src/inseason/backtest/scorers.ts";
import { standPat, addBestFreeAgent, valueMinDrop, hasRealDrop } from "../src/inseason/backtest/policies.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const seasonsArg = arg("--seasons", "2018-2025");
const [lo, hi] = seasonsArg.split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const model = arg("--model", "served");
const db = openDb(arg("--db", undefined));
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
if (!lg) { console.error("no league synced"); process.exit(2); }

const run = (scorer) => backtestPolicies(db, {
  leagueId: lg.league_id, seasons, model, scorer,
  baseline: standPat, variant: addBestFreeAgent(valueMinDrop), admit: hasRealDrop,
});
const line = (r, label) =>
  `  ${label.padEnd(16)} diff/decision ${r.meanDiff.toFixed(3).padStart(7)}  CI [${r.bootstrap.lo.toFixed(2)}, ${r.bootstrap.hi.toFixed(2)}]  P(add better) ${(100 * r.bootstrap.pVariantBetter).toFixed(0)}%  (claimed ${r.differed} of ${r.evaluated})`;

const t0 = Date.now();
console.log(`\nWAIVER-CLAIM VALUE -- stand pat vs add-best-FA, ${model} model, seasons ${seasonsArg}`);
console.log(`  + => the claim helped; diff = realized/expected rest-of-season lineup points gained\n`);
console.log(line(run(undefined), "REALIZED"));
console.log(line(run(makeSimExpectedScorer(db, { trials: 200 })), "SIM (distr.)"));
db.close();
console.log(`\n  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
