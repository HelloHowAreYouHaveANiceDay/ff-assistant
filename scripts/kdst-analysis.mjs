// K/DST validation on the league's REAL box scores (leak-free historical accounting).
// Answers: (Q1) magnitude, (Q2) do K/DST DECIDE games (counterfactual flip), (Q3) the user's
// asymmetry -- do they win weeks more than they cause losses -- and the skew mechanism behind it.
import Database from "better-sqlite3";
const db = new Database("H:/working/ff-assistant/data/ff.db", { readonly: true });

// ---- load per-team-week: total, K pts, DST pts -------------------------------------------------
const rows = db.prepare(
  "SELECT season, week, team_id, started_pts, slots_json FROM fact_lineup_week WHERE slots_json IS NOT NULL AND started_pts IS NOT NULL"
).all();
const tw = new Map(); // key season|week|team -> {tot,k,dst}
for (const r of rows) {
  let slots; try { slots = JSON.parse(r.slots_json); } catch { continue; }
  let k = 0, dst = 0, hasK = false, hasD = false;
  for (const s of slots) {
    const slot = s[0], pts = Number(s[2]) || 0;
    if (slot === "K") { k += pts; hasK = true; }
    else if (slot === "DST" || slot === "D/ST" || slot === "DEF") { dst += pts; hasD = true; }
  }
  if (!hasK && !hasD) continue; // team-week with no K/DST slot (rare/format) -> skip
  tw.set(`${r.season}|${r.week}|${r.team_id}`, { tot: r.started_pts, k, dst, kd: k + dst, season: r.season, week: r.week });
}

// ---- weekly league expectation for K, DST (mean across all started that week) -------------------
const wk = new Map(); // season|week -> {kSum,dSum,n}
for (const v of tw.values()) {
  const key = `${v.season}|${v.week}`;
  const w = wk.get(key) || { kSum: 0, dSum: 0, n: 0 };
  w.kSum += v.k; w.dSum += v.dst; w.n++; wk.set(key, w);
}
const expOf = (season, week) => {
  const w = wk.get(`${season}|${week}`); if (!w || !w.n) return null;
  return { k: w.kSum / w.n, dst: w.dSum / w.n, kd: (w.kSum + w.dSum) / w.n };
};

// ---- matchups: join both teams ----------------------------------------------------------------
const matchups = db.prepare(
  "SELECT season, week, home_id, away_id FROM fact_matchup WHERE home_id IS NOT NULL AND away_id IS NOT NULL ORDER BY season, week"
).all();

const games = []; // per matchup: {season, margin(home-away), homeKD, awayKD, exp}
let unmatched = 0;
for (const m of matchups) {
  const h = tw.get(`${m.season}|${m.week}|${m.home_id}`);
  const a = tw.get(`${m.season}|${m.week}|${m.away_id}`);
  if (!h || !a) { unmatched++; continue; }
  const exp = expOf(m.season, m.week); if (!exp) continue;
  games.push({ season: m.season, week: m.week, margin: h.tot - a.tot, h, a, exp });
}

// ---- helpers ----------------------------------------------------------------------------------
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const skew = (xs) => { const m = mean(xs), s = sd(xs); return s === 0 ? 0 : mean(xs.map((x) => ((x - m) / s) ** 3)); };
const bySeasonBoot = (perGameVal, reduce, B = 2000) => {
  // block bootstrap by SEASON (unit of analysis)
  const seasons = [...new Set(games.map((g) => g.season))];
  const bySeason = new Map(seasons.map((s) => [s, games.filter((g) => g.season === s)]));
  const stats = [];
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let b = 0; b < B; b++) {
    const samp = [];
    for (let i = 0; i < seasons.length; i++) samp.push(...bySeason.get(seasons[Math.floor(rnd() * seasons.length)]));
    stats.push(reduce(samp.map(perGameVal)));
  }
  stats.sort((x, y) => x - y);
  return [stats[Math.floor(B * 0.05)], stats[Math.floor(B * 0.95)]];
};

// ================= Q1: MAGNITUDE =================
const totals = games.flatMap((g) => [g.h.tot, g.a.tot]);
const kds = games.flatMap((g) => [g.h.kd, g.a.kd]);
const ks = games.flatMap((g) => [g.h.k, g.a.k]);
const dsts = games.flatMap((g) => [g.h.dst, g.a.dst]);
console.log("=".repeat(70));
console.log(`GAMES: ${games.length} matchups joined (${unmatched} unmatched dropped), 2018-2025`);
console.log("=".repeat(70));
console.log("\n### Q1 MAGNITUDE -- how much of a team's week is K/DST?");
console.log(`  team total: mean ${mean(totals).toFixed(1)} sd ${sd(totals).toFixed(1)}`);
console.log(`  K+DST:      mean ${mean(kds).toFixed(1)} sd ${sd(kds).toFixed(1)}  (${(100 * mean(kds) / mean(totals)).toFixed(1)}% of the total)`);
console.log(`  K alone:    mean ${mean(ks).toFixed(1)} sd ${sd(ks).toFixed(1)}`);
console.log(`  DST alone:  mean ${mean(dsts).toFixed(1)} sd ${sd(dsts).toFixed(1)}`);

