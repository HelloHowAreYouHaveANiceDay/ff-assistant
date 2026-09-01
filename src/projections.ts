// The SHARED projection layer -- one module, three horizons, feeding BOTH the draft (season ->
// values) and in-season (weekly -> lineups, ROS -> waivers/trades). Independent of ESPN/consensus
// (that independence is the measured edge -- docs/edges.md).
import { readFileSync, existsSync } from "node:fs";
//
// Calibration note (tools/validate_matchup.py, 57k player-weeks 2014-24): weekly prediction is
// ~72% correlation from PLAYER TALENT alone; the defense-vs-position matchup adjustment adds only
// ~+0.013 corr. So the big in-season edge is EXECUTION (start startable studs, bench byes/OUT) +
// waivers -- NOT a fancy weekly model. This layer keeps the matchup mult (small, real) but the
// lineup optimizer's value comes mostly from availability, which it enforces at lineup time.

export interface PlayerProj { name: string; pos: string; season: number; }
export interface Projections {
  /** Full-season projected points (draft values source). */
  season(name: string): number;
  all(): PlayerProj[];
  /** One week's projection: per-game talent x opponent defense-vs-position (if opponent known). */
  week(name: string, pos: string, opponentTeam?: string): number;
  /** Rest-of-season: remaining games x per-game (matchup averages out). */
  ros(name: string, gamesRemaining: number): number;
}

export interface ProjInputs {
  seasonPoints: PlayerProj[]; // name/pos/season projected points (our independent table)
  defRatings?: Map<string, number>; // key `${team}|${pos}` -> multiplier (>1 = soft matchup)
  gamesPerSeason?: number; // default 17
}

export function makeProjections(inp: ProjInputs): Projections {
  const games = inp.gamesPerSeason ?? 17;
  const byName = new Map(inp.seasonPoints.map((p) => [p.name, p]));
  const def = inp.defRatings ?? new Map();
  const perGame = (name: string) => (byName.get(name)?.season ?? 0) / games;
  return {
    season: (name) => byName.get(name)?.season ?? 0,
    all: () => inp.seasonPoints,
    week: (name, pos, opp) => {
      const base = perGame(name);
      const mult = opp ? (def.get(`${opp}|${pos}`) ?? 1) : 1;
      return Math.round(base * mult * 10) / 10;
    },
    ros: (name, gamesRemaining) => Math.round(perGame(name) * Math.max(0, gamesRemaining) * 10) / 10,
  };
}

/** Load the layer from the CSVs the tools produce (points.csv + def-ratings.csv). */
export function loadProjections(pointsCsv: string, defCsv?: string): Projections {
  const seasonPoints: PlayerProj[] = readFileSync(pointsCsv, "utf8").trim().split(/\r?\n/).slice(1)
    .map((l) => l.split(",")).filter((f) => f[0] && f[2])
    .map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), season: Number(f[2]) }));
  let defRatings: Map<string, number> | undefined;
  if (defCsv && existsSync(defCsv)) {
    defRatings = new Map();
    for (const l of readFileSync(defCsv, "utf8").trim().split(/\r?\n/).slice(1)) {
      const f = l.split(","); if (f[0]) defRatings.set(`${f[0].trim()}|${f[1].trim().toUpperCase()}`, Number(f[2]));
    }
  }
  return makeProjections({ seasonPoints, defRatings });
}
