// THE PLAYOFF FIELD, and the check that says whether the data agrees with it.
//
// This file exists mostly to record a derivation that DOES NOT WORK, so nobody rebuilds it. A first
// cut read the field off each season -- "the teams that finish 1..k are exactly the seeds 1..k, for
// the largest such k" -- and it was wrong twice: k = teams satisfies it trivially, so the rule could
// only ever return its own fallback; and bounded to a plausible bracket it is not identifiable,
// because ESPN's `final_rank` is a consolation-inclusive ordering whose relationship to the bracket
// varies by season. Only a fault injection found the first fault, and only running it across all
// eight settled seasons found the second.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { playoffFieldFor, seedsAgreeAtField } from "../src/features/picks.js";

// 2024, exactly as the store holds it: 14 teams, and the six teams that finished 1..6 are seeds
// 3,5,1,2,4,6 -- a permutation of 1..6. The seventh finisher is seed 9, which is what ends it.
const S2024 = [
  { rank: 1, seed: 3 }, { rank: 2, seed: 5 }, { rank: 3, seed: 1 }, { rank: 4, seed: 2 },
  { rank: 5, seed: 4 }, { rank: 6, seed: 6 }, { rank: 7, seed: 9 }, { rank: 8, seed: 12 },
  { rank: 9, seed: 7 }, { rank: 10, seed: 13 }, { rank: 11, seed: 8 }, { rank: 12, seed: 14 },
  { rank: 13, seed: 10 }, { rank: 14, seed: 11 },
];
// 2025: 16 teams, seven-team bracket, and the CHAMPION WAS THE 7 SEED at 9-5 -- the case any rule
// keyed on "the top seed wins" gets wrong, and the reason a title probability is worth computing.
const S2025 = [
  { rank: 1, seed: 7 }, { rank: 2, seed: 4 }, { rank: 3, seed: 3 }, { rank: 4, seed: 1 },
  { rank: 5, seed: 6 }, { rank: 6, seed: 5 }, { rank: 7, seed: 2 }, { rank: 8, seed: 11 },
  { rank: 9, seed: 13 }, { rank: 10, seed: 8 }, { rank: 11, seed: 15 }, { rank: 12, seed: 12 },
  { rank: 13, seed: 9 }, { rank: 14, seed: 14 }, { rank: 15, seed: 10 }, { rank: 16, seed: 16 },
];

test("the field is 6 in the 14-team era and 7 in the 16-team one", () => {
  assert.equal(playoffFieldFor(14), 6);
  assert.equal(playoffFieldFor(16), 7);
});

test("the top-k seed check AGREES with the stated field in 2024 and 2025", () => {
  assert.equal(seedsAgreeAtField(S2024, 6), true);
  assert.equal(seedsAgreeAtField(S2025, 7), true);
});

// FAULT INJECTION. The check must be able to say NO. Move the 9 seed into the top six -- a season no
// six-team bracket can produce -- and it must report a disagreement rather than absorbing it. A
// check that can only ever return true is the shape of defect this whole file is about.
test("FAULT INJECTION: a top six containing a non-playoff seed is reported as a DISAGREEMENT", () => {
  const injected = S2024.map((r) => (r.rank === 6 ? { rank: 6, seed: 9 } : r.rank === 7 ? { rank: 7, seed: 6 } : r));
  assert.equal(seedsAgreeAtField(injected, 6), false);
  // ...and the honest direction too: the same season checked at 7 is still a disagreement, so the
  // check is not simply relabelling the field it was handed.
  assert.equal(seedsAgreeAtField(S2024, 7), false);
});

test("a season with no finishes returns null rather than a verdict", () => {
  assert.equal(seedsAgreeAtField(S2025.map((r) => ({ seed: r.seed, rank: null })), 7), null);
});

// THE STORE, as it actually is. Recorded rather than asserted true, because two of the six settled
// 14-team seasons genuinely disagree -- in 2021 the 8 seed finished FIFTH and the 6 seed seventh --
// and a test that demanded agreement would be demanding that ESPN's ordering mean something it does
// not. What IS asserted is that the majority agree, which is the evidence the stated constant rests
// on; if that ever stops being true, the constant is wrong and somebody should look.
test("in the store, the stated field agrees with the seeds in most settled seasons", (t) => {
  if (!existsSync("data/ff.db")) return t.skip("no data/ff.db");
  const db = new Database("data/ff.db", { readonly: true });
  let rows: { season: number; teams: number; agree: number }[];
  try {
    rows = db.prepare(
      `SELECT season, COUNT(*) teams,
              SUM(CASE WHEN final_rank <= (CASE WHEN (SELECT COUNT(*) FROM fact_team_season x WHERE x.season = t.season) >= 16 THEN 7 ELSE 6 END)
                        AND playoff_seed <= (CASE WHEN (SELECT COUNT(*) FROM fact_team_season x WHERE x.season = t.season) >= 16 THEN 7 ELSE 6 END)
                   THEN 1 ELSE 0 END) agree
         FROM fact_team_season t WHERE settled = 1 GROUP BY season ORDER BY season`,
    ).all() as typeof rows;
  } catch { db.close(); return t.skip("fact_team_season not built"); }
  db.close();
  if (!rows.length) return t.skip("no settled seasons");
  const field = (n: number) => (n >= 16 ? 7 : 6);
  const full = rows.filter((r) => r.agree === field(r.teams)).length;
  assert.ok(full >= Math.ceil(rows.length * 0.6),
    `only ${full}/${rows.length} settled seasons have the top-${"k"} finishers exactly at the stated field`);
});
