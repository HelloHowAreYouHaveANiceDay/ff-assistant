/**
 * NO PRIVATE LEAGUE DATA MAY LEAVE THIS REPO, AND A TEST SAYS SO RATHER THAN A HABIT.
 *
 * The store holds sixteen managers' ESPN account GUIDs, their usernames, eighteen member ids and
 * their complete transaction history -- pulled with the owner's authenticated session from a private
 * league. None of them agreed to publication, and a roster/transaction history is re-identifying on
 * its own to anyone who knows the league.
 *
 * "We remembered to strip it" is exactly the guard that stops being true, so it is asserted here.
 *
 * THE PROPERTY THAT MATTERS MOST is the third test: a table nobody has classified must default to
 * EXCLUDED. An allowlist fails closed -- a new public table is merely missing until someone adds it,
 * which is a bug report. A denylist fails open -- a new private table is published by default, and
 * nobody finds out until it is on the internet. That difference is the entire design.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openDb } from "../src/db/db.js";
import { PUBLISHABLE, planExport, privateColumnsIn, writeExport } from "../src/data/datasetExport.js";

/** Tables that must NEVER appear in an export, named individually so a regression is loud and
 *  specific rather than a count that shifted. */
const MUST_NEVER_EXPORT = [
  "ownership", "league", "draft", "draft_state", "draft_pick", "my_roster", "roster",
  "raw_league_season", "raw_league_team_season", "raw_league_pick", "raw_league_matchup",
  "raw_league_division", "raw_league_roster_week", "raw_league_roster_week_status",
  "raw_league_transaction", "raw_league_transaction_status",
  "fact_team_season", "fact_matchup", "fact_draft_pick", "fact_roster_week", "fact_lineup_week",
  "fact_fa_pool_week", "fact_waiver_claim", "decision_snapshot", "action_log", "matchup",
];

test("the allowlist does not contain a single league table", () => {
  const allowed = new Set(PUBLISHABLE.map((p) => p.table));
  for (const t of MUST_NEVER_EXPORT) {
    assert.ok(!allowed.has(t), `${t} is on the PUBLISHABLE allowlist and carries private league data`);
  }
});

test("every allowlist entry states WHY it is safe", () => {
  // An entry whose justification nobody can write is an entry nobody thought about. This is the
  // cheapest possible defence against a table being added because it was convenient.
  for (const p of PUBLISHABLE) {
    assert.ok(p.why && p.why.length > 8, `PUBLISHABLE entry "${p.table}" has no real justification`);
  }
  assert.equal(new Set(PUBLISHABLE.map((p) => p.table)).size, PUBLISHABLE.length, "duplicate allowlist entry");
});

test("A TABLE NOBODY CLASSIFIED DEFAULTS TO EXCLUDED -- the allowlist fails CLOSED", () => {
  /**
   * The single most important assertion here. A denylist would publish this table; an allowlist
   * does not. The table is given an innocuous name and NO private-looking columns on purpose --
   * if it were caught only by the column scan, this would be testing the scan, not the direction
   * the list fails in.
   */
  const db = openDb(":memory:");
  try {
    db.exec("CREATE TABLE some_new_table_nobody_classified (a TEXT, b INTEGER)");
    db.prepare("INSERT INTO some_new_table_nobody_classified VALUES ('x', 1)").run();
    const plan = planExport(db);
    assert.ok(!plan.tables.some((t) => t.table === "some_new_table_nobody_classified"),
      "an unclassified table was exported -- the allowlist is behaving like a denylist");
    const ex = plan.excluded.find((e) => e.table === "some_new_table_nobody_classified");
    assert.ok(ex, "and it must be REPORTED as excluded, not silently absent");
    assert.match(ex!.reason, /fails CLOSED/);
  } finally { db.close(); }
});

test("an allowlisted table that LATER gains a private column is REFUSED, not quietly dropped", () => {
  // The allowlist is a decision made once; the scan re-checks it every run. A table approved in
  // March that gains a `league_id` in September must stop the export rather than shrink it -- a
  // dataset that quietly got smaller is a dataset nobody audits.
  const db = openDb(":memory:");
  try {
    db.exec("ALTER TABLE raw_combine ADD COLUMN league_id TEXT");
    assert.throws(() => planExport(db), /export REFUSED/);
    assert.throws(() => planExport(db), /raw_combine \(league_id\)/);
  } finally { db.close(); }
});

