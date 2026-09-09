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
import { assertRostersCanFillLineup } from "../src/draft/season.js";
import { dstAliasKey, nameKey } from "../src/draft/values.js";

// --- the structural guard itself ------------------------------------------------------------------
// Both directions are asserted. A guard that can only ever REFUSE is dead code that reads exactly
// like a guard that is working, and the negative path is the one that was already correct here.
const SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE"];
type FixturePlayer = { name: string; pos: string; proj: number; bye: number | null; eligible?: string[] };
const roster = (spec: [string, number][]): FixturePlayer[] =>
  spec.flatMap(([pos, n]) => Array.from({ length: n }, (_, i): FixturePlayer => ({ name: `${pos}${i}`, pos, proj: 100, bye: null })));
const team = (spec: [string, number][]) => [{ id: "1", name: "T1", roster: roster(spec) }];
const COMPLETE: [string, number][] = [["QB", 1], ["RB", 3], ["WR", 3], ["TE", 1], ["K", 1], ["DST", 1]];

test("POSITIVE DIRECTION: a complete roster passes the structural check", () => {
  assert.doesNotThrow(() => assertRostersCanFillLineup(team(COMPLETE), SLOTS));
});

test("FAULT: a roster with no DST is refused, naming the team and the slot", () => {
  const noDst = COMPLETE.filter(([p]) => p !== "DST");
  assert.throws(() => assertRostersCanFillLineup(team(noDst), SLOTS), /T1.*0 DST.*starts 1/s);
});

test("FAULT: a roster that cannot fill FLEX is refused, even with every fixed slot covered", () => {
  // Exactly one of each flex position: the fixed RB/WR/TE slots consume them all, leaving no spare.
  const noFlex: [string, number][] = [["QB", 1], ["RB", 1], ["WR", 1], ["TE", 1], ["K", 1], ["DST", 1]];
  assert.throws(() => assertRostersCanFillLineup(team(noFlex), SLOTS), /flex-eligible/);
});

test("the opt-out works, and is the only way through", () => {
  const noDst = COMPLETE.filter(([p]) => p !== "DST");
  assert.throws(() => assertRostersCanFillLineup(team(noDst), SLOTS));
  // Same rosters, opt-out set: the caller has said partial rosters are the point.
  assert.doesNotThrow(() => assertRostersCanFillLineup(team(noDst), SLOTS.filter((s) => s !== "DST")));
});

// --- SYSTEMATIC vs INDIVIDUAL -----------------------------------------------------------------------
// Once streaming is modelled, an unfillable slot no longer scores zero -- it scores replacement level,
// and punting a position to stream it weekly becomes a real strategy the simulator can price. So the
// guard can no longer refuse on SHAPE alone without blocking legitimate analysis.
//
// What still cannot happen is many teams short at the same position: sixteen managers do not
// independently abandon the same mandatory slot, and that pattern is exactly what the missing-defense
// join failure looked like. The test therefore moved from "is this roster odd" to "is this shortfall
// systematic", and these pin both sides of that line.
const REP = { QB: 13, RB: 6, WR: 8, TE: 7, K: 9, DST: 7 };
const league = (n: number, missing: string) => Array.from({ length: 16 }, (_, i) => ({
  id: String(i), name: `T${i}`,
  roster: ([["QB", 300], ["RB", 250], ["RB", 200], ["WR", 240], ["WR", 210], ["WR", 180], ["TE", 150], ["K", 120], ["DST", 110]] as [string, number][])
    .filter(([p]) => !(i < n && p === missing))
    .map(([p, v]) => ({ name: `${p}${v}-t${i}`, pos: p, proj: v, bye: null })),
}));
const FULL_SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE"];

test("SYSTEMATIC shortfall is still refused even with streaming on -- the original bug", () => {
  assert.throws(() => assertRostersCanFillLineup(league(16, "DST"), FULL_SLOTS, ["RB", "WR", "TE"], REP),
    /16 of 16 teams have no DST/);
});

