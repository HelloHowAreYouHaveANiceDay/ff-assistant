// DOES IN-SEASON USAGE IMPROVE THE WAIVER RANKING? -- leave-season-out, paired by season, 2.9*SE.
//
// `breakout-prefilter.mjs` said the usage family carries signal the incumbent does not: route and
// snap share partial 0.15-0.31 net of BOTH the season line and trailing form, consistent at all four
// positions. A pre-filter admits nothing. This is the screen.
//
// THE BASELINE IS FITTED, NOT A STRAWMAN. Arm B is an OLS on the two incumbent signals, which is
// STRONGER than what ships (arm A ranks on the season line alone, which is what `waiverTargets`
// does through value-over-replacement). Beating A while losing to B would mean the gain was "use
// trailing form at all", not "use usage" -- the same mistake as crediting `multQB` for what `aggr`
// was doing. The verdict is C vs B. A is printed so the shipped posture is visible.
//
// THE METRIC IS THE DECISION, NOT THE FIT. R-squared on 18,000 rows answers a question nobody asks.
// A waiver claim is a RANKING problem with K around 3-5: of the free agents available at this
// position in this week, the ones I would actually consider. So each arm ranks that week's pool and
// is scored on the REALISED rest-of-season points per game of its top K. Rank correlation is printed
// beside it as the continuous view.
//
// THE UNIT OF ANALYSIS IS THE SEASON. 18,000 (player, week) rows are not 18,000 observations -- the
// same player recurs weekly and everything within a season shares an injury and scoring environment.
// The panel starts in 2018 (league roster history), so there are 8 seasons and the floor is computed
// on 8 paired differences. That is thin, and it is stated rather than hidden behind the row count.
//
// Usage: node --import tsx scripts/breakout-screen.mjs [--k 5] [--max-week 13] [--shuffle]
import Database from "better-sqlite3";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const K = Number(arg("--k", 5));
const MAX_WEEK = Number(arg("--max-week", 13));
const MIN_ROS = Number(arg("--min-ros-games", 4));
const LEAGUE = arg("--league", "462233");
/**
 * THE LAST COMPLETE SEASON. 2026 is IN PROGRESS: its `ros_pts` covers the two weeks played so far,
 * so a "rest of season" label there is two games of noise standing in for fourteen, and the
 * `--min-ros-games 4` guard does not catch it because early weeks still have games remaining on the
 * schedule. Including it silently added a ninth season of near-garbage to an 8-season paired test.
 * Found by reading the season list the script printed, which is why it prints it.
 */
const TO = Number(arg("--to", 2025));
/** POSITIVE CONTROL: shuffle the outcome within season. Every arm must collapse to the pool mean.
 *  An edge that survives a shuffled label is measuring the harness, not the players. */
const SHUFFLE = process.argv.includes("--shuffle");

const INCUMBENTS = ["season_line_pg", "t4_mean"];
/** The pre-filter's survivors, and ONLY those. Adding the rejects back because they are cheap is how
 *  a screen turns into a fishing expedition with 14 chances to get lucky. */
const USAGE = ["prior_snap_share", "prior_route_share", "td_ts", "td_rush_yards", "rz_share_td"];

const db = new Database("data/ff.db", { readonly: true });
const rows = db.prepare(`
  SELECT f.season, f.week, f.pos, f.name, f.ros_pts, f.ros_games,
         m.${[...INCUMBENTS, ...USAGE].join(", m.")}
  FROM fact_fa_pool_week f
  JOIN feat_player_week_model m
    ON m.season = f.season AND m.week = f.week AND m.player_sk = f.player_sk
  WHERE f.league_id = ? AND f.ros_games >= ? AND f.week <= ? AND f.season <= ?
    AND m.season_line_pg IS NOT NULL AND m.t4_mean IS NOT NULL
`).all(LEAGUE, MIN_ROS, MAX_WEEK, TO);

for (const r of rows) r.y = r.ros_pts / r.ros_games;

