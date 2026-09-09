// THE CONTRACT AROUND THE STREAMING BLOCK -- three lists that must agree, and one join that must
// actually deliver.
//
// The failure this file exists for is not a wrong number, it is a column that reaches nobody. A
// streaming feature the artifact declares and `loadWeeklyRows` does not select falls back on its
// declared `missing` default, which for a centred column means "exactly league average" -- so every
// player gets a plausible projection, nothing errors, and the model that was measured is not the
// model that is serving. That has happened in this repo across a repo boundary before; here the two
// halves are four files apart, which is close enough to look safe and far enough to drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.js";
import { WEEKLY_FEATURE_FIELDS, loadWeeklyRows } from "../src/weekly/features.js";
import { STREAM_FIELDS, STREAM_FIELD_NAMES, ensureStreamTable, presentStreamFields } from "../src/weekly/streamingFeatures.js";

/** schema.sql sits beside the source that reads it; the test resolves it from this file rather than
 *  from the process cwd, which the test runner does not promise. */
const SCHEMA_PATH = new URL("../src/db/schema.sql", import.meta.url);

test("every streaming column is in the artifact loader's published dictionary", () => {
  // WEEKLY_FEATURE_FIELDS is `as const` and drives a union type, so the names are written there as
  // literals rather than spread from this list. That is a deliberate trade -- the type is worth it --
  // and this assertion is the price: a typo in either list is otherwise a feature the loader refuses
  // at serve time and nothing catches at build time.
  const declared = new Set<string>(WEEKLY_FEATURE_FIELDS as readonly string[]);
  for (const n of STREAM_FIELD_NAMES) {
    assert.ok(declared.has(n),
      `${n} is a streaming column but is not in WEEKLY_FEATURE_FIELDS -- the artifact loader would ` +
      "REFUSE any artifact that declares it, which is the right failure but a late one");
  }
  assert.equal(new Set(STREAM_FIELD_NAMES).size, STREAM_FIELD_NAMES.length, "a streaming column is declared twice");
  for (const f of STREAM_FIELDS) {
    assert.ok(f.asOf && f.asOf.length > 20,
      `${f.name} has no as-of rule. Every column on this table needs one beside it or it is a leak waiting to happen`);
  }
});

test("schema.sql's CREATE carries exactly the columns STREAM_FIELDS declares", () => {
  // COVERAGE BY ENUMERATION ROTS. schema.sql is hand-written and STREAM_FIELDS is the list the
  // builder writes from; a column added to one and not the other produces a store where the ALTER in
  // `ensureStreamTable` silently repairs a fresh install and nothing repairs the SQL a reader trusts.
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  const block = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS feat_player_week_stream"));
  const body = block.slice(0, block.indexOf(");"));
  for (const f of STREAM_FIELDS) {
    assert.ok(new RegExp(`\\b${f.name}\\s+${f.sql}\\b`).test(body),
      `schema.sql's feat_player_week_stream does not declare ${f.name} ${f.sql}`);
  }
  // FAULT INJECTION ON THIS CHECK: a name that is NOT in the table must not be found, or the regex
  // is matching something other than a column declaration.
  assert.equal(/\bopp_wind_forecast_mph\s+REAL\b/.test(body), false,
    "the check matches a column that does not exist -- it is not reading the CREATE it claims to");
});

test("temperature and wind are NOT built, and the refusal is visible in the dictionary", () => {
  // The most attractive leak available on this table. raw_nfl_game's `temp` and `wind` are OBSERVED
  // -- schema.sql says so -- and a model fitted on them would improve for a reason that cannot exist
  // on a Saturday. This asserts the absence rather than trusting the comment that explains it.
  for (const banned of ["temp", "wind", "temperature", "wind_mph", "weather"]) {
    assert.ok(!STREAM_FIELD_NAMES.some((n) => n === banned || n.endsWith(`_${banned}`)),
      `${banned} is a declared streaming column. Observed weather is lookahead; this store has no ` +
      "forecast feed, so the honest state is the column's absence");
  }
  assert.ok(STREAM_FIELD_NAMES.includes("roof_dome"),
    "roof_dome is absent -- a stadium's roof IS knowable when the schedule is published, and " +
    "dropping it alongside the observed columns would be over-correcting");
});

