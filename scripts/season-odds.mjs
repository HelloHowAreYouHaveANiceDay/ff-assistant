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
// Playoff and championship odds for THIS season, from the rosters that actually exist.
//
//   node --import tsx scripts/season-odds.mjs [trials]
//
// Pulls the 16 real rosters and the real schedule through the league adaptor, then runs a forward
// Monte Carlo (src/draft/season.ts). Read the header of that file before quoting any number: the
// output is conditioned on our projections being right ON AVERAGE, and the projection-error draw is
// what separates an honest answer from a confidently wrong one.
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { openLeague, nameKey } from "../src/league/index.ts";
import { simulateSeasons } from "../src/draft/season.ts";

const TRIALS = Number(process.argv[2] ?? 4000);
const vm = JSON.parse(readFileSync("data/variance-model.json", "utf8"));
// BOOTSTRAP is the default sampler: real historical weeks joined on preseason positional rank, with
// NFL teammates correlated. --parametric falls back to the fitted-lognormal path for comparison.
const PARAMETRIC = process.argv.includes("--parametric");
// Read the fitted models with an actionable failure. rank-outcomes.json is 2.1 MB and gitignored, so
// it is exactly the file a fresh clone will be missing -- and a raw ENOENT stack trace names the path
// without saying how to produce it.
const need = (path, how) => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { console.log(`missing ${path}
  rebuild it with:  ${how}
  (or run with --parametric to use the older fitted-lognormal sampler)`); process.exit(1); }
};
const outcomes = PARAMETRIC ? null : need("data/rank-outcomes.json", "node --import tsx scripts/fit-bootstrap.mjs");
const corrModel = PARAMETRIC ? null : need("data/correlation-model.json", "node --import tsx scripts/fit-correlation.mjs");

const lg = await openLeague();
const sched = lg.provider.matchups ? await lg.provider.matchups() : null;
if (!sched) { console.log("adaptor exposes no schedule"); await lg.close(); process.exit(1); }

// bye weeks, so a slot with one eligible body correctly scores zero that week
const byeOf = new Map();
for (const r of lg.db.prepare(
  `SELECT p.name, r.bye FROM player p JOIN ranking r ON r.player_id=p.player_id AND r.source='fantasypros_ecr' AND r.season=?`,
).all(lg.season)) byeOf.set(nameKey(r.name), r.bye);

const idx = new Map(lg.teams.map((t, i) => [t.id, i]));
const teams = lg.teams.map((t) => ({
  id: t.id, name: t.name,
  roster: t.roster.map((p) => ({ name: p.name, pos: p.pos, proj: p.proj, team: p.team, bye: byeOf.get(nameKey(p.name)) ?? null })),
}));
// the REAL schedule, as team indices
const weeks = [];
for (let w = 1; w <= lg.regWeeks; w++) {
  const games = sched.games.filter((g) => g.week === w)
    .map((g) => [idx.get(g.homeId), idx.get(g.awayId)])
    .filter(([a, b]) => a != null && b != null);
  if (games.length) weeks.push(games);
}
// THE PLAYOFF FORMAT COMES FROM THE LEAGUE'S OWN BLOCK. `const playoffTeams = 7` used to sit here:
// right for this league, and unfalsifiable -- the day the field changes, every odds number is quietly
// computed for a league that does not exist. Seeding, the reseed flag and the divisions come from the
// same block, so the bracket simulated here is the bracket ESPN will actually run.
const fmt = lg.format;
const playoffTeams = fmt.playoffTeams;
// team index -> division index, matched by the platform's own team ids.
const divOfTeam = (() => {
  if (fmt.divisions.length < 2) return undefined;
  const m = new Map();
  fmt.divisions.forEach((d, i) => d.teamIds.forEach((id) => m.set(String(id), i)));
  const out = teams.map((t) => m.get(String(t.id)));
  const missing = out.filter((d) => d == null).length;
  if (missing) { console.log(`WARNING: ${missing} team(s) are in no division in the format block -- seeding falls back to record.`); return undefined; }
  return out;
})();
await lg.close();

