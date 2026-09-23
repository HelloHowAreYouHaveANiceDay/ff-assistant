// HOW MUCH DOES A BACKUP'S OUTPUT RISE IN THE WEEKS HIS LEAD IS OUT? -- the one number the season
// simulator needs to represent a handcuff, fitted from this repo's own (lead, backup) pairs.
//
// WHY A RATIO AND NOT A LIFT. `handcuff-lift-screen.mjs` fits a model that PREDICTS a backup's level
// from his projection -- a board question. This is a different question, for a different consumer:
// the simulator already draws the backup a real season with a real level, and it needs only the
// WITHIN-SEASON, WITHIN-PLAYER contrast between the weeks the lead played and the weeks he did not.
// That is `observedActive / observedBase`, which is exactly the CAUSAL baseline the screen carries
// and labels "diagnosis only" -- because for the board it IS only diagnosis. Here it is the estimand.
//
// Both callers read the SAME pairs from `lib/handcuff-pairs.mjs`, so this cannot silently drift from
// the gate or the screen.
//
// Usage: node --import tsx scripts/fit-handcuff-coupling.mjs [--from 2005] [--to 2025] [--out PATH]
import { writeFileSync } from "node:fs";
import { loadHistory, byeIndex, buildPairs, POS } from "./lib/handcuff-pairs.mjs";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const FROM = Number(arg("--from", 2005)), TO = Number(arg("--to", 2025));
const LEAD_MAX_RANK = Number(arg("--lead-max-rank", 36));
const OUT = arg("--out", "data/handcuff-coupling.json");

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const H = loadHistory();
const pairs = buildPairs(H, byeIndex(H), { from: FROM, to: TO, leadMaxRank: LEAD_MAX_RANK })
  // Both halves of the contrast must be OBSERVED. `observedBase` falls back to the projection proxy
  // when the backup never played alongside his lead, and a ratio built on that fallback would be
  // measuring the proxy, not the player.
  .filter((p) => p.leadMissedGames > 0 && p.observedActive != null && p.playedWeeks > 0 && p.observedBase > 0);

const seasons = [...new Set(pairs.map((p) => p.season))].sort((a, b) => a - b);

/**
 * THE RATIO IS FITTED ON POOLED MEANS, NOT AS A MEAN OF RATIOS.
 *
 * A per-pair ratio `observedActive / observedBase` explodes whenever the denominator is small -- a
 * backup who averaged 0.4 points beside his lead and 6 without him is a ratio of 15, and a handful
 * of those dominate any average. The pooled form (mean active / mean base) weights each pair by the
 * points it actually represents, which is the quantity the simulator is reproducing.
 */
const ratioFor = (rows) => {
  if (!rows.length) return null;
  const base = mean(rows.map((p) => p.observedBase));
  const active = mean(rows.map((p) => p.observedActive));
  return base > 0 ? { n: rows.length, base, active, ratio: active / base } : null;
};

console.log(`\nHANDCUFF COUPLING -- ${FROM}-${TO}, n=${pairs.length} pairs with an observed absence AND observed play beside the lead\n`);
console.log("  pos      n    base/wk   active/wk   ratio   leave-season-out spread");

const byPos = {};
for (const pos of POS) {
  const rows = pairs.filter((p) => p.pos === pos);
  const all = ratioFor(rows);
  if (!all) { console.log(`  ${pos.padEnd(5)} (no pairs)`); continue; }

  // LEAVE-SEASON-OUT, reported as a SPREAD rather than a single number, because a constant fitted on
  // every season and then shipped into a simulator that scores those same seasons is an in-sample
  // constant. The spread says how much of this ratio is the era and how much is the effect.
  const loo = seasons.map((Y) => ratioFor(rows.filter((p) => p.season !== Y))?.ratio).filter((x) => x != null);
  const lo = Math.min(...loo), hi = Math.max(...loo);
  byPos[pos] = { n: all.n, ratio: all.ratio, looMin: lo, looMax: hi };
  console.log(`  ${pos.padEnd(5)} ${String(all.n).padStart(5)}    ${all.base.toFixed(2).padStart(6)}    ${all.active.toFixed(2).padStart(7)}   ${all.ratio.toFixed(3).padStart(5)}   ${lo.toFixed(3)} - ${hi.toFixed(3)}`);
}

/**
 * THE NULL THIS HAS TO BEAT, stated here so it is not quietly skipped: if the ratio is 1.0 the
 * coupling is a no-op and the simulator's independence assumption was right all along. A ratio
 * whose leave-season-out spread STRADDLES 1.0 is not a finding, it is noise with a point estimate.
 */
for (const pos of POS) {
  const b = byPos[pos];
  if (!b) continue;
  if (b.looMin <= 1 && b.looMax >= 1) console.log(`  NOTE ${pos}: the leave-season-out spread straddles 1.0 -- not distinguishable from no coupling.`);
}

const out = {
  builtAt: new Date().toISOString(),
  source: "data/history-weekly.csv via scripts/lib/handcuff-pairs.mjs",
  window: { from: FROM, to: TO, leadMaxRank: LEAD_MAX_RANK },
  estimand: "E[backup points per week | lead OUT] / E[backup points per week | lead PLAYED], within player, within season",
  byPos: Object.fromEntries(Object.entries(byPos).map(([k, v]) => [k, Math.round(v.ratio * 1e4) / 1e4])),
  detail: byPos,
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`\n  wrote ${OUT}`);
