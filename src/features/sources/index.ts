/**
 * `ff build-features-ext --seasons 2013-2025` -- the two extension tables plus their coverage.
 *
 * Kept entirely separate from `src/features/build.ts`: that file owns feat_player_season and
 * feat_player_week and is being changed on another branch. These tables extend those rows sideways
 * on `player_sk` and never rewrite them, so the two builders can run in either order and neither
 * can silently change the other's numbers.
 */
import { openDb } from "../../db/db.js";
import { buildSeasonExt, type SeasonExtResult } from "./seasonExt.js";
import { buildWeekContext, type WeekContextResult } from "./weekContext.js";
import { writeCoverage } from "./coverage.js";

export interface BuildExtResult {
  season: SeasonExtResult;
  week: WeekContextResult;
  coverageRows: number;
}

export async function buildFeaturesExt(opts: { dbPath?: string; seasons: number[]; weeks?: boolean }): Promise<BuildExtResult> {
  const season = await buildSeasonExt({ dbPath: opts.dbPath, seasons: opts.seasons });
  const week = opts.weeks === false
    ? { seasons: [], rows: 0, perSeason: [], resolution: [] } as WeekContextResult
    : buildWeekContext({ dbPath: opts.dbPath, seasons: opts.seasons });
  const db = openDb(opts.dbPath);
  let coverageRows = 0;
  if (season.seasons.length) coverageRows += writeCoverage(db, "feat_player_season_ext", season.seasons);
  if (week.seasons.length) coverageRows += writeCoverage(db, "feat_player_week_context", week.seasons);
  db.close();
  return { season, week, coverageRows };
}
