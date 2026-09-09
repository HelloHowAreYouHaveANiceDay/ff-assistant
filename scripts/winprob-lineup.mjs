// THE WEEK'S LINEUP UNDER BOTH OBJECTIVES, LIVE AND READ-ONLY.
//
//   node --import tsx scripts/winprob-lineup.mjs [--week N] [--model floor|challenger|both] [--sims 8000]
//
// WHY THIS IS A SCRIPT AND NOT `ff copilot lineup --objective winprob`. It should be the CLI flag,
// and the plumbing for it is one line in `src/inseason/copilotActions.ts`'s dispatcher plus one in
// `cmdCopilot`. Both files are outside this track's file fence -- other agents are editing them in
// parallel -- so the flag is deferred and this script is the caller in the meantime. It reaches the
// SAME function the flag would (`lineupRecommend`), through the same context loader and the same
// store readers, and it writes the same D3 action-log row BEFORE returning an answer, so nothing
// about the number differs from what the flag will print. What is missing is only the flag.
//
// NOTHING HERE WRITES TO ESPN. It reads the league through the app bridge, reads the store, and
// prints. The default objective is unchanged -- `expected` is what `ff copilot lineup` and every MCP
// consumer still get; this prints both so the owner can see the trade before deciding.
import { readFileSync } from "node:fs";
import { openDb, logAction } from "../src/db/db.ts";
import { dataPath } from "../src/data/paths.ts";
import { copilotContext } from "../src/inseason/copilotActions.ts";
import { lineupRecommend, lineupNameKey } from "../src/inseason/copilot.ts";
import { loadAvailability, loadProvenance, currentWeek } from "../src/inseason/copilotStore.ts";
import { loadWeeklyRows } from "../src/weekly/features.ts";
import {
  loadWeeklyArtifact, projectWeekly, SHIPPED_WEEKLY_ARTIFACT, CHALLENGER_WEEKLY_ARTIFACT,
} from "../src/weekly/projector.ts";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const which = arg("--model", "both");
const sims = Number(arg("--sims", 8000));

const ctx = await copilotContext("real");
const week = process.argv.includes("--week") ? Number(arg("--week")) : currentWeek().week;
const weekSource = process.argv.includes("--week") ? "caller" : currentWeek().source;

/** Means AND bands from one artifact, keyed the way `lineupRecommend` looks a roster player up. */
function projectionsFor(file) {
  const artifact = loadWeeklyArtifact(JSON.parse(readFileSync(dataPath(file), "utf8")));
  const db = openDb();
  let rows;
  try { rows = loadWeeklyRows(db, ctx.season, week); } finally { db.close(); }
  const weekly = new Map(), bands = new Map();
  for (const p of projectWeekly({ artifact, rows })) {
    const k = lineupNameKey(p.name);
    const prev = weekly.get(k);
    if (prev == null || p.mean > prev) {
      weekly.set(k, p.mean);
      bands.set(k, { mean: p.mean, p10: p.p10, p50: p.p50, p90: p.p90, pZero: p.pZero ?? null });
    }
  }
  return { weekly, bands, rows: rows.length };
}

const MODELS = which === "both"
  ? [["floor (SHIPPED)", SHIPPED_WEEKLY_ARTIFACT], ["challenger", CHALLENGER_WEEKLY_ARTIFACT]]
  : which === "floor" ? [["floor (SHIPPED)", SHIPPED_WEEKLY_ARTIFACT]] : [["challenger", CHALLENGER_WEEKLY_ARTIFACT]];

const availability = loadAvailability();
const provenance = loadProvenance();
const line = (s) => console.log(s);

console.log(`=== WEEK ${week} (${weekSource}), season ${ctx.season}, schedule ${ctx.syntheticSchedule ? "GENERATED" : "REAL"}`);
if (ctx.syntheticSchedule) {
  console.error("the real schedule was unreachable -- winprob would be a probability against an invented opponent, and it refuses. Start the app.");
  process.exit(2);
}

