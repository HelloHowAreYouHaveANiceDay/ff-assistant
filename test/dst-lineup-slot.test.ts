/**
 * THE DST SLOT MUST BE FILLABLE, and the reason this test exists is that it stopped being so
 * SILENTLY: `ff lineup` returned "(empty)" at DST with a rostered defense on the bench, and
 * nothing errored. An empty slot scores replacement points, so the only symptom was a lineup that
 * looked slightly wrong to a human.
 *
 * WHAT THE RCA GOT RIGHT, AND THE ONE THING IT DID NOT. The root cause was a key mismatch: ESPN keys
 * defenses `dst-MIN`, the resolver emitted `DST:VIKINGS`, and the board/model key them `DST:MIN`.
 * Fixing that fixed the roster resolution AND the free-agent pool leak.
 *
 * But the RCA listed "DST weekly projections missing from the serve" as a separate, unfixed cause.
 * It is not: the serve produces all 32, and the slot fills. What is actually load-bearing is
 * something subtler, and it is what these tests pin:
 *
 *   `weeklyFor` LOOKS UP BY NAME. The roster carries NICKNAMES ("Packers D/ST"); the served weekly
 *   rows carry ABBREVIATIONS ("GB D/ST"). So the DIRECT name lookup MISSES FOR EVERY DEFENSE, every
 *   week, and the `dstAliasKey` fallback is the only reason the slot fills at all.
 *
 * A name join rescued by an alias table is the fragile pattern this repo moved away from everywhere
 * else -- both sides carry `player_sk` (`DST:GB` on each) and the map is keyed by name anyway. Until
 * that is changed, the alias is load-bearing and is tested as such.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { dstAliasKey } from "../src/draft/values.js";
import { lineupNameKey } from "../src/inseason/copilot.js";

const DB = "data/ff.db";
const skip = !existsSync(DB) && "no data/ff.db";
const SEASON = 2026;

test("the weekly serve produces a row for ALL 32 defenses", { skip }, async () => {
  const { projectStreamingWith } = await import("../src/weekly/streamingServe.js");
  const db = new Database(DB, { readonly: true });
  try {
    // The first week the store has DST feature rows for; the test is about coverage, not a week.
    const wk = (db.prepare(
      "SELECT MIN(week) w FROM feat_player_week_stream WHERE season = ? AND pos = 'DST'",
    ).get(SEASON) as { w: number | null }).w;
    if (wk == null) return;                       // a store without the stream features cannot answer

    const rows = (projectStreamingWith(db as never, SEASON, wk)?.rows ?? [])
      .filter((r: { pos: string }) => r.pos === "DST");
    assert.equal(rows.length, 32,
      `the serve produced ${rows.length} DST rows for ${SEASON} wk${wk}, not 32 -- a defense with no ` +
      "projection empties its slot, and an empty slot scores replacement points rather than erroring");

    // KEYED BY THE ABBREVIATION -- but the NAME is spelled two ways, which is the defect this file
    // was written to catch. 28 defenses are "XX D/ST" and four (LAR, NE, SEA, SF) are "XX DST".
    // The test asserts the key is uniform and that BOTH name spellings normalise to ONE key, rather
    // than demanding a uniform spelling the feature table does not have.
    const keys = new Set<string>();
    for (const r of rows as { player_sk: string; name: string }[]) {
      assert.match(r.player_sk, /^DST:[A-Z]{2,3}$/, `served DST key is not the abbreviation form: ${r.player_sk}`);
      assert.match(r.name, /^[A-Z]{2,3} D\/?ST$/, `served DST name is in neither spelling: ${r.name}`);
      keys.add(lineupNameKey(r.name));
    }
    assert.equal(keys.size, 32,
      "two defenses normalised to the same lineup key, or one normalised to two -- the weekly map " +
      "is keyed by this form, so a collision silently serves one defense's projection for another");
  } finally { db.close(); }
});

test("THE ROSTER AND THE SERVE DISAGREE ABOUT THE NAME -- so the direct lookup cannot work", { skip }, () => {
  // The premise the alias exists for, asserted rather than assumed. If this ever stops being true --
  // if the roster starts carrying abbreviations -- the alias becomes dead code and somebody should
  // find that out from a failing test rather than by deleting it and hoping.
  const db = new Database(DB, { readonly: true });
  try {
    const roster = db.prepare(
      "SELECT DISTINCT name FROM fact_roster_week WHERE season = ? AND pos = 'DST'",
    ).all(SEASON) as { name: string }[];
    if (!roster.length) return;
    const abbrevForm = roster.filter((r) => /^[A-Z]{2,3} D\/ST$/.test(r.name)).length;
    assert.equal(abbrevForm, 0,
      "the roster now carries abbreviation-form DST names, which the serve also uses. The direct " +
      "lookup in weeklyFor would then succeed on its own and dstAliasKey would be dead code -- " +
      "verify that and simplify, rather than leaving an untested fallback in place.");
  } finally { db.close(); }
});

test("EVERY rostered defense's nickname resolves through the alias to the served key", { skip }, () => {
  // The load-bearing step, end to end on real names. `dstAliasKey` turning "Packers D/ST" into "GB"
  // is the ONLY thing connecting the roster to the projection.
  const db = new Database(DB, { readonly: true });
  try {
    const roster = db.prepare(
      "SELECT DISTINCT name, player_sk FROM fact_roster_week WHERE season = ? AND pos = 'DST'",
    ).all(SEASON) as { name: string; player_sk: string | null }[];
    if (!roster.length) return;

    for (const r of roster) {
      const alias = dstAliasKey(r.name);
      assert.ok(alias, `dstAliasKey could not resolve the rostered defense "${r.name}" -- its slot will empty`);
      // And it must agree with the key the row already carries, which is the cross-check that makes
      // this more than "the alias returned something".
      if (r.player_sk) {
        assert.equal(`DST:${String(alias).toUpperCase()}`, r.player_sk,
          `"${r.name}" aliases to ${alias} but its row is keyed ${r.player_sk} -- the two disagree`);
      }
    }
  } finally { db.close(); }
});

test("the ESPN team-code quirks are covered, not just the common case", () => {
  // Pure unit, no store. These are the three that a naive abbreviation map gets wrong, and two of
  // them (JAX->JAC, OAK->LV) were part of the original fix.
  for (const [name, want] of [
    ["Jaguars D/ST", "JAC"],
    ["Raiders D/ST", "LV"],
    ["Commanders D/ST", "WAS"],
    ["Vikings D/ST", "MIN"],
    ["Packers D/ST", "GB"],
  ] as [string, string][]) {
    const got = dstAliasKey(name);
    assert.equal(String(got).toUpperCase(), want, `${name} should alias to ${want}, got ${got}`);
  }
});

test("BOTH DST SPELLINGS NORMALISE TO ONE KEY -- the bug the RCA's roster did not expose", () => {
  // `feat_player_week` spells four defenses "XX DST" and the other 28 "XX D/ST". The slash is
  // punctuation, so without a collapse the normaliser produced "lar d st" and "lar dst" -- two keys
  // for one team -- and `weeklyFor`'s alias path, which builds the SLASH form, missed all four.
  //
  // It stayed hidden because the reporting roster held Minnesota, spelled with the slash. Four of
  // this league's seventeen rostered defenses were emptying their slot the whole time.
  for (const team of ["LAR", "NE", "SEA", "SF", "MIN", "GB"]) {
    assert.equal(lineupNameKey(`${team} DST`), lineupNameKey(`${team} D/ST`),
      `"${team} DST" and "${team} D/ST" must be the same lineup key -- they are the same defense`);
  }
  // And the collapse must not reach beyond defenses: a real name containing a "d" word followed by
  // "st" must be left alone, or this normaliser starts merging players.
  assert.notEqual(lineupNameKey("David Stills"), lineupNameKey("Dvd DST"));
  assert.equal(lineupNameKey("Amon-Ra St. Brown Jr."), "amon ra st brown",
    "the documented example must not move -- the weekly Map is keyed by this form on both sides");
});

test("END TO END: every rostered defense gets a weekly projection", { skip }, async () => {
  // The assertion that would have caught the original report, stated as the user experiences it:
  // a rostered defense must produce a number, or its slot empties and scores replacement points.
  const { projectStreamingWith } = await import("../src/weekly/streamingServe.js");
  const db = new Database(DB, { readonly: true });
  try {
    const wk = (db.prepare(
      "SELECT MIN(week) w FROM feat_player_week_stream WHERE season = ? AND pos = 'DST'",
    ).get(SEASON) as { w: number | null }).w;
    if (wk == null) return;
    const rows = (projectStreamingWith(db as never, SEASON, wk)?.rows ?? [])
      .filter((r: { pos: string }) => r.pos === "DST") as { name: string; mean: number }[];
    const weekly = new Map(rows.map((r) => [lineupNameKey(r.name), r.mean]));

    const roster = db.prepare(
      "SELECT DISTINCT name FROM fact_roster_week WHERE season = ? AND pos = 'DST'",
    ).all(SEASON) as { name: string }[];
    if (!roster.length) return;

    const missing: string[] = [];
    for (const r of roster) {
      // Exactly what `weeklyFor` does: direct, then the DST alias.
      const alias = dstAliasKey(r.name);
      const got = weekly.get(lineupNameKey(r.name))
        ?? (alias == null ? undefined : weekly.get(lineupNameKey(`${String(alias).toUpperCase()} D/ST`)));
      if (got == null) missing.push(r.name);
    }
    assert.deepEqual(missing, [],
      `${missing.length} of ${roster.length} rostered defenses have no weekly projection, so their ` +
      "lineup slot empties silently: " + missing.join(", "));
  } finally { db.close(); }
});
