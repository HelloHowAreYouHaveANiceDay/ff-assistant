// What are THIS league's actual acquisition rules? Waivers vs free-for-all, FAAB vs rolling order,
// process day, roster/acquisition limits. Read from the platform rather than assumed -- these vary
// per league and drive whether you claim tonight or race at the free-agent open.
//
//   node --import tsx scripts/waiver-rules.mjs
import { openLeague } from "../src/league/index.ts";

const lg = await openLeague();
if (!lg.provider.acquisitionRules) {
  console.log(`the ${lg.provider.platform} adaptor does not expose acquisition rules.`);
  await lg.close(); process.exit(1);
}
const a = await lg.provider.acquisitionRules();

console.log(`${lg.season} -- acquisition rules\n`);
console.log(`  waivers in use          ${a.waivers ? "YES" : "no -- free agency is first-come, first-served"}`);
console.log(`  FAAB budget             ${a.faabBudget != null ? `YES, $${a.faabBudget}` : "no -- waiver ORDER, not bidding"}`);
console.log(`  waiver process days     ${a.processDays.join(", ") || "(none listed)"}`);
console.log(`  waiver process hour     ${a.processHour ?? "?"} (league timezone)`);
console.log(`  acquisition limit       ${a.seasonLimit ?? "unlimited"} per season`);
console.log(`  weekly acquisition cap  ${a.weeklyLimit ?? "unlimited"}`);

console.log(`\nWhat this means in practice:`);
if (!a.waivers) {
  console.log(`  No waiver period -- adds are FIRST COME, FIRST SERVED. Speed matters, budget does not.`);
} else if (a.faabBudget != null) {
  console.log(`  Blind FAAB bidding. A claim wins on DOLLARS, not on being early, so there is no`);
  console.log(`  advantage to claiming the moment you decide -- only to bidding the right amount.`);
} else {
  console.log(`  Rolling waiver ORDER. Your position is the currency; using it drops you to the back,`);
  console.log(`  so spend it on a player who actually changes your lineup, not on depth.`);
}
await lg.close();
