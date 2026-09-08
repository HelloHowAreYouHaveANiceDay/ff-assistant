// The ECR-archive ingest. The risk here is not a crash -- it is a silent mis-parse that shifts every
// column, so `ecr` gets read from the team field and the whole table is quietly wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { splitCsv, REDRAFT_TYPES, FPECR_URL } from "../src/data/ecrHistory.js";

test("splitCsv handles quoted fields, embedded commas and escaped quotes", () => {
  assert.deepEqual(splitCsv("a,b,c"), ["a", "b", "c"]);
  // The failure this exists for: an unquoted split shifts every later column and nothing throws.
  assert.deepEqual(splitCsv('a,"Smith, John",c'), ["a", "Smith, John", "c"]);
  assert.deepEqual(splitCsv('a,"say ""hi""",c'), ["a", 'say "hi"', "c"]);
  assert.deepEqual(splitCsv("a,,c"), ["a", "", "c"]);
  assert.deepEqual(splitCsv("a,b,"), ["a", "b", ""]);
  assert.deepEqual(splitCsv('"lead",x'), ["lead", "x"]);
});

test("the ranking types we keep are redraft and weekly only", () => {
  // Dynasty, best-ball and superflex answer a different question than a redraft league asks. Asserted
  // so a future edit that widens this is a deliberate act rather than a drift.
  assert.deepEqual([...REDRAFT_TYPES].sort(), ["ro", "rp", "wo", "wp"]);
  assert.match(FPECR_URL, /^https:\/\/github\.com\/DynastyProcess\/data\/raw\//);
});

// --- against the loaded table, when it exists ------------------------------------------------------
const DB = "data/ff.db";
const hasTable = (() => {
  if (!existsSync(DB)) return false;
  try {
    const db = new Database(DB, { readonly: true });
    const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ranking_history'").get();
    db.close();
    return !!r;
  } catch { return false; }
})();

test("POSITION is part of the key -- distinct people sharing a name must not merge", (t) => {
  if (!hasTable) return t.skip("ranking_history not loaded (run: ff ingest-ecr)");
  const db = new Database(DB, { readonly: true });
  // The concrete case: "A.J. Green" is both a WR and a DB. Without pos in the primary key one
  // overwrites the other on every shared scrape date -- 64 ids spanned multiple positions on the
  // first load, and 811 rows came back when the key was fixed.
  const dupes = db.prepare(
    "SELECT COUNT(*) c FROM (SELECT 1 FROM ranking_history GROUP BY source, ecr_type, scrape_date, player_id, pos HAVING COUNT(*) > 1)",
  ).get() as { c: number };
  assert.equal(dupes.c, 0, "the key must be unique at (source, type, date, player, pos)");
  const green = db.prepare(
    "SELECT DISTINCT pos FROM ranking_history WHERE player_id = 'ajgreen' ORDER BY pos",
  ).all() as { pos: string }[];
  db.close();
  if (green.length) {
    assert.ok(green.length > 1, `A.J. Green should survive as more than one position, got ${green.map((g) => g.pos).join(",")}`);
  }
});

test("a preseason redraft snapshot is retrievable for each recent season", (t) => {
  if (!hasTable) return t.skip("ranking_history not loaded");
  const db = new Database(DB, { readonly: true });
  // The point of the table: what the market believed BEFORE the season, which is what every backtest
  // currently substitutes prior-season finishing rank for.
  for (const season of [2021, 2022, 2023, 2024]) {
    const row = db.prepare(
      `SELECT scrape_date, COUNT(*) n FROM ranking_history
       WHERE ecr_type='ro' AND season=? AND (substr(scrape_date,6,2)='08' OR (substr(scrape_date,6,2)='09' AND CAST(substr(scrape_date,9,2) AS INT)<=7))
       GROUP BY scrape_date ORDER BY scrape_date DESC LIMIT 1`,
    ).get(season) as { scrape_date: string; n: number } | undefined;
    assert.ok(row, `no preseason ro snapshot for ${season}`);
    assert.ok(row!.n > 200, `${season} preseason snapshot has only ${row!.n} players`);
  }
  db.close();
});

test("sd is populated, since that is the column the archive was fetched for", (t) => {
  if (!hasTable) return t.skip("ranking_history not loaded");
  const db = new Database(DB, { readonly: true });
  const r = db.prepare(
    "SELECT COUNT(*) n, SUM(CASE WHEN sd IS NOT NULL THEN 1 ELSE 0 END) withSd FROM ranking_history WHERE ecr_type='ro'",
  ).get() as { n: number; withSd: number };
  db.close();
  assert.ok(r.withSd / r.n > 0.9, `only ${((100 * r.withSd) / r.n).toFixed(0)}% of ro rows carry an sd`);
});
