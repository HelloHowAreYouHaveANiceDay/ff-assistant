// Evaluate a SHORT LIST of named trades at high precision.
//
//   node --import tsx scripts/trade-check.mjs 3200 "Michael Pittman Jr.->Jalen Hurts" ...
//
// The full sweep answers "what should I look at"; this answers "is this specific deal real". They are
// different questions and the second deserves more trials per candidate, because by the time a deal
// is on the short list the gaps between the survivors are small -- which is exactly where the sweep's
// own noise floor stops being negligible.
//
// It also reports the standard error, estimated by re-running each arm under several seeds, so a
// number is never quoted without the width of its own uncertainty. scripts/sim-convergence.mjs
// measured that width against a 12,000-trial reference; this reports it per deal.
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { nameKey } from "../src/league/index.ts";
import { simulateSeasons } from "../src/draft/season.ts";
import { buildSchedule } from "../src/draft/schedule.ts";

const TRIALS = Number(process.argv[2] ?? 3200);
const WANT = process.argv.slice(3);
const SEEDS = [7, 101, 202, 303];

const vm = JSON.parse(readFileSync("data/variance-model.json", "utf8"));
const outcomes = JSON.parse(readFileSync("data/rank-outcomes.json", "utf8"));
const corrModel = JSON.parse(readFileSync("data/correlation-model.json", "utf8"));
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
for (const r of db.prepare("SELECT player_id, team_id, team_abbrev, owner FROM ownership WHERE league_id=?").all(lgRow.league_id)) {
  const b = board.get(r.player_id);
  if (!b) continue;
  if (!byTeam.has(r.team_id)) byTeam.set(r.team_id, { id: r.team_id, name: r.team_abbrev || r.owner, roster: [] });
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
const run = (teams, seed) => simulateSeasons(teams, weeks, vm, {
  weeks: weeks.length, playoffTeams: 7, slots: cfg.slots, projSd: 0.30, trials: TRIALS, seed, poolRank,
  bootstrap: { outcomes, corr: corrModel, calibration: "scale" },
});
const clone = (t) => t.map((x) => ({ ...x, roster: x.roster.map((p) => ({ ...p })) }));

const find = (name) => {
  for (let ti = 0; ti < baseTeams.length; ti++) {
    const p = baseTeams[ti].roster.find((x) => x.name === name);
    if (p) return { ti, p };
  }
  return null;
};

const DEFAULT = [
  "Michael Pittman Jr.->Jalen Hurts", "Chris Godwin Jr.->Jalen Hurts", "Jameson Williams->Jalen Hurts",
  "Marvin Harrison Jr.->Jalen Hurts", "Ladd McConkey->Jalen Hurts", "Chris Godwin Jr.->Brock Purdy",
  "Marvin Harrison Jr.->Brock Purdy", "Amon-Ra St. Brown->Christian McCaffrey",
  "Michael Pittman Jr.->Christian McCaffrey", "Marvin Harrison Jr.->Christian McCaffrey",
  "Isaiah Likely->Christian McCaffrey", "Chris Godwin Jr.->Bijan Robinson",
];
const deals = (WANT.length ? WANT : DEFAULT).map((s) => {
  const [g, t] = s.split("->");
  return { giveName: g.trim(), getName: t.trim() };
});

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };

console.log(`SHORT-LIST CHECK -- ${TRIALS} trials x ${SEEDS.length} seeds each, identity-keyed CRN\n`);
const baseBySeed = SEEDS.map((s) => run(baseTeams, s));
const baseTitle = baseBySeed.map((o) => 100 * o[meIdx].champion);
console.log(`  BASE: ${mean(baseTitle).toFixed(2)}% title  (+/- ${sd(baseTitle).toFixed(2)} across seeds)\n`);
console.log("  we give               we get                 partner   title delta   +/- SE    them");
const out = [];
for (const d of deals) {
  const giv = baseTeams[meIdx].roster.find((x) => x.name === d.giveName);
  const got = find(d.getName);
  if (!giv || !got) { console.log(`  ${d.giveName} -> ${d.getName}: NOT FOUND (roster changed?)`); continue; }
  const ds = [], dsThem = [];
  SEEDS.forEach((s, i) => {
    const teams = clone(baseTeams);
    teams[meIdx].roster = teams[meIdx].roster.filter((p) => p.name !== giv.name).concat([{ ...got.p }]);
    teams[got.ti].roster = teams[got.ti].roster.filter((p) => p.name !== got.p.name).concat([{ ...giv }]);
    const o = run(teams, s);
    ds.push(100 * o[meIdx].champion - baseTitle[i]);
    dsThem.push(100 * (o[got.ti].champion - baseBySeed[i][got.ti].champion));
  });
  out.push({ ...d, d: mean(ds), se: sd(ds) / Math.sqrt(SEEDS.length), them: mean(dsThem), abbr: baseTeams[got.ti].name });
}
out.sort((a, b) => b.d - a.d);
for (const r of out) {
  console.log(
    `  ${r.giveName.slice(0, 20).padEnd(20)}  ${r.getName.slice(0, 20).padEnd(20)}  ${String(r.abbr).slice(0, 7).padEnd(7)} ` +
    `${(r.d >= 0 ? "+" : "") + r.d.toFixed(2)}pp`.padStart(11) + `  +/-${r.se.toFixed(2)}` +
    `${(r.them >= 0 ? "+" : "") + r.them.toFixed(2)}pp`.padStart(9),
  );
}
console.log(`\n  A deal is only distinguishable from the one below it if the gap exceeds roughly the sum`);
console.log(`  of their SEs. Ranking beyond that resolution is reading noise as a preference.`);
