// CAN WE IDENTIFY AN IN-SEASON WAIVER BREAKOUT BEFORE IT HAPPENS?
//
// THIS IS A PRE-FILTER, NOT A SCREEN, AND NOT A VERDICT. The charter's rule 2 exists because a full
// paired-season screen costs hours and most candidates die to a five-minute correlation check -- and
// because the check that matters is not "does it correlate with the outcome" (a level always does)
// but "does it correlate with what the INCUMBENT does not already explain". Raw `prior_vol` passed
// the naive version of this and was 0.58-correlated with the level the model already carries.
//
// WHY THIS IS A DIFFERENT QUESTION FROM THE ONES ALREADY REJECTED. `docs/feature-frontier.md` records
// NGS efficiency, the PBP situational-opportunity substrate and `prior_td_oe` as comprehensive nulls.
// Every one of those was screened on the PRESEASON projector: predict a SEASON TOTAL from PRIOR-SEASON
// features, over the whole player population. This asks something else entirely --
//
//     of the men NOBODY ROSTERS in week w, who is about to be worth starting for the rest of the year
//
// -- on a different population (the free-agent pool), from different features (in-season usage and
// role, not last year's efficiency), against a different baseline. A null there is not a null here.
//
// THE PANEL. `fact_fa_pool_week` is the real thing, not a reconstruction: who was on NOBODY's roster
// in week w of league 462233, with his rest-of-season points. 2018-2025, ~65k rows.
//
// POINT-IN-TIME, AND THE LEAK THIS AVOIDS. `ros_pts` is built with `g.week >= f.week`, so THE LABEL
// INCLUDES WEEK w ITSELF (verified against the data, not just read off the SQL: ros[w] - ros[w+1]
// equals that player's week-w points). Every feature therefore has to be knowable BEFORE week w's
// kickoff, which is exactly what `feat_player_week_model` at (season, week) is built to be -- it is
// the table the weekly model predicts week w's `pts` FROM. `actual_pts` is week w's score and is part
// of the label, so it is never a feature here.
//
// Usage: node --import tsx scripts/breakout-prefilter.mjs [--from 2018] [--to 2025] [--min-ros-games 4]
import Database from "better-sqlite3";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const FROM = Number(arg("--from", 2018)), TO = Number(arg("--to", 2025));
const MIN_ROS = Number(arg("--min-ros-games", 4));
const LEAGUE = arg("--league", "462233");
/**
 * COMPARE EVERY FEATURE ON THE SAME ROWS.
 *
 * `ecr_wk_rank` exists only for 2020-2024 (61% of rows); the usage features span 2018-2025. Printed
 * side by side without this flag, ECR's column is computed on a DIFFERENT and non-random subsample
 * than the features it is being ranked against -- two artifacts my own extraction encoded
 * differently, which is the comparison this repo has been burned by before.
 *
 * 2019 IS EXCLUDED UNDER THIS FLAG AND THAT IS NOT OPTIONAL: `ranking_history` holds exactly ONE
 * scrape for 2019, dated 2019-12-27, so a "week 3" ECR for that season would be a December opinion
 * about a September week -- textbook lookahead. 2020-2024 carry 15-20 distinct in-season scrape
 * dates each, which is what makes those knowable.
 */
const REQUIRE_ECR = process.argv.includes("--require-ecr");

const db = new Database("data/ff.db", { readonly: true });

/**
 * THE INCUMBENTS, named explicitly because a candidate is only interesting net of them.
 *   season_line_pg  the preseason-anchored per-game line -- what `waiverTargets` ranks the pool on
 *                   today (through value-over-replacement on the season projection).
 *   t4_mean         trailing-4 form -- what `policies.ts:addHottestFreeAgent` chases, and what its
 *                   own docstring says a real waiver claim actually follows.
 */
const INCUMBENTS = ["season_line_pg", "t4_mean"];

/** Candidates: in-season ROLE and USAGE, the things a preseason projector structurally cannot see. */
const CANDIDATES = [
  "prior_snap_share", "prior_route_share", "depth_rank", "teammates_out",
  "td_ts", "td_attempts", "td_rush_yards", "td_ppg", "t4_sd", "prior_vol_cv",
  "rz_share_td", "ecr_wk_rank",
];

const rows = db.prepare(`
  SELECT f.season, f.week, f.pos, f.ros_pts, f.ros_games,
         m.${[...INCUMBENTS, ...CANDIDATES].join(", m.")}
  FROM fact_fa_pool_week f
  JOIN feat_player_week_model m
    ON m.season = f.season AND m.week = f.week AND m.player_sk = f.player_sk
  WHERE f.league_id = ? AND f.season BETWEEN ? AND ? AND f.ros_games >= ?
    ${REQUIRE_ECR ? "AND m.ecr_wk_rank IS NOT NULL AND f.season <> 2019" : ""}
`).all(LEAGUE, FROM, TO, MIN_ROS);

