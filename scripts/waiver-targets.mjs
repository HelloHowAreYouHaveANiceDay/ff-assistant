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
// Who is available, and what would each ADD to our starting lineup?
//
//   node --import tsx scripts/waiver-targets.mjs
//
// Ranking free agents by raw projection is the obvious mistake: it recommends a WR4 you would never
// start. The number that matters is MARGINAL -- rerun the real lineup optimizer with the player
// added and take the delta. That automatically prices a positional hole (an RB when you roster one
// RB is worth far more than his projection suggests) and correctly values a good player at a
// position you are already deep at near zero.
//
// Bye-week coverage is scored separately: a player available in a week where our only starter at
// that slot is on bye fixes a guaranteed ZERO, which a season-total projection cannot see.
import { openLeague, freeAgentsWithProj, nameKey } from "../src/league/index.ts";

const lg = await openLeague();
const base = lg.score(lg.me.roster);

const byeOf = new Map();
for (const r of lg.db.prepare(
  `SELECT p.name, r.bye FROM player p
     JOIN ranking r ON r.player_id = p.player_id AND r.source='fantasypros_ecr' AND r.season = ?`,
).all(lg.season)) byeOf.set(nameKey(r.name), r.bye);

// Which slots go EMPTY because our only eligible player is on bye?
const byeGaps = {};
for (const p of lg.me.roster) {
  const b = byeOf.get(nameKey(p.name));
  if (b && lg.me.roster.filter((q) => q.pos === p.pos).length === 1) byeGaps[p.pos] = b;
}

const fas = (await freeAgentsWithProj(lg)).map((f) => {
  const bye = byeOf.get(nameKey(f.name)) ?? null;
  return { ...f, bye, delta: lg.score([...lg.me.roster, f]) - base, coversGap: byeGaps[f.pos] != null && bye !== byeGaps[f.pos] };
}).sort((a, z) => z.delta - a.delta || z.proj - a.proj);

console.log(`WAIVER TARGETS -- ${lg.season}`);
console.log(`current optimal starting lineup: ${base.toFixed(0)} projected pts`);
const gapTxt = Object.entries(byeGaps).map(([p, w]) => `${p} (week ${w})`).join(", ");
console.log(`slots that go EMPTY on a bye (sole player at the position): ${gapTxt || "none"}\n`);
console.log("  pos  player                    +starterPts  proj   bye  own%  fixes bye gap");
for (const r of fas.slice(0, 18)) {
  console.log(`  ${r.pos.padEnd(4)} ${r.name.slice(0, 24).padEnd(25)} ${(r.delta > 0 ? "+" : "") + r.delta.toFixed(0)}`.padEnd(46) +
    `${String(r.proj.toFixed(0)).padStart(5)} ${String(r.bye ?? "?").padStart(5)} ${String(r.pctOwned).padStart(4)}%  ${r.coversGap ? "YES" : ""}`);
}
console.log(`\nMARGINAL means: rerun the optimizer with them added, take the delta. A high projection`);
console.log(`with +0 marginal is a player you would never actually start.`);

// --- the WEEKLY question, which season totals cannot answer -------------------------------------
if (Object.keys(byeGaps).length) {
  console.log(`\n=== BYE-WEEK FILLS (often the actual problem) ===`);
  console.log(`A slot with one eligible player scores ZERO on his bye. Per-game = season proj / ${lg.nflWeeks}.`);
  for (const [gapPos, week] of Object.entries(byeGaps)) {
    const cands = fas.filter((r) => r.pos === gapPos && r.bye !== week).sort((a, z) => z.proj - a.proj).slice(0, 6);
    const starter = lg.me.roster.find((p) => p.pos === gapPos);
    console.log(`\n  ${gapPos} -- week ${week} is empty (only ${starter?.name ?? "?"}, and he is on bye)`);
    if (!cands.length) { console.log(`    no eligible ${gapPos} available`); continue; }
    console.log(`    player                     per-game  season  bye  own%`);
    for (const c of cands) {
      console.log(`    ${c.name.slice(0, 24).padEnd(25)} ${(c.proj / lg.nflWeeks).toFixed(1).padStart(7)} ${String(c.proj.toFixed(0)).padStart(7)} ${String(c.bye ?? "?").padStart(4)} ${String(c.pctOwned).padStart(4)}%`);
    }
  }
  console.log(`\n  Cost of doing nothing = one empty slot for one week, roughly the per-game figure`);
  console.log(`  above. Weigh a FAAB bid against that, not against a season-long upgrade.`);
}
await lg.close();
