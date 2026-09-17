// CHEAP PRE-FILTER of an OFFENSIVE-LINE INJURY feature for the WEEKLY projector (charter rule 2).
//
// THE QUESTION. Does "this team's offensive linemen are missing this week" carry signal about a
// skill player's weekly fantasy points that the served 26-feature two-part GBM
// (data/weekly-artifact.json) does NOT already hold -- in particular signal the WEEKLY EXPERT
// CONSENSUS (ecr_wk_rank / ecr_wk_sd, promoted D27) has not already priced? A full paired-floor
// screen (scripts/weekly-paired-floor.mjs over two 14-fold training arms) is ~2.5 hours; this is the
// minutes-long first cut that decides whether that price is worth paying.
//
// WHAT IT MEASURES, per season (the season is the unit of analysis -- CLAUDE.md):
//   rho_y        corr(candidate, ACTUAL weekly points)
//   rho_r        corr(candidate, the OUT-OF-FOLD residual of the served design)  <- raw, nothing removed
//   rho_r|L      the same, PARTIALLED on the LEVEL/anchor block (season line, points-to-date,
//                trailing-4, games played, week number)
//   rho_r|L+E    the same, partialled on the level block AND the weekly consensus pair
//   gap          mean residual (points) for ol_out >= 1 and >= 2 vs ol_out == 0
//
// rho_r is what matters: a candidate can only add what the shipped model left on the table. The
// artifacts in --artifact-dir are per-season folds, each BLIND to the season it scores (the header
// asserts holdoutSeason === Y), so that residual is genuinely out-of-fold and not a fit statistic.
// The L vs L+E pair is what distinguishes the two ways a candidate can die: "no signal at all"
// (rho_r ~ 0 before anything is removed) from "redundant with the consensus" (rho_r real, rho_r|L+E
// collapses).
//
// CONTROLS (mandatory -- charter rule 4; without both the result is not reportable):
//   --positive  a synthetic feature = residual + gaussian noise scaled to a TRUE corr of ~0.05,
//               pushed through the identical pipeline. If the pipeline cannot see that, it cannot
//               see anything, and a null from it measures the instrument rather than the football.
//   --negative  ol_out permuted across team-weeks WITHIN each season (so its marginal distribution
//               and per-season coverage are preserved exactly, and only the team-week alignment is
//               destroyed). It must read null.
//
// THE VERDICT RULE is the repo's floor convention: quote the season-level mean of rho_r|L+E and its
// SE across the 14 seasons; "worth a full screen" only if |mean| > 2.9*SE pooled OR in the RB slice.
//
// WHAT THIS IS NOT. A pre-filter null is not a verdict -- docs/feature-frontier.md records
// prior_vol_cv, whose pooled pre-filter null averaged away a real recent-regime effect. A candidate
// with a mechanical reason to be regime-dependent still earns the expensive screen.
//
// USAGE (one command, reproducible):
//   node --import tsx scripts/weekly-oline-prefilter.mjs \
//     --artifact-dir data/fold-artifacts-oline --seasons 2012-2025 --out data/residuals-oline.tsv
//
// --artifact-dir is a directory of per-season weekly fold artifacts, i.e. exactly what
//   `npm run ff -- evaluate-weekly --keep-artifacts <dir>` writes (weekly-<season>.json).
// The DB is opened READONLY; nothing here writes to the store or to any served artifact.
import Database from "better-sqlite3";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadWeeklyRows } from "../src/weekly/features.ts";
import { populationKeys } from "../src/weekly/population.ts";
import { loadWeeklyArtifact, projectWeekly } from "../src/weekly/projector.ts";

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const dbPath = val("--db", "data/ff.db");
const artDir = val("--artifact-dir", "data/fold-artifacts-oline");
const outPath = val("--out", null);
const [y0, y1] = val("--seasons", "2012-2025").split("-").map(Number);
const seasons = []; for (let y = y0; y <= (y1 ?? y0); y++) seasons.push(y);