const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** OLS with intercept, ridge-nudged. Returns a predict(row) closure over the given feature list. */
function fit(trainRows, feats, fill) {
  const p = feats.length + 1;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  const col = (j, r) => (j === 0 ? 1 : (r[feats[j - 1]] ?? fill[feats[j - 1]]));
  for (const r of trainRows) {
    for (let j = 0; j < p; j++) {
      b[j] += col(j, r) * r.y;
      for (let k = 0; k < p; k++) A[j][k] += col(j, r) * col(k, r);
    }
  }
  for (let j = 0; j < p; j++) A[j][j] += 1e-6;
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
  return (r) => c.reduce((s, cj, j) => s + cj * col(j, r), 0);
}

const spearman = (xs, ys) => {
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(v.length);
    idx.forEach(([, i], p) => { out[i] = p; });
    return out;
  };
  const a = rank(xs), c = rank(ys), ma = mean(a), mc = mean(c);
  let num = 0, da = 0, dc = 0;
  for (let i = 0; i < a.length; i++) { const u = a[i] - ma, v = c[i] - mc; num += u * v; da += u * u; dc += v * v; }
  return da && dc ? num / Math.sqrt(da * dc) : NaN;
};

const ARMS = {
  A_shipped: null,                       // rank by season_line_pg directly -- no fit
  B_incumbent: INCUMBENTS,
  C_usage: [...INCUMBENTS, ...USAGE],
};

console.log(`\nWAIVER-BREAKOUT SCREEN -- league ${LEAGUE}, weeks 1-${MAX_WEEK}, top-${K} per (season, week, pos)`);
console.log(`  n=${rows.length} (free agent, week) rows over ${seasons.length} seasons: ${seasons.join(", ")}${SHUFFLE ? "   *** SHUFFLED LABELS (positive control) ***" : ""}\n`);

