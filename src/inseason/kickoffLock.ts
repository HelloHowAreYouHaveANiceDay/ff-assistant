/**
 * WHO CAN STILL BE MOVED, AND WHO IS ALREADY PLAYING.
 *
 * WHY THIS EXISTS. `lineupRecommend` had no concept of a kickoff. It read the roster, priced every
 * man at his weekly projection and returned the best legal assignment -- of ALL of them, including
 * the ones whose games had already been played. On 2026-09-18, the morning after a Thursday night
 * game, it advised league 462233 to start a quarterback who had thrown for 29.8 points the previous
 * evening and been on the bench while he did it. The advice was arithmetically correct and
 * physically impossible, and it will recur every Friday of the season, plus every Sunday afternoon
 * once the early games are final -- which is exactly when a manager is most likely to be looking.
 *
 * THE RULE IS A FACT ABOUT THE NFL CLOCK, NOT ABOUT OUR LEAGUE. ESPN locks a player when his own
 * team's game kicks off; nothing else moves him. So the question "may I still bench him?" is
 * answered entirely by `raw_nfl_game`: his NFL team's kickoff for this week, against now.
 *
 * TIMEZONE. `raw_nfl_game.gameday`/`gametime` are AMERICA/NEW_YORK -- a kickoff is an ET fact -- so
 * `etClock` (src/weekly/scorecard.ts, already the repo's one converter) is reused rather than
 * respelled. The machine's own timezone is never consulted; this machine is not guaranteed to be in
 * ET and the schedule table is.
 *
 * SETTLED POINTS (added 2026-09-18). A man whose game is OVER is no longer a distribution: he is a
 * number. `settledPointsFor` reads what he actually scored from `raw_league_roster_week`, which is
 * ESPN's OWN applied total under this league's scoring -- not a re-derivation from nflverse stats,
 * which would be a second opinion about a settled fact.
 *
 * KICKED OFF AND FINISHED ARE DIFFERENT QUESTIONS, and conflating them is the trap here. At kickoff
 * a man stops being MOVABLE; only at the final whistle does he stop being UNCERTAIN. Between the two
 * his applied total is a running score, and substituting it for his projection would price a
 * receiver with one catch in the first quarter at 1.4 points for the week. So the lock and the
 * settlement are computed separately: `lockedNflTeams` governs what may move, `finishedNflTeams`
 * governs what is known.
 */
import { etClock } from "../weekly/scorecard.js";
import type { DB } from "../db/db.js";

/** One NFL team's kickoff for the week, as the ET calendar day and wall clock the table stores. */
export interface Kickoff { team: string; day: string; hm: string }

/**
 * Every team playing in `week`, with its kickoff. A team with no row -- a bye, or a schedule the
 * store has not ingested -- is simply absent, and callers treat absence as "not locked" rather than
 * guessing, which is the safe direction: it leaves a man movable, and the worst case is advice the
 * manager finds he cannot take, not advice that silently omits an option he had.
 */
export function weekKickoffTimes(db: DB, season: number, week: number): Map<string, Kickoff> {
  const out = new Map<string, Kickoff>();
  const rows = db.prepare(
    `SELECT gameday, gametime, away_team, home_team FROM raw_nfl_game
      WHERE season=? AND week=? AND game_type='REG'
        AND gameday IS NOT NULL AND gameday <> '' AND gametime IS NOT NULL AND gametime <> ''`,
  ).all(season, week) as { gameday: string; gametime: string; away_team: string; home_team: string }[];
  for (const r of rows) {
    for (const t of [r.away_team, r.home_team]) {
      const team = (t ?? "").trim().toUpperCase();
      if (team) out.set(team, { team, day: r.gameday, hm: r.gametime });
    }
  }
  return out;
}

/** A kickoff is in the past when its (day, wall clock) is at or before now's, both in ET. Compared
 *  as the strings the table already stores -- `YYYY-MM-DD` and `HH:MM` both sort chronologically --
 *  so no date arithmetic, and no chance of a parse silently shifting an hour. */
export const hasKickedOff = (k: Kickoff, nowEt: { day: string; hm: string }): boolean =>
  k.day < nowEt.day || (k.day === nowEt.day && k.hm <= nowEt.hm);

/**
 * THE NFL TEAMS WHOSE WEEK HAS STARTED. Every rostered man on one of these is locked.
 *
 * An empty set is the correct and common answer -- it is what every day before the week's first
 * kickoff looks like -- so callers must not read emptiness as "the schedule is missing". `.size`
 * against `weekKickoffTimes(...).size` is how the two are told apart, and the serve reports both.
 */
export function lockedNflTeams(db: DB, season: number, week: number, now: Date = new Date()): Set<string> {
  const nowEt = etClock(now);
  const out = new Set<string>();
  for (const k of weekKickoffTimes(db, season, week).values()) if (hasKickedOff(k, nowEt)) out.add(k.team);
  return out;
}

