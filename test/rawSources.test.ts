// THE RAW FEEDS, asserted against arithmetic rather than against themselves.
//
// A raw ingester is the easiest thing in this repo to have silently broken: every fetch is wrapped
// so a missing season does not abort a sweep, which makes a mistyped URL and a season that does not
// exist produce the same clean exit and the same empty table. So these tests do two things a
// re-fetch cannot: they check counts against a number derived from the SPORT (32 teams x 17 games
// / 2 = 272 regular-season games), and they check that the columns the feed exists FOR are actually
// populated, per season, rather than present and null.
//
// They run against the local store when it has been built, and skip with a message otherwise. A
// skipped test that claims to have passed is worse than no test, which is why the guard is on
// `HAVE` and not on a try/catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";

const DB = "data/ff.db";
const HAVE = existsSync(DB);
const open = () => new Database(DB, { readonly: true });

function tableHasRows(t: string): boolean {
  if (!HAVE) return false;
  const db = open();
  try {
    const r = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number };
    return r.c > 0;
  } catch { return false; } finally { db.close(); }
}

// ==================================================================================================
// raw_nfl_game
// ==================================================================================================

test("raw_nfl_game: regular-season counts equal 32 teams x 17 games / 2, and 31 x 16 / 2 before 2002", { skip: !tableHasRows("raw_nfl_game") ? "raw_nfl_game not built" : false }, () => {
  const db = open();
  const rows = db.prepare(
    "SELECT season, SUM(game_type='REG') reg, COUNT(*) n FROM raw_nfl_game GROUP BY season ORDER BY season",
  ).all() as { season: number; reg: number; n: number }[];
  db.close();
  const byYear = new Map(rows.map((r) => [r.season, r]));

  // Hand-checked, from the league's own structure rather than from the file:
  //   1999-2001: 31 teams (Houston joined in 2002), 16 games -> 31*16/2 = 248
  //   2002-2020: 32 teams, 16 games                        -> 32*16/2 = 256
  //   2021-:     32 teams, 17 games                        -> 32*17/2 = 272
  const expect: [number, number][] = [[1999, 248], [2001, 248], [2002, 256], [2015, 256], [2020, 256], [2021, 272], [2023, 272], [2025, 272]];
  for (const [yr, reg] of expect) {
    const r = byYear.get(yr);
    assert.ok(r, `season ${yr} missing from raw_nfl_game`);
    assert.equal(r!.reg, reg, `${yr} regular-season games`);
  }
  // 2023 in full: 272 regular season + 6 wild card + 4 divisional + 2 conference + 1 Super Bowl.
  assert.equal(byYear.get(2023)!.n, 285, "2023 total games including the playoffs");
});

test("raw_nfl_game: the columns this table exists for are POPULATED, not merely present", { skip: !tableHasRows("raw_nfl_game") ? "raw_nfl_game not built" : false }, () => {
  const db = open();
  // Completed seasons only. The live season legitimately has no closing line for games not yet
  // played and no observed temperature at all, and asserting on it would make the test fail every
  // September for a correct reason.
  const rows = db.prepare(
    `SELECT season, COUNT(*) n, SUM(spread_line IS NOT NULL) sp, SUM(total_line IS NOT NULL) tl,
            SUM(roof IS NOT NULL) rf, SUM(home_rest IS NOT NULL) rs, SUM(surface IS NOT NULL) sf
     FROM raw_nfl_game WHERE season BETWEEN 1999 AND 2025 GROUP BY season ORDER BY season`,
  ).all() as { season: number; n: number; sp: number; tl: number; rf: number; rs: number; sf: number }[];
  db.close();
  assert.ok(rows.length >= 27, `expected 27 completed seasons, got ${rows.length}`);
  for (const r of rows) {
    // A Vegas line for every completed game, every season back to 1999. This is the column the
    // whole table is worth having for, and "the feed has it from 1999" is a claim worth a guard.
    assert.equal(r.sp, r.n, `${r.season}: spread_line missing on ${r.n - r.sp} games`);
    assert.equal(r.tl, r.n, `${r.season}: total_line missing on ${r.n - r.tl} games`);
    assert.equal(r.rf, r.n, `${r.season}: roof missing on ${r.n - r.rf} games`);
    // `surface` is NOT complete, and the test says so with the measured number rather than being
    // relaxed to nothing. Measured 2026-09-08: complete 1999-2021, then 278/284 in 2022, 250/285 in
    // 2023 (87.7%, the worst), 283/285 in 2024, 284/285 in 2025. The guard is set below that worst
    // case, so it still catches the failure that matters -- a season silently losing the column
    // entirely, which is what a renamed source field would look like.
    assert.ok(r.sf / r.n >= 0.85, `${r.season}: surface on only ${r.sf}/${r.n} games`);
    assert.equal(r.rs, r.n, `${r.season}: home_rest missing on ${r.n - r.rs} games`);
  }
});

