// Recalibrate how THIS room behaves -- at the draft, and during the season.
//
//   node --import tsx scripts/tendencies.mjs [firstSeason] [lastSeason]
//
// Regenerated from the league API through the adaptor, so it can be re-run rather than hand-edited.
//
// TWO ERAS, AND THEY ARE NOT COMPARABLE. This league was 14 teams through 2024 and 16 from 2025.
// More teams means more money and more roster spots chasing the same players, so raw per-year
// POSITIONAL TOTALS cannot be compared across that line. Everything below is reported as a SHARE of
// the money actually in the room, which is comparable; dollar totals are shown only within an era.
//
// The in-season section exists because a draft recap says how a manager values positions in August
// and NOTHING about whether they stream, hoard FAAB, or stop setting a lineup in November. Each
// activity measure is paired with where the team FINISHED, because the only thing that makes a
// tendency actionable is whether it is associated with winning in this room.
import { openLeague } from "../src/league/index.ts";

const POS = ["QB", "RB", "WR", "TE", "K", "DST"];
const lg = await openLeague();
if (!lg.provider.history) { console.log(`the ${lg.provider.platform} adaptor exposes no history.`); await lg.close(); process.exit(1); }

const first = Number(process.argv[2] ?? lg.season - 3);
const last = Number(process.argv[3] ?? lg.season);
const seasons = [];
for (let y = first; y <= last; y++) seasons.push(y);
const snaps = (await lg.provider.history(seasons)).filter((s) => s.available);
await lg.close();

const drafted = snaps.filter((s) => s.picks.length);
console.log(`LEAGUE TENDENCIES -- seasons ${first}-${last}, regenerated ${new Date().toISOString().slice(0, 10)}\n`);

// =================================================================================================
// DRAFT
// =================================================================================================
console.log(`=== DRAFT ===\n`);
console.log("  season  teams  picks  total$  avg  median  top  >$50  >$30  $1-5");
const eras = new Map();
for (const s of drafted) {
  const prices = s.picks.map((p) => p.price).filter((n) => n > 0).sort((a, b) => a - b);
  if (!prices.length) continue;
  const tot = prices.reduce((a, b) => a + b, 0);
  const med = prices[Math.floor(prices.length / 2)];
  const cheap = prices.filter((p) => p <= 5).length / prices.length;
  console.log(`  ${s.season}    ${String(s.size ?? "?").padStart(4)} ${String(s.picks.length).padStart(6)} ${String(tot).padStart(7)} ${(tot / prices.length).toFixed(1).padStart(5)} ${String(med).padStart(7)} ${String(prices[prices.length - 1]).padStart(5)} ${String(prices.filter((p) => p > 50).length).padStart(5)} ${String(prices.filter((p) => p > 30).length).padStart(5)} ${(cheap * 100).toFixed(0).padStart(4)}%`);
  const era = s.size ?? 0;
  if (!eras.has(era)) eras.set(era, []);
  eras.get(era).push(s.season);
}
console.log(`\n  ERAS (league size): ${[...eras].map(([n, ys]) => `${n}-team: ${ys.join(", ")}`).join("   |   ")}`);

// positional SHARE of spend -- the era-comparable number
console.log(`\n  POSITIONAL SHARE of total spend (comparable across eras)`);
console.log("  season  " + POS.map((p) => p.padStart(6)).join(""));
const shareBy = {};
for (const s of drafted) {
  const tot = s.picks.reduce((a, p) => a + p.price, 0);
  if (!tot) continue;
  const sh = {};
  for (const p of POS) sh[p] = s.picks.filter((x) => x.pos === p).reduce((a, x) => a + x.price, 0) / tot;
  shareBy[s.season] = sh;
  console.log(`  ${s.season}  ` + POS.map((p) => `${(sh[p] * 100).toFixed(1)}%`.padStart(6)).join(""));
}
const yrs = Object.keys(shareBy);
if (yrs.length > 1) {
  console.log(`\n  DRIFT (latest vs the mean of earlier years):`);
  const latest = shareBy[yrs[yrs.length - 1]];
  const prior = yrs.slice(0, -1);
  for (const p of POS) {
    const was = prior.reduce((a, y) => a + shareBy[y][p], 0) / prior.length;
    const d = (latest[p] - was) * 100;
    if (Math.abs(d) >= 1.5) console.log(`    ${p.padEnd(4)} ${(d > 0 ? "+" : "") + d.toFixed(1)}pp  (${(was * 100).toFixed(1)}% -> ${(latest[p] * 100).toFixed(1)}%)`);
  }
}

