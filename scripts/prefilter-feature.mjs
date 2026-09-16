// CHEAP PRE-FILTER for projector feature candidates (charter rule 2).
//
// The full paired-floor screen (scripts/admit-feature.mjs) costs two nested-CV runs -- ~1 minute each
// with the fold fan-out, and the trainer per fold. That is the right price for a DECISION, and the
// wrong price for ORDERING a library of ~20 candidates. This script is the cheap first cut:
//
//   for each candidate column, per position, under whatever target the --db carries, measure
//     rho_y     corr(candidate, the actual season points)          -- raw predictiveness
//     rho_r     corr(candidate, the OUT-OF-SAMPLE residual of the SHIPPED baseline)
//     rho_r|C   the same, PARTIALLED on the level and the incumbent usage shares
//
// rho_r is the number that matters: a candidate can only add what the shipped model has left on the
// table, and the fold artifacts in --artifact-dir are blind to their own season (the header asserts
// `holdoutSeason === Y`), so the residual is genuinely out-of-sample rather than an in-sample fit.
// rho_r|C is the LEVEL-IN-DISGUISE detector: a column that correlates with the residual only because
// it encodes "this man is good" collapses once prior_pts / prior_pos_rank / the fitted usage shares
// are partialled out, and that is the candidate a naive screen admits for the wrong reason.
//
// WHAT THIS IS NOT. A pre-filter null is NOT a verdict. docs/feature-frontier.md records the case that
// proves it: the pooled pre-filter measured `prior_vol_cv` at ~0.05 and called it flat, and the full
// season-partitioned screen then found a real REGIME SPLIT the pooling had averaged away. Use this to
// ORDER the queue and to kill level-in-disguise; a candidate with a MECHANICAL reason under the target
// still earns the expensive screen regardless of what it scores here.
//
// USAGE
//   node --import tsx scripts/prefilter-feature.mjs --db <store> --artifact-dir <blind fold dir> \
//        [--seasons 2013-2025] [--candidates a,b,c] [--out <path.tsv>]
//
// --artifact-dir is a directory of per-season artifacts, each blind to its own season, i.e. exactly
// what `ff evaluate-projection --keep-artifacts <dir>` writes. There is no single-artifact mode on
// purpose: one all-history artifact has seen every season it would be scored on, and the residual it
// leaves is a fit statistic, not a measurement.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { openDb } from "../src/db/db.ts";
import { loadArtifact, projectSeason } from "../src/model/projector.ts";
import { loadFeatureRows } from "../src/model/features.ts";

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const dbPath = val("--db", undefined);
const artDir = val("--artifact-dir", null);
if (!artDir) { console.error("usage: prefilter-feature.mjs --artifact-dir <dir of per-season blind artifacts> [--db <store>] [--seasons 2013-2025] [--candidates a,b] [--out f.tsv]"); process.exit(1); }
const rng = val("--seasons", "2013-2025").split("-").map(Number);
const seasons = []; for (let y = rng[0]; y <= (rng[1] ?? rng[0]); y++) seasons.push(y);
const outPath = val("--out", null);

// The candidate library. Mirrors the declared-not-fitted sets in tools/train_projection.py
// (EXT_CENTER frontier block, EXT_INDICATOR, LAG_RATIO, BASIS_CENTER) plus the two market anchors,
// which are DEFAULTS and are listed so the table shows what the incumbent anchors are worth under
// this target beside the candidates that would have to beat them.
const DEFAULT_CANDIDATES = [
  "prior_adot", "prior_td_oe",
  "prior_rz_touch_share", "prior_gtg_carry_share", "prior_ez_target_share",
  "qb_changed", "prior_out_games",
  "prior_yac_oe", "prior_ryoe", "prior_cpoe",
  "prior_team_pass_rate", "prior_team_plays_pg", "prior_team_rz_pg",
  "prior2_pts", "prior3_pts", "hist_ppg_w",
  "age_sq", "age_hinge30", "log_rank",
  "contract_year",
  // already-fitted, shown for contrast (a candidate must beat these, not merely be non-zero)
  "prior_carries_per_game", "prior_carry_share", "prior_wopr", "prior_air_yards_share",
  "adp", "fftoday_proj",
];
const candidates = (val("--candidates", null)?.split(",").map((s) => s.trim()).filter(Boolean)) ?? DEFAULT_CANDIDATES;

// The CONTROL block for the partial correlation: the LEVEL (what rank/points the man carried in) plus
// the incumbent usage shares the projector already fits. A candidate that survives partialling on
// these is measuring something the shipped design does not already hold.
const CONTROLS = [
  "prior_pts", "prior_pos_rank", "prior_games", "age",
  "prior_snap_share", "prior_route_share", "prior_carries_per_game", "prior_carry_share",
  "prior_air_yards_share", "prior_wopr", "adp", "fftoday_proj",
];
const POSITIONS = ["QB", "RB", "WR", "TE"];

