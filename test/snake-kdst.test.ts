// A LEAGUE WITH NO KICKER SLOT MUST NOT BE SHOWN KICKERS (WP11, item 5).
//
// Yahoo 129048 rosters no K and no DST. The value model did not know that: its pool comes from a
// history CSV that scores K and DST rows under the DEFAULT tables (this league declares none), so
// `computeValues` handed every kicker a dollar figure, the board carried them, and `waivers` could
// offer one. The fix is `startablePositions` -- dedicated slots plus anything a flex group admits --
// and the control that matters is that ESPN, which DOES start both, is untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeValues, resolveValueLeague, startablePositions, filterToStartable, slotEligibility, DEFAULT_VALUE_LEAGUE, type PointsRow } from "../src/draft/values.ts";
import { vorBook, runSnakeDraft } from "../src/draft/draftModel.ts";

const YAHOO = { teams: 12, budget: 200, slots: ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "FLEX", "FLEX", "SUPERFLEX", "BE", "BE", "BE", "BE", "BE", "BE", "BE", "IR", "IR"] };
const ESPN = { teams: 16, budget: 200, slots: ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"] };

function pool(): PointsRow[] {
  const rows: PointsRow[] = [];
  const shape: [string, number, number, number][] = [
    // Deep enough that a 12x17 snake (204 picks) never exhausts the startable pool -- if it did, the
    // legality rule would correctly start taking unstartable bodies to fill benches, and the test
    // below would be measuring the fixture rather than the book.
    ["QB", 40, 400, 7], ["RB", 90, 300, 2.5], ["WR", 120, 295, 2], ["TE", 40, 210, 4],
    ["K", 20, 130, 2], ["DST", 20, 120, 2],
    // The incumbent's own pool carries IDP rows; they are OUTSIDE the six positions this model
    // prices, so they must be left exactly where they are (see filterToStartable's header).
    ["LB", 30, 200, 3], ["DB", 30, 190, 3],
  ];
  for (const [pos, n, top, step] of shape) for (let i = 0; i < n; i++) rows.push({ name: `${pos}${i + 1}`, pos, points: top - i * step });
  return rows;
}

test("startablePositions reads the slot template, and refuses to guess for a legacy ValueLeague", () => {
  assert.deepEqual([...startablePositions(resolveValueLeague(YAHOO))!].sort(), ["QB", "RB", "TE", "WR"]);
  assert.deepEqual([...startablePositions(resolveValueLeague(ESPN))!].sort(), ["DST", "K", "QB", "RB", "TE", "WR"]);
  // A hand-built `starters` map never named its slots, so "no K key" is not evidence of "no K slot".
  assert.equal(startablePositions(DEFAULT_VALUE_LEAGUE), null);
});

test("Yahoo: no K or DST survives the pool or the value book; ESPN keeps both", () => {
  const p = pool();
  const yahooPool = filterToStartable(p, resolveValueLeague(YAHOO));
  assert.equal(yahooPool.filter((x) => x.pos === "K" || x.pos === "DST").length, 0);
  const vy = computeValues(p, resolveValueLeague(YAHOO));
  assert.equal(vy.filter((v) => v.pos === "K" || v.pos === "DST").length, 0, "a league with no K slot must price no kicker");
  assert.ok(vy.some((v) => v.pos === "QB"), "and must still price the positions it does start");

  const ve = computeValues(p, resolveValueLeague(ESPN));
  assert.ok(ve.some((v) => v.pos === "K"), "ESPN starts a kicker, so kickers stay priced");
  assert.ok(ve.some((v) => v.pos === "DST"));
});

test("POSITIVE CONTROL: the incumbent's book is byte-identical with the filter in place", () => {
  // ESPN starts all six priced positions AND the filter deliberately does not touch IDP, so the
  // whole table -- values and order -- must be unchanged. This is the assertion that says the Yahoo
  // fix cost the incumbent nothing; the golden line says the same thing at the other end.
  const p = pool();
  const lg = resolveValueLeague(ESPN);
  assert.deepEqual(computeValues(p, lg), computeValues(filterToStartable(p, lg), lg));
  assert.equal(filterToStartable(p, lg).length, p.length, "nothing may be dropped for ESPN -- IDP included");
  assert.ok(p.some((x) => x.pos === "LB"), "the fixture must actually contain the IDP rows it claims to");
});

test("FAULT INJECTION: give Yahoo a K slot and the kickers come back", () => {
  // Proves the exclusion is driven by the SLOT TEMPLATE and not by a hardcoded "Yahoo has no K".
  const withK = { ...YAHOO, slots: [...YAHOO.slots, "K"] };
  assert.ok(computeValues(pool(), resolveValueLeague(withK)).some((v) => v.pos === "K"));
});

test("a position with NO SLOT is worth zero in the snake book, and none is ever drafted", () => {
  // THE DEFECT THIS LOCKS (measured 2026-09-16, 149 of 816 drafted players): the Yahoo pool carries
  // the incumbent's IDP rows (LB/DB/DL), which `filterToStartable` deliberately does NOT remove (see
  // its header -- removing them moves the ESPN golden). Their VOR floors at 0 because the baseline at
  // a position with no slot is the BEST player at it, so only the TIE-BREAK ordered them -- and the
  // tie-break was raw points, so a 200-point linebacker outranked every sub-replacement receiver and
  // rounds 12-17 filled with men who cannot be started. ~18% of every roster was dead weight.
  const p = pool();
  const lg = { teams: 12, budget: 200, slots: YAHOO.slots };
  const book = vorBook(p, resolveValueLeague(lg));
  for (const r of p.filter((x) => ["LB", "DB", "K", "DST"].includes(x.pos))) {
    assert.equal(book.get(r.name), 0, `${r.name} (${r.pos}) has no slot in this league and must be worth 0`);
  }
  // ...and every startable man with a projection outranks him, which is what makes zero sufficient.
  assert.ok(p.filter((x) => ["QB", "RB", "WR", "TE"].includes(x.pos)).every((x) => (book.get(x.name) ?? 0) > 0));

  const teams = runSnakeDraft(p, lg, { botIdioSd: 0.20 }, { values: book, cfg: { benchDiscount: 0.25 } }, 31337);
  const dead = teams.flat().filter((x) => !["QB", "RB", "WR", "TE"].includes(x.pos));
  assert.equal(dead.length, 0, `nobody may draft a player this league cannot start: ${dead.map((d) => `${d.pos} ${d.name}`).join(", ")}`);
});

test("FAULT INJECTION: give the league an LB slot and linebackers become valuable again", () => {
  // Proves the zero is driven by the SLOT TEMPLATE, not by a hardcoded list of "real" positions --
  // otherwise this guard would keep passing after the rule it protects had been replaced by a name.
  const p = pool();
  const lg = { teams: 12, budget: 200, slots: [...YAHOO.slots, "LB"] };
  const book = vorBook(p, resolveValueLeague(lg));
  const lbs = p.filter((x) => x.pos === "LB");
  assert.ok(lbs.some((x) => (book.get(x.name) ?? 0) > 1), "with an LB slot, the top linebackers carry real VOR");
  const teams = runSnakeDraft(p, lg, { botIdioSd: 0 }, { values: book, cfg: { benchDiscount: 0.25 } }, 31337);
  assert.ok(teams.flat().some((x) => x.pos === "LB"), "and the room drafts them");
});

test("the priced-position universe matches the slot vocabulary's dedicated tokens", () => {
  // `values.ts` carries its own copy of the six priced positions (slots.ts imports nothing, by
  // design). A guard keyed on a hand-typed list rots; this binds the copy to the real parser.
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    assert.deepEqual(slotEligibility(pos), [pos], `${pos} must parse as a dedicated position`);
    // ...and a league that starts ONLY this position must price only it.
    const lg = resolveValueLeague({ teams: 2, budget: 100, slots: [pos, "BE"] });
    assert.deepEqual([...startablePositions(lg)!], [pos]);
  }
});
