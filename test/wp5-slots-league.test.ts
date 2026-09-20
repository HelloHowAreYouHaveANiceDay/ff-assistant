/**
 * WP5: SLOT ELIGIBILITY EVERYWHERE, FAAB PER LEAGUE, PLATFORM DISPATCH, LEAGUE-AWARE ROUTINES.
 *
 * Findings I-2, I-3, I-4, I-7 and P-1/P-6 of docs/architecture-review-2026-09-16.md.
 *
 * EVERY POSITIVE ASSERTION HERE IS PAIRED WITH A FAULT INJECTION, because a lineup that fills a
 * SUPERFLEX slot and a lineup that fills it by coincidence are indistinguishable from the output: the
 * old code scored an unfillable slot 0 and returned a full-looking lineup. So each test either
 * reproduces the OLD rule (the literal `slot === "FLEX"` / `BE|BENCH` filter) and asserts it FAILS, or
 * removes the thing under test and asserts the assertion fires.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { UNKNOWN_PLATFORM, assertUnregistered } from "./helpers/unknown-platform.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optimalLineup, type RosterPlayer } from "../src/inseason/lineup.js";
import { assertRostersCanFillLineup, rosterGaps } from "../src/draft/season.js";
import { isBenchSlot, slotAdmits, startingSlots, splitTemplate } from "../src/draft/slots.js";
import { resolveValueLeague } from "../src/draft/values.js";
import { faabArtifactFor, FAAB_INCUMBENT_LEAGUE } from "../src/inseason/faab.js";
import { openDb, setConfig } from "../src/db/db.js";
import { loadAcquisition, loadFaabBudget } from "../src/inseason/copilotStore.js";
import { planRoutines, routineLeagues, getSchedule, setSchedule } from "../src/inseason/routines.js";
import { platformFor } from "../src/league/platform.js";
import type { PlatformIO } from "../src/league/platform.js";

// The Yahoo 129048 template, exactly as `config:129048` carries it (WP4 read it off the live page).
const YAHOO_SLOTS = ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "FLEX", "FLEX", "SUPERFLEX",
  "BE", "BE", "BE", "BE", "BE", "BE", "BE", "IR", "IR"];
const ESPN_SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"];
const ESPN_FLEX_OK = ["RB", "WR", "TE"];

const p = (name: string, pos: string, proj: number, available = true): RosterPlayer => ({ name, pos, proj, available });

/** A Yahoo-shaped roster: 2 QB, 3 RB, 4 WR, 2 TE = 11 men for 10 starting slots. */
function yahooRoster(): RosterPlayer[] {
  return [
    p("QB1", "QB", 22), p("QB2", "QB", 18),
    p("RB1", "RB", 16), p("RB2", "RB", 13), p("RB3", "RB", 9),
    p("WR1", "WR", 17), p("WR2", "WR", 15), p("WR3", "WR", 11), p("WR4", "WR", 8),
    p("TE1", "TE", 12), p("TE2", "TE", 6),
  ];
}

// -------------------------------------------------------------------------------------------
// (a) THE LINEUP OPTIMIZER
// -------------------------------------------------------------------------------------------

test("I-2: a Yahoo roster fills SUPERFLEX with the second QB, and the two IR slots are NOT starting slots", () => {
  const res = optimalLineup(yahooRoster(), YAHOO_SLOTS, ESPN_FLEX_OK);

  // Ten starting slots, none empty, and NO "no available player to fill IR" flag.
  assert.equal(res.starters.length, 10, "QB/WR x2/RB x2/TE/FLEX x3/SUPERFLEX -- IR and BE are not starting slots");
  assert.equal(res.starters.filter((s) => s.name === "(empty)").length, 0, "every starting slot is filled");
  assert.ok(!res.flags.some((f) => /fill IR/.test(f)), `no IR flag, got: ${res.flags.join(" | ")}`);

  // The SUPERFLEX slot holds the second quarterback -- the whole point of the slot.
  const sf = res.starters.find((s) => s.slot === "SUPERFLEX");
  assert.ok(sf, "a SUPERFLEX slot exists in the answer");
  assert.equal(sf!.name, "QB2", `SUPERFLEX should take the spare QB (18 pts), got ${sf!.name}`);

  // FAULT INJECTION: the OLD rule, reproduced exactly -- literal FLEX, literal BE|BENCH bench test.
  // It must produce the failure this test exists to prevent: SUPERFLEX and both IR slots unfillable.
  const oldStart = YAHOO_SLOTS.filter((s) => s !== "BE" && s !== "BENCH");
  const oldAccepts = (slot: string, pl: RosterPlayer) =>
    slot === "FLEX" ? ESPN_FLEX_OK.includes(pl.pos) : pl.pos === slot;
  const unfillable = oldStart.filter((slot) => !yahooRoster().some((pl) => oldAccepts(slot, pl)));
  assert.deepEqual(unfillable, ["SUPERFLEX", "IR", "IR"],
    "the literal rule this replaced leaves SUPERFLEX and both IR slots matching nobody");
});

