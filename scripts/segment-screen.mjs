// AN INITIAL COHORT OF SEGMENT IDEAS, SCREENED THE SAME WAY EVERYTHING ELSE HERE IS.
//
// The individual-effect screen settled that per-player modelling is dead: player effects are real
// inside a window (split-half 0.37-0.50) but do NOT carry across seasons (3 of 4 positions below
// their shuffle null), because season_line_pg and the form columns already carry the individual
// information. So the productive direction is FINER SEGMENTS defined by observable characteristics
// that POOL ACROSS PLAYERS. This screens the first cohort of them.
//
// A SEGMENT CAN EARN ITS KEEP THREE DIFFERENT WAYS AND THEY NEED SEPARATE TESTS. Conflating them
// is how a "segment finding" turns out to be a plain missing feature:
//
//   MAIN   the model is BIASED inside the segment. Partial corr of S with the model residual. If
//          this is what fires, the fix is to add S as an ordinary feature -- it is not a segment
//          result at all, and calling it one would be building machinery for nothing.
//   INTER  the segment changes the SLOPE on something the model already reads. Partial corr of
//          (S x X) with the residual, controlling for the controls AND S AND X, so a main effect
//          in either factor cannot masquerade as an interaction. THIS is the actual segment claim.
//   BAND   the segment changes the SPREAD, not the mean. Partial corr of S with |residual|. The
//          served band is calibrated per position (D32); if variance is segment-structured, the
//          band is wrong for a whole archetype and no mean-based test would ever notice.
//
// EVERY SEGMENT VARIABLE IS PRIOR-SEASON OR TO-DATE, so none of them can see the week being
// scored. They are read from columns this repo already builds -- no new ingestion -- which is
// deliberate: the cohort is meant to be cheap enough to be wrong about.
//
// LIMIT, STATED: residuals come from the SHIPPED artifact, fitted on these seasons, so they are
// shrunk. That direction is conservative for MAIN and INTER (a real effect is understated). It is
// NOT obviously conservative for BAND, so a BAND hit earns a look at the fold-artifact residuals
// before anyone believes it.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { loadWeeklyArtifact, projectWeekly } from "../src/weekly/projector.ts";
import { loadWeeklyRows } from "../src/weekly/features.ts";
import { partial, shuffleNull, mean, sd } from "./lib/linalg.mjs";

const ART = loadWeeklyArtifact(JSON.parse(readFileSync("data/weekly-artifact.json", "utf8")));
const FROM = 2012, TO = 2025;
const db = new Database("data/ff.db", { readonly: true });

// The incumbent block a segment has to beat. `implied_team_total` is out because it is exactly
// (total_line + spread_line)/2 and its presence makes the design singular -- see the QB pre-filter.
const CONTROLS = ["season_line_pg", "td_ppg", "t4_mean", "td_games",
  "spread_line", "total_line", "home", "days_rest", "week_no"];

/**
 * THE COHORT. Each entry is one archetype hypothesis, the column that expresses it, the positions
 * it is defined for, and the feature it is expected to INTERACT with -- named in advance, because
 * choosing the interaction partner after seeing the numbers is how a screen gets fitted.
 */
