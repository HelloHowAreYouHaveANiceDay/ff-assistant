// MULTI-PLAYER PACKAGE TRADES (borrowed from arXiv 2111.02859 / 2511.17535: trades as a knapsack over
// packages). Extends the validated one-for-one trade edge (#10, +5 pts) to 2-for-1 / 1-for-2 / 2-for-2.
// Each config SUBSUMES the smaller ones (the search includes singletons), so the question is how much
// the extra flexibility -- consolidate surplus into a stud (2-for-1), or add depth (1-for-2) -- adds
// over the one-for-one, and whether the extra realized value survives the random-trade control.
//   node --import tsx scripts/inseason-backtest-trade-package.mjs [--seasons 2018-2024] [--league <id>]
//
// WHICH LEAGUE (D-2, 2026-09-16 -- D25.2's fix applied to this sibling). `ORDER BY last_synced_at DESC
// LIMIT 1` returns the last-SYNCED league, not the ACTIVE one, and on a two-league store that is Yahoo
// 129048 with no roster history -- four rows of 0.000 that read as "packages add nothing". Now: the one
// resolver, `--league <id>`, and a refusal on an empty set.
import { openDb } from "../src/db/db.ts";
import { backtestTrades } from "../src/inseason/backtest/trades.ts";
import { resolveLeagueContext, requireLeagueId } from "../src/data/leagueContext.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const seasonsArg = arg("--seasons", "2018-2024");
const [lo, hi] = seasonsArg.split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const db = openDb(arg("--db", undefined));
const leagueId = requireLeagueId(resolveLeagueContext(db, arg("--league", undefined)), "inseason-backtest-trade-package");

const run = (maxGive, maxGet) => backtestTrades(db, { leagueId, seasons, model: "served", gap: 3, mutual: true, maxGive, maxGet });

console.log(`\nPACKAGE TRADES vs one-for-one (realized rest-of-season), ${seasonsArg}`);
console.log(`  config        our diff/dec   CI [lo, hi]        P(better)   traded    random ctrl`);
for (const [g, t, label] of [[1, 1, "1-for-1 (#10)"], [2, 1, "2-for-1"], [1, 2, "1-for-2"], [2, 2, "2-for-2"]]) {
  const t0 = Date.now();
  const r = run(g, t);
  // AN EMPTY DECISION SET IS A REFUSAL, NOT A ZERO (D25.2) -- a monotone column of 0.000 over an empty
  // set reads exactly like "the extra flexibility buys nothing".
  if (r.evaluated === 0) {
    console.error(`\nREFUSED: league ${leagueId} produced ZERO evaluated trade decisions over ${seasonsArg} ` +
      "(no fact_roster_week rows for it). Nothing was measured. Pass --league <id> for a league with " +
      "in-season history.");
    process.exit(3);
  }
  const ci =`[${r.bootstrap.lo.toFixed(2)}, ${r.bootstrap.hi.toFixed(2)}]`;
  console.log(`  ${label.padEnd(14)} ${r.meanOurDiff.toFixed(3).padStart(7)}      ${ci.padEnd(16)}  ${(100 * r.bootstrap.pBetter).toFixed(0).padStart(3)}%      ${String(r.traded).padStart(4)}     ${r.randomControl.meanDiff.toFixed(2).padStart(6)}   (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
console.log(`\n  each config subsumes the smaller ones, so meanDiff is monotone by construction; the real read is`);
console.log(`  the INCREMENT over 1-for-1 and whether the random control stays <=0 (edge is selection, not artifact).`);
db.close();