test("ONE team punting a position is allowed once streaming can price it", () => {
  assert.doesNotThrow(() => assertRostersCanFillLineup(league(1, "DST"), FULL_SLOTS, ["RB", "WR", "TE"], REP));
  assert.doesNotThrow(() => assertRostersCanFillLineup(league(3, "DST"), FULL_SLOTS, ["RB", "WR", "TE"], REP));
});

test("the systematic threshold bites at a quarter of the league", () => {
  // Stated as a test rather than a comment so the boundary cannot drift unnoticed.
  assert.throws(() => assertRostersCanFillLineup(league(4, "DST"), FULL_SLOTS, ["RB", "WR", "TE"], REP), /4 of 16/);
});

test("with NO streaming floor the original premise holds and any gap is refused", () => {
  // The old rationale is exactly true here: the slot really would score zero every week, so a single
  // team short is still a defect. This is what keeps unmigrated callers safe.
  assert.throws(() => assertRostersCanFillLineup(league(1, "DST"), FULL_SLOTS, ["RB", "WR", "TE"]),
    /score zero in EVERY week/);
});

test("flexOk is honoured -- a superflex league can fill FLEX with the spare QB", () => {
  // Guards against the check hardcoding RB/WR/TE the way optimalLineup once did.
  const spec: [string, number][] = [["QB", 3], ["RB", 1], ["WR", 1], ["TE", 1], ["K", 1], ["DST", 1]];
  assert.throws(() => assertRostersCanFillLineup(team(spec), SLOTS));
  assert.doesNotThrow(() => assertRostersCanFillLineup(team(spec), SLOTS, ["QB", "RB", "WR", "TE"]));
});

// --- DUAL ELIGIBILITY -----------------------------------------------------------------------------
// A man ESPN qualifies at two positions must be counted toward whichever one is SHORT. Counting him
// under his projection's position and stopping there reports a hole at the very slot he exists to
// cover, and this function's caller then REFUSES to simulate a perfectly legal roster.

test("a dual-eligible player is counted toward the position that is SHORT", () => {
  // No tight end on the roster at all -- except a receiver ESPN also qualifies at TE.
  const spec: [string, number][] = [["QB", 1], ["RB", 3], ["WR", 3], ["K", 1], ["DST", 1]];
  const plain = team(spec);
  assert.throws(() => assertRostersCanFillLineup(plain, SLOTS), /0 TE.*starts 1/s,
    "the fixture must be short at TE, or the next assertion proves nothing");

  const dual = team(spec);
  dual[0].roster.find((p) => p.name === "WR2")!.eligible = ["WR", "TE"];
  assert.doesNotThrow(() => assertRostersCanFillLineup(dual, SLOTS),
    "the dual man covers the TE slot and the roster is legal");
});

test("a dual-eligible player is counted ONCE -- he cannot cover two holes at the same time", () => {
  // Short at both TE and WR. One man eligible at both can only fill one of them.
  const spec: [string, number][] = [["QB", 1], ["RB", 4], ["K", 1], ["DST", 1]];
  const t2 = team(spec);
  t2[0].roster.push({ name: "Swiss", pos: "WR", proj: 100, bye: null, eligible: ["WR", "TE"] });
  assert.throws(() => assertRostersCanFillLineup(t2, SLOTS), /(0 TE|0 WR)/,
    "one body was made to fill two mandatory slots");
});

test("eligibility is inert for a single-eligible roster -- same answer with the field present", () => {
  const withField = team(COMPLETE);
  for (const p of withField[0].roster) p.eligible = [p.pos];
  assert.doesNotThrow(() => assertRostersCanFillLineup(withField, SLOTS));
  const noDst = team(COMPLETE.filter(([p]) => p !== "DST"));
  for (const p of noDst[0].roster) p.eligible = [p.pos];
  assert.throws(() => assertRostersCanFillLineup(noDst, SLOTS), /0 DST.*starts 1/s);
});

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
