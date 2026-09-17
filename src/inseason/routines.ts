// THE IN-SEASON SCHEDULER'S UNIT OF WORK. A "routine" is a named sequence of `ff` verbs the app (or a
// poller) runs on a cadence. Keeping the registry here, in the engine, rather than as a list of
// commands hardcoded in the Electron main process means the app and the CLI and the copilot all agree
// on what "the actuals routine" IS -- and adding one is an engine change with a test, not an edit to
// three call sites. The schedule (which routines are on, how often) is a stored config the copilot
// writes and the app reads, so "the copilot sets the routines" is a data change, not a code change.
import { openDb, getSetting, setSetting, type DB } from "../db/db.js";

export interface Routine {
  name: string;
  what: string;
  /** Each step is one `ff` verb plus its args, run as its own process (a step's crash is one step). */
  steps: [string, string[]][];
  /** True if the routine needs the desktop app's ESPN webview (the app bridge); false = self-contained
   *  (nflverse / local sim), so a headless poller can run it. */
  needsApp: boolean;
  /**
   * WHICH PLATFORMS THIS ROUTINE'S STEPS HAVE AN ADAPTOR FOR (I-7 / P-1).
   *
   * `null` = platform-neutral (nflverse results, the local simulator, the scorecard -- none of them
   * touch a fantasy provider). A list = the steps are provider-specific, and a league on any other
   * platform is SKIPPED BY NAME rather than run against an adaptor that does not exist. `sync-league`
   * builds ESPN URLs, so `roster` is `["espn"]` and a Yahoo league is told so.
   */
  platforms: string[] | null;
  /**
   * DOES EVERY STEP ACCEPT `--league <id>`?
   *
   * `true` for all four as of WP13, and that is a statement about `src/ff.ts`, not about the routine.
   * It was `false` because `sync-actuals`, `scorecard`, `refresh-decisions` and `sync-league` all
   * resolved the ACTIVE league and took no flag, so appending one would have been SILENTLY IGNORED --
   * the routine would look per-league while running the active league's work N times, which is the
   * exact failure shape this pass exists to remove. All four now READ the flag (`sync-league` forwards
   * every flag but its own `--tier` to each step), so `planRoutines` appends `--league <id>` and runs
   * the set for every synced league.
   *
   * THE FLAG IS NOT THE ONLY GATE, and `platforms` is still the other one: `roster` remains
   * `["espn"]`, so the Yahoo league is skipped BY NAME there rather than run against an ESPN-only
   * step list. A routine is run for a league only when BOTH are satisfied.
   */
  leagueScoped: boolean;
}

/**
 * THE REGISTRY. Ordered as they should run: pull results, score the card, recompute recommendations,
 * then the app-only league state. `actuals` already refreshes the decision snapshot on a real change
 * (see sync-actuals), so `decisions` is the way to recompute WITHOUT new actuals -- e.g. after a
 * roster or odds move -- not a duplicate of it.
 */