// ---------------------------------------------------------------------------------------------
// Vocabulary, enumerated from the data rather than assumed (the task's instruction, and the right
// habit: a hardcoded list of position strings is coverage-by-enumeration and rots silently).
// ---------------------------------------------------------------------------------------------
const db = new Database(dbPath, { readonly: true });

const injPositions = db.prepare(
  `SELECT DISTINCT position FROM raw_injury WHERE season BETWEEN ? AND ?`).all(y0, y1)
  .map((r) => (r.position ?? "").trim()).filter(Boolean);
// An OL position token is one of the interior/tackle codes OR any code whose letters are a known OL
// variant. Enumerated from the feed, then intersected with this pattern, and the result is PRINTED
// so a new variant (OT/OG/OL) shows up as an addition rather than being silently dropped.
const OL_PAT = /^(T|G|C|OT|OG|OL|LT|RT|LG|RG|OC)$/;
const OL_POS = injPositions.filter((p) => OL_PAT.test(p.toUpperCase())).sort();
const NON_OL = injPositions.filter((p) => !OL_PAT.test(p.toUpperCase())).sort();

const injStatuses = db.prepare(
  `SELECT DISTINCT report_status s FROM raw_injury WHERE season BETWEEN ? AND ?`).all(y0, y1)
  .map((r) => r.s).filter((s) => s != null);

const OUTISH = new Set(["Out", "Doubtful"]);
const QUESTIONABLE = new Set(["Questionable", "Probable"]);   // Probable was retired after 2015

console.log("WEEKLY OFFENSIVE-LINE INJURY PRE-FILTER");
console.log(`  db=${dbPath} (readonly)  artifacts=${artDir}  seasons=${y0}-${y1}`);
console.log(`  raw_injury position vocabulary (${injPositions.length}): OL = [${OL_POS.join(", ")}]`);
console.log(`    non-OL, for the record: [${NON_OL.join(", ")}]`);
console.log(`  raw_injury report_status vocabulary: [${injStatuses.map((s) => JSON.stringify(s)).join(", ")}]`);
console.log(`    ol_out        = status in {${[...OUTISH].join(", ")}}`);
console.log(`    ol_questionable = status in {${[...QUESTIONABLE].join(", ")}}`);

// ---------------------------------------------------------------------------------------------
// LEAK GUARD. Every report row that feeds a (season, week, team) count must be DATED STRICTLY
// BEFORE that team's own kickoff. The cutoff used is (this team's gameday - 2 days), which is
// exactly the cutoff src/features/sources/weekContext.ts already uses for the SHIPPED inj_* columns
// -- so the candidate is built on the same point-in-time contract as the incumbent availability
// block, not a looser one.
//
// Why a per-TEAM cutoff and not a league-wide one: the feed's final filings are dated Friday or
// Saturday, which is AFTER the Thursday-night game but before the Sunday slate. A league-wide
// "before the week's first kickoff" test therefore fails for 212 of 243 week-groups and would read
// as a leak when it is not one; the per-team test is the one that answers the question.
//
// 2025 IS DATELESS. nflverse dropped date_modified, so every 2025 row has report_date '' and as_of
// NULL. weekContext.ts documents the fallback: the file then holds ONE row per player-week, the
// FINAL pre-game report, which is knowable before kickoff. This script takes the same position,
// marks the season DATELESS in the coverage table, and reports the verdict both with and without it.
// ---------------------------------------------------------------------------------------------
const kickoff = new Map();     // `${season}|${week}|${team}` -> gameday (YYYY-MM-DD)
for (const g of db.prepare(
  `SELECT season, week, gameday, away_team, home_team FROM raw_nfl_game
    WHERE season BETWEEN ? AND ? AND game_type = 'REG' AND gameday IS NOT NULL`).all(y0, y1)) {
  kickoff.set(`${g.season}|${g.week}|${g.home_team}`, g.gameday);
  kickoff.set(`${g.season}|${g.week}|${g.away_team}`, g.gameday);
}
const minusDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

