// ONE KEY SPACE. The registry (`player_identity` + `player_xref`) and staging (`stg_player`) held
// DIFFERENT surrogate keys for the same men for a year: of the 7,961 gsis ids present in both,
// 7,902 disagreed. Nothing failed -- a consumer resolving through the registry simply joined
// nothing, and reported a healthy resolution rate while doing it, because the rate measures whether
// a key was FOUND and not whether the key means anything to the table it will be used against.
//
// These are assertions about the SHAPE of the store after `ff build-identity && ff build-staging`,
// not unit tests of a function, for the same reason test/stgPlayer.test.ts is: the guarantee the
// layer sells is one downstream code is entitled to stop re-checking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";

const DB = "data/ff.db";
const ready = (() => {
  if (!existsSync(DB)) return false;
  try {
    const db = new Database(DB, { readonly: true });
    const n = (db.prepare("SELECT COUNT(*) c FROM stg_player").get() as { c: number }).c;
    const m = (db.prepare("SELECT COUNT(*) c FROM player_xref WHERE source='gsis'").get() as { c: number }).c;
    db.close();
    return n > 0 && m > 0;
  } catch { return false; }
})();
const open = () => new Database(DB, { readonly: true });

// THE MEASUREMENT THAT NAMED THE DEFECT, kept as the guard against its return. It compares the two
// tables through a gsis id -- evidence NEITHER of them owns -- rather than through a count or a
// rate, because a count agreed the whole time the keys disagreed.
test("the registry and staging are ONE key space: every shared gsis id resolves to the same player_sk", (t) => {
  if (!ready) return t.skip("registry/staging not built (run: ff build-identity && ff build-staging)");
  const db = open();
  const r = db.prepare(
    `SELECT COUNT(*) n, SUM(x.player_sk = s.player_sk) same
     FROM player_xref x JOIN stg_player s ON s.gsis_id = x.source_id
     WHERE x.source = 'gsis'`,
  ).get() as { n: number; same: number };
  db.close();
  assert.ok(r.n > 5000, `expected thousands of shared gsis ids to compare, got ${r.n}`);
  assert.equal(r.same, r.n, `${r.n - r.same} of ${r.n} shared gsis ids disagree on player_sk -- ` +
    "staging is minting its own keys again (check the id bag passed to resolveOrMint)");
});

test("every staging key is a registry key -- staging READS the registry, it does not extend it", (t) => {
  if (!ready) return t.skip("registry/staging not built");
  const db = open();
  const orphans = db.prepare(
    "SELECT COUNT(*) c FROM stg_player s WHERE NOT EXISTS (SELECT 1 FROM player_identity i WHERE i.player_sk = s.player_sk)",
  ).get() as { c: number };
  db.close();
  assert.equal(orphans.c, 0);
});

// --- the three men the collapse was measured on ----------------------------------------------------
//
// All three are one `name_key` standing for more than one real person, which is the only case where
// a key space can merge two men without anything looking wrong. They are asserted by BIRTH YEAR
// rather than by key, because the key is an internal integer that is allowed to move and the birth
// year is the thing that must not.

const stagedFor = (db: Database.Database, nk: string) =>
  db.prepare("SELECT player_sk, name, position, team, birthdate, gsis_id, ambiguous FROM stg_player WHERE name_key = ? ORDER BY birthdate")
    .all(nk) as { player_sk: number; name: string; position: string; team: string | null; birthdate: string | null; gsis_id: string | null; ambiguous: number }[];