test("raw_nfl_game: as_of is the gameday, never the fetch date", { skip: !tableHasRows("raw_nfl_game") ? "raw_nfl_game not built" : false }, () => {
  const db = open();
  const bad = db.prepare(
    "SELECT COUNT(*) c FROM raw_nfl_game WHERE gameday IS NOT NULL AND (as_of IS NULL OR as_of != gameday)",
  ).get() as { c: number };
  // The point-in-time invariant, stated as a query: a 1999 row must be stamped 1999, and the one way
  // it silently would not be is if `as_of` had been filled from nowIso() like `fetched_at`.
  const late = db.prepare(
    "SELECT COUNT(*) c FROM raw_nfl_game WHERE as_of IS NOT NULL AND CAST(substr(as_of,1,4) AS INTEGER) < season",
  ).get() as { c: number };
  const fetchDated = db.prepare(
    "SELECT COUNT(*) c FROM raw_nfl_game WHERE season < 2020 AND substr(as_of,1,4) = substr(fetched_at,1,4)",
  ).get() as { c: number };
  db.close();
  assert.equal(bad.c, 0, "as_of must equal gameday wherever the feed publishes one");
  assert.equal(late.c, 0, "as_of must not predate its own season");
  assert.equal(fetchDated.c, 0, "a pre-2020 row stamped with this year is as_of taken from the fetch clock");
});

// ==================================================================================================
// raw_injury
// ==================================================================================================

test("raw_injury: the feed starts in 2009 and every season from there has rows", { skip: !tableHasRows("raw_injury") ? "raw_injury not built" : false }, () => {
  const db = open();
  const rows = db.prepare("SELECT season, COUNT(*) n FROM raw_injury GROUP BY season ORDER BY season").all() as { season: number; n: number }[];
  db.close();
  const years = rows.map((r) => r.season);
  // 1999-2008 return HTTP 404 from nflverse. That is a fact about the commons, and it means an
  // injury feature is structurally null for ten of the twenty-seven backtest seasons -- which a
  // model must be told rather than fed zeros for.
  assert.ok(!years.some((y) => y < 2009), `injury rows before 2009: ${years.filter((y) => y < 2009)}`);
  assert.equal(years[0], 2009);
  // Every completed season since must be present and substantial. ~5,000-6,000 rows a year is one
  // report row per listed player per week; a season that drops to a handful is a broken fetch.
  for (let y = 2009; y <= 2024; y++) {
    const r = rows.find((x) => x.season === y);
    assert.ok(r && r.n > 3000, `${y}: ${r?.n ?? 0} injury rows`);
  }
});

test("raw_injury: identity is the source's gsis id, present on every row, and never resolved here", { skip: !tableHasRows("raw_injury") ? "raw_injury not built" : false }, () => {
  const db = open();
  const r = db.prepare("SELECT COUNT(*) n, SUM(gsis_id IS NOT NULL) g FROM raw_injury").get() as { n: number; g: number };
  const cols = (db.prepare("PRAGMA table_info(raw_injury)").all() as { name: string }[]).map((c) => c.name);
  db.close();
  assert.equal(r.g, r.n, `${r.n - r.g} injury rows without a gsis id`);
  // A raw table that carried player_sk would mean identity had been resolved one layer too early.
  assert.ok(!cols.includes("player_sk"), "raw_injury must not carry a surrogate key");
});

