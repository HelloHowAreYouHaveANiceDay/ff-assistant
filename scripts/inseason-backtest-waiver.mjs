// BACKTEST 2 -- WAIVER POLICY AGAINST THE ROOM'S ACTUAL CLAIMS.
//
//   node --import tsx scripts/inseason-backtest-waiver.mjs [--seasons 2018-2025]
import Database from "better-sqlite3";
import { backtestWaivers } from "../src/inseason/backtest/waiver.ts";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const [lo, hi] = arg("--seasons", "2018-2025").split("-").map(Number);
const seasons = []; for (let y = lo; y <= hi; y++) seasons.push(y);

const db = new Database("data/ff.db");
const leagueId = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get().league_id;

const res = {};
for (const model of ["floor", "challenger"]) {
  const { summary: s } = backtestWaivers(db, leagueId, { seasons, model });
  res[model] = s;
  console.log(`\n=== ${model}`);
  console.log(`  weeks with a claim ${s.weeks}   room adds scored ${s.roomAdds}   our adds scored ${s.ourAdds}`);
  console.log(`  the room's add was in our week-w free-agent pool ${(s.poolMatchRate * 100).toFixed(1)}% of the time`);
  console.log(`  realised rest-of-season points per game:  room ${s.roomPpg}   ours ${s.ourPpg}`);
  console.log(`  our top-K beat the room's K in ${(s.weeksWon * 100).toFixed(1)}% of weeks`);
  console.log(`  total realised ROS points: room ${s.roomTotalRos}   ours ${s.ourTotalRos}   on the room's $${s.dollars} of FAAB`);
  console.log(`  per FAAB dollar (DOLLAR-MATCHED -- same claims, same dollars): room ${s.roomPerDollar}   ours ${s.ourPerDollar}`);
  console.log("  season  weeks   room   ours");
  for (const x of s.seasons) console.log(`   ${x.season}  ${String(x.weeks).padStart(5)}  ${String(x.room).padStart(5)}  ${String(x.ours).padStart(5)}`);
}

console.log("\n--- DOES PAYING MORE GET MORE? (the room alone; no model of ours involved)");
console.log("  bucket             n   mean bid   realised ROS pts/game");
for (const b of res.floor.bidBuckets) {
  console.log(`  ${b.bucket.padEnd(16)} ${String(b.n).padStart(4)}   ${String(b.meanBid).padStart(8)}   ${b.meanPpg}`);
}

console.log("\n--- PRE-REGISTERED");
const f = res.floor, c = res.challenger;
const held = (s) => (s.ourPerDollar > s.roomPerDollar ? "HELD" : "FAILED");
console.log(`P38 our recommended adds outscore the room's per FAAB dollar, 2018-2025:`);
console.log(`    floor      ours ${f.ourPerDollar} vs room ${f.roomPerDollar} -> ${held(f)}`);
console.log(`    challenger ours ${c.ourPerDollar} vs room ${c.roomPerDollar} -> ${held(c)}`);
console.log(`    plain per-add: floor ours ${f.ourPpg} vs room ${f.roomPpg}; challenger ours ${c.ourPpg} vs room ${c.roomPpg}`);
console.log("    NOTE: the denominator is the room's own FAAB on BOTH sides, so the per-dollar test");
console.log("    and the per-add test are the same test. Saying so beats printing one number twice.");
db.close();
