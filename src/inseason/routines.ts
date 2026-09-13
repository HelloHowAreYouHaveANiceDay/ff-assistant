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
}

/**
 * THE REGISTRY. Ordered as they should run: pull results, score the card, recompute recommendations,
 * then the app-only league state. `actuals` already refreshes the decision snapshot on a real change
 * (see sync-actuals), so `decisions` is the way to recompute WITHOUT new actuals -- e.g. after a
 * roster or odds move -- not a duplicate of it.
 */
export const ROUTINES: Record<string, Routine> = {
  actuals: {
    name: "actuals",
    what: "ingest nflverse results, rebuild the forward board (trailing form), refresh decisions on a change",
    steps: [["sync-actuals", []]],
    needsApp: false,
  },
  scorecard: {
    name: "scorecard",
    what: "freeze the imminent week's weekly predictions and score any settled week",
    steps: [["scorecard", ["--no-forward", "--no-odds"]]],
    needsApp: false,
  },
  decisions: {
    name: "decisions",
    what: "recompute and store the waiver / trade / odds recommendations (decision_snapshot)",
    steps: [["refresh-decisions", ["--schedule", "auto"]]],
    needsApp: false,
  },
  roster: {
    name: "roster",
    what: "pull the league's roster + transaction + pending-trade state (needs the app's ESPN session)",
    steps: [["sync-league", ["--tier", "fast"]]],
    needsApp: true,
  },
};

/** What the app schedules by default in-season: everything self-contained, on one cadence. `roster`
 *  is left off the default because it needs the app bridge and moves slower; the copilot can add it. */
export const DEFAULT_ROUTINES = ["actuals", "scorecard", "decisions"];

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

/** The stored schedule, merged over defaults so a partial or absent row is always a complete config. */
export function getSchedule(db: DB): ScheduleConfig {
  const raw = getSetting(db, SCHEDULE_KEY);
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
export function setSchedule(db: DB, patch: Partial<ScheduleConfig>): { config: ScheduleConfig; droppedRoutines: string[] } {
  const cur = getSchedule(db);
  const wantRoutines = patch.routines ?? cur.routines;
  const dropped = wantRoutines.filter((r) => !(r in ROUTINES));
  const routines = wantRoutines.filter((r) => r in ROUTINES);
  const next: ScheduleConfig = {
    enabled: patch.enabled ?? cur.enabled,
    everyMinutes: clampMinutes(patch.everyMinutes ?? cur.everyMinutes),
    routines,
  };
  setSetting(db, SCHEDULE_KEY, JSON.stringify(next));
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

export function withDb<T>(dbPath: string | undefined, fn: (db: DB) => T): T {
  const db = openDb(dbPath);
  try { return fn(db); } finally { db.close(); }
}