/** Is this season's injury feed dateless (rows present, none dated)? Same test as weekContext.ts. */
function datelessSeason(y) {
  const r = db.prepare(
    `SELECT COUNT(*) n, SUM(as_of IS NOT NULL AND as_of <> '') dated FROM raw_injury WHERE season = ?`).get(y);
  return r.n > 0 && (r.dated ?? 0) === 0;
}

// Depth chart, for ol_starters_out. 2012-2024 carry one week-keyed chart per season with depth_rank;
// 2025+ is a DIFFERENT schema (week is pinned to 1, the chart is keyed by snapshot as_of_key), so a
// team-WEEK starter join is not available there and the column is reported as unavailable rather
// than silently filled from the wrong week.
const DEPTH_OL = /^(T|G|C|OT|OG|OL|LT|RT|LG|RG|OC)$/;
function depthStarters(y) {
  const weeks = db.prepare(
    `SELECT COUNT(DISTINCT week) w, COUNT(DISTINCT as_of_key) k FROM raw_depth_chart WHERE season = ?`).get(y);
  if (!weeks || weeks.w < 10) return null;               // 2025+ schema: no week-level chart
  const out = new Set();                                 // `${week}|${team}|${ident}`
  for (const r of db.prepare(
    `SELECT week, team, position, depth_rank, gsis_id, full_name FROM raw_depth_chart
      WHERE season = ? AND depth_rank = 1`).all(y)) {
    if (!DEPTH_OL.test((r.position ?? "").toUpperCase())) continue;
    if (r.gsis_id) out.add(`${r.week}|${r.team}|G:${r.gsis_id}`);
    if (r.full_name) out.add(`${r.week}|${r.team}|N:${r.full_name.trim().toLowerCase()}`);
  }
  return out;
}

/**
 * The candidate block for one season: `${week}|${team}` -> { ol_out, ol_questionable, ol_starters_out }.
 * Also returns the leak-guard audit for the season.
 */
function olFeatures(y) {
  const dateless = datelessSeason(y);
  const starters = depthStarters(y);
  const rows = db.prepare(
    `SELECT week, team, player_key, position, report_status, as_of, gsis_id, full_name
       FROM raw_injury WHERE season = ? AND game_type = 'REG'`).all(y);
  // Latest filing at or before this team's cutoff, per (week, team, player).
  const pick = new Map();
  let considered = 0, dropped_nodate = 0, dropped_late = 0, dropped_nogame = 0;
  for (const r of rows) {
    if (!OL_PAT.test((r.position ?? "").trim().toUpperCase())) continue;
    considered++;
    const gd = kickoff.get(`${y}|${r.week}|${r.team}`);
    if (!gd) { dropped_nogame++; continue; }
    const cutoff = minusDays(gd, 2);
    if (!dateless) {
      if (!r.as_of) { dropped_nodate++; continue; }
      if (r.as_of.slice(0, 10) > cutoff) { dropped_late++; continue; }
    }
    const k = `${r.week}|${r.team}|${r.player_key}`;
    const prev = pick.get(k);
    if (!prev || (r.as_of ?? "") > (prev.as_of ?? "")) pick.set(k, r);
  }
  const feat = new Map();
  for (const [, r] of pick) {
    const k = `${r.week}|${r.team}`;
    const f = feat.get(k) ?? feat.set(k, { ol_out: 0, ol_questionable: 0, ol_starters_out: starters ? 0 : null }).get(k);
    const s = (r.report_status ?? "").trim();
    if (OUTISH.has(s)) {
      f.ol_out++;
      if (starters) {
        const byId = r.gsis_id && starters.has(`${r.week}|${r.team}|G:${r.gsis_id}`);
        const byName = r.full_name && starters.has(`${r.week}|${r.team}|N:${r.full_name.trim().toLowerCase()}`);
        if (byId || byName) f.ol_starters_out++;
      }
    } else if (QUESTIONABLE.has(s)) f.ol_questionable++;
  }
  // Every team-week that PLAYED a game gets an explicit 0 where the feed named no OL -- the feature
  // is "how many linemen are missing", and a silent absence there is a zero, not a missing value.
  // The one exception is a season whose feed never spoke at all, which would be a coverage fact
  // dressed up as a healthy league; that case shows up as feedWeeks = 0 in the coverage table.
  const feedWeeks = new Set([...feat.keys()].map((k) => k.split("|")[0]));
  for (const key of kickoff.keys()) {
    const [ky, kw, kt] = key.split("|");
    if (Number(ky) !== y) continue;
    if (!feedWeeks.has(kw)) continue;                     // feed silent that league-week
    const k = `${kw}|${kt}`;
    if (!feat.has(k)) feat.set(k, { ol_out: 0, ol_questionable: 0, ol_starters_out: starters ? 0 : null });
  }
  return {
    feat, dateless, starters: !!starters,
    audit: { considered, dropped_nodate, dropped_late, dropped_nogame, teamWeeks: feat.size },
  };
}

