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
const USAGE = process.argv.includes("--wide")
  ? ["prior_snap_share", "td_ts", "td_rush_yards", "rz_share_td"]
  : ["prior_snap_share", "prior_route_share", "td_ts", "td_rush_yards", "rz_share_td"];

/**
 * WIDE MODE -- the league's roster history is NOT a limit on identifying the breakout.
 *
 * `fact_fa_pool_week` starts in 2018 because that is how far back THIS LEAGUE's rosters go. But the
 * league only decides WHO WAS AVAILABLE; the question "which low-usage player is about to become
 * valuable" is answered entirely from player data, and the rest-of-season LABEL is already computed
 * purely from `feat_player_week_model` (see `rosterState.ts`: the ros subselects touch no league
 * table at all). Tying the screen to 2018 imported a constraint that belongs to a different
 * question, and it cost half the seasons on a test that was visibly underpowered.
 *
 * So wide mode rebuilds the pool SYNTHETICALLY: at each (season, week, pos), the men ranked below
 * that position's typical rostered depth by `season_line_pg`. The depths are CALIBRATED from this
 * league's own real pool over 2018-2025 (median rostered per league-week), not chosen:
 *
 *     QB 22    RB 48    WR 57    TE 22
 *
 * THE PROXY IS VALIDATED, NOT ASSUMED: on the overlapping seasons the script prints how often
 * synthetic membership agrees with real membership, so the cost of the substitution is a number
 * rather than a hope.
 *
 * `prior_route_share` is DROPPED in wide mode -- it only exists from 2016, and it and
 * `prior_snap_share` were near-substitutes in the pre-filter (RB .152/.153, WR .269/.261,
 * TE .305/.258, QB .168/.149). Trading one of a correlated pair for three more seasons is the right
 * side of that bargain on an 8-season test.
 */
const WIDE = process.argv.includes("--wide");
/** Arm D needs the trend columns, which only the wide (synthetic-pool) builder computes. */
const WIDE_ARMD = WIDE && !process.argv.includes("--no-arm-d");
const ROSTERED_DEPTH = { QB: 22, RB: 48, WR: 57, TE: 22 };
const WIDE_FROM = Number(arg("--wide-from", 2013));

const db = new Database("data/ff.db", { readonly: true });
const rows = WIDE ? buildWide() : db.prepare(`
  SELECT f.season, f.week, f.pos, f.name, f.ros_pts, f.ros_games,
         m.${[...INCUMBENTS, ...USAGE].join(", m.")}
  FROM fact_fa_pool_week f
  JOIN feat_player_week_model m
    ON m.season = f.season AND m.week = f.week AND m.player_sk = f.player_sk
  WHERE f.league_id = ? AND f.ros_games >= ? AND f.week <= ? AND f.season <= ?
    AND m.season_line_pg IS NOT NULL AND m.t4_mean IS NOT NULL
`).all(LEAGUE, MIN_ROS, MAX_WEEK, TO);

/**
 * The synthetic panel, built exactly as `rosterState.ts` builds the real one -- `ros` is the sum of
 * `pts` from this week forward and `games` the count of rows -- but computed as suffix sums in one
 * pass instead of two correlated subqueries per row, because this runs over 13 seasons.
 */
function buildWide() {
  const all = db.prepare(`
    SELECT season, week, pos, player_sk, name, pts, ${[...INCUMBENTS, ...USAGE].join(", ")}
      FROM feat_player_week_model
     WHERE season BETWEEN ? AND ? AND pos IN ('QB','RB','WR','TE')
     ORDER BY season, player_sk, week
  `).all(WIDE_FROM, TO);

  // Suffix sums per (season, player): ros[w] = sum of pts from w forward, games[w] = rows from w on.
  const key = (r) => `${r.season}|${r.player_sk}`;
  const groups = new Map();
  for (const r of all) { if (!groups.has(key(r))) groups.set(key(r), []); groups.get(key(r)).push(r); }
  for (const [, g] of groups) {
    let sum = 0, cnt = 0;
    for (let i = g.length - 1; i >= 0; i--) { sum += g[i].pts ?? 0; cnt++; g[i].ros_pts = sum; g[i].ros_games = cnt; }
  }

  // The pool: below this position's rostered depth by the season line, in that week.
  const out = [];
  const byWeek = new Map();
  for (const r of all) {
    const k = `${r.season}|${r.week}|${r.pos}`;
    if (!byWeek.has(k)) byWeek.set(k, []); byWeek.get(k).push(r);
  }
  for (const [, wk] of byWeek) {
    wk.sort((a, b) => (b.season_line_pg ?? -1) - (a.season_line_pg ?? -1));
    const depth = ROSTERED_DEPTH[wk[0].pos] ?? 40;
    for (let i = depth; i < wk.length; i++) out.push(wk[i]);
  }
  const panel = out.filter((r) => r.week <= MAX_WEEK && r.ros_games >= MIN_ROS
    && r.season_line_pg != null && r.t4_mean != null);
  if (WIDE_ARMD) addTrend(panel, groups);
  return panel;
}

