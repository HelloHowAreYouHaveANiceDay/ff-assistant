// THE FEATURE TABLE, and the identity it is keyed by.
//
// The defect these tests exist to catch is the one that has now been found four times in this repo
// in four different places: a NAME used as a join key. It never crashes. It returns a row -- the
// wrong man's row -- and the model fitted on it reports a coefficient rather than an error. A
// feature table is the worst possible place for it, because every downstream fit inherits the merge
// at once and none of them can see it.
//
// So the assertions below are about the KEY, about coverage, and about size -- the three things that
// look identical whether the pipeline is correct or silently half-connected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { openDb } from "../src/db/db.js";
import { buildSkResolver, dstKey } from "../src/data/skResolve.js";
import type { DB } from "../src/db/db.js";

const HAVE_DB = existsSync("data/ff.db");

/** A fixture staging table holding only the collisions, so the assertion is about the RULE rather
 *  than about whatever the live crosswalk happens to contain this week. */
function fixtureDb(): DB {
  const db = new Database(":memory:") as unknown as DB;
  db.exec(`CREATE TABLE stg_player (player_sk INTEGER PRIMARY KEY, name_key TEXT, name TEXT,
    position TEXT, team TEXT, birthdate TEXT, gsis_id TEXT)`);
  const ins = db.prepare("INSERT INTO stg_player VALUES (@sk,@nk,@n,@p,@t,@b,@g)");
  // Two Justin Jeffersons: one real WR, one real LB, four years apart. The board once aged the
  // receiver from the linebacker's birth date.
  ins.run({ sk: 14123, nk: "justinjefferson", n: "Justin Jefferson", p: "WR", t: "MIN", b: "1999-06-16", g: "00-0036322" });
  ins.run({ sk: 12087, nk: "justinjefferson", n: "Justin Jefferson", p: "LB", t: "CLE", b: "2003-03-20", g: "00-0041075" });
  // Marvin Harrison Sr. and Jr. -- BOTH WR, and `nameKey` strips "Jr" on purpose, so name and
  // position agree and only TEAM separates them. This is the pair that broke the first version of
  // the board fix: a name+position lookup returned a Hall of Famer who retired in 2008.
  ins.run({ sk: 12622, nk: "marvinharrison", n: "Marvin Harrison", p: "WR", t: "IND", b: "1973-08-26", g: "00-0000123" });
  ins.run({ sk: 99001, nk: "marvinharrison", n: "Marvin Harrison Jr.", p: "WR", t: "ARI", b: "2002-08-07", g: "00-0039849" });
  return db;
}

test("two men who share a name resolve to two DIFFERENT keys", () => {
  const db = fixtureDb();
  const r = buildSkResolver(db);
  const wr = r.resolve({ name: "Justin Jefferson", pos: "WR", team: "MIN" });
  const lb = r.resolve({ name: "Justin Jefferson", pos: "LB", team: "CLE" });
  assert.ok(wr && lb, "both Jeffersons must resolve");
  assert.notEqual(wr, lb, "the receiver and the linebacker are not the same person");
  const born = (sk: string) => (db.prepare("SELECT birthdate FROM stg_player WHERE player_sk = ?").get(Number(sk)) as { birthdate: string }).birthdate;
  assert.equal(born(wr!), "1999-06-16", "the WR must carry HIS birth date, not the linebacker's");
  assert.equal(born(lb!), "2003-03-20");
  db.close();
});

test("father and son at the SAME position are separated by team -- the case position alone cannot", () => {
  const db = fixtureDb();
  const r = buildSkResolver(db);
  // `nameKey` strips generational suffixes, so these two share a name key AND a position. Anything
  // weaker than the team rule hands the son his father's row, which is a 53-year-old on the board.
  const sr = r.resolve({ name: "Marvin Harrison", pos: "WR", team: "IND" });
  const jr = r.resolve({ name: "Marvin Harrison Jr.", pos: "WR", team: "ARI" });
  assert.ok(sr && jr, "both Harrisons must resolve");
  assert.notEqual(sr, jr, "Marvin Harrison Jr. is not Marvin Harrison Sr.");
  const born = (sk: string) => (db.prepare("SELECT birthdate FROM stg_player WHERE player_sk = ?").get(Number(sk)) as { birthdate: string }).birthdate;
  assert.equal(born(sr!), "1973-08-26");
  assert.equal(born(jr!), "2002-08-07");
  db.close();
});