// ---------------------------------------------------------------------------------------------
// The scored rows: every QB/RB/WR/TE row of the decision population, with the BLIND out-of-fold
// prediction of the served 26-feature design.
// ---------------------------------------------------------------------------------------------
const SERVED = JSON.parse(readFileSync("data/weekly-artifact.json", "utf8")).features.map((f) => f.name);
const POS = ["QB", "RB", "WR", "TE"];
const LEVEL = ["season_line_pg", "td_ppg", "t4_mean", "td_games", "week_no"];
const ECR = ["ecr_wk_rank", "ecr_wk_sd"];

/** A tiny deterministic PRNG, so both controls are reproducible from the command line alone. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rnd) => {
  const u = Math.max(rnd(), 1e-12), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const bySeason = new Map();
const coverage = [];
for (const y of seasons) {
  const p = `${artDir}/weekly-${y}.json`;
  if (!existsSync(p)) { console.error(`  ${y}: no weekly-${y}.json in ${artDir} -- season skipped`); continue; }
  const art = loadWeeklyArtifact(JSON.parse(readFileSync(p, "utf8")));
  // THE BLINDNESS ASSERTION. An artifact that saw the season it scores leaves an IN-SAMPLE residual,
  // and every correlation below would measure the fit rather than what the model left on the table.
  if (art.holdoutSeason !== y) throw new Error(`${p} declares holdoutSeason ${art.holdoutSeason}, used for ${y} -- that residual is in-sample`);
  if (art.seasons.includes(y)) throw new Error(`${p} lists ${y} among its training seasons -- not blind`);
  // THE DESIGN ASSERTION. This pre-filter is about the SERVED design; a fold fitting a different
  // feature list is a different model and its residual answers a different question.
  const got = art.features.map((f) => f.name);
  if (got.join(",") !== SERVED.join(",")) {
    throw new Error(`${p} fits [${got.join(",")}] but data/weekly-artifact.json serves [${SERVED.join(",")}]`);
  }

  const pop = populationKeys(db, y);
  if (!pop) throw new Error(`season ${y} has no decision population (feat_player_week_model.in_population)`);
  const raw = db.prepare(
    `SELECT feat_key, week, pts, is_bye FROM feat_player_week_model WHERE season = ?`).all(y);
  const actual = new Map(), bye = new Set();
  for (const r of raw) {
    const k = `${r.feat_key}|${r.week}`;
    if (r.is_bye) { bye.add(k); continue; }
    actual.set(k, r.pts ?? 0);                 // a rostered week not played is a REAL ZERO
  }
  const rows = loadWeeklyRows(db, y)
    .filter((r) => POS.includes(r.pos) && pop.has(`${r.feat_key}|${r.week}`) && !bye.has(`${r.feat_key}|${r.week}`));
  const proj = new Map(projectWeekly({ artifact: art, rows }).map((r) => [`${r.feat_key}|${r.week}`, r]));

  const ol = olFeatures(y);
  const recs = [];
  let covered = 0;
  for (const r of rows) {
    const k = `${r.feat_key}|${r.week}`;
    const a = actual.get(k), m = proj.get(k);
    if (a == null || !m) continue;
    const f = r.team ? ol.feat.get(`${r.week}|${r.team}`) : undefined;
    if (f) covered++;
    recs.push({
      week: r.week, pos: r.pos, team: r.team, actual: a,
      resid: a - m.p50, resid_mean: a - m.mean,
      cand: f ?? null,
      ctl: Object.fromEntries([...LEVEL, ...ECR].map((c) => [c, c === "week_no" ? r.week : (r.f[c] ?? null)])),
    });
  }
  bySeason.set(y, { recs, ol });
  const tws = [...ol.feat.values()];
  coverage.push({
    season: y, rows: recs.length, covered,
    cov: recs.length ? covered / recs.length : 0,
    teamWeeks: tws.length,
    twPos: tws.length ? tws.filter((f) => f.ol_out > 0).length / tws.length : 0,
    twPos2: tws.length ? tws.filter((f) => f.ol_out >= 2).length / tws.length : 0,
    meanOut: tws.length ? tws.reduce((s, f) => s + f.ol_out, 0) / tws.length : 0,
    starters: ol.starters, dateless: ol.dateless, audit: ol.audit,
  });
}

// ---------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
function corr(x, y) {
  const n = x.length; if (n < 3) return NaN;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}
const sd = (v) => { const m = mean(v); return Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, v.length - 1)); };
/** OLS residual of y on [1, ...cols], normal equations + a tiny ridge (the control block is
 *  collinear by construction -- the season line and points-to-date are two views of the level --
 *  and a singular solve would hand back NaN, which reads exactly like "no signal"). */
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

