#!/usr/bin/env node
/**
 * `node --import tsx scripts/injury-depth-compare.mjs [--player "Name"] [--trials 600]`
 *
 * THE CONSUMER CHANGE, RUN AGAINST THE REAL LEAGUE, WITH BOTH NUMBERS SIDE BY SIDE.
 *
 * READ-ONLY. It loads the sim context with a GENERATED schedule (no app, no ESPN connection, no
 * write of any kind), finds the men on our roster who carry a live injury designation, and prints,
 * for the most serious of them, `ff copilot depth-risk` as it now answers AND as it answered before
 * Track I -- the variance model's per-tier rate, computed here by the same call the copilot itself
 * makes, so the comparison is between two numbers and not between two harnesses.
 *
 * Why a script and not a flag: the "before" number is not a mode the shipped tool has. Adding one
 * would mean shipping a switch nobody should ever flip, and a switch that is never flipped is a
 * code path that quietly stops working.
 */
import { loadSimContext } from "../src/draft/simContext.ts";
import { depthRisk, handcuffs } from "../src/inseason/copilot.ts";
import { loadInjuryOutlook, emptyOutlookSet } from "../src/inseason/injuryHorizon.ts";
import { loadDepth } from "../src/inseason/copilotStore.ts";
import { nameKey } from "../src/draft/values.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : d; };

const ctx = await loadSimContext({ schedule: "generated" });
const outlook = loadInjuryOutlook({ season: ctx.season });
console.log(`SEASON ${ctx.season} -- injury outlook source: ${outlook.source}, ${outlook.byName.size} men on the report`);
console.log(`  ${outlook.note}\n`);

const ours = ctx.teams[ctx.meIdx].roster;
const hit = ours.map((p) => ({ p, o: outlook.byName.get(nameKey(p.name)) })).filter((x) => x.o);
console.log(`OUR ROSTER (${ours.length}) -- ${hit.length} carry a designation:`);
console.log("  player                     pos   proj   designation      injury          E[games out, next 4]");
for (const { p, o } of hit.sort((a, b) => b.o.expectedGamesOut4 - a.o.expectedGamesOut4)) {
  console.log(`  ${p.name.padEnd(26)} ${p.pos.padEnd(4)} ${String(Math.round(p.proj)).padStart(5)}   ` +
    `${(o.designation || "(none)").padEnd(16)} ${(o.detail || o.injuryGroup || "-").padEnd(15)} ${o.expectedGamesOut4.toFixed(2)}`);
}
if (!hit.length) { console.log("  (nobody) -- nothing to compare."); process.exit(0); }

const want = arg("--player", null);
const target = want
  ? hit.find((x) => nameKey(x.p.name) === nameKey(want))
  : hit.sort((a, b) => b.o.expectedGamesOut4 - a.o.expectedGamesOut4)[0];
if (!target) { console.log(`\n"${want}" is not on our roster with a designation.`); process.exit(2); }

const trials = Number(arg("--trials", "600"));
console.log(`\n=== ff copilot depth-risk "${target.p.name}" (trials ${trials}, GENERATED schedule) ===`);
const now = depthRisk(ctx, target.p.name, { trials, seeds: [7, 101] });
console.log(`  cost if GONE FOR THE SEASON: ${now.costPp} pp of playoffs, ${now.costPlayoffWeekPts} playoff-week pts (noise floor ${now.noiseFloorPp} pp)`);
console.log(`  horizon source: ${now.horizon.source} (evidence: ${now.horizon.evidence})`);
console.log(`    designation ${now.horizon.designation}, injury ${now.horizon.injury}`);
console.log(`    P(miss next k): ${JSON.stringify(now.horizon.pMiss)}`);
console.log(`    E[games out of the next 4]`);
console.log(`      injury model      ${now.horizon.expectedGamesOut4.toFixed(2)}`);
console.log(`      designation only  ${now.horizon.designationOnlyGamesOut4 == null ? "n/a" : now.horizon.designationOnlyGamesOut4.toFixed(2)}`);
console.log(`      PER-TIER RATE     ${now.horizon.tierGamesOut4.toFixed(2)}   <- what this repo used before Track I`);
console.log(`    expected cost over those games: ${now.horizon.expectedCostNext4Pts} pts`);
const tierCost = (now.costPlayoffWeekPts / Math.max(1, ctx.format?.playoffWeeks?.length ?? 3)) * now.horizon.tierGamesOut4;
console.log(`    the SAME figure on the tier rate: ${(Math.round(tierCost * 100) / 100)} pts`);

console.log(`\n=== handcuffs, RB -- the same board with the model, and with the tier rate alone ===`);
const { depth, poolSize, vm } = loadDepth(["RB"]);
const withM = handcuffs(ctx, { depth, vm, poolSize, positions: ["RB"], weeks: 17 });
const without = handcuffs(ctx, { depth, vm, poolSize, positions: ["RB"], weeks: 17, outlook: emptyOutlookSet(outlook.tierMissProb, "comparison run: the injury model deliberately withheld") });
const byName = new Map(without.rows.map((r) => [r.name, r]));
console.log(`  ${withM.injuryPriced} of ${withM.rows.length} rows priced by the injury model (source ${withM.injurySource})`);
console.log("  backup                 lead                  designation    E[games out/4]  expectedPts");
console.log("                                                             model   tier    model   tier");
let shown = 0;
for (const r of withM.rows) {
  if (r.missSource !== "injury-model" || shown >= 8) continue;
  const w = byName.get(r.name);
  console.log(`  ${r.name.padEnd(22)} ${r.lead.padEnd(21)} ${(r.leadDesignation ?? "").padEnd(14)} ` +
    `${r.leadGamesOutNext4.toFixed(2).padStart(5)}  ${r.leadGamesOutNext4Tier.toFixed(2).padStart(5)}   ` +
    `${r.expectedPts.toFixed(1).padStart(5)}  ${(w ? w.expectedPts.toFixed(1) : "-").padStart(5)}`);
  shown++;
}
if (!shown) console.log("  (no lead on the RB board carries a designation this week)");