for (const pos of ["RB", "WR", "TE", "QB"]) {
  const all = rows.filter((r) => r.pos === pos);
  if (all.length < 500) { console.log(`  ${pos}: ${all.length} rows -- too thin\n`); continue; }

  // per season -> per arm -> mean realised ros/gm of the top-K, and the pool mean as the null.
  const perSeason = { A_shipped: [], B_incumbent: [], C_usage: [], pool: [], rho: { A_shipped: [], B_incumbent: [], C_usage: [] } };

  for (const Y of seasons) {
    const train = all.filter((r) => r.season !== Y);
    let test = all.filter((r) => r.season === Y);
    if (train.length < 200 || test.length < K * 2) continue;

    if (SHUFFLE) {
      const ys = test.map((r) => r.y).sort(() => Math.random() - 0.5);
      test = test.map((r, i) => ({ ...r, y: ys[i] }));
    }

    // MISSING VALUES ARE FILLED FROM THE TRAINING FOLD ONLY. A median taken over train+test would
    // let the held-out season inform its own imputation -- a small leak that is invisible in output.
    const fill = {};
    for (const f of [...INCUMBENTS, ...USAGE]) fill[f] = median(train.map((r) => r[f]).filter((v) => v != null));

    const preds = {};
    for (const [arm, feats] of Object.entries(ARMS)) {
      preds[arm] = feats ? fit(train, feats, fill) : (r) => r.season_line_pg;
    }

    const byWeek = new Map();
    for (const r of test) { if (!byWeek.has(r.week)) byWeek.set(r.week, []); byWeek.get(r.week).push(r); }

    const topOf = { A_shipped: [], B_incumbent: [], C_usage: [] }, pool = [];
    const rhoOf = { A_shipped: [], B_incumbent: [], C_usage: [] };
    for (const [, wk] of byWeek) {
      if (wk.length < K * 2) continue;                  // a pool smaller than 2K is not a choice
      pool.push(mean(wk.map((r) => r.y)));
      for (const arm of Object.keys(ARMS)) {
        const scored = wk.map((r) => ({ r, s: preds[arm](r) })).sort((a, b) => b.s - a.s);
        topOf[arm].push(mean(scored.slice(0, K).map((x) => x.r.y)));
        rhoOf[arm].push(spearman(scored.map((x) => x.s), scored.map((x) => x.r.y)));
      }
    }
    if (!pool.length) continue;
    perSeason.pool.push(mean(pool));
    for (const arm of Object.keys(ARMS)) {
      perSeason[arm].push(mean(topOf[arm]));
      perSeason.rho[arm].push(mean(rhoOf[arm].filter(Number.isFinite)));
    }
  }

  const ns = perSeason.pool.length;
  if (ns < 3) { console.log(`  ${pos}: only ${ns} usable seasons\n`); continue; }

  console.log(`  ${pos}  n=${all.length} rows, ${ns} seasons`);
  console.log(`    arm             top-${K} ros/gm   vs pool    rank rho`);
  console.log(`    pool mean       ${mean(perSeason.pool).toFixed(2).padStart(10)}        --          --`);
  for (const arm of Object.keys(ARMS)) {
    console.log(`    ${arm.padEnd(14)} ${mean(perSeason[arm]).toFixed(2).padStart(10)} ${(mean(perSeason[arm]) - mean(perSeason.pool)).toFixed(2).padStart(9)} ${mean(perSeason.rho[arm]).toFixed(3).padStart(11)}`);
  }

  // THE ADMISSION TEST. Paired per season, C against B -- the fitted incumbent, not the shipped one.
  const paired = (candArm, refArm) => {
    const d = perSeason[candArm].map((v, i) => v - perSeason[refArm][i]);
    const m = mean(d);
    const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, d.length - 1));
    const se = sd / Math.sqrt(d.length);
    const floor = 2.9 * se;
    return { m, se, floor, wins: d.filter((x) => x > 0).length, n: d.length };
  };
  for (const [cand, ref] of [["C_usage", "B_incumbent"], ["C_usage", "A_shipped"], ["B_incumbent", "A_shipped"]]) {
    const t = paired(cand, ref);
    console.log(`    ${cand} vs ${ref.padEnd(12)} mean ${t.m >= 0 ? "+" : ""}${t.m.toFixed(3)}  SE ${t.se.toFixed(3)}  floor ${t.floor.toFixed(3)}  ` +
      `${t.m > t.floor ? "ADMIT" : "REJECT"}  (${t.wins}/${t.n} seasons)`);
  }

  /**
   * SECONDARY, AND POST-HOC -- SAID SO RATHER THAN SLIPPED IN.
   *
   * The primary metric was fixed before any result was seen: realised top-K value, because that is
   * the decision. Rank correlation is reported here as a SECOND paired test because top-K over 8
   * seasons is visibly noisy (it reads 5 of a ~20-man pool, so one hit swings a season), while rho
   * uses the whole ordering and is far better behaved.
   *
   * IT IS NOT A SECOND CHANCE TO ADMIT. Running two metrics and shipping whichever clears is the
   * winner's curse with two tickets, and this repo has a documented case of exactly that (+3.4pp
   * becoming +1.0pp on holdout). A verdict here does NOT promote anything; it only says whether the
   * primary's REJECT looks like "no signal" or like "not enough seasons to resolve it".
   */
  const pairedRho = (candArm, refArm) => {
    const d = perSeason.rho[candArm].map((v, i) => v - perSeason.rho[refArm][i]);
    const m = mean(d);
    const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, d.length - 1));
    const se = sd / Math.sqrt(d.length);
    return { m, se, floor: 2.9 * se, wins: d.filter((x) => x > 0).length, n: d.length };
  };
  for (const [cand, ref] of [["C_usage", "B_incumbent"], ["C_usage", "A_shipped"]]) {
    const t = pairedRho(cand, ref);
    console.log(`    [post-hoc, RANK RHO] ${cand} vs ${ref.padEnd(12)} mean ${t.m >= 0 ? "+" : ""}${t.m.toFixed(4)}  SE ${t.se.toFixed(4)}  floor ${t.floor.toFixed(4)}  ` +
      `${t.m > t.floor ? "clears" : "does not clear"}  (${t.wins}/${t.n})`);
  }
  console.log();
}
console.log("  THE VERDICT IS C vs B. A is the shipped ranking (season line alone); B is a FITTED");
console.log("  incumbent and therefore a harder, fairer baseline. Beating A while losing to B would");
console.log("  mean the gain was 'use trailing form', not 'use usage'.");