const SLICES = {
  pooled: (r) => true,
  QB: (r) => r.pos === "QB",
  RB: (r) => r.pos === "RB",
  WR: (r) => r.pos === "WR",
  TE: (r) => r.pos === "TE",
  RUSH: (r) => r.pos === "RB",                       // the published prior: line loss hits rushing
  PASS: (r) => r.pos !== "RB",
};

/** One season x one slice x one candidate accessor -> the row of statistics. */
function seasonStat(recs, slice, get) {
  const sub = recs.filter((r) => SLICES[slice](r)).filter((r) => {
    const v = get(r); return v != null && Number.isFinite(v);
  });
  if (sub.length < 200) return null;
  const x = sub.map(get);
  if (new Set(x).size < 2) return null;
  const y = sub.map((r) => r.actual);
  const e = sub.map((r) => r.resid);
  // Controls present on EVERY retained row, non-constant. Nothing is imputed: a control the store
  // does not carry for a season (the consensus pair before the feed's archive begins) drops out and
  // the count is printed, so a partial taken without it is visible rather than assumed.
  const keepOf = (names) => names.filter((c) => sub.every((r) => r.ctl[c] != null && Number.isFinite(Number(r.ctl[c]))))
    .filter((c) => new Set(sub.map((r) => Number(r.ctl[c]))).size > 2);
  const kL = keepOf(LEVEL);
  const colsOf = (names, rows) => names.map((c) => rows.map((r) => Number(r.ctl[c])));
  const rhoL = corr(residualize(x, colsOf(kL, sub)), residualize(e, colsOf(kL, sub)));
  // THE CONSENSUS PARTIAL IS TAKEN ON THE CONSENSUS-COVERED SUBSET, not on the whole season.
  // ecr_wk_rank exists only from 2019 (and for ~65% of rows in the seasons it covers -- the feed
  // publishes a weekly top slice, not the whole population). Requiring it on every row would drop
  // the control silently and print an L-only number under an L+ECR label; restricting the rows is
  // the honest version, and `nE` says how many rows the number rests on.
  const subE = sub.filter((r) => ECR.every((c) => r.ctl[c] != null && Number.isFinite(Number(r.ctl[c]))));
  // On that same subset the LEVEL-ONLY partial is also recomputed (rho_rLsubE): it is the honest
  // "before" for the "after", so the ECR comparison is not confounded by a different row set.
  let rhoE = NaN, rhoLsubE = NaN, kE = [];
  if (subE.length >= 200) {
    const xE = subE.map(get), eE = subE.map((r) => r.resid);
    if (new Set(xE).size >= 2) {
      kE = [...LEVEL, ...ECR].filter((c) => subE.every((r) => r.ctl[c] != null && Number.isFinite(Number(r.ctl[c]))))
        .filter((c) => new Set(subE.map((r) => Number(r.ctl[c]))).size > 2);
      rhoE = corr(residualize(xE, colsOf(kE, subE)), residualize(eE, colsOf(kE, subE)));
      const kLs = kL.filter((c) => new Set(subE.map((r) => Number(r.ctl[c]))).size > 2);
      rhoLsubE = corr(residualize(xE, colsOf(kLs, subE)), residualize(eE, colsOf(kLs, subE)));
    }
  }
  const g = (pred) => {
    const hit = sub.filter((r) => pred(get(r))).map((r) => r.resid);
    const base = sub.filter((r) => get(r) === 0).map((r) => r.resid);
    return hit.length >= 30 && base.length >= 30 ? mean(hit) - mean(base) : NaN;
  };
  return {
    n: sub.length, rho_y: corr(x, y), rho_r: corr(x, e), rho_rL: rhoL,
    rho_rE: rhoE, rho_rLsubE: rhoLsubE, nE: subE.length,
    gap1: g((v) => v >= 1), gap2: g((v) => v >= 2),
    n1: sub.filter((r) => get(r) >= 1).length, n2: sub.filter((r) => get(r) >= 2).length,
    ctlL: kL.length, ctlE: kE.length,
  };
}