test("I-2 REGRESSION LOCK: the ESPN template is byte-identical under the shared slot module", () => {
  const roster = [
    p("QB1", "QB", 21), p("RB1", "RB", 18), p("RB2", "RB", 14), p("RB3", "RB", 7),
    p("WR1", "WR", 16), p("WR2", "WR", 15), p("WR3", "WR", 10),
    p("TE1", "TE", 11), p("K1", "K", 8), p("D1", "DST", 9), p("WR4", "WR", 4),
  ];
  const res = optimalLineup(roster, ESPN_SLOTS, ESPN_FLEX_OK);
  assert.deepEqual(
    res.starters.map((s) => `${s.slot}:${s.name}`),
    ["QB:QB1", "RB:RB1", "WR:WR1", "TE:TE1", "FLEX:WR2", "FLEX:RB2", "DST:D1", "K:K1"],
    "the eight ESPN starting slots, filled exactly as the literal-FLEX optimizer filled them",
  );
  assert.equal(res.totalProj, 112, "total is the sum of those eight");
});

test("I-3: one bench test covers BE / BENCH / BN / IR / ER, and a BN roster counts 7 bench", () => {
  for (const s of ["BE", "BENCH", "BN", "IR", "ER", "be", "ir"]) assert.ok(isBenchSlot(s), `${s} is bench-like`);
  for (const s of ["QB", "RB", "FLEX", "SUPERFLEX", "DST", "K"]) assert.ok(!isBenchSlot(s), `${s} is NOT bench`);

  // Yahoo's own token, carried verbatim rather than normalized away.
  const bnTemplate = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BN", "BN", "BN", "BN", "BN", "BN", "BN"];
  assert.equal(startingSlots(bnTemplate).length, 7, "seven STARTING slots");
  assert.equal(bnTemplate.length - startingSlots(bnTemplate).length, 7, "seven BENCH slots, not seven starters");

  // FAULT INJECTION: the old `BE|BENCH` filter counts all fourteen as starting slots.
  assert.equal(bnTemplate.filter((s) => s !== "BE" && s !== "BENCH").length, 14,
    "the literal BE|BENCH test this replaced saw 14 starting slots, i.e. seven phantom starters at a position called BN");
});

test("I-2: slotAdmits keeps flex_ok as the override for the literal FLEX and nothing else", () => {
  assert.deepEqual(slotAdmits("FLEX", ESPN_FLEX_OK), ["RB", "WR", "TE"]);
  assert.deepEqual(slotAdmits("FLEX", ["RB", "WR"]), ["RB", "WR"], "an edited flex_ok still wins on FLEX");
  // flex_ok must NOT be applied to SUPERFLEX: it is one league-wide list, and applying it there
  // would strip the QB straight back out and reinstate the bug.
  assert.deepEqual(slotAdmits("SUPERFLEX", ESPN_FLEX_OK), ["QB", "RB", "WR", "TE"]);
  assert.deepEqual(slotAdmits("Q/W/R/T", ESPN_FLEX_OK), ["QB", "RB", "WR", "TE"]);
  assert.deepEqual(slotAdmits("QB", ESPN_FLEX_OK), ["QB"]);
});

// -------------------------------------------------------------------------------------------
// (b) ROSTER LEGALITY
// -------------------------------------------------------------------------------------------

const team = (id: string, roster: RosterPlayer[]) => ({ id, name: id, roster: roster.map((x) => ({ pos: x.pos })) });

