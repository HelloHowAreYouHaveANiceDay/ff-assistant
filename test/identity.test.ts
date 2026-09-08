// The identity registry. The property under test is STABILITY: a surrogate key, once minted, must
// survive rebuilds and new information. Everything else in the store can be regenerated; keys cannot,
// because other tables point at them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildIdentity, resolveOrMint, linkId } from "../src/data/identity.js";

const DB = "data/ff.db";
const ready = (() => {
  if (!existsSync(DB)) return false;
  try {
    const db = new Database(DB, { readonly: true });
    const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='player_identity'").get();
    const n = r ? (db.prepare("SELECT COUNT(*) c FROM player_identity").get() as { c: number }).c : 0;
    db.close();
    return n > 0;
  } catch { return false; }
})();

/** A disposable copy, because these tests mutate. */
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "ffid-"));
  const p = join(d, "ff.db");
  copyFileSync(DB, p);
  for (const ext of ["-wal", "-shm"]) if (existsSync(DB + ext)) copyFileSync(DB + ext, p + ext);
  return p;
}

test("rebuilding mints nothing and moves no key -- the foundation property", (t) => {
  if (!ready) return t.skip("registry not built (run: ff build-identity)");
  const p = scratch();
  const before = new Map((new Database(p, { readonly: true })
    .prepare("SELECT player_sk, name_key, position FROM player_identity").all() as { player_sk: number; name_key: string; position: string }[])
    .map((r) => [`${r.name_key}|${r.position}`, r.player_sk]));
  const r = buildIdentity(p);
  assert.equal(r.minted, 0, `a rebuild minted ${r.minted} keys -- the registry is not stable`);
  const after = new Database(p, { readonly: true })
    .prepare("SELECT player_sk, name_key, position FROM player_identity").all() as { player_sk: number; name_key: string; position: string }[];
  for (const a of after) {
    const was = before.get(`${a.name_key}|${a.position}`);
    if (was !== undefined) assert.equal(a.player_sk, was, `${a.name_key}/${a.position} changed key ${was} -> ${a.player_sk}`);
  }
});

test("nobody is absorbed: every crosswalk player has their own key", (t) => {
  if (!ready) return t.skip("registry not built");
  const db = new Database(DB, { readonly: true });
  const ids = (db.prepare("SELECT COUNT(*) c FROM player_ids").get() as { c: number }).c;
  const sks = (db.prepare("SELECT COUNT(*) c FROM player_identity").get() as { c: number }).c;
  db.close();
  // The failure this catches actually happened: matching on a DISPUTED gsis absorbed 15 players into
  // other people's keys, and Bobby McCray -- who shares gsis 00-0022888 with punter Jake Schum --
  // ended up with no identity row at all.
  assert.equal(sks, ids, `${ids - sks} players were absorbed into someone else's key`);
});

test("a disputed id neither matches nor gets recorded", (t) => {
  if (!ready) return t.skip("registry not built");
  const db = new Database(DB, { readonly: true });
  const disputed = db.prepare(
    `SELECT gsis_id v FROM player_ids WHERE gsis_id IS NOT NULL
     GROUP BY gsis_id HAVING COUNT(DISTINCT name_key || '|' || position) > 1`,
  ).all() as { v: string }[];
  for (const d of disputed) {
    const claimants = db.prepare("SELECT name_key, position FROM player_ids WHERE gsis_id = ?").all(d.v) as { name_key: string; position: string }[];
    const sks = new Set(claimants.map((c) =>
      (db.prepare("SELECT player_sk FROM player_identity WHERE name_key=? AND position=?").get(c.name_key, c.position) as { player_sk: number } | undefined)?.player_sk));
    assert.equal(sks.size, claimants.length, `disputed gsis ${d.v} merged ${claimants.length} people into ${sks.size} key(s)`);
    assert.ok(!sks.has(undefined as never), `a claimant of ${d.v} has no key at all`);
  }
  db.close();
});

test("a NEW source id attaches to the existing player rather than minting a second", (t) => {
  if (!ready) return t.skip("registry not built");
  const p = scratch();
  const db = new Database(p);
  // Someone currently keyed only by name+pos: the case where later learning an id must NOT create a
  // duplicate, which is exactly what a natural key would have done (his key would have changed).
  const row = db.prepare(
    `SELECT i.player_sk, i.name_key, i.position FROM player_identity i
     WHERE NOT EXISTS (SELECT 1 FROM player_xref x WHERE x.player_sk = i.player_sk AND x.source='gsis') LIMIT 1`,
  ).get() as { player_sk: number; name_key: string; position: string } | undefined;
  if (!row) { db.close(); return t.skip("everyone already has a gsis"); }
  const before = row.player_sk;
  const again = resolveOrMint(db, { name: "x", nameKey: row.name_key, position: row.position, ids: { gsis: "00-9999999" } });
  assert.equal(again.sk, before, "learning a new id must not mint a second key for the same player");
  assert.equal(linkId(db, before, "gsis", "00-9999999"), null, "the new id should attach cleanly");
  const third = resolveOrMint(db, { name: "x", nameKey: "someoneelse", position: "RB", ids: { gsis: "00-9999999" } });
  assert.equal(third.sk, before, "and thereafter that id must resolve to the same player");
  db.close();
});

test("linkId refuses to move an id between players", (t) => {
  if (!ready) return t.skip("registry not built");
  const p = scratch();
  const db = new Database(p);
  const two = db.prepare("SELECT player_sk FROM player_identity LIMIT 2").all() as { player_sk: number }[];
  assert.equal(linkId(db, two[0].player_sk, "gsis", "00-8888888"), null);
  const err = linkId(db, two[1].player_sk, "gsis", "00-8888888");
  assert.ok(err && /already belongs/.test(err), "a second claimant must be refused, not silently reassigned");
  const owner = db.prepare("SELECT player_sk FROM player_xref WHERE source='gsis' AND source_id='00-8888888'").get() as { player_sk: number };
  assert.equal(owner.player_sk, two[0].player_sk, "the original owner must keep the id");
  db.close();
});
