// TRADE BACKTEST -- do the trades trade_finder-style logic recommends (fair, lineup-improving,
// mutually-acceptable one-for-ones) actually improve realized rest-of-season value? Realized + sim,
// with a positive control (give our best for their worst, which must crater).
//   node --import tsx scripts/inseason-backtest-trade.mjs [--seasons 2018-2024] [--model served|floor] [--gap 3] [--self]
import { openDb } from "../src/db/db.ts";
import { backtestTrades } from "../src/inseason/backtest/trades.ts";
import { makeSimExpectedScorer } from "../src/inseason/backtest/scorers.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const seasonsArg = arg("--seasons", "2018-2024");
const [lo, hi] = seasonsArg.split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const model = arg("--model", "served");
const gap = Number(arg("--gap", "3"));
const mutual = !process.argv.includes("--self");
const db = openDb(arg("--db", undefined));
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
if (!lg) { console.error("no league synced"); process.exit(2); }

const run = (scorer) => backtestTrades(db, { leagueId: lg.league_id, seasons, model, scorer, gap, mutual });
const line = (r, label) => `  ${label.padEnd(14)} our diff/decision ${r.meanOurDiff.toFixed(3).padStart(7)}  where-traded ${r.meanOurDiffWhereTraded.toFixed(2).padStart(6)}  CI [${r.bootstrap.lo.toFixed(2)}, ${r.bootstrap.hi.toFixed(2)}]  P(better) ${(100 * r.bootstrap.pBetter).toFixed(0)}%  (traded ${r.traded}/${r.evaluated})  their diff ${r.meanTheirDiff.toFixed(2)}`;

console.log(`\nTRADE BACKTEST -- ${mutual ? "MUTUAL (acceptable)" : "self-interested"} fair one-for-ones (|proj gap|<=${gap}), ${model} model, seasons ${seasonsArg}`);
console.log(`  + => the projection-improving trade improved OUR realized rest-of-season value\n`);
const rr = run(undefined);
console.log(line(rr, "REALIZED"));
console.log(line(run(makeSimExpectedScorer(db, { trials: 150 })), "SIM (distr.)"));
console.log(`\n  NEUTRAL control (RANDOM fair trade, realized): ${rr.randomControl.meanDiff.toFixed(2)} pts  (must be ~0 -- else the edge is a hindsight artifact, not selection)`);
console.log(`  positive control (give our best for their worst): ${rr.control.meanDiff.toFixed(1)} pts  (must be strongly negative)`);
console.log(`  per-season (realized our diff/trade): ${rr.perSeason.map((s) => `${s.season}:${s.meanOurDiff.toFixed(1)}(${s.traded})`).join("  ")}`);
db.close();