/** Season-level mean +/- SE and the 2.9*SE floor verdict, over a per-season statistic. */
function acrossSeasons(vals) {
  const v = vals.filter((x) => Number.isFinite(x));
  if (v.length < 3) return { k: v.length, mean: NaN, se: NaN, floor: NaN, pass: false };
  const m = mean(v), se = sd(v) / Math.sqrt(v.length);
  return { k: v.length, mean: m, se, floor: 2.9 * se, pass: Math.abs(m) > 2.9 * se };
}

// The candidate accessors, including the two controls.
const rnd = mulberry32(Number(val("--seed", "20260917")));
// NEGATIVE CONTROL: permute ol_out across the team-weeks WITHIN a season. The marginal distribution
// and the per-season coverage are preserved exactly; only the alignment to the team-week is
// destroyed. If the pipeline reports THIS as signal, every number it prints is an artefact.
for (const [, s] of bySeason) {
  const keys = [...s.ol.feat.keys()];
  const vals = keys.map((k) => s.ol.feat.get(k).ol_out);
  for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
  const shuf = new Map(keys.map((k, i) => [k, vals[i]]));
  for (const r of s.recs) r.shuffled = r.team ? shuf.get(`${r.week}|${r.team}`) ?? null : null;
}
// POSITIVE CONTROL: synth = resid + N(0, sigma) with sigma chosen so corr(synth, resid) = TARGET.
// For synth = e + z with z independent of e, corr = sd_e / sqrt(sd_e^2 + sigma^2), so
// sigma = sd_e * sqrt(1/target^2 - 1). A pipeline that cannot see a true 0.05 cannot see anything.
const TARGET = Number(val("--positive-corr", "0.05"));
for (const [, s] of bySeason) {
  const se = sd(s.recs.map((r) => r.resid));
  const sigma = se * Math.sqrt(1 / (TARGET * TARGET) - 1);
  for (const r of s.recs) r.synth = r.resid + sigma * gauss(rnd);
}

const CANDS = [
  ["ol_out", (r) => (r.cand ? r.cand.ol_out : null)],
  ["ol_questionable", (r) => (r.cand ? r.cand.ol_questionable : null)],
  ["ol_starters_out", (r) => (r.cand && r.cand.ol_starters_out != null ? r.cand.ol_starters_out : null)],
  ["CONTROL+ synthetic", (r) => r.synth],
  ["CONTROL- shuffled_ol_out", (r) => (r.shuffled == null ? null : r.shuffled)],
];

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------
const f3 = (v) => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(3) : "   n/a");
const f4 = (v) => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(4) : "    n/a");
const tsv = [];

