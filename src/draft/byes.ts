/**
 * ONE ANSWER TO "WHICH WEEK IS THIS MAN'S BYE" -- for a rostered man AND for a free agent.
 *
 * WHY THIS IS ITS OWN MODULE (2026-10-13). `loadSimContext` resolved byes with a closure (the
 * consensus ranking's bye by name, else the schedule's bye for his NFL team) and applied it to the
 * board and to every roster. It was never exported, so `streamRecommend` -- whose pool comes from the
 * weekly feature table, not the board -- could only look a bye up on OUR roster. Every free agent in
 * the stream pool therefore read `unavailable: null`, and in NFL week 6 of 2026 `ff stream --pos DST`
 * recommended adding DET D/ST (6.72 projected) while Detroit was on bye; MIA, CIN and MIN skill
 * players were listed as streamable the same way. The resolver now lives here, `loadSimContext`
 * builds the board and rosters through it, and it is carried on the context (`ctx.byeOf`) so a
 * consumer that prices a man who is NOT on the board asks the same function.
 *
 * Pure: no store, no clock. The store reads stay in `loadSimContext`.
 */
import { nameKey } from "./values.js";

/** Bye week for a man, from his name, his NFL team (UPPER abbrev, nflverse spelling) and position.
 *  Null when neither source knows -- never a guess. */
export type ByeResolver = (name: string, team: string | null | undefined, pos?: string) => number | null;

/**
 * Each NFL team's bye: the ONE regular-season week in which it has no game. A team with zero or
 * several missing weeks (a partial schedule) gets no entry rather than a wrong one.
 */
export function teamByesFromGames(games: { week: number; h: string; a: string }[]): Map<string, number> {
  const weeksOf = new Map<string, Set<number>>();
  for (const r of games) for (const t of [r.h, r.a]) { if (!weeksOf.has(t)) weeksOf.set(t, new Set()); weeksOf.get(t)!.add(r.week); }
  const all = new Set(games.map((r) => r.week));
  const out = new Map<string, number>();
  for (const [t, ws] of weeksOf) {
    const off = [...all].filter((w) => !ws.has(w));
    if (off.length === 1) out.set(t, off[0]);
  }
  return out;
}

/** "DET D/ST" -> "DET". A defence's team is its own name when nothing else carries it. */
export function dstTeamFromName(name: string): string {
  return name.match(/^([A-Z]{2,3})\s+D\/ST$/)?.[1] ?? "";
}

/**
 * The consensus ranking's bye by `nameKey` first (that is what the board has always used), else the
 * schedule's bye for his team; a defence with no team falls back to the team in its name.
 */
export function makeByeResolver(byName: Map<string, number>, teamBye: Map<string, number>): ByeResolver {
  return (name, team, pos) => {
    const named = byName.get(nameKey(name));
    if (named != null) return named;
    const t = team || (pos === "DST" ? dstTeamFromName(name) : "");
    return t ? teamBye.get(t) ?? null : null;
  };
}

/** A context with no schedule and no ranking (a fixture, a replay that opts out): nobody has a
 *  known bye beyond what a roster entry already carries. Named, so the opt-out is greppable. */
export const NO_BYES: ByeResolver = () => null;
