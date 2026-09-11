// Measure WITHIN-TEAM, SAME-WEEK correlation between fantasy positions, from our own 26 seasons.
// Writes data/correlation-model.json.
//
//   node --import tsx scripts/fit-correlation.mjs
//
// WHY MEASURE RATHER THAN CITE. Published figures for QB-WR correlation are quoted inconsistently --
// the same numbers appear labelled "r" in one place and "r-squared" in another, which is a factor-of-
// two difference in how much correlation to impose. We have 164k player-weeks with team labels; the
// number is cheap to compute and then it is OURS, on OUR scoring, with OUR half-PPR settings.
//
// WHAT IS BEING MEASURED. For each (team, season, week), take the team's top scorer at each position
// and correlate the pair across all team-weeks -- but on RESIDUALS, not raw points. Raw correlation
// would mostly capture "good offenses score more", which is a between-team effect already present in
// our projections. What a simulator needs is the WITHIN-team, week-to-week co-movement: given what
// these two players average, do they have good weeks together? So each player-week is divided by
// that player's own season mean before correlating.
import { readFileSync, writeFileSync } from "node:fs";

const POS = ["QB", "RB", "WR", "TE", "K", "DST"];
const rows = readFileSync("data/history-weekly.csv", "utf8").trim().split(/\r?\n/).slice(1);

// LEAVE-SEASON-OUT support for the calibration harness's un-leaked refit. Both unset -> shipped run.
const FIT_EXCLUDE = process.env.FIT_EXCLUDE ? Number(process.env.FIT_EXCLUDE) : null;
const FIT_OUT = process.env.FIT_OUT || "data/correlation-model.json";

// season -> name -> {pos, team, weeks: Map<week, pts>}
const players = new Map();
for (const line of rows) {
  const [season, name, pos, week, pts, team] = line.split(",");
  if (FIT_EXCLUDE != null && Number(season) === FIT_EXCLUDE) continue;   // leave-season-out
  if (!POS.includes(pos) || !team) continue;
  const p = Number(pts), w = Number(week);
  if (!Number.isFinite(p) || !Number.isFinite(w)) continue;
  const key = `${season}|${name}`;
  if (!players.has(key)) players.set(key, { season: Number(season), name, pos, team, weeks: new Map() });
  players.get(key).weeks.set(w, p);
}

// season mean per player -> residual = week / mean (1.0 = an average week for that player)
for (const p of players.values()) {
  const vals = [...p.weeks.values()];
  p.mean = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
  p.games = vals.length;
}

// (season, team, week) -> position -> best residual, using the team's TOP scorer at that position
//
// `all` is the SAME rows, kept in full rather than reduced to the top man, because the same-position
// block below needs the SECOND and THIRD names at a position and the top-scorer reduction throws
// them away. That reduction is why no same-position pair has ever been measured here: WR1-WR2 was
// not small, it was ABSENT, and `pairCorr` filled the hole with 1. Same filters, same residual, same
// team-weeks -- only the depth kept differs.
const cell = new Map();
for (const p of players.values()) {
  if (p.games < 6 || p.mean <= 1) continue;   // need a stable mean to residualise against
  for (const [w, pts] of p.weeks) {
    const k = `${p.season}|${p.team}|${w}`;
    if (!cell.has(k)) cell.set(k, { all: {} });
    const c = cell.get(k);
    // "top scorer at the position" is chosen by SEASON mean, not by this week's points -- picking by
    // this week's points would select on the outcome and inflate every correlation.
    if (!c[p.pos] || p.mean > c[p.pos].mean) c[p.pos] = { mean: p.mean, resid: pts / p.mean };
    (c.all[p.pos] ??= []).push({ name: p.name, mean: p.mean, resid: pts / p.mean });
  }
}
// Rank within the team-week by SEASON mean, for the same reason the top-scorer pick uses it: rank
// by this week's points and "WR1" becomes "whoever happened to go off", which manufactures a
// negative correlation out of the ordering alone.
for (const c of cell.values()) {
  for (const pos of Object.keys(c.all)) c.all[pos].sort((a, b) => b.mean - a.mean);
}

const pearson = (xs, ys) => {
  const n = xs.length;
  if (n < 30) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const dx = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0));
  const dy = Math.sqrt(ys.reduce((a, y) => a + (y - my) ** 2, 0));
  return dx && dy ? num / (dx * dy) : null;
};

