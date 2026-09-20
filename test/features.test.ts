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

test("THE SEPT-1 PIN IS BACKED BY SEPT-1 DATA -- the label is a claim, and this enforces it", (t) => {
  /**
   * `feat_player_season.as_of` is hardcoded to `<season>-09-01` and CANNOT drift by rebuilding --
   * which is right, and is not the same as the row being true as of that date. The builder reads
   * LIVE dimension tables (`player.nfl_team`, via the ECR join) at build time, so a rebuild run in
   * week 8 writes week-8 values under a September label and nothing notices. Sanders' row shows the
   * shape today: `as_of 2026-09-01`, `updated_at 2026-09-12`.
   *
   * For a table the TRAINERS treat as preseason, that is lookahead -- pointed the opposite way from
   * the serving bug in the same chain.
   *
   * THE CHECK. Week 1 is the first week that actually happened, so a player's week-1 team is the
   * closest observable proxy for "his team at the start of the season". Where the season pin and the
   * week-1 row disagree, the pin is carrying something week 1 did not know about.
   *
   * MEASURED CLEAN when written (2026-09-19): zero disagreements. This is a tripwire for a latent
   * gap, not a fix for a live one -- it exists so that a mid-season `ff refresh` cannot quietly
   * re-date the training inputs.
   */
  if (!HAVE_DB) return t.skip("no data/ff.db");
  const db = openDb("data/ff.db");
  try {
    const rows = db.prepare(
      `SELECT s.season, s.name, s.team AS pin, w.team AS wk1
         FROM feat_player_season s
         JOIN feat_player_week w
           ON w.season = s.season AND w.feat_key = s.feat_key AND w.week = 1
        WHERE s.team IS NOT NULL AND w.team IS NOT NULL AND s.team <> w.team`,
    ).all() as { season: number; name: string; pin: string; wk1: string }[];
    // A tripwire that can never fire is not a tripwire: assert the comparison actually ran.
    const considered = (db.prepare(
      `SELECT COUNT(*) c FROM feat_player_season s
         JOIN feat_player_week w ON w.season = s.season AND w.feat_key = s.feat_key AND w.week = 1
        WHERE s.team IS NOT NULL AND w.team IS NOT NULL`,
    ).get() as { c: number }).c;
    if (considered < 100) return t.skip(`only ${considered} comparable rows -- this store cannot answer`);

    // TWO ARMS, because the fix landed in two halves and pretending otherwise would either hide the
    // backlog or block on it.
    //
    // THE SERVED SEASON IS HELD TO ZERO. It is what this week's decisions are made from, it has been
    // rebuilt with the corrected resolution, and it must stay clean.
    const cur = (db.prepare("SELECT MAX(season) s FROM feat_player_season").get() as { s: number }).s;
    const live = rows.filter((r) => r.season === cur);
    assert.deepEqual(live.map((r) => `${r.name}: pin=${r.pin} wk1=${r.wk1}`), [],
      `the ${cur} season pin disagrees with week 1 for ${live.length} player(s). This season is SERVED, ` +
      "so a wrong team here means a NULL opponent and a matchup-blind projection. Rebuild: " +
      "`ff build-features --seasons " + `${cur}-${cur}` + "` then `ff sync-actuals --force` then " +
      "`ff build-streaming-features`.");

    // THE HISTORY IS A RATCHET, not a pass. 283 player-seasons carry their END-of-season team under a
    // September label -- the `u.team` last-wins bug, fixed in src/features/build.ts but NOT yet
    // rebuilt for 1999-2025, because that changes feature VALUES beneath three fitted artifacts and
    // is a refit-and-gate job rather than a rebuild. `populationHash` does NOT cover this: it watches
    // who is in the population, not what their columns say.
    //
    // The count may only go DOWN. If it rises, something re-introduced the bug; if it reaches zero,
    // delete this arm and hold the whole table to zero.
    // 283 -> 210 after the 1999-2025 rebuild (2026-09-19). The RESIDUAL has a known cause and is
    // not the same bug: `teamFirst` comes from the nflverse STATS feed, which only carries weeks a
    // player recorded something in, while `feat_player_week.team` comes from history-weekly, which
    // carries weeks he was merely rostered. Marcus Nash 1999 is the shape -- rostered on BAL in
    // week 1, first STATISTICAL week on DEN, so the pin says DEN. Closing it means giving the season
    // pin the same per-week source the weekly table uses, which is a build-order change, not a
    // one-liner.
    const HISTORICAL_BACKLOG = 210;
    const hist = rows.filter((r) => r.season !== cur);
    assert.ok(hist.length <= HISTORICAL_BACKLOG,
      `historical pin/week-1 disagreements rose to ${hist.length} from the recorded ${HISTORICAL_BACKLOG}. ` +
      "The last-wins team bug is back, or a rebuild wrote later data under the September label.");
  } finally { db.close(); }
});