/**
 * HOW LONG AFTER KICKOFF A GAME IS ASSUMED OVER, when the store has no score for it.
 *
 * Four hours. An NFL game runs a little over three; the margin covers overtime and a late window
 * without reaching the next slate's kickoff (the 13:00 ET games are settled well before the 20:15).
 * It is a FALLBACK: a real score in `raw_nfl_game` always wins, and `finishedNflTeams` reports which
 * rule it used per team so a reader can tell a known result from an assumed one.
 */
export const ASSUME_FINAL_AFTER_MINUTES = 240;

const hm2min = (hm: string): number => {
  const [h, m] = hm.split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};

/** Whole days from `from` to `to`, both `YYYY-MM-DD` ET calendar days. Differenced as UTC midnights,
 *  which is exact for a date-only string and immune to any local-timezone DST shift. */
const dayDiff = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000);

/**
 * THE NFL TEAMS WHOSE GAME IS OVER, and how we know.
 *
 * `byScore` is the teams whose game carries a real result in the store. `byElapsed` is the teams we
 * are ASSUMING are finished because four hours have passed since kickoff and nobody has told us the
 * score -- which is the common case in-season, because the nflverse schedule feed lands its results
 * well after the game ends. Both are returned separately rather than unioned into one opaque set,
 * because "we read the final score" and "we guessed from the clock" are different claims and the
 * serve says which it made.
 */
export function finishedNflTeams(
  db: DB, season: number, week: number, now: Date = new Date(),
): { byScore: Set<string>; byElapsed: Set<string> } {
  const nowEt = etClock(now);
  const nowMin = hm2min(nowEt.hm);
  const byScore = new Set<string>();
  const byElapsed = new Set<string>();
  const rows = db.prepare(
    `SELECT gameday, gametime, away_team, home_team, away_score, home_score, result FROM raw_nfl_game
      WHERE season=? AND week=? AND game_type='REG'
        AND gameday IS NOT NULL AND gameday <> '' AND gametime IS NOT NULL AND gametime <> ''`,
  ).all(season, week) as {
    gameday: string; gametime: string; away_team: string; home_team: string;
    away_score: number | null; home_score: number | null; result: number | null;
  }[];
  for (const r of rows) {
    const teams = [r.away_team, r.home_team].map((t) => (t ?? "").trim().toUpperCase()).filter(Boolean);
    if (r.result != null || r.away_score != null || r.home_score != null) {
      for (const t of teams) byScore.add(t);
      continue;
    }
    // No score. Fall back to the clock: finished once ASSUME_FINAL_AFTER_MINUTES have elapsed.
    //
    // ELAPSED TIME IS COMPUTED ACROSS THE DAY BOUNDARY, not approximated by comparing calendar
    // days. The first version of this said "an earlier day is finished outright", which marks a
    // 20:15 Thursday kickoff final at 00:01 on Friday -- three hours and forty-six minutes in, with
    // an overtime game still being played. Caught by the test, not by reading the code. Both dates
    // are ET calendar days, so differencing them as UTC midnights is exact.
    const elapsed = (dayDiff(r.gameday, nowEt.day) * 1440) + nowMin - hm2min(r.gametime);
    if (elapsed >= ASSUME_FINAL_AFTER_MINUTES) for (const t of teams) byElapsed.add(t);
  }
  return { byScore, byElapsed };
}

/**
 * WHAT EACH ROSTERED MAN ACTUALLY SCORED THIS WEEK, by `player_id`, from the league's own feed.
 *
 * `raw_league_roster_week.applied_points` is ESPN's applied total under this league's scoring rules,
 * so it needs no re-derivation and cannot disagree with what the manager sees on the site. The join
 * to the board's `player_id` is BY ESPN ID through `player.espn_id` -- never by name, which is the
 * defect this repo has now paid for twice.
 *
 * A zero is NOT returned as a settled score. ESPN writes 0 both for "he was held scoreless" and for
 * "this week has not been scored yet", and those are the same bytes; treating the second as the
 * first would price an entire unplayed roster at nothing. A genuine scoreless game therefore falls
 * back to his projection, which is the conservative direction and is stated in the serve's caveat.
 */
export function settledPointsFor(db: DB, leagueId: string, season: number, week: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of db.prepare(
    `SELECT p.player_id AS pid, r.applied_points AS pts
       FROM raw_league_roster_week r JOIN player p ON p.espn_id = r.espn_player_id
      WHERE r.league_id=? AND r.season=? AND r.week=? AND r.applied_points IS NOT NULL AND r.applied_points <> 0`,
  ).all(leagueId, season, week) as { pid: string; pts: number }[]) {
    out.set(r.pid, r.pts);
  }
  return out;
}
