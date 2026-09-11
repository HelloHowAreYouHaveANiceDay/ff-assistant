// MDP-FRONTIER PROBE: our one validated edge is trades (#10, +5 pts full-RoS). The sequential/MDP
// question (recon's "GA with playoff biasing"): does an in-season trade pay in the PLAYOFF WEEKS that
// decide the title -- i.e. does the edge survive being scored only on weeks 15-17? If yes, temporal
// (playoff) weighting of trades is a real sequential frontier; if it evaporates, myopic full-RoS
// trading is fine and the MDP view adds nothing here.
//   node --import tsx scripts/mdp-trade-playoff-probe.mjs [--seasons 2018-2024]
import { openDb } from "../src/db/db.ts";
import { backtestTrades } from "../src/inseason/backtest/trades.ts";
import { realizedRestOfSeason } from "../src/inseason/backtest/harness.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const [lo, hi] = arg("--seasons", "2018-2024").split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const db = openDb(arg("--db", undefined));
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();

// full-RoS scorer (default) vs playoff-window scorer (weeks 15-17 of the frozen post-trade roster)
const playoff = { name: "playoff 15-17", score: (r, ctx) => realizedRestOfSeason(r, { ...ctx, fromWeek: 15, toWeek: 17 }) };
const run = (scorer) => backtestTrades(db, { leagueId: lg.league_id, seasons, model: "served", scorer, gap: 3, mutual: true });

console.log(`\nMDP PROBE -- does the trade edge (#10) survive to the PLAYOFF WEEKS? seasons ${arg("--seasons", "2018-2024")}\n`);
const rr = run(undefined);
const rp = run(playoff);
const line = (r, label) => `  ${label.padEnd(16)} our diff/decision ${r.meanOurDiff.toFixed(3).padStart(7)}  CI [${r.bootstrap.lo.toFixed(2)}, ${r.bootstrap.hi.toFixed(2)}]  P(better) ${(100 * r.bootstrap.pBetter).toFixed(0)}%  (traded ${r.traded})`;
console.log(line(rr, "full rest-of-season"));
console.log(line(rp, "PLAYOFF weeks 15-17"));
console.log(`\n  random-trade control: full ${rr.randomControl.meanDiff.toFixed(2)}, playoff ${rp.randomControl.meanDiff.toFixed(2)}  (both ~<=0)`);
console.log(`\n  read: if the playoff-window edge is positive and CI-clear, trades pay in the games that matter --`);
console.log(`  temporal (playoff) weighting of the trade edge is a real MDP-frontier lever. If it flips ~0/negative,`);
console.log(`  the edge is a regular-season artifact and myopic full-RoS trading is the honest ceiling.`);
db.close();
