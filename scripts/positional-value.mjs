// WHAT IS A FREE PLAYER WORTH, BY POSITION? The diagnostic behind "no good RB trades".
//
//   node --import tsx scripts/positional-value.mjs [trials]
//
// The trade sweep keeps returning QB deals and almost no running backs, and "nobody will sell an RB"
// is a convenient explanation that happens to also be what a broken model would produce. The two are
// distinguishable: a trade result mixes what we GAIN with what it COSTS us and what it costs the
// partner, so a low score can come from any of the three. Giving a player away FREE -- no drop, no
// counterparty -- isolates the first.
//
// If a mid-tier RB is worth much more than a mid-tier WR here, the model prices the position
// correctly and the sweep's answer is a fact about the market rather than about the simulator. If
// they come out similar on a one-RB roster with a mandatory RB slot, the simulator is not seeing the
// hole and every trade conclusion in this repo is suspect.
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { nameKey } from "../src/league/index.ts";
import { simulateSeasons } from "../src/draft/season.ts";
import { buildSchedule } from "../src/draft/schedule.ts";

const TRIALS = Number(process.argv[2] ?? 3000);
const SEEDS = [7, 101, 202, 303];
const vm = JSON.parse(readFileSync("data/variance-model.json", "utf8"));
const outcomes = JSON.parse(readFileSync("data/rank-outcomes.json", "utf8"));
const corr = JSON.parse(readFileSync("data/correlation-model.json", "utf8"));

const db = new Database("data/ff.db", { readonly: true });
const cfg = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='config'").get().value);
const lgRow = db.prepare("SELECT league_id, team_id FROM league WHERE season=? AND team_id IS NOT NULL").get(cfg.season);
const byeOf = new Map();
for (const r of db.prepare(
  `SELECT p.name, r.bye FROM player p JOIN ranking r ON r.player_id=p.player_id AND r.source='fantasypros_ecr' AND r.season=?`,
).all(cfg.season)) byeOf.set(nameKey(r.name), r.bye);
const board = new Map();
for (const r of db.prepare("SELECT player_id, row_json FROM board WHERE season=?").all(cfg.season)) {
  const j = JSON.parse(r.row_json);
  board.set(r.player_id, { name: j.Player, pos: j.Pos, proj: j.ProjPts || 0, team: j.Team || "" });
}
const byTeam = new Map();
const owned = new Set();
for (const r of db.prepare("SELECT player_id, team_id, team_abbrev FROM ownership WHERE league_id=?").all(lgRow.league_id)) {
  owned.add(r.player_id);
  const b = board.get(r.player_id);
  if (!b) continue;
  if (!byTeam.has(r.team_id)) byTeam.set(r.team_id, { id: r.team_id, name: r.team_abbrev, roster: [] });
  byTeam.get(r.team_id).roster.push({ ...b, bye: byeOf.get(nameKey(b.name)) ?? null });
}
const baseTeams = [...byTeam.values()].sort((a, b) => Number(a.id) - Number(b.id));
const meIdx = baseTeams.findIndex((t) => t.id === String(lgRow.team_id));
const weeks = buildSchedule(baseTeams.length, cfg.regWeeks ?? 14, 4).weeks;
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
db.close();

const run = (teams, seed) => 100 * simulateSeasons(teams, weeks, vm, {
  weeks: weeks.length, playoffTeams: 7, slots: cfg.slots, projSd: 0.30, trials: TRIALS, seed, poolRank,
  bootstrap: { outcomes, corr, calibration: "scale" },
})[meIdx].champion;
const clone = (t) => t.map((x) => ({ ...x, roster: x.roster.map((p) => ({ ...p })) }));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };

const baseBySeed = SEEDS.map((s) => run(baseTeams, s));
const us = baseTeams[meIdx].roster;
const shape = {};
for (const p of us) shape[p.pos] = (shape[p.pos] ?? 0) + 1;
console.log(`OUR ROSTER: ${Object.entries(shape).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`BASE: ${mean(baseBySeed).toFixed(2)}% title\n`);
console.log("Adding one FREE player of each position+calibre. No drop, no counterparty -- pure");
console.log("positional marginal value, with the trade cost stripped out.\n");
console.log("  add               proj   title after    delta    +/-SE");

// Calibre bands chosen from the real projection pool so "a mid-tier RB" means the same thing as
// "a mid-tier WR" -- comparing a position's BEST against another's median would answer nothing.
// MATCHED ON PROJECTION, not on rank. RB rank-20 outprojects WR rank-20, so a rank-matched
// comparison partly measures points rather than position -- and points are exactly what a positional
// question has to hold constant. Each band picks the player of that position CLOSEST to a target
// point total, so "an RB worth 190" is compared against "a WR worth 190".
const nearest = (pool, target) => pool.reduce((best, p) => Math.abs(p.proj - target) < Math.abs(best.proj - target) ? p : best, pool[0]);
for (const pos of ["RB", "WR", "TE", "QB"]) {
  const pool = [...board.values()].filter((p) => p.pos === pos).sort((a, b) => b.proj - a.proj);
  for (const [label, target] of [["~240 pts", 240], ["~190 pts", 190], ["~140 pts", 140]]) {
    const p = nearest(pool, target);
    if (!p) continue;
    const ds = SEEDS.map((s, i) => {
      const teams = clone(baseTeams);
      teams[meIdx].roster = teams[meIdx].roster.concat([{ ...p, bye: byeOf.get(nameKey(p.name)) ?? null }]);
      return run(teams, s) - baseBySeed[i];
    });
    console.log(`  ${(pos + " " + label).padEnd(20)} ${p.proj.toFixed(0).padStart(4)}  ` +
      `${(mean(baseBySeed) + mean(ds)).toFixed(2)}%`.padStart(11) + `  ${(mean(ds) >= 0 ? "+" : "") + mean(ds).toFixed(2)}pp`.padStart(9) +
      `  +/-${(sd(ds) / Math.sqrt(SEEDS.length)).toFixed(2)}`);
  }
}
console.log(`
  We roster ONE running back and the RB slot is mandatory, so if the simulator sees the hole at all,
  RB must lead its calibre band. If it does not, the trade conclusions in this repo rest on a model
  that cannot see the thing it was asked about.`);