export const ROUTINES: Record<string, Routine> = {
  /**
   * THE WEEKLY EXPERT CONSENSUS, PULLED BEFORE THE WEEK IS BUILT (M2b, 2026-09-16).
   *
   * THE VERB IS `ingest-source`, NOT `ingest-raw`, and that is not interchangeable: `weekly` is an
   * L1 asset (it feeds the board), and `cmdIngestRaw` REFUSES any id outside `RAW_ASSETS` with
   * `exit 2`. A routine naming the wrong one would have failed every tick, loudly but off-screen.
   * `test/routines.test.ts` catches the other half -- a verb the tick has no handler for is SKIPPED
   * SILENTLY -- which is how this was found, so `ingest-source` is in the tick's HANDLERS map too.
   *
   * IT IS FIRST IN THE REGISTRY AND THAT ORDER IS LOAD-BEARING. `ff ingest-source weekly` refreshes
   * `weekly_rank` AND appends the scrape into `ranking_history` (src/data/advanced.ts), but it does
   * NOT rebuild `feat_player_week_model`. `actuals` does, through `buildForwardInto`, which is what
   * reads the archive and fills `ecr_wk_rank`/`ecr_wk_sd`; and `scorecard` then FREEZES the week's
   * predictions off those rows, write-once. Run in the other order the column a prediction was
   * frozen on is a week old, and nothing in the frozen row says so.
   *
   * CADENCE. This is on the DEFAULT set, which the app's timer runs every `everyMinutes` (clamped
   * to [5, 720]) whenever the schedule is enabled -- so on any live cadence it lands many times
   * between Thursday and Sunday's first kickoff, which is the window the point-in-time rule needs
   * (the feed is published on Fridays; the column's anchor is each team's kickoff minus two days).
   * The repeat cost is one ~300KB CSV and an `INSERT OR IGNORE`: re-ingesting a scrape already held
   * writes nothing, by construction, so over-running is a no-op rather than a corruption. A SINGLE
   * weekly run would be the fragile design -- one missed Friday and the week has no consensus at
   * all, with no second chance before kickoff.
   *
   * NOT `leagueScoped`: the feed is FantasyPros' league-independent positional consensus, one copy
   * per store. Marking it league-scoped would fetch and re-append the identical rows once per
   * league, which the ignore-on-conflict makes harmless and pointless.
   */
  rankings: {
    name: "rankings",
    what: "refresh the FantasyPros weekly consensus and RETAIN the scrape point-in-time (ranking_history)",
    steps: [["ingest-source", ["weekly"]]],
    needsApp: false,
    platforms: null,          // a public CSV -- no fantasy provider involved
    leagueScoped: false,
  },
  /**
   * THE LIVE SEASON'S USAGE FEEDS RIDE THIS ROUTINE (WP17), and that is deliberate rather than a
   * missing routine of its own.
   *
   * `buildForwardBoardInto` now refreshes the current season's nflverse snap counts and rebuilds the
   * live week's availability block as part of the board rebuild. It could not be a routine here: the
   * tick can only run verbs `HANDLERS` in src/ff.ts holds, and neither `ingest-raw` nor
   * `build-live-context` is one -- a routine naming either would sit in the schedule looking enabled
   * and be SKIPPED SILENTLY, which is the same class of failure `test/routines.test.ts` exists for.
   * The board rebuild is also the step that has just created the universe the live context builder
   * reads, so it is the only seam where the two can meet in the right order.
   *
   * What that buys, measured: seven served weekly features were 100% NULL at the 2026 week-2 serve
   * while prior seasons carried 78-93% at the same week, worth -0.71 points per lineup per week
   * (docs/weekly-missingness-ablation-2026-09-16.md). Six of the seven now land on this routine's
   * ordinary tick; the seventh (`prior_route_share`) cannot -- nflverse stopped publishing
   * `pbp_participation` after 2025 -- and the lineup caveat names it instead.
   */
  actuals: {
    name: "actuals",
    what: "ingest nflverse results + the live season's snap counts, rebuild the forward board (trailing form, usage-to-date) and the live week's availability block, refresh decisions on a change",
    steps: [["sync-actuals", []]],
    needsApp: false,
    platforms: null,          // nflverse results -- no fantasy provider involved
    leagueScoped: true,
  },
  scorecard: {
    name: "scorecard",
    what: "freeze the imminent week's weekly predictions and score any settled week",
    steps: [["scorecard", ["--no-forward", "--no-odds"]]],
    needsApp: false,
    platforms: null,
    leagueScoped: true,
  },
  /**
   * THE SUNDAY RE-READ (M2c, 2026-09-16) -- the availability information gap, closed as a routine.
   *
   * WHY IT IS ON THE DEFAULT SET AND WHY THAT IS SAFE. `scripts/availability-gap.mjs` measures the
   * gap it closes: the largest recoverable class of zero-scoring starts in our lineup is the
   * GAME-DAY INACTIVE, and the only thing that catches one is reading the inactive list on Sunday
   * morning. A routine that fires only when a human remembers is a routine that does not fire, and
   * the whole point is that the window is 90 minutes wide, twice a week, at a time nobody is at a
   * terminal. So it rides the ordinary tick.
   *
   * IT IS SAFE TO RUN EVERY TICK BECAUSE THE WINDOW IS A REFUSAL, NOT A PREFERENCE. `ff
   * sunday-refresh` resolves the window BEFORE it touches the feed: outside it, nothing is fetched
   * and nothing is written, and it says which windows it was outside of. Inside it, the freeze is
   * `INSERT OR IGNORE` under `weekly_sunday`, so the second tick of the same window is a no-op
   * rather than a rewrite. Over-running is therefore a no-op by construction, exactly as `rankings`
   * is, and a SINGLE scheduled Sunday run would be the fragile design -- one missed tick and the
   * week has no second read at all, with no second chance before kickoff.
   *
   * IT MUST RUN AFTER `scorecard`, and the registry order is what guarantees that. The Sunday kind
   * is a re-read OF the frozen Friday rows -- it copies their values and zeroes the men the game-day
   * feed rules out -- so a week whose `weekly` rows were never frozen has nothing to re-read against
   * and the freeze refuses by name.
   *
   * `leagueScoped` because the rows are stamped with a format key and the lineup swap is computed on
   * one league's roster; `platforms: null` because the feed itself is ESPN's PUBLIC, keyless NFL
   * scoreboard -- an NFL fact, not a fantasy-provider one -- so a Yahoo league re-reads the same
   * inactive list against its own frozen rows.
   */
  sunday: {
    name: "sunday",
    what: "re-read the game-day inactive list inside its window and FREEZE the Sunday lineup (kind weekly_sunday)",
    steps: [["sunday-refresh", []]],
    needsApp: false,          // site.api.espn.com is public and keyless; no ESPN session involved
    platforms: null,
    leagueScoped: true,
  },
  decisions: {
    name: "decisions",
    what: "recompute and store the waiver / trade / odds recommendations (decision_snapshot)",
    steps: [["refresh-decisions", ["--schedule", "auto"]]],
    needsApp: false,
    platforms: null,
    leagueScoped: true,
  },
  roster: {
    name: "roster",
    what: "pull the league's roster + transaction + pending-trade state (needs the app's ESPN session)",
    steps: [["sync-league", ["--tier", "fast"]]],
    needsApp: true,
    platforms: ["espn"],      // cmdSyncLeague builds ESPN URLs; there is no yahoo syncRosters wiring yet
    leagueScoped: true,
  },
};

