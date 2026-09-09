// BACKTEST 1b -- THE WIN-PROBABILITY LINEUP AGAINST THIS LEAGUE'S REAL MATCHUPS.
//
//   node --import tsx scripts/winprob-backtest.mjs [--seasons 2018-2025] [--sims 1200] [--no-search]
//
// Every team-week with a named opponent, under BOTH weekly artifacts: what the manager started,
// what the expected-points lineup would have scored, what the win-probability lineup would have
// scored, and what hindsight had available -- all four scored against the OPPONENT'S ACTUAL POINTS
// that week, which is the only bar the league pays out on.
//
// `--no-search` is the FAULT INJECTION. It disables the swap search, so the win-probability lineup
// IS the expected-points lineup; every gain below must then be exactly 0.000, and the share of
// team-weeks where the two differ must be exactly 0. A run that still shows a gain is measuring
// something other than the search.
import Database from "better-sqlite3";
import { backtestWinProbLineups, seasonBootstrapWins } from "../src/inseason/backtest/winprobLineup.ts";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const [lo, hi] = arg("--seasons", "2018-2025").split("-").map(Number);
const seasons = []; for (let y = lo; y <= hi; y++) seasons.push(y);
const sims = Number(arg("--sims", 1200));
const noSearch = process.argv.includes("--no-search");

const signed = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

const db = new Database("data/ff.db");
const leagueId = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get().league_id;

const out = {};
for (const model of ["floor", "challenger"]) {
  const t0 = Date.now();
  const { rows, summary } = backtestWinProbLineups(db, leagueId, { seasons, model, sims, noSearch });
  const boot = seasonBootstrapWins(rows);
  out[model] = { summary, boot };

  console.log(`\n=== ${model}${noSearch ? "   [FAULT INJECTION: SWAP SEARCH DISABLED]" : ""}`);
  console.log(`team-weeks ${summary.teamWeeks}   seasons ${summary.seasons.join(",")}   ${sims} sims/team-week   coupling ${summary.coupling}   ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (Object.keys(summary.skipped).length) {
    for (const [why, n] of Object.entries(summary.skipped)) console.log(`  SKIPPED ${n}: ${why}`);
  }
  const inv = summary.pairedInvariant;
  console.log(`  CONSERVATION: ${inv.name}\n                got ${inv.got}%, want ${inv.want}% +/- ${inv.tol}  -> ${inv.ok ? "ok" : "*** FAILED -- every number below is untrustworthy ***"}`);
  console.log(`  opponent's actual, the bar     ${summary.meanOppActual} pts/wk`);
  console.log(`  the manager                    ${summary.meanManagerPts} pts   ${summary.managerWinPct}% of team-weeks won`);
  console.log(`  expected-points lineup         ${summary.meanEpPts} pts   ${summary.epWinPct}%`);
  console.log(`  WIN-PROBABILITY lineup         ${summary.meanWpPts} pts   ${summary.wpWinPct}%   (${summary.gainPp >= 0 ? "+" : ""}${summary.gainPp}pp)`);
  console.log(`  hindsight optimum              ${(summary.hindsightWinPct).toFixed(1)}%`);
  console.log(`  it differs from the EP lineup in ${(100 * summary.differShare).toFixed(1)}% of team-weeks, giving up ${summary.meanEpCost} projected pts/wk`);
  console.log(`  IT CLAIMED to be buying ${signed(summary.claimedGainPp)}pp under its own sampler, and DELIVERED ${signed(summary.gainPp)}pp`);
  console.log(`  ${(100 * summary.bandFallbackRate).toFixed(1)}% of rostered men had NO band even after the position-shape fallback (point masses)`);
  console.log(`  season bootstrap of the PAIRED win difference: ${boot.meanPp >= 0 ? "+" : ""}${boot.meanPp}pp [${boot.loPp}, ${boot.hiPp}] over ${boot.seasons} seasons, P(>0) = ${boot.pGreaterZero}`);

  console.log("\n  |projected margin|      n     EP win%   WP win%     gain   claimed    differ%   EP cost");
  for (const b of summary.buckets) {
    const label = b.bucket === "under5" ? "under 5" : b.bucket === "5to15" ? "5 to 15" : "over 15";
    console.log(`  ${label.padEnd(18)}${String(b.teamWeeks).padStart(6)}${b.epWinPct.toFixed(2).padStart(11)}${b.wpWinPct.toFixed(2).padStart(10)}${signed(b.gainPp).padStart(9)}${signed(b.claimedGainPp).padStart(10)}${(100 * b.differShare).toFixed(1).padStart(11)}${b.meanEpCost.toFixed(2).padStart(10)}`);
  }
  console.log("\n  season     n    EP win%   WP win%     gain   EP cost");
  for (const s of summary.perSeason) {
    console.log(`  ${s.season}${String(s.teamWeeks).padStart(6)}${s.epWinPct.toFixed(2).padStart(11)}${s.wpWinPct.toFixed(2).padStart(10)}${signed(s.gainPp).padStart(9)}${s.epCost.toFixed(2).padStart(10)}`);
  }
}
db.close();

console.log("\n--- PRE-REGISTERED (Track H)");
const c = out.challenger.summary, f = out.floor.summary;
const cb = out.challenger.boot;
console.log(`P51 the winprob lineup wins >= 1.5pp more team-weeks than the EP lineup, 2018-2025, CHALLENGER:`);
console.log(`    ${c.gainPp >= 0 ? "+" : ""}${c.gainPp}pp [${cb.loPp}, ${cb.hiPp}] -> ${c.gainPp >= 1.5 ? "HELD" : "FAILED"}`);
console.log(`    same under the FLOOR: ${f.gainPp >= 0 ? "+" : ""}${f.gainPp}pp`);
const big = c.buckets.find((b) => b.bucket === "over15"), small = c.buckets.find((b) => b.bucket === "under5");
const mid = c.buckets.find((b) => b.bucket === "5to15");
console.log(`P57 the gain is CONCENTRATED where |projected margin| > 15: under5 ${small.gainPp >= 0 ? "+" : ""}${small.gainPp}pp, 5to15 ${mid.gainPp >= 0 ? "+" : ""}${mid.gainPp}pp, over15 ${big.gainPp >= 0 ? "+" : ""}${big.gainPp}pp`);
console.log(`    -> ${big.gainPp > mid.gainPp && big.gainPp > small.gainPp ? "HELD" : "FAILED"}`);
console.log(`P58 in the under-5 bucket the two lineups differ in < 20% of team-weeks: ${(100 * small.differShare).toFixed(1)}% -> ${small.differShare < 0.20 ? "HELD" : "FAILED"}`);
console.log(`\nEXPECTED-POINTS COST: ${c.meanEpCost} pts/wk overall (challenger); by bucket ` +
  c.buckets.map((b) => `${b.bucket} ${b.meanEpCost}`).join(", "));