test("Marvin Harrison Sr. and Jr. are separate players, with their own birth years", (t) => {
  if (!ready) return t.skip("registry/staging not built");
  const db = open();
  const rows = stagedFor(db, "marvinharrison");
  db.close();
  const jr = rows.find((r) => r.birthdate?.startsWith("2002"));
  const sr = rows.find((r) => r.birthdate === "1972-08-25");
  assert.ok(jr, "the son (born 2002) must have a staging row of his own");
  assert.ok(sr, "the father (born 1972-08-25, Syracuse, drafted 1996) must have one too");
  assert.notEqual(jr!.player_sk, sr!.player_sk, "father and son must not share a surrogate key");
  // The son's gsis must be on the SON. It sat on a row carrying his father's 1973 birthdate for
  // months -- a row describing neither man, and exactly as well-formed as a real one.
  assert.equal(jr!.gsis_id, "00-0039849");
  assert.equal(sr!.gsis_id, null, "the father has no gsis in this crosswalk; inventing one would be the same bug");
  // Both flagged, because the name really is shared. A consumer that cannot tell them apart is
  // entitled to skip them, and can only do that if it is told.
  assert.ok(rows.every((r) => r.ambiguous === 1), "every side of a shared name must be flagged");
});

test("the two Justin Jeffersons are two players", (t) => {
  if (!ready) return t.skip("registry/staging not built");
  const db = open();
  const rows = stagedFor(db, "justinjefferson");
  db.close();
  const wr = rows.find((r) => r.position === "WR"), lb = rows.find((r) => r.position === "LB");
  assert.ok(wr && lb, "both the receiver and the linebacker must be staged");
  assert.equal(wr!.birthdate, "1999-06-16");
  assert.equal(lb!.birthdate, "2003-03-20");
  assert.notEqual(wr!.player_sk, lb!.player_sk);
});

test("Lamar Jackson the Ravens QB and Lamar Jackson the Panthers CB are two players", (t) => {
  if (!ready) return t.skip("registry/staging not built");
  const db = open();
  const rows = stagedFor(db, "lamarjackson");
  db.close();
  const qb = rows.find((r) => r.position === "QB"), cb = rows.find((r) => r.position === "CB");
  assert.ok(qb && cb, "both men must be staged");
  assert.equal(qb!.birthdate, "1997-01-07");
  assert.equal(cb!.birthdate, "1998-04-13");
  assert.notEqual(qb!.player_sk, cb!.player_sk);
  assert.equal(qb!.gsis_id, "00-0034796");
  assert.equal(cb!.gsis_id, "00-0036152");
});

// --- the rekey map -------------------------------------------------------------------------------

test("identity_rekey accounts for every old key, and its reasons are internally consistent", (t) => {
  if (!ready) return t.skip("registry/staging not built");
  const db = open();
  const rows = db.prepare("SELECT old_sk, new_sk, reason FROM identity_rekey")
    .all() as { old_sk: number; new_sk: number | null; reason: string }[];
  db.close();
  if (!rows.length) return t.skip("no rekey recorded (a store built fresh, with no old key space)");
  const newOf = new Map<number, Set<number>>(), oldOf = new Map<number, Set<number>>();
  for (const r of rows) {
    if (r.new_sk == null) { assert.equal(r.reason, "dropped"); continue; }
    (newOf.get(r.old_sk) ?? newOf.set(r.old_sk, new Set()).get(r.old_sk)!).add(r.new_sk);
    (oldOf.get(r.new_sk) ?? oldOf.set(r.new_sk, new Set()).get(r.new_sk)!).add(r.old_sk);
  }
  // The reason is DERIVED, so it can be re-derived and must agree. A label nothing can contradict is
  // documentation, not a check.
  for (const r of rows) {
    if (r.new_sk == null) continue;
    const want = (newOf.get(r.old_sk)!.size > 1) ? "split"
      : [...newOf.get(r.old_sk)!].some((n) => oldOf.get(n)!.size > 1) ? "merged"
      : r.new_sk === r.old_sk ? "unchanged" : "moved";
    assert.equal(r.reason, want, `old_sk ${r.old_sk} -> ${r.new_sk} labelled ${r.reason}, shape says ${want}`);
  }
  // Every surviving target must be a real staging key. A map pointing at keys that do not exist is
  // worse than no map: a migration through it looks like it worked.
  const db2 = open();
  const bad = db2.prepare(
    "SELECT COUNT(*) c FROM identity_rekey r WHERE r.new_sk IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stg_player s WHERE s.player_sk = r.new_sk)",
  ).get() as { c: number };
  db2.close();
  assert.equal(bad.c, 0);
});
