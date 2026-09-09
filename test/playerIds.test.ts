/**
 * DEFECT D2: the crosswalk merged a father and a son into one row that describes neither.
 *
 * `nameKey` strips generational suffixes ON PURPOSE, so Marvin Harrison and Marvin Harrison Jr. --
 * two real receivers, born twenty-nine years apart -- arrive at `player_ids` as one key. The ingest
 * used to resolve that with `ON CONFLICT DO UPDATE`, which takes name, team and birthdate from the
 * LAST row and COALESCEs the ids from the FIRST. The shipped store therefore held:
 *
 *     marvinharrison | WR | Marvin Harrison | IND | 1973-08-26 | gsis 00-0039849 | espn 4432708
 *
 * -- the father's name, team and birth date carrying the SON's ids. Age 52 on a rookie, and no error
 * anywhere, because a merged row is exactly as well-formed as a real one.
 *
 * The fixture is the real pair, with the real dates and ids.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.js";
import { ingestPlayerIds, variantsFor } from "../src/data/playerIds.js";

const HEADER = "name,position,team,birthdate,gsis_id,espn_id,sleeper_id,yahoo_id,pfr_id,fantasypros_id,mfl_id,sportradar_id";
const HARRISONS = [
  "Marvin Harrison,WR,IND,1972-08-25,00-0002899,1234,NA,NA,HarrMa00,1010,NA,NA",
  "Marvin Harrison Jr.,WR,ARI,2002-08-07,00-0039849,4432708,NA,NA,HarrMa01,24029,NA,NA",
  // A control: one man, one row, one birth date. He must come through untouched.
  "Ja'Marr Chase,WR,CIN,2000-03-01,00-0036900,4362628,NA,NA,ChasJa00,19798,NA,NA",
];

function ingestFixture(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "ff-pids-"));
  const csv = join(dir, "ids.csv");
  writeFileSync(csv, [HEADER, ...lines].join("\n") + "\n", "utf8");
  const dbPath = join(dir, "t.db");
  return { dir, csv, dbPath };
}

test("two Harrisons stay two people: the merged row is refused, both variants are kept", async (t) => {
  const { dir, csv, dbPath } = ingestFixture(HARRISONS);
  const cleanup: (() => void)[] = [];
  t.after(() => { for (const f of cleanup.reverse()) f(); rmSync(dir, { recursive: true, force: true }); });

  const res = await ingestPlayerIds({ dbPath, file: csv });
  assert.equal(res.collided, 1, "exactly one colliding key was expected");
  assert.equal(res.variants, 2, "both Harrisons must be recorded in player_ids_variant");

  const db = openDb(dbPath);
  cleanup.push(() => db.close());
  const row = db.prepare("SELECT * FROM player_ids WHERE name_key = 'marvinharrison' AND position = 'WR'")
    .get() as Record<string, unknown>;
  assert.ok(row, "the key must still exist -- the fix is not to delete the man");
  assert.equal(row.ambiguous, 1, "the key must be FLAGGED, not silently resolved");

  // THE ASSERTION THAT MATTERS. Any single birth date here is a claim about one of two people, and
  // whichever one it is, it is wrong for the other. The only honest value is none.
  assert.equal(row.birthdate, null,
    `birthdate is ${JSON.stringify(row.birthdate)} -- a merged row picked a side. ` +
    `1973/1972 ages the SON at 52; 2002 ages the FATHER at 23.`);
  assert.equal(row.gsis_id, null, "the two men have different gsis ids; neither may be presented as this key's");
  assert.equal(row.espn_id, null, "same for espn");
  // What they genuinely agree about survives -- a fix that blanked the whole row would pass the
  // assertions above and destroy information for no reason.
  assert.equal(row.position, "WR");

  const v = variantsFor(db, "Marvin Harrison", "WR");
  assert.equal(v.length, 2);
  assert.deepEqual(v.map((x) => x.birthdate), ["1972-08-25", "2002-08-07"]);
  assert.equal(v[1].gsis_id, "00-0039849", "the son's own row must carry the son's own id");
  assert.equal(v[0].gsis_id, "00-0002899", "and the father's, the father's");

  // THE CONTROL, and it is the half that a blanket "NULL everything ambiguous" fix would fail: an
  // unambiguous player must be completely unaffected.
  const chase = db.prepare("SELECT * FROM player_ids WHERE name_key = 'jamarrchase'").get() as Record<string, unknown>;
  assert.equal(chase.birthdate, "2000-03-01");
  assert.equal(chase.gsis_id, "00-0036900");
  assert.equal(chase.ambiguous, 0);
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM player_ids_variant").get() as { c: number }).c, 2,
    "only the colliding key writes variants",
  );
});

test("re-running the ingest is idempotent and does not accumulate variants", async (t) => {
  const { dir, csv, dbPath } = ingestFixture(HARRISONS);
  const cleanup: (() => void)[] = [];
  t.after(() => { for (const f of cleanup.reverse()) f(); rmSync(dir, { recursive: true, force: true }); });
  await ingestPlayerIds({ dbPath, file: csv });
  const second = await ingestPlayerIds({ dbPath, file: csv });
  assert.equal(second.collided, 1);
  const db = openDb(dbPath);
  cleanup.push(() => db.close());
  assert.equal((db.prepare("SELECT COUNT(*) c FROM player_ids_variant").get() as { c: number }).c, 2);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM player_ids WHERE name_key='marvinharrison'").get() as { c: number }).c, 1);
});