test("a gsis id decides even when the name and team would not", () => {
  const db = fixtureDb();
  const r = buildSkResolver(db);
  // The strongest evidence must win. Passing the son's gsis with a WRONG team must still return the
  // son -- otherwise the ordering in skResolve.ts is decorative.
  assert.equal(r.resolve({ gsis: "00-0039849", name: "Marvin Harrison", pos: "WR", team: "IND" }), "99001");
  db.close();
});

test("an unresolvable row reports null rather than a plausible wrong key", () => {
  const db = fixtureDb();
  const r = buildSkResolver(db);
  assert.equal(r.resolve({ name: "Nobody Atall", pos: "WR", team: "SEA" }), null);
  db.close();
});

test("a team defense gets a deterministic synthetic key, not a minted surrogate one", () => {
  const db = fixtureDb();
  const r = buildSkResolver(db);
  assert.equal(dstKey("sf"), "DST:SF");
  assert.equal(r.resolve({ name: "SF DST", pos: "DST", team: "SF" }), "DST:SF");
  // Stable across calls and independent of the registry -- a defense is not a person and must not
  // consume a player_sk.
  assert.equal(r.resolve({ name: "SF D/ST", pos: "DST", team: "SF" }), "DST:SF");
  db.close();
});

test("feat_player_season holds one row per SCORED player-season, within 5%", (t) => {
  if (!HAVE_DB) return t.skip("no data/ff.db");
  const db = openDb("data/ff.db");
  const rows = db.prepare(
    "SELECT season, COUNT(*) n, SUM(CASE WHEN pts IS NOT NULL THEN 1 ELSE 0 END) scored FROM feat_player_season " +
    "WHERE season BETWEEN 1999 AND 2025 GROUP BY season",
  ).all() as { season: number; n: number; scored: number }[];
  db.close();
  if (!rows.length) return t.skip("feature table not built -- run `ff build-features`");
  for (const r of rows) {
    // A table that quietly holds twice or half the players it should looks entirely healthy from
    // any single row, and every rate computed from it is then wrong by a factor nobody states.
    assert.ok(Math.abs(r.n - r.scored) <= 0.05 * r.scored,
      `${r.season}: ${r.n} feature rows against ${r.scored} scored players -- more than 5% apart`);
  }
});

test("player_sk is present on at least 97% of skill-position rows, 2010-2025", (t) => {
  if (!HAVE_DB) return t.skip("no data/ff.db");
  const db = openDb("data/ff.db");
  const r = db.prepare(
    "SELECT COUNT(*) n, SUM(CASE WHEN player_sk IS NOT NULL THEN 1 ELSE 0 END) k FROM feat_player_season " +
    "WHERE season BETWEEN 2010 AND 2025 AND pos IN ('QB','RB','WR','TE')",
  ).get() as { n: number; k: number };
  db.close();
  if (!r.n) return t.skip("feature table not built -- run `ff build-features`");
  const rate = r.k / r.n;
  assert.ok(rate >= 0.97, `player_sk on ${r.k}/${r.n} = ${(rate * 100).toFixed(2)}% of skill rows; below the 97% bar`);
});

test("the week table never lets week W see week W", (t) => {
  if (!HAVE_DB) return t.skip("no data/ff.db");
  const db = openDb("data/ff.db");
  const first = db.prepare(
    "SELECT COUNT(*) n FROM feat_player_week WHERE week = 1 AND td_games > 0",
  ).get() as { n: number };
  db.close();
  // Week 1's to-date usage must be built from zero games. A single row with games played before the
  // season started is the signature of accumulating BEFORE writing -- the one-line version of
  // lookahead, which would make every weekly model in this repo look excellent and be worthless.
  assert.equal(first.n, 0, `${first.n} week-1 rows claim prior games played`);
});