// ---- collect one row per (season, player) with the blind residual and every feature value --------
const db = openDb(dbPath);
const recs = [];
let usedSeasons = 0;
for (const yr of seasons) {
  const p = `${artDir}/artifact-${yr}.json`;
  if (!existsSync(p)) { console.error(`  ${yr}: no artifact-${yr}.json -- season skipped`); continue; }
  const art = loadArtifact(JSON.parse(readFileSync(p, "utf8")));
  // THE BLINDNESS ASSERTION. An artifact that saw the season it is scoring leaves an in-sample
  // residual, and every correlation below would be measuring the fit rather than what is left.
  if (art.holdoutSeason !== yr) throw new Error(`${p} declares holdoutSeason ${art.holdoutSeason} but is being used for ${yr} -- that residual would be in-sample`);
  const feats = loadFeatureRows(db, { season: yr, rankBasis: "prior", base: art.base, curve: art.curve });
  const proj = new Map(projectSeason({ season: yr, asOf: `${yr}-09-01`, artifact: art, features: feats }).map((r) => [`${r.pos}|${r.name}`, r.mean]));
  const tgt = new Map();
  for (const r of db.prepare("SELECT name, pos, pts FROM feat_player_season WHERE season = ? AND pts IS NOT NULL AND prior_pos_rank IS NOT NULL").all(yr)) {
    tgt.set(`${r.pos}|${r.name}`, r.pts);
  }
  let n = 0;
  for (const f of feats) {
    const k = `${f.pos}|${f.name}`;
    const a = tgt.get(k), m = proj.get(k);
    if (a == null || m == null) continue;
    recs.push({ season: yr, pos: f.pos, actual: a, resid: a - m, f: f.f });
    n++;
  }
  if (n) usedSeasons++;
}
db.close();
console.log(`pre-filter: ${recs.length} scored rows over ${usedSeasons} blind seasons (${artDir})`);

// ---- statistics -----------------------------------------------------------------------------------
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
function corr(x, y) {
  const n = x.length; if (n < 3) return NaN;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}
/** OLS residual of y on the design [1, ...cols] via normal equations + a tiny ridge (columns here are
 *  collinear by construction -- prior_pts and prior_pos_rank are two views of the same level -- and a
 *  singular solve would otherwise hand back NaN and read as "no signal"). */
function residualize(y, cols) {
  const n = y.length, k = cols.length + 1;
  const X = [];
  for (let i = 0; i < n; i++) { const row = [1]; for (const c of cols) row.push(c[i]); X.push(row); }
  const A = Array.from({ length: k }, () => new Float64Array(k));
  const b = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      b[a] += X[i][a] * y[i];
      for (let c = 0; c < k; c++) A[a][c] += X[i][a] * X[i][c];
    }
  }
  for (let a = 1; a < k; a++) A[a][a] += 1e-6 * (A[a][a] || 1);
  // Gaussian elimination with partial pivoting.
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) continue;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j];
    }
  }
  const beta = new Float64Array(k);
  for (let c = 0; c < k; c++) beta[c] = Math.abs(M[c][c]) < 1e-12 ? 0 : M[c][k] / M[c][c];
  const out = new Array(n);
  for (let i = 0; i < n; i++) { let p = 0; for (let a = 0; a < k; a++) p += beta[a] * X[i][a]; out[i] = y[i] - p; }
  return out;
}

const rows = [];
for (const cand of candidates) {
  for (const pos of POSITIONS) {
    // Rows where BOTH the candidate and every retained control are present. A candidate whose column
    // is null for a position (an NGS metric outside its family, a rookie lag) drops out here rather
    // than being silently imputed to zero, which would manufacture a correlation.
    const sub = recs.filter((r) => r.pos === pos && r.f[cand] != null && Number.isFinite(Number(r.f[cand])));
    if (sub.length < 60) { rows.push({ cand, pos, n: sub.length, rho_y: NaN, rho_r: NaN, rho_rc: NaN, note: "thin" }); continue; }
    const x = sub.map((r) => Number(r.f[cand]));
    // An INDICATOR (qb_changed, contract_year) has exactly two distinct values and is a perfectly
    // legitimate candidate -- a ">= 3 distinct values" guard here silently reported every indicator in
    // the library as "constant", which reads as a fact about the data and is a fact about the guard.
    if (new Set(x).size < 2) { rows.push({ cand, pos, n: sub.length, rho_y: NaN, rho_r: NaN, rho_rc: NaN, note: "constant" }); continue; }
    const y = sub.map((r) => r.actual);
    const e = sub.map((r) => r.resid);
    // Keep only controls that are present on EVERY retained row and not constant; impute nothing.
    const keep = CONTROLS.filter((c) => c !== cand && sub.every((r) => r.f[c] != null && Number.isFinite(Number(r.f[c]))))
      .filter((c) => new Set(sub.map((r) => Number(r.f[c]))).size > 2);
    const cols = keep.map((c) => sub.map((r) => Number(r.f[c])));
    const xr = residualize(x, cols), er = residualize(e, cols);
    rows.push({ cand, pos, n: sub.length, rho_y: corr(x, y), rho_r: corr(x, e), rho_rc: corr(xr, er), note: `ctrl:${keep.length}` });
  }
}

const f = (v) => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(3) : "  n/a");
const lines = ["candidate\tpos\tn\trho_y\trho_resid\trho_resid|ctrl\tnote"];
console.log("\ncandidate                   pos      n   rho_y  rho_res  rho_res|C   note");
for (const r of rows) {
  if (r.n < 60) continue;
  console.log(`${r.cand.padEnd(26)} ${r.pos.padEnd(3)} ${String(r.n).padStart(6)}  ${f(r.rho_y)}   ${f(r.rho_r)}     ${f(r.rho_rc)}   ${r.note}`);
  lines.push([r.cand, r.pos, r.n, r.rho_y, r.rho_r, r.rho_rc, r.note].join("\t"));
}
for (const r of rows) if (r.n < 60) lines.push([r.cand, r.pos, r.n, "", "", "", r.note].join("\t"));
if (outPath) { writeFileSync(outPath, lines.join("\n") + "\n"); console.log(`\nwrote ${outPath}`); }
