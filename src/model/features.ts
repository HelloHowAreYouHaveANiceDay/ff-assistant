/**
 * THE ONE PLACE feature rows are built for the projector, so the board and the backtest cannot be
 * looking at different numbers while both calling "the projector".
 *
 * The split of responsibility is deliberate and it is the whole point of the module boundary:
 *
 *   this file      reads the store, reads the fitted multiplier artifacts, and produces FeatureRows
 *   projector.ts   is a pure function of (artifact, FeatureRows) and can therefore be tested by
 *                  handing the two call sites identical inputs and demanding identical output
 *
 * If the loader lived inside the projector, that test would prove nothing: each caller could reach
 * for a different file and the "identical inputs" would be a fiction.
 *
 * THE RANK BASIS is the one real difference between the callers, and it is named rather than
 * implicit. The BOARD indexes the curve at preseason consensus rank, because that is the variable
 * the auction is actually priced against. The BACKTEST has no consensus for 1999-2019 (the
 * FantasyPros archive begins in 2020), so it indexes at prior-year finish rank -- which is what
 * Phase 1's `--projection conditional` arm did, and keeping it that way is what makes the two arms
 * comparable at all.
 */
import { type DB } from "../db/db.js";
import type { FeatureRow, ProjectionArtifact, ProjRow } from "./projector.js";
import { projectSeason } from "./projector.js";

export type RankBasis = "ecr" | "prior" | "ecr-else-prior";

export interface LoadOpts {
  season: number;
  rankBasis: RankBasis;
  /** Where `base` comes from. Defaults to the artifact's own declaration. */
  base?: ProjectionArtifact["base"];
  /** The curve carried ON the artifact, read at the row's rank. Required when base is
   *  "artifact_curve" and ignored otherwise. */
  curve?: Record<string, number[]>;
  /** Positions to emit. Defaults to whatever the table holds for the season. */
  positions?: string[];
}

/** Read a curve at a rank, carrying the last fitted value past its end -- the same rule the
 *  precomputed `curve_value_*` columns follow, stated once so the two cannot diverge. */
export function curveAt(curve: Record<string, number[]> | undefined, pos: string, rank: number | null): number | null {
  const v = curve?.[pos];
  if (!v || !v.length || rank == null || rank < 1) return null;
  return v[Math.min(Math.round(rank) - 1, v.length - 1)];
}

interface Raw {
  feat_key: string; player_sk: string | null; name: string; name_key: string | null; pos: string;
  prior_pos_rank: number | null; prior_pts: number | null; prior_games: number | null;
  age: number | null; prior_fd: number | null; prior_ts: number | null;
  prior_attempts: number | null; prior_rush_yards: number | null;
  prior_air_yards_share: number | null; prior_wopr: number | null;
  team_changed: number | null; draft_year: number | null; draft_round: number | null; draft_pick: number | null;
  ecr_pos_rank: number | null; ecr_sd: number | null;
  curve_value_prior: number | null; curve_value_ecr: number | null; curve_value_orderstat: number | null;
}

/**
 * THE EXTENSION TABLE'S SEASON COLUMNS, keyed by SURROGATE KEY (Phase 2d).
 *
 * `feat_player_season_ext` is the data track's own season-level output and it is written under
 * `player_sk`, not under `feat_key`. Joining it by name would be the join that put a father's birth
 * year on his son; joining it by feat_key would silently miss every row whose key has moved.
 *
 * Two of the columns are DERIVED here rather than read:
 *   `adp_vs_ecr`        -- ADP is an overall draft position and ECR is a positional rank, so the raw
 *                          two are not comparable. Ranking ADP within (season, position) puts them
 *                          on one scale; positive means the room takes him later than the experts.
 *   `rookie_draft_pick` -- draft position for a man with NO prior season, and NULL for everyone
 *                          else. `draft_round` is already a fitted feature for every player, where
 *                          it is largely a proxy for career quality; this asks the narrower question.
 *
 * A season the table does not cover (it starts in 2013) yields an empty map, and every column lands
 * NULL -- which the artifact's declared `missing` handles, and `feat_coverage` reports.
 */
