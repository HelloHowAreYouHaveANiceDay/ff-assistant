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
import { existsSync, readFileSync } from "node:fs";
import { openDb, type DB } from "../db/db.js";
import { dataPath } from "../data/paths.js";
import { ageFactor, type AgeCurve } from "../draft/age.js";
import { opportunityFactor, type OpportunityModel } from "../draft/opportunity.js";
import type { FeatureRow, ProjectionArtifact, ProjRow } from "./projector.js";
import { projectSeason } from "./projector.js";

export type RankBasis = "ecr" | "prior" | "ecr-else-prior";

export interface LoadOpts {
  season: number;
  rankBasis: RankBasis;
  /** Which curve column feeds `base`. Defaults to the artifact's own declaration. */
  base?: ProjectionArtifact["base"];
  /** Apply the shipped age / opportunity multipliers. Off means every factor is exactly 1, which is
   *  what a trained artifact that regresses on age wants. */
  useAge?: boolean;
  useOpp?: boolean;
  /** Positions to emit. Defaults to whatever the table holds for the season. */
  positions?: string[];
}

interface Raw {
  feat_key: string; player_sk: string | null; name: string; pos: string;
  prior_pos_rank: number | null; prior_pts: number | null; prior_games: number | null;
  age: number | null; prior_fd: number | null; prior_ts: number | null;
  prior_attempts: number | null; prior_rush_yards: number | null;
  prior_air_yards_share: number | null; prior_wopr: number | null;
  team_changed: number | null; draft_year: number | null; draft_round: number | null; draft_pick: number | null;
  ecr_pos_rank: number | null; ecr_sd: number | null;
  curve_value_prior: number | null; curve_value_ecr: number | null; curve_value_orderstat: number | null;
}

export function loadAgeCurve(): AgeCurve | null {
  const p = dataPath("age-curve.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as AgeCurve; } catch { return null; }
}
export function loadOpportunity(): OpportunityModel | null {
  const p = dataPath("opportunity-model.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as OpportunityModel; } catch { return null; }
}

/** Feature rows for one season, in projector shape. Reads ONLY point-in-time columns; `pts` and
 *  `games` are targets and are deliberately not selected, so a projector cannot read them by
 *  accident. */
export function loadFeatureRows(db: DB, opts: LoadOpts): FeatureRow[] {
  const rows = db.prepare(
    `SELECT feat_key, player_sk, name, pos, prior_pos_rank, prior_pts, prior_games, age,
            prior_fd, prior_ts, prior_attempts, prior_rush_yards, prior_air_yards_share, prior_wopr,
            team_changed, draft_year, draft_round, draft_pick, ecr_pos_rank, ecr_sd,
            curve_value_prior, curve_value_ecr, curve_value_orderstat
       FROM feat_player_season WHERE season = ?`,
  ).all(opts.season) as Raw[];

  const age = opts.useAge === false ? null : loadAgeCurve();
  const opp = opts.useOpp === false ? null : loadOpportunity();
  const want = opts.positions ? new Set(opts.positions) : null;
  const baseCol = opts.base ?? "curve_value_ecr";

  const out: FeatureRow[] = [];
  for (const r of rows) {
    if (want && !want.has(r.pos)) continue;
    const rank = opts.rankBasis === "prior" ? r.prior_pos_rank
      : opts.rankBasis === "ecr" ? r.ecr_pos_rank
        : (r.ecr_pos_rank ?? r.prior_pos_rank);
    const base = baseCol === "curve_value_prior" ? r.curve_value_prior
      : baseCol === "curve_value_orderstat" ? r.curve_value_orderstat
        : (opts.rankBasis === "prior" ? r.curve_value_prior : (r.curve_value_ecr ?? r.curve_value_prior));
    const sk = r.player_sk != null && /^\d+$/.test(r.player_sk) ? Number(r.player_sk) : null;
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
      },
      factors: {
        age_factor: ageFactor(age, r.name, r.pos, opts.season, sk),
        opp_factor: opportunityFactor(opp, r.name, r.pos, rank ?? 999, opts.season, sk),
      },
    });
  }
  // Deterministic order, so two paths that agree on the numbers also agree byte for byte. Ordered by
  // (pos, name) rather than by the projection: sorting on the output would make the row order depend
  // on the artifact, which is exactly the coupling this function exists to avoid.
  out.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** BOARD path: consensus rank, both shipped multipliers, the ECR curve column. */
