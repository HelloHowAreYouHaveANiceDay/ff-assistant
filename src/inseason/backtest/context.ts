/**
 * THE POINT-IN-TIME INPUT to every in-season backtest: what was knowable when week w's decisions
 * were made, and nothing else.
 *
 * One loader, so the lineup backtest, the waiver backtest and the handcuff fit cannot end up
 * disagreeing about what "as of week 8" means -- the same defect `loadSimContext` was written to
 * fix for the draft side, where six scripts each rebuilt the context and three of them silently
 * used a different schedule.
 *
 * WHAT IS ALLOWED IN, and why each is allowed:
 *
 *   ROSTER MEMBERSHIP AND SLOTS for week w      set by the manager BEFORE kickoff (see
 *                                               src/features/sources/rosterState.ts).
 *   feat_player_week_model FEATURES for week w  built with as_of = the day before week w's first
 *                                               kickoff, and test/weekly-leakage.test.ts perturbs
 *                                               week w's own results and asserts none of them move.
 *   is_bye, inj_out, inj_doubtful               the availability block of the same table, on the
 *                                               same anchor.
 *
 * WHAT IS NOT: `pts` from week w or any later week. It is loaded, but into a SEPARATE map named
 * `actual`, which exists only to score a decision after it has been made. Nothing that builds a
 * recommendation may read it, and the leakage test proves that by perturbing it.
 *
 * TWO MODELS, ALWAYS BOTH. `floor` is the shipped season-line-only artifact; `challenger` is the
 * trained two-part one that failed its coverage gate (docs/weekly.md) and is carried anyway. A
 * conclusion that holds under one and not the other is a conclusion about an artifact, not about
 * the decision.
 */
import { readFileSync } from "node:fs";
import type { DB } from "../../db/db.js";
import { dataPath } from "../../data/paths.js";
import { loadWeeklyRows } from "../../weekly/features.js";
import {
  loadWeeklyArtifact, projectWeekly, SHIPPED_WEEKLY_ARTIFACT, CHALLENGER_WEEKLY_ARTIFACT,
  type WeeklyArtifact,
} from "../../weekly/projector.js";
import { projectStreamingWith } from "../../weekly/streamingServe.js";
import { asOfRosterState, buildEspnResolver, startingTemplate, type RosterEntry } from "../../features/sources/rosterState.js";

/**
 * A THIRD ARM: `served`, the per-position mapping the live system actually uses.
 *
 * `floor` and `challenger` are each ONE artifact applied to all six positions, which is the right
 * shape for asking "is this model better". It is not what anybody is served. `WEEKLY_SERVE` maps QB,
 * K and DST to the streaming artifact and RB, WR and TE to the floor, and integration pass 4 routed
 * the lineup seam through it -- so the replay had no arm corresponding to the thing that ships, and
 * the recorded lineup numbers were about two models the copilot does not use.
 */
export type ModelName = "floor" | "challenger" | "served";
/** The sentinel for the served arm. It is not a file, because the served arm is a TABLE. */
export const SERVED = "served" as const;
export type WeekModel = WeeklyArtifact | typeof SERVED;
export const MODEL_FILES: Record<ModelName, string> = {
  floor: SHIPPED_WEEKLY_ARTIFACT,
  challenger: CHALLENGER_WEEKLY_ARTIFACT,
  served: "WEEKLY_SERVE (per position)",
};

export function loadModel(name: ModelName): WeekModel {
  if (name === SERVED) return SERVED;
  return loadWeeklyArtifact(JSON.parse(readFileSync(dataPath(MODEL_FILES[name]), "utf8")));
}

/** Narrow a model to a single artifact, for the paths that genuinely need one. Throws by NAME rather
 *  than silently substituting the floor, which would make a served run report a floor number. */
export function requireArtifact(m: WeekModel, who: string): WeeklyArtifact {
  if (m === SERVED) {
    throw new Error(`${who} needs ONE artifact and was handed the per-position serve table. ` +
      "Run it with --model floor or --model challenger, or teach it the table.");
  }
  return m;
}

