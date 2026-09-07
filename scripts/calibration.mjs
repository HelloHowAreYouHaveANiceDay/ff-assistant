// Is our uncertainty HONEST? A calibration check on the bootstrap pools.
//
//   node --import tsx scripts/calibration.mjs
//
// Everything we measure today asks whether the projection is ACCURATE -- MAE against ESPN,
// championship rate against a baseline. Nothing asks whether the stated UNCERTAINTY is right: when
// the simulator says 40%, does it happen 40% of the time? An accurate point estimate with dishonest
// error bars is a worse input to a season simulation than a vaguer one that knows it is vague,
// because the whole output is a distribution.
//
// THE TEST: probability integral transform (PIT). For a well-calibrated predictive distribution, the
// quantile at which the ACTUAL outcome lands should be uniform on [0,1]. Take every historical
// player-week, find where that week's real score falls inside the bootstrap pool we would have used
// for him, and histogram those quantiles. Uniform means honest. A hump in the middle means the
// distribution is too WIDE (we claim more uncertainty than we have). Weight in the tails means it is
// too NARROW -- reality surprises us more often than we said it would, which is the dangerous
// direction for a playoff-odds model.
//
// LEAVE-ONE-SEASON-OUT, and this is the part that makes it a real test. The pools are built from
// history that INCLUDES the season being scored. Testing against a pool that already contains the
// answer measures memorisation, not calibration -- so each season is scored against pools rebuilt
// with that season removed.
import { readFileSync } from "node:fs";

const POS = ["QB", "RB", "WR", "TE", "K", "DST"];
const MAX_RANK = { QB: 40, RB: 90, WR: 110, TE: 45, K: 40, DST: 40 };
const SMOOTH = 2, MIN_POOL = 60;
const TEST_SEASONS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

