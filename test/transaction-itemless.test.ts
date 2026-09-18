/**
 * A TRANSACTION ESPN RETURNED MUST NEVER LEAVE NO TRACE.
 *
 * `raw_league_transaction` is stored ONE ROW PER ITEM, so a transaction whose `items` array is empty
 * contributes nothing -- and was discarded in silence until 2026-09-18. ESPN serves a trade between
 * two OTHER teams as exactly that: a container with `items: []`. Our own trades come back with their
 * items intact, which is why the gap looked like nothing at all.
 *
 * MEASURED on league 462233. A 14 <-> 13 trade on 2026-09-17 moving Jalen Hurts and Ladd McConkey
 * arrived twice -- `TRADE_ACCEPT` with `status: undefined`, then `TRADE_UPHOLD` EXECUTED -- both with
 * zero items, and neither produced a row. Nothing reported it. It surfaced only because a
 * ROSTER-move cross-check disagreed with `ownership` on exactly two players out of forty-eight.
 *
 * The rows still cannot be written: ESPN did not say who moved, and inventing the players would be
 * worse than reporting the gap. What changes is that "ESPN withheld the items of N transactions" and
 * "there were no transactions" are now different sentences.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTransactionWeek } from "../src/data/leagueTransactions.js";

const withItems = {
  id: "t-ours", type: "TRADE_ACCEPT", status: "EXECUTED", teamId: 8, scoringPeriodId: 2,
  proposedDate: 1789000000000,
  items: [
    { playerId: 4612826, type: "TRADE", fromTeamId: 8, toTeamId: 14 },
    { playerId: 4426338, type: "TRADE", fromTeamId: 14, toTeamId: 8 },
  ],
};
// EXACTLY the shape ESPN served for the third-party trade, including the undefined status.
const itemlessAccept = { id: "t-theirs", type: "TRADE_ACCEPT", teamId: 14, scoringPeriodId: 2, proposedDate: 1789100000000, items: [] as unknown[] };
const itemlessUphold = { id: "t-uphold", type: "TRADE_UPHOLD", status: "EXECUTED", teamId: 13, scoringPeriodId: 2, proposedDate: 1789200000000, items: [] as unknown[] };

test("an ITEMLESS transaction is counted and named, not dropped", () => {
  const r = parseTransactionWeek({ transactions: [withItems, itemlessAccept, itemlessUphold] }, 2026, 2);
  assert.equal(r.rows.length, 2, "only the trade WITH items can produce rows");
  assert.equal(r.itemless.length, 2, "and the two without items must still be reported");
  assert.deepEqual(r.itemless.map((t) => t.type).sort(), ["TRADE_ACCEPT", "TRADE_UPHOLD"]);
  assert.deepEqual(r.itemless.map((t) => t.teamId).sort(), ["13", "14"]);
  // A missing status must survive as null rather than becoming the string "undefined".
  assert.equal(r.itemless.find((t) => t.type === "TRADE_ACCEPT")!.status, null);
  assert.match(r.note ?? "", /2 transaction\(s\) carried NO items/);
});

test("POSITIVE CONTROL: a week with only normal transactions reports NO itemless and no note", () => {
  // The other direction. A detector that always fires is as useless as one that never does, and
  // "every week has withheld trades" would read as an ESPN problem rather than a real one.
  const r = parseTransactionWeek({ transactions: [withItems] }, 2026, 2);
  assert.equal(r.itemless.length, 0);
  assert.equal(r.note, null);
  assert.equal(r.rows.length, 2);
});

test("an item with NO playerId is counted too, rather than silently skipped", () => {
  const odd = { id: "t-odd", type: "ROSTER", status: "EXECUTED", teamId: 4, scoringPeriodId: 2, proposedDate: 1789300000000,
    items: [{ playerId: 123, type: "LINEUP" }, { type: "LINEUP" }] };
  const r = parseTransactionWeek({ transactions: [odd] }, 2026, 2);
  assert.equal(r.rows.length, 1);
  assert.equal(r.itemsWithoutPlayer, 1);
  assert.equal(r.itemless.length, 0, "a transaction WITH items is not itemless just because one item is unusable");
});

test("an empty payload is still distinguishable from a withheld one", () => {
  const empty = parseTransactionWeek({ transactions: [] }, 2026, 9);
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.itemless.length, 0);
  assert.match(empty.note ?? "", /ESPN returned no transactions/);

  // The case that matters: ESPN sent something, we could store none of it. That must NOT read the
  // same as "nothing happened" -- it is the exact confusion this whole file exists to prevent.
  const withheld = parseTransactionWeek({ transactions: [itemlessAccept] }, 2026, 2);
  assert.equal(withheld.rows.length, 0);
  assert.equal(withheld.itemless.length, 1);
  assert.notEqual(withheld.note, empty.note);
});