test("loadWeeklyRows DELIVERS the streaming columns, and reads NULL where the table is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-stream-join-"));
  const db = openDb(join(dir, "join.db"));
  try {
    db.prepare(
      `INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, as_of, name, pos, team,
          opponent, home, is_bye, season_line_pg, td_games, pts, updated_at)
        VALUES ('K1','1',2099,3,'2099-09-20','Kicker','K','AAA','BBB',1,0,8.0,2,9.0,'x')`,
    ).run();

    // (a) NO streaming table at all -- an OLD store, opened by a new binary. schema.sql creates the
    // table on `openDb`, so the case has to be manufactured by dropping it; that is exactly the
    // state a machine with real data was in before this track existed, and naming a missing column
    // in a SELECT is a hard SQLite error rather than a NULL. Every streaming column must read null,
    // which is the same statement a store that HAS the table and no value makes, and nothing throws.
    db.exec("DROP TABLE feat_player_week_stream");
    assert.deepEqual(presentStreamFields(db), []);
    const before = loadWeeklyRows(db, 2099, 3);
    assert.equal(before.length, 1);
    for (const c of STREAM_FIELD_NAMES) {
      assert.equal(before[0].f[c as never] ?? null, null, `${c} is not null on a store without the table`);
    }

    // (b) WITH the table and a row, the values must arrive. This is the assertion that a forgotten
    // join would fail -- and it is the only one that can, because a missing column and a column
    // whose value happens to equal its default are indistinguishable downstream.
    ensureStreamTable(db);
    db.prepare(
      `INSERT INTO feat_player_week_stream (feat_key, player_sk, season, week, as_of, pos, team,
          opponent, opp_pa_pos, opp_pa_pos_n, opp_def_sacks_pg, opp_def_takeaways_pg,
          opp_pass_yds_allowed_pg, opp_rush_yds_allowed_pg, opp_off_sacks_allowed_pg,
          opp_off_giveaways_pg, opp_implied_total, roof_dome, team_fga_pg, team_pat_pg, updated_at)
        VALUES ('K1','1',2099,3,'2099-09-20','K','AAA','BBB',7.5,2,2.4,1.3,231.0,104.0,2.1,1.4,19.5,1,2.2,2.9,'x')`,
    ).run();
    assert.equal(presentStreamFields(db).length, STREAM_FIELD_NAMES.length);
    const after = loadWeeklyRows(db, 2099, 3);
    assert.equal(after[0].f.opp_pa_pos, 7.5);
    assert.equal(after[0].f.roof_dome, 1);
    assert.equal(after[0].f.team_fga_pg, 2.2);
    assert.equal(after[0].f.opp_implied_total, 19.5);
    for (const c of STREAM_FIELD_NAMES) {
      assert.notEqual(after[0].f[c as never] ?? null, null,
        `${c} arrived NULL through loadWeeklyRows despite being written to the table -- the join is ` +
        "not delivering it, and a model declaring it would silently serve on its missing-value default");
    }

    // (c) A model row with NO streaming row must still load, with nulls -- the LEFT join, asserted.
    db.prepare(
      `INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, as_of, name, pos, team,
          opponent, home, is_bye, season_line_pg, td_games, pts, updated_at)
        VALUES ('K2','2',2099,3,'2099-09-20','Other','K','CCC','DDD',0,0,7.0,2,4.0,'x')`,
    ).run();
    const both = loadWeeklyRows(db, 2099, 3);
    assert.equal(both.length, 2, "a model row with no streaming row was dropped -- the join is INNER, not LEFT");
    const orphan = both.find((r) => r.feat_key === "K2")!;
    assert.equal(orphan.f.opp_pa_pos ?? null, null);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
