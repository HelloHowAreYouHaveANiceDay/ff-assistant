/**
 * D25 (2026-09-16) -- `starterBaselines` fills FLEX by ELIGIBILITY GROUP, not by one `flex_ok` list.
 *
 * WHAT WAS WRONG. `src/draft/lineupMarginal.ts` counted every flex-ish slot in the template
 * (`isFlexSlot`) and then filled them all from the league's single `flex_ok` array. Under a
 * SUPERFLEX template that is two errors at once: quarterbacks compete for NO flex slot (so QB
 * replacement level sits at the last DEDICATED quarterback, far too shallow, and V3 prices the whole
 * position against the wrong man), and the [RB,WR,TE] pool is handed the superflex slot as well (so
 * the RB/WR/TE baselines are one slot-per-team too deep). `values.ts baselines()` had already been
 * generalised to groups; this is the same fill on the same input.
 *
 * THE TWO THINGS THIS FILE HAS TO PROVE, because a group fill that quietly changed the incumbent
 * would be a value-book change behind the arbiter's back:
 *
 *   1. ESPN 462233 -- a single [RB,WR,TE] group -- is BYTE-IDENTICAL. The numbers below were produced
 *      by the PRE-D25 implementation on this fixture (scripts/d25-baseline-compare.mjs did the same
 *      against the live 529-row board at three openFractions: 0 differing keys).
 *   2. A SUPERFLEX group moves QB and only then. The fault injection is the decisive half: delete the
 *      `SUPERFLEX` token from the same template and every number must return EXACTLY to the
 *      no-superflex answer. A generalisation that changed the baselines for some other reason would
 *      fail that, and a dead one would fail the superflex assertion.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { starterBaselines, expectedWeekPoints, type LmOpts } from "../src/draft/lineupMarginal.js";
import { baselines as valueBaselines, resolveValueLeague } from "../src/draft/values.js";

/** A deterministic board -- a smooth decay per position, so every cutoff index is distinguishable
 *  and no two adjacent men tie. Nothing here depends on the live store. */
const POS: Record<string, number> = { QB: 40, RB: 80, WR: 90, TE: 40, K: 32, DST: 32 };
const TOP: Record<string, number> = { QB: 380, RB: 300, WR: 290, TE: 220, K: 150, DST: 140 };
const BOARD: { name: string; pos: string; proj: number }[] = [];
for (const [pos, n] of Object.entries(POS)) {
  for (let i = 0; i < n; i++) {
    BOARD.push({ name: `${pos}${i + 1}`, pos, proj: Math.round(TOP[pos] * (1 - i / (n + 4)) * 10) / 10 });
  }
}

const FLEX_OK = ["RB", "WR", "TE"];
const ESPN = { teams: 16, slots: ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"] };
const SUPERFLEX = {
  teams: 12,
  slots: ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "FLEX", "FLEX", "SUPERFLEX", "BE", "BE", "IR"],
};
const NO_SUPERFLEX = { ...SUPERFLEX, slots: SUPERFLEX.slots.filter((s) => s !== "SUPERFLEX") };

/** The pinned numbers below are printed to six decimals, so the lock is to 1e-6 -- three orders of
 *  magnitude tighter than any real re-baseline (the smallest genuine move here is ~0.1 pts/wk). */
