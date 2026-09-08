// THE PICKS FACT TABLE against the numbers already written down.
//
// docs/league-tendencies.md records what this room spent, season by season, and those figures are
// what every piece of reasoning about the league's behaviour rests on. If fact_draft_pick disagrees
// with them, one of the two is wrong and neither can be trusted -- and a table of prices that is
// quietly 3% light looks exactly like one that is right.
//
// So the assertion is against the DOC's numbers, hardcoded here on purpose: an assertion that
// recomputed the totals from the same table would be the table agreeing with itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { openDb } from "../src/db/db.js";

const HAVE_DB = existsSync("data/ff.db");

// season -> [picks, total $] exactly as docs/league-tendencies.md records them.
const RECORDED: Record<number, [number, number]> = {
  2022: [182, 2796],
  2023: [182, 2783],
  2024: [182, 2767],
  2025: [192, 3157],
};

test("every season's pick count and total spend match docs/league-tendencies.md within 1%", (t) => {
  if (!HAVE_DB) return t.skip("no data/ff.db");
  const db = openDb("data/ff.db");
  let rows: { season: number; n: number; total: number }[];
  try {
    rows = db.prepare("SELECT season, COUNT(*) n, SUM(price) total FROM fact_draft_pick GROUP BY season")
      .all() as typeof rows;
  } catch { db.close(); return t.skip("fact_draft_pick not built -- run `ff build-picks`"); }
  db.close();
  if (!rows.length) return t.skip("fact_draft_pick is empty -- run `ff build-picks`");
  for (const r of rows) {
    const want = RECORDED[r.season];
    if (!want) continue;                       // a season the doc does not cover is not a failure
    assert.equal(r.n, want[0], `${r.season}: ${r.n} picks against the recorded ${want[0]}`);
    assert.ok(Math.abs(r.total - want[1]) <= 0.01 * want[1],
      `${r.season}: $${r.total} against the recorded $${want[1]} -- more than 1% apart`);
  }
  // The check must actually have compared something. A table holding only seasons the doc does not
  // list would sail through the loop above having asserted nothing at all.
  const covered = rows.filter((r) => RECORDED[r.season]).length;
  assert.ok(covered >= 3, `only ${covered} recorded seasons present -- this test compared almost nothing`);
});

test("a pick's player key is resolved for nearly all of them, and unresolved is a KEPT row", (t) => {
  if (!HAVE_DB) return t.skip("no data/ff.db");
  const db = openDb("data/ff.db");
  let r: { n: number; k: number };
  try {
    r = db.prepare("SELECT COUNT(*) n, SUM(CASE WHEN player_sk IS NOT NULL THEN 1 ELSE 0 END) k FROM fact_draft_pick")
      .get() as typeof r;
  } catch { db.close(); return t.skip("fact_draft_pick not built"); }
  db.close();
  if (!r.n) return t.skip("fact_draft_pick is empty");
  assert.ok(r.k / r.n >= 0.95, `player_sk on ${r.k}/${r.n} picks -- below 95%`);
  // And the unresolved ones are still THERE. A pipeline that reached 100% by dropping the hard rows
  // would pass the line above and lose real picks.
  assert.ok(r.n >= 700, `only ${r.n} picks -- rows are being dropped somewhere`);
});

test("the consensus columns are stamped with the scrape they came from", (t) => {
  if (!HAVE_DB) return t.skip("no data/ff.db");
  const db = openDb("data/ff.db");
  let rows: { season: number; asOf: string | null; withRank: number; n: number }[];
  try {
    rows = db.prepare(
      "SELECT season, consensus_asof asOf, COUNT(*) n, " +
      "SUM(CASE WHEN consensus_pos_rank_asof IS NOT NULL THEN 1 ELSE 0 END) withRank " +
      "FROM fact_draft_pick GROUP BY season",
    ).all() as typeof rows;
  } catch { db.close(); return t.skip("fact_draft_pick not built"); }
  db.close();
  if (!rows.length) return t.skip("fact_draft_pick is empty");
  for (const r of rows) {
    // "The consensus at the draft" and "the last consensus before week 1" are different quantities.
    // We do not know the draft dates, so every row says WHICH scrape it used rather than leaving a
    // model to assume the wrong one.
    assert.ok(r.asOf, `${r.season}: consensus columns with no consensus_asof stamp`);
    assert.ok(r.asOf!.startsWith(String(r.season)), `${r.season}: consensus dated ${r.asOf}`);
    const m = Number(r.asOf!.slice(5, 7));
    assert.ok(m === 8 || m === 9, `${r.season}: consensus scraped in month ${m} -- that is not preseason`);
    assert.ok(r.withRank / r.n >= 0.8, `${r.season}: only ${r.withRank}/${r.n} picks carry a consensus rank`);
  }
});
