// HOW MANY TRIALS IS ENOUGH? Measuring diminishing returns in the trade simulator.
//
//   node --import tsx scripts/sim-convergence.mjs
//
// "Run more trials" has no natural stopping point: the standard error of a Monte Carlo estimate
// falls as 1/sqrt(N) forever and never flattens. So precision is the wrong thing to watch. What
// actually saturates is DECISION QUALITY -- once the error is small compared to the gaps BETWEEN
// candidates, more trials stop changing which move you would make, and every further simulation buys
// a more precise answer to a question already settled.
//
// Three things measured here, all of which are needed to choose a budget honestly:
//
//   1. SPREAD OF THE ESTIMATE. Re-run the same candidate at the same N under DIFFERENT seeds and
//      take the standard deviation of the answers. That is the real run-to-run error, measured
//      rather than taken from a formula -- the textbook sqrt(p(1-p)/N) assumes independent binomial
//      trials, and a season simulation with correlated teammates, shared schedules and lineup logic
//      does not obviously satisfy that.
//
//   2. RANK STABILITY. The output is a RANKING, not a number, so the decision-relevant question is
//      whether the top of the list stops moving. Measured as top-3 overlap against a high-budget
//      reference ranking. A run whose SE is still falling but whose top 3 is stable has converged
//      for our purposes.
//
//   3. WHAT COMMON RANDOM NUMBERS ACTUALLY BUY. CRN is used everywhere in trade-odds.mjs on the
//      argument that it makes the DIFFERENCE less noisy than either arm. That is a claim about this
//      simulator, not a theorem about all simulators -- if the roster change shifts which weeks
//      matter, shared draws help less than advertised. Measured by computing each delta both ways.
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { nameKey } from "../src/league/index.ts";
import { simulateSeasons } from "../src/draft/season.ts";
import { buildSchedule } from "../src/draft/schedule.ts";

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
const opts = (trials, seed) => ({ weeks: weeks.length, playoffTeams: 7, slots: cfg.slots, projSd: 0.30, trials, seed, poolRank,
  bootstrap: { outcomes, corr: corrModel, calibration: "scale" } });
const clone = (t) => t.map((x) => ({ ...x, roster: x.roster.map((p) => ({ ...p })) }));
const titleOf = (teams, trials, seed) => 100 * simulateSeasons(teams, weeks, vm, opts(trials, seed))[meIdx].champion;

// A SPREAD of candidates, deliberately including near-ties. If every candidate were far apart the
// ranking would be stable at any budget and the experiment would flatter the simulator.
const us = baseTeams[meIdx].roster;
const CANDS = [];
for (const t of baseTeams) {
  if (t.id === String(lgRow.team_id)) continue;
  for (const get of t.roster) {
    if (!["RB", "WR", "QB", "TE"].includes(get.pos) || get.proj < 230) continue;
    const give = us.find((p) => p.name === "Michael Pittman Jr.") ?? us[0];
    CANDS.push({ label: `${give.name.split(" ").pop()}->${get.name}`, ti: baseTeams.indexOf(t), give, get });
  }
}
const PICK = CANDS.slice(0, 10);
const swap = (c) => {
  const teams = clone(baseTeams);
  teams[meIdx].roster = teams[meIdx].roster.filter((p) => p.name !== c.give.name).concat([{ ...c.get }]);
  teams[c.ti].roster = teams[c.ti].roster.filter((p) => p.name !== c.get.name).concat([{ ...c.give }]);
  return teams;
};

const LEVELS = [100, 200, 400, 800, 1600, 3200];
const SEEDS = [11, 22, 33, 44];
const REF_TRIALS = 12000, REF_SEED = 99;

console.log(`${PICK.length} candidate moves, ${SEEDS.length} seeds per level, levels ${LEVELS.join("/")}`);
console.log(`reference ranking computed at ${REF_TRIALS} trials\n`);

// Reference ranking (the "truth" we measure convergence against).
const refBase = titleOf(baseTeams, REF_TRIALS, REF_SEED);
const ref = PICK.map((c) => ({ label: c.label, d: titleOf(swap(c), REF_TRIALS, REF_SEED) - refBase }))
  .sort((a, b) => b.d - a.d);
const refTop3 = new Set(ref.slice(0, 3).map((x) => x.label));
console.log(`reference top 3: ${[...refTop3].join(", ")}`);
console.log(`reference deltas: ${ref.map((x) => `${x.label} ${x.d >= 0 ? "+" : ""}${x.d.toFixed(2)}`).join("  ")}\n`);

console.log("  trials   SD of one delta   CRN?   top-3 overlap w/ reference   sec/eval");
console.log("                (pp, across seeds)          (of 3)");
for (const N of LEVELS) {
  const t0 = Date.now();
  // For each seed: full ranking at this budget, with CRN (base and swap share the seed).
  const perSeedRank = [], perCandDeltas = PICK.map(() => []), noCrnDeltas = PICK.map(() => []);
  for (const s of SEEDS) {
    const b = titleOf(baseTeams, N, s);
    const ds = PICK.map((c) => titleOf(swap(c), N, s) - b);
    ds.forEach((d, i) => perCandDeltas[i].push(d));
    // WITHOUT CRN: the swapped arm uses a DIFFERENT seed, so the two arms no longer share draws.
    const ds2 = PICK.map((c) => titleOf(swap(c), N, s + 500) - b);
    ds2.forEach((d, i) => noCrnDeltas[i].push(d));
    perSeedRank.push(PICK.map((c, i) => ({ label: c.label, d: ds[i] })).sort((a, b2) => b2.d - a.d).slice(0, 3).map((x) => x.label));
  }
  const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
  const sdCrn = perCandDeltas.map(sd).reduce((a, b) => a + b, 0) / PICK.length;
  const sdNo = noCrnDeltas.map(sd).reduce((a, b) => a + b, 0) / PICK.length;
  const overlap = perSeedRank.map((top3) => top3.filter((l) => refTop3.has(l)).length).reduce((a, b) => a + b, 0) / SEEDS.length;
  const secs = (Date.now() - t0) / 1000 / (SEEDS.length * (PICK.length * 2 + 1));
  console.log(`  ${String(N).padStart(6)}   ${sdCrn.toFixed(2).padStart(10)}      CRN    ${overlap.toFixed(2).padStart(14)} / 3        ${secs.toFixed(2)}`);
  console.log(`           ${sdNo.toFixed(2).padStart(10)}   no-CRN            (CRN cuts SD ${(sdNo / (sdCrn || 1)).toFixed(2)}x)`);
}

console.log(`
HOW TO READ THIS.

SD is the run-to-run spread of a single delta at that budget, measured across seeds rather than
assumed from a formula. It should fall roughly as 1/sqrt(N) -- quadrupling the trials halves it. It
never reaches zero, which is exactly why it is the wrong stopping rule.

TOP-3 OVERLAP is the stopping rule. Once a budget reproduces the reference top 3 consistently, more
trials buy precision on a decision already made. Pick the smallest N where overlap is at or near 3/3,
then use the next level up for anything you will act on.

THE CRN RATIO is the variance reduction from sharing draws between the two arms. A ratio near 1 would
mean CRN is doing nothing here and the pairing in trade-odds.mjs is decoration; well above 1 means a
no-CRN sweep would need that factor SQUARED in trials to match it.`);