/** What the app schedules by default in-season: everything self-contained, on one cadence. `roster`
 *  is left off the default because it needs the app bridge and moves slower; the copilot can add it. */
export const DEFAULT_ROUTINES = ["rankings", "actuals", "scorecard", "sunday", "decisions"];

export interface ScheduleConfig {
  /** The master switch. Off means the app runs no routines on a timer. */
  enabled: boolean;
  /** How often the app runs the routine set, in minutes. Clamped to [5, 720] by the app. */
  everyMinutes: number;
  /** Which routines run, in registry order. Unknown names are ignored (and reported). */
  routines: string[];
}

export const DEFAULT_SCHEDULE: ScheduleConfig = { enabled: false, everyMinutes: 15, routines: DEFAULT_ROUTINES };
const SCHEDULE_KEY = "scheduler";

/**
 * THE SCHEDULE IS PER LEAGUE, with the old single-slot row as the shared default (I-7 / S-13).
 *
 * `settings.scheduler` was ONE global row for a store that now holds two leagues, so turning the
 * timer on for a Yahoo league turned it on for the ESPN one too. `scheduler:<leagueId>` is read when
 * a league is named and it EXISTS; otherwise the global row is used unchanged, which is what keeps
 * every existing caller (the app timer, `ff schedule`) byte-identical on a one-league store.
 */