console.log(`SEASON ODDS -- ${lg.season}, ${teams.length} teams, ${weeks.length} scheduled weeks, ${TRIALS} trials`);
console.log(`variance model fitted on ${vm.seasons.length} seasons; UNFITTED positions: ${vm.unfitted.length ? vm.unfitted.join(", ") : "none -- every position has real weekly data"}\n`);

// POOL RANKS. Tiers in the variance model are positions within the FULL seasonal player pool, so
// they must be supplied from points.csv -- ranking within rostered players instead would map a
// 16-team league's WR4 onto the historical "barely plays" tier. See the note in season.ts.
const poolRank = new Map();
{
  const byPos = {};
  for (const line of readFileSync("data/points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
    const f = line.split(",");
    if (!f[0] || !f[2]) continue;
    const pos = f[1].trim().toUpperCase();
    (byPos[pos] ??= []).push({ name: f[0].trim(), pts: Number(f[2]) });
  }
  for (const [, list] of Object.entries(byPos)) {
    list.sort((a, b) => b.pts - a.pts);
    list.forEach((x, i) => poolRank.set(x.name, { rank: i, of: list.length }));
  }
}
const tierCount = {};
for (const t of teams) for (const p of t.roster) {
  const pr = poolRank.get(p.name);
  const tier = pr ? Math.min(3, Math.floor((pr.rank / pr.of) * 4)) : 0;
  tierCount[tier] = (tierCount[tier] ?? 0) + 1;
}
console.log(`rostered players by fitted tier: ${Object.entries(tierCount).map(([t, n]) => `t${t}=${n}`).join("  ")}`);
console.log(`(a 16-team league rosters mostly tier 0 -- if most land in t2/t3 the tiering is wrong)\n`);

console.log(`sampler: ${outcomes ? "BOOTSTRAP (real weeks by preseason rank) + correlated NFL teammates" : "parametric lognormal"}
`);
const base = { weeks: weeks.length, playoffTeams, seeding: fmt.seeding, divisionOf: divOfTeam,
  playoffReseed: fmt.playoffReseed, playoffWeekCount: fmt.playoffWeeks.length,
  slots: lg.slots, projSd: 0.30, trials: TRIALS, seed: 7, poolRank,
  ...(outcomes ? { bootstrap: { outcomes, corr: corrModel, calibration: "scale" } } : {}) };
// Surface what the calibration guard refused to trust. A pool ratio far from 1 is a BROKEN
// PROJECTION, not a modelling choice, and it must not stay invisible just because the guard handled
// it safely -- silently-correct is how a defect survives.
if (outcomes) {
  const { prepare } = await import("../src/draft/bootstrap.ts");
  const pp = lg.me.roster.map((p) => ({ name: p.name, pos: p.pos, team: p.team,
    rank: (poolRank.get(p.name)?.rank ?? 0) + 1, projPerGame: p.proj / 17 }));
  const { uncalibrated } = prepare(pp, outcomes, corrModel, "scale");
  if (uncalibrated.length) {
    const byPos = {};
    for (const u of uncalibrated) (byPos[u.pos] ??= []).push(u.ratio);
    console.log(`  WARNING -- ${uncalibrated.length} of our players have a projection the pools do not support,`);
    console.log(`  so their pools were left at the HISTORICAL level rather than rescaled:`);
    for (const [pos, rs] of Object.entries(byPos)) {
      console.log(`    ${pos}: our projection is ${(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2)}x the real pool mean (${rs.length} player(s))`);
    }
    console.log(`  This is a defect in points.csv, not in the simulator. See scripts/bootstrap-calibration.mjs.
`);
  }
}

const odds = simulateSeasons(teams, weeks, vm, base);

const rows = [...odds].sort((a, z) => z.playoffs - a.playoffs);
console.log("  team                          playoff%   title%   mean W   mean pts");
for (const r of rows) {
  const us = r.id === lg.me.id ? "   <<< US" : "";
  console.log(`  ${r.name.slice(0, 28).padEnd(29)} ${(r.playoffs * 100).toFixed(1).padStart(7)}% ${(r.champion * 100).toFixed(1).padStart(7)}% ${r.meanWins.toFixed(1).padStart(8)} ${r.meanPoints.toFixed(0).padStart(10)}${us}`);
}
const me = odds.find((r) => r.id === lg.me.id);
console.log(`\nOUR ODDS: ${(me.playoffs * 100).toFixed(1)}% playoffs, ${(me.champion * 100).toFixed(1)}% title (${(100 / teams.length).toFixed(1)}% = random)`);

// --- SELF-CHECKS. A simulator that is quietly wrong still prints a plausible table, so assert the
// conservation laws that any correct season must satisfy. These caught nothing here, but they are
// what stands between "the numbers look reasonable" and "the numbers are arithmetically possible".
const sumWins = odds.reduce((a, r) => a + r.meanWins, 0);
const wantWins = (weeks.length * teams.length) / 2;
const sumPlayoffs = odds.reduce((a, r) => a + r.playoffs, 0);
const sumTitles = odds.reduce((a, r) => a + r.champion, 0);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const checks = [
  [`total wins = ${wantWins} (one per game played)`, near(sumWins, wantWins, 0.5), sumWins.toFixed(1)],
  [`playoff shares sum to ${playoffTeams} teams`, near(sumPlayoffs, playoffTeams, 0.02), sumPlayoffs.toFixed(3)],
  [`exactly one champion per season`, near(sumTitles, 1, 0.02), sumTitles.toFixed(3)],
];
console.log(`\n=== SELF-CHECKS ===`);
let bad = 0;
for (const [label, ok, got] of checks) {
  if (!ok) bad++;
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${label.padEnd(42)} got ${got}`);
}
if (bad) { console.log(`\n  ${bad} INVARIANT FAILED -- the table above is not trustworthy.`); process.exit(1); }

// --- how much does the answer depend on the assumptions? ----------------------------------------
// Three checks, because a single point estimate hides which inputs it is resting on.
console.log(`\n=== SENSITIVITY ===`);
// In BOOTSTRAP mode projSd and the CV model are ignored by construction, so varying them would print
// four identical rows -- a sensitivity table that cannot move is worse than none, because it reads as
// evidence of robustness. The variants that matter here are the SAMPLER itself and the correlation.
const variants = outcomes
  ? [
    ["parametric lognormal (the old sampler)", { ...base, bootstrap: undefined, projSd: 0.30 }],
    ["bootstrap, correlation ZEROED (= ffsimulator)", { ...base, bootstrap: { outcomes, corr: { pairs: {} }, calibration: "scale" } }],
    ["bootstrap, UNCALIBRATED pools (pool level, not our board)", { ...base, bootstrap: { outcomes, corr: corrModel, calibration: "none" } }],
    ["bootstrap, correlation DOUBLED", { ...base, bootstrap: { outcomes, corr: { pairs: Object.fromEntries(Object.entries(corrModel.pairs).map(([k, v]) => [k, Math.min(0.95, v * 2)])) }, calibration: "scale" } }],
  ]
  : [
    ["projections treated as TRUTH (projSd 0)", { ...base, projSd: 0 }],
    ["higher projection error (projSd 0.40)", { ...base, projSd: 0.40 }],
    ["K/DST volatility x2", { ...base, kdstCvScale: 2 }],
    ["K/DST volatility x0.5", { ...base, kdstCvScale: 0.5 }],
  ];
console.log(`  ${"variant".padEnd(42)} our playoff%   our title%`);
console.log(`  ${"(baseline, projSd 0.30)".padEnd(42)} ${(me.playoffs * 100).toFixed(1).padStart(11)}% ${(me.champion * 100).toFixed(1).padStart(11)}%`);
for (const [label, o] of variants) {
  const r = simulateSeasons(teams, weeks, vm, o).find((x) => x.id === lg.me.id);
  console.log(`  ${label.padEnd(42)} ${(r.playoffs * 100).toFixed(1).padStart(11)}% ${(r.champion * 100).toFixed(1).padStart(11)}%`);
}
console.log(`\nIf "projections as TRUTH" is far from the baseline, that gap IS the honest uncertainty --`);
console.log(`it is the difference between "our roster is exactly this good" and "we think it is about`);
console.log(`this good". K/DST are now fitted from real weekly data; the scale test is kept as a`);
console.log(`standing check that no one position's volatility is quietly driving the answer.`);
console.log(`\nTrust the PLAYOFF number more than the title number: a 7-of-16 threshold is far less`);
console.log(`sensitive to tail assumptions than a single-elimination bracket.`);
