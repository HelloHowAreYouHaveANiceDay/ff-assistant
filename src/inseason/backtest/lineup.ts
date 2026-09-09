/**
 * BACKTEST 1: LINEUP REGRET AGAINST REAL MANAGERS.
 *
 * For every team-week 2018-2025, three numbers on the same roster:
 *
 *   started   what the manager actually started, scored on real results
 *   optimal   the best legal lineup from that same roster with HINDSIGHT -- a ceiling nobody could
 *             have hit, and the honest denominator
 *   tool      what OUR lineup would have scored: `optimalLineup` over the weekly projector's means
 *             AS OF that week, with availability from the same point-in-time block, then scored on
 *             the real results
 *
 * `tool` is the only one of the three that is a decision. It uses exactly the pure core
 * `lineupRecommend` calls -- `optimalLineup` plus `unavailableReason` -- rather than
 * `lineupRecommend` itself, because that function takes a `SimContext`, which is built entirely
 * from the CURRENT season's board, ownership and schedule and cannot be constructed for 2019. The
 * substitution is named here rather than buried: what is being backtested is the lineup rule, on the
 * same projections and the same availability rule, not the copilot's reporting envelope.
 *
 * A ROSTER PLAYER THE PROJECTOR HAS NO ROW FOR falls back to his points per game through week w-1,
 * and the fallback rate is reported. `lineupRecommend` falls back to the season projection over 17;
 * that quantity does not exist for a past season, and td_ppg is the closest thing knowable at the
 * same moment. Silence there would be the whole bug -- a lineup half from a model and half from a
 * flat average, reported as one thing.
 */
import type { DB } from "../../db/db.js";
import { optimalLineup, type RosterPlayer } from "../lineup.js";
import { loadWeekContext, loadModel, type ModelName, type WeekContext } from "./context.js";

export interface LineupRow {
  season: number; week: number; teamId: string;
  started: number; optimal: number; tool: number;
  benchLeft: number; toolLeft: number; toolGain: number;
  rosterN: number; fellBack: number;
}

export interface LineupSummary {
  model: ModelName;
  teamWeeks: number; seasons: number[];
  meanStarted: number; meanOptimal: number; meanTool: number;
  meanBenchLeft: number; meanToolLeft: number; meanToolGain: number;
  /** Share of team-weeks where our lineup outscored what that team actually started. Ties are
   *  counted as HALF a win -- and they are common, because in most weeks the manager and the tool
   *  pick the same eight men. Reporting a tie as a loss would understate, as a win overstate. */
  winVsOwnManager: number; ties: number;
  /** Share of team-weeks where our lineup for that team beat the league's MEDIAN realised lineup
   *  that week. A different question: it mixes roster quality in, where the paired comparison above
   *  holds the roster fixed and varies only the decision. */
  winVsLeagueMedian: number;
  fallbackRate: number;
  seasonsWithoutInjuryData: number[];
  perSeason: { season: number; teamWeeks: number; started: number; optimal: number; tool: number; win: number }[];
}

/** The available/unavailable rule and the projection, per rostered man. */
function toRosterPlayers(ctx: WeekContext, entries: { playerSk: string; name: string; pos: string; lineupSlotId: number }[]): { players: RosterPlayer[]; fellBack: number } {
  const players: RosterPlayer[] = [];
  let fellBack = 0;
  for (const e of entries) {
    // The IR slot is not startable under the league's rules, so it is out of both lineups.
    if (e.lineupSlotId === 21) continue;
    const p = ctx.players.get(e.playerSk);
    const proj = p?.proj ?? null;
    if (proj == null) fellBack++;
    players.push({
      name: `${e.name}#${e.playerSk}`, pos: e.pos,
      proj: proj ?? p?.fallback ?? 0,
      available: p ? p.available : true,
    });
  }
  return { players, fellBack };
}

