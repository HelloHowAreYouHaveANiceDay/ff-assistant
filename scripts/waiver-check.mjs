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
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { openLeague, nameKey } from "../src/league/index.ts";
import { simulateSeasons } from "../src/draft/season.ts";

const ADD = process.argv[2] ?? "Braelon Allen";
const TRIALS = Number(process.argv[3] ?? 3000);
const SEEDS = [7, 101, 202, 303];

const vm = JSON.parse(readFileSync("data/variance-model.json", "utf8"));
const outcomes = JSON.parse(readFileSync("data/rank-outcomes.json", "utf8"));
const corrModel = JSON.parse(readFileSync("data/correlation-model.json", "utf8"));

const lg = await openLeague();
const sched = await lg.provider.matchups();
const store = new Database("data/ff.db", { readonly: true });
const cfg = JSON.parse(store.prepare("SELECT value FROM settings WHERE key='config'").get().value);
const byeOf = new Map();
for (const r of store.prepare(
  `SELECT p.name, r.bye FROM player p JOIN ranking r ON r.player_id=p.player_id AND r.source='fantasypros_ecr' AND r.season=?`,
).all(lg.season)) byeOf.set(nameKey(r.name), r.bye);
const board = new Map();
for (const r of store.prepare("SELECT player_id, row_json FROM board WHERE season=?").all(lg.season)) {
  const j = JSON.parse(r.row_json);
  board.set(j.Player, { name: j.Player, pos: j.Pos, proj: j.ProjPts || 0, team: j.Team || "" });
}
const idx = new Map(lg.teams.map((t, i) => [t.id, i]));
const baseTeams = lg.teams.map((t) => ({
  id: t.id, name: t.name,
  roster: t.roster.map((p) => ({ name: p.name, pos: p.pos, proj: p.proj, team: p.team, bye: byeOf.get(nameKey(p.name)) ?? null })),
}));
const weeks = [];
for (let w = 1; w <= lg.regWeeks; w++) {
  const g = sched.games.filter((x) => x.week === w).map((x) => [idx.get(x.homeId), idx.get(x.awayId)]).filter(([a, b]) => a != null && b != null);
  if (g.length) weeks.push(g);
}
const meIdx = idx.get(lg.me.id);
const poolRank = new Map();
{
  const byPos = {};
  for (const line of readFileSync("data/points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
    const f = line.split(",");
    if (!f[0] || !f[2]) continue;
    (byPos[f[1].trim().toUpperCase()] ??= []).push({ name: f[0].trim(), pts: Number(f[2]) });
  }
  for (const [, l] of Object.entries(byPos)) { l.sort((a, b) => b.pts - a.pts); l.forEach((x, i) => poolRank.set(x.name, { rank: i, of: l.length })); }
}
await lg.close();

const addP = board.get(ADD);
if (!addP) { console.log(`"${ADD}" is not on the board -- check the spelling.`); process.exit(1); }
const owned = new Set(baseTeams.flatMap((t) => t.roster.map((p) => p.name)));
if (owned.has(ADD)) { console.log(`"${ADD}" is already rostered in this league -- not a waiver add.`); process.exit(1); }

const run = (teams, seed) => 100 * simulateSeasons(teams, weeks, vm, {
  weeks: weeks.length, playoffTeams: 7, slots: lg.slots, projSd: 0.30, trials: TRIALS, seed, poolRank,
  bootstrap: { outcomes, corr: corrModel, calibration: "scale" },
})[meIdx].champion;
const clone = (t) => t.map((x) => ({ ...x, roster: x.roster.map((p) => ({ ...p })) }));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };

const baseBySeed = SEEDS.map((s) => run(baseTeams, s));
console.log(`ADD ${ADD} (${addP.pos}, ${addP.proj.toFixed(0)} proj) -- ${TRIALS} trials x ${SEEDS.length} seeds`);
console.log(`  BASE: ${mean(baseBySeed).toFixed(2)}% title\n`);
console.log("  drop                   pos   proj    title after   delta    +/-SE");

const rows = [];
for (const cand of baseTeams[meIdx].roster) {
  const after = SEEDS.map((s, i) => {
    const teams = clone(baseTeams);
    teams[meIdx].roster = teams[meIdx].roster.filter((p) => p.name !== cand.name)
      .concat([{ ...addP, bye: byeOf.get(nameKey(addP.name)) ?? null }]);
    return run(teams, s) - baseBySeed[i];
  });
  rows.push({ name: cand.name, pos: cand.pos, proj: cand.proj, d: mean(after), se: sd(after) / Math.sqrt(SEEDS.length) });
}
rows.sort((a, b) => b.d - a.d);
for (const r of rows) {
  console.log(`  ${r.name.slice(0, 21).padEnd(21)} ${r.pos.padEnd(4)} ${r.proj.toFixed(0).padStart(5)}  ` +
    `${(mean(baseBySeed) + r.d).toFixed(2)}%`.padStart(11) + `  ${(r.d >= 0 ? "+" : "") + r.d.toFixed(2)}pp`.padStart(9) + `  +/-${r.se.toFixed(2)}`);
}
console.log(`
  A positive delta means the claim is worth making by dropping that man. Options whose deltas
  overlap within their SEs are not distinguishable -- pick between them on something the simulator
  does not model (upcoming schedule, injury news, who you would rather hold in December).`);
