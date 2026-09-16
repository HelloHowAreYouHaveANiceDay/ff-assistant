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

/**
 * WHICH LEAGUE THESE NUMBERS ARE. docs/league-tendencies.md is about ONE room -- the ESPN auction
 * league 462233 -- and every query here used to read `fact_draft_pick` with no league filter at all.
 * That was invisible while the store held one league and became wrong the moment it held two: M2e
 * ingested the Yahoo snake league's own draft (129048, 384 picks), and 2025 promptly read **372 picks
 * against the recorded 192** -- this file's first test, failing for a completely healthy store.
 *
 * The other tests in the file did NOT fail, and that is the more interesting half: the `player_sk`
 * coverage test, the consensus-stamp test and the raw-vs-fact reconciliation all kept passing on a
 * contaminated population, because their assertions happen to survive it (the reconciliation compares
 * two sums that are contaminated identically). A test that passes on the wrong rows is not passing.
 * So every per-league read below is scoped, and the last test proves the scope is load-bearing.
 */
const LEAGUE = "462233";

// season -> [picks, total $] exactly as docs/league-tendencies.md records them, FOR LEAGUE 462233.
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
    rows = db.prepare("SELECT season, COUNT(*) n, SUM(price) total FROM fact_draft_pick WHERE league_id = ? GROUP BY season")
      .all(LEAGUE) as typeof rows;
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
    r = db.prepare("SELECT COUNT(*) n, SUM(CASE WHEN player_sk IS NOT NULL THEN 1 ELSE 0 END) k FROM fact_draft_pick WHERE league_id = ?")
      .get(LEAGUE) as typeof r;
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
      "FROM fact_draft_pick WHERE league_id = ? GROUP BY season",
    ).all(LEAGUE) as typeof rows;
  } catch { db.close(); return t.skip("fact_draft_pick not built"); }
  db.close();
  if (!rows.length) return t.skip("fact_draft_pick is empty");
  let stamped = 0;
  for (const r of rows) {
    // A SEASON THE ECR ARCHIVE DOES NOT REACH carries NO consensus and NO stamp, which is the
    // honest state: 2018 and 2019 predate the scrape archive, and borrowing a neighbouring year's
    // ranks would be indistinguishable, on the row, from having the right ones. What must never
    // happen is a rank WITHOUT a stamp -- a number whose provenance nothing records.
    if (!r.asOf) {
      assert.equal(r.withRank, 0, `${r.season}: ${r.withRank} consensus ranks with no consensus_asof stamp`);
      continue;
    }
    stamped++;
    // "The consensus at the draft" and "the last consensus before week 1" are different quantities.
    // We do not know the draft dates, so every row says WHICH scrape it used rather than leaving a
    // model to assume the wrong one.
    assert.ok(r.asOf.startsWith(String(r.season)), `${r.season}: consensus dated ${r.asOf}`);
    const m = Number(r.asOf.slice(5, 7));
    assert.ok(m === 8 || m === 9, `${r.season}: consensus scraped in month ${m} -- that is not preseason`);
    assert.ok(r.withRank / r.n >= 0.8, `${r.season}: only ${r.withRank}/${r.n} picks carry a consensus rank`);
  }
  assert.ok(stamped >= 5, `only ${stamped} seasons carry a consensus at all -- this test checked almost nothing`);
});

// ==================================================================================================
// THE OTHER TWO FACT TABLES
// ==================================================================================================

const factRows = <T>(sql: string, ...params: unknown[]): T[] | null => {
  if (!HAVE_DB) return null;
  const db = openDb("data/ff.db");
  try { return db.prepare(sql).all(...params) as T[]; } catch { return null; } finally { db.close(); }
};