export interface ExtSeasonRow {
  prior_snap_share: number | null; prior_route_share: number | null;
  prior_carries_per_game: number | null; prior_carry_share: number | null;
  depth_rank_sep1: number | null; contract_year: number | null;
  adp: number | null; adp_vs_ecr: number | null; rookie_draft_pick: number | null;
  // FRONTIER CANDIDATES (2026-09-14) -- read here so the SERVING projector computes them the same way
  // the trainer fits them. --add-features candidates only; not fitted by default.
  prior_out_games: number | null; prior_yac_oe: number | null; prior_ryoe: number | null;
  prior_cpoe: number | null; qb_changed: number | null;
}

export function loadExtSeason(db: DB, season: number): Map<string, ExtSeasonRow> {
  const out = new Map<string, ExtSeasonRow>();
  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare(
      `SELECT player_sk, pos, draft_year, draft_pick, contract_year, prior_snap_share,
              prior_route_share, prior_carries_per_game, prior_carry_share, depth_rank_sep1, adp,
              prior_out_games, prior_yac_oe, prior_ryoe, prior_cpoe, qb_changed
         FROM feat_player_season_ext WHERE season = ?`,
    ).all(season) as Record<string, unknown>[];
  } catch { return out; }                      // a store without the extension table: no columns, not zeros
  // ECR positional rank comes from feat_player_season, which is the same place the model reads it,
  // so the two halves of `adp_vs_ecr` cannot be two different rank definitions.
  const ecr = new Map<string, number>();
  for (const r of db.prepare(
    "SELECT player_sk, ecr_pos_rank FROM feat_player_season WHERE season = ? AND player_sk IS NOT NULL",
  ).all(season) as { player_sk: string; ecr_pos_rank: number | null }[]) {
    if (r.ecr_pos_rank != null) ecr.set(String(r.player_sk), Number(r.ecr_pos_rank));
  }
  const byPos = new Map<string, { sk: string; adp: number }[]>();
  for (const r of rows) {
    if (r.adp == null) continue;
    const p = String(r.pos ?? "");
    (byPos.get(p) ?? byPos.set(p, []).get(p)!).push({ sk: String(r.player_sk), adp: Number(r.adp) });
  }
  const adpRank = new Map<string, number>();
  for (const list of byPos.values()) {
    list.sort((a, b) => a.adp - b.adp);
    list.forEach((x, i) => adpRank.set(x.sk, i + 1));
  }
  const num = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  for (const r of rows) {
    const sk = String(r.player_sk);
    const ar = adpRank.get(sk), er = ecr.get(sk);
    out.set(sk, {
      prior_snap_share: num(r.prior_snap_share), prior_route_share: num(r.prior_route_share),
      prior_carries_per_game: num(r.prior_carries_per_game), prior_carry_share: num(r.prior_carry_share),
      depth_rank_sep1: num(r.depth_rank_sep1), contract_year: num(r.contract_year),
      adp: num(r.adp),
      adp_vs_ecr: ar != null && er != null ? ar - er : null,
      rookie_draft_pick: num(r.draft_year) === season ? num(r.draft_pick) : null,
      prior_out_games: num(r.prior_out_games), prior_yac_oe: num(r.prior_yac_oe),
      prior_ryoe: num(r.prior_ryoe), prior_cpoe: num(r.prior_cpoe), qb_changed: num(r.qb_changed),
    });
  }
  return out;
}

const EMPTY_EXT: ExtSeasonRow = {
  prior_snap_share: null, prior_route_share: null, prior_carries_per_game: null,
  prior_carry_share: null, depth_rank_sep1: null, contract_year: null,
  adp: null, adp_vs_ecr: null, rookie_draft_pick: null,
  prior_out_games: null, prior_yac_oe: null, prior_ryoe: null, prior_cpoe: null, qb_changed: null,
};

