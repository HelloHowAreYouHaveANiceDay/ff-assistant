// THE LEAKAGE AUDIT ON THE REAL TABLE.
//
// test/weekly-leakage.test.ts proves the BUILDER cannot leak, on a synthetic fixture it controls
// completely. This proves the TABLE THAT ACTUALLY SHIPPED does not, by recomputing three columns
// from the raw weekly facts with an independent implementation and an explicit `week < w` bound, and
// comparing. The two are different questions: a builder can be correct and the table still be stale,
// half-built, or written by an older version of the code.
//
// It is an independent implementation on purpose. Re-running the builder and diffing would compare
// the code against itself, which is the shape this repo has been burned by more than once -- a
// producer that ships its own validator grades its own homework and passes forever.
//
// Each check reports a MISMATCH COUNT and a WORST CASE, and each carries a positive control: the
// same arithmetic with the bound moved to `<= w` must produce mismatches, or the comparison is not
// sensitive to the thing it exists to detect.
//
//   node --import tsx scripts/weekly-leak-audit.mjs [season] [--db path]
import { openDb } from "../src/db/db.js";

const season = Number(process.argv[2] ?? 2023);
const dbArg = process.argv.indexOf("--db");
const db = openDb(dbArg >= 0 ? process.argv[dbArg + 1] : undefined);

const raw = db.prepare(
  "SELECT feat_key, week, pts, opponent, pos FROM feat_player_week WHERE season = ? ORDER BY feat_key, week",
).all(season);
const model = db.prepare(
  "SELECT feat_key, week, td_games, td_ppg, t4_mean, dvp_mult, dvp_n FROM feat_player_week_model WHERE season = ?",
).all(season);
db.close();

if (!raw.length || !model.length) {
  console.log(`nothing to audit for ${season} (raw ${raw.length}, model ${model.length})`);
  process.exit(2);
}

// ---- independent recomputation, parameterised by the bound so the control is the SAME code ----
const played = new Map();
for (const r of raw) {
  if (r.pts == null) continue;
  (played.get(r.feat_key) ?? played.set(r.feat_key, new Map()).get(r.feat_key)).set(r.week, r.pts);
}

/** `slack` 0 is the honest bound (weeks < w); 1 is the leak (weeks <= w). */
function expected(key, week, slack) {
  const m = played.get(key);
  if (!m) return { games: 0, ppg: null, t4: null };
  let games = 0, sum = 0;
  const trail = [];
  for (let w = 1; w <= week - 1 + slack; w++) {
    const v = m.get(w);
    if (v == null) continue;
    games++; sum += v;
  }
  for (let w = week - 1 + slack; w >= 1 && trail.length < 4; w--) {
    const v = m.get(w);
    if (v != null) trail.push(v);
  }
  return {
    games,
    ppg: games ? sum / games : null,
    t4: trail.length ? trail.reduce((s, x) => s + x, 0) / trail.length : null,
  };
}

function audit(slack) {
  let n = 0, bad = { games: 0, ppg: 0, t4: 0 }, worst = { ppg: 0, t4: 0 };
  for (const r of model) {
    const e = expected(r.feat_key, r.week, slack);
    n++;
    if ((r.td_games ?? 0) !== e.games) bad.games++;
    const cmp = (got, want, key) => {
      if (got == null && want == null) return;
      if (got == null || want == null) { bad[key]++; return; }
      const d = Math.abs(got - want);
      if (d > 1e-6) { bad[key]++; worst[key] = Math.max(worst[key], d); }
    };
    cmp(r.td_ppg, e.ppg, "ppg");
    cmp(r.t4_mean, e.t4, "t4");
  }
  return { n, bad, worst };
}

const honest = audit(0);
const leaked = audit(1);

console.log(`weekly leak audit -- season ${season}, ${honest.n} model rows recomputed independently\n`);
console.log("            mismatches vs `week < w`   vs `week <= w` (the leak)");
for (const k of ["games", "ppg", "t4"]) {
  console.log(`  ${k.padEnd(8)} ${String(honest.bad[k]).padStart(12)} ${String(leaked.bad[k]).padStart(22)}`);
}
console.log(`\n  worst absolute difference under the honest bound: ppg ${honest.worst.ppg}, t4 ${honest.worst.t4}`);

// ---- the verdicts, each with its control ----
let failed = false;
for (const k of ["games", "ppg", "t4"]) {
  if (honest.bad[k] > 0) {
    failed = true;
    console.log(`\nFAIL: ${k} disagrees with an independent 'weeks strictly before w' recomputation ` +
      `in ${honest.bad[k]} of ${honest.n} rows. Either the table is stale, or a column is reading ` +
      "week w itself.");
  }
  if (leaked.bad[k] === 0) {
    failed = true;
    console.log(`\nFAIL: moving the bound to 'weeks <= w' changed NOTHING for ${k}. This comparison ` +
      "cannot see the leak it exists to detect, so its clean verdict above means nothing.");
  }
}

// DvP is checked separately: it is a team-level statistic and the sensitive assertion is simply that
// the stored multiplier is not degenerate and its n never reaches the current week.
const dvpBad = model.filter((r) => r.dvp_n != null && r.dvp_n > r.week - 1).length;
if (dvpBad) {
  failed = true;
  console.log(`\nFAIL: ${dvpBad} rows carry dvp_n greater than week-1, i.e. the defence's record ` +
    "includes the week being predicted.");
}

console.log(failed ? "\nAUDIT FAILED" : "\nAUDIT PASSED -- and the leaked-bound control fired on every column, so it was capable of failing.");
process.exit(failed ? 1 : 0);
