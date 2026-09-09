// THE FEATURE-EXTENSION TABLES: identity, point-in-time, and coverage.
//
// These are the three ways a feature table is wrong without being broken.
//
//   IDENTITY  -- it joins the wrong man and returns a coefficient rather than an error.
//   TIME      -- a column carries information from after the moment it claims, and the model that
//                uses it looks excellent and is worthless.
//   COVERAGE  -- a column silently reads zero for a season it should cover; the fit simply has a
//                smaller training set and nothing anywhere says so.
//
// The identity tests run against a FIXTURE staging table, so they assert the RULE rather than
// whatever the live crosswalk happens to contain this week. The time and coverage tests need the
// built tables and skip with a message when they are absent -- a skipped test that reports a pass
// is worse than no test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { buildSourceResolver } from "../src/features/sources/resolve.js";
import type { DB } from "../src/db/db.js";

const DBP = "data/ff.db";
const open = () => new Database(DBP, { readonly: true });

function built(table: string): boolean {
  if (!existsSync(DBP)) return false;
  const db = open();
  try { return ((db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c) > 0; }
  catch { return false; } finally { db.close(); }
}
const skipIf = (t: string) => (built(t) ? false : `${t} not built`);

// ==================================================================================================
// IDENTITY
// ==================================================================================================

/** A staging table holding only the collisions, so the assertion is about the rule. */
function fixtureDb(): DB {
  const db = new Database(":memory:") as unknown as DB;
  db.exec(`CREATE TABLE stg_player (player_sk INTEGER PRIMARY KEY, name_key TEXT, name TEXT,
    position TEXT, team TEXT, birthdate TEXT, gsis_id TEXT, espn_id TEXT, sleeper_id TEXT,
    pfr_id TEXT, fantasypros_id TEXT);`);
  const ins = db.prepare(
    "INSERT INTO stg_player VALUES (@sk,@nk,@n,@p,@t,@b,@g,@e,@s,@pf,@f)",
  );
  // TWO JUSTIN JEFFERSONS: a receiver and a linebacker, four years apart. The board once aged the
  // receiver from the linebacker's birth date.
  ins.run({ sk: 14123, nk: "justinjefferson", n: "Justin Jefferson", p: "WR", t: "MIN", b: "1999-06-16", g: "00-0036322", e: "4262921", s: "6794", pf: "JeffJu00", f: "17257" });
  ins.run({ sk: 12087, nk: "justinjefferson", n: "Justin Jefferson", p: "LB", t: "CLE", b: "2003-03-20", g: "00-0041075", e: "4685702", s: "12070", pf: null, f: null });
  // MARVIN HARRISON SR. AND JR.: both WR, and `nameKey` strips the suffix on purpose, so they share
  // a name key. Only the team (or an id) can separate them.
  ins.run({ sk: 12622, nk: "marvinharrison", n: "Marvin Harrison", p: "WR", t: "IND", b: "1972-08-25", g: "00-0004666", e: "1428", s: null, pf: "HarrMa00", f: null });
  ins.run({ sk: 22001, nk: "marvinharrison", n: "Marvin Harrison Jr.", p: "WR", t: "ARI", b: "2002-08-07", g: "00-0039849", e: "4432708", s: "11624", pf: "HarrMa09", f: "25802" });
  return db;
}

test("identity: an id resolves the exact man, for every id the new feeds carry", () => {
  const db = fixtureDb();
  const r = buildSourceResolver(db);
  assert.equal(r.resolve({ gsis: "00-0036322" }).sk, 14123, "gsis -> the receiver");
  assert.equal(r.resolve({ gsis: "00-0041075" }).sk, 12087, "gsis -> the linebacker");
  assert.equal(r.resolve({ espn: "4432708" }).sk, 22001, "espn id -> Harrison Jr.");
  assert.equal(r.resolve({ sleeper: "6794" }).sk, 14123);
  assert.equal(r.resolve({ fantasypros: "25802" }).sk, 22001);
  db.close();
});

test("identity: the two Justin Jeffersons and the two Marvin Harrisons stay two people", () => {
  const db = fixtureDb();
  const r = buildSourceResolver(db);
  const wr = r.resolve({ name: "Justin Jefferson", pos: "WR", team: "MIN" });
  const lb = r.resolve({ name: "Justin Jefferson", pos: "LB", team: "CLE" });
  assert.equal(wr.sk, 14123);
  assert.equal(lb.sk, 12087);
  assert.notEqual(wr.sk, lb.sk);
  // Both Harrisons are WRs with the same name key. TEAM is the only thing that separates them, and
  // it is why the (name, position, team) rule exists at all.
  const sr = r.resolve({ name: "Marvin Harrison", pos: "WR", team: "IND" });
  const jr = r.resolve({ name: "Marvin Harrison Jr.", pos: "WR", team: "ARI" });
  assert.equal(sr.sk, 12622);
  assert.equal(jr.sk, 22001);
  assert.notEqual(sr.sk, jr.sk);
  assert.equal(sr.by, "name-pos-team");
  db.close();
});

// FAULT INJECTION on identity. Take the team away -- which is what a feed with no team column, or a
// resolver that forgot to pass it, would do -- and the answer must be NOBODY, not a plausible one of
// the two. A resolver that guesses here reproduces the bug this whole layer exists to prevent, and
// it would pass every test above.
test("FAULT: without a team, a shared name key resolves to nobody rather than to a guess", () => {
  const db = fixtureDb();
  const r = buildSourceResolver(db);
  const guess = r.resolve({ name: "Marvin Harrison", pos: "WR" });
  assert.equal(guess.sk, null, `resolved to ${guess.sk} by ${guess.by} -- it must refuse`);
  assert.equal(guess.by, "unresolved");
  // And with the team back, it resolves again -- so the refusal is a REFUSAL and not a dead rule
  // that can never return anything. A guard that can only ever say no is not a guard.
  assert.equal(r.resolve({ name: "Marvin Harrison", pos: "WR", team: "ARI" }).sk, 22001);
  db.close();
});

test("identity: a PFR id resolves the exact man -- it is the snap feed's only route", () => {
  const db = fixtureDb();
  const r = buildSourceResolver(db);
  // Until Phase 2c a pfr id was mapped through `player_ids` to (name_key, position) and then into
  // staging, so `HarrMa00` -- a per-PERSON id -- landed on a pair two men share and had to refuse.
  // The id now lives on the staged row itself, which is the only route that can tell them apart.
  assert.equal(r.resolve({ pfr: "HarrMa00" }).sk, 12622, "the father");
  assert.equal(r.resolve({ pfr: "HarrMa09" }).sk, 22001, "the son");
  assert.equal(r.resolve({ pfr: "HarrMa00" }).by, "pfr");
  // A pfr id nobody carries still resolves to nobody. The positive answers above are what make this
  // a check rather than a rule that can only ever say no.
  assert.equal(r.resolve({ pfr: "NoSuchPf00" }).sk, null);
  db.close();
});

// FAULT INJECTION on the pfr route: an id two staged rows claim must resolve to NOBODY, on the same
// rule as a disputed gsis. Built by hand here because the live crosswalk may hold no such pair.
test("FAULT: a PFR id claimed by two staged players resolves to nobody", () => {
  const db = fixtureDb();
  db.prepare("UPDATE stg_player SET pfr_id = 'HarrMa00' WHERE player_sk = 22001").run();
  const r = buildSourceResolver(db);
  assert.equal(r.resolve({ pfr: "HarrMa00" }).sk, null, "a disputed id must not pick a side");
  db.close();
});

// ==================================================================================================
// POINT-IN-TIME
// ==================================================================================================

test("feat_player_week_context: as_of is strictly before this team's own kickoff", { skip: skipIf("feat_player_week_context") }, () => {
  const db = open();
  const bad = db.prepare(
    `SELECT COUNT(*) c FROM feat_player_week_context c
     JOIN raw_nfl_game g ON g.season = c.season AND g.week = c.week AND g.game_type = 'REG'
       AND (g.home_team = c.team OR g.away_team = c.team)
     WHERE c.as_of IS NOT NULL AND g.gameday IS NOT NULL AND c.as_of >= g.gameday`,
  ).get() as { c: number };
  db.close();
  assert.equal(bad.c, 0, "a context row dated on or after the game it describes");
});

test("feat_player_week_context: every ARCHIVE Friday injury status is backed by a report filed by then", { skip: skipIf("feat_player_week_context") }, () => {
  const db = open();
  // THE LEAKAGE GUARD. A status in the Friday column must correspond to a raw_injury row for the
  // same man and week whose report date is at or before that Friday -- i.e. at or before
  // (this team's gameday - 2). A status sourced from a later filing is information from the future
  // wearing a Friday label, and nothing else in the pipeline would notice.
  //
  // SCOPED TO source = 'archive', AND THE SCOPE IS THE POINT. The table now has two builders under
  // two different guarantees. `buildWeekContext` reads `raw_injury` and places each designation by
  // the date it was FILED, which is what makes this back-join meaningful. `buildLiveWeekContext`
  // reads a status FEED for a season the archive does not cover -- it publishes a current state and
  // one timestamp and files nothing, so there is no filing to join to and never will be. Running
  // this query over those rows reports a leak that does not exist.
  //
  // The scope is read off the ROW, not inferred from the season number and not from the shape of
  // `as_of`: the builder stamps `source`, so a row that claims the archive guarantee is held to it
  // whatever season it is in. The live rows get their own, different assertion in the next test --
  // they are not exempted, they are checked against the guarantee they actually carry.
  const bad = db.prepare(
    `SELECT COUNT(*) c FROM feat_player_week_context ctx
     JOIN stg_player s ON s.player_sk = ctx.player_sk
     JOIN raw_nfl_game g ON g.season = ctx.season AND g.week = ctx.week AND g.game_type = 'REG'
       AND (g.home_team = ctx.team OR g.away_team = ctx.team)
     WHERE ctx.report_status_fri IS NOT NULL AND s.gsis_id IS NOT NULL
       AND COALESCE(ctx.source, 'archive') = 'archive'
       AND NOT EXISTS (
         SELECT 1 FROM raw_injury i
         WHERE i.season = ctx.season AND i.week = ctx.week AND i.gsis_id = s.gsis_id
           AND i.report_status = ctx.report_status_fri
           AND i.as_of IS NOT NULL AND i.as_of <= date(g.gameday, '-2 day'))
       AND NOT EXISTS (
         -- The same check for a row the resolver reached by (name, position, team) rather than by
         -- gsis. 42 rows are attributed that way, and every one of them is a case where the injury
         -- feed's gsis for a shared name differs from staging's -- so a gsis-only back-join calls
         -- them unbacked when the report exists under the same man's NAME. The fallback is here
         -- rather than in the guard's threshold, because a threshold would also absorb a real leak.
         SELECT 1 FROM raw_injury i2
         WHERE i2.season = ctx.season AND i2.week = ctx.week AND i2.full_name = s.name
           AND i2.report_status = ctx.report_status_fri
           AND i2.as_of IS NOT NULL AND i2.as_of <= date(g.gameday, '-2 day'))`,
  ).get() as { c: number };
  const have = db.prepare(
    "SELECT COUNT(*) c FROM feat_player_week_context WHERE report_status_fri IS NOT NULL AND COALESCE(source, 'archive') = 'archive'",
  ).get() as { c: number };
  db.close();
  // The guard must have something to guard. A zero here would make the assertion below vacuous,
  // which is the exact failure mode a passing check hides. Scoping by `source` could have produced
  // exactly that -- a scope that quietly matches nothing -- so the count is asserted INSIDE the
  // scope rather than over the whole table.
  assert.ok(have.c > 5000, `only ${have.c} ARCHIVE rows carry a Friday status -- the guard would be vacuous`);
  assert.equal(bad.c, 0, "a Friday status not backed by a report filed by Friday");
});

test("feat_player_week_context: every LIVE row precedes its week's first kickoff", { skip: skipIf("feat_player_week_context") }, () => {
  const db = open();
  // THE LIVE ROWS' OWN GUARANTEE, and it is a different one. There is no filing behind a live status
  // to back-join to, so what has to hold instead is the point-in-time rule the live builder places
  // the whole snapshot by: the snapshot time must be BEFORE the week's first kickoff. A snapshot
  // taken after it is contaminated by a game already played -- a man carted off on Thursday is "Out"
  // in a feed read on Friday -- and would be information from the future wearing a week label,
  // exactly the failure the archive guard catches by a different route.
  const rows = db.prepare(
    `SELECT ctx.season, ctx.week, ctx.as_of, k.first_kick FROM feat_player_week_context ctx
     JOIN (SELECT season, week, MIN(gameday) AS first_kick FROM raw_nfl_game
            WHERE game_type = 'REG' AND gameday IS NOT NULL GROUP BY season, week) k
       ON k.season = ctx.season AND k.week = ctx.week
     WHERE ctx.source = 'live'`,
  ).all() as { season: number; week: number; as_of: string; first_kick: string }[];
  db.close();
  if (!rows.length) {
    // A store built before the live builder ran has no such rows, and that is not a failure. It IS
    // reported, because "the check found nothing" and "the check passed" must not read the same.
    console.log("  (no live-sourced context rows in this store -- nothing to check)");
    return;
  }
  const late = rows.filter((r) => r.as_of.slice(0, 10) >= r.first_kick);
  assert.deepEqual(late, [],
    "a live context row was stamped at or after its own week's first kickoff, so its injury " +
    "designations could already reflect a game that has been played");
  // And the rows must be for a season the ARCHIVE does not cover, or the archive builder should own
  // them: two builders writing the same week would leave the surviving guarantee up to run order.
  const db2 = open();
  const overlap = db2.prepare(
    `SELECT COUNT(*) c FROM feat_player_week_context ctx
      WHERE ctx.source = 'live'
        AND EXISTS (SELECT 1 FROM raw_injury i WHERE i.season = ctx.season AND i.as_of IS NOT NULL)`,
  ).get() as { c: number };
  db2.close();
  assert.equal(overlap.c, 0,
    "a live-sourced row exists for a season whose injury archive carries dated filings -- the " +
    "archive builder owns those weeks, and two builders writing one week leaves which guarantee " +
    "survives up to run order");
});

test("feat_player_season_ext: the anchor is September 1 and nothing is stamped later", { skip: skipIf("feat_player_season_ext") }, () => {
  const db = open();
  const bad = db.prepare("SELECT COUNT(*) c FROM feat_player_season_ext WHERE as_of != season || '-09-01'").get() as { c: number };
  // The draft cannot be in the future relative to the row it describes.
  const draft = db.prepare("SELECT COUNT(*) c FROM feat_player_season_ext WHERE draft_year IS NOT NULL AND draft_year > season").get() as { c: number };
  // THE ADP WINDOW CLOSES AFTER SEPTEMBER 1, and that is a fact about the source rather than a bug.
  // Measured: 2013 closes 09-04, 2015 09-09, 2016 09-02, 2017 09-04, 2018 09-04, 2019 09-04, 2022
  // 09-04 -- seven of thirteen seasons, ~180 players each. The anchor `as_of` is 09-01 because that
  // is what feat_player_season uses and the two must join row for row.
  //
  // So the invariant that MEANS something is not "before September 1", it is BEFORE THE SEASON'S
  // FIRST KICKOFF -- the moment after which any market number is contaminated by results. That is
  // the boundary a consumer actually cares about, and it is the one asserted. `adp_as_of` is stored
  // on every row so a consumer wanting the stricter rule can apply it.
  const adpAfterKickoff = db.prepare(
    `SELECT COUNT(*) c FROM feat_player_season_ext e
     WHERE e.adp_as_of IS NOT NULL
       AND e.adp_as_of >= (SELECT MIN(g.gameday) FROM raw_nfl_game g
                           WHERE g.season = e.season AND g.game_type = 'REG' AND g.gameday IS NOT NULL)`,
  ).get() as { c: number };
  const adpAfterAnchor = db.prepare("SELECT COUNT(*) c FROM feat_player_season_ext WHERE adp_as_of IS NOT NULL AND adp_as_of > as_of").get() as { c: number };
  db.close();
  assert.equal(bad.c, 0);
  assert.equal(draft.c, 0, "a player drafted after the season the row describes");
  assert.equal(adpAfterKickoff.c, 0, "an ADP whose window closed on or after the season's first game");
  // Recorded as a number rather than asserted to zero, so the day it grows is visible in a diff.
  assert.ok(adpAfterAnchor.c > 0 && adpAfterAnchor.c < 1500, `${adpAfterAnchor.c} rows have an ADP window closing after the 09-01 anchor`);
});

// ==================================================================================================
// COVERAGE
// ==================================================================================================

test("feat_coverage: no column silently drops to zero in a season it should cover", { skip: skipIf("feat_coverage") }, () => {
  const db = open();
  const cov = db.prepare("SELECT table_name t, column_name c, season s, rows, non_null FROM feat_coverage").all() as { t: string; c: string; s: number; rows: number; non_null: number }[];
  db.close();
  const get = (t: string, c: string, s: number) => cov.find((x) => x.t === t && x.c === c && x.s === s);

  // The season each column CAN cover, from the feeds' own measured start dates in
  // docs/data-sources.md. A column expected to cover a season and reading zero there is the failure
  // this table exists to make visible.
  const WEEK: [string, number][] = [
    ["opponent", 2013], ["home", 2013], ["days_rest", 2013], ["roof", 2013],
    ["spread_line", 2013], ["total_line", 2013], ["implied_team_total", 2013],
    ["depth_rank", 2013],
    ["prior_snap_share", 2014],          // snap counts start 2013, so a PRIOR week exists from 2013
    ["prior_route_share", 2016],         // participation starts 2016
  ];
  for (const [col, from] of WEEK) {
    for (let s = from; s <= 2025; s++) {
      const r = get("feat_player_week_context", col, s);
      assert.ok(r, `no coverage row for feat_player_week_context.${col} ${s}`);
      assert.ok(r!.non_null > 0, `feat_player_week_context.${col} is EMPTY in ${s} (${r!.rows} rows)`);
    }
  }
  // The injury report is the exception, and it is a fact about the FEED rather than about us: from
  // 2025 nflverse stopped publishing `date_modified`, so no report can be placed before a Friday
  // cutoff and the column is correctly empty. Asserted explicitly so the day it comes back is a
  // test failure someone reads rather than a silent change.
  for (let s = 2013; s <= 2024; s++) {
    const r = get("feat_player_week_context", "report_status_fri", s)!;
    assert.ok(r.non_null > 0, `report_status_fri empty in ${s}`);
  }
  const y2025 = get("feat_player_week_context", "report_status_fri", 2025);
  if (y2025) assert.equal(y2025.non_null, 0, "2025 injuries carry no report date -- see docs/data-sources.md");

  const SEASON: [string, number][] = [
    ["draft_round", 2013], ["draft_pick", 2013], ["draft_year", 2013],
    ["contract_year", 2013], ["adp", 2013], ["adp_as_of", 2013],
    ["depth_rank_sep1", 2013], ["prior_snap_share", 2014], ["prior_carries_per_game", 2013],
    ["prior_carry_share", 2013], ["prior_air_yards_share", 2013], ["prior_wopr", 2013],
    ["prior_route_share", 2017],
  ];
  for (const [col, from] of SEASON) {
    for (let s = from; s <= 2025; s++) {
      const r = get("feat_player_season_ext", col, s);
      assert.ok(r, `no coverage row for feat_player_season_ext.${col} ${s}`);
      assert.ok(r!.non_null > 0, `feat_player_season_ext.${col} is EMPTY in ${s} (${r!.rows} rows)`);
    }
  }
});

test("feat_player_season_ext: shares are shares, and face-valid for players we can check by hand", { skip: skipIf("feat_player_season_ext") }, () => {
  const db = open();
  const impossible = db.prepare(
    `SELECT COUNT(*) c FROM feat_player_season_ext
     WHERE (prior_snap_share IS NOT NULL AND (prior_snap_share < 0 OR prior_snap_share > 1.05))
        OR (prior_route_share IS NOT NULL AND (prior_route_share < 0 OR prior_route_share > 1.05))
        OR (prior_carry_share IS NOT NULL AND (prior_carry_share < 0 OR prior_carry_share > 1.05))`,
  ).get() as { c: number };
  // FACE VALIDITY, and it is here because the first version of prior_snap_share divided by the sum
  // of every player's snaps instead of by the team's plays -- eleven men on the field for each one,
  // so the share came out an order of magnitude small while still looking like a number. Christian
  // McCaffrey's 2023 read 0.069, a bench player's share, and nothing about that was an error.
  const cmc = db.prepare(
    `SELECT e.prior_snap_share ss, e.prior_route_share rs FROM feat_player_season_ext e
     JOIN stg_player s ON s.player_sk = e.player_sk
     WHERE e.season = 2024 AND s.name_key = 'christianmccaffrey'`,
  ).get() as { ss: number | null; rs: number | null } | undefined;
  db.close();
  assert.equal(impossible.c, 0, "a share outside [0, 1]");
  if (cmc) {
    assert.ok(cmc.ss != null && cmc.ss > 0.5, `McCaffrey's 2023 snap share read ${cmc.ss} -- a workhorse back is not a bench player`);
    assert.ok(cmc.rs != null && cmc.rs > 0.5, `McCaffrey's 2023 route share read ${cmc.rs}`);
  }
});

test("feat_player_week_context: a known OUT week lands on the right man, with his team-mate counted", { skip: skipIf("feat_player_week_context") }, () => {
  const db = open();
  // Baltimore, 2023 week 4: Rashod Bateman and Odell Beckham were both listed Out on the Friday
  // report. Each must therefore see exactly one same-position team-mate Out, and each must be
  // joined to his OWN surrogate key -- which is the assertion, because a name-keyed join here
  // returns a row either way.
  const rows = db.prepare(
    `SELECT s.name, c.player_sk, c.report_status_fri, c.teammates_out, c.as_of
     FROM feat_player_week_context c JOIN stg_player s ON s.player_sk = c.player_sk
     WHERE c.season = 2023 AND c.week = 4 AND c.team = 'BAL' AND c.pos = 'WR'
       AND s.name_key IN ('rashodbateman', 'odellbeckham')
     ORDER BY s.name`,
  ).all() as { name: string; player_sk: number; report_status_fri: string; teammates_out: number; as_of: string }[];
  db.close();
  assert.equal(rows.length, 2, `expected two Baltimore receivers, got ${rows.length}`);
  const sks = new Set(rows.map((r) => r.player_sk));
  assert.equal(sks.size, 2, "two men, two keys");
  for (const r of rows) {
    assert.equal(r.report_status_fri, "Out", `${r.name} status`);
    assert.equal(r.teammates_out, 1, `${r.name} should see exactly one same-position team-mate Out`);
    // The week-4 anchor: Baltimore played on 2023-10-01, so the row is dated the day before.
    assert.equal(r.as_of, "2023-09-30", `${r.name} as_of`);
  }
});
