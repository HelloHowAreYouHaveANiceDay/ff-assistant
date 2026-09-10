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

/** STAND PAT: hold the roster. The waiver baseline. */
export const standPat: RosterPolicy = { name: "stand pat", apply(state) { return { roster: state.roster }; } };

/** FORM-AWARE ADD: claim the free agent with the best RECENT FORM (trailing-4 points), dropping via
 *  `drop`, when he is hotter than the man dropped. The preseason-anchored projection over-rates the
 *  bust-heavy FA pool and misses in-season breakouts; recent form is what a real waiver chases. */
export function addHottestFreeAgent(drop: RosterPolicy): RosterPolicy {
  const form = (m: DecisionMember) => m.form ?? 0;
  return {
    name: `add-form + ${drop.name}`,
    apply(state) {
      if (!state.freeAgents.length) return { roster: state.roster };
      const hottest = [...state.freeAgents].sort((a, b) => form(b) - form(a) || -byProjAsc(a, b))[0];
      const after = drop.apply(state).roster;
      if (after.length === state.roster.length) return { roster: state.roster };
      const dropped = state.roster.find((m) => !after.some((x) => x.playerSk === m.playerSk));
      if (dropped && form(hottest) <= form(dropped)) return { roster: state.roster }; // not hotter than our coldest
      return { roster: [...after, hottest], meta: { addedPos: hottest.pos } };
    },
  };
}

/** NEED-AWARE ADD: claim the free agent who most improves our projected OPTIMAL STARTING LINEUP
 *  (dropping via `drop`), and only when he improves it at all. Unlike add-best-FA, a redundant body
 *  -- a second QB behind your starter -- yields zero lineup gain and is skipped, so this claims a
 *  starter upgrade or nothing. Decision reads only point-in-time projections. */
export function addBestLineupUpgrade(drop: RosterPolicy): RosterPolicy {
  const rp = (m: DecisionMember) => ({ name: m.name, pos: m.pos, proj: m.proj, available: true });
  return {
    name: `add-need + ${drop.name}`,
    apply(state) {
      const after = drop.apply(state).roster;
      if (after.length === state.roster.length) return { roster: state.roster }; // no legal drop
      const base = optimalLineup(after.map(rp), state.template, state.flexOk).totalProj;
      let best: DecisionMember | null = null, bestGain = 0;
      for (const fa of state.freeAgents) {
        if (fa.proj <= bestGain) continue; // cannot beat the current best gain even as a pure add
        const gain = optimalLineup([...after, fa].map(rp), state.template, state.flexOk).totalProj - base;
        if (gain > bestGain) { bestGain = gain; best = fa; }
      }
      if (!best) return { roster: state.roster }; // nothing upgrades the lineup -> stand pat
      return { roster: [...after, best], meta: { addedPos: best.pos } };
    },
  };
}

/** ADD THE BEST FREE AGENT (dropping via `drop`), but only when he out-projects the man dropped --
 *  a rational manager does not claim a worse player. Tests whether one waiver claim is worth making;
 *  `meta.addedPos` tags the added position. */
export function addBestFreeAgent(drop: RosterPolicy): RosterPolicy {
  return {
    name: `add-best-FA + ${drop.name}`,
    apply(state) {
      if (!state.freeAgents.length) return { roster: state.roster };
      const bestFa = [...state.freeAgents].sort((a, b) => -byProjAsc(a, b))[0];
      const after = drop.apply(state).roster;
      if (after.length === state.roster.length) return { roster: state.roster }; // no legal drop
      const dropped = state.roster.find((m) => !after.some((x) => x.playerSk === m.playerSk));
      if (dropped && bestFa.proj <= dropped.proj) return { roster: state.roster }; // no improvement
      return { roster: [...after, bestFa], meta: { addedPos: bestFa.pos } };
    },
  };
}