console.log(`\nWAIVER-BREAKOUT PRE-FILTER -- league ${LEAGUE}, ${FROM}-${TO}, n=${rows.length} (free agent, week) rows` +
  (REQUIRE_ECR
    ? " [--require-ecr: every feature on the SAME rows; 2019 excluded, single December scrape]\n"
    : " [MIXED SUBSAMPLES: ecr_wk_rank covers 2020-2024 only and is NOT comparable to the usage rows -- use --require-ecr]\n"));

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
/** Fractional ranks, so one outlier week cannot drive a correlation. Ties share the average rank. */
function ranks(v) {
  const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(v.length);
  let i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
const corr = (a, b) => {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; dbb += y * y; }
  return da && dbb ? num / Math.sqrt(da * dbb) : NaN;
};
/** Residual of y on the columns of X (with intercept), by normal equations with a ridge nudge. */
function residual(y, X) {
  const n = y.length, p = X.length + 1;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  const col = (j, i) => (j === 0 ? 1 : X[j - 1][i]);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      b[j] += col(j, i) * y[i];
      for (let k = 0; k < p; k++) A[j][k] += col(j, i) * col(k, i);
    }
  }
  for (let j = 0; j < p; j++) A[j][j] += 1e-8;
  // Gaussian elimination.
  for (let j = 0; j < p; j++) {
    let piv = j;
    for (let k = j + 1; k < p; k++) if (Math.abs(A[k][j]) > Math.abs(A[piv][j])) piv = k;
    [A[j], A[piv]] = [A[piv], A[j]]; [b[j], b[piv]] = [b[piv], b[j]];
    if (Math.abs(A[j][j]) < 1e-12) continue;
    for (let k = j + 1; k < p; k++) {
      const f = A[k][j] / A[j][j];
      for (let l = j; l < p; l++) A[k][l] -= f * A[j][l];
      b[k] -= f * b[j];
    }
  }
  const c = new Array(p).fill(0);
  for (let j = p - 1; j >= 0; j--) {
    let s = b[j];
    for (let k = j + 1; k < p; k++) s -= A[j][k] * c[k];
    c[j] = Math.abs(A[j][j]) < 1e-12 ? 0 : s / A[j][j];
  }
  return y.map((yi, i) => yi - c.reduce((s, cj, j) => s + cj * col(j, i), 0));
}

/**
 * TWO TARGETS, because "breakout" and "worth claiming" are not the same question and conflating them
 * is how this kind of study fools itself.
 *
 *   LEVEL  rest-of-season points per game. This is the DECISION -- you claim the man who will score,
 *          whether or not his scoring is a surprise.
 *   JUMP   the same, minus his own preseason line. This is the BREAKOUT -- the part nobody saw
 *          coming. A signal that predicts only the LEVEL is re-discovering the projection.
 */
const TARGETS = {
  level: (r) => r.ros_pts / r.ros_games,
  jump: (r) => r.ros_pts / r.ros_games - (r.season_line_pg ?? 0),
};

for (const pos of ["RB", "WR", "TE", "QB"]) {
  const sub = rows.filter((r) => r.pos === pos && INCUMBENTS.every((k) => r[k] != null));
  if (sub.length < 300) { console.log(`  ${pos}: only ${sub.length} rows -- too thin to pre-filter`); continue; }

  console.log(`  ${pos}  n=${sub.length}`);
  console.log(`    feature                 rho(level)  partial(level)   rho(jump)  partial(jump)   n`);

  // Controls are rank-transformed too, so the partial is a Spearman partial rather than a mixture.
  for (const f of [...INCUMBENTS, ...CANDIDATES]) {
    const ok = sub.filter((r) => r[f] != null);
    if (ok.length < 200) { console.log(`    ${f.padEnd(22)} (n=${ok.length}, too thin)`); continue; }
    const fr = ranks(ok.map((r) => r[f]));
    const ctrl = INCUMBENTS.filter((c) => c !== f).map((c) => ranks(ok.map((r) => r[c])));
    const out = [];
    for (const [, fn] of Object.entries(TARGETS)) {
      const yr = ranks(ok.map(fn));
      const raw = corr(fr, yr);
      const part = corr(residual(fr, ctrl), residual(yr, ctrl));
      out.push(raw, part);
    }
    const isInc = INCUMBENTS.includes(f);
    console.log(`    ${(isInc ? "* " : "  ") + f.padEnd(20)} ${out.map((x) => x.toFixed(3).padStart(10)).join("  ")}  ${String(ok.length).padStart(6)}`);
  }
  console.log();
}
console.log("  * = INCUMBENT. `partial` is net of the OTHER incumbent, so a candidate's partial column");
console.log("    is what it adds to a ranking that already has both the season line and trailing form.");
console.log("  A candidate whose partial is near zero is the incumbent wearing a costume -- skip the screen.");