const scheduleKey = (leagueId?: string | null): string =>
  leagueId ? `${SCHEDULE_KEY}:${leagueId}` : SCHEDULE_KEY;

/** The stored schedule, merged over defaults so a partial or absent row is always a complete config.
 *  `leagueId` omitted (or naming a league with no row of its own) reads the shared global row. */
export function getSchedule(db: DB, leagueId?: string | null): ScheduleConfig {
  const raw = (leagueId ? getSetting(db, scheduleKey(leagueId)) : undefined) ?? getSetting(db, SCHEDULE_KEY);
  if (!raw) return { ...DEFAULT_SCHEDULE };
  try {
    const p = JSON.parse(raw) as Partial<ScheduleConfig>;
    return {
      enabled: typeof p.enabled === "boolean" ? p.enabled : DEFAULT_SCHEDULE.enabled,
      everyMinutes: Number.isFinite(p.everyMinutes) ? Number(p.everyMinutes) : DEFAULT_SCHEDULE.everyMinutes,
      routines: Array.isArray(p.routines) ? p.routines.filter((r) => typeof r === "string") : DEFAULT_SCHEDULE.routines,
    };
  } catch { return { ...DEFAULT_SCHEDULE }; }
}

/** Write a partial change over the stored schedule, validate it, and return the result. Unknown
 *  routine names are dropped here so a bad name can never reach the app's timer. */
export function setSchedule(db: DB, patch: Partial<ScheduleConfig>, leagueId?: string | null): { config: ScheduleConfig; droppedRoutines: string[] } {
  const cur = getSchedule(db, leagueId);
  const wantRoutines = patch.routines ?? cur.routines;
  const dropped = wantRoutines.filter((r) => !(r in ROUTINES));
  const routines = wantRoutines.filter((r) => r in ROUTINES);
  const next: ScheduleConfig = {
    enabled: patch.enabled ?? cur.enabled,
    everyMinutes: clampMinutes(patch.everyMinutes ?? cur.everyMinutes),
    routines,
  };
  setSetting(db, scheduleKey(leagueId), JSON.stringify(next));
  return { config: next, droppedRoutines: dropped };
}

export function clampMinutes(m: number): number {
  if (!Number.isFinite(m)) return DEFAULT_SCHEDULE.everyMinutes;
  return Math.max(5, Math.min(720, Math.round(m)));
}

/** Resolve the routine names to their ordered step list, skipping unknowns. Used by `ff inseason-tick`
 *  and by any caller that wants to know WHAT a routine set would run before running it. */
export function stepsFor(routineNames: string[]): { steps: [string, string[]][]; ran: string[]; unknown: string[] } {
  const unknown = routineNames.filter((r) => !(r in ROUTINES));
  const ran = Object.keys(ROUTINES).filter((r) => routineNames.includes(r)); // registry order, de-duped
  const steps = ran.flatMap((r) => ROUTINES[r].steps);
  return { steps, ran, unknown };
}

// ---------------------------------------------------------------------------------------------
// THE ROUTINE SET, PER LEAGUE (I-7)
// ---------------------------------------------------------------------------------------------

/** One league the routine set could be run for: a row with a seat we actually hold. */
export interface RoutineLeague { leagueId: string; platform: string | null; name: string | null }

/**
 * THE LEAGUES A ROUTINE SET APPLIES TO: every league row with a `team_id`.
 *
 * `team_id IS NULL` means the sync never identified our seat, so there is nothing in that league to
 * pull actuals for or set a lineup in; running routines against it would produce rows attributed to
 * a league we are not in. Ordered by id so a plan is deterministic and diffable.
 */