test("NEGATIVE CONTROL: a player's espn_id is NOT treated as private", () => {
  /**
   * `espn_id` on `player` is a PLAYER identifier -- public, stable, and the join key half the public
   * feeds use. A naive /espn/ pattern would flag `player`, `stg_player` and `market_value`, which
   * are exactly the tables this export exists to publish. Over-blocking would gut the dataset and
   * LOOK like caution, which is why the control is here: a guard that refuses everything passes
   * every leak test in this file.
   */
  const db = openDb(":memory:");
  try {
    assert.deepEqual(privateColumnsIn(db, "player"), [],
      "player was flagged as private -- espn_id is a player id, not a manager id");
    const plan = planExport(db);
    assert.ok(plan.tables.some((t) => t.table === "player"), "the player dimension must be exportable");
    assert.ok(plan.tables.length >= 20, `only ${plan.tables.length} tables exportable -- the guard is over-blocking`);
  } finally { db.close(); }
});

test("the column scan catches league, manager and fantasy-team identity by name", () => {
  const db = openDb(":memory:");
  try {
    for (const col of ["league_id", "owner", "owner_id", "member_id", "team_id", "swid"]) {
      db.exec(`CREATE TABLE probe_${col} (${col} TEXT, x INTEGER)`);
      assert.deepEqual(privateColumnsIn(db, `probe_${col}`), [col], `${col} must be recognised as private`);
    }
    // And the other direction, so the pattern is not simply matching everything.
    db.exec("CREATE TABLE probe_clean (player_sk TEXT, season INTEGER, pts REAL, gsis_id TEXT)");
    assert.deepEqual(privateColumnsIn(db, "probe_clean"), []);
  } finally { db.close(); }
});

// ---------------------------------------------------------------------------------------------
// AGAINST THE REAL STORE -- the only version that can catch a real leak
// ---------------------------------------------------------------------------------------------

const DB = "data/ff.db";

test("REAL STORE: not one exported table carries a private column", { skip: !existsSync(DB) && "no data/ff.db" }, () => {
  const db = new Database(DB, { readonly: true });
  try {
    const plan = planExport(db as never);
    assert.ok(plan.tables.length > 10, `only ${plan.tables.length} tables planned -- this would pass vacuously`);
    for (const t of plan.tables) {
      assert.deepEqual(privateColumnsIn(db as never, t.table), [],
        `${t.table} is being exported and carries league/manager identity`);
    }
  } finally { db.close(); }
});

test("REAL STORE: every known league table is excluded, by name", { skip: !existsSync(DB) && "no data/ff.db" }, () => {
  const db = new Database(DB, { readonly: true });
  try {
    const exported = new Set(planExport(db as never).tables.map((t) => t.table));
    const present = new Set((db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name));
    let checked = 0;
    for (const t of MUST_NEVER_EXPORT) {
      if (!present.has(t)) continue;
      checked++;
      assert.ok(!exported.has(t), `${t} would be EXPORTED -- it holds private league data`);
    }
    assert.ok(checked >= 15, `only ${checked} league tables were present to check -- is this the right store?`);
  } finally { db.close(); }
});

test("REAL STORE: no exported row contains a known manager's username", { skip: !existsSync(DB) && "no data/ff.db" }, () => {
  /**
   * The check that does not depend on column NAMES at all. A manager's handle embedded in a text
   * blob -- a JSON column, a note, a log line -- would pass every schema-level guard above. So the
   * real usernames are read out of the league tables and searched for in the TEXT columns of every
   * table about to be exported.
   */
  const db = new Database(DB, { readonly: true });
  try {
    const owners = (db.prepare(
      "SELECT DISTINCT owner FROM raw_league_team_season WHERE owner IS NOT NULL AND length(owner) > 5",
    ).all() as { owner: string }[]).map((r) => r.owner);
    if (!owners.length) return;                       // nothing to search for
    assert.ok(owners.length >= 5, "expected several managers to search for");

    const plan = planExport(db as never);
    for (const t of plan.tables) {
      const textCols = (db.prepare(`PRAGMA table_info(${t.table})`).all() as { name: string; type: string }[])
        .filter((c) => /CHAR|TEXT|CLOB|BLOB|^$/i.test(c.type)).map((c) => c.name);
      if (!textCols.length) continue;
      // One query per table, OR-ing the columns, so this stays affordable on 1.9M-row tables.
      const where = textCols.map((c) => owners.map(() => `${c} = ?`).join(" OR ")).join(" OR ");
      const params = textCols.flatMap(() => owners);
      const hit = db.prepare(`SELECT COUNT(*) c FROM ${t.table} WHERE ${where}`).get(...params) as { c: number };
      assert.equal(hit.c, 0, `${t.table} contains a manager's username in a text column`);
    }
  } finally { db.close(); }
});

// ---------------------------------------------------------------------------------------------
// STABLE KEYS -- the dataset is only useful to somebody else if they can join it
// ---------------------------------------------------------------------------------------------