console.log("\n== LEAK GUARD / COVERAGE ==============================================================");
console.log("  cutoff = (this team's own gameday - 2 days), the same point-in-time rule the SHIPPED");
console.log("  inj_* columns use (src/features/sources/weekContext.ts). Rows dated after it are DROPPED.");
console.log("\nseason  rows   cov%   team-wks  ol_out>0  ol_out>=2  mean  starters  dated   OL rows  dropped-late");
for (const c of coverage) {
  console.log(`  ${c.season}  ${String(c.rows).padStart(5)}  ${(100 * c.cov).toFixed(1).padStart(5)}  ` +
    `${String(c.teamWeeks).padStart(8)}  ${(100 * c.twPos).toFixed(1).padStart(7)}%  ${(100 * c.twPos2).toFixed(1).padStart(8)}%  ` +
    `${c.meanOut.toFixed(2).padStart(4)}  ${(c.starters ? "yes" : "NO ").padStart(8)}  ${(c.dateless ? "DATELESS" : "dated").padStart(8)}  ` +
    `${String(c.audit.considered).padStart(7)}  ${String(c.audit.dropped_late).padStart(12)}`);
  tsv.push(["coverage", c.season, c.rows, c.cov, c.teamWeeks, c.twPos, c.twPos2, c.meanOut, c.starters, c.dateless, c.audit.considered, c.audit.dropped_late, c.audit.dropped_nodate].join("\t"));
}

// FACE VALIDITY OF THE FEATURE ITSELF (charter rule 4: before believing a null, prove the lever is
// CONNECTED). A dead column and a real null print the same flat numbers, so two cheap checks that a
// dead column could not pass: (1) ol_out is week-to-week PERSISTENT within a team-season -- a lineman
// with a broken foot is out next week too -- while the shuffled control by construction is not;
// (2) the extreme team-weeks are nameable, so the column can be eyeballed rather than trusted.
{
  const lag = [], lagShuf = [];
  const tops = [];
  for (const [y, s] of bySeason) {
    const byTeam = new Map();
    for (const [k, f] of s.ol.feat) {
      const [w, t] = k.split("|");
      (byTeam.get(t) ?? byTeam.set(t, new Map()).get(t)).set(Number(w), f.ol_out);
    }
    const a = [], b = [];
    for (const [, m] of byTeam) {
      const ws = [...m.keys()].sort((x, z) => x - z);
      for (let i = 1; i < ws.length; i++) if (ws[i] === ws[i - 1] + 1) { a.push(m.get(ws[i - 1])); b.push(m.get(ws[i])); }
    }
    if (a.length > 50) lag.push(corr(a, b));
    // the same statistic on the shuffled control, which must be ~0
    const sa = [], sb = [];
    const shuf = new Map();
    for (const r of s.recs) if (r.team && r.shuffled != null) shuf.set(`${r.week}|${r.team}`, r.shuffled);
    const byTeamS = new Map();
    for (const [k, v] of shuf) { const [w, t] = k.split("|"); (byTeamS.get(t) ?? byTeamS.set(t, new Map()).get(t)).set(Number(w), v); }
    for (const [, m] of byTeamS) {
      const ws = [...m.keys()].sort((x, z) => x - z);
      for (let i = 1; i < ws.length; i++) if (ws[i] === ws[i - 1] + 1) { sa.push(m.get(ws[i - 1])); sb.push(m.get(ws[i])); }
    }
    if (sa.length > 50) lagShuf.push(corr(sa, sb));
    const top = [...s.ol.feat.entries()].sort((p, q) => q[1].ol_out - p[1].ol_out).slice(0, 3);
    tops.push(`${y}: ` + top.map(([k, f]) => `${k.split("|")[1]} wk${k.split("|")[0]} ${f.ol_out}`).join(", "));
  }
  const la = acrossSeasons(lag), ls = acrossSeasons(lagShuf);
  console.log("\n== FEATURE FACE VALIDITY (is the column CONNECTED, or is it dead?) ====================");
  console.log(`  lag-1 within-team autocorrelation of ol_out:   ${f3(la.mean)} +/- ${la.se.toFixed(3)} over ${la.k} seasons`);
  console.log(`  the same on the shuffled control:              ${f3(ls.mean)} +/- ${ls.se.toFixed(3)}  (must be ~0)`);
  console.log("  worst OL weeks per season (team, week, linemen Out/Doubtful):");
  for (const t of tops) console.log(`    ${t}`);
  tsv.push(["facevalidity", "lag1_ol_out", la.mean, la.se, la.k].join("\t"));
  tsv.push(["facevalidity", "lag1_shuffled", ls.mean, ls.se, ls.k].join("\t"));
}