test("raw_injury: as_of, where the feed publishes one, lies inside its own season", { skip: !tableHasRows("raw_injury") ? "raw_injury not built" : false }, () => {
  const db = open();
  // The point-in-time guard. A report for the 2014 season cannot be dated 2026, and the one way it
  // silently would be is as_of taken from the fetch clock.
  const bad = db.prepare(
    `SELECT COUNT(*) c FROM raw_injury WHERE as_of IS NOT NULL
       AND (as_of < season || '-06-01' OR as_of > (season + 1) || '-04-01')`,
  ).get() as { c: number };
  const perSeason = db.prepare(
    "SELECT season, COUNT(*) n, SUM(as_of IS NOT NULL) a, GROUP_CONCAT(DISTINCT source_schema) s FROM raw_injury GROUP BY season ORDER BY season",
  ).all() as { season: number; n: number; a: number; s: string }[];
  db.close();
  assert.equal(bad.c, 0, "an injury report dated outside its own season");
  // MEASURED, and recorded because it changes what a weekly feature can do:
  //   2009      -- 17 of 4,821 rows carry date_modified. The as-of is effectively absent.
  //   2010-2024 -- essentially complete.
  //   2025-2026 -- the feed dropped date_modified entirely (source_schema 'no-date-modified'), so
  //                the week anchor has to come from the schedule, in the feature layer.
  const s2024 = perSeason.find((p) => p.season === 2024)!;
  assert.equal(s2024.a, s2024.n, "2024 should carry a report date on every row");
  assert.equal(s2024.s, "classic");
  const late = perSeason.filter((p) => p.season >= 2025);
  for (const p of late) {
    assert.equal(p.s, "no-date-modified", `${p.season} schema`);
    assert.equal(p.a, 0, `${p.season} should have no report date -- the feed stopped publishing one`);
  }
});

test("raw_injury: report_status uses the source's own vocabulary, unmapped", { skip: !tableHasRows("raw_injury") ? "raw_injury not built" : false }, () => {
  const db = open();
  const vals = (db.prepare("SELECT DISTINCT report_status v FROM raw_injury WHERE report_status IS NOT NULL").all() as { v: string }[]).map((r) => r.v).sort();
  db.close();
  // Exactly what the NFL publishes, including "Probable", which the league DISCONTINUED after 2015 --
  // a staging layer may map it, raw may not. A new value appearing here should fail this test and be
  // looked at, not silently absorbed.
  assert.deepEqual(vals, ["Doubtful", "Note", "Out", "Probable", "Questionable"]);
});

// ==================================================================================================
// raw_depth_chart -- the two-schema feed
// ==================================================================================================

test("raw_depth_chart: both source schemas land, and the weekly/daily split is read from the file", { skip: !tableHasRows("raw_depth_chart") ? "raw_depth_chart not built" : false }, () => {
  const db = open();
  const rows = db.prepare(
    `SELECT season, COUNT(*) n, GROUP_CONCAT(DISTINCT source_schema) s, COUNT(DISTINCT week) weeks,
            COUNT(DISTINCT as_of) dates, SUM(depth_rank IS NOT NULL) r
     FROM raw_depth_chart GROUP BY season ORDER BY season`,
  ).all() as { season: number; n: number; s: string; weeks: number; dates: number; r: number }[];
  db.close();
  const by = new Map(rows.map((r) => [r.season, r]));
  // Measured: the feed starts in 2001 (1999 and 2000 are HTTP 404).
  assert.equal(rows[0].season, 2001);
  // The weekly schema, through 2024: ~28,000-38,000 rows a year over ~21 weeks, no dates at all.
  for (const y of [2001, 2010, 2020, 2024]) {
    const r = by.get(y)!;
    assert.equal(r.s, "weekly", `${y} schema`);
    assert.ok(r.weeks >= 17, `${y} has only ${r.weeks} distinct weeks`);
    assert.equal(r.dates, 0, `${y} weekly rows must carry no as_of -- the feed publishes none`);
  }
  // The daily schema. MEASURED AND CORRECTED: probing the 2026 file alone suggested the change
  // began in 2026; ingesting the whole range showed 2025 had already switched, with 219 distinct
  // snapshot dates. This is why the ingester reads the shape from the file header and not the year.
  // 2025 must be PRESENT, not merely consistent if present. Reading the daily file with the weekly
  // column names produces zero rows and a clean exit, so a guard that skips an absent season is a
  // guard that passes on exactly the failure it exists for.
  assert.ok(by.has(2025), "2025 depth-chart rows missing entirely");
  assert.ok(by.get(2025)!.n > 100000, `2025 has only ${by.get(2025)!.n} depth rows`);
  for (const y of [2025, 2026]) {
    const r = by.get(y);
    if (!r) continue;
    assert.equal(r.s, "daily", `${y} schema`);
    assert.equal(r.weeks, 1, `${y} daily rows use the week=0 sentinel only`);
    assert.ok(r.dates > 100, `${y} has only ${r.dates} snapshot dates`);
  }
  // The rank is the column the table exists for, in BOTH schemas -- `depth_team` in one and
  // `pos_rank` in the other. A normalisation that read the wrong name shows up here as a zero.
  for (const r of rows) assert.equal(r.r, r.n, `${r.season}: depth_rank missing on ${r.n - r.r} rows`);
});

