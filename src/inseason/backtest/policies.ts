/**
 * IN-SEASON DECISION POLICIES, as RosterPolicy objects the harness (harness.ts) can A/B.
 *
 * A policy is a pure function of the point-in-time DecisionState to the roster it leaves you holding.
 * Adding a new decision rule -- a different way to choose a drop, a stream target, a lineup -- is a
 * new object here; the harness and the scorers do not change. The DROP family is implemented first
 * because it is what motivated the harness; the shape is deliberately general so waiver/stream/trade
 * policies slot in beside it.
 */
import { optimalLineup } from "../lineup.js";
import type { DecisionMember, DecisionState, RosterPolicy } from "./harness.js";

const without = (state: DecisionState, playerSk: string): DecisionMember[] =>
  state.roster.filter((m) => m.playerSk !== playerSk);

const startersNeeded = (template: string[]): number => template.filter((s) => s !== "BE" && s !== "BENCH").length;

/** Can this set of players still field the whole starting template (roster-construction legality,
 *  independent of this week's byes/injuries -- everyone marked available for the check)?
 *
 *  optimalLineup returns EVERY slot, including empties it could not fill (a "(empty)" placeholder
 *  plus a "no available player to fill <slot>" flag), so legality is FILLED slots, not slot count --
 *  the trap that let a policy "drop" the only kicker. */
function canFill(members: DecisionMember[], template: string[], flexOk: Set<string>): boolean {
  const res = optimalLineup(members.map((m) => ({ name: m.name, pos: m.pos, proj: 1, available: true })), template, flexOk);
  const filled = res.starters.filter((s) => s.name && s.name !== "(empty)").length;
  return filled >= startersNeeded(template);
}

/** Drops that leave a roster that can still fill the template. */
function legalDrops(state: DecisionState): DecisionMember[] {
  return state.roster.filter((m) => canFill(without(state, m.playerSk), state.template, state.flexOk));
}

/** Backups at a position = rostered there minus its dedicated starting slots. */
function backupsAt(members: DecisionMember[], pos: string, template: string[]): number {
  return members.filter((m) => m.pos === pos).length - template.filter((s) => s === pos).length;
}

const byProjAsc = (a: DecisionMember, b: DecisionMember) => a.proj - b.proj || a.playerSk.localeCompare(b.playerSk);

/** VALUE-MIN: drop the lowest-projected legal body. What the live stream helper does today. */
export const valueMinDrop: RosterPolicy = {
  name: "value-min drop",
  apply(state) {
    const legal = legalDrops(state);
    if (!legal.length) return { roster: state.roster };
    return { roster: without(state, [...legal].sort(byProjAsc)[0].playerSk) };
  },
};

/** DEPTH-AWARE: drop the lowest-projected legal body that does NOT cut the last backup at a protected
 *  position; fall back to value-min when no such drop exists. `meta.protectedPos` names the position
 *  of the backup it kept when it diverged from value-min, for per-position attribution. */
export function depthAwareDrop(protectedPositions: Set<string>): RosterPolicy {
  return {
    name: `depth-aware {${[...protectedPositions].join(",")}}`,
    apply(state) {
      const legal = legalDrops(state);
      if (!legal.length) return { roster: state.roster };
      const asc = [...legal].sort(byProjAsc);
      const vm = asc[0];
      const depthSafe = asc.filter((m) => !protectedPositions.has(m.pos) || backupsAt(state.roster, m.pos, state.template) - 1 >= 1);
      const drop = depthSafe.length ? depthSafe[0] : vm;
      return { roster: without(state, drop.playerSk), meta: drop.playerSk !== vm.playerSk ? { protectedPos: vm.pos } : undefined };
    },
  };
}

/** POSITIVE CONTROL: drop the HIGHEST-projected legal body. Must score far worse than value-min, or
 *  the harness is not measuring realized value at all. */
export const dropBest: RosterPolicy = {
  name: "drop-best (control)",
  apply(state) {
    const legal = legalDrops(state);
    if (!legal.length) return { roster: state.roster };
    return { roster: without(state, [...legal].sort((a, b) => -byProjAsc(a, b))[0].playerSk) };
  },
};

/** States with a real drop choice: a bench body beyond the starters. */
export const hasRealDrop = (state: DecisionState): boolean => state.roster.length >= startersNeeded(state.template) + 1;
