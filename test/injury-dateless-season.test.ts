/**
 * WHICH SEASONS THE INJURY BUILDER CAN READ.
 *
 * The builder has two paths: a dated one that places each filing against that team's Friday cutoff,
 * and a dateless one that takes each week's file as its own final pre-game report. Choosing between
 * them used to be `dated === 0`, and that exact-zero test cost the whole of 2009 -- a season with
 * 4,821 filings of the same shape as 2010, of which exactly 17 carry a date, all of them week 17
 * sharing one timestamp. Seventeen rows made the test false, the dated path discarded the other
 * 99.6%, and the season read as "no injury data" rather than "undated".
 *
 * That is this repo's recurring shape: a guard keyed on a value that a stray row can flip, rather
 * than on the property actually being asked about. So the rule is asserted here against the REAL
 * per-season shares, and both directions are covered -- a dated season must NOT be diverted to the
 * dateless path, which would be the same bug pointing the other way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { isDatelessSeason } from "../src/features/sources/injuryDuration.js";

test("a handful of stray dated rows does NOT make a season 'dated'", () => {
  // 2009's exact numbers. The old `dated === 0` returned false here and threw the season away.
  assert.equal(isDatelessSeason(4821, 17), true);
});

test("a season that really publishes dates takes the dated path", () => {
  assert.equal(isDatelessSeason(4491, 4429), false);   // 2010, 98.6%
  assert.equal(isDatelessSeason(4971, 4971), false);   // 2011, 100%
});

test("a season with no dates at all is dateless", () => {
  assert.equal(isDatelessSeason(6068, 0), true);       // 2025
});

test("a season with no rows is not 'dateless' -- there is nothing to read either way", () => {
  // Guards the divide-by-zero, and keeps an absent season from claiming a path it cannot walk.
  assert.equal(isDatelessSeason(0, 0), false);
});

test("REAL DATA: every season lands far from the threshold, so it decides nothing marginal", {
  skip: !existsSync("data/ff.db") && "no data/ff.db",
}, () => {
  const db = new Database("data/ff.db", { readonly: true });
  try {
    const rows = db.prepare(
      "SELECT season, COUNT(*) n, SUM(as_of IS NOT NULL AND as_of <> '') dated FROM raw_injury GROUP BY season",
    ).all() as { season: number; n: number; dated: number | null }[];
    if (!rows.length) return;
    for (const r of rows) {
      const share = (r.dated ?? 0) / r.n;
      // The whole defence of a 0.5 cut is that the two regimes are nowhere near it. If a season ever
      // lands in the middle, the cut has started making a judgement call and wants a human.
      assert.ok(share < 0.05 || share > 0.95,
        `season ${r.season} is ${(share * 100).toFixed(1)}% dated -- between the two regimes, so the ` +
        "0.5 threshold is now deciding something real. Check the feed rather than moving the number.");
    }
    // AND THE POSITIVE CONTROL: at least one season of each kind must actually be present, or this
    // test is passing over a population that cannot exercise either branch.
    const dateless = rows.filter((r) => isDatelessSeason(r.n, r.dated ?? 0));
    assert.ok(dateless.length > 0, "no dateless season in the store -- the fallback is untested here");
    assert.ok(dateless.length < rows.length, "every season is dateless -- the dated path is untested here");
  } finally { db.close(); }
});

test("REAL DATA: 2009 produced episodes -- the gap is actually closed, not merely permitted", {
  skip: !existsSync("data/ff.db") && "no data/ff.db",
}, () => {
  const db = new Database("data/ff.db", { readonly: true });
  try {
    const raw = db.prepare("SELECT COUNT(*) n FROM raw_injury WHERE season = 2009").get() as { n: number };
    if (!raw.n) return;   // a store without the 2009 feed cannot be asked this
    const eps = db.prepare("SELECT COUNT(*) n FROM fact_injury_episode WHERE season = 2009").get() as { n: number };
    assert.ok(eps.n > 300,
      `2009 has ${raw.n} filings but only ${eps.n} episodes. Rebuild with ` +
      "`ff build-injury-horizon --seasons 2009-2009`; a near-zero count is the exact-zero bug returning.");
  } finally { db.close(); }
});