// ==================================================================================================
// raw_snap_count
// ==================================================================================================

test("raw_snap_count: 2013-2025 land, 2012 is a header and nothing else, and as_of comes from the game", { skip: !tableHasRows("raw_snap_count") ? "raw_snap_count not built" : false }, () => {
  const db = open();
  const rows = db.prepare(
    "SELECT season, COUNT(*) n, SUM(pfr_player_id IS NOT NULL) p, SUM(as_of IS NOT NULL) a FROM raw_snap_count GROUP BY season ORDER BY season",
  ).all() as { season: number; n: number; p: number; a: number }[];
  const cols = (db.prepare("PRAGMA table_info(raw_snap_count)").all() as { name: string }[]).map((c) => c.name);
  db.close();
  // The 2012 ASSET EXISTS AND IS EMPTY -- a header with no rows. It is absent from this table by
  // design, and the ingest run reports it as a zero-row season with a note rather than as a failure,
  // because "the feed has no 2012" and "our fetch broke" are different facts.
  assert.ok(!rows.some((r) => r.season <= 2012), "2012 has no snap rows -- the asset is a bare header");
  assert.equal(rows[0].season, 2013);
  for (const r of rows) {
    assert.ok(r.n > 20000, `${r.season}: ${r.n} snap rows`);
    // The feed's ONLY player id is the PFR one. If this ever drops, the feature layer's route to
    // player_sk (player_xref, source 'pfr') is gone and every snap feature silently unresolves.
    assert.equal(r.p, r.n, `${r.season}: ${r.n - r.p} rows without a pfr id`);
    // as_of is joined from raw_nfl_game by game_id -- 100% resolved, measured. A drop here means
    // the two feeds' game ids have diverged, which would be invisible in the snap table alone.
    assert.equal(r.a, r.n, `${r.season}: ${r.n - r.a} snap rows could not find their game day`);
  }
  assert.ok(!cols.includes("player_sk") && !cols.includes("gsis_id"), "the snap feed has no gsis id and raw must not invent one");
});

// ==================================================================================================
// raw_nfl_draft_pick
// ==================================================================================================

test("raw_nfl_draft_pick: hand-checked draft sizes, and as_of is the May after the draft", { skip: !tableHasRows("raw_nfl_draft_pick") ? "raw_nfl_draft_pick not built" : false }, () => {
  const db = open();
  const by = new Map((db.prepare(
    "SELECT season, COUNT(*) n, MAX(round) r FROM raw_nfl_draft_pick GROUP BY season",
  ).all() as { season: number; n: number; r: number }[]).map((r) => [r.season, r]));
  const asOf = db.prepare(
    "SELECT COUNT(*) c FROM raw_nfl_draft_pick WHERE as_of != season || '-05-01'",
  ).get() as { c: number };
  db.close();
  // Hand-checked against the real drafts, not against the file: the 2023 NFL draft made 259
  // selections and the 2024 draft made 257, both over seven rounds. Compensatory picks are why
  // neither is a round number.
  assert.equal(by.get(2023)!.n, 259, "2023 NFL draft selections");
  assert.equal(by.get(2024)!.n, 257, "2024 NFL draft selections");
  assert.equal(by.get(2023)!.r, 7);
  assert.equal(asOf.c, 0, "as_of must be the May after each draft");
});

// ==================================================================================================
// raw_participation
// ==================================================================================================