const COHORT = [
  { key: "qb_rush", pos: ["QB"], x: "spread_line",
    why: "scrambler vs pocket passer. A rushing QB's floor is carries, which do not vanish when he is trailing or facing a good secondary; a pocket passer's does.",
    col: (r, s) => (s?.prior_rush_yards != null && s?.prior_games > 0 ? s.prior_rush_yards / s.prior_games : null) },
  { key: "adot_share", pos: ["WR", "TE"], x: "total_line",
    why: "deep threat vs possession receiver, via prior air-yards share. Deep targets are boom/bust and should live in the BAND at least as much as the mean.",
    col: (r, s) => s?.prior_air_yards_share ?? null },
  { key: "rb_pass_role", pos: ["RB"], x: "spread_line",
    why: "passing-down back vs early-down grinder. THE cleanest game-script hypothesis in the cohort: a receiving back is script-independent, a grinder collapses when his team is behind, so this should interact with the spread.",
    col: (r) => (r.f.prior_route_share != null && r.f.prior_snap_share > 0 ? r.f.prior_route_share / r.f.prior_snap_share : null) },
  { key: "rz_role", pos: ["RB", "WR", "TE"], x: "implied_team_total",
    why: "goal-line/red-zone share. TD-dependent production should scale with how many points his offence is expected to score, and should be higher variance.",
    col: (r) => r.f.rz_share_td ?? null },
  { key: "experience", pos: ["QB", "RB", "WR", "TE"], x: "season_line_pg",
    why: "career stage. A young player's preseason line is a weaker prior than a veteran's, so the model should lean on it LESS for him -- an interaction with the anchor itself.",
    col: (r, s) => (s?.draft_year != null ? r.season - s.draft_year : null) },
  { key: "alpha_wopr", pos: ["WR", "TE"], x: "season_line_pg",
    why: "alpha receiver vs committee, via prior WOPR. Target concentration should make production more stable and less line-dependent.",
    col: (r, s) => s?.prior_wopr ?? null },
  { key: "volatility", pos: ["RB", "WR", "TE"], x: "season_line_pg",
    why: "prior-season volatility as an archetype rather than a level. NOT a positive control, though it was written in as one: prior_vol_cv is DECLARED in the trainer and POS_GATED to these positions, but it is NOT on the served artifact's 26-feature list, so the model never reads it. It is an ordinary untested candidate like the rest -- and a MAIN hit here means a missing feature, not a saturated one. (Same for rz_share_td below, and for dvp_mult, which D19 dropped.)",
    col: (r) => r.f.prior_vol_cv ?? null },
  { key: "depth", pos: ["RB", "WR", "TE"], x: "teammates_out",
    why: "depth-chart rank as an archetype: a WR3's week depends on who is missing far more than a WR1's, so rank should interact with teammates_out.",
    col: (r) => r.f.depth_rank ?? null },
];

// ---- season-level segment source, keyed by (player_sk, season) ---------------------------------
const seasonOf = new Map();
for (const r of db.prepare(
  `SELECT player_sk, season, prior_rush_yards, prior_games, prior_air_yards_share, prior_wopr,
          draft_year, age
     FROM feat_player_season WHERE season BETWEEN ? AND ? AND player_sk IS NOT NULL`,
).all(FROM, TO)) seasonOf.set(`${r.player_sk}|${r.season}`, r);

const ptsOf = new Map();
for (const r of db.prepare(
  `SELECT season, week, feat_key, pts FROM feat_player_week_model
    WHERE season BETWEEN ? AND ? AND pts IS NOT NULL`,
).all(FROM, TO)) ptsOf.set(`${r.season}|${r.week}|${r.feat_key}`, Number(r.pts));

const all = [];
for (let yr = FROM; yr <= TO; yr++) {
  const rows = loadWeeklyRows(db, yr).filter((r) => ["QB", "RB", "WR", "TE"].includes(r.pos));
  for (const r of rows) r.pts = ptsOf.get(`${r.season}|${r.week}|${r.feat_key}`) ?? null;
  const withPts = rows.filter((r) => r.pts != null && r.season_line_pg != null && r.season_line_pg > 0);
  const proj = projectWeekly({ artifact: ART, rows: withPts });
  const byKey = new Map(proj.map((p) => [`${p.feat_key}|${p.week}`, p]));
  for (const r of withPts) {
    const p = byKey.get(`${r.feat_key}|${r.week}`);
    if (!p || !Number.isFinite(p.mean)) continue;
    const s = r.player_sk ? seasonOf.get(`${r.player_sk}|${r.season}`) : null;
    const rec = {
      season: r.season, week: r.week, week_no: r.week, pos: r.pos, player_sk: r.player_sk,
      resid: Number(r.pts) - p.mean, absresid: Math.abs(Number(r.pts) - p.mean),
      season_line_pg: r.season_line_pg,
    };
    for (const c of CONTROLS) if (rec[c] === undefined) rec[c] = r.f[c] ?? null;
    rec.implied_team_total = r.f.implied_team_total ?? null;
    rec.teammates_out = r.f.teammates_out ?? null;
    for (const seg of COHORT) if (seg.pos.includes(r.pos)) rec[seg.key] = seg.col(r, s);
    all.push(rec);
  }
}
console.log(`scored rows ${all.length} | seasons ${FROM}-${TO} | residuals from the SHIPPED artifact\n`);