test("the crosswalk that makes the dataset joinable is ON the allowlist", () => {
  /**
   * `player_ids` is the DynastyProcess cross-platform map -- the table the fantasy-data ecosystem
   * joins on (`nflreadr::load_ff_playerids()`). The first version of this allowlist omitted it, so
   * the published dataset was keyed ONLY on `player_sk`: a minted surrogate that the store's own
   * `identity_rekey` log shows moving 11,974 of 12,021 keys in a single rebuild. A consumer who
   * joined release N on it and upgraded to N+1 would have silently joined the wrong players, with
   * every row still matching something.
   */
  const allowed = new Set(PUBLISHABLE.map((p) => p.table));
  for (const t of ["player_ids", "player_xref", "stg_player"]) {
    assert.ok(allowed.has(t), `${t} must be published -- without it nobody can key this dataset`);
  }
});

test("REAL STORE: dim_player_key is one row per key and reaches a STABLE external id", { skip: !existsSync(DB) && "no data/ff.db" }, () => {
  // READ-WRITE on purpose: `writeExport` ATTACHes the target, and SQLite refuses to attach a
  // writable database to a read-only connection. Nothing in `main` is modified -- every statement
  // against it is a SELECT, and the only CREATEs are in the attached `pub`.
  const src = new Database(DB);
  const out = join(tmpdir(), `ff-keydim-${process.pid}.db`);
  try {
    const plan = planExport(src as never);
    writeExport(src as never, out, plan);
    const pub = new Database(out, { readonly: true });
    try {
      const n = (sql: string) => (pub.prepare(sql).get() as { c: number }).c;
      const total = n("SELECT COUNT(*) c FROM dim_player_key");
      assert.ok(total > 1000, `dim_player_key has only ${total} rows -- this would pass vacuously`);
      // ONE ROW PER KEY. The first build fanned out: 45 keys carry more than one (name, pos) across
      // a season and the NULL key carried 154, which broke the primary key outright.
      assert.equal(n("SELECT COUNT(*) c FROM (SELECT player_sk FROM dim_player_key GROUP BY player_sk HAVING COUNT(*) > 1)"), 0);
      assert.equal(n("SELECT COUNT(*) c FROM dim_player_key WHERE player_sk IS NULL"), 0);

      // THE POINT: a stable id for the overwhelming majority. `mfl_id` is the crosswalk's own row
      // key and has the best coverage; a floor rather than an exact number, so a rebuild that
      // gains players does not fail this.
      const withMfl = n("SELECT COUNT(*) c FROM dim_player_key WHERE mfl_id IS NOT NULL");
      assert.ok(withMfl / total > 0.9, `only ${(100 * withMfl / total).toFixed(1)}% carry an mfl_id`);

      // AND THE ROUTE IS RECORDED, so a consumer can discount the weaker one. A name-key join is a
      // name join, which this repo distrusts on principle -- it is used only after the exact route
      // has missed, and saying so is what lets somebody else decide whether to trust it.
      const routes = (pub.prepare("SELECT DISTINCT resolved_by FROM dim_player_key").all() as { resolved_by: string }[])
        .map((r) => r.resolved_by);
      for (const r of routes) assert.ok(["xref-gsis", "staged-name-key", "xref-direct", "dst-synthetic", "unresolved"].includes(r), `unknown route ${r}`);
      assert.ok(routes.includes("xref-gsis"), "the EXACT route must actually be used, not just available");

      // THE DIRECT ROUTE (2026-09-19 bug report). Both player_ids routes reach an id only THROUGH
      // that map, so a player it does not carry came out unresolved with every column NULL even
      // where player_xref already held stable ids for his exact key. Asserted as a FLOOR of one so
      // a store whose registry has fewer such players does not fail, but a route that silently
      // stopped resolving anybody does.
      const direct = n("SELECT COUNT(*) c FROM dim_player_key WHERE resolved_by = 'xref-direct'");
      assert.ok(direct > 0, "the xref-direct route resolved nobody -- it is present but not working");
      // Every one of them must actually carry an id. A route that resolves a row to all-NULLs is
      // worse than leaving it unresolved, because it claims to have answered.
      assert.equal(n(`SELECT COUNT(*) c FROM dim_player_key WHERE resolved_by = 'xref-direct'
                       AND gsis_id IS NULL AND pfr_id IS NULL AND sleeper_id IS NULL
                       AND espn_id IS NULL AND fantasypros_id IS NULL`), 0,
        "an xref-direct row carries no ids at all");

      // DST keys are deterministic by construction and need no bridge -- the only keys in the
      // dataset safe to join on directly across releases.
      assert.equal(n("SELECT COUNT(*) c FROM dim_player_key WHERE player_sk LIKE 'DST:%' AND resolved_by <> 'dst-synthetic'"), 0);
    } finally { pub.close(); }
  } finally {
    src.close();
    try { rmSync(out, { force: true }); } catch { /* best effort */ }
  }
});