/**
 * MULTI-YEAR HISTORY (rung 2, 2026-09-14): the Y-2 and Y-3 rows of feat_player_season, by SURROGATE
 * KEY -- the same key `prior_pts` is keyed on (the Y row's prior_pts equals the Y-1 row's pts for
 * every resolved pair in the store). Their `pts`/`games` are season Y-2/Y-3 TARGETS, which at the
 * season-Y anchor are past facts; nothing here reads season Y's own row.
 *
 * Mirrored by tools/train_projection.py load_rows() / hist_ppg_w(), and the artifact's golden block
 * carries fixtures with these keys so the two are checked to agree rather than assumed to.
 */
export interface LagSeasonRow { p2: number | null; g2: number | null; p3: number | null; g3: number | null }

export function loadLagSeason(db: DB, season: number): Map<string, LagSeasonRow> {
  const out = new Map<string, LagSeasonRow>();
  for (const r of db.prepare(
    "SELECT player_sk, season, pts, games FROM feat_player_season WHERE season IN (?, ?) AND player_sk IS NOT NULL AND pts IS NOT NULL",
  ).all(season - 2, season - 3) as { player_sk: string; season: number; pts: number; games: number | null }[]) {
    const sk = String(r.player_sk);
    const cur = out.get(sk) ?? { p2: null, g2: null, p3: null, g3: null };
    if (r.season === season - 2) { cur.p2 = r.pts; cur.g2 = r.games; } else { cur.p3 = r.pts; cur.g3 = r.games; }
    out.set(sk, cur);
  }
  return out;
}

/** Marcel weights on Y-1, Y-2, Y-3. Applied to BOTH points and games, so a three-game season barely
 *  moves the blend. Mirrors LAG_WEIGHTS in tools/train_projection.py. */
const LAG_WEIGHTS = [5, 4, 3] as const;

/** Games-weighted three-season points per game; null when no season has games. Mirrors the Python
 *  hist_ppg_w() term for term. */
export function histPpgW(
  p1: number | null | undefined, g1: number | null | undefined,
  p2: number | null | undefined, g2: number | null | undefined,
  p3: number | null | undefined, g3: number | null | undefined,
): number | null {
  let num = 0, den = 0;
  const ps = [p1, p2, p3], gs = [g1, g2, g3];
  for (let i = 0; i < 3; i++) {
    const p = ps[i], g = gs[i];
    if (p == null || g == null || !(g > 0)) continue;
    num += LAG_WEIGHTS[i] * p;
    den += LAG_WEIGHTS[i] * g;
  }
  return den > 0 ? num / den : null;
}

function lagFeatures(l: LagSeasonRow | undefined, p1: number | null | undefined, g1: number | null | undefined) {
  return {
    prior2_pts: l?.p2 ?? null,
    prior3_pts: l?.p3 ?? null,
    hist_ppg_w: histPpgW(p1, g1, l?.p2, l?.g2, l?.p3, l?.g3),
  };
}

/** NONLINEAR BASIS (rung 4, 2026-09-14): three terms derived from age and prior rank, so an artifact
 *  can carry curvature and a hinge without a new evaluator. Mirrors basis_features() in
 *  tools/train_projection.py term for term; the pivots and the rank clip are the trainer's. */
const AGE_PIVOT = 27, AGE_HINGE = 30, BASIS_MAX_RANK = 60;
export function basisFeatures(age: number | null | undefined, rank: number | null | undefined) {
  return {
    age_sq: age != null ? (age - AGE_PIVOT) ** 2 : null,
    age_hinge30: age != null ? Math.max(age - AGE_HINGE, 0) : null,
    log_rank: rank != null ? Math.log(Math.min(Math.max(rank, 1), BASIS_MAX_RANK)) : null,
  };
}

/** EXTERNAL PROJECTION (rung 7, 2026-09-14): FFToday's PRESEASON season projection for `season`,
 *  keyed `${pos}|${name_key}` -- the same join rule the trainer's load_rows uses. A store without the
 *  archive yields an empty map, so the column lands NULL and the artifact's `missing` (1.0, "what his
 *  rank implies") handles it. Verified a projection, not leaked actuals: corr with actual points
 *  0.60-0.79 by season. */