/**
 * The arm-D columns, built to the SAME point-in-time rule as `breakout-trend-prefilter.mjs`:
 * everything is read from weeks STRICTLY BEFORE w, because w is the first week of the label.
 */
function addTrend(panel, groups) {
  const RECENT = 2;
  const ext = new Map();
  for (const r of db.prepare(
    `SELECT player_sk, season, draft_year, draft_round FROM feat_player_season_ext WHERE season BETWEEN ? AND ?`
  ).all(WIDE_FROM, TO)) ext.set(`${r.season}|${r.player_sk}`, r);

  for (const r of panel) {
    const sp = `${r.season}|${r.player_sk}`;
    const g = groups.get(sp) ?? [];
    // Snap share arrives as a weekly LEVEL already carried forward, so its own lag IS the trend.
    const prev = g.filter((x) => x.week < r.week - RECENT).map((x) => x.prior_snap_share).filter((v) => v != null);
    r.d_snap = (r.prior_snap_share != null && prev.length)
      ? r.prior_snap_share - prev.reduce((a, b) => a + b, 0) / prev.length : null;
    const e = ext.get(sp);
    r.exp_years = e?.draft_year ? r.season - e.draft_year : null;
    r.draft_round = e?.draft_round ?? null;
  }
}

/** HOW GOOD IS THE PROXY? Agreement between synthetic and REAL pool membership, where both exist. */
function validatePool() {
  const real = new Set(db.prepare(
    `SELECT season||'|'||week||'|'||player_sk AS k FROM fact_fa_pool_week
      WHERE league_id=? AND season BETWEEN 2018 AND ? AND week<=?`).all(LEAGUE, TO, MAX_WEEK).map((r) => r.k));
  const cand = db.prepare(`
    SELECT season, week, pos, player_sk, season_line_pg FROM feat_player_week_model
     WHERE season BETWEEN 2018 AND ? AND week<=? AND pos IN ('QB','RB','WR','TE')`).all(TO, MAX_WEEK);
  const byWeek = new Map();
  for (const r of cand) { const k = `${r.season}|${r.week}|${r.pos}`; if (!byWeek.has(k)) byWeek.set(k, []); byWeek.get(k).push(r); }
  let agree = 0, n = 0, inSynth = 0, rostered = 0;
  for (const [, wk] of byWeek) {
    wk.sort((a, b) => (b.season_line_pg ?? -1) - (a.season_line_pg ?? -1));
    const depth = ROSTERED_DEPTH[wk[0].pos] ?? 40;
    wk.forEach((r, i) => {
      const synth = i >= depth, actual = real.has(`${r.season}|${r.week}|${r.player_sk}`);
      if (synth === actual) agree++;
      if (synth) { inSynth++; if (!actual) rostered++; }
      n++;
    });
  }
  return { pct: n ? (100 * agree) / n : NaN, n, contamination: inSynth ? (100 * rostered) / inSynth : NaN };
}

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

/**
 * ARM D -- the trend/context survivors from `breakout-trend-prefilter.mjs`.
 *
 * ONE feature set for all four positions, deliberately. The pre-filter's survivors differ by
 * position (d_snap at RB/QB, exp_years at WR/TE/QB, draft_round at TE) and fitting a bespoke set per
 * position would be four hand-picked models chosen on the same data that scores them -- selection
 * inside the screen. A single set lets the OLS put a zero where a feature does not belong, at the
 * cost of a little noise, and costs one test per position instead of four choices per position.
 *
 * `d_hv` survived at RB (0.069) and is LEFT OUT on coverage, not on effect: it needs four prior
 * appearances in the play-by-play and exists for 43% of RB rows, so 57% would be median-filled and
 * the fill would BE the feature. Stated so its absence is not read as a rejection.
 */
const TREND = WIDE_ARMD ? ["d_snap", "exp_years", "draft_round"] : [];

const ARMS = {
  A_shipped: null,                       // rank by season_line_pg directly -- no fit
  B_incumbent: INCUMBENTS,
  C_usage: [...INCUMBENTS, ...USAGE],
  ...(WIDE_ARMD ? { D_trend: [...INCUMBENTS, ...USAGE, ...TREND] } : {}),
};

