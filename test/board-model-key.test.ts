/**
 * THE BOARD LAYER AND THE MODEL LAYER KEY THE SAME MEN TWO DIFFERENT WAYS, AND ONLY ONE BRIDGE
 * CROSSES THEM.
 *
 * `player_value.player_sk` / `board.player_sk` are INTEGER; `feat_player_week.player_sk`,
 * `fact_roster_week.player_sk` and `scorecard_prediction.subject` are TEXT and carry `DST:<TEAM>`
 * for a defence. The identity registry mints an integer surrogate for all 32 defences anyway, so the
 * board columns hold a key that joins to nothing on the other side.
 *
 * Found on 2026-09-18 while pricing a live matchup: joining the two layers on `player_sk` resolved
 * every skill starter and dropped both DSTs; joining on NAME appeared to work, but only because both
 * sides happened to spell "MIN D/ST" the same way that day -- `raw_league_roster_week` spells the
 * very same defence "Vikings D/ST". Neither method complains. That is the shape this file pins.
 *
 * The assertions run against the REAL store when one is present, because a bridge tested only
 * against a fixture it also wrote proves nothing about the two namespaces actually in the database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { boardModelKey, dstKey } from "../src/data/skResolve.js";

// --- the bridge itself, both directions -----------------------------------------------------------

test("a DST is keyed by TEAM, never by its minted integer surrogate", () => {
  // The integer is present and must be IGNORED -- that is the whole point. A bridge that passed it
  // through would be a no-op wearing the name of a fix.
  assert.equal(boardModelKey({ position: "DST", player_id: "min", player_sk: 12089 }), "DST:MIN");
  assert.equal(boardModelKey({ position: "DST", player_id: "bal", team: "BAL", player_sk: 12091 }), "DST:BAL");
  assert.equal(boardModelKey({ position: "D/ST", player_id: "sf", player_sk: 1 }), "DST:SF");
});

test("a PLAYER is keyed by his surrogate, rendered as text", () => {
  // The positive control for the other branch: a bridge that only ever produced DST keys would fail
  // every skill player while looking like it worked on the case that was broken.
  assert.equal(boardModelKey({ position: "WR", player_id: "amonrastbrown", player_sk: 1866 }), "1866");
  assert.equal(boardModelKey({ position: "QB", player_id: "bonix", player_sk: 680 }), "680");
});

test("an unkeyable row returns null rather than a guess", () => {
  assert.equal(boardModelKey({ position: "WR", player_id: "nobody", player_sk: null }), null);
  assert.equal(boardModelKey({ position: "DST", player_id: "", team: "" }), null);
});

test("dstKey normalises case and whitespace, so two spellings cannot become two keys", () => {
  assert.equal(dstKey(" min "), "DST:MIN");
  assert.equal(dstKey("Min"), dstKey("MIN"));
});

// --- against the real store -----------------------------------------------------------------------

const DB = "data/ff.db";

test("REAL STORE: every board DST bridges to a key the model layer actually carries", { skip: !existsSync(DB) && "no data/ff.db" }, () => {
  const db = new Database(DB, { readonly: true });
  try {
    const modelKeys = new Set((db.prepare(
      "SELECT DISTINCT player_sk AS k FROM feat_player_week WHERE pos='DST'",
    ).all() as { k: string }[]).map((r) => r.k));
    if (!modelKeys.size) return; // nothing ingested yet; the fixture tests above still stand

    const board = db.prepare(
      `SELECT pv.player_id, pv.player_sk, p.position FROM player_value pv JOIN player p USING(player_id)
        WHERE p.position='DST' AND pv.season=(SELECT MAX(season) FROM player_value)`,
    ).all() as { player_id: string; player_sk: number | null; position: string }[];
    assert.ok(board.length >= 30, `expected ~32 board defences, got ${board.length}`);

    const bridged: string[] = [];
    const missed: string[] = [];
    for (const r of board) {
      const k = boardModelKey(r);
      (k && modelKeys.has(k) ? bridged : missed).push(`${r.player_id} -> ${k}`);
    }
    assert.equal(missed.length, 0, `these board defences do not bridge: ${missed.slice(0, 6).join(", ")}`);
    assert.equal(bridged.length, board.length);

    // FAULT INJECTION, and the reason this test is not circular: the RAW integer must NOT resolve.
    // If it did, the two namespaces would already agree and this whole bridge would be dead code
    // that passes forever -- which is indistinguishable from a bridge that works.
    const rawIntegersThatResolve = board.filter((r) => r.player_sk != null && modelKeys.has(String(r.player_sk)));
    assert.equal(rawIntegersThatResolve.length, 0,
      "a board DST's integer player_sk resolved in the model layer -- the namespaces have merged and this test is no longer measuring anything");
  } finally { db.close(); }
});

test("REAL STORE: a skill player's board surrogate DOES resolve in the model layer", { skip: !existsSync(DB) && "no data/ff.db" }, () => {
  // The other half of the same guard. If skill keys did not line up either, the DST result above
  // would say nothing about DST -- it would just mean the two layers share no keys at all.
  const db = new Database(DB, { readonly: true });
  try {
    const season = (db.prepare("SELECT MAX(season) s FROM player_value").get() as { s: number }).s;
    const rows = db.prepare(
      `SELECT pv.player_id, pv.player_sk, p.position FROM player_value pv JOIN player p USING(player_id)
        WHERE p.position IN ('QB','RB','WR','TE') AND pv.season=? AND pv.player_sk IS NOT NULL LIMIT 200`,
    ).all(season) as { player_id: string; player_sk: number; position: string }[];
    if (!rows.length) return;
    const modelKeys = new Set((db.prepare(
      "SELECT DISTINCT player_sk AS k FROM feat_player_week WHERE pos IN ('QB','RB','WR','TE')",
    ).all() as { k: string }[]).map((r) => r.k));
    if (!modelKeys.size) return;
    const hit = rows.filter((r) => modelKeys.has(boardModelKey(r)!)).length;
    assert.ok(hit / rows.length > 0.8, `only ${hit}/${rows.length} board skill players bridge into the model layer`);
  } finally { db.close(); }
});
