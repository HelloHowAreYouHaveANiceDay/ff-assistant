/**
 * THE ONE PLACE THAT KNOWS WHAT A ROSTER SLOT IS.
 *
 * WHAT THIS REPLACED (I-2 / I-3 of docs/architecture-review-2026-09-16.md). "Which players may fill
 * this slot?" and "is this slot a bench slot?" were each answered in four or five places, by hand:
 *
 *   FLEX ELIGIBILITY   lineup.ts:66      `slot === "FLEX" ? eligible ∩ flexOk : eligible.includes(slot)`
 *                      season.ts:365     `if (s === "FLEX") flexN++ else need[s]++`
 *                      season.ts:249     `if (slot === "FLEX") max over flexOk`
 *                      winprob.ts        through lineup.ts
 *                      lineupMarginal/rosterMarginal `FLEX_KEYS = {FLEX, OP, RB/WR, WR/TE}`
 *   BENCH              lineup.ts:62      `BE|BENCH`
 *                      winprob.ts:476    `BE|BENCH`
 *                      season.ts:362     `BE|BENCH|IR`
 *                      values.ts:154     `BE|BENCH|IR|ER`
 *                      lineupMarginal:100 / rosterMarginal:131  `BE|BENCH|IR|ER`
 *
 * Every one of those is a LITERAL, and a literal cannot see a token it was not typed with. A Yahoo
 * league's `SUPERFLEX` slot therefore matched nobody: the lineup optimizer silently scored it 0 (a
 * full-looking lineup missing its best quarterback) and `assertRostersCanFillLineup` refused every
 * Yahoo roster outright, so six in-season verbs threw. A `BN` bench slot, symmetrically, would have
 * become a phantom STARTING slot at a position called "BN" and moved every replacement level in the
 * league. Neither failure produces an error message; both produce a plausible number.
 *
 * So: one parser (`slotEligibility`), one bench test (`isBenchSlot`), one "what does this slot admit
 * here" (`slotAdmits`, which is `slotEligibility` plus the league's own `flex_ok` override on the
 * literal `FLEX` token, so the ESPN incumbent is byte-identical), and one starting-template filter
 * (`startingSlots`).
 *
 * `flex_ok` OVERRIDES ONLY THE LITERAL `FLEX`. That is deliberate and it is what keeps ESPN
 * unchanged: this league's stored `flex_ok` is `[RB,WR,TE]`, which is also what `slotEligibility`
 * returns for `FLEX`, so nothing moves -- but a league that had edited `flex_ok` keeps the edit. It
 * must NOT be applied to `SUPERFLEX`/`OP`/`Q/W/R/T`: `flex_ok` is a single league-wide list, so
 * applying it to a superflex slot would strip the QB back out and reinstate exactly the bug.
 *
 * Nothing here imports anything. That is on purpose -- it is imported by values.ts, season.ts,
 * lineup.ts, winprob.ts, lineupMarginal.ts and rosterMarginal.ts, and a cycle through any of them
 * would be a startup failure rather than a wrong number.
 */

// A slot token -> the position it admits. Q/W/R/T slash-forms (Yahoo) and W/R/T are parsed by these.
const SLOT_TOKEN: Record<string, string> = { Q: "QB", W: "WR", R: "RB", T: "TE", K: "K", D: "DST" };
const FULL_POS = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);

/**
 * BENCH-LIKE SLOTS: a slot that names no starting position.
 *
 * `BE`/`BENCH` (ESPN + our config vocabulary), `BN` (Yahoo's own token -- carried verbatim now that
 * this test is the only one), `IR` and `ER` (injured / injured-reserve variants). Yahoo 129048 has
 * TWO `IR` slots, and the whole point of them being here is that they must never become two
 * permanent "no available player to fill IR" flags on every lineup the copilot prints.
 */
export function isBenchSlot(slot: string): boolean {
  return /^(BE|BENCH|BN|IR|ER)$/i.test(String(slot).trim());
}

/** The STARTING template: the slots a lineup actually has to fill, bench-like ones removed. */
export function startingSlots(slots: readonly string[]): string[] {
  return slots.filter((s) => !isBenchSlot(s));
}

