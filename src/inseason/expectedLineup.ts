/**
 * EXPECTED STARTING-LINEUP POINTS OVER A WINDOW OF WEEKS -- the quantity D42 ranks waiver claims on.
 *
 * ONE IMPLEMENTATION, called by the live verb (`waiverTargets`) AND by the waiver decision replay
 * (`scripts/lib/waiver-replay.mjs`), so the rule that was validated and the rule that is served
 * cannot drift apart. They had: the replay's copy never learned the like-for-like swap, the
 * Questionable rate or the kickoff lock.
 *
 * Two optional refinements, both OFF unless asked for (absent = the D42 arithmetic exactly):
 *
 *  `availByPos` -- FUTURE-WEEK INJURIES. D42 counted only byes after this week, so a bench body was
 *   worth exactly zero unless a bye stacked on his position: Michael Pittman Jr. started 0 of 11
 *   weeks for league 462233 and "drop him for a second kicker" read +10.9. With this, each future
 *   week a man plays with his position's healthy rate `a`, and when he plays he scores `rate / a` --
 *   so his OWN expectation is unchanged (the rest-of-season rate already counts missed games as
 *   zeros), and the only thing that moves is what the lineup does when a starter misses: the bench
 *   covers it. Expectation over `draws` common-random-number draws keyed on (seed, draw, week, name),
 *   so a base roster and a candidate roster see the SAME injuries for every man they share.
 *
 *  `replacement` -- STREAMING. A slot the roster cannot fill in a given week scores the position's
 *   replacement level (the free agent a manager adds that week, `simContext`'s streaming floor)
 *   instead of zero -- the same rule `season.ts` `emptySlotPoints` applies. Without it a second kicker
 *   "covers" our kicker's bye for the whole of a kicker's points, when the real alternative is to
 *   add one that Tuesday.
 *
 * THIS WEEK is never drawn: it is the known week. A man's `playRate` (OUT 0, Questionable 0.645) and
 * `locked` (a free agent whose game has kicked off) apply to `firstWk` only, exactly as before.
 */
import { optimalLineup } from "./lineup.js";
import { slotAdmits } from "../draft/slots.js";
import { draw, nameKey32 } from "../draft/rng.js";
import { streamCandidates } from "../draft/season.js";

export interface ExpLineupPlayer {
  name: string;
  pos: string;
  /** Rest-of-season expected points per SCHEDULED week (missed games counted as zeros). */
  rate: number;
  bye?: number | null;
  eligible?: string[];
  /** THIS week only: chance he plays (1 when absent). */
  playRate?: number;
  /** THIS week only: he cannot enter our lineup (a free agent already kicked off). */
  locked?: boolean;
}

export interface ExpLineupOpts {
  slots: string[];
  flexOk?: string[];
  /** Inclusive week window. */
  from: number;
  to: number;
  /** The current (known) week -- statuses and locks apply to it; it is never drawn. */
  firstWk: number;
  /** Per-position probability a man plays in a FUTURE week (bye excluded). Absent = D42 (no draws). */
  availByPos?: Record<string, number>;
  /** Per-position weekly points for a slot the roster cannot fill. Absent = an empty slot scores 0. */
  replacement?: Record<string, number>;
  draws?: number;
  seed?: number;
}

/** 0x5A1D: a purpose no simulator stream uses, so these draws never alias a season trial's. */
const PURPOSE_EXP_AVAIL = 0x5a1d;

const emptyFill = (slot: string, o: ExpLineupOpts): number => {
  const rep = o.replacement;
  if (!rep) return 0;
  const elig = slotAdmits(slot, o.flexOk ?? ["RB", "WR", "TE"]);
  return Math.max(0, ...elig.map((p) => rep[p] ?? 0));
};

function weekTotal(players: { name: string; pos: string; proj: number; available: boolean; eligible?: string[] }[], o: ExpLineupOpts): number {
  // STREAMING OVER A STARTER (2026-10-02), the same rule as `SeasonOpts.streamOverStarters`: a slot
  // takes the replacement-level free agent whenever he beats the roster, not only when it is empty.
  // Before, dropping a sub-replacement man forced to start in a bye week "gained" the whole floor.
  const streams = o.replacement && process.env.FF_STREAM_OVER_STARTERS !== "off"
    ? streamCandidates(o.slots, o.flexOk, o.replacement).map((v) => ({ ...v, available: true }))
    : [];
  const lu = optimalLineup(streams.length ? [...players, ...streams] : players, o.slots, o.flexOk);
  let t = lu.totalProj;
  if (o.replacement) for (const s of lu.starters) if (s.name === "(empty)") t += emptyFill(s.slot, o);
  return t;
}

export function expectedLineupPoints(roster: ExpLineupPlayer[], o: ExpLineupOpts): number {
  const nDraws = Math.max(1, o.draws ?? 64);
  const seed = o.seed ?? 1;
  const ids = roster.map((p) => nameKey32(p.name));
  let tot = 0;
  for (let w = o.from; w <= o.to; w++) {
    if (w === o.firstWk || !o.availByPos) {
      const known = w === o.firstWk;
      tot += weekTotal(roster.map((p) => {
        const pr = known ? (p.playRate ?? 1) : 1;
        return {
          name: p.name, pos: p.pos, proj: p.rate * pr,
          available: p.bye !== w && !(known && (pr === 0 || p.locked)),
          ...(p.eligible ? { eligible: p.eligible } : {}),
        };
      }), o);
      continue;
    }
    let acc = 0;
    for (let d = 0; d < nDraws; d++) {
      acc += weekTotal(roster.map((p, i) => {
        const a = Math.min(1, Math.max(0.05, o.availByPos![p.pos] ?? 1));
        const plays = p.bye !== w && draw(seed, d, w, ids[i], PURPOSE_EXP_AVAIL) < a;
        return { name: p.name, pos: p.pos, proj: p.rate / a, available: plays, ...(p.eligible ? { eligible: p.eligible } : {}) };
      }), o);
    }
    tot += acc / nDraws;
  }
  return tot;
}

/**
 * The healthy rate per position for a FUTURE week, from the variance model's tier-0 availability
 * (games/17, which includes the bye -- divided back out exactly as `season.ts` does). Tier 0 because
 * the lower tiers' availability is mostly NOT PLAYING (a backup's zeros), which the rate already
 * carries; what the lineup needs to cover is a starter's injury.
 */
export function availByPosFrom(vm: { pos: Record<string, { avail: number[] }> }): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [pos, m] of Object.entries(vm.pos)) out[pos] = Math.min(1, (m.avail?.[0] ?? 0.85) / (16 / 17));
  return out;
}
