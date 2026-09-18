/**
 * WHAT THIS WEEK IS, assembled once and carried on the context.
 *
 * WHY THIS EXISTS. `SimContext` models the league's STRUCTURE -- who is on which roster, the
 * schedule, the starting slots, the board. It did not model the WEEK'S STATE -- who can play, who is
 * locked, what is already scored -- so every verb re-derived that at its own call site, by hand,
 * inside a `switch`. Measured on 2026-09-18 across the ten copilot verbs:
 *
 *     availability    reached 2 of 10        (lineup, stream)
 *     kickoff locks   reached 1 of 10        (lineup)
 *     settled points  reached 1 of 10        (lineup)
 *
 * Every defect found that day is one of those cells being empty. A man on injured reserve read as
 * startable to the waiver verb, which recommended bidding 53% of the FAAB budget on him. A
 * quarterback who had already played was recommended as a starter. A headline total said "89.9
 * projected" when 35.0 of it had been scored the night before.
 *
 * Four cells were then filled by hand. This module exists because filling cells by hand is what
 * produced a 2-of-10 table in the first place.
 *
 * THE MECHANISM IS THE POINT. `availability?: AvailabilityMap` on a per-verb options bag is WHY it
 * could be forgotten: a verb that never mentions it compiles, runs, and returns a confident answer.
 * Here it is a required field on the context every verb already takes, so omission is not
 * expressible. The per-verb option survives ONLY as an override, used by the tests to fault-inject;
 * the default is the context, so a new verb gets the real week state whether or not its author
 * thought about it.
 *
 * WHAT IS DELIBERATELY NOT HERE. The simulator's fitted availability RATES (`variance-model.json`,
 * "an RB misses 18% of weeks") are different information from a known designation ("he is Out"), and
 * unifying the two would be a model change wearing a refactor's clothes. That seam is designed in
 * `docs/week-state-design-2026-09-18.md` section 4 and is gated by the championship backtest.
 */
import { lockedNflTeams, finishedNflTeams, settledPointsFor, weekKickoffTimes } from "./kickoffLock.js";
import { normalizeStatus, unknownStatusesSeen, type AvailabilityMap } from "./availability.js";
import { nameKey } from "../draft/values.js";
import { feedStatus } from "../data/feeds.js";
import type { DB } from "../db/db.js";

/** One NFL team's game, as this week's state sees it. */
export interface WeekState {
  season: number;
  week: number;
  /** Who cannot play, by `nameKey`. Empty is a legitimate answer; `feeds` says whether it is empty
   *  because nobody is hurt or because nothing was read. */
  availability: AvailabilityMap;
  /** NFL teams whose game has kicked off. A rostered man on one of them cannot be moved. */
  locked: Set<string>;
  /** NFL teams whose game is OVER, split by HOW we know -- a stored final score, or four hours
   *  elapsed with no score ingested. Kept apart because they are different claims. */
  finished: { byScore: Set<string>; byElapsed: Set<string> };
  /** What a man on a FINISHED team actually scored, by `player_id`, under this league's scoring. */
  settledPoints: Map<string, number>;
  /** How many NFL teams are scheduled this week. Beside `locked.size`, this is what tells "nobody
   *  has kicked off yet" apart from "the store has no schedule" -- two states that otherwise print
   *  identically as zero. */
  scheduledTeams: number;
  /** Availability statuses this assembly could not recognise. Non-empty means somebody's feed has a
   *  spelling we do not know and those men were defaulted to startable -- the exact failure that
   *  made every `Injured Reserve` man look healthy for the whole of 2026. */
  unknownStatuses: string[];
  /** One line per source, for the caveat: what was read and how much of it there was. */
  sources: { id: string; rows: number; asOf: string | null }[];
  /** HOW OLD EVERY REGISTERED FEED IS (src/data/feeds.ts), dated once here and carried onto every
   *  verb's assumptions. Commit 2 of the week-state design: freshness reached 0 of 10 verbs because
   *  each would have had to ask for it, and none did. */
  feeds: import("../data/feeds.js").FeedStatus[];
}

/**
 * THE EXPLICIT OPT-OUT, and the reason it is a named function rather than an optional field.
 *
 * A historical replay, a backtest fold and a hand-built fixture genuinely have no live week state --
 * asking a 2019 week which NFL teams have kicked off is not a question. They say so by calling this,
 * which is greppable and self-documenting, instead of by omitting an argument, which is not.
 */