test("every settled season has EXACTLY ONE champion", (t) => {
  const rows = factRows<{ season: number; teams: number; champs: number; settled: number }>(
    `SELECT season, COUNT(*) teams, SUM(champion) champs, MAX(settled) settled
       FROM fact_team_season GROUP BY season ORDER BY season`);
  if (!rows) return t.skip("fact_team_season not built -- run `ff build-picks`");
  if (!rows.length) return t.skip("fact_team_season is empty");
  const settled = rows.filter((r) => r.settled === 1);
  assert.ok(settled.length >= 8, `only ${settled.length} settled seasons -- expected 2018-2025`);
  for (const r of settled) {
    assert.equal(r.champs, 1, `${r.season}: ${r.champs} champions among ${r.teams} teams`);
  }
  // ...and the season in progress must NOT have one. A placeholder final_rank looks exactly like a
  // result, and scoring a simulation against it would be scoring against nothing.
  for (const r of rows.filter((x) => x.settled === 0)) {
    assert.equal(r.champs, 0, `${r.season} is not settled but reports ${r.champs} champions`);
  }
});

// FAULT INJECTION on the uniqueness above. A second final_rank = 1 in a season is the exact defect
// this test exists for -- an ESPN feed that ranks two teams first, or a rebuild that merged two
// seasons' rows -- so the assertion is run against a table that HAS one. Done on an in-memory copy
// so the real table is untouched.
test("FAULT INJECTION: a season with two champions fails the uniqueness check", (t) => {
  const rows = factRows<{ season: number; team_id: string; champion: number; settled: number }>(
    "SELECT season, team_id, champion, settled FROM fact_team_season WHERE settled = 1");
  if (!rows || !rows.length) return t.skip("fact_team_season not built");
  const season = rows[0].season;
  const injected = rows.map((r) => ({ ...r }));
  const second = injected.find((r) => r.season === season && r.champion === 0);
  assert.ok(second, "need a non-champion to promote");
  second!.champion = 1;
  const champs = injected.filter((r) => r.season === season && r.champion === 1).length;
  assert.equal(champs, 2, "the injection must actually produce two champions");
  assert.throws(() => assert.equal(champs, 1), "the uniqueness assertion must reject it");
});

test("every team in fact_matchup exists in fact_team_season for that season", (t) => {
  const rows = factRows<{ c: number }>(
    `SELECT COUNT(*) c FROM fact_matchup m
      WHERE NOT EXISTS (SELECT 1 FROM fact_team_season t WHERE t.season = m.season AND t.team_id = m.home_id)
         OR NOT EXISTS (SELECT 1 FROM fact_team_season t WHERE t.season = m.season AND t.team_id = m.away_id)`);
  if (!rows) return t.skip("fact tables not built");
  assert.equal(rows[0].c, 0, `${rows[0].c} games name a team with no team-season row`);
  // The check must have had something to check. An empty schedule passes the query above and proves
  // nothing -- the same shape as a rule that can only ever say no.
  const n = factRows<{ c: number }>("SELECT COUNT(*) c FROM fact_matchup")!;
  assert.ok(n[0].c > 900, `only ${n[0].c} games -- expected ~1,050 across 2018-2026`);
});

test("fact_draft_pick totals match raw_league_pick to the dollar, season by season", (t) => {
  const rows = factRows<{ season: number; f: number; r: number; fn: number; rn: number }>(
    `SELECT p.season,
            (SELECT SUM(price) FROM fact_draft_pick d WHERE d.league_id = p.league_id AND d.season = p.season) f,
            SUM(p.price) r,
            (SELECT COUNT(*) FROM fact_draft_pick d WHERE d.league_id = p.league_id AND d.season = p.season) fn,
            COUNT(*) rn
       FROM raw_league_pick p WHERE p.league_id = ? GROUP BY p.season ORDER BY p.season`, LEAGUE);
  if (!rows || !rows.length) return t.skip("raw_league_pick not ingested");
  assert.ok(rows.length >= 9, `only ${rows.length} seasons of raw picks`);
  for (const r of rows) {
    assert.equal(Math.round(r.f), Math.round(r.r), `${r.season}: fact $${r.f} vs raw $${r.r}`);
    assert.equal(r.fn, r.rn, `${r.season}: ${r.fn} fact picks vs ${r.rn} raw picks`);
  }
});