export function backtestLineups(
  db: DB, leagueId: string, opts: { seasons: number[]; model: ModelName },
): { rows: LineupRow[]; summary: LineupSummary } {
  const artifact = loadModel(opts.model);
  const rows: LineupRow[] = [];
  const seasonsSeen = new Set<number>();
  const noInjury = new Set<number>();
  let fellBackTotal = 0, rosterTotal = 0;
  let winPaired = 0, ties = 0, winMedian = 0;

  for (const season of opts.seasons) {
    const weeks = db.prepare(
      `SELECT DISTINCT week FROM fact_lineup_week WHERE season=? ORDER BY week`,
    ).all(season) as { week: number }[];
    if (!weeks.length) continue;
    for (const { week } of weeks) {
      const ctx = loadWeekContext(db, leagueId, season, week, artifact);
      if (!ctx.rosters.size || !ctx.template.length) continue;
      if (ctx.injuryBlockEmpty) noInjury.add(season);
      seasonsSeen.add(season);

      const actualOf = db.prepare(
        `SELECT team_id, started_pts, optimal_pts, roster_n FROM fact_lineup_week WHERE season=? AND week=?`,
      ).all(season, week) as { team_id: string; started_pts: number; optimal_pts: number; roster_n: number }[];
      const byTeam = new Map(actualOf.map((r) => [r.team_id, r]));

      const weekRows: LineupRow[] = [];
      for (const [teamId, entries] of ctx.rosters) {
        const real = byTeam.get(teamId);
        if (!real) continue;
        const { players, fellBack } = toRosterPlayers(ctx, entries);
        const chosen = optimalLineup(players, ctx.template, ["RB", "WR", "TE"]);
        // SCORED ON REAL RESULTS, not on the projection that chose it. Quoting the tool's own
        // projected total against the managers' realised points would compare a forecast with an
        // outcome and flatter the forecast.
        let tool = 0;
        for (const s of chosen.starters) {
          if (s.name === "(empty)") continue;
          const sk = s.name.split("#")[1];
          tool += ctx.players.get(sk)?.actual ?? 0;
        }
        rosterTotal += entries.length;
        fellBackTotal += fellBack;
        weekRows.push({
          season, week, teamId,
          started: r2(real.started_pts), optimal: r2(real.optimal_pts), tool: r2(tool),
          benchLeft: r2(real.optimal_pts - real.started_pts), toolLeft: r2(real.optimal_pts - tool),
          toolGain: r2(tool - real.started_pts),
          rosterN: real.roster_n, fellBack,
        });
      }
      // The league's median realised lineup THIS WEEK, so the second comparison is against the room
      // as it actually played rather than against a season average.
      const med = median(weekRows.map((r) => r.started));
      for (const r of weekRows) {
        if (r.tool > r.started) winPaired++;
        else if (r.tool === r.started) ties++;
        if (r.tool > med) winMedian++;
      }
      rows.push(...weekRows);
    }
  }

  const n = rows.length || 1;
  const perSeason = [...seasonsSeen].sort().map((s) => {
    const sub = rows.filter((r) => r.season === s);
    const w = sub.filter((r) => r.tool > r.started).length + 0.5 * sub.filter((r) => r.tool === r.started).length;
    return {
      season: s, teamWeeks: sub.length,
      started: r2(mean(sub.map((r) => r.started))), optimal: r2(mean(sub.map((r) => r.optimal))),
      tool: r2(mean(sub.map((r) => r.tool))), win: r3(w / Math.max(1, sub.length)),
    };
  });

  return {
    rows,
    summary: {
      model: opts.model, teamWeeks: rows.length, seasons: [...seasonsSeen].sort(),
      meanStarted: r2(mean(rows.map((r) => r.started))),
      meanOptimal: r2(mean(rows.map((r) => r.optimal))),
      meanTool: r2(mean(rows.map((r) => r.tool))),
      meanBenchLeft: r2(mean(rows.map((r) => r.benchLeft))),
      meanToolLeft: r2(mean(rows.map((r) => r.toolLeft))),
      meanToolGain: r2(mean(rows.map((r) => r.toolGain))),
      winVsOwnManager: r3((winPaired + 0.5 * ties) / n), ties,
      winVsLeagueMedian: r3(winMedian / n),
      fallbackRate: r3(fellBackTotal / Math.max(1, rosterTotal)),
      seasonsWithoutInjuryData: [...noInjury].sort(),
      perSeason,
    },
  };
}

/**
 * SEASON-LEVEL BOOTSTRAP on the paired per-team-week gain.
 *
 * The unit of analysis is the SEASON, not the team-week -- 1,896 team-weeks are eight seasons of
 * correlated draws, and a naive interval over them would be roughly sqrt(1896/8) times too tight.
 * Same rule CLAUDE.md states for the championship backtest.
 */
export function seasonBootstrap(rows: { season: number; toolGain: number }[], iters = 2000, seed = 20260909): { mean: number; lo: number; hi: number; seasons: number } {
  const bySeason = new Map<number, number[]>();
  for (const r of rows) {
    if (!bySeason.has(r.season)) bySeason.set(r.season, []);
    bySeason.get(r.season)!.push(r.toolGain);
  }
  const seasons = [...bySeason.values()];
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const draws: number[] = [];
  for (let i = 0; i < iters; i++) {
    const picked: number[] = [];
    for (let k = 0; k < seasons.length; k++) picked.push(...seasons[Math.floor(rnd() * seasons.length)]);
    draws.push(mean(picked));
  }
  draws.sort((a, b) => a - b);
  return {
    mean: r3(mean(rows.map((r) => r.toolGain))),
    lo: r3(draws[Math.floor(0.025 * draws.length)]),
    hi: r3(draws[Math.floor(0.975 * draws.length)]),
    seasons: seasons.length,
  };
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r2 = (x: number): number => Math.round(x * 100) / 100;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
export { mean, median, r2, r3 };