export function boardProjection(db: DB, season: number, artifact: ProjectionArtifact, asOf?: string): ProjRow[] {
  const features = loadFeatureRows(db, {
    season, rankBasis: "ecr-else-prior", base: artifact.base,
    useAge: artifact.multiplicative.includes("age_factor"),
    useOpp: artifact.multiplicative.includes("opp_factor"),
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
  const curve = new Map<string, number[]>();
  for (const c of db.prepare("SELECT pos, rank, value FROM feat_curve WHERE season = ? AND kind = ? ORDER BY rank")
    .all(season, kind) as { pos: string; rank: number; value: number }[]) {
    const a = curve.get(c.pos) ?? curve.set(c.pos, []).get(c.pos)!;
    a[c.rank - 1] = c.value;
  }
  const pool = db.prepare(
    `SELECT feat_key, player_sk, name, pos, pos_rank FROM feat_player_season
      WHERE season = ? AND pts IS NOT NULL AND pos_rank IS NOT NULL`,
  ).all(season - 1) as { feat_key: string; player_sk: string | null; name: string; pos: string; pos_rank: number }[];

  const own = new Map<string, Raw>();
  for (const r of db.prepare(
    `SELECT feat_key, player_sk, name, pos, prior_pos_rank, prior_pts, prior_games, age,
            prior_fd, prior_ts, prior_attempts, prior_rush_yards, prior_air_yards_share, prior_wopr,
            team_changed, draft_year, draft_round, draft_pick, ecr_pos_rank, ecr_sd,
            curve_value_prior, curve_value_ecr, curve_value_orderstat
       FROM feat_player_season WHERE season = ?`,
  ).all(season) as (Raw & { feat_key: string })[]) own.set(r.feat_key, r);

  const age = artifact.multiplicative.includes("age_factor") ? loadAgeCurve() : null;
  const opp = artifact.multiplicative.includes("opp_factor") ? loadOpportunity() : null;

  const out: FeatureRow[] = [];
  for (const p of pool) {
    const v = curve.get(p.pos);
    const base = v && v.length ? v[Math.min(p.pos_rank - 1, v.length - 1)] : null;
    const r = own.get(p.feat_key);
    const sk = p.player_sk != null && /^\d+$/.test(p.player_sk) ? Number(p.player_sk) : null;
    out.push({
      player_sk: p.player_sk, name: p.name, pos: p.pos, base: base ?? null, rank: p.pos_rank,
      f: {
        age: r?.age ?? null, prior_pos_rank: p.pos_rank, prior_pts: r?.prior_pts ?? null,
        prior_games: r?.prior_games ?? null, prior_fd: r?.prior_fd ?? null, prior_ts: r?.prior_ts ?? null,
        prior_attempts: r?.prior_attempts ?? null, prior_rush_yards: r?.prior_rush_yards ?? null,
        prior_air_yards_share: r?.prior_air_yards_share ?? null, prior_wopr: r?.prior_wopr ?? null,
        team_changed: r?.team_changed ?? null, draft_round: r?.draft_round ?? null,
        draft_pick: r?.draft_pick ?? null,
        draft_age: r?.draft_year != null && r.age != null ? r.age - (season - r.draft_year) : null,
        ecr_pos_rank: r?.ecr_pos_rank ?? null, ecr_sd: r?.ecr_sd ?? null,
      },
      factors: {
        age_factor: ageFactor(age, p.name, p.pos, season, sk),
        opp_factor: opportunityFactor(opp, p.name, p.pos, p.pos_rank, season, sk),
      },
    });
  }
  out.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

export function backtestProjection(db: DB, season: number, artifact: ProjectionArtifact, asOf?: string): ProjRow[] {
  return projectSeason({ season, asOf: asOf ?? `${season}-09-01`, artifact, features: backtestFeatureRows(db, season, artifact) });
}

/** Open the store, project, close. For callers that only want the numbers. */
export function projectWith(dbPath: string | undefined, season: number, artifact: ProjectionArtifact, path: "board" | "backtest"): ProjRow[] {
  const db = openDb(dbPath);
  try { return path === "board" ? boardProjection(db, season, artifact) : backtestProjection(db, season, artifact); }
  finally { db.close(); }
}
