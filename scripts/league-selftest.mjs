// Proves the league adaptor layer actually WORKS against the running app -- a green typecheck says
// nothing about whether the fetch returns data.
//
// Includes the fault injections that matter, because the failures this layer exists to prevent all
// look like success: an empty roster reads as "no trades available", and a substring name match
// reads as a confident wrong answer.
//
//   node scripts/league-selftest.mjs
import { openLeague, resolvePlayer, freeAgentsWithProj } from "../src/league/index.ts";

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? "   " + detail : ""}`);
  if (!cond) fails++;
};

console.log("opening league via the adaptor...");
const lg = await openLeague();
console.log(`  platform: ${lg.provider.platform}   season ${lg.season}   ${lg.teams.length} teams\n`);

console.log("POSITIVE CONTROLS -- the layer can return real data");
ok(lg.teams.length > 1, "teams() returned a league", `${lg.teams.length} teams`);
ok(lg.me && lg.me.roster.length > 0, "myTeam() has a roster", `${lg.me?.roster.length} players`);
ok(lg.teams.filter((t) => t.mine).length === 1, "exactly one team is flagged mine");
const projected = lg.me.roster.filter((p) => p.proj > 0).length;
ok(projected >= lg.me.roster.length - 2, "our valuation attached to the roster", `${projected}/${lg.me.roster.length} have a projection`);
const withTeam = lg.me.roster.filter((p) => p.team).length;
ok(withTeam > 0, "NFL team attached (needed for SOS joins)", `${withTeam}/${lg.me.roster.length}`);
const base = lg.score(lg.me.roster);
ok(base > 0, "score() computes an optimal lineup", `${base.toFixed(0)} pts`);
ok(Array.isArray(lg.slots) && lg.slots.length > 0, "slots came from the league", lg.slots.join(","));
ok(lg.playoffWeeks.length > 0, "playoff weeks DERIVED, not hardcoded",
  `regWeeks ${lg.regWeeks} -> weeks ${lg.playoffWeeks.join("/")}`);

console.log("\nFAULT INJECTION -- resolvePlayer must refuse what /hall/i accepted");
const real = lg.me.roster[0].name;
try { ok(resolvePlayer(lg.me.roster, real).name === real, "exact name resolves", real); }
catch (e) { ok(false, "exact name resolves", e.message); }

// The actual bug, on a FIXED fixture: these cases must not depend on who happens to be rostered
// today (a first draft appended "Breece Hall" to a roster that already had him, and the resolver
// correctly refused the duplicate -- a broken test, not broken code).
const decoy = [
  { name: "Breece Hall", pos: "RB", proj: 205 },
  { name: "Brandon Marshall", pos: "WR", proj: 90 },
  { name: "Puka Nacua", pos: "WR", proj: 210 },
];
try {
  const got = resolvePlayer(decoy, "hall");
  ok(false, "ambiguous 'hall' must throw", `instead returned ${got.name} -- this is the /hall/i bug`);
} catch (e) {
  ok(/matches 2 players/.test(e.message) && /Marshall/.test(e.message),
    "ambiguous 'hall' throws and names the candidates", e.message.slice(0, 68));
}
// and the positive value: the same query, made specific, must RESOLVE (a guard that can only ever
// refuse is dead code that reads exactly like a working guard)
try { ok(resolvePlayer(decoy, "Breece").name === "Breece Hall", "a unique substring still resolves", "'Breece' -> Breece Hall"); }
catch (e) { ok(false, "a unique substring still resolves", e.message); }
try {
  resolvePlayer(lg.me.roster, "Nobody McNothing");
  ok(false, "unknown name must throw");
} catch (e) { ok(/matches nobody/.test(e.message), "unknown name throws"); }
// exact match must win even when the name is a substring of another entry
const shadow = [{ name: "Josh Allen", pos: "QB", proj: 300 }, { name: "Josh Allen Jr.", pos: "RB", proj: 40 }];
try {
  ok(resolvePlayer(shadow, "Josh Allen").name === "Josh Allen", "exact match beats a longer substring hit");
} catch (e) { ok(false, "exact match beats a longer substring hit", e.message); }

console.log("\nFREE AGENTS");
try {
  const fas = await freeAgentsWithProj(lg, 50);
  ok(fas.length > 0, "freeAgents() returned players", `${fas.length} with a projection`);
  ok(fas.every((f) => typeof f.pctOwned === "number"), "ownership normalized");
} catch (e) { ok(false, "freeAgents()", e.message); }

await lg.close();
console.log(fails ? `\n${fails} FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
