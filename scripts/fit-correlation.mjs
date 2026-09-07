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

// season -> name -> {pos, team, weeks: Map<week, pts>}
const players = new Map();
for (const line of rows) {
  const [season, name, pos, week, pts, team] = line.split(",");
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
const cell = new Map();
for (const p of players.values()) {
  if (p.games < 6 || p.mean <= 1) continue;   // need a stable mean to residualise against
  for (const [w, pts] of p.weeks) {
    const k = `${p.season}|${p.team}|${w}`;
    if (!cell.has(k)) cell.set(k, {});
    const c = cell.get(k);
    // "top scorer at the position" is chosen by SEASON mean, not by this week's points -- picking by
    // this week's points would select on the outcome and inflate every correlation.
    if (!c[p.pos] || p.mean > c[p.pos].mean) c[p.pos] = { mean: p.mean, resid: pts / p.mean };
  }
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
writeFileSync("data/correlation-model.json", JSON.stringify(model, null, 2));
console.log(`\nwrote data/correlation-model.json`);
console.log(`\nThese are the numbers the season simulator should impose between rostered NFL teammates.`);
console.log(`Anything flagged indistinguishable from 0 should be modelled as 0 -- imposing a`);
console.log(`correlation the data does not support is worse than imposing none.`);
