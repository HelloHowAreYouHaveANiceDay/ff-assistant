// THE canonical ESPN id -> name/position maps, in ONE place.
//
// These were duplicated across src/league/espn.ts and src/data/eligibility.ts and had already
// DRIFTED -- the espn.ts copy of the slot-name map was missing TQB(1), P(18), HC(19), ER(24) and
// every IDP slot (8-15) that the eligibility.ts copy carried, which is exactly the "fixed one caller,
// not the other" trap. A leaf module with NO imports, so importing it can never create a cycle.

/** ESPN defaultPositionId -> our position vocabulary. */
export const ESPN_POS: Record<number, string> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };

/** lineupSlotId -> slot NAME. Kept COMPLETE so an unknown id is visibly unknown rather than silently
 *  absent. 23 is FLEX, NOT IR (IR is 21) -- getting that backwards would hide the FLEX slots the whole
 *  value curve is built on. */
export const ESPN_SLOT_NAME: Record<number, string> = {
  0: "QB", 1: "TQB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP",
  8: "DT", 9: "DE", 10: "LB", 11: "DL", 12: "CB", 13: "S", 14: "DB", 15: "DP",
  16: "DST", 17: "K", 18: "P", 19: "HC", 20: "BE", 21: "IR", 23: "FLEX", 24: "ER",
  // 25 appears on some of the 2026 pool and ESPN publishes no name for it in any documentation this
  // repo has found. Recorded as unknown rather than guessed, and absent from DEDICATED_SLOT_POS below
  // so it contributes no position either way.
  25: "?25",
};

/** The ONLY slot ids that name a single position in our vocabulary, and the fallback when a drafted
 *  player is missing from the public pool. A combo slot (3, 5, 7, 23) is eligibility at a SET and is
 *  deliberately absent: treating it as a position would mark every receiver in football RB-eligible. */
export const DEDICATED_SLOT_POS: Record<number, string> = {
  0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "DST", 17: "K",
};
