// MULTI-PLAYER PACKAGE TRADES (borrowed from arXiv 2111.02859 / 2511.17535: trades as a knapsack over
// packages). Extends the validated one-for-one trade edge (#10, +5 pts) to 2-for-1 / 1-for-2 / 2-for-2.
// Each config SUBSUMES the smaller ones (the search includes singletons), so the question is how much
// the extra flexibility -- consolidate surplus into a stud (2-for-1), or add depth (1-for-2) -- adds
// over the one-for-one, and whether the extra realized value survives the random-trade control.
//   node --import tsx scripts/inseason-backtest-trade-package.mjs [--seasons 2018-2024]
import { openDb } from "../src/db/db.ts";
import { backtestTrades } from "../src/inseason/backtest/trades.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const seasonsArg = arg("--seasons", "2018-2024");
const [lo, hi] = seasonsArg.split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const db = openDb(arg("--db", undefined));
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
if (!lg) { console.error("no league synced"); process.exit(2); }

const run = (maxGive, maxGet) => backtestTrades(db, { leagueId: lg.league_id, seasons, model: "served", gap: 3, mutual: true, maxGive, maxGet });

console.log(`\nPACKAGE TRADES vs one-for-one (realized rest-of-season), ${seasonsArg}`);
console.log(`  config        our diff/dec   CI [lo, hi]        P(better)   traded    random ctrl`);
for (const [g, t, label] of [[1, 1, "1-for-1 (#10)"], [2, 1, "2-for-1"], [1, 2, "1-for-2"], [2, 2, "2-for-2"]]) {
  const t0 = Date.now();
  const r = run(g, t);
  const ci = `[${r.bootstrap.lo.toFixed(2)}, ${r.bootstrap.hi.toFixed(2)}]`;
  console.log(`  ${label.padEnd(14)} ${r.meanOurDiff.toFixed(3).padStart(7)}      ${ci.padEnd(16)}  ${(100 * r.bootstrap.pBetter).toFixed(0).padStart(3)}%      ${String(r.traded).padStart(4)}     ${r.randomControl.meanDiff.toFixed(2).padStart(6)}   (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
console.log(`\n  each config subsumes the smaller ones, so meanDiff is monotone by construction; the real read is`);
console.log(`  the INCREMENT over 1-for-1 and whether the random control stays <=0 (edge is selection, not artifact).`);
db.close();