console.log(`\nWAIVER-BREAKOUT SCREEN -- league ${LEAGUE}, weeks 1-${MAX_WEEK}, top-${K} per (season, week, pos)`);
console.log(`  n=${rows.length} (free agent, week) rows over ${seasons.length} seasons: ${seasons.join(", ")}${SHUFFLE ? "   *** SHUFFLED LABELS (positive control) ***" : ""}`);
if (WIDE) {
  const v = validatePool();
  console.log(`  WIDE: synthetic pool (below rostered depth QB22/RB48/WR57/TE22 by season line), usage set drops prior_route_share (2016+ only)`);
  console.log(`  PROXY CHECK: synthetic membership agrees with this league's REAL pool on ${v.pct.toFixed(1)}% of ${v.n} (player, week) rows, 2018-${TO}`);
  console.log(`  CONTAMINATION: ${v.contamination.toFixed(1)}% of the synthetic pool was ACTUALLY ROSTERED -- men you could not have claimed,`);
  console.log(`    and disproportionately the GOOD ones, since being good is why somebody rostered them. So the top-${K} column is`);
  console.log(`    OPTIMISTIC in wide mode and the *_vs_A_shipped rows are NOT decision-valid. The prediction this makes is testable`);
  console.log(`    and confirmed: form-based arms should inflate most, and B_incumbent vs A_shipped reads +2.0 to +2.7 here against`);
  console.log(`    +0.39/-0.15/+0.50/+0.46 (all REJECT) on the REAL pool. READ C_usage vs B_incumbent: both arms rank the SAME`);
  console.log(`    contaminated pool and differ ONLY in the usage features, so the selection bias is common and largely cancels.`);
}
console.log();

for (const pos of ["RB", "WR", "TE", "QB"]) {
  const all = rows.filter((r) => r.pos === pos);
  if (all.length < 500) { console.log(`  ${pos}: ${all.length} rows -- too thin\n`); continue; }

  // per season -> per arm -> mean realised ros/gm of the top-K, and the pool mean as the null.
  const perSeason = { pool: [], rho: {} };
  for (const a2 of Object.keys(ARMS)) { perSeason[a2] = []; perSeason.rho[a2] = []; }

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
    // EVERY feature ANY arm uses. This listed only INCUMBENTS+USAGE while arm D also reads TREND,
    // so d_snap/exp_years/draft_round fell through `?? fill[f]` to `undefined`, NaN-poisoned the
    // normal equations, and the solve degenerated to almost exactly -season_line_pg -- arm D scored
    // identically to A_shipped with an exactly negated rho. It looked like a REJECT and was a BUG.
    for (const f of [...INCUMBENTS, ...USAGE, ...TREND]) {
      const vals = train.map((r) => r[f]).filter((v) => v != null && Number.isFinite(v));
      fill[f] = vals.length ? median(vals) : 0;
    }

    const preds = {};
    for (const [arm, feats] of Object.entries(ARMS)) {
      preds[arm] = feats ? fit(train, feats, fill) : (r) => r.season_line_pg;
    }

    const byWeek = new Map();
    for (const r of test) { if (!byWeek.has(r.week)) byWeek.set(r.week, []); byWeek.get(r.week).push(r); }

    const topOf = {}, rhoOf = {}, pool = [];
    for (const a2 of Object.keys(ARMS)) { topOf[a2] = []; rhoOf[a2] = []; }
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
  const COMPARISONS = WIDE_ARMD
    ? [["D_trend", "C_usage"], ["C_usage", "B_incumbent"], ["D_trend", "B_incumbent"], ["B_incumbent", "A_shipped"]]
    : [["C_usage", "B_incumbent"], ["C_usage", "A_shipped"], ["B_incumbent", "A_shipped"]];
  for (const [cand, ref] of COMPARISONS) {
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
  for (const [cand, ref] of (WIDE_ARMD ? [["D_trend", "C_usage"], ["C_usage", "B_incumbent"]] : [["C_usage", "B_incumbent"], ["C_usage", "A_shipped"]])) {
    const t = pairedRho(cand, ref);
    console.log(`    [post-hoc, RANK RHO] ${cand} vs ${ref.padEnd(12)} mean ${t.m >= 0 ? "+" : ""}${t.m.toFixed(4)}  SE ${t.se.toFixed(4)}  floor ${t.floor.toFixed(4)}  ` +
      `${t.m > t.floor ? "clears" : "does not clear"}  (${t.wins}/${t.n})`);
  }
  console.log();
}
console.log("  THE VERDICT IS C vs B. A is the shipped ranking (season line alone); B is a FITTED");
console.log("  incumbent and therefore a harder, fairer baseline. Beating A while losing to B would");
console.log("  mean the gain was 'use trailing form', not 'use usage'.");