// =================================================================================================
// IN-SEASON
// =================================================================================================
console.log(`\n\n=== IN-SEASON ===\n`);
// Only COMPLETED seasons carry meaningful activity: the current year is a few weeks old and its
// counters are near zero, which would drag every average toward "this league is passive".
const done = snaps.filter((s) => s.teams.some((t) => t.wins + t.losses > 0));
const live = snaps.filter((s) => !done.includes(s));
if (live.length) console.log(`  (${live.map((s) => s.season).join(", ")} excluded from averages -- season still in progress)\n`);
if (!done.length) { console.log("  no completed seasons in range."); process.exit(0); }

for (const s of done) {
  const T = s.teams.filter((t) => t.wins + t.losses > 0);
  const mean = (f) => T.reduce((a, t) => a + f(t), 0) / T.length;
  console.log(`  ${s.season}  (${T.length} teams)`);
  console.log(`    adds/team          ${mean((t) => t.acquisitions).toFixed(1).padStart(6)}   range ${Math.min(...T.map((t) => t.acquisitions))}-${Math.max(...T.map((t) => t.acquisitions))}`);
  console.log(`    FAAB spent/team    ${mean((t) => t.faabSpent).toFixed(1).padStart(6)}   range ${Math.min(...T.map((t) => t.faabSpent))}-${Math.max(...T.map((t) => t.faabSpent))}`);
  console.log(`    trades/team        ${mean((t) => t.trades).toFixed(1).padStart(6)}   league total ${T.reduce((a, t) => a + t.trades, 0) / 2} deals`);
  console.log(`    lineup moves/team  ${mean((t) => t.lineupMoves).toFixed(1).padStart(6)}   range ${Math.min(...T.map((t) => t.lineupMoves))}-${Math.max(...T.map((t) => t.lineupMoves))}`);
}

// --- does activity correlate with finishing well? -----------------------------------------------
// Spearman-style: correlate each activity measure against final rank across all completed
// team-seasons. Negative r = more activity goes with a BETTER (lower-numbered) finish.
const pool = done.flatMap((s) => s.teams.filter((t) => t.finalRank != null && t.wins + t.losses > 0));
const pearson = (xs, ys) => {
  const n = xs.length;
  if (n < 6) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const dx = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0));
  const dy = Math.sqrt(ys.reduce((a, y) => a + (y - my) ** 2, 0));
  return dx && dy ? num / (dx * dy) : null;
};
console.log(`\n  DOES ACTIVITY WIN? correlation with final rank, ${pool.length} team-seasons`);
console.log(`  (negative = more of it goes with a BETTER finish; |r| under ~${(2 / Math.sqrt(pool.length)).toFixed(2)} is noise at this n)`);
for (const [label, f] of [["adds", (t) => t.acquisitions], ["FAAB spent", (t) => t.faabSpent],
  ["trades", (t) => t.trades], ["lineup moves", (t) => t.lineupMoves], ["points for", (t) => t.pointsFor]]) {
  const r = pearson(pool.map(f), pool.map((t) => t.finalRank));
  if (r == null) { console.log(`    ${label.padEnd(14)} too few cases`); continue; }
  const strong = Math.abs(r) > 2 / Math.sqrt(pool.length);
  console.log(`    ${label.padEnd(14)} r = ${(r >= 0 ? "+" : "") + r.toFixed(3)}   ${strong ? (r < 0 ? "<-- more is BETTER" : "<-- more is WORSE") : "(noise)"}`);
}

// --- per-owner in-season profile ------------------------------------------------------------------
const byOwner = new Map();
for (const t of pool) {
  const k = t.owner || t.ownerId || t.id;
  if (!byOwner.has(k)) byOwner.set(k, []);
  byOwner.get(k).push(t);
}
const avg = (a, f) => a.reduce((x, t) => x + f(t), 0) / a.length;
const rows = [...byOwner].filter(([, a]) => a.length >= 2)
  .map(([owner, a]) => ({ owner, n: a.length, adds: avg(a, (t) => t.acquisitions), faab: avg(a, (t) => t.faabSpent),
    trades: avg(a, (t) => t.trades), moves: avg(a, (t) => t.lineupMoves), rank: avg(a, (t) => t.finalRank) }))
  .sort((a, z) => z.adds - a.adds);
console.log(`\n  PER-OWNER (2+ completed seasons), averages`);
console.log("    owner               yrs   adds   FAAB  trades  moves  avg finish");
for (const r of rows) {
  console.log(`    ${r.owner.slice(0, 18).padEnd(19)} ${String(r.n).padStart(3)} ${r.adds.toFixed(1).padStart(6)} ${r.faab.toFixed(0).padStart(6)} ${r.trades.toFixed(1).padStart(7)} ${r.moves.toFixed(0).padStart(6)} ${r.rank.toFixed(1).padStart(11)}`);
}
console.log(`\n  Averages over ${rows.length ? Math.min(...rows.map((r) => r.n)) : 0}-${rows.length ? Math.max(...rows.map((r) => r.n)) : 0} seasons per owner -- small n. Treat a single owner's row as a`);
console.log(`  hint, and the league-wide correlations above as the load-bearing finding.`);
