// DO THE SMALL LIFTS AGGREGATE INTO A BIG ONE? Fit a multivariate ridge model over the FULL in-season
// feature set (frozen line + form + role level + role trend + usage + matchup + Vegas), point-in-time,
// and ask whether the aggregate beats (a) the frozen line and (b) role-trend ALONE -- on accuracy AND
// on the waiver decision.
//
// RIGOR: per-fold training (standardise + fit on DESIGN seasons, evaluate on HELD-OUT seasons, both
// directions) so nothing is scored in-sample; features are all through week w-1, target is week-w pts.
// If the aggregate ~= the best single feature, the signals are redundant (correlated), which is the
// statistical default for signals that all track the same "situation changed" latent.
//   node --import tsx scripts/inseason-aggregate-model.mjs
import { openDb } from "../src/db/db.ts";
import { backtestPolicies } from "../src/inseason/backtest/harness.ts";
import { makeSimExpectedScorer } from "../src/inseason/backtest/scorers.ts";
import { waiverByProjection, hasRealDrop } from "../src/inseason/backtest/policies.ts";
import { frozenProjector } from "../src/inseason/backtest/projectors.ts";
import { makeRoleAggregates } from "../src/inseason/backtest/opportunity.ts";

const db = openDb();
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
const agg = makeRoleAggregates(db, { window: 2 });   // sma2, the winning role encoding

const FEATURES = ["season_line", "form", "roleLevel", "roleTrend", "usage_ts", "dvp", "impliedTotal", "home"];
const A = [2018, 2019, 2020, 2021], B = [2022, 2023, 2024];

// Build the point-in-time feature row + target for every played RB/WR/TE week with a role signal.
function rows(seasons) {
  const out = [];
  for (const season of seasons) {
    for (const r of db.prepare(
      `SELECT player_sk, pos, week, season_line_pg, t4_mean, td_ts, dvp_mult, implied_team_total, home, pts, is_bye, inj_out
         FROM feat_player_week_model
        WHERE season=? AND pos IN ('RB','WR','TE') AND player_sk IS NOT NULL AND season_line_pg IS NOT NULL AND pts IS NOT NULL`,
    ).all(season)) {
      if (r.is_bye || r.inj_out || r.week < 4) continue;
      const a = agg(String(r.player_sk), r.pos, season, r.week);
      if (!a || a.games < 3) continue;
      const changed = a.rolePrior != null && Math.abs(a.roleRecent - a.rolePrior) > 0.15;
      out.push({
        season, sk: String(r.player_sk), week: r.week, pts: r.pts, frozen: r.season_line_pg, changed,
        x: {
          season_line: r.season_line_pg, form: r.t4_mean, roleLevel: a.roleRecent,
          roleTrend: a.roleToDate > 0 ? a.roleRecent / a.roleToDate : 1,
          usage_ts: r.td_ts, dvp: r.dvp_mult, impliedTotal: r.implied_team_total, home: r.home,
        },
      });
    }
  }
  return out;
}

// mean-impute + standardise on TRAIN, fit ridge (normal equations), return predictor + role-alone.
function fit(train, lambda = 5) {
  const cols = FEATURES;
  const mean = {}, sd = {};
  for (const c of cols) {
    const vals = train.map((r) => r.x[c]).filter((v) => v != null && Number.isFinite(v));
    const mu = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
    const v = vals.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, vals.length);
    mean[c] = mu; sd[c] = Math.sqrt(v) || 1;
  }
  const val = (r, c) => { const v = r.x[c]; return v == null || !Number.isFinite(v) ? mean[c] : v; }; // NaN-safe impute
  const z = (r) => [1, ...cols.map((c) => (val(r, c) - mean[c]) / sd[c])];
  const p = cols.length + 1;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (const r of train) {
    const xr = z(r);
    for (let i = 0; i < p; i++) { for (let j = 0; j < p; j++) XtX[i][j] += xr[i] * xr[j]; Xty[i] += xr[i] * r.pts; }
  }
  for (let i = 1; i < p; i++) XtX[i][i] += lambda;   // ridge (do not penalise bias)
  const w = solve(XtX, Xty);
  if (w.some((v) => !Number.isFinite(v))) console.log("    !! non-finite weights:", w.map((v) => v.toFixed?.(2) ?? v).join(","));
  return { predict: (r) => z(r).reduce((s, xi, i) => s + xi * w[i], 0), w };
}

function solve(Ain, bin) { // Gaussian elimination with partial pivoting
  const n = bin.length, M = Ain.map((row, i) => [...row, bin[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => row[n] / row[i]);   // row = M[i]; row[i] is the diagonal pivot
}

const mae = (arr, f) => arr.reduce((s, r) => s + Math.abs(f(r) - r.pts), 0) / arr.length;
function evalFold(train, test, label) {
  const model = fit(train);
  const all = test, chg = test.filter((r) => r.changed);
  const line = (arr, name) => `    ${name.padEnd(12)} n ${String(arr.length).padStart(5)}   frozen ${mae(arr, (r) => r.frozen).toFixed(3)}   role-alone ${mae(arr, (r) => r.frozen * Math.min(2, Math.max(0.5, r.x.roleTrend ** 0.5))).toFixed(3)}   AGGREGATE ${mae(arr, (r) => model.predict(r)).toFixed(3)}`;
  console.log(`  ${label}`);
  console.log(line(all, "all"));
  console.log(line(chg, "role-changed"));
  return model;
}

console.log(`AGGREGATE in-season model (ridge over ${FEATURES.length} features). Accuracy MAE, lower = better.\n`);
const mAB = evalFold(rows(A), rows(B), "train A(2018-21) -> test B(2022-24)");
const mBA = evalFold(rows(B), rows(A), "train B(2022-24) -> test A(2018-21)");

// DECISION TEST: wrap each fold's model as a projector and A/B the waiver on the HELD-OUT seasons.
const featByKey = new Map();
for (const r of [...rows(A), ...rows(B)]) featByKey.set(`${r.season}|${r.sk}|${r.week}`, r);
const projFrom = (model) => (m, season, week) => {
  const r = featByKey.get(`${season}|${m.playerSk}|${week}`);
  return r ? Math.max(0, model.predict(r)) : m.proj;
};
const admit = (s) => s.freeAgents.length > 0 && hasRealDrop(s);
const decide = (model, seasons) => {
  const base = waiverByProjection(frozenProjector);
  const variant = waiverByProjection(projFrom(model));
  const hr = backtestPolicies(db, { leagueId: lg.league_id, seasons, model: "served", baseline: base, variant, admit });
  const hs = backtestPolicies(db, { leagueId: lg.league_id, seasons, model: "served", baseline: base, variant, admit, scorer: makeSimExpectedScorer(db, { trials: 150 }) });
  return { hr, hs };
};
console.log(`\nDECISION value of the aggregate model (waiver, HELD-OUT):`);
for (const [label, model, seasons] of [["test B", mAB, B], ["test A", mBA, A]]) {
  const { hr, hs } = decide(model, seasons);
  console.log(`  ${label}: realized ${hr.meanDiff.toFixed(3)} CI[${hr.bootstrap.lo.toFixed(2)},${hr.bootstrap.hi.toFixed(2)}]  sim ${hs.meanDiff.toFixed(3)} CI[${hs.bootstrap.lo.toFixed(2)},${hs.bootstrap.hi.toFixed(2)}]  (differed ${hr.differed})`);
}
db.close();