const PAIRS = [["QB","WR"],["QB","TE"],["QB","RB"],["RB","WR"],["WR","TE"],["RB","TE"],["QB","DST"],["QB","K"],["K","DST"]];
const model = { fittedFrom: "data/history-weekly.csv", teamWeeks: cell.size, pairs: {} };
console.log(`within-team same-week correlation, on residuals (week / player's season mean)`);
console.log(`${cell.size} team-weeks\n`);
console.log("  pair      n        r      note");
for (const [a, b] of PAIRS) {
  const xs = [], ys = [];
  for (const c of cell.values()) if (c[a] && c[b]) { xs.push(c[a].resid); ys.push(c[b].resid); }
  const r = pearson(xs, ys);
  const key = `${a}-${b}`;
  model.pairs[key] = r == null ? 0 : Number(r.toFixed(4));
  const se = xs.length ? 1 / Math.sqrt(xs.length) : 1;
  const note = r == null ? "too few" : Math.abs(r) < 2 * se ? "(indistinguishable from 0)" : "";
  console.log(`  ${key.padEnd(8)} ${String(xs.length).padStart(6)}  ${r == null ? "  n/a" : (r >= 0 ? "+" : "") + r.toFixed(3)}   ${note}`);
}
// ==================================================================================================
// SAME-POSITION TEAMMATES. Two receivers on one NFL team.
//
// WHY THIS EXISTS. `pairCorr` in src/draft/bootstrap.ts returned 1 whenever the two POSITION STRINGS
// matched, so `prepare()` handed the copula a correlation matrix in which two different men at the
// same position on the same team were the same man. That was never a modelling choice: the fit above
// took only the TOP scorer per position per team-week, so a same-position pair was never measured,
// and 1 is what an unmeasured self-pair defaults to.
//
// WHAT THE ANSWER SHOULD BE IS EMPIRICAL, and both mechanisms are real. Shared game script pushes it
// POSITIVE -- a shootout gives both receivers volume, a blowout win gives both running backs carries.
// Competition for the same targets and the same carries pushes it NEGATIVE -- there is one ball, and
// a 12-target day for one man is usually a 4-target day for the other. Which dominates is a fact
// about football, not a thing to assume, so it is measured here on exactly the basis the
// cross-position pairs use.
//
// SHRINK RULE. A same-position pair within 2 SE of zero is WRITTEN AS ZERO. That is the rule this
// script has always PRINTED for the cross-position pairs; it is applied for real to the new keys
// because they are the ones about to change simulator behaviour. The raw r is kept beside it in
// `samePosition` so shrinking to zero cannot be mistaken for measuring zero.
const SAME = [
  ["WR", 0, 1, "WR-WR"],
  ["RB", 0, 1, "RB-RB"],
  ["TE", 0, 1, "TE-TE"],
  ["QB", 0, 1, null],       // reported only -- two QBs who both clear the games filter is a QB change
  ["WR", 0, 2, null],       // WR1-WR3, reported: does the effect deepen down the depth chart?
];
model.samePosition = {};
console.log(`\nSAME-POSITION TEAMMATES, same residual basis, same team-weeks.`);
console.log(`  pair        n        r      SE    shrunk   note`);
for (const [pos, i, j, key] of SAME) {
  const xs = [], ys = [];
  for (const c of cell.values()) {
    const list = c.all[pos];
    if (!list || list.length <= j) continue;
    // Two DIFFERENT men. A player cannot appear twice in a team-week, but guard it anyway: a name
    // collision would read as r = 1 and look exactly like the bug this block exists to remove.
    if (list[i].name === list[j].name) continue;
    xs.push(list[i].resid); ys.push(list[j].resid);
  }
  const r = pearson(xs, ys);
  const se = xs.length ? 1 / Math.sqrt(xs.length) : 1;
  const label = `${pos}${i + 1}-${pos}${j + 1}`;
  const noisy = r == null || Math.abs(r) < 2 * se;
  const shrunk = r == null ? 0 : noisy ? 0 : Number(r.toFixed(4));
  model.samePosition[label] = { n: xs.length, r: r == null ? null : Number(r.toFixed(4)), se: Number(se.toFixed(4)), shrunkToZero: noisy, key };
  if (key) model.pairs[key] = shrunk;
  console.log(`  ${label.padEnd(10)} ${String(xs.length).padStart(6)}  ${r == null ? "  n/a" : (r >= 0 ? "+" : "") + r.toFixed(4)}  ${se.toFixed(4)}  ${(shrunk >= 0 ? "+" : "") + shrunk.toFixed(4)}   ${noisy ? "(within 2 SE -- written as 0)" : ""}${key ? "" : "  [reported only, not written]"}`);
}

writeFileSync(FIT_OUT, JSON.stringify(model, null, 2));
console.log(`\nwrote data/correlation-model.json`);
console.log(`\nThese are the numbers the season simulator should impose between rostered NFL teammates.`);
console.log(`Anything flagged indistinguishable from 0 should be modelled as 0 -- imposing a`);
console.log(`correlation the data does not support is worse than imposing none.`);