const f4 = (x) => (x == null ? "    n/a" : (x >= 0 ? " " : "") + x.toFixed(4));
for (const seg of COHORT) {
  console.log(`\n=== ${seg.key}  [${seg.pos.join("/")}]  x ${seg.x}`);
  console.log(`    ${seg.why}`);
  console.log("pos    n      MAIN(resid)  INTER(SxX)   BAND(|resid|)   null p95   coverage");
  for (const pos of seg.pos) {
    const rows = all.filter((r) => r.pos === pos && r[seg.key] != null);
    const posAll = all.filter((r) => r.pos === pos);
    if (rows.length < 400) { console.log(`${pos.padEnd(6)} ${String(rows.length).padStart(5)}   -- too few rows --`); continue; }

    // The interaction term, built from CENTRED factors so it is a pure product and not a rescaled
    // main effect. Controlling for S and X as well makes the test an interaction test.
    const xKey = seg.x;
    const usable = rows.filter((r) => r[xKey] != null && Number.isFinite(Number(r[xKey])));
    const mS = mean(usable.map((r) => Number(r[seg.key])));
    const mX = mean(usable.map((r) => Number(r[xKey])));
    for (const r of usable) r.__inter = (Number(r[seg.key]) - mS) * (Number(r[xKey]) - mX);

    const ctlPlus = [...new Set([...CONTROLS, xKey, seg.key])];
    const mainR = partial(rows, seg.key, CONTROLS, "resid");
    const interR = partial(usable, "__inter", ctlPlus, "resid");
    const bandR = partial(rows, seg.key, CONTROLS, "absresid");
    const nul = shuffleNull(rows, seg.key, CONTROLS, "resid", 15);

    // RATIO TO THE NULL is what makes the row readable. A partial of 0.05 is a strong result at one
    // sample size and noise at another, and comparing raw partials across positions with different
    // n invites exactly that mistake.
    const rat = (v) => (v == null || !nul.p95 ? "  -" : (Math.abs(v) / nul.p95).toFixed(1) + "x");
    console.log(
      pos.padEnd(6), String(rows.length).padStart(5),
      `${f4(mainR.part)} ${rat(mainR.part).padStart(5)}`,
      `${f4(interR.part)} ${rat(interR.part).padStart(5)}`,
      `${f4(bandR.part)} ${rat(bandR.part).padStart(5)}`,
      f4(nul.p95).padStart(9), `  ${(rows.length / Math.max(1, posAll.length) * 100).toFixed(0)}%`,
    );
  }
}

console.log("\n\nMULTIPLICITY, BEFORE ANY OF THIS IS READ AS A RESULT. This table runs 3 tests across 8");
console.log("segments and up to 4 positions each -- on the order of 60 tests against a p95 bar, so about");
console.log("THREE false positives are EXPECTED from chance alone. A 1.5x row is noise-shaped. Treat only");
console.log("the 2.5x+ rows as candidates, and even those buy a paired-season screen, not a place in the model.");
console.log("\nREADING THIS TABLE:");
console.log("  MAIN fires  -> not a segment. Add the column as an ordinary feature and screen it that way.");
console.log("  INTER fires -> a real segment claim: the slope differs, so a gated feature or a split head.");
console.log("  BAND fires  -> the per-position band (D32) is wrong for a whole archetype.");
console.log("  Nothing above its own null p95 is a result. A pass buys a paired-season screen, nothing more.");
db.close();
