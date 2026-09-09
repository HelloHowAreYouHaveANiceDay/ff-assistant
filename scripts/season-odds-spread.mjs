// DEPRECATED (copilot track, 2026-09-08). Superseded by:  ff copilot season-odds
//   -- src/inseason/copilot.ts :: seasonOdds, also served as an MCP tool (docs/mcp.md).
//
// The computation moved into a callable FUNCTION rather than a program that prints and exits, so
// the desktop Assistant and any MCP client reach the same number this script prints -- which they
// could not do while it lived in a script. Every result now carries its assumptions (real vs
// generated schedule, trials, seeds, data stamp) in the returned JSON.
//
// KEPT, NOT DELETED: docs/validation.md and docs/edges.md cite figures this script produced, and a
// deleted script makes those citations unverifiable. Do not build anything new on it.
// SEASON ODDS, and how far apart the sixteen teams are.
//
//   node --import tsx scripts/season-odds-spread.mjs [trials]
//
// The headline this exists to watch is not any one team's number, it is the SPREAD across teams.
// Resampling weeks independently understated season-total dispersion by roughly 2x, and the visible
// symptom of that is a field that is too easy to tell apart: the best roster's title probability is
// too high and the pack is too tightly ordered behind it, because the simulator never lets a good
// roster have a genuinely bad year. Widening the season distribution should pull the favourite DOWN
// and compress the field.
//
// GENERATED SCHEDULE, always. The real-schedule path opens the league, and a number computed against
// a different schedule cannot be compared with the one before it -- which is the mistake this whole
// file exists to avoid making.
import { loadSimContext } from "../src/draft/simContext.ts";

const TRIALS = Number(process.argv[2] ?? 4000);
const SEEDS = [7, 101, 202];
const ctx = await loadSimContext({ schedule: "generated" });

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };

// Average each team's title/playoff probability over several seeds, so the spread reported below is
// a property of the ROSTERS rather than of one seed's schedule draw.
const perTeam = ctx.teams.map(() => ({ champ: [], playoff: [] }));
for (const s of SEEDS) {
  const res = ctx.run(ctx.teams, TRIALS, s);
  res.forEach((r, i) => { perTeam[i].champ.push(100 * r.champion); perTeam[i].playoff.push(100 * r.playoffs); });
}
const rows = ctx.teams.map((t, i) => ({
  name: t.name, me: i === ctx.meIdx,
  champ: mean(perTeam[i].champ), playoff: mean(perTeam[i].playoff),
}));
rows.sort((a, b) => b.champ - a.champ);

console.log(`schedule: GENERATED (offline, deterministic)   trials ${TRIALS} x ${SEEDS.length} seeds\n`);
console.log("  rank  team                 title%   playoff%");
rows.forEach((r, i) => console.log(
  `  ${String(i + 1).padStart(4)}  ${(r.name + (r.me ? " (us)" : "")).padEnd(20)} ${r.champ.toFixed(2).padStart(6)}   ${r.playoff.toFixed(1).padStart(8)}`));

const champs = rows.map((r) => r.champ);
console.log(`\n  favourite        ${champs[0].toFixed(2)}%`);
console.log(`  median team      ${champs[Math.floor(champs.length / 2)].toFixed(2)}%`);
console.log(`  worst team       ${champs[champs.length - 1].toFixed(2)}%`);
console.log(`  favourite/worst  ${(champs[0] / Math.max(0.01, champs[champs.length - 1])).toFixed(1)}x`);
console.log(`  sd across teams  ${sd(champs).toFixed(2)}pp`);
console.log(`
  A HIGH favourite and a LARGE spread are what an over-confident season model looks like: it has
  decided the draft already settled the year. Widening season-total dispersion to its measured value
  should move both down, and that is the before/after this script is for.`);