export function emptyWeekState(season: number, week: number): WeekState {
  return {
    season, week,
    availability: new Map(),
    locked: new Set(),
    finished: { byScore: new Set(), byElapsed: new Set() },
    settledPoints: new Map(),
    scheduledTeams: 0,
    unknownStatuses: [],
    sources: [],
    feeds: [],
  };
}

/** `player_status` + escalating news + ESPN's game-day designations, by `nameKey`. Escalation only:
 *  a later source can rule a man OUT, never clear one who already is. */
function buildAvailability(db: DB): { map: AvailabilityMap; sources: WeekState["sources"] } {
  const map: AvailabilityMap = new Map();
  const sources: WeekState["sources"] = [];
  const count = (id: string, rows: number, asOf: string | null) => sources.push({ id, rows, asOf });

  const ps = db.prepare(
    "SELECT player_id, injury_status, injury_body, updated_at FROM player_status WHERE injury_status IS NOT NULL",
  ).all() as { player_id: string; injury_status: string; injury_body: string | null; updated_at: string | null }[];
  for (const r of ps) {
    const status = normalizeStatus(r.injury_status);
    if (status === "ACTIVE") continue;
    map.set(r.player_id, { status, source: "player_status", detail: r.injury_body ?? r.injury_status });
  }
  count("player_status", ps.length, ps[0]?.updated_at ?? null);

  const news = db.prepare(
    "SELECT player_id, player_name, severity, detail, asof FROM news WHERE category='injury'",
  ).all() as { player_id: string | null; player_name: string; severity: string; detail: string; asof: string }[];
  for (const r of news) {
    if (String(r.severity).toLowerCase() !== "high") continue;
    const k = r.player_id ?? nameKey(r.player_name);
    if (!k || map.get(k)?.status === "OUT") continue;
    map.set(k, { status: "OUT", source: "news(injury/high)", detail: String(r.detail ?? "").slice(0, 120) });
  }
  count("news", news.length, news.reduce<string | null>((a, r) => (a == null || r.asof > a ? r.asof : a), null));

  const gd = db.prepare(
    `SELECT name, status, as_of FROM raw_gameday_status
      WHERE (season, week) = (SELECT season, week FROM raw_gameday_status ORDER BY season DESC, week DESC LIMIT 1)
        AND name IS NOT NULL AND status IS NOT NULL`,
  ).all() as { name: string; status: string; as_of: string | null }[];
  for (const r of gd) {
    if (normalizeStatus(r.status) !== "OUT") continue;
    const k = nameKey(r.name);
    if (!k || map.get(k)?.status === "OUT") continue;
    map.set(k, { status: "OUT", source: "gameday(espn)", detail: `ESPN game-day ${r.status}` });
  }
  count("gameday-status", gd.length, gd.reduce<string | null>((a, r) => (a == null || (r.as_of ?? "") > a ? r.as_of : a), null));

  return { map, sources };
}

/**
 * Assemble the week's state from the store. ONE read per source, ONE place that decides what "this
 * week" means, and every source counted so an empty result can be told apart from an unread one.
 *
 * `now` is injected rather than read from the clock inside the verbs, so a recommendation is
 * reproducible: the same store and the same instant give the same answer.
 */
export function loadWeekState(
  db: DB, opts: { season: number; week: number; leagueId?: string | null; now?: Date },
): WeekState {
  const { season, week } = opts;
  const now = opts.now ?? new Date();
  unknownStatusesSeen.clear();

  const { map, sources } = buildAvailability(db);
  const locked = lockedNflTeams(db, season, week, now);
  const finished = finishedNflTeams(db, season, week, now);
  const scheduledTeams = weekKickoffTimes(db, season, week).size;
  const settledPoints = opts.leagueId ? settledPointsFor(db, String(opts.leagueId), season, week) : new Map<string, number>();

  return {
    season, week,
    availability: map,
    locked,
    finished,
    settledPoints,
    scheduledTeams,
    unknownStatuses: [...unknownStatusesSeen.keys()],
    sources,
    feeds: feedStatus(db, now),
  };
}

/** Every NFL team whose game is over, however we know. The verbs want the union; the split stays
 *  available on `finished` for the caveat, which must be able to say which claim it is making. */
export const finishedTeams = (w: WeekState): Set<string> =>
  new Set([...w.finished.byScore, ...w.finished.byElapsed]);

/** Is this man ruled out this week? The one predicate every verb uses, so "OUT" cannot come to mean
 *  two different things in two files. */
export const cannotPlay = (w: WeekState, name: string): boolean =>
  w.availability.get(nameKey(name))?.status === "OUT";