test("raw_participation: 2016-2025, aggregated to player-week, with its own denominators", { skip: !tableHasRows("raw_participation") ? "raw_participation not built" : false }, () => {
  const db = open();
  const rows = db.prepare(
    "SELECT season, COUNT(*) n, COUNT(DISTINCT week) w, SUM(as_of IS NOT NULL) a FROM raw_participation GROUP BY season ORDER BY season",
  ).all() as { season: number; n: number; w: number; a: number }[];
  // Every share this table can produce must be a real share. A player cannot be on the field for
  // more pass plays than his team ran, and cannot have more charted pass plays than total plays --
  // both are the shape a mis-joined aggregation takes, and both are silent in a ratio.
  const impossible = db.prepare(
    "SELECT COUNT(*) c FROM raw_participation WHERE pass_plays > off_plays OR pass_plays > team_pass_plays OR off_plays > team_off_plays",
  ).get() as { c: number };
  db.close();
  assert.equal(rows[0].season, 2016, "the participation feed starts in 2016");
  assert.ok(rows.every((r) => r.season <= 2025), "2026 has no participation asset yet");
  for (const r of rows) {
    assert.ok(r.n > 15000, `${r.season}: ${r.n} player-weeks`);
    assert.ok(r.w >= 21, `${r.season}: only ${r.w} weeks`);
    // as_of is the game day, joined from raw_nfl_game. 100%, measured -- a drop means the two feeds'
    // game ids have diverged, which is invisible in this table alone.
    assert.equal(r.a, r.n, `${r.season}: ${r.n - r.a} rows without a game day`);
  }
  assert.equal(impossible.c, 0, "a player with more plays than his team");
});

// ==================================================================================================
// raw_adp_history
// ==================================================================================================

test("raw_adp_history: each format starts where it measurably starts, and `teams` is not a dimension", { skip: !tableHasRows("raw_adp_history") ? "raw_adp_history not built" : false }, () => {
  const db = open();
  const rows = db.prepare(
    "SELECT format, MIN(season) lo, MAX(season) hi, COUNT(DISTINCT season) n FROM raw_adp_history GROUP BY format ORDER BY format",
  ).all() as { format: string; lo: number; hi: number; n: number }[];
  const teams = (db.prepare("SELECT DISTINCT meta_teams t FROM raw_adp_history").all() as { t: number }[]).map((r) => r.t);
  db.close();
  const by = new Map(rows.map((r) => [r.format, r]));
  // Measured by sweeping 2007-2026 per format. half-ppr -- the format matching THIS league -- has
  // the shortest archive of the three, which is a fact a feature has to be built knowing.
  assert.equal(by.get("standard")!.lo, 2008);
  assert.equal(by.get("ppr")!.lo, 2010);
  assert.equal(by.get("half-ppr")!.lo, 2018);
  // The API accepts `teams` and ignores it: every response's own meta says 12 regardless of what was
  // asked for, and teams=16 is HTTP 400. If this ever becomes more than one value, the source has
  // changed and the "one team count" decision has to be revisited.
  assert.deepEqual(teams, [12]);
});

test("raw_adp_history: as_of is the archive's own window end, and 2008-2009 are BACK-DATED", { skip: !tableHasRows("raw_adp_history") ? "raw_adp_history not built" : false }, () => {
  const db = open();
  const rows = db.prepare(
    "SELECT format, season, MIN(as_of) a, MIN(window_end) w FROM raw_adp_history GROUP BY format, season",
  ).all() as { format: string; season: number; a: string; w: string }[];
  db.close();
  for (const r of rows) assert.equal(r.a, r.w, `${r.format} ${r.season}: as_of must be the window end`);
  // THE TRAP, measured: FFC stamps its 2008 AND 2009 standard archives 2010-06-20 -- a date AFTER
  // both of those seasons were played. Their ADP is therefore NOT knowable at a 2008-09-01 or
  // 2009-09-01 anchor and using it there is leakage. Every other season/format pair is stamped in
  // its own late August or early September, as it should be.
  const backdated = rows.filter((r) => r.a.slice(0, 4) !== String(r.season));
  assert.deepEqual(
    backdated.map((r) => `${r.format} ${r.season} -> ${r.a}`).sort(),
    ["standard 2008 -> 2010-06-20", "standard 2009 -> 2010-06-20"],
    "only the two known back-dated archives may carry an as_of outside their own season",
  );
  // Everything else must be knowable by the September anchor a preseason feature uses.
  for (const r of rows) {
    if (backdated.includes(r)) continue;
    assert.ok(r.a >= `${r.season}-08-01` && r.a <= `${r.season}-10-01`, `${r.format} ${r.season} as_of ${r.a}`);
  }
});
