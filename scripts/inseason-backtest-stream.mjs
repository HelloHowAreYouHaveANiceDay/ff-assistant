// Single-position streaming value: does starting the best-available body each week (roster + free
// agents) beat holding your rostered guy? A true weekly-churn measure, our-points-only, point-in-time
// choice / actual score. See src/inseason/backtest/streaming.ts.
//   node --import tsx scripts/inseason-backtest-stream.mjs [--seasons 2018-2025] [--model served|floor] [--pos QB,TE,K,DST] [--league <id>]
//
// WHICH LEAGUE (D-2, 2026-09-16 -- D25.2's fix applied to this sibling). `ORDER BY last_synced_at DESC
// LIMIT 1` returns the last-SYNCED league, not the ACTIVE one; on a two-league store that is Yahoo
// 129048, with no `fact_roster_week`/`fact_fa_pool_week` rows for these seasons, so every position
// printed 0.00 over 0 team-weeks. Now: the one resolver, `--league <id>`, and a refusal on an empty set.
import { openDb } from "../src/db/db.ts";
import { backtestStreaming } from "../src/inseason/backtest/streaming.ts";
import { resolveLeagueContext, requireLeagueId } from "../src/data/leagueContext.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const seasonsArg = arg("--seasons", "2018-2025");
const [lo, hi] = seasonsArg.split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const model = arg("--model", "served");
const positions = arg("--pos", "QB,TE,K,DST").split(",").map((s) => s.trim().toUpperCase());
const db = openDb(arg("--db", undefined));
const leagueId = requireLeagueId(resolveLeagueContext(db, arg("--league", undefined)), "inseason-backtest-stream");

const t0 = Date.now();
const r = backtestStreaming(db, { leagueId, seasons, model, positions });
db.close();

// AN EMPTY DECISION SET IS A REFUSAL, NOT A ZERO (D25.2). Every column below is a mean over team-weeks;
// with none, the table prints 0.00 diffs and a [0.00, 0.00] CI that reads as a measured null.
const teamWeeks = r.positions.reduce((n, p) => n + p.teamWeeks, 0);
if (teamWeeks === 0) {
  console.error(`\nREFUSED: league ${leagueId} has ZERO scored team-weeks over ${seasonsArg} at ${positions.join(",")} ` +
    "(no fact_roster_week / fact_fa_pool_week rows for it). Nothing was measured. " +
    "Pass --league <id> for a league with in-season history.");
  process.exit(3);
}

console.log(`\nSTREAMING VALUE -- stream best-available vs HOLD your rostered guy, ${model} model, seasons ${seasonsArg}`);
console.log(`  points are per team-week at the position; diff = stream - hold (+ => streaming pays); ceiling = perfect-hindsight streaming (headroom)\n`);
console.log("  pos    hold   stream   diff     CI            P(better)   ceiling   team-weeks");
for (const p of r.positions) {
  console.log(`  ${p.pos.padEnd(5)} ${p.holdPtsPerWeek.toFixed(2).padStart(6)} ${p.streamPtsPerWeek.toFixed(2).padStart(7)} ${p.diffPerWeek.toFixed(2).padStart(6)}   ` +
    `[${p.bootstrap.lo.toFixed(2)}, ${p.bootstrap.hi.toFixed(2)}]`.padEnd(15) + `${(100 * p.bootstrap.pStreamBetter).toFixed(0)}%`.padStart(6) +
    `   ${p.ceilingPtsPerWeek.toFixed(2).padStart(6)}   ${String(p.teamWeeks).padStart(7)}`);
}
console.log(`\n  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
