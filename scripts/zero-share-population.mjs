// WHY THE WEEKLY GATE'S CLAUSE (c) CANNOT BE CLOSED BY RECALIBRATING THE STAGE-ONE INTERCEPT.
//
//   node --import tsx scripts/zero-share-population.mjs [trainMinLine=3]
//
// Clause (c) asks whether the two-part model's mean predicted P(zero week) matches the actual share,
// per position, within 0.030. It misses at RB (0.031), WR (0.039) and TE (0.074), always in the same
// direction. That looks exactly like a LEVEL error, and a level error has an obvious one-number fix:
// shift each position's stage-one logistic intercept until the mean predicted probability matches.
// That was pre-registered as P48 and it moved the intercepts by about 0.0005. It could not have
// moved them further, for two reasons this script makes visible:
//
//   1. AN MLE LOGISTIC WITH AN INTERCEPT IS ALREADY MEAN-CALIBRATED ON ITS OWN TRAINING SET. The
//      score equation for the intercept is exactly sum(p_i) = sum(y_i). Only the L2 penalty perturbs
//      it, and only slightly -- hence 0.0005 rather than 0. So there is nothing on the training fold
//      for a Platt shift to correct.
//
//   2. THE TWO POPULATIONS ARE NOT THE SAME POPULATION. The trainer fits on rows with
//      `season_line_pg >= trainMinLine`; the harness scores EVERY non-bye row, including the deep
//      bench where a zero is near-certain. The table below is the size of that difference, and it is
//      0.11 to 0.21 at QB/RB/WR/TE -- three to seven times the tolerance.
//
// Together those say the residual miss is not a level the intercept can carry: it is how far the
// FEATURES extrapolate across a population shift. They extrapolate well at QB (0.112 population gap,
// 0.009 residual -- clause (c) passes) and badly at TE (0.207 gap, 0.074 residual).
//
// And the fix that would "work" is the one that must not be taken: choosing the intercept on the
// SCORED rows fits the gate directly, which makes clause (c) unfailable and measures nothing.
import Database from 'better-sqlite3';
const db = new Database('data/ff.db', { readonly: true });
const MIN = Number(process.argv[2] ?? 3);
const rows = db.prepare(`
  SELECT pos,
         SUM(CASE WHEN COALESCE(pts,0) <= 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS zero_all,
         COUNT(*) AS n_all,
         SUM(CASE WHEN season_line_pg >= ? THEN 1 ELSE 0 END) AS n_train,
         SUM(CASE WHEN season_line_pg >= ? AND COALESCE(pts,0) <= 0 THEN 1 ELSE 0 END) * 1.0
           / NULLIF(SUM(CASE WHEN season_line_pg >= ? THEN 1 ELSE 0 END), 0) AS zero_train
    FROM feat_player_week_model
   WHERE COALESCE(is_bye,0) = 0 AND season BETWEEN 2012 AND 2025 AND season_line_pg > 0
   GROUP BY pos ORDER BY pos`).all(MIN, MIN, MIN);
console.log(`trainMinLine = ${MIN}`);
console.log('pos   scored n   zero(scored)   trained n   zero(trained)   gap');
for (const r of rows) {
  console.log(
    `${r.pos.padEnd(5)} ${String(r.n_all).padStart(8)}   ${r.zero_all.toFixed(3).padStart(10)}   ` +
    `${String(r.n_train).padStart(9)}   ${(r.zero_train ?? NaN).toFixed(3).padStart(11)}   ` +
    `${(r.zero_all - (r.zero_train ?? NaN)).toFixed(3).padStart(6)}`);
}