export function loadExternalProj(db: DB, season: number): Map<string, number> {
  const out = new Map<string, number>();
  try {
    for (const r of db.prepare(
      "SELECT pos, name_key, proj_fpts FROM raw_fftoday_proj WHERE season = ? AND proj_fpts IS NOT NULL",
    ).all(season) as { pos: string; name_key: string; proj_fpts: number }[]) {
      out.set(`${r.pos}|${r.name_key}`, Number(r.proj_fpts));
    }
  } catch { /* no archive table in this store: no column, not zeros */ }
  return out;
}

/**
 * NOTHING HERE READS `age-curve.json` OR `opportunity-model.json` ANY MORE (Phase 2b).
 *
 * They were fitted outside every fold, by their own scripts, against their own curves -- and the
 * opportunity one against a curve that had seen the future, which is defect D1. A projector that
 * reaches for a fitted file on disk cannot be cross-validated, because the file is the same file in
 * every fold. Age and usage are now named features of the trainer, fitted inside the fold; the two
 * files remain on disk for the record and `models.ts` says so.
 */

/** Feature rows for one season, in projector shape. Reads ONLY point-in-time columns; `pts` and
 *  `games` are targets and are deliberately not selected, so a projector cannot read them by
 *  accident. */
export function loadFeatureRows(db: DB, opts: LoadOpts): FeatureRow[] {
  const rows = db.prepare(
    `SELECT feat_key, player_sk, name, name_key, pos, prior_pos_rank, prior_pts, prior_games, age,
            prior_fd, prior_ts, prior_attempts, prior_rush_yards, prior_air_yards_share, prior_wopr,
            team_changed, draft_year, draft_round, draft_pick, ecr_pos_rank, ecr_sd,
            curve_value_prior, curve_value_ecr, curve_value_orderstat
       FROM feat_player_season WHERE season = ?`,
  ).all(opts.season) as Raw[];

  const want = opts.positions ? new Set(opts.positions) : null;
  const baseCol = opts.base ?? "curve_value_ecr";
  const xt = loadExtSeason(db, opts.season);
  const lag = loadLagSeason(db, opts.season);
  const ext = loadExternalProj(db, opts.season);

  const out: FeatureRow[] = [];
  for (const r of rows) {
    if (want && !want.has(r.pos)) continue;
    const rank = opts.rankBasis === "prior" ? r.prior_pos_rank
      : opts.rankBasis === "ecr" ? r.ecr_pos_rank
        : (r.ecr_pos_rank ?? r.prior_pos_rank);
    const base = baseCol === "artifact_curve" ? curveAt(opts.curve, r.pos, rank)
      : baseCol === "curve_value_prior" ? r.curve_value_prior
        : baseCol === "curve_value_orderstat" ? r.curve_value_orderstat
          : (opts.rankBasis === "prior" ? r.curve_value_prior : (r.curve_value_ecr ?? r.curve_value_prior));
    out.push({
      player_sk: r.player_sk, name: r.name, pos: r.pos,
      base, rank,
      f: {
        age: r.age, prior_pos_rank: r.prior_pos_rank, prior_pts: r.prior_pts, prior_games: r.prior_games,
        prior_fd: r.prior_fd, prior_ts: r.prior_ts, prior_attempts: r.prior_attempts,
        prior_rush_yards: r.prior_rush_yards, prior_air_yards_share: r.prior_air_yards_share,
        prior_wopr: r.prior_wopr, team_changed: r.team_changed,
        draft_round: r.draft_round, draft_pick: r.draft_pick,
        draft_age: r.draft_year != null && r.age != null ? r.age - (opts.season - r.draft_year) : null,
        ecr_pos_rank: r.ecr_pos_rank, ecr_sd: r.ecr_sd,
        ...(r.player_sk != null ? xt.get(String(r.player_sk)) ?? EMPTY_EXT : EMPTY_EXT),
        ...lagFeatures(r.player_sk != null ? lag.get(String(r.player_sk)) : undefined, r.prior_pts, r.prior_games),
        ...basisFeatures(r.age, r.prior_pos_rank),
        fftoday_proj: r.name_key != null ? ext.get(`${r.pos}|${r.name_key}`) ?? null : null,
      },
    });
  }
  // Deterministic order, so two paths that agree on the numbers also agree byte for byte. Ordered by
  // (pos, name) rather than by the projection: sorting on the output would make the row order depend
  // on the artifact, which is exactly the coupling this function exists to avoid.
  out.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** BOARD path: consensus rank, the curve the artifact declares. */
export function boardProjection(db: DB, season: number, artifact: ProjectionArtifact, asOf?: string): ProjRow[] {
  const features = loadFeatureRows(db, {
    season, rankBasis: "ecr-else-prior", base: artifact.base, curve: artifact.curve,
  });
  return projectSeason({ season, asOf: asOf ?? `${season}-09-01`, artifact, features });
}

/**
 * BACKTEST path: prior-year finish rank, same artifact, same projector.
 *
 * THE POOL IS THE PRIOR SEASON'S PLAYERS, not this season's, and that is not a detail. The backtest
 * drafts in the (simulated) August of season Y, when the only people who exist are the ones who
 * played in Y-1 -- including the ones who are about to retire or get hurt in camp and never appear
 * in Y at all. Building the pool from season Y's scored rows instead would quietly delete every
 * player who did not play, which is survivorship selection handed to our side of the draft and
 * nobody else's, and it would break the pairing with the baseline arm as well.
 *
 * So the universe comes from season Y-1, each player is looked up in the curve for Y at HIS Y-1
 * finish rank, and his regression features are taken from his season-Y row where one exists. A
 * player with no season-Y row keeps nulls, which the artifact's declared `missing` values handle --
 * an honest "we do not know" rather than a dropped row.
 */
export function backtestFeatureRows(db: DB, season: number, artifact: ProjectionArtifact): FeatureRow[] {
  const kind = artifact.base === "curve_value_orderstat" ? "orderstat" : "conditional";
  let curve: Record<string, number[]>;
  if (artifact.base === "artifact_curve") {
    curve = artifact.curve!;
  } else {
    curve = {};
    for (const c of db.prepare("SELECT pos, rank, value FROM feat_curve WHERE season = ? AND kind = ? ORDER BY rank")
      .all(season, kind) as { pos: string; rank: number; value: number }[]) {
      (curve[c.pos] ??= [])[c.rank - 1] = c.value;
    }
  }
  // THE POOL CARRIES ITS OWN SEASON'S FACTS, which is the fix for defect D3.
  //
  // A man in the pool who never posts a season-Y row -- retired, cut, hurt in August -- used to
  // arrive with every feature NULL, so the trained arm projected him from the intercept alone while
  // the curve-only arm projected him from his rank. That is not a fair pairing, and it hits exactly
  // the players whose fate the projection most needs to price. His season Y-1 row holds all of it:
  // `pts`/`games` are the Y row's `prior_pts`/`prior_games`, and `own_*` is the Y row's `prior_*`.
  const pool = db.prepare(
    `SELECT feat_key, player_sk, name, name_key, pos, pos_rank, pts, games, age, draft_year, draft_round, draft_pick,
            own_fd, own_ts, own_attempts, own_rush_yards, own_air_yards_share, own_wopr
       FROM feat_player_season
      WHERE season = ? AND pts IS NOT NULL AND pos_rank IS NOT NULL`,
  ).all(season - 1) as {
    feat_key: string; player_sk: string | null; name: string; name_key: string | null; pos: string; pos_rank: number;
    pts: number; games: number | null; age: number | null;
    draft_year: number | null; draft_round: number | null; draft_pick: number | null;
    own_fd: number | null; own_ts: number | null; own_attempts: number | null;
    own_rush_yards: number | null; own_air_yards_share: number | null; own_wopr: number | null;
  }[];

  const xt = loadExtSeason(db, season);
  const lag = loadLagSeason(db, season);
  const ext = loadExternalProj(db, season);
  const own = new Map<string, Raw>();
  for (const r of db.prepare(
    `SELECT feat_key, player_sk, name, pos, prior_pos_rank, prior_pts, prior_games, age,
            prior_fd, prior_ts, prior_attempts, prior_rush_yards, prior_air_yards_share, prior_wopr,
            team_changed, draft_year, draft_round, draft_pick, ecr_pos_rank, ecr_sd,
            curve_value_prior, curve_value_ecr, curve_value_orderstat
       FROM feat_player_season WHERE season = ?`,
  ).all(season) as (Raw & { feat_key: string })[]) own.set(r.feat_key, r);

  const out: FeatureRow[] = [];
  for (const p of pool) {
    const base = curveAt(curve, p.pos, p.pos_rank);
    const r = own.get(p.feat_key);
    // `??` and not `||`: a genuine 0 (no rushing yards, no target share) is information and must not
    // fall through to the previous season's number.
    const age = r?.age ?? (p.age != null ? Math.round((p.age + 1) * 100) / 100 : null);
    const draftYear = r?.draft_year ?? p.draft_year;
    out.push({
      player_sk: p.player_sk, name: p.name, pos: p.pos, base: base ?? null, rank: p.pos_rank,
      f: {
        age, prior_pos_rank: p.pos_rank,
        prior_pts: r?.prior_pts ?? p.pts,
        prior_games: r?.prior_games ?? p.games ?? null,
        prior_fd: r?.prior_fd ?? p.own_fd,
        prior_ts: r?.prior_ts ?? p.own_ts,
        prior_attempts: r?.prior_attempts ?? p.own_attempts,
        prior_rush_yards: r?.prior_rush_yards ?? p.own_rush_yards,
        prior_air_yards_share: r?.prior_air_yards_share ?? p.own_air_yards_share,
        prior_wopr: r?.prior_wopr ?? p.own_wopr,
        // Whether he changed team is genuinely unknowable for a man with no season-Y row, so it
        // stays NULL and the artifact's declared `missing` handles it. Draft capital is a fact about
        // the past and carries over.
        team_changed: r?.team_changed ?? null,
        draft_round: r?.draft_round ?? p.draft_round,
        draft_pick: r?.draft_pick ?? p.draft_pick,
        draft_age: draftYear != null && age != null ? age - (season - draftYear) : null,
        ecr_pos_rank: r?.ecr_pos_rank ?? null, ecr_sd: r?.ecr_sd ?? null,
        // The extension columns are as-of September 1 of season Y, so they belong to the Y row and
        // are looked up under the Y surrogate key -- the SAME key the trainer reads them under. A
        // man in the pool with no Y row has none of them, which is the honest answer.
        ...(p.player_sk != null ? xt.get(String(p.player_sk)) ?? EMPTY_EXT : EMPTY_EXT),
        // The lags are keyed on the same surrogate key and are past facts for a man with or without
        // a season-Y row; his Y-1 points/games come from the same place `prior_pts` above does.
        ...lagFeatures(p.player_sk != null ? lag.get(String(p.player_sk)) : undefined,
          r?.prior_pts ?? p.pts, r?.prior_games ?? p.games ?? null),
        // The basis is a function of the same `age` and rank used above, so the two cannot disagree.
        ...basisFeatures(age, p.pos_rank),
        // Season Y's preseason projection for the pool man, by the name key he carries in the pool row.
        fftoday_proj: p.name_key != null ? ext.get(`${p.pos}|${p.name_key}`) ?? null : null,
      },
    });
  }
  out.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

export function backtestProjection(db: DB, season: number, artifact: ProjectionArtifact, asOf?: string): ProjRow[] {
  return projectSeason({ season, asOf: asOf ?? `${season}-09-01`, artifact, features: backtestFeatureRows(db, season, artifact) });
}

