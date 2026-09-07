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
const MIN_POOL = 60;   // below this many observations, widen further

const rows = readFileSync("data/history-weekly.csv", "utf8").trim().split(/\r?\n/).slice(1);

// season -> name -> {pos, team, weeks:Map}
const byKey = new Map();
const teamWeeks = new Map();   // season|team -> Set(weeks the team played)
for (const line of rows) {
  const [season, name, pos, week, pts, team] = line.split(",");
  if (!POS.includes(pos)) continue;
  const s = Number(season), w = Number(week), p = Number(pts);
  if (!Number.isFinite(s) || !Number.isFinite(w) || !Number.isFinite(p)) continue;
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
const raw = {};   // pos -> rank -> number[]
for (const p of byKey.values()) {
  const prior = finishRank.get(`${p.season - 1}|${p.name}`);
  if (!prior) continue;                                  // no prior season -> no preseason rank proxy
  if (prior > (MAX_RANK[p.pos] ?? 60)) continue;
  const played = teamWeeks.get(`${p.season}|${p.team}`);
  if (!played || played.size < 8) continue;
  (raw[p.pos] ??= {});
  const bucket = (raw[p.pos][prior] ??= []);
  for (const w of played) bucket.push(p.weeks.get(w) ?? 0);   // absent in a week his team played = 0
}

// Smooth: each rank's pool is itself plus neighbours, widening until MIN_POOL observations.
const model = { fittedFrom: "data/history-weekly.csv", seasons, smooth: SMOOTH, pos: {} };
console.log("bootstrap pools -- actual weekly outcomes by position and PRESEASON rank (prior-year finish)");
console.log("  pos   ranks   median pool   example rank 1 -> mean / p10 / p90");
for (const pos of POS) {
  const byRank = raw[pos] ?? {};
  const out = {};
  const maxR = MAX_RANK[pos] ?? 60;
  for (let r = 1; r <= maxR; r++) {
    let width = SMOOTH, pool = [];
    while (width <= 12) {
      pool = [];
      for (let d = -width; d <= width; d++) pool.push(...(byRank[r + d] ?? []));
      if (pool.length >= MIN_POOL) break;
      width += 2;
    }
    if (pool.length >= 20) out[r] = pool.map((x) => Math.round(x * 10) / 10);
  }
  model.pos[pos] = out;
  const sizes = Object.values(out).map((a) => a.length).sort((a, b) => a - b);
  const med = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  const one = out[1] ?? [];
  const srt = [...one].sort((a, b) => a - b);
  const mean = one.length ? one.reduce((a, b) => a + b, 0) / one.length : 0;
  const q = (f) => srt.length ? srt[Math.floor(f * (srt.length - 1))] : 0;
  console.log(`  ${pos.padEnd(4)} ${String(Object.keys(out).length).padStart(6)} ${String(med).padStart(13)}   ${mean.toFixed(1)} / ${q(0.1).toFixed(1)} / ${q(0.9).toFixed(1)}`);
}
writeFileSync("data/rank-outcomes.json", JSON.stringify(model));
const bytes = readFileSync("data/rank-outcomes.json").length;
console.log(`\nwrote data/rank-outcomes.json (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
console.log(`\nThe p10 column is the point of this file: it is a REAL bad week for a real player who`);
console.log(`entered a season at that rank, including the ones who got hurt. A fitted lognormal`);
console.log(`cannot produce that shape, and a same-season rank join would have deleted it.`);
