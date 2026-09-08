/**
 * EVERY ROSTERED PLAYER REACHES THE SIMULATOR, AND EVERY LINEUP SLOT CAN BE FILLED.
 *
 * There was already a test that ESPN's defense spellings resolve to our abbreviation key, and it
 * passed every run while all sixteen rosters in the league were silently missing their defense. It
 * tested the alias MAP; the bug was that the map was never APPLIED at the ownership-to-board join.
 * A test one layer away from the defect is green for the entire life of the defect.
 *
 * So this asserts the composed result instead of a component of it: load the real context the tools
 * use, and require that no roster row was dropped and that no team is short of a position its lineup
 * is obliged to start. Both failures are otherwise invisible -- the simulator fields an empty slot
 * and scores it zero without complaint, which looks exactly like a team that chose to punt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { loadSimContext } from "../src/draft/simContext.js";
import { dstAliasKey, nameKey } from "../src/draft/values.js";

test("every rostered player resolves onto the board", async (t) => {
  if (!existsSync("data/ff.db")) return t.skip("no local store");
  const db = new Database("data/ff.db", { readonly: true });
  const cfg = JSON.parse((db.prepare("SELECT value FROM settings WHERE key='config'").get() as { value: string }).value);
  const lg = db.prepare("SELECT league_id FROM league WHERE season=? AND team_id IS NOT NULL").get(cfg.season) as { league_id: string } | undefined;
  if (!lg) { db.close(); return t.skip("no league bound"); }

  const boardIds = new Set((db.prepare("SELECT player_id FROM board WHERE season=?").all(cfg.season) as { player_id: string }[]).map((r) => r.player_id));
  const owned = (db.prepare("SELECT player_id FROM ownership WHERE league_id=?").all(lg.league_id) as { player_id: string }[]).map((r) => r.player_id);
  db.close();
  if (!owned.length) return t.skip("no rosters synced");

  const missing = owned.filter((id) => !boardIds.has(id) && !(dstAliasKey(id) && boardIds.has(dstAliasKey(id)!)));
  assert.equal(missing.length, 0, `rostered players that match no board row: ${missing.join(", ")}`);
});

test("no team is short of a position its lineup must start", async (t) => {
  if (!existsSync("data/ff.db")) return t.skip("no local store");
  const db = new Database("data/ff.db", { readonly: true });
  const cfgRow = db.prepare("SELECT value FROM settings WHERE key='config'").get() as { value: string } | undefined;
  db.close();
  if (!cfgRow) return t.skip("no config");
  const cfg = JSON.parse(cfgRow.value);

  let ctx;
  try { ctx = await loadSimContext(); } catch { return t.skip("context unavailable"); }
  if (!ctx.teams.length) return t.skip("no teams");

  // FLEX is excluded deliberately: it is fillable from several positions, so a count against it
  // would fail for a legal roster.
  const need: Record<string, number> = {};
  for (const s of (cfg.slots ?? []) as string[]) if (!["BE", "IR", "FLEX"].includes(s)) need[s] = (need[s] ?? 0) + 1;

  const short: string[] = [];
  for (const team of ctx.teams) {
    for (const [pos, n] of Object.entries(need)) {
      const have = team.roster.filter((p) => p.pos === pos).length;
      if (have < n) short.push(`${team.name}: ${have} ${pos} but starts ${n}`);
    }
  }
  assert.equal(short.length, 0, `teams that would score zero at a mandatory slot: ${short.join("; ")}`);
});

test("the DST namespaces really are different, so the alias is load-bearing", async (t) => {
  // Guards against a future refactor that "simplifies away" the alias because the two id spaces look
  // interchangeable. They are not, and this states the fact the join depends on.
  if (!existsSync("data/ff.db")) return t.skip("no local store");
  const db = new Database("data/ff.db", { readonly: true });
  const cfg = JSON.parse((db.prepare("SELECT value FROM settings WHERE key='config'").get() as { value: string }).value);
  const dstBoard = (db.prepare("SELECT player_id, row_json FROM board WHERE season=?").all(cfg.season) as { player_id: string; row_json: string }[])
    .filter((r) => JSON.parse(r.row_json).Pos === "DST").map((r) => r.player_id);
  db.close();
  if (!dstBoard.length) return t.skip("no defenses on the board");
  // Board defenses are keyed by abbreviation, so each must be a fixed point of the alias.
  for (const id of dstBoard) {
    assert.equal(dstAliasKey(id), nameKey(id), `board DST id ${id} is not a canonical abbreviation key`);
  }
  // And a nickname must NOT already equal its abbreviation, or the alias would be doing nothing and
  // this whole class of bug would be untestable.
  assert.notEqual(nameKey("packers"), dstAliasKey("packers"), "nickname and abbreviation keys are identical -- the alias cannot be load-bearing");
  assert.equal(dstAliasKey("packers"), nameKey("GB"));
});