// --- load history once ---------------------------------------------------------------------------
const byKey = new Map();       // season|name -> {season,name,pos,team,weeks:Map}
const teamWeeks = new Map();   // season|team -> Set(weeks)
for (const line of readFileSync("data/history-weekly.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
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
const players = [...byKey.values()];
const seasons = [...new Set(players.map((p) => p.season))].sort();

// finish rank per (season, pos)
const finishRank = new Map();
for (const s of seasons) {
  for (const pos of POS) {
    players.filter((p) => p.season === s && p.pos === pos)
      .map((p) => ({ p, tot: [...p.weeks.values()].reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.tot - a.tot)
      .forEach((x, i) => finishRank.set(`${s}|${x.p.name}`, i + 1));
  }
}

/** Bootstrap pools built from every season EXCEPT `exclude`. Same construction as fit-bootstrap. */
function poolsExcluding(exclude) {
  const raw = {};
  for (const p of players) {
    if (p.season === exclude) continue;
    const prior = finishRank.get(`${p.season - 1}|${p.name}`);
    if (!prior || prior > (MAX_RANK[p.pos] ?? 60)) continue;
    const played = teamWeeks.get(`${p.season}|${p.team}`);
    if (!played || played.size < 8) continue;
    (raw[p.pos] ??= {});
    const b = (raw[p.pos][prior] ??= []);
    for (const w of played) b.push(p.weeks.get(w) ?? 0);
  }
  const out = {};
  for (const pos of POS) {
    const byRank = raw[pos] ?? {};
    out[pos] = {};
    for (let r = 1; r <= (MAX_RANK[pos] ?? 60); r++) {
      let width = SMOOTH, pool = [];
      while (width <= 12) {
        pool = [];
        for (let d = -width; d <= width; d++) pool.push(...(byRank[r + d] ?? []));
        if (pool.length >= MIN_POOL) break;
        width += 2;
      }
      if (pool.length >= 20) out[pos][r] = pool.sort((a, b) => a - b);
    }
  }
  return out;
}

// --- run the PIT ----------------------------------------------------------------------------------
const BINS = 10;
const hist = {}, all = new Array(BINS).fill(0);
for (const pos of POS) hist[pos] = new Array(BINS).fill(0);
let n = 0;
for (const testSeason of TEST_SEASONS) {
  const pools = poolsExcluding(testSeason);
  for (const p of players) {
    if (p.season !== testSeason) continue;
    const prior = finishRank.get(`${p.season - 1}|${p.name}`);
    if (!prior || prior > (MAX_RANK[p.pos] ?? 60)) continue;
    const pool = pools[p.pos]?.[prior];
    if (!pool || pool.length < 20) continue;
    const played = teamWeeks.get(`${p.season}|${p.team}`);
    if (!played) continue;
    for (const w of played) {
      const actual = p.weeks.get(w) ?? 0;
      // RANDOMIZED PIT. The pools contain a large ATOM at exactly 0 (weeks a player's team played and
      // he did not), and standard PIT is invalid for a discrete distribution: every actual 0 would
      // take the quantile at the TOP of the zero mass, systematically pushing the entire atom up and
      // out of the bottom decile. A first version of this did exactly that and reported the
      // distributions as "too wide" -- the bottom decile held 1.5% against an expected 10%, which was
      // an artefact of tie handling, not a property of the model.
      //
      // The fix is standard: for an atom spanning [P(X < x), P(X <= x)], draw uniformly inside it.
      // A calibrated forecast is then uniform even with atoms.
      let loI = 0, hiI = pool.length;
      while (loI < hiI) { const mid = (loI + hiI) >> 1; if (pool[mid] < actual) loI = mid + 1; else hiI = mid; }
      const below = loI;
      loI = 0; hiI = pool.length;
      while (loI < hiI) { const mid = (loI + hiI) >> 1; if (pool[mid] <= actual) loI = mid + 1; else hiI = mid; }
      const atOrBelow = loI;
      const q = Math.min(0.999999, (below + Math.random() * (atOrBelow - below)) / pool.length);
      const b = Math.min(BINS - 1, Math.floor(q * BINS));
      hist[p.pos][b]++; all[b]++; n++;
    }
  }
}

const expected = 100 / BINS;
console.log(`PIT CALIBRATION -- ${n.toLocaleString()} player-weeks, leave-one-season-out over ${TEST_SEASONS.length} seasons`);
console.log(`each decile should hold ${expected.toFixed(1)}% if the predictive distribution is honest\n`);
const bar = (pct) => "#".repeat(Math.round(pct * 2));
console.log("  decile   share    (bar; even = calibrated)");
for (let b = 0; b < BINS; b++) {
  const pct = 100 * all[b] / n;
  console.log(`  ${String(b * 10).padStart(3)}-${String((b + 1) * 10).padEnd(3)} ${pct.toFixed(1).padStart(5)}%   ${bar(pct)}`);
}
// a single number: mean absolute deviation from uniform, in percentage points
const mad = all.reduce((a, c) => a + Math.abs(100 * c / n - expected), 0) / BINS;
console.log(`\n  mean absolute deviation from uniform: ${mad.toFixed(2)}pp per decile`);
console.log(`  (0 = perfect. Under ~1pp is good; over ~3pp means the stated uncertainty is wrong.)`);

// tails vs middle -- the diagnostic that says WHICH WAY it is wrong
const tails = (all[0] + all[BINS - 1]) / n * 100;
const mid = (all[4] + all[5]) / n * 100;
console.log(`\n  outer two deciles: ${tails.toFixed(1)}%  (expect ${(2 * expected).toFixed(1)}%)`);
console.log(`  inner two deciles: ${mid.toFixed(1)}%  (expect ${(2 * expected).toFixed(1)}%)`);
console.log(tails > 2 * expected + 2
  ? "  -> TOO NARROW: reality lands outside our range more often than we claim. Playoff odds will be OVERCONFIDENT."
  : mid > 2 * expected + 2
    ? "  -> TOO WIDE: we claim more uncertainty than we have. Odds will be mushy, pulled toward 50%."
    : "  -> tails and centre both near expectation; the width of the distribution is about right.");

console.log(`\n  by position (mean absolute deviation from uniform, pp per decile):`);
for (const pos of POS) {
  const tot = hist[pos].reduce((a, b) => a + b, 0);
  if (!tot) continue;
  const m = hist[pos].reduce((a, c) => a + Math.abs(100 * c / tot - expected), 0) / BINS;
  console.log(`    ${pos.padEnd(4)} ${m.toFixed(2).padStart(5)}   (${tot.toLocaleString()} player-weeks)`);
}