export function routineLeagues(db: DB): RoutineLeague[] {
  try {
    return (db.prepare(
      "SELECT league_id, platform, name FROM league WHERE team_id IS NOT NULL ORDER BY league_id",
    ).all() as { league_id: string; platform: string | null; name: string | null }[])
      .map((r) => ({ leagueId: String(r.league_id), platform: r.platform ?? null, name: r.name ?? null }));
  } catch { return []; }            // a fresh store, before the league table exists
}

/** One league's worth of work, and why a league/routine pair was left out. */
export interface RoutinePlan {
  runs: { leagueId: string; platform: string | null; routine: string; steps: [string, string[]][] }[];
  skipped: { leagueId: string; platform: string | null; routine: string; why: string }[];
  unknown: string[];
}

/**
 * WHAT THE ROUTINE SET WOULD RUN, PER LEAGUE, AND WHAT IT WOULD NOT -- with a reason for every miss.
 *
 * Three rules, and the third is the one that keeps this honest:
 *   1. A routine whose `platforms` list excludes the league's platform is SKIPPED BY NAME. `roster`
 *      runs `sync-league`, which builds ESPN URLs; pointing it at the Yahoo league would have pulled
 *      ESPN data and written it under the Yahoo league id (S-2), which is the failure this names.
 *   2. A league with an unknown/absent platform is skipped, naming the platform string it carries.
 *   3. A routine that is NOT `leagueScoped` can only be run for the ACTIVE league, because its verbs
 *      take no `--league` flag. It is NOT quietly run N times with an ignored flag: every other
 *      league is reported with the verb that would have to accept the flag first.
 */
export function planRoutines(db: DB, routineNames: string[], activeLeagueId: string | null): RoutinePlan {
  const unknown = routineNames.filter((r) => !(r in ROUTINES));
  const ran = Object.keys(ROUTINES).filter((r) => routineNames.includes(r));   // registry order, de-duped
  const leagues = routineLeagues(db);
  const plan: RoutinePlan = { runs: [], skipped: [], unknown };
  // No league rows at all: keep the pre-multi-league behaviour exactly -- run the set once, for
  // whatever the verbs resolve themselves. A fresh clone must not silently do nothing.
  if (!leagues.length) {
    for (const r of ran) plan.runs.push({ leagueId: activeLeagueId ?? "", platform: null, routine: r, steps: ROUTINES[r].steps });
    return plan;
  }
  for (const lg of leagues) {
    for (const r of ran) {
      const rt = ROUTINES[r];
      if (rt.platforms && !(lg.platform && rt.platforms.includes(lg.platform))) {
        plan.skipped.push({
          leagueId: lg.leagueId, platform: lg.platform, routine: r,
          why: `routine "${r}" has no ${lg.platform ?? "unknown-platform"} adaptor -- its step(s) ${rt.steps.map((s) => `\`${s[0]}\``).join(", ")} are ${rt.platforms.join("/")}-only`,
        });
        continue;
      }
      if (!rt.leagueScoped) {
        if (activeLeagueId != null && lg.leagueId === activeLeagueId) {
          plan.runs.push({ leagueId: lg.leagueId, platform: lg.platform, routine: r, steps: rt.steps });
        } else {
          plan.skipped.push({
            leagueId: lg.leagueId, platform: lg.platform, routine: r,
            why: `routine "${r}" is not league-scoped yet: ${rt.steps.map((s) => `\`ff ${s[0]}\``).join(", ")} take no --league flag, so they can only run for the ACTIVE league (${activeLeagueId ?? "none"})`,
          });
        }
        continue;
      }
      plan.runs.push({
        leagueId: lg.leagueId, platform: lg.platform, routine: r,
        steps: rt.steps.map(([verb, args]) => [verb, [...args, "--league", lg.leagueId]] as [string, string[]]),
      });
    }
  }
  return plan;
}

export function withDb<T>(dbPath: string | undefined, fn: (db: DB) => T): T {
  const db = openDb(dbPath);
  try { return fn(db); } finally { db.close(); }
}