const verdicts = [];
for (const [cname, get] of CANDS) {
  console.log(`\n== ${cname} ==========================================================`);
  for (const slice of ["pooled", "RB", "WR", "TE", "QB", "PASS"]) {
    const per = [];
    for (const y of [...bySeason.keys()].sort((a, b) => a - b)) {
      const st = seasonStat(bySeason.get(y).recs, slice, get);
      per.push([y, st]);
    }
    const ok = per.filter(([, s]) => s);
    if (!ok.length) { console.log(`  ${slice}: no season had >=200 covered rows -- skipped`); continue; }
    if (slice === "pooled" || slice === "RB") {
      console.log(`  ${slice}: per season  (n, rho_y, rho_resid, rho|L, rho|L+ECR, gap>=1, gap>=2 in points)`);
      for (const [y, s] of ok) {
        console.log(`    ${y}  n=${String(s.n).padStart(5)}  ${f3(s.rho_y)}  ${f3(s.rho_r)}  ${f3(s.rho_rL)}  ${f3(s.rho_rE)}   ` +
          `${f3(s.gap1)} (n=${s.n1})  ${f3(s.gap2)} (n=${s.n2})   ecr-rows=${s.nE}`);
      }
    }
    const A = (k) => acrossSeasons(ok.map(([, s]) => s[k]));
    const mk = (label, k) => { const a = A(k); return { label, ...a }; };
    const rows = [mk("rho_resid (raw)", "rho_r"), mk("rho|L (level+anchor)", "rho_rL"),
      mk("rho|L, ECR-covered rows", "rho_rLsubE"), mk("rho|L+ECR (full partial)", "rho_rE"),
      mk("gap ol>=1 (pts)", "gap1"), mk("gap ol>=2 (pts)", "gap2")];
    console.log(`  ${slice}: season-level mean +/- SE over ${ok.length} seasons`);
    for (const r of rows) {
      console.log(`      ${r.label.padEnd(26)} ${f4(r.mean)}  SE ${Number.isFinite(r.se) ? r.se.toFixed(4) : "n/a"}  ` +
        `floor(2.9SE) ${Number.isFinite(r.floor) ? r.floor.toFixed(4) : "n/a"}   ${r.pass ? "CLEARS" : "below"}`);
      tsv.push(["stat", cname, slice, r.label, r.k, r.mean, r.se, r.floor, r.pass].join("\t"));
    }
    if (slice === "pooled" || slice === "RB") verdicts.push({ cand: cname, slice, full: A("rho_rE"), raw: A("rho_r") });
  }
}

console.log("\n== VERDICT (floor convention: |mean| > 2.9*SE, on rho|L+ECR, pooled OR RB) ==============");
for (const v of verdicts) {
  console.log(`  ${v.cand.padEnd(26)} ${v.slice.padEnd(7)} rho|L+ECR ${f4(v.full.mean)} +/- ${Number.isFinite(v.full.se) ? v.full.se.toFixed(4) : "n/a"}` +
    `  floor ${Number.isFinite(v.full.floor) ? v.full.floor.toFixed(4) : "n/a"}  -> ${v.full.pass ? "WORTH A FULL SCREEN" : "DEAD at the pre-filter"}` +
    `   (raw rho_resid ${f4(v.raw.mean)})`);
}

db.close();
if (outPath) { writeFileSync(outPath, tsv.join("\n") + "\n"); console.log(`\nwrote ${outPath}`); }
