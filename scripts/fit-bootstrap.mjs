// Build the BOOTSTRAP pool: for each (position, preseason rank), the actual weekly fantasy outcomes
// that players at that rank went on to post. Writes data/rank-outcomes.json.
//
//   node --import tsx scripts/fit-bootstrap.mjs
//
// This is the mechanism ffsimulator uses (verified in its source: it merges rankings to historical
// outcomes `by = c("pos","rank")` and resamples week outcomes with replacement). It replaces a fitted
// parametric distribution with the empirical record, which matters for three reasons at once:
//   - the SHAPE is real: right-skewed, hard zero floor, fat ceiling weeks
//   - PROJECTION ERROR comes free: the pool for "preseason RB5" already contains the seasons where
//     RB5 tore an ACL in week 2 and the ones where he led the league. No separate error term needed.
//   - AVAILABILITY comes free: a week the player missed is a real 0 in the pool.
//
// PRESEASON RANK PROXY. We have no historical ADP, so a player's rank ENTERING season Y is proxied by
// where he finished at his position in season Y-1 -- the same convention the backtest's
// `--no-lookahead` mode already uses. This is the load-bearing choice: using SAME-season finish rank
// instead would be lookahead and would silently destroy the point, because the "RB5" pool would then
// contain only players who actually finished RB5 -- every bust filtered out, exactly the outcomes the
// pool exists to represent.
//
// BYES ARE EXCLUDED, INJURIES ARE NOT. A bye leaves no row in the source, so it never enters the pool;
// the simulator applies the real 2026 byes itself, from the schedule, and would double-count them
// otherwise. A week the player's TEAM played but he did not becomes a 0 -- that is injury risk, and
// it belongs in the pool.
import { readFileSync, writeFileSync } from "node:fs";

const POS = ["QB", "RB", "WR", "TE", "K", "DST"];
const MAX_RANK = { QB: 40, RB: 90, WR: 110, TE: 45, K: 40, DST: 40 };
const SMOOTH = 2;      // pool ranks +/- this many neighbours, for a stable sample at each rank
const MIN_TRAJ = 20;   // below this many TRAJECTORIES, widen further
const EMIT_TRAJ = 10;  // below this many, the rank gets no pool at all rather than a fabricated one
const LAST_REG_WEEK = 17;

const rows = readFileSync("data/history-weekly.csv", "utf8").trim().split(/\r?\n/).slice(1);

// season -> name -> {pos, team, weeks:Map}
const byKey = new Map();
const teamWeeks = new Map();   // season|team -> Set(weeks the team played)
for (const line of rows) {
  const [season, name, pos, week, pts, team] = line.split(",");
  if (!POS.includes(pos)) continue;
  const s = Number(season), w = Number(week), p = Number(pts);
  if (!Number.isFinite(s) || !Number.isFinite(w) || !Number.isFinite(p)) continue;
  if (w > LAST_REG_WEEK) continue;   // regular season only; the sim applies its own playoff weeks
  const k = `${s}|${name}`;
  if (!byKey.has(k)) byKey.set(k, { season: s, name, pos, team, weeks: new Map() });
  byKey.get(k).weeks.set(w, p);
  if (team) {
    const tk = `${s}|${team}`;
    if (!teamWeeks.has(tk)) teamWeeks.set(tk, new Set());
    teamWeeks.get(tk).add(w);
  }
}

