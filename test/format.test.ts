import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFromEspnSettings, effectiveFormat, validateFormat, playoffRounds, isSeedingRule } from "../src/league/index.js";

/**
 * The league's calendar must be a FACT WITH A SOURCE, not a default.
 *
 * The defect these guard is not "the wrong number": it is a number that is RIGHT and unfalsifiable.
 * `regWeeks ?? 14` gave the correct answer for this league for the whole life of the repo while
 * never once reading anything, so a code path that had lost its input was indistinguishable from one
 * that had it. Hence the fault-injection test at the bottom: the interesting behaviour is not that a
 * present field is read, it is that an ABSENT field stops the sync instead of being invented.
 */

/**
 * The real 2026 payload for this league, slimmed -- the fields the format block is built from.
 *
 * READ LIVE 2026-09-09, AFTER the commissioner shortened the regular season. The fixture below it
 * is the SAME league read hours earlier, and the pair is the point: nothing about a payload says
 * how old it is, so the only defence against quoting a superseded calendar is to re-read it and
 * keep the stale one clearly labelled rather than deleted.
 */
const ESPN_2026 = () => ({
  settings: {
    size: 16,
    scheduleSettings: {
      matchupPeriodCount: 13,
      matchupPeriodLength: 1,
      playoffTeamCount: 7,
      playoffMatchupPeriodLength: 1,
      playoffSeedingRule: "TOTAL_POINTS_SCORED",
      playoffSeedingRuleBy: 0,
      playoffReseed: true,
      divisions: [
        { id: 0, name: "Class of 2013" }, { id: 1, name: "Class of 2012" },
        { id: 2, name: "Class of 2011" }, { id: 3, name: "Class of 2014" },
      ],
    },
  },
  teams: [...Array(16).keys()].map((i) => ({ id: i + 1, divisionId: i % 4 })),
});

/** The SAME league, read BEFORE the 2026-09 change: 14 weeks, playoffs 15/16/17, a fixed bracket. */
const ESPN_2026_PRE_CHANGE = () => ({
  settings: {
    size: 16,
    scheduleSettings: {
      matchupPeriodCount: 14,
      matchupPeriodLength: 1,
      playoffTeamCount: 7,
      playoffMatchupPeriodLength: 1,
      playoffSeedingRule: "TOTAL_POINTS_SCORED",
      playoffSeedingRuleBy: 0,
      playoffReseed: false,
      divisions: [
        { id: 0, name: "Be Someone" }, { id: 1, name: "Room 214 iirc" },
        { id: 2, name: "7th Floor OGs" }, { id: 3, name: "Probably Adulting" },
      ],
    },
  },
  teams: [...Array(16).keys()].map((i) => ({ id: i + 1, divisionId: i % 4 })),
});

/** The same league in 2019: one division, 13 regular-season weeks, a 6-team field. */
const ESPN_2019 = () => ({
  settings: {
    size: 14,
    scheduleSettings: {
      matchupPeriodCount: 13, matchupPeriodLength: 1,
      playoffTeamCount: 6, playoffMatchupPeriodLength: 1,
      playoffSeedingRule: "TOTAL_POINTS_SCORED", playoffSeedingRuleBy: 0, playoffReseed: false,
      divisions: [{ id: 0, name: "League" }],
    },
  },
  teams: [...Array(14).keys()].map((i) => ({ id: i + 1, divisionId: 0 })),
});

test("the block comes from ESPN: 13 regular weeks, a 7-team field, playoffs 14/15/16, RESEEDING", () => {
  const f = formatFromEspnSettings(ESPN_2026());
  assert.equal(f.regWeeks, 13);
  assert.equal(f.playoffTeams, 7);
  assert.equal(f.playoffRoundWeeks, 1);
  assert.deepEqual(f.playoffWeeks, [14, 15, 16]);
  assert.equal(f.playoffReseed, true, "ESPN says this bracket reseeds -- it must reach the block");
  assert.equal(f.seeding, "division-winners-first");
  assert.equal(f.tiebreak, "TOTAL_POINTS_SCORED");
  assert.equal(f.source, "espn");
  assert.equal(f.divisions.length, 4);
  assert.deepEqual(f.divisions.map((d) => d.teamIds.length), [4, 4, 4, 4]);
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(f.fetchedAt), `fetchedAt "${f.fetchedAt}" is not a local stamp`);
});