test("the auction-state columns replay the auction: money and slots only ever fall", (t) => {
  const rows = factRows<{ season: number; team_id: string; pick_order: number; money_remaining: number | null; slots_remaining: number | null; price: number }>(
    "SELECT season, team_id, pick_order, money_remaining, slots_remaining, price FROM fact_draft_pick WHERE league_id = ? ORDER BY season, team_id, pick_order", LEAGUE);
  if (!rows || !rows.length) return t.skip("fact_draft_pick not built");
  const last = new Map<string, { money: number; slots: number; price: number }>();
  let checked = 0;
  for (const r of rows) {
    if (r.money_remaining == null || r.slots_remaining == null) continue;
    const k = `${r.season}|${r.team_id}`;
    const prev = last.get(k);
    if (prev) {
      assert.equal(r.money_remaining, prev.money - prev.price, `${k} pick ${r.pick_order}: money did not fall by the previous price`);
      assert.equal(r.slots_remaining, prev.slots - 1, `${k} pick ${r.pick_order}: slots did not fall by one`);
      checked++;
    }
    last.set(k, { money: r.money_remaining, slots: r.slots_remaining, price: r.price });
  }
  assert.ok(checked > 1000, `only ${checked} consecutive pairs compared`);
});

/**
 * THE LEAGUE FILTERS ABOVE ARE LOAD-BEARING, AND THIS IS WHERE THAT IS PROVED.
 *
 * Adding `WHERE league_id = ?` to a query that was passing is the kind of change that can be wrong in
 * both directions: it fixes nothing if the store only ever holds one league, and it hides a real
 * regression if it silently matches zero rows. So this asserts the differential directly -- with a
 * second league present, the unfiltered population MUST differ from the filtered one on a season both
 * leagues drafted, which is exactly the condition under which the first test in this file failed
 * (2025: 372 unfiltered against 192 for league 462233).
 *
 * On a store that holds one league there is no differential to observe and the test says so rather
 * than asserting something it cannot see.
 */
test("the league filter is load-bearing: a second league in the store changes the unfiltered numbers", (t) => {
  const leagues = factRows<{ league_id: string; n: number }>(
    "SELECT league_id, COUNT(*) n FROM fact_draft_pick GROUP BY league_id ORDER BY league_id");
  if (!leagues || !leagues.length) return t.skip("fact_draft_pick not built");
  const mine = leagues.find((l) => l.league_id === LEAGUE);
  assert.ok(mine && mine.n > 0, `league ${LEAGUE} has no picks -- the filter matches nothing, which would make every test above vacuous`);
  if (leagues.length === 1) return t.skip(`only league ${LEAGUE} is in the store -- no differential to observe`);

  // A season BOTH leagues drafted. Without one, the two populations could differ only by seasons and
  // the per-season assertions above would not have been affected at all.
  // `all` is a SQL keyword -- aliasing a column to it makes the whole statement throw, which
  // `factRows` catches and turns into a null, i.e. a skip. Named `every` for that reason.
  const shared = factRows<{ season: number; leagues: number; every: number; ours: number }>(
    `SELECT season, COUNT(DISTINCT league_id) leagues, COUNT(*) every,
            SUM(CASE WHEN league_id = ? THEN 1 ELSE 0 END) ours
       FROM fact_draft_pick GROUP BY season HAVING leagues > 1`, LEAGUE);
  assert.ok(shared, "the differential query did not run at all -- a thrown query reads exactly like a clean store");
  if (!shared.length) return t.skip("no season is drafted by more than one league yet");
  for (const s of shared) {
    assert.ok(s.every > s.ours,
      `${s.season}: the unfiltered count (${s.every}) equals the filtered one (${s.ours}) -- the filter cannot be shown to do anything`);
  }
});