/**
 * The positions a roster SLOT admits. Handles dedicated positions, the keyword flexes
 * (FLEX/OP/SUPERFLEX), and generic slash-forms ("Q/W/R/T" -> [QB,WR,RB,TE], "RB/WR" -> [RB,WR]).
 * Unknown -> the slot as its own single position, so nothing silently becomes a full flex.
 */
export function slotEligibility(slot: string): string[] {
  const s = String(slot).trim().toUpperCase();
  if (FULL_POS.has(s)) return [s];
  if (s === "DEF" || s === "D/ST") return ["DST"];
  if (s === "FLEX" || s === "W/R/T" || s === "RB/WR/TE" || s === "WRT") return ["RB", "WR", "TE"];
  if (s === "OP" || s === "SUPERFLEX" || s === "SF" || s === "Q/W/R/T" || s === "QB/RB/WR/TE") return ["QB", "RB", "WR", "TE"];
  if (s.includes("/")) {
    const out: string[] = [];
    for (const tok of s.split("/").map((t) => t.trim())) {
      const p = FULL_POS.has(tok) ? tok : SLOT_TOKEN[tok];
      if (p && !out.includes(p)) out.push(p);
    }
    if (out.length) return out;
  }
  return [s];
}

/** True when a slot admits more than one position -- i.e. it is a flex of some kind. */
export function isFlexSlot(slot: string): boolean {
  return !isBenchSlot(slot) && slotEligibility(slot).length > 1;
}

/**
 * WHAT THIS SLOT ADMITS IN THIS LEAGUE. `slotEligibility`, with the league's own `flex_ok` replacing
 * the eligibility of the literal `FLEX` token (and nothing else -- see the file header).
 */
export function slotAdmits(slot: string, flexOk?: Iterable<string> | null): string[] {
  const s = String(slot).trim().toUpperCase();
  if (s === "FLEX" && flexOk) {
    const out = [...flexOk];
    if (out.length) return out;
  }
  return slotEligibility(s);
}

/** Does this slot accept a player whose eligible positions are `elig`? */
export function slotAccepts(slot: string, elig: readonly string[], flexOk?: Iterable<string> | null): boolean {
  const admits = slotAdmits(slot, flexOk);
  return elig.some((e) => admits.includes(String(e).trim().toUpperCase()));
}

/** A player's eligible positions: his explicit set when he has one, else his own position. */
export function eligibilityOf(p: { pos: string; eligible?: readonly string[] }): string[] {
  return p.eligible && p.eligible.length ? [...p.eligible] : [p.pos];
}

/** One flex GROUP of a starting template: the positions it admits, how many such slots there are,
 *  and the slot token to NAME it by in a message (so ESPN still says "FLEX" and Yahoo says
 *  "SUPERFLEX" rather than both being called "flex"). */
export interface FlexGroup { key: string; label: string; elig: string[]; count: number }

/**
 * Split a starting template into dedicated counts + flex groups.
 *
 * A single `[RB,WR,TE]` group is exactly the old single-FLEX behaviour, which is why the ESPN
 * numbers do not move. Groups are keyed by their SORTED eligibility, so `FLEX` and `SUPERFLEX` are
 * two distinct groups even though both are "a flex".
 */
export function splitTemplate(slots: readonly string[], flexOk?: Iterable<string> | null): {
  dedicated: Record<string, number>; flex: FlexGroup[];
} {
  const dedicated: Record<string, number> = {};
  const byKey = new Map<string, FlexGroup>();
  for (const s of startingSlots(slots)) {
    const elig = slotAdmits(s, flexOk);
    if (elig.length === 1) { dedicated[elig[0]] = (dedicated[elig[0]] ?? 0) + 1; continue; }
    const key = [...elig].sort().join("/");
    const g = byKey.get(key) ?? { key, label: String(s).trim().toUpperCase(), elig, count: 0 };
    g.count++;
    byKey.set(key, g);
  }
  // NARROWEST FIRST. The assignment below (and `rosterGaps`) fills the most constrained group first,
  // which is exactly optimal when the groups are LAMINAR -- FLEX [RB,WR,TE] inside SUPERFLEX
  // [QB,RB,WR,TE], which is every real superflex league. It also reduces to "one group" trivially.
  return { dedicated, flex: [...byKey.values()].sort((a, b) => a.elig.length - b.elig.length) };
}