test("a ONE-DIVISION season reads as record seeding, and a 13-week calendar as weeks 14/15/16", () => {
  const f = formatFromEspnSettings(ESPN_2019());
  assert.equal(f.regWeeks, 13);
  assert.equal(f.playoffTeams, 6);
  assert.deepEqual(f.playoffWeeks, [14, 15, 16]);
  assert.equal(f.seeding, "record", "with one division there is no division to win");
});

test("playoff rounds: a 6- and a 7-team field both take three weeks; 4 takes two", () => {
  assert.equal(playoffRounds(4), 2);
  assert.equal(playoffRounds(6), 3);
  assert.equal(playoffRounds(7), 3);
  assert.equal(playoffRounds(8), 3);
});

test("the OWNER OVERRIDE block: 13 weeks, playoffs 14/15/16, and it says where it came from", () => {
  const espn = formatFromEspnSettings(ESPN_2026_PRE_CHANGE());
  const owner = validateFormat({
    regWeeks: 13, playoffTeams: 7, playoffRoundWeeks: 1, playoffWeeks: [14, 15, 16],
    seeding: "division-winners-first", playoffReseed: true, tiebreak: espn.tiebreak, divisions: espn.divisions,
    source: "owner-override", fetchedAt: "2026-09-09 09:00",
    note: `ESPN said regWeeks ${espn.regWeeks}, playoffWeeks ${espn.playoffWeeks.join("/")}`,
  }, "test");
  assert.equal(owner.regWeeks, 13);
  assert.deepEqual(owner.playoffWeeks, [14, 15, 16]);
  assert.equal(owner.source, "owner-override");
  assert.equal(effectiveFormat({ format: owner }).regWeeks, 13, "the override, not ESPN, is in force");
  assert.match(String(owner.note), /regWeeks 14/, "the override must record what it overruled");
});

test("FAULT INJECTION: remove matchupPeriodCount and the sync REFUSES rather than defaulting to a plausible number", () => {
  const bad = ESPN_2026();
  delete (bad.settings.scheduleSettings as Record<string, unknown>).matchupPeriodCount;
  assert.throws(() => formatFromEspnSettings(bad), /matchupPeriodCount is missing/);
  // Positive control on the same payload: put it back and it reads. Without this the throw above
  // could equally mean "this fixture never worked", which is the failure mode being guarded.
  assert.equal(formatFromEspnSettings(ESPN_2026()).regWeeks, 13);
});

test("FAULT INJECTION: every other required field is required too", () => {
  for (const [field, pattern] of [
    ["playoffTeamCount", /playoffTeamCount is missing/],
    ["playoffMatchupPeriodLength", /playoffMatchupPeriodLength is missing/],
    ["playoffSeedingRule", /playoffSeedingRule is missing/],
    ["playoffReseed", /playoffReseed is missing/],
    ["divisions", /divisions is missing/],
  ] as [string, RegExp][]) {
    const bad = ESPN_2026();
    delete (bad.settings.scheduleSettings as Record<string, unknown>)[field];
    assert.throws(() => formatFromEspnSettings(bad), pattern, `deleting ${field} must fail loudly`);
  }
  // And a payload with no scheduleSettings at all -- the shape a gated or changed view returns.
  assert.throws(() => formatFromEspnSettings({ settings: {}, teams: [] }), /no scheduleSettings/);
});

test("FAULT INJECTION: a half-written or contradictory stored block is refused", () => {
  const ok = formatFromEspnSettings(ESPN_2026());
  assert.throws(() => effectiveFormat({}), /no league format block/);
  assert.throws(() => effectiveFormat({ format: { ...ok, seeding: "by-vibes" } }), /format.seeding must be one of/);
  assert.throws(() => effectiveFormat({ format: { ...ok, source: "guess" } }), /format.source must be/);
  assert.throws(() => effectiveFormat({ format: { ...ok, playoffWeeks: [] } }), /playoffWeeks is missing or empty/);
  // The one that a naive validator waves through: a calendar that contradicts ITSELF -- 13 regular
  // weeks with the bracket still starting in week 15. Both halves are individually well-formed.
  assert.throws(() => effectiveFormat({ format: { ...ok, regWeeks: 12 } }), /contradicts itself/);
  assert.throws(() => effectiveFormat({ format: { ...ok, playoffReseed: undefined } }), /playoffReseed must be true or false/);
  // Positive control: the untouched block validates.
  assert.equal(effectiveFormat({ format: ok }).regWeeks, 13);
});

test("isSeedingRule accepts exactly the two rules", () => {
  assert.ok(isSeedingRule("record"));
  assert.ok(isSeedingRule("division-winners-first"));
  assert.ok(!isSeedingRule("division_winners_first"));
  assert.ok(!isSeedingRule(undefined));
});
