// Did this league CHANGE its format? Reads settings for several past seasons through the league
// adaptor and diffs the PPR value, roster shape, size and auction budget.
//
//   node --import tsx scripts/scoring-history.mjs [firstSeason] [lastSeason]
//
// WHY IT MATTERS. If the league moved 0 -> 0.5 PPR this year, every prior year's spend history
// UNDERSTATES what the room will now pay for pass-catchers -- and any tendency doc or opponent
// model built on that history is calibrated to a format that no longer exists.
//
// Read-only. The desktop app must be open and logged in.
import { openLeague } from "../src/league/index.ts";

const lg = await openLeague();
if (!lg.provider.history) {
  console.log(`the ${lg.provider.platform} adaptor does not expose league history.`);
  await lg.close(); process.exit(1);
}
const first = Number(process.argv[2] ?? lg.season - 3);
const last = Number(process.argv[3] ?? lg.season);
const seasons = [];
for (let y = first; y <= last; y++) seasons.push(y);

console.log(`FORMAT HISTORY -- seasons ${first}-${last}\n`);
const snaps = await lg.provider.history(seasons);
await lg.close();

for (const s of snaps) {
  if (!s.available) { console.log(`  ${s.season}: unavailable -- ${s.note ?? "no data"}`); continue; }
  const slots = Object.entries(s.slotCounts).map(([k, n]) => `${k}x${n}`).join(" ");
  console.log(`  ${s.season}: reception pts = ${s.pprPoints ?? "?"}  | teams ${s.size ?? "?"} | budget $${s.auctionBudget ?? "?"} | ${slots}`);
}

// --- the verdict, as a check that can FAIL ------------------------------------------------------
const known = snaps.filter((s) => s.available && s.pprPoints !== null);
console.log("");
if (known.length < 2) { console.log("VERDICT: not enough seasons returned data to diff."); process.exit(0); }

const ppr = [...new Set(known.map((s) => s.pprPoints))];
if (ppr.length === 1) {
  console.log(`VERDICT: scoring UNCHANGED across ${known.map((s) => s.season).join(", ")} -- reception pts = ${ppr[0]} every year.`);
} else {
  console.log(`VERDICT: scoring CHANGED. reception pts by season:`);
  for (const s of known) console.log(`    ${s.season}  ${s.pprPoints}`);
  console.log(`  Spend history from the earlier format understates pass-catcher prices under the newer one.`);
}

const sizes = [...new Set(known.map((s) => s.size).filter((x) => x != null))];
if (sizes.length > 1) console.log(`  NOTE: league SIZE changed across seasons (${sizes.join(", ")}) -- per-team budgets and`);
if (sizes.length > 1) console.log(`  scarcity differ, so cross-season spend comparisons need normalising.`);
const budgets = [...new Set(known.map((s) => s.auctionBudget).filter((x) => x != null))];
if (budgets.length > 1) console.log(`  NOTE: auction BUDGET changed (${budgets.join(", ")}) -- compare spend SHARES, not dollars.`);
const shapes = [...new Set(known.map((s) => JSON.stringify(s.slotCounts)))];
if (shapes.length > 1) console.log(`  NOTE: roster SHAPE changed across seasons -- the value curve is not comparable year to year.`);