const close = (a: number, b: number, what: string) =>
  assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} vs ${b}`);

test("D25 REGRESSION LOCK -- ESPN 462233 baselines are unchanged by the group fill", () => {
  // Captured from the PRE-D25 implementation (git HEAD @ 0835e7a + WP1-WP7) on this fixture.
  const AT_FULL: Record<string, number> = {
    QB: 14.223529, RB: 11.135294, WR: 11.070588, TE: 8.235294, K: 4.9, DST: 4.576471, FLEX: 11.135294,
  };
  const AT_HALF: Record<string, number> = {
    QB: 18.288235, RB: 14.288235, WR: 14.152941, TE: 10.588235, K: 6.864706, DST: 6.405882, FLEX: 14.288235,
  };
  for (const [frac, want] of [[1, AT_FULL], [0.5, AT_HALF]] as [number, Record<string, number>][]) {
    const got = starterBaselines(BOARD, ESPN, frac, 17, FLEX_OK);
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(),
      `openFraction ${frac}: the key SET must not move either -- a stray group key is a new baseline`);
    for (const k of Object.keys(want)) close(got[k], want[k], `openFraction ${frac}, ${k}`);
  }
});

test("D25 -- ESPN baselines still agree with values.ts baselines(), the independent reference", () => {
  // The same quantity computed by the other module, which was NOT changed by D25. A hardcoded lock
  // and an agreement check fail for different reasons: the lock catches a silent re-baseline, this
  // catches the two modules drifting apart.
  const lg = resolveValueLeague({ teams: ESPN.teams, budget: 200, slots: ESPN.slots });
  const theirs = valueBaselines(BOARD.map((p) => ({ name: p.name, pos: p.pos, points: p.proj })), lg);
  const mine = starterBaselines(BOARD, ESPN, 1, 17);
  for (const pos of Object.keys(theirs)) {
    close(mine[pos] * 17, theirs[pos], `${pos}: starterBaselines x17 vs values.ts baselines()`);
  }
});

test("D25 -- a SUPERFLEX group takes QB replacement level DEEPER into the pool", () => {
  const withSf = starterBaselines(BOARD, SUPERFLEX, 1, 17, FLEX_OK);
  const withoutSf = starterBaselines(BOARD, NO_SUPERFLEX, 1, 17, FLEX_OK);
  assert.ok(withSf.QB < withoutSf.QB - 1,
    `the superflex slot must move the QB baseline to a WORSE (deeper) quarterback, so QB VOR rises: ` +
    `${withSf.QB.toFixed(3)} with vs ${withoutSf.QB.toFixed(3)} without`);
  // The group's own cutoff travels under its own token, because a SUPERFLEX reaches a different man
  // than a W/R/T flex on the same board and a single `FLEX` entry cannot carry both.
  assert.ok(withSf.SUPERFLEX != null, "the SUPERFLEX group must emit its own cutoff");
  assert.ok(withSf.FLEX != null, "the FLEX group must still emit its own cutoff");
  assert.notEqual(withSf.SUPERFLEX, withSf.FLEX, "two groups do not share one cutoff");
  assert.equal(withoutSf.SUPERFLEX, undefined, "no SUPERFLEX slot, no SUPERFLEX entry");
});

test("D25 FAULT INJECTION -- remove the SUPERFLEX slot and every baseline returns exactly", () => {
  // The decisive half. If the group fill had changed the answer for any reason OTHER than the
  // superflex slot, these would not be equal; if it were dead, the previous test would fail instead.
  const withoutSf = starterBaselines(BOARD, NO_SUPERFLEX, 1, 17, FLEX_OK);
  const PRE_D25: Record<string, number> = {
    QB: 16.258824, RB: 9.241176, WR: 9.252941, TE: 9.117647, K: 8.823529, DST: 8.235294, FLEX: 9.252941,
  };
  for (const k of Object.keys(PRE_D25)) close(withoutSf[k], PRE_D25[k], `no-superflex ${k}`);
});

test("D25 -- expectedWeekPoints prices a SUPERFLEX slot against the SUPERFLEX cutoff, not FLEX", () => {
  const o: LmOpts = {
    slots: ["QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX", "BE"],
    flexOk: FLEX_OK, weeks: 17, avail: { QB: 0.9, RB: 0.9, WR: 0.9, TE: 0.9 },
    replacement: { QB: 1, RB: 1, WR: 1, TE: 1 },
    baseline: { QB: 12, RB: 6, WR: 6, TE: 5, FLEX: 6, SUPERFLEX: 9 },
  };
  // An EMPTY roster, so every slot scores its own floor and the sum is readable term by term.
  const empty = expectedWeekPoints([], 0, o);
  close(empty, 12 + 6 + 6 + 5 + 6 + 9, "empty template scores each slot's own floor");
  // Fault injection: move ONLY the SUPERFLEX entry. If the slot were still reading `FLEX` this is
  // exactly the change that would be invisible.
  const moved = expectedWeekPoints([], 0, { ...o, baseline: { ...o.baseline!, SUPERFLEX: 20 } });
  close(moved - empty, 11, "the SUPERFLEX slot must follow the SUPERFLEX baseline");
  // ...and the FLEX slot must still follow FLEX, so the two are not simply swapped.
  const movedFlex = expectedWeekPoints([], 0, { ...o, baseline: { ...o.baseline!, FLEX: 16 } });
  close(movedFlex - empty, 10, "the FLEX slot must follow the FLEX baseline");
});
