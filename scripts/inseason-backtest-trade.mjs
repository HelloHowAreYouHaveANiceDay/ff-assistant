// TRADE BACKTEST -- do the trades trade_finder-style logic recommends (fair, lineup-improving,
// mutually-acceptable one-for-ones) actually improve realized rest-of-season value? Realized + sim,
// with a positive control (give our best for their worst, which must crater).
//   node --import tsx scripts/inseason-backtest-trade.mjs [--seasons 2018-2024] [--model served|floor] [--gap 3] [--self] [--league <id>]
//
// WHICH LEAGUE (D-2, 2026-09-16 -- D25.2's fix applied to this sibling). `ORDER BY last_synced_at DESC
// LIMIT 1` returns the last-SYNCED league rather than the ACTIVE one, which on a two-league store is
// Yahoo 129048 with no roster history at all -- so this scored ZERO trades and printed 0.000 next to a
// positive control of 0.0. Now: the one resolver, `--league <id>`, and a refusal on an empty set.
import { openDb } from "../src/db/db.ts";
import { backtestTrades } from "../src/inseason/backtest/trades.ts";
import { makeSimExpectedScorer } from "../src/inseason/backtest/scorers.ts";
import { resolveLeagueContext, requireLeagueId } from "../src/data/leagueContext.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const seasonsArg = arg("--seasons", "2018-2024");
const [lo, hi] = seasonsArg.split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const model = arg("--model", "served");
const gap = Number(arg("--gap", "3"));
const mutual = !process.argv.includes("--self");
const db = openDb(arg("--db", undefined));
const leagueId = requireLeagueId(resolveLeagueContext(db, arg("--league", undefined)), "inseason-backtest-trade");

const run = (scorer) => backtestTrades(db, { leagueId, seasons, model, scorer, gap, mutual });
const line = (r, label) => `  ${label.padEnd(14)} our diff/decision ${r.meanOurDiff.toFixed(3).padStart(7)}  where-traded ${r.meanOurDiffWhereTraded.toFixed(2).padStart(6)}  CI [${r.bootstrap.lo.toFixed(2)}, ${r.bootstrap.hi.toFixed(2)}]  P(better) ${(100 * r.bootstrap.pBetter).toFixed(0)}%  (traded ${r.traded}/${r.evaluated})  their diff ${r.meanTheirDiff.toFixed(2)}`;

console.log(`\nTRADE BACKTEST -- ${mutual ? "MUTUAL (acceptable)" : "self-interested"} fair one-for-ones (|proj gap|<=${gap}), ${model} model, seasons ${seasonsArg}`);
console.log(`  + => the projection-improving trade improved OUR realized rest-of-season value\n`);
const rr = run(undefined);
// AN EMPTY DECISION SET IS A REFUSAL, NOT A ZERO (D25.2). `evaluated 0` prints 0.000 with a 0.0
// positive control, which is indistinguishable from "the fair-trade filter finds nothing worth doing".
if (rr.evaluated === 0) {
  console.error(`\nREFUSED: league ${leagueId} produced ZERO evaluated trade decisions over ${seasonsArg} ` +
    "(no fact_roster_week rows for it). Nothing was measured -- a printed 0.000 here would be an empty " +
    "set, not a null result. Pass --league <id> for a league with in-season history.");
  process.exit(3);
}
console.log(line(rr, "REALIZED"));
console.log(line(run(makeSimExpectedScorer(db, { trials: 150, leagueId })), "SIM (distr.)"));
console.log(`\n  NEUTRAL control (RANDOM fair trade, realized): ${rr.randomControl.meanDiff.toFixed(2)} pts  (must be ~0 -- else the edge is a hindsight artifact, not selection)`);
console.log(`  positive control (give our best for their worst): ${rr.control.meanDiff.toFixed(1)} pts  (must be strongly negative)`);
console.log(`  per-season (realized our diff/trade): ${rr.perSeason.map((s) => `${s.season}:${s.meanOurDiff.toFixed(1)}(${s.traded})`).join("  ")}`);
db.close();
