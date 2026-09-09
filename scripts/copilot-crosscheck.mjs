// CROSS-CHECK THE COPILOT AGAINST THE REAL LEAGUE, read-only.
//
//   node --import tsx scripts/copilot-crosscheck.mjs [--week N] [--schedule real|generated|auto]
//
// WHY A SCRIPT AND NOT A TEST. test/copilot.test.ts asserts these same properties on a fixture, and
// that is the right place for them: the fixture runs on a clean clone with no store, no app and no
// league. But a fixture cannot tell you that the REAL store's bye column arrived populated, that the
// REAL injury table joins on the key the optimizer looks up, or that the REAL schedule produced a
// bracket that crowns exactly one champion. Those are properties of the data, and they can only be
// checked against the data -- which is gitignored, so it cannot live in the suite.
//
// This is deliberately the "prove the lever is CONNECTED" check from CLAUDE.md rather than a smoke
// test. Two of the four assertions below are POSITIVE CONTROLS: they fail if the availability signal
// never reaches the optimizer, which is the failure mode that produces a completely normal-looking
// lineup starting a man who is not playing.
import { runCopilot } from "../src/inseason/copilotActions.ts";
import { loadAvailability, currentWeek } from "../src/inseason/copilotStore.ts";
import { nameKey } from "../src/draft/values.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const schedule = arg("--schedule", "auto");
const week = Number(arg("--week", String(currentWeek().week)));

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${label}${detail ? `  --  ${detail}` : ""}`);
};

console.log(`COPILOT CROSS-CHECK -- schedule ${schedule}, week ${week}\n`);

// --- 1. SEASON ODDS: the conservation laws, on the REAL rosters and the REAL schedule ------------
const odds = (await runCopilot("season_odds", { schedule, trials: 3000 })).result;
console.log(`SEASON ODDS (${odds.assumptions.schedule} schedule, ${odds.assumptions.trials} trials)`);
const sumTitles = odds.teams.reduce((a, t) => a + t.champion, 0);
const sumPlayoffs = odds.teams.reduce((a, t) => a + t.playoffs, 0);
check("title shares sum to exactly one champion per season", Math.abs(sumTitles - 1) < 0.02, `got ${sumTitles.toFixed(4)}`);
check(`playoff shares sum to the ${odds.playoffTeams}-team field`, Math.abs(sumPlayoffs - odds.playoffTeams) < 0.05, `got ${sumPlayoffs.toFixed(4)}`);
check("every team in the league appears exactly once", new Set(odds.teams.map((t) => t.id)).size === odds.teams.length, `${odds.teams.length} teams`);
check("exactly one team is flagged as ours", odds.teams.filter((t) => t.us).length === 1, odds.us.name);

// --- 2. LINEUP: nobody started who cannot play, checked against the SOURCE -----------------------
const avail = loadAvailability();
const lineup = (await runCopilot("lineup_recommend", { schedule, week })).result;
console.log(`\nLINEUP week ${lineup.week} (weekSource: ${lineup.weekSource})`);
const startedNames = lineup.starters.filter((s) => s.name !== "(empty)").map((s) => s.name);
const outStarters = startedNames.filter((n) => avail.get(nameKey(n))?.status === "OUT");
check("no starter is ruled OUT in the store", outStarters.length === 0, outStarters.join(", ") || "none");
const byeStarters = lineup.unavailable.filter((u) => startedNames.includes(u.name));
check("no starter appears in the unavailable list (bye or OUT)", byeStarters.length === 0, byeStarters.map((b) => `${b.name}: ${b.reason}`).join("; ") || "none");

// POSITIVE CONTROL. The two checks above pass trivially if the availability signal never arrives --
// an empty map means nothing is ever unavailable, and both assertions hold vacuously. So prove the
// signal exists AND reaches the roster: the store must carry OUT designations at all, and across the
// season our own roster must hit at least one bye week. A roster where no player is ever unavailable
// in any week is not a healthy roster, it is a disconnected bye column.
check("the store carries OUT designations at all", [...avail.values()].some((v) => v.status === "OUT"),
  `${[...avail.values()].filter((v) => v.status === "OUT").length} OUT / ${avail.size} rows`);
let byeWeeksSeen = 0;
for (let w = 1; w <= 18; w++) {
  const r = (await runCopilot("lineup_recommend", { schedule, week: w })).result;
  if (r.unavailable.length) byeWeeksSeen++;
}
check("our roster is unavailable somewhere across weeks 1-18 (the bye column is connected)", byeWeeksSeen > 0,
  `${byeWeeksSeen} of 18 weeks have at least one unavailable player`);

// --- 3. FAULT INJECTION: prove the OUT check above can actually fail ----------------------------
// Green output is not evidence that a check is connected -- a check whose input never reaches the
// thing being checked reports success and nothing distinguishes that from real success. So feed the
// same predicate a lineup that MUST violate it: whoever the store currently rules out, started.
console.log("\nFAULT INJECTION (these must be the mirror image of the checks above)");
const anOut = [...avail.entries()].find(([, v]) => v.status === "OUT");
if (!anOut) {
  console.log("  SKIP  the store rules nobody out today, so this injection has nothing to inject");
} else {
  // `avail` is keyed by name_key, and a name_key is already letters-only, so passing the key itself
  // through the same predicate exercises the real lookup rather than a reimplementation of it.
  const outs = (names) => names.filter((n) => avail.get(nameKey(n))?.status === "OUT");
  check("a clean lineup is still reported clean (no false positive)", outs(startedNames).length === 0, `${outs(startedNames).length} flagged`);
  check("a lineup containing an OUT player IS flagged (the check can fire)", outs([...startedNames, anOut[0]]).length === 1,
    `injected ${anOut[0]} (${anOut[1].detail ?? anOut[1].status}) and the check flagged it`);
}

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : "ALL CHECKS PASSED"}`);
process.exit(failures ? 1 : 0);
