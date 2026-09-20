/**
 * THE CONSENSUS A LEAGUE ACTUALLY PLAYS UNDER (2026-09-20).
 *
 * `ranking` held ONE list -- FantasyPros `redraft-overall` -- and every league read it. A rank
 * carries no statement about which game it describes, so a dynasty superflex league was priced
 * against a one-QB redraft market and nothing anywhere said so.
 *
 * THE POSITIVE CONTROL COMES FIRST, as with the dynasty key: a redraft one-QB league must resolve to
 * the EXACT source string it always used, or every existing `ranking` row is orphaned and the
 * incumbent's board silently empties.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ecrVariantFor, isSuperflex, ECR_SOURCE } from "../src/data/ecrVariant.js";

const REDRAFT_SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE"];
const SUPERFLEX_SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "OP", "DST", "BE"];

test("POSITIVE CONTROL: a redraft one-QB league keeps the EXACT source it always used", () => {
  const v = ecrVariantFor({ leagueType: "redraft", slots: REDRAFT_SLOTS });
  assert.equal(v.source, "fantasypros_ecr", "hard-coded: if this string moves, every stored ranking row is orphaned");
  assert.equal(v.source, ECR_SOURCE);
  assert.equal(v.pageType, "redraft-overall");
  assert.equal(v.baseline, true);
  assert.equal(v.caveat, undefined);
  // Absent leagueType is the same answer -- a store that has never heard of league types is unchanged.
  assert.deepEqual(ecrVariantFor({ slots: REDRAFT_SLOTS }), v);
  assert.deepEqual(ecrVariantFor({ leagueType: null, slots: REDRAFT_SLOTS }), v);
});

test("a DYNASTY SUPERFLEX league gets the dynasty superflex list", () => {
  const v = ecrVariantFor({ leagueType: "dynasty", slots: SUPERFLEX_SLOTS });
  assert.equal(v.pageType, "dynasty-op");
  assert.equal(v.source, "fantasypros_ecr:dynasty-op");
  assert.equal(v.baseline, false);
  // The source must DIFFER from the baseline, which is what lets the two coexist in one table.
  assert.notEqual(v.source, ECR_SOURCE);
});

test("a DYNASTY one-QB league gets dynasty-overall, not the superflex list", () => {
  const v = ecrVariantFor({ leagueType: "dynasty", slots: REDRAFT_SLOTS });
  assert.equal(v.pageType, "dynasty-overall");
  assert.equal(v.source, "fantasypros_ecr:dynasty-overall");
  assert.notEqual(v.source, ecrVariantFor({ leagueType: "dynasty", slots: SUPERFLEX_SLOTS }).source);
});

test("keeper is treated as dynasty-ish -- you keep the player, which is what moves the market", () => {
  assert.equal(ecrVariantFor({ leagueType: "keeper", slots: REDRAFT_SLOTS }).pageType, "dynasty-overall");
  assert.equal(ecrVariantFor({ leagueType: "KEEPER", slots: SUPERFLEX_SLOTS }).pageType, "dynasty-op", "case must not change the answer");
});

/**
 * THE HONEST GAP. FantasyPros publishes `dynasty-op` and `weekly-op` but no REDRAFT superflex list in
 * this feed, so a redraft superflex league cannot be served its own market. It gets the baseline AND
 * a caveat naming what is missing -- a number that silently describes the wrong format is the failure
 * this whole variant selection exists to end, and falling back without saying so would reintroduce it.
 */
test("a REDRAFT SUPERFLEX league falls back to the baseline and SAYS SO", () => {
  const v = ecrVariantFor({ leagueType: "redraft", slots: SUPERFLEX_SLOTS });
  assert.equal(v.source, ECR_SOURCE, "no redraft superflex list exists to fetch");
  assert.equal(v.baseline, true);
  assert.ok(v.caveat, "falling back silently is the defect");
  assert.match(v.caveat, /SUPERFLEX/);
  assert.match(v.caveat, /rank 25/, "the caveat must quantify what is wrong, not just flag it");
});

test("isSuperflex reads the SLOT TEMPLATE, and the dedicated QB slot does not count", () => {
  assert.equal(isSuperflex(SUPERFLEX_SLOTS), true, "OP admits QB");
  assert.equal(isSuperflex(["QB", "RB", "WR", "TE", "SUPERFLEX", "BE"]), true, "so does the SUPERFLEX spelling");
  assert.equal(isSuperflex(["QB", "RB", "WR", "TE", "Q/W/R/T", "BE"]), true, "and the slash form");
  assert.equal(isSuperflex(REDRAFT_SLOTS), false, "a plain FLEX is RB/WR/TE -- not superflex");
  assert.equal(isSuperflex(["QB", "QB", "RB", "WR"]), false,
    "TWO dedicated QB slots is a 2QB league, not superflex -- neither slot admits anything else, so the " +
    "flex-eligibility question this asks is still no");
  assert.equal(isSuperflex([]), false);
});

/**
 * pageType <-> source must be ONE-TO-ONE. Two DIFFERENT lists under one source means the second
 * ingest's `DELETE FROM ranking WHERE source = ?` wipes the first, and a league reads whichever was
 * fetched last -- the exact silent substitution this module exists to end.
 *
 * Sharing is correct in the other direction: keeper and dynasty deliberately resolve to the SAME
 * list, and the redraft-superflex fallback deliberately shares the baseline. (My first version of
 * this test asserted every source unique and failed on keeper/dynasty -- the test was wrong, not the
 * mapping, which is why the invariant is stated as a direction rather than as a count.)
 */
test("FAULT: two DIFFERENT consensus lists must never share one source", () => {
  const sourceOf = new Map<string, string>();   // pageType -> source
  const listOf = new Map<string, string>();     // source   -> pageType
  for (const leagueType of ["redraft", "keeper", "dynasty", "", null]) {
    for (const slots of [REDRAFT_SLOTS, SUPERFLEX_SLOTS, []]) {
      const v = ecrVariantFor({ leagueType, slots });
      const priorSource = sourceOf.get(v.pageType);
      if (priorSource) assert.equal(priorSource, v.source, `${v.pageType} resolved to two different sources`);
      const priorList = listOf.get(v.source);
      if (priorList) {
        assert.equal(priorList, v.pageType,
          `sources collide: "${priorList}" and "${v.pageType}" both write to ${v.source}, so whichever ingests second DELETES the other`);
      }
      sourceOf.set(v.pageType, v.source);
      listOf.set(v.source, v.pageType);
    }
  }
  assert.deepEqual([...listOf.keys()].sort(),
    ["fantasypros_ecr", "fantasypros_ecr:dynasty-op", "fantasypros_ecr:dynasty-overall"],
    "the three distinct lists this repo can fetch today");
  assert.equal(listOf.get(ECR_SOURCE), "redraft-overall");
});