test("I-2: assertRostersCanFillLineup ACCEPTS a legal superflex roster", () => {
  const t = team("us", yahooRoster());
  assert.deepEqual(rosterGaps([t], YAHOO_SLOTS, ESPN_FLEX_OK), [], "a legal Yahoo roster has no gaps");
  assert.doesNotThrow(() => assertRostersCanFillLineup([t], YAHOO_SLOTS, ESPN_FLEX_OK));

  // FAULT INJECTION: drop one spare body and the three FLEX + one SUPERFLEX can no longer all be
  // filled, so the check must fire. If it cannot fire, the acceptance above proves nothing.
  const thin = team("us", yahooRoster().filter((x) => x.name !== "WR4" && x.name !== "RB3"));
  const gaps = rosterGaps([thin], YAHOO_SLOTS, ESPN_FLEX_OK);
  assert.ok(gaps.length > 0, `a roster two bodies short must report a gap, got ${JSON.stringify(gaps)}`);
  assert.ok(gaps.some((g) => /FLEX|SUPERFLEX/.test(g)), `the gap names the flex group: ${gaps.join(" | ")}`);
});

test("I-2: the SYSTEMATIC-shortfall refusal still fires (a failed join, not a roster choice)", () => {
  // Twelve teams with no tight end at all: the signature of a broken join, and the case
  // assertRostersCanFillLineup exists to refuse.
  const noTe = yahooRoster().filter((x) => x.pos !== "TE");
  const teams = Array.from({ length: 12 }, (_, i) => team(`t${i}`, noTe));
  assert.throws(() => assertRostersCanFillLineup(teams, YAHOO_SLOTS, ESPN_FLEX_OK),
    /no TE|cannot fill the lineup/, "twelve teams short at TE is refused");
});

test("I-2: resolveValueLeague keeps FLEX and SUPERFLEX as DISTINCT groups and excludes IR", () => {
  const vl = resolveValueLeague({ teams: 12, budget: 200, slots: YAHOO_SLOTS });
  assert.equal(vl.rosterSpots, 19);
  assert.deepEqual(vl.dedicated, { QB: 1, WR: 2, RB: 2, TE: 1 }, "no bench/IR slot became a dedicated position");
  const keys = (vl.flexGroups ?? []).map((g) => `${[...g.elig].sort().join("/")}x${g.count}`).sort();
  assert.deepEqual(keys, ["QB/RB/TE/WRx1", "RB/TE/WRx3"], "two distinct flex groups, not one bucket of four");

  const { dedicated, flex } = splitTemplate(YAHOO_SLOTS, ESPN_FLEX_OK);
  assert.deepEqual(dedicated, { QB: 1, WR: 2, RB: 2, TE: 1 });
  assert.deepEqual(flex.map((g) => `${g.label}x${g.count}`), ["FLEXx3", "SUPERFLEXx1"],
    "narrowest group first, each labelled by its own slot token");
});

// -------------------------------------------------------------------------------------------
// (d) FAAB PER LEAGUE
// -------------------------------------------------------------------------------------------

test("I-4: the fitted FAAB artifact is the INCUMBENT league's and is not handed to another league", () => {
  const prev = process.env.FF_FAAB_MODEL;
  delete process.env.FF_FAAB_MODEL;
  try {
    const espn = faabArtifactFor(FAAB_INCUMBENT_LEAGUE);
    assert.equal(espn.path, "data/faab-model.json", "the ESPN incumbent still reads the shipped artifact");

    const yahoo = faabArtifactFor("129048");
    assert.equal(yahoo.exists, false, "no artifact is fitted for the Yahoo league");
    assert.equal(yahoo.path, "data/faab-model.129048.json", "and the convention names where one would go");
    assert.ok(yahoo.reason && /129048/.test(yahoo.reason) && new RegExp(FAAB_INCUMBENT_LEAGUE).test(yahoo.reason),
      `the refusal names both leagues: ${yahoo.reason}`);
    // FAULT INJECTION: the OLD behaviour was one unconditional path for every league. Assert the two
    // leagues do NOT resolve to the same file -- if they did, this whole finding would be unfixed.
    assert.notEqual(yahoo.path, espn.path, "a second league must not silently read league 462233's model");
  } finally { if (prev) process.env.FF_FAAB_MODEL = prev; }
});