export interface PlayerWeek {
  playerSk: string; name: string; pos: string;
  /** The projector's mean, or null where it produced no row (no season line). NULL IS NOT ZERO. */
  proj: number | null;
  /** The point-in-time fallback when the projector has no row: points per game through week w-1.
   *  `lineupRecommend` falls back to the season projection over 17; that number does not exist for a
   *  past season, and td_ppg is the closest quantity that is knowable at the same moment. */
  fallback: number | null;
  available: boolean;
  whyNot: string | null;
  /** THE OUTCOME. Scoring only. Never an input to a recommendation. */
  actual: number;
}

export interface WeekContext {
  season: number; week: number;
  asOf: string | null; firstKickoff: string | null;
  /** The league's starting template for that season, derived from its own rows. */
  template: string[];
  rosters: Map<string, RosterEntry[]>;
  /** Everything with a weekly feature row, keyed by player_sk. */
  players: Map<string, PlayerWeek>;
  rostered: Set<string>;
  /** How many rostered players the projector had no row for -- reported, never silent. */
  fellBack: number;
  /** True when the season's injury block is empty, so availability is bye-only. Stated because a
   *  silently absent OUT designation reads exactly like a healthy league. */
  injuryBlockEmpty: boolean;
}

export function loadWeekContext(
  db: DB, leagueId: string, season: number, week: number, artifact: WeekModel,
  cache?: { resolver?: ReturnType<typeof buildEspnResolver>; template?: string[]; injuryEmpty?: boolean },
): WeekContext {
  const state = asOfRosterState(db, leagueId, season, week, cache?.resolver);
  const template = cache?.template ?? startingTemplate(db, leagueId, season);

  const proj = new Map<string, number>();
  // The served arm goes through the SAME router the live seam does, not a second copy of the table.
  const projected = artifact === SERVED
    ? (projectStreamingWith(db, season, week)?.rows ?? [])
    : projectWeekly({ artifact, rows: loadWeeklyRows(db, season, week) });
  for (const p of projected) {
    if (p.player_sk == null) continue;
    const prev = proj.get(p.player_sk);
    if (prev == null || p.mean > prev) proj.set(p.player_sk, p.mean);
  }

  const meta = db.prepare(
    `SELECT player_sk, name, pos, pts, td_ppg, is_bye, inj_out, inj_doubtful
       FROM feat_player_week_model WHERE season=? AND week=? AND player_sk IS NOT NULL`,
  ).all(season, week) as {
    player_sk: string; name: string; pos: string; pts: number | null; td_ppg: number | null;
    is_bye: number | null; inj_out: number | null; inj_doubtful: number | null;
  }[];

  const injuryBlockEmpty = cache?.injuryEmpty ?? !((db.prepare(
    `SELECT SUM(COALESCE(inj_out,0)) AS n FROM feat_player_week_model WHERE season=?`,
  ).get(season) as { n: number | null }).n);

  const players = new Map<string, PlayerWeek>();
  for (const m of meta) {
    // DOUBTFUL counts as OUT, matching copilot.ts's OUT_STATUSES -- the two surfaces must not
    // disagree about who can be started.
    const whyNot = m.is_bye ? `bye week ${week}` : (m.inj_out ? "OUT" : (m.inj_doubtful ? "DOUBTFUL" : null));
    players.set(m.player_sk, {
      playerSk: m.player_sk, name: m.name, pos: m.pos,
      proj: proj.get(m.player_sk) ?? null,
      fallback: m.td_ppg ?? null,
      available: whyNot == null, whyNot,
      actual: m.pts ?? 0,
    });
  }

  const rosters = new Map<string, RosterEntry[]>();
  let fellBack = 0;
  for (const e of state.rosters) {
    if (!rosters.has(e.teamId)) rosters.set(e.teamId, []);
    rosters.get(e.teamId)!.push(e);
    const p = players.get(e.playerSk);
    if (!p || p.proj == null) fellBack++;
  }
  return {
    season, week, asOf: state.asOf, firstKickoff: state.firstKickoff, template,
    rosters, players, rostered: state.rostered, fellBack, injuryBlockEmpty,
  };
}

