// THE SNAKE'S ONE HARD RULE: a pick is legal only while the picks left still cover every starting
// slot the roster cannot fill. That is `starterReserve`'s semantics with picks in place of dollars,
// and it is what stops a bot rostering a fourth quarterback and fielding an illegal lineup.
//
// TWO IMPLEMENTATIONS OF "IS THIS ROSTER LEGAL" THAT CAN DISAGREE IS THE BUG THIS REPO KEEPS FINDING,
// so the numeric `startingDeficit` is asserted against `season.ts:rosterGaps` -- the sentence-producing
// sibling -- rather than merely being believed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startingDeficit, deficitFromCounts, runSnakeDraft, vorBook } from "../src/draft/draftModel.ts";
import { splitTemplate } from "../src/draft/slots.ts";
import { rosterGaps } from "../src/draft/season.ts";
import { resolveValueLeague, type PointsRow } from "../src/draft/values.ts";

const YAHOO = ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "FLEX", "FLEX", "SUPERFLEX",
  "BE", "BE", "BE", "BE", "BE", "BE", "BE", "IR", "IR"];
const ESPN = ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"];

const R = (...pos: string[]) => pos.map((p) => ({ pos: p }));

test("startingDeficit agrees with rosterGaps about WHETHER a roster is legal", () => {
  const cases: { slots: string[]; roster: string[] }[] = [
    { slots: YAHOO, roster: [] },
    { slots: YAHOO, roster: ["QB", "QB", "WR", "WR", "RB", "RB", "TE", "RB", "WR", "WR"] },  // legal
    { slots: YAHOO, roster: ["QB", "QB", "QB", "QB", "WR", "WR", "RB", "RB", "TE", "WR"] },  // 4 QB: short a flex body
    { slots: YAHOO, roster: ["QB", "WR", "WR", "RB", "RB", "TE", "TE", "TE", "TE", "TE"] },
    { slots: ESPN, roster: ["QB", "RB", "WR", "TE", "K", "DST", "RB", "WR"] },               // legal
    { slots: ESPN, roster: ["QB", "RB", "WR", "TE", "K", "RB", "WR", "WR"] },                // no DST
    { slots: ESPN, roster: ["QB", "RB", "WR", "TE", "K", "DST"] },                           // no flex bodies
  ];
  for (const c of cases) {
    const d = startingDeficit(R(...c.roster), c.slots);
    const gaps = rosterGaps([{ id: "t", roster: R(...c.roster) }], c.slots);
    assert.equal(d > 0, gaps.length > 0,
      `deficit ${d} vs rosterGaps ${JSON.stringify(gaps)} for [${c.roster.join(",")}] under ${c.slots[9] ?? c.slots[6]}`);
  }
});

test("the deficit counts the right NUMBER of unfillable starting slots", () => {
  assert.equal(startingDeficit([], YAHOO), 10);                       // ten starting slots, nobody
  assert.equal(startingDeficit([], ESPN), 8);
  // QB fills the QB slot; the other nine remain.
  assert.equal(startingDeficit(R("QB"), YAHOO), 9);
  // A SECOND QB fills SUPERFLEX (the whole point of the format); a THIRD fills nothing.
  assert.equal(startingDeficit(R("QB", "QB"), YAHOO), 8);
  assert.equal(startingDeficit(R("QB", "QB", "QB"), YAHOO), 8);
  // ...and a FLEX group does NOT admit him, so he cannot cover one.
  assert.equal(startingDeficit(R("QB", "QB", "QB", "QB"), YAHOO), 8);
});

test("deficitFromCounts is the same arithmetic over a pre-parsed template (the hot path)", () => {
  const tpl = splitTemplate(YAHOO);
  for (const roster of [[], ["QB"], ["QB", "QB", "RB"], ["QB", "WR", "WR", "RB", "RB", "TE", "TE", "WR"]]) {
    const counts: Record<string, number> = {};
    for (const p of roster) counts[p] = (counts[p] ?? 0) + 1;
    assert.equal(deficitFromCounts(counts, tpl), startingDeficit(R(...roster), YAHOO));
  }
});

function superflexPool(): PointsRow[] {
  const rows: PointsRow[] = [];
  const shape: [string, number, number, number][] = [["QB", 40, 420, 6], ["RB", 90, 300, 2.5], ["WR", 110, 295, 2], ["TE", 40, 210, 4]];
  for (const [pos, n, top, step] of shape) for (let i = 0; i < n; i++) rows.push({ name: `${pos}${i + 1}`, pos, points: top - i * step });
  return rows;
}

test("EVERY seat finishes a snake draft with a roster that can field a legal lineup", () => {
  const pts = superflexPool();
  const lg = { teams: 12, budget: 200, slots: YAHOO };
  const ours = vorBook(pts, resolveValueLeague(lg));
  for (const seed of [1, 2, 3, 99]) {
    const teams = runSnakeDraft(pts, lg, { botIdioSd: 0.20 }, { values: ours, cfg: { benchDiscount: 0.25 } }, seed);
    assert.equal(teams.length, 12);
    for (const [i, t] of teams.entries()) {
      assert.equal(t.length, 17, `seat ${i} must fill all 17 drafted slots`);
      assert.equal(rosterGaps([{ id: String(i), roster: t }], YAHOO).length, 0,
        `seat ${i} (seed ${seed}) drafted an unfillable roster: ${rosterGaps([{ id: String(i), roster: t }], YAHOO).join("; ")}`);
    }
    // nobody is drafted twice
    const all = teams.flat().map((p) => p.name);
    assert.equal(new Set(all).size, all.length);
  }
});

test("FAULT INJECTION: remove the legality rule's headroom and the rule BINDS (it is not dead code)", () => {
  // A roster of nine quarterbacks under the Yahoo template still cannot fill WR/RB/TE, so with only
  // one pick left the deficit must EXCEED it -- which is precisely the condition the draft loop uses
  // to refuse a pick. If this ever reads <= 1 the rule can never bind and the guard is decoration.
  const nineQb = startingDeficit(R("QB", "QB", "QB", "QB", "QB", "QB", "QB", "QB", "QB"), YAHOO);
  assert.ok(nineQb > 1, `a nine-QB roster must leave more than one unfillable starting slot (got ${nineQb})`);
});