// finish rank per (season, pos), by season total
const finishRank = new Map();   // season|name -> rank
const seasons = [...new Set([...byKey.values()].map((p) => p.season))].sort();
for (const s of seasons) {
  for (const pos of POS) {
    const list = [...byKey.values()].filter((p) => p.season === s && p.pos === pos)
      .map((p) => ({ p, tot: [...p.weeks.values()].reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.tot - a.tot);
    list.forEach((x, i) => finishRank.set(`${s}|${x.p.name}`, i + 1));
  }
}

// For each player-season, his PRIOR-season finish rank is his proxy preseason rank. Collect the
// weeks his team PLAYED, filling a 0 where he did not appear.
// SCHEMA 2: one TRAJECTORY per player-season, not a flat bag of weeks.
//
// The pool used to be flattened -- every week from every player-season at a rank poured into one
// array, and the simulator drew weeks from it independently. That understates season-total spread by
// a factor of 1.6-2.8, measured at every position and rank, because a real player-season is not
// sixteen independent draws. It has PERSISTENT STATE: a torn ACL in week 3 zeroes the rest of the
// year, a breakout raises every remaining week, a bust lowers them. Independent weeks average those
// states away and produce a season total far too close to the mean:
//
//   pos rank   empirical season sd   iid-week sd   ratio    empirical p10/p90   iid p10/p90
//   RB 1              108                47         2.3         82 / 369         168 / 287
//   RB 10              86                36         2.4         62 / 284         123 / 215
//   QB 5               86                35         2.4        108 / 340         193 / 283
//   WR 5               65                33         2.0         99 / 263         145 / 231
//   TE 3               53                27         1.9         66 / 203         100 / 170
//
// Keeping the weeks GROUPED BY PLAYER-SEASON preserves that dependence exactly, with no model of it:
// draw a whole season, then read its weeks. The weekly marginal is unchanged (the same numbers are
// in the pool), so nothing downstream that reads a single week moves -- only the season-level
// dispersion, which is the thing that was wrong.
const raw = {};   // pos -> rank -> number[][] (one inner array per player-season)
for (const p of byKey.values()) {
  const prior = finishRank.get(`${p.season - 1}|${p.name}`);
  if (!prior) continue;                                  // no prior season -> no preseason rank proxy
  if (prior > (MAX_RANK[p.pos] ?? 60)) continue;
  const played = teamWeeks.get(`${p.season}|${p.team}`);
  if (!played || played.size < 8) continue;
  (raw[p.pos] ??= {});
  const bucket = (raw[p.pos][prior] ??= []);
  // In WEEK ORDER, so a mid-season injury reads as a run of zeros at the end rather than scattered.
  // That ordering is the whole point: it is what makes the trajectory a trajectory.
  const weeks = [...played].sort((a, b) => a - b).map((w) => Math.round((p.weeks.get(w) ?? 0) * 10) / 10);
  bucket.push(weeks);                                    // absent in a week his team played = 0
}

// Smooth: each rank's pool is itself plus neighbours, widening until MIN_TRAJ trajectories.
const model = { schema: 2, fittedFrom: "data/history-weekly.csv", seasons, smooth: SMOOTH, pos: {} };
console.log("bootstrap pools -- actual weekly TRAJECTORIES by position and PRESEASON rank (prior-year finish)");
console.log("  pos   ranks   median #traj   rank 1 -> season total mean / p10 / p90   (weekly mean)");
for (const pos of POS) {
  const byRank = raw[pos] ?? {};
  const out = {};
  const maxR = MAX_RANK[pos] ?? 60;
  for (let r = 1; r <= maxR; r++) {
    let width = SMOOTH, pool = [];
    while (width <= 12) {
      pool = [];
      for (let d = -width; d <= width; d++) pool.push(...(byRank[r + d] ?? []));
      if (pool.length >= MIN_TRAJ) break;
      width += 2;
    }
    if (pool.length >= EMIT_TRAJ) out[r] = pool;
  }
  model.pos[pos] = out;
  const sizes = Object.values(out).map((a) => a.length).sort((a, b) => a - b);
  const med = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  const one = out[1] ?? [];
  const totals = one.map((t) => t.reduce((a, b) => a + b, 0)).sort((a, b) => a - b);
  const mean = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0;
  const wk = one.flat();
  const wkMean = wk.length ? wk.reduce((a, b) => a + b, 0) / wk.length : 0;
  const q = (f) => totals.length ? totals[Math.floor(f * (totals.length - 1))] : 0;
  console.log(`  ${pos.padEnd(4)} ${String(Object.keys(out).length).padStart(6)} ${String(med).padStart(13)}   ${mean.toFixed(0)} / ${q(0.1).toFixed(0)} / ${q(0.9).toFixed(0)}   (${wkMean.toFixed(1)}/wk)`);
}
writeFileSync("data/rank-outcomes.json", JSON.stringify(model));
const bytes = readFileSync("data/rank-outcomes.json").length;
console.log(`\nwrote data/rank-outcomes.json (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
console.log(`\nThe p10 column is the point of this file: it is a REAL bad SEASON posted by a real player`);
console.log(`who entered at that rank, including the ones who got hurt in week 3. A fitted lognormal`);
console.log(`cannot produce that shape, a same-season rank join would have deleted it, and resampling`);
console.log(`the weeks independently -- which is what schema 1 forced -- averaged it away.`);
