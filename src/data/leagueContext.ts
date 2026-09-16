// LEAGUE CONTEXT -- the single seam the multi-league refactor turns on (docs/multi-league-refactor.md).
//
// PHASE 1 (behavior-preserving). Today the store holds ONE "current" league's derived state: a single
// global config (`settings` key 'config') and single-slot board/values/in-season tables. `AppConfig`
// already carries everything a per-league layer needs -- scoring, slots, teams, budget, format, levers --
// it is just stored once. This module wraps "which league + its config" into one object so that the
// ~27 call sites that reach for `currentLeagueId()` or the global `getConfig(db)` can be migrated to an
// explicit context WITHOUT changing behavior yet.
//
// The resolver returns the CURRENT league (most-recently-synced) and the CURRENT global config, so every
// caller gets byte-identical data. Phase 2 makes the config per-league (keyed by `leagueId`); this
// resolver is then the ONE place that changes, and every threaded caller comes along for free.
import type { DB } from "../db/db.js";
import { getConfig, type AppConfig } from "../db/db.js";
import { currentLeagueId } from "./leagueHistory.js";

export interface LeagueContext {
  /** The league this computation is for. `null` only on a store that has never synced a league (a fresh
   *  clone before `league_sync`); config-only callers still work, league-history callers must guard. */
  leagueId: string | null;
  /** Scoring, roster slots, teams, budget, format, levers -- already per-league IN SHAPE (one slot today). */
  config: AppConfig;
}

/**
 * Resolve the context for `leagueId` (default: the current, most-recently-synced league). Never throws
 * for a missing league -- it degrades to `leagueId: null` so config-only paths keep working, matching
 * today's `getConfig(db)` which also does not require a league row.
 */
export function resolveLeagueContext(db: DB, leagueId?: string | null): LeagueContext {
  let id: string | null = leagueId ?? null;
  if (id == null) { try { id = currentLeagueId(db); } catch { id = null; } }
  return { leagueId: id, config: getConfig(db) };
}