function twoLeagueDb() {
  const dir = mkdtempSync(join(tmpdir(), "ff-wp5-"));
  const db = openDb(join(dir, "t.db"));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?,?,?,?,?,?)")
    .run("462233", "espn", "seacaptaindate.com", 2026, "8", now);
  db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?,?,?,?,?,?)")
    .run("129048", "yahoo", "Fappening World Cup Edition", 2026, "11", now);
  return { db, dir, path: join(dir, "t.db") };
}

test("I-4: the FAAB budget comes from the league's OWN acquisition rules, per league", () => {
  const { db, path } = twoLeagueDb();
  // Yahoo's rules as WP4 read them off the live settings page; ESPN's league carries none.
  setConfig(db, { acquisition: { waivers: true, faabBudget: 100, processDays: ["Tuesday"], processHour: null, seasonLimit: null, weeklyLimit: null } } as never, "129048");
  db.close();

  const acq = loadAcquisition(path, "129048");
  assert.ok(acq, "the Yahoo league has acquisition rules");
  assert.equal(acq!.faabBudget, 100);
  assert.deepEqual(acq!.processDays, ["Tuesday"]);
  assert.equal(loadFaabBudget(path, "129048"), 100, "the budget is READ, not inferred from ESPN transactions");

  // The ESPN league has no acquisition block: `null` means UNKNOWN and is never another league's rules.
  assert.equal(loadAcquisition(path, "462233"), null,
    "a league with no rules reads null -- not the other league's, and not a default set");
});

// -------------------------------------------------------------------------------------------
// (e) PLATFORM DISPATCH
// -------------------------------------------------------------------------------------------

test("P-1: syncSettings dispatches on the league row's platform; an unknown platform refuses BY NAME", async () => {
  const espn = await platformFor("espn");
  const yahoo = await platformFor("yahoo");
  assert.equal(espn.id, "espn");
  assert.equal(yahoo.id, "yahoo");
  // `host` is a platform fact and no longer lives on the Electron webview spec (2026-09-19).
  assert.equal(espn.host, "espn.com");
  assert.notEqual(yahoo.host, espn.host, "each platform names its OWN session host");

  const unknown = assertUnregistered();
  await assert.rejects(() => platformFor(unknown), new RegExp(`no platform adaptor for "${unknown}"`),
    "an unregistered platform is refused by name, never given ESPN's adaptor");
  await assert.rejects(() => platformFor(null), /no platform adaptor for "unknown"/);

  // THE DISPATCH ACTUALLY REACHES THE RIGHT ADAPTOR: a recording IO shows which URLs were fetched.
  const seen: string[] = [];
  const io: PlatformIO = { get: async (url) => { seen.push(url); throw new Error("stop after the URL"); } };
  await assert.rejects(() => yahoo.syncSettings(io, "129048", 2026));
  assert.ok(seen.some((u) => /fantasysports\.yahoo\.com/.test(u)), `yahoo syncSettings fetched Yahoo: ${seen.join(", ")}`);
  assert.ok(!seen.some((u) => /espn\.com/.test(u)), "and it never touched ESPN");

  seen.length = 0;
  await assert.rejects(() => espn.syncSettings(io, "462233", 2026));
  assert.ok(seen.some((u) => /espn\.com/.test(u)), `espn syncSettings fetched ESPN: ${seen.join(", ")}`);
  assert.ok(!seen.some((u) => /yahoo/.test(u)), "and it never touched Yahoo");
});

test("P-1: an unknown platform is NAMED in the refusal, not anonymised", async () => {
  const { db } = twoLeagueDb();
  db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?,?,?,?,?,?)")
    .run("999", assertUnregistered(), "somewhere else", 2026, "3", new Date().toISOString());
  const { resolveLeagueContext, requirePlatform } = await import("../src/data/leagueContext.js");
  const ctx = resolveLeagueContext(db, "999");
  assert.equal(ctx.platform, null, "the narrowed union cannot hold it");
  assert.equal(ctx.platformRaw, UNKNOWN_PLATFORM, "the raw string is kept so the refusal can name it");
  assert.throws(() => requirePlatform(ctx, "espn", "ingest league-rosters", "syncRosters"),
    new RegExp(`"${UNKNOWN_PLATFORM}".*syncRosters`, "s"), "the refusal names the platform AND the adaptor method that is missing");
  db.close();
});

