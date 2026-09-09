// DEPRECATED (copilot track, 2026-09-08). Superseded by:  ff copilot waivers
//   -- src/inseason/copilot.ts :: waiverTargets, also served as an MCP tool (docs/mcp.md).
//
// The computation moved into a callable FUNCTION rather than a program that prints and exits, so
// the desktop Assistant and any MCP client reach the same number this script prints -- which they
// could not do while it lived in a script. Every result now carries its assumptions (real vs
// generated schedule, trials, seeds, data stamp) in the returned JSON.
//
// KEPT, NOT DELETED: docs/validation.md and docs/edges.md cite figures this script produced, and a
// deleted script makes those citations unverifiable. Do not build anything new on it.
// WHICH ADD/DROP ACTUALLY HELPS? Waiver moves scored by simulated championship odds.
//
//   node --import tsx scripts/waiver-check.mjs "Braelon Allen" [trials]
//
// A waiver claim is two decisions and the second is the one people get wrong. WHO TO ADD is usually
// obvious; WHO TO DROP is a comparison between players who all look expendable because none of them
// start. They are not equivalent: a benched receiver on a six-receiver roster is genuinely idle,
// while a second tight end is the only thing standing between you and an empty TE slot.
//
// Scored the same way as trades -- change in title probability over the real schedule and the real
// sixteen rosters -- because points cannot see a mandatory slot going empty, and expected points
// cannot see that our league pays on a threshold and then top-heavy.
//
// Several seeds per option, and the standard error is reported. Drop candidates sit close together
// by construction, so a ranking without its own error bars would be an invitation to read noise.
import { loadSimContext } from "../src/draft/simContext.ts";
import { rosterGaps } from "../src/draft/season.ts";

const ADD = process.argv[2] ?? "Braelon Allen";
const TRIALS = Number(process.argv[3] ?? 3000);
const SEEDS = [7, 101, 202, 303];

// Shared context -- same rosters, schedule and config-derived options as every other tool. This
// script previously built its own and used the REAL schedule while positional-value used a
// GENERATED one, so their base probabilities differed and were still compared side by side.
const ctx = await loadSimContext();
const baseTeams = ctx.teams, meIdx = ctx.meIdx, board = ctx.board, owned = ctx.ownedIds;
const run = (teams, seed) => 100 * ctx.run(teams, TRIALS, seed)[meIdx].champion;
const clone = () => ctx.clone();
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };

// board is keyed by name_key; the CLI takes a display name.
const { nameKey } = await import("../src/draft/values.ts");
const addKey = nameKey(ADD);
const addP = board.get(addKey);
if (!addP) { console.log(`"${ADD}" is not on the board -- check the spelling.`); process.exit(1); }
if (owned.has(addKey)) { console.log(`"${ADD}" is already rostered in this league -- not a waiver add.`); process.exit(1); }

const baseBySeed = SEEDS.map((s) => run(baseTeams, s));
console.log(`ADD ${ADD} (${addP.pos}, ${addP.proj.toFixed(0)} proj) -- ${TRIALS} trials x ${SEEDS.length} seeds`);
console.log(`  BASE: ${mean(baseBySeed).toFixed(2)}% title\n`);
console.log("  drop                   pos   proj    title after   delta    +/-SE");

// Some drops are not options at all. Dropping the only kicker to roster a fourth back leaves a slot
// that scores zero every week, and no manager does that -- he claims another kicker instead. Before
// the roster guard existed this script simulated it anyway and returned a number; now it would throw
// mid-run. Neither is right: the honest answer is to name the candidate and say why it is excluded,
// because scoring it as an empty slot overstates the cost of a move nobody would make that way.
const rows = [], illegal = [];
for (const cand of baseTeams[meIdx].roster) {
  const probe = clone();
  probe[meIdx].roster = probe[meIdx].roster.filter((p) => p.name !== cand.name).concat([{ ...addP }]);
  const gaps = rosterGaps([probe[meIdx]], ctx.slots, ctx.flexOk);
  if (gaps.length) {
    illegal.push({ name: cand.name, pos: cand.pos, why: gaps[0].replace(/^[^:]*:\s*/, "") });
    continue;
  }
  const after = SEEDS.map((s, i) => {
    const teams = clone();
    teams[meIdx].roster = teams[meIdx].roster.filter((p) => p.name !== cand.name)
      .concat([{ ...addP }]);
    return run(teams, s) - baseBySeed[i];
  });
  rows.push({ name: cand.name, pos: cand.pos, proj: cand.proj, d: mean(after), se: sd(after) / Math.sqrt(SEEDS.length) });
}
rows.sort((a, b) => b.d - a.d);
for (const r of rows) {
  console.log(`  ${r.name.slice(0, 21).padEnd(21)} ${r.pos.padEnd(4)} ${r.proj.toFixed(0).padStart(5)}  ` +
    `${(mean(baseBySeed) + r.d).toFixed(2)}%`.padStart(11) + `  ${(r.d >= 0 ? "+" : "") + r.d.toFixed(2)}pp`.padStart(9) + `  +/-${r.se.toFixed(2)}`);
}
if (illegal.length) {
  console.log(`\n  NOT REAL OPTIONS -- dropping these leaves a slot nothing can fill, so you would be`);
  console.log(`  claiming a replacement at that position instead, not fielding an empty one:`);
  for (const r of illegal) console.log(`    ${r.name.slice(0, 21).padEnd(21)} ${r.pos.padEnd(4)} -- ${r.why}`);
}
console.log(`
  A positive delta means the claim is worth making by dropping that man. Options whose deltas
  overlap within their SEs are not distinguishable -- pick between them on something the simulator
  does not model (upcoming schedule, injury news, who you would rather hold in December).`);