// ================= Q2: DO K/DST DECIDE GAMES? (counterfactual: both -> neutral) =================
// newMargin = margin - dKDST, dKDST = homeKD - awayKD. flip iff sign changes.
let flips = 0, close = 0;
const swingKD = sd(kds.map((x) => x)); // rough K/DST swing scale
for (const g of games) {
  const dKD = g.h.kd - g.a.kd;
  const newMargin = g.margin - dKD;
  if (Math.sign(newMargin) !== Math.sign(g.margin) && g.margin !== 0) flips++;
  if (Math.abs(g.margin) < Math.abs(dKD)) close++; // margin smaller than the KD differential
}
const flipRate = flips / games.length;
const flipCI = bySeasonBoot(
  (g) => (Math.sign(g.margin - (g.h.kd - g.a.kd)) !== Math.sign(g.margin) && g.margin !== 0) ? 1 : 0,
  (xs) => mean(xs)
);
console.log("\n### Q2 DO K/DST DECIDE GAMES? (both teams -> league-average K/DST; the differential cancels)");
console.log(`  FLIP RATE: ${flips}/${games.length} = ${(100 * flipRate).toFixed(1)}%  (season-bootstrap 90% CI [${(100 * flipCI[0]).toFixed(1)}, ${(100 * flipCI[1]).toFixed(1)}]%)`);
console.log(`  = share of games whose winner's K/DST advantage exceeded the final margin.`);

// ================= Q3: ASYMMETRY -- win weeks vs cause losses (team-centric) =================
// For each TEAM-week: replace ONLY that team's K/DST with the weekly expectation, hold the opponent.
// dev = team.kd - exp.kd. team won & dev>margin -> K/DST WON it. team lost & dev<margin(<0) -> K/DST LOST it.
let kdstWon = 0, kdstLost = 0, teamWeeks = 0;
const devs = [];
for (const g of games) {
  for (const [me, opp, sign] of [[g.h, g.a, 1], [g.a, g.h, -1]]) {
    const margin = sign * g.margin; // my total - opp total
    if (margin === 0) continue;
    const dev = me.kd - g.exp.kd;
    devs.push(dev);
    teamWeeks++;
    if (margin > 0 && dev > margin) kdstWon++;      // I won, and w/o my K/DST edge I'd lose
    if (margin < 0 && dev < margin) kdstLost++;      // I lost, and w/ average K/DST I'd have won
  }
}
const wonCI = bySeasonBoot((g) => {
  let c = 0; for (const [me, opp, sign] of [[g.h, g.a, 1], [g.a, g.h, -1]]) { const m = sign * g.margin; if (m > 0 && me.kd - g.exp.kd > m) c++; } return c;
}, (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length * 2));
const lostCI = bySeasonBoot((g) => {
  let c = 0; for (const [me, opp, sign] of [[g.h, g.a, 1], [g.a, g.h, -1]]) { const m = sign * g.margin; if (m < 0 && me.kd - g.exp.kd < m) c++; } return c;
}, (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length * 2));
console.log("\n### Q3 THE ASYMMETRY -- does your K/DST WIN weeks more than it CAUSES losses?");
console.log(`  team-weeks analysed: ${teamWeeks}`);
console.log(`  K/DST WON the week:   ${kdstWon} (${(100 * kdstWon / teamWeeks).toFixed(1)}%, CI [${(100 * wonCI[0]).toFixed(1)}, ${(100 * wonCI[1]).toFixed(1)}]) -- you won BECAUSE your K/DST beat average by more than the margin`);
console.log(`  K/DST CAUSED a loss:  ${kdstLost} (${(100 * kdstLost / teamWeeks).toFixed(1)}%, CI [${(100 * lostCI[0]).toFixed(1)}, ${(100 * lostCI[1]).toFixed(1)}]) -- you lost, and average K/DST would have won it`);
console.log(`  RATIO won:lost = ${(kdstWon / Math.max(1, kdstLost)).toFixed(2)} : 1`);

// ================= the mechanism: SKEW =================
console.log("\n### THE MECHANISM -- skew of K/DST outcomes (right-skew => booms bigger than busts)");
console.log(`  skewness  K+DST points: ${skew(kds).toFixed(2)}   K: ${skew(ks).toFixed(2)}   DST: ${skew(dsts).toFixed(2)}   (deviation-from-week-exp: ${skew(devs).toFixed(2)})`);
const expKdAll = mean(kds);
const bigUp = kds.filter((x) => x > expKdAll + swingKD).length, bigDn = kds.filter((x) => x < expKdAll - swingKD).length;
console.log(`  big BOOM (K+DST > mean+1sd): ${bigUp} team-weeks (${(100 * bigUp / kds.length).toFixed(1)}%)   big BUST (< mean-1sd): ${bigDn} (${(100 * bigDn / kds.length).toFixed(1)}%)`);
const p = (a, xs) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length * a)]; };
console.log(`  K+DST distribution: min ${Math.min(...kds).toFixed(0)}  p10 ${p(.1, kds).toFixed(0)}  p50 ${p(.5, kds).toFixed(0)}  mean ${expKdAll.toFixed(1)}  p90 ${p(.9, kds).toFixed(0)}  max ${Math.max(...kds).toFixed(0)}`);
console.log(`  DST alone:          min ${Math.min(...dsts).toFixed(0)}  p10 ${p(.1, dsts).toFixed(0)}  p50 ${p(.5, dsts).toFixed(0)}  p90 ${p(.9, dsts).toFixed(0)}  max ${Math.max(...dsts).toFixed(0)}  (floor near 0, right tail from return/def TDs)`);