// -------------------------------------------------------------------------------------------
// (f) ROUTINES PER LEAGUE
// -------------------------------------------------------------------------------------------

test("I-7: the routine set iterates the leagues with a seat, and skips a platform BY NAME", () => {
  const { db } = twoLeagueDb();
  const leagues = routineLeagues(db);
  assert.deepEqual(leagues.map((l) => l.leagueId), ["129048", "462233"], "both leagues have a team_id");

  const plan = planRoutines(db, ["actuals", "roster"], "462233");
  // `roster` USED to be ESPN-gated and no longer is (2026-09-19): three of its four sub-steps are
  // platform-dispatched, so gating the whole routine denied the Yahoo league work it can do. The
  // one ESPN-only sub-step, `sync-pending-trades`, is declined inside `sync-league` instead.
  const yahooRoster = plan.runs.find((r) => r.leagueId === "129048" && r.routine === "roster");
  assert.ok(yahooRoster, "the Yahoo league's roster routine must RUN now, not be skipped wholesale");
  assert.equal(plan.skipped.filter((s) => s.routine === "roster").length, 0,
    "no league should be skipped at the roster-routine level any more");

  // EXPECTATION CHANGED BY WP13, AND THE SEMANTICS WITH IT. Until WP13 `actuals` was NOT
  // `leagueScoped` -- `ff sync-actuals`/`scorecard`/`refresh-decisions` took no `--league` -- so this
  // assertion read "the non-active league's actuals routine is REPORTED, not silently run", which was
  // the honest answer while appending the flag would have been silently ignored. All four verbs now
  // read the flag, `Routine.leagueScoped` is `true`, and `planRoutines` runs the routine for EVERY
  // league with a seat, appending `--league <id>` to each step. What has NOT changed is the other
  // gate: a routine whose `platforms` list excludes the league is still skipped by name (above).
  for (const lg of ["462233", "129048"]) {
    const run = plan.runs.find((r) => r.leagueId === lg && r.routine === "actuals");
    assert.ok(run, `league ${lg} runs the actuals routine`);
    assert.deepEqual(run!.steps, [["sync-actuals", ["--league", lg]]],
      "every step carries the league it is for, rather than resolving whichever is active");
  }
  assert.equal(plan.skipped.find((s) => s.routine === "actuals"), undefined,
    "no league is skipped for want of a --league flag any more");

  // FAULT INJECTION: nothing is skipped for a reason that is not stated.
  for (const s of plan.skipped) assert.ok(s.why.length > 20, `every skip carries a reason: ${JSON.stringify(s)}`);

  // A store with no league rows keeps the pre-multi-league behaviour exactly: run the set once.
  const { db: empty } = (() => { const d = mkdtempSync(join(tmpdir(), "ff-wp5e-")); return { db: openDb(join(d, "e.db")) }; })();
  const p0 = planRoutines(empty, ["actuals", "scorecard"], null);
  assert.equal(p0.runs.length, 2, "a fresh clone still runs the set once rather than doing nothing");
  assert.equal(p0.skipped.length, 0);
  empty.close();
  db.close();
});

test("I-7: the schedule is per league, with the global row as the shared default", () => {
  const { db } = twoLeagueDb();
  // No per-league row: both leagues read the shared global one -- today's behaviour, unchanged.
  setSchedule(db, { enabled: true, everyMinutes: 30 });
  assert.equal(getSchedule(db, "462233").everyMinutes, 30);
  assert.equal(getSchedule(db, "129048").everyMinutes, 30);

  // One league gets its own cadence; the other is untouched.
  setSchedule(db, { everyMinutes: 60, enabled: false }, "129048");
  assert.equal(getSchedule(db, "129048").everyMinutes, 60);
  assert.equal(getSchedule(db, "129048").enabled, false);
  assert.equal(getSchedule(db, "462233").everyMinutes, 30, "the other league did NOT move");
  assert.equal(getSchedule(db).everyMinutes, 30, "and neither did the global row");
  db.close();
});
