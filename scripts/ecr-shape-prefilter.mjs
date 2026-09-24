// IS THE PANEL'S *SHAPE* (skew, range) ANYTHING OTHER THAN ITS SPREAD (sd), WHICH THE MODEL ALREADY
// FITS?
//
// This is a DISQUALIFIER, not a promise, and that distinction is the whole lesson of 2026-09-24:
// four candidates with strong residual-correlation screens were rejected by the gate, one of them
// harmfully, because a partial correlation measures whether SIGNAL EXISTS and says nothing about
// what a column COSTS. So this screen is allowed to say only "skip" -- never "expect a gain".
//
// WHY THESE CANDIDATES ARE WORTH THE QUESTION AT ALL. The one weekly feature this repo has ever
// admitted is `ecr_wk_rank` (+0.04134 pooled CRPS, 19x our floor), and what set it apart from the
// four rejects was PROVENANCE: it is a human panel's weekly forecast, information that exists
// nowhere in the store's own history, where every reject was a recombination of rows the model
// already held. `best` and `worst` come from that same panel, on the same weekly cadence, and the
// model does not read them -- it reads only `ecr` and `sd`.
//
//   range = worst - best                       how far apart the panel is, in ranks
//   skew  = ((worst-ecr) - (ecr-best)) / range  WHERE the consensus sits inside that spread:
//                                               +1 = all the disagreement is downside, -1 = upside
//
// `sd` is a moment and cannot express asymmetry: Dak Prescott at ecr 4.5 / sd 2.2 / best 2 /
// worst 16 and Aaron Rodgers at ecr 6.8 / sd 1.9 / best 2 / worst 10 have nearly the same spread
// and completely different shapes.
//
// THE DISQUALIFIER: if range is essentially a rescaled sd, and skew has no variance once the level
// is controlled, there is nothing here and the wiring is not worth doing.
import Database from "better-sqlite3";
import { corr, residualize, mean, sd as sdOf } from "./lib/linalg.mjs";

const db = new Database("data/ff.db", { readonly: true });
const rows = db.prepare(
  `SELECT season, scrape_date, pos, ecr, sd, best, worst
     FROM ranking_history
    WHERE ecr_type='wp' AND ecr IS NOT NULL AND sd IS NOT NULL
      AND best IS NOT NULL AND worst IS NOT NULL AND worst > best`,
).all();

const use = rows.map((r) => ({
  ...r,
  range: r.worst - r.best,
  skew: ((r.worst - r.ecr) - (r.ecr - r.best)) / (r.worst - r.best),
})).filter((r) => Number.isFinite(r.range) && Number.isFinite(r.skew));

console.log(`weekly consensus rows with a full shape: ${use.length} (seasons ${Math.min(...use.map((r) => r.season))}-${Math.max(...use.map((r) => r.season))})\n`);

const col = (k) => use.map((r) => Number(r[k]));
console.log("marginal distributions:");
for (const k of ["ecr", "sd", "range", "skew"]) {
  const v = col(k);
  console.log(`  ${k.padEnd(6)} mean ${mean(v).toFixed(3).padStart(8)}  sd ${sdOf(v).toFixed(3).padStart(7)}  min ${Math.min(...v).toFixed(2).padStart(7)}  max ${Math.max(...v).toFixed(2).padStart(8)}`);
}

console.log("\npairwise correlation (is `range` just `sd` rescaled?):");
for (const [a, b] of [["range", "sd"], ["skew", "sd"], ["skew", "range"], ["range", "ecr"], ["skew", "ecr"], ["sd", "ecr"]]) {
  console.log(`  ${(a + " ~ " + b).padEnd(16)} r = ${corr(col(a), col(b)).toFixed(4)}`);
}

// THE DECISIVE ONE: what survives after removing everything the model ALREADY reads (ecr, sd)?
// A candidate whose residual variance is near zero is arithmetic, not information.
console.log("\nresidual variance after regressing out the FITTED columns (ecr, sd):");
for (const k of ["range", "skew"]) {
  const y = col(k);
  const res = residualize(use, y, ["ecr", "sd"]);
  if (!res) { console.log(`  ${k}: SINGULAR`); continue; }
  const keep = sdOf(res) / sdOf(y);
  console.log(`  ${k.padEnd(6)} sd ${sdOf(y).toFixed(4)} -> residual sd ${sdOf(res).toFixed(4)}   retains ${(100 * keep).toFixed(1)}% of its spread`);
}

console.log("\nVERDICT IS A DISQUALIFIER ONLY. A column that retains little spread after ecr+sd is");
console.log("arithmetic on what the model already has -- skip it. A column that retains most of its");
console.log("spread has merely EARNED the gate; last night proved that is not the same as a gain.");
db.close();
