// Fit the weekly-scoring variance model the forward season simulator needs, from 137k player-weeks
// of history (1999-2024). Writes data/variance-model.json.
//
//   node --import tsx scripts/fit-variance.mjs
//
// WHY THIS IS THE FIRST STEP. A season simulator that scores each player at projection/17 every week
// makes every team's record collapse toward its roster rank and reports absurdly confident playoff
// odds. What decides a fantasy season is the SPREAD, not the mean -- so the spread has to be
// measured, not assumed. Three things get fitted here:
//
//   1. WEEK-TO-WEEK CV, by position and tier. A weekly score is roughly mean x (1 + noise); the size
//      of that noise differs sharply by position (a QB is far steadier than a TE) and by tier (a
//      workhorse RB1 is steadier than an RB4 splitting carries).
//   2. AVAILABILITY. What fraction of a season's weeks a player at each position/tier actually
//      plays. This must be fitted over ALL players, including the ones who got hurt in week 2 --
//      restricting to players with enough games to estimate a CV would silently select for health.
//   3. SKEW. Fantasy weeks are right-skewed (a 40-point ceiling game, a floor of ~0). A symmetric
//      normal understates both the ceiling that wins a playoff game and the zero that loses one.
import { readFileSync, writeFileSync } from "node:fs";

const POS = ["QB", "RB", "WR", "TE", "K", "DST"];
const REG_WEEKS = 17;
const rows = readFileSync("data/history-weekly.csv", "utf8").trim().split(/\r?\n/).slice(1);

// season -> pos -> name -> weekly points
const bySeason = new Map();
for (const line of rows) {
  const [season, name, pos, week, pts] = line.split(",");
  if (!POS.includes(pos)) continue;
  const s = Number(season), p = Number(pts);
  if (!Number.isFinite(p)) continue;
  if (!bySeason.has(s)) bySeason.set(s, new Map());
  const m = bySeason.get(s);
  if (!m.has(pos)) m.set(pos, new Map());
  const byName = m.get(pos);
  if (!byName.has(name)) byName.set(name, []);
  byName.get(name).push(p);
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };

// Tier by within-season, within-position rank of TOTAL points -- the same way a draft board ranks.
// 4 tiers: roughly starters, flex-worthy, bench, deep.
const TIERS = 4;
const tierOf = (rank, n) => Math.min(TIERS - 1, Math.floor((rank / Math.max(1, n)) * TIERS));

const cvSamples = {}, availSamples = {}, skewSamples = {};
for (const p of POS) { cvSamples[p] = Array.from({ length: TIERS }, () => []); availSamples[p] = Array.from({ length: TIERS }, () => []); skewSamples[p] = Array.from({ length: TIERS }, () => []); }

for (const [, byPos] of bySeason) {
  for (const [pos, byName] of byPos) {
    const players = [...byName].map(([name, w]) => ({ name, w, total: w.reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.total - a.total);
    players.forEach((pl, rank) => {
      const t = tierOf(rank, players.length);
      // availability over ALL players at this tier -- including the week-2 injuries
      availSamples[pos][t].push(Math.min(1, pl.w.length / REG_WEEKS));
      // CV needs enough games to estimate a spread at all
      if (pl.w.length >= 6) {
        const m = mean(pl.w);
        if (m > 1) {
          cvSamples[pos][t].push(sd(pl.w) / m);
          const s = sd(pl.w);
          if (s > 0) skewSamples[pos][t].push(mean(pl.w.map((x) => ((x - m) / s) ** 3)));
        }
      }
    });
  }
}

// FALLBACK placeholders, used ONLY when a position genuinely has no weekly rows.
//
// These were previously applied to K and DST UNCONDITIONALLY, because at the time neither had any
// weekly data. Once history.ts started emitting both, the override kept firing and kept printing
// "UNFITTED" over 273 real kicker samples -- a guard keyed on a hardcoded NAME rather than on the
// condition it was standing in for, which is exactly the failure mode that survives the thing it
// was guarding against. It is now keyed on whether samples actually exist.
const FALLBACK = {
  K: { cv: 0.55, avail: 0.94, skew: 0.35 },
  DST: { cv: 0.80, avail: 1.00, skew: 0.70 },
  _: { cv: 0.80, avail: 0.85, skew: 0.60 },
};
const MIN_N = 30;   // below this a tier's CV is noise; fall back to the nearest well-populated tier

const unfitted = [];
const model = { fittedFrom: "data/history-weekly.csv", seasons: [...bySeason.keys()].sort(), tiers: TIERS, unfitted, pos: {} };
console.log("weekly scoring variance, by position and tier (tier 0 = best by season total)");
console.log("  pos  tier      n     CV   avail   skew   note");
for (const p of POS) {
  const anySamples = cvSamples[p].some((a) => a.length);
  if (!anySamples) unfitted.push(p);
  model.pos[p] = { cv: [], avail: [], skew: [], fitted: anySamples };
  for (let t = 0; t < TIERS; t++) {
    const cv = cvSamples[p][t], av = availSamples[p][t], sk = skewSamples[p][t];
    let cvV, avV, skV, note = "";
    if (!cv.length) {
      ({ cv: cvV, avail: avV, skew: skV } = FALLBACK[p] ?? FALLBACK._);
      note = "UNFITTED -- no weekly rows for this position";
    } else if (cv.length < MIN_N) {
      // borrow the last tier that had enough samples, rather than publish a 2-sample CV
      const prev = model.pos[p].cv.length ? model.pos[p].cv.length - 1 : 0;
      cvV = model.pos[p].cv[prev] ?? 1.0;
      avV = av.length ? mean(av) : 0.5;
      skV = model.pos[p].skew[prev] ?? 0.8;
      note = `n<${MIN_N}, CV borrowed from tier ${prev}`;
    } else {
      cvV = mean(cv); avV = mean(av); skV = mean(sk);
    }
    model.pos[p].cv.push(Number(cvV.toFixed(4)));
    model.pos[p].avail.push(Number(avV.toFixed(4)));
    model.pos[p].skew.push(Number(skV.toFixed(4)));
    console.log(`  ${p.padEnd(4)} ${t}  ${String(cv.length).padStart(5)}  ${cvV.toFixed(3)}   ${avV.toFixed(3)}  ${skV >= 0 ? "+" : ""}${skV.toFixed(2)}   ${note}`);
  }
}

writeFileSync("data/variance-model.json", JSON.stringify(model, null, 2));
console.log(`\nwrote data/variance-model.json (${model.seasons.length} seasons)`);
console.log(`\nRead the CV column: it is the fraction of a player's weekly mean that a typical week`);
console.log(`swings by. Anything near 1.0 means the position is close to a coin flip week to week,`);
console.log(`and a simulator that ignores it will report playoff odds far too confidently.`);