for (const [label, file] of MODELS) {
  const { weekly, bands, rows } = projectionsFor(file);
  console.log(`\n--- ARTIFACT: ${label}  (${file}, ${rows} feature rows for the week, ${bands.size} projected)`);

  // D3: the recommendation is LOGGED before it is returned, exactly as the dispatcher does it.
  const db = openDb();
  const logId = logAction(db, { runType: "copilot", action: "lineup_recommend", detail: { args: { week, objective: "both", artifact: file, sims } } });

  const ep = lineupRecommend(ctx, week, { provenance, availability, weekly, bands });
  const wp = lineupRecommend(ctx, week, { provenance, availability, weekly, bands, objective: "winprob", winprob: { sims, seed: 7 } });

  const w = wp.winprob;
  line(`OPPONENT: ${w.opponent} (team ${w.opponentTeamId}).  our projected ${w.epTotalProj} vs his ${w.oppMeanTotal} (sd ${w.oppSdTotal}) -- margin ${w.projMargin >= 0 ? "+" : ""}${w.projMargin}, posture ${w.posture.toUpperCase()}`);
  line("");
  line(`  EXPECTED-POINTS lineup   ${ep.totalProj} proj pts   P(win) ${w.epWinPct}%   <- WHAT SHIPS TODAY`);
  for (const s of ep.starters) line(`     ${s.slot.padEnd(5)} ${s.name.padEnd(26)} ${String(s.proj).padStart(6)}`);
  line("");
  line(`  WIN-PROBABILITY lineup   ${wp.totalProj} proj pts   P(win) ${w.winPct}%   (${w.gainPp >= 0 ? "+" : ""}${w.gainPp}pp, costing ${w.epCostPts} proj pts)`);
  for (const s of wp.starters) line(`     ${s.slot.padEnd(5)} ${s.name.padEnd(26)} ${String(s.proj).padStart(6)}`);
  line("");
  if (!w.swaps.length) line("  NO SWAP IMPROVED P(win) -- the two lineups are identical.");
  for (const s of w.swaps) {
    line(`  SWAP  ${s.out} -> ${s.in} (${s.slot}): ${s.winPp >= 0 ? "+" : ""}${s.winPp}pp, costing ${s.epCost} proj pts; sd ${s.sdDelta >= 0 ? "+" : ""}${s.sdDelta}, p10 ${s.p10Delta >= 0 ? "+" : ""}${s.p10Delta}`);
    line(`        ${s.why}`);
  }
  line(`  search: ${w.evaluated} candidate lineups over ${w.passes} pass(es), ${w.sims} sims, coupling ${w.coupling}, ${w.pointMass} point mass(es)`);
  if (ep.unavailable.length) line(`  OUT/bye: ${ep.unavailable.map((u) => `${u.name} (${u.reason})`).join(", ")}`);
  line("  CAVEATS:");
  for (const c of w.caveats) line(`    - ${c}`);
  line(`  ${ep.assumptions.basisNote}`);

  db.prepare("UPDATE action_log SET status=?, reason=? WHERE id=?").run(
    "recommended",
    `week ${week} [${file}] EP ${ep.totalProj}pts P(win) ${w.epWinPct}% vs WINPROB ${wp.totalProj}pts P(win) ${w.winPct}% against ${w.opponent}; ${w.swaps.length} swap(s). DEFAULT OBJECTIVE UNCHANGED (expected).`.slice(0, 2000),
    logId,
  );
  db.close();
  line(`  (logged to action_log #${logId} at status "recommended")`);
}

console.log("\nTHE DEFAULT DID NOT CHANGE. `ff copilot lineup` and every MCP consumer still get the");
console.log("EXPECTED-POINTS lineup. docs/validation.md records why: the 2018-2025 replay measured the");
console.log("win-probability lineup at -0.59pp of team-weeks won, so making it the default would be");
console.log("shipping a measured regression.");
