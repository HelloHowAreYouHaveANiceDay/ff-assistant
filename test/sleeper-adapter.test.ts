/**
 * THE SLEEPER ADAPTOR -- the third platform, read against saved payloads from the real league.
 *
 * The fixtures are The Dy-nasty (1353038434335195136, 10 teams, dynasty, SUPER_FLEX, no kicker),
 * saved from the public API on 2026-09-20. They are served back through `filePlatformIO`, which is
 * the same seam the live path uses, so what these tests exercise is the adaptor rather than a
 * hand-built object shaped like one.
 *
 * THE LOAD-BEARING TEST IS THE GROUND TRUTH ONE. Sleeper publishes each roster's own week score
 * beside the per-player points, so "did we identify the right ten starters" has an answer that does
 * not come from us. Every other assertion here could pass while the slot alignment was wrong; that
 * one could not. It agreed 10/10 live before it was written down.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filePlatformIO, platformFor, knownPlatforms } from "../src/league/platform.js";
import {
  sleeperSlotId, sleeperSlotName, sleeperScoringRules, sleeperKickerRules, sleeperDefenseRules,
  sleeperScoringBucket, sleeperUser, parseSleeperPlayers, startingTokens, sleeperPlayerKey,
  sleeperPlatform, __resetSleeperPlayerCache, type SleeperScoring,
} from "../src/league/sleeper.js";

import { ESPN_SLOT_NAME as ESPN_SLOT_NAME_T } from "../src/league/espnSlots.js";

const FIX = join("test", "fixtures", "sleeper");
const LEAGUE = "1353038434335195136";
const leagueJson = JSON.parse(readFileSync(join(FIX, "league.json"), "utf8")) as { scoring_settings: SleeperScoring; roster_positions: string[] };
const SC = leagueJson.scoring_settings;

/**
 * ORDER MATTERS AND IS NOT INCIDENTAL. `filePlatformIO` takes the FIRST token the url contains, and
 * `/league/<id>/rosters` contains `/league/<id>`. The specific tokens must therefore precede the
 * general one, or every read would be served the league payload -- which would parse, and produce
 * nonsense.
 */
const io = () => filePlatformIO({
  "/league/1353038434335195136/rosters": join(FIX, "rosters.json"),
  "/league/1353038434335195136/users": join(FIX, "users.json"),
  "/league/1353038434335195136/matchups/1": join(FIX, "matchups-1.json"),
  "/players/nfl": join(FIX, "players.json"),
  "/league/1353038434335195136": join(FIX, "league.json"),
});

test("the registry carries sleeper, and it resolves to the adaptor", async () => {
  assert.ok(knownPlatforms().includes("sleeper"), `knownPlatforms() is ${knownPlatforms().join(",")}`);
  const p = await platformFor("sleeper");
  assert.equal(p.id, "sleeper");
  assert.equal(p.host, "api.sleeper.app");
  // Read-only and sessionless, both stated by ABSENCE per the contract.
  assert.equal(p.writes, undefined, "sleeper must declare no writes -- a write capability it does not have would be refused later, somewhere else");
  assert.equal(p.webview, undefined, "sleeper needs no login, so it must not claim an Electron guest");
});

test("SUPER_FLEX maps to ESPN's OP slot -- the D24 work is what makes this league expressible", () => {
  assert.equal(sleeperSlotId("SUPER_FLEX"), 7);
  assert.equal(sleeperSlotName("SUPER_FLEX"), "OP");
  assert.equal(sleeperSlotId("FLEX"), 23);
  assert.equal(sleeperSlotName("FLEX"), "FLEX");
  assert.equal(sleeperSlotId("DEF"), 16);
  assert.equal(sleeperSlotName("DEF"), "DST");
  assert.equal(sleeperSlotId("BN"), 20);
  assert.equal(sleeperSlotId("QB"), 0);
});

test("FAULT: an unknown roster position REFUSES rather than becoming a bench seat", () => {
  assert.throws(() => sleeperSlotId("WOMBAT_FLEX"), /unknown roster position "WOMBAT_FLEX"/);
});

test("startingTokens drops bench and taxi, and keeps the starting slots IN ORDER", () => {
  const t = startingTokens(leagueJson.roster_positions);
  assert.deepEqual(t, ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "SUPER_FLEX", "DEF"]);
  assert.equal(t.length, 10, "the order is what aligns `starters[i]` to a slot; a set would lose it");
});

test("offense scoring is read verbatim from the league's own settings", () => {
  const s = sleeperScoringRules(SC);
  assert.equal(s.rec, 0.5);
  assert.equal(s.passYd, 0.04);
  assert.equal(s.passTD, 4);
  assert.equal(s.int, -1, "this league pays -1 for an interception, NOT the -2 the repo default carries");
  assert.equal(s.rushYd, 0.1);
  assert.equal(s.rushTD, 6);
  assert.equal(s.recTD, 6);
  assert.equal(s.fumble, -2);
  assert.equal(s.twoPt, 2);
  assert.equal(sleeperScoringBucket(SC), "HALF");
});

test("FAULT: a two-point conversion scored differently by type REFUSES", () => {
  assert.throws(() => sleeperScoringRules({ ...SC, rush_2pt: 1 }), /two-point conversions are scored differently/);
});

test("FAULT: a missing required scoring key REFUSES rather than defaulting to zero", () => {
  const { pass_td: _drop, ...without } = SC;
  assert.throws(() => sleeperScoringRules(without), /no "pass_td"/);
});

test("defense scoring, including the points-allowed ladder", () => {
  const d = sleeperDefenseRules(SC);
  assert.equal(d.sack, 1);
  assert.equal(d.interception, 2);
  assert.equal(d.safety, 2);
  assert.equal(d.blockedKick, 2);
  assert.equal(d.td, 6);
  assert.deepEqual(d.paLadder, [[0, 10], [6, 7], [13, 4], [20, 1], [27, 0], [34, -1], [Infinity, -4]]);
  // The LAST bound is Infinity in memory. It becomes null through JSON, which the repo already
  // documents as a real bug it paid for -- asserted here so a change of form is visible.
  assert.equal(JSON.parse(JSON.stringify(d.paLadder)).at(-1)[0], null);
});

test("FAULT: defensive and special-teams TDs scored differently REFUSES", () => {
  assert.throws(() => sleeperDefenseRules({ ...SC, st_td: 10 }), /scored differently/);
});

test("FAULT: a split FG 0-39 bucket REFUSES rather than silently collapsing", () => {
  assert.throws(() => sleeperKickerRules({ ...SC, fgm_20_29: 4 }), /FG 0-39 is not one value/);
});

test("kicker rules ARE readable when asked for -- the positive control on the null below", () => {
  const k = sleeperKickerRules(SC);
  assert.equal(k.fg0_39, 3);
  assert.equal(k.fg40_49, 4);
  assert.equal(k.fg50_59, 5);
  assert.equal(k.pat, 1);
});

test("the player map names a team defence the way every other surface does", () => {
  const m = parseSleeperPlayers(readFileSync(join(FIX, "players.json"), "utf8"));
  const den = m.get("DEN");
  assert.ok(den, "the fixture must carry DEN's defence");
  assert.equal(den.name, "DEN D/ST");
  assert.equal(den.pos, "DST", "Sleeper says DEF; the repo says DST everywhere else");
  const allen = m.get("4984");
  assert.equal(allen?.name, "Josh Allen");
  assert.equal(allen?.pos, "QB");
});

test("FAULT: a thin player payload REFUSES rather than silently blanking rosters", () => {
  assert.throws(() => parseSleeperPlayers(JSON.stringify({ "1": { full_name: "A B", position: "QB", team: "BUF" } })), /refusing a payload this thin/);
});

test("sleeperUser REFUSES when nobody said who we are -- it must not read as 'no leagues'", () => {
  const saved = process.env.FF_SLEEPER_USER;
  try {
    delete process.env.FF_SLEEPER_USER;
    assert.throws(() => sleeperUser(), /no username/);
    assert.equal(sleeperUser({ swid: "artistm" }), "artistm", "hints carry identity when the env does not");
    process.env.FF_SLEEPER_USER = "fromenv";
    assert.equal(sleeperUser(), "fromenv");
  } finally {
    if (saved === undefined) delete process.env.FF_SLEEPER_USER; else process.env.FF_SLEEPER_USER = saved;
  }
});

test("syncSettings reads the dynasty league's rules, and states what it could not read", async () => {
  __resetSleeperPlayerCache();
  const s = await sleeperPlatform.syncSettings(io(), LEAGUE, 2026);
  assert.equal(s.platform, "sleeper");
  assert.equal(s.teams, 10);
  assert.equal(s.draftType, "snake");
  assert.equal(s.budget, null, "a FAAB budget is not auction dollars");
  assert.equal(s.scoringBucket, "HALF");
  assert.deepEqual(s.slots.slice(0, 10), ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "OP", "DST"]);

  // THE CONTRACT RULE, EXERCISED: this league rosters a DEF but no K, so kicker is null -- even
  // though Sleeper publishes perfectly good kicking values that are simply unreachable.
  assert.equal(s.kicker, null, "no K slot means null, not another league's constants");
  assert.ok(s.defense, "it does roster a DEF, so defence rules must be present");

  assert.equal(s.format.regWeeks, 14);
  assert.equal(s.format.playoffTeams, 6);
  assert.deepEqual(s.format.playoffWeeks, [15, 16, 17]);
  assert.equal(s.acquisition.faabBudget, 100);

  // Provenance that an auditor can act on, including the thing Sleeper does not publish.
  assert.match(s.rosterSettings.league_type, /dynasty/);
  assert.match(s.rosterSettings.playoff_reseed, /NOT PUBLISHED BY SLEEPER/);
  assert.match(s.rosterSettings.kicker_slot, /UNREACHABLE/);
  assert.equal(s.rosterSettings.previous_league_id, "1238610819197960192", "the dynasty history chain");
});

test("FAULT: a league with a K slot gets REAL kicker rules -- proving the null above is read, not hardcoded", async () => {
  __resetSleeperPlayerCache();
  const withK = { ...leagueJson, roster_positions: [...leagueJson.roster_positions, "K"] };
  const alt = filePlatformIO({
    "/league/1353038434335195136/rosters": join(FIX, "rosters.json"),
    "/players/nfl": join(FIX, "players.json"),
    "/league/1353038434335195136": join(FIX, "league-withk.json"),
  });
  const { writeFileSync, unlinkSync } = await import("node:fs");
  writeFileSync(join(FIX, "league-withk.json"), JSON.stringify(withK));
  try {
    const s = await sleeperPlatform.syncSettings(alt, LEAGUE, 2026);
    assert.ok(s.kicker, "with a K slot the very same payload must yield kicker rules");
    assert.equal(s.kicker.fg40_49, 4);
  } finally { unlinkSync(join(FIX, "league-withk.json")); }
});

test("syncRosters resolves ids to men, and gives each his slot from the starters order", async () => {
  __resetSleeperPlayerCache();
  const rosters = await sleeperPlatform.syncRosters(io(), LEAGUE, 2026);
  assert.equal(rosters.length, 10);
  for (const r of rosters) {
    const starters = r.players.filter((p) => p.slot !== "BE" && p.slot !== "IR");
    assert.equal(starters.length, 10, `roster ${r.teamId} started ${starters.length}, not the template's 10`);
    // Exactly one of each dedicated slot, and the superflex is a real OP.
    assert.equal(starters.filter((p) => p.slot === "OP").length, 1, `roster ${r.teamId} has no OP (superflex) starter`);
    assert.equal(starters.filter((p) => p.slot === "DST").length, 1);
    assert.equal(starters.filter((p) => p.slot === "FLEX").length, 2);
    assert.ok(r.teamName && r.teamName.length > 0, "a roster must be named");
  }
});

/**
 * THE GROUND TRUTH. Sleeper publishes `points` per roster AND `players_points` per man, so the
 * starters we pick out of the positional array can be checked against the platform's own arithmetic.
 * This is the assertion that would fail if the slot alignment were off by one, if bench men leaked
 * into the starting set, or if a starter were dropped -- none of which the shape tests above notice.
 */
test("GROUND TRUTH: our week-1 starters sum to Sleeper's own reported score, all 10 rosters", async () => {
  __resetSleeperPlayerCache();
  const rows = await sleeperPlatform.rosterWeek!(io(), LEAGUE, 2026, 1);
  const reported = new Map(
    (JSON.parse(readFileSync(join(FIX, "matchups-1.json"), "utf8")) as { roster_id: number; points: number }[])
      .map((m) => [String(m.roster_id), m.points]),
  );
  assert.equal(reported.size, 10);
  const byTeam = new Map<string, number>();
  for (const r of rows) if (r.isStarter) byTeam.set(r.teamId, (byTeam.get(r.teamId) ?? 0) + (r.appliedPoints ?? 0));
  assert.equal(byTeam.size, 10, "every roster must have starters");
  for (const [teamId, sum] of byTeam) {
    const want = reported.get(teamId)!;
    assert.ok(Math.abs(sum - want) < 0.011, `roster ${teamId}: we summed ${sum.toFixed(2)}, Sleeper reported ${want}`);
  }
});

/**
 * THE SLOT ASSIGNMENT, WHICH THE GROUND-TRUTH SUM CANNOT SEE.
 *
 * Written because fault injection caught the gap: shifting `starters[i]` to `tokens[i+1]` left all
 * 22 tests green. The sum is blind to it -- an off-by-one changes which SLOT each starter holds but
 * not the SET of starters, so every roster still totalled Sleeper's reported score exactly.
 *
 * So this asserts the two things the sum cannot: that each roster's starting slots are the TEMPLATE's
 * multiset, and that every man is POSITION-ELIGIBLE for the slot he is in -- through `slotAdmits`,
 * the same definition every other consumer uses, not a literal list. A QB sitting in an RB slot is
 * the symptom an off-by-one actually produces, and it is what would corrupt every replacement level
 * computed from this league.
 */
test("every week-1 starter is POSITION-ELIGIBLE for his slot, and the slots are the template", async () => {
  __resetSleeperPlayerCache();
  const rows = await sleeperPlatform.rosterWeek!(io(), LEAGUE, 2026, 1);
  const { slotAdmits } = await import("../src/draft/slots.js");
  const wantSlots = startingTokens(leagueJson.roster_positions).map(sleeperSlotName).sort();

  const byTeam = new Map<string, typeof rows>();
  for (const r of rows) if (r.isStarter) byTeam.set(r.teamId, [...(byTeam.get(r.teamId) ?? []), r]);
  assert.equal(byTeam.size, 10);

  for (const [teamId, starters] of byTeam) {
    const got = starters.map((r) => ESPN_SLOT_NAME_T[r.lineupSlotId] ?? String(r.lineupSlotId)).sort();
    assert.deepEqual(got, wantSlots, `roster ${teamId} started slots ${got.join(",")} -- the template is ${wantSlots.join(",")}`);
    for (const r of starters) {
      const slot = ESPN_SLOT_NAME_T[r.lineupSlotId] ?? String(r.lineupSlotId);
      const admits = slotAdmits(slot);
      assert.ok(
        admits.includes(r.position),
        `roster ${teamId}: ${r.position} ${r.name} is in slot ${slot}, which admits ${admits.join("/")}`,
      );
    }
  }
});

test("rosterWeek carries the whole league, namespaced ids, and 10 starters per team", async () => {
  __resetSleeperPlayerCache();
  const rows = await sleeperPlatform.rosterWeek!(io(), LEAGUE, 2026, 1);
  assert.equal(new Set(rows.map((r) => r.teamId)).size, 10);
  assert.equal(rows.filter((r) => r.isStarter).length, 100, "10 teams x 10 starting slots");
  for (const r of rows) {
    assert.ok(r.platformPlayerId.startsWith("s:"), `id ${r.platformPlayerId} is not namespaced -- it would collide with an ESPN id in the same column`);
    assert.notEqual(r.name, "", "a row with no name would resolve to nobody");
  }
  assert.equal(sleeperPlayerKey("4984"), "s:4984");
});

test("a man the week has no points for is null, NEVER a manufactured zero", async () => {
  __resetSleeperPlayerCache();
  const ms = JSON.parse(readFileSync(join(FIX, "matchups-1.json"), "utf8")) as { roster_id: number; players: string[]; players_points: Record<string, number> }[];
  // Take a real roster and remove one man's points entry, leaving him on the roster.
  const doctored = ms.map((m, i) => {
    if (i !== 0) return m;
    const victim = m.players.find((p) => p in m.players_points)!;
    const pts = { ...m.players_points };
    delete pts[victim];
    return { ...m, players_points: pts, __victim: victim };
  });
  const victim = (doctored[0] as unknown as { __victim: string }).__victim;
  const { writeFileSync, unlinkSync } = await import("node:fs");
  writeFileSync(join(FIX, "matchups-doctored.json"), JSON.stringify(doctored));
  const alt = filePlatformIO({
    "/league/1353038434335195136/matchups/1": join(FIX, "matchups-doctored.json"),
    "/players/nfl": join(FIX, "players.json"),
    "/league/1353038434335195136": join(FIX, "league.json"),
  });
  try {
    __resetSleeperPlayerCache();
    const rows = await sleeperPlatform.rosterWeek!(alt, LEAGUE, 2026, 1);
    const row = rows.find((r) => r.platformPlayerId === sleeperPlayerKey(victim));
    assert.ok(row, "the man must still appear on the roster");
    assert.equal(row.appliedPoints, null, "no entry must be null -- a zero week is a real result and must not be invented");
  } finally { unlinkSync(join(FIX, "matchups-doctored.json")); }
});

test("readTeam returns our roster as the platform-agnostic type", async () => {
  __resetSleeperPlayerCache();
  const t = await sleeperPlatform.readTeam(io(), LEAGUE, 2026, "8");
  assert.equal(t.id, "8");
  assert.ok(t.roster.length > 20, `dynasty rosters are deep; got ${t.roster.length}`);
  assert.ok(t.roster.every((p) => p.proj === 0), "valuation is attached by openLeague, not here");
  assert.ok(t.roster.some((p) => p.pos === "DST"));
});

test("FAULT: an unmatched url REFUSES instead of returning an empty body", async () => {
  __resetSleeperPlayerCache();
  const empty = filePlatformIO({ "/players/nfl": join(FIX, "players.json") });
  await assert.rejects(() => sleeperPlatform.syncSettings(empty, LEAGUE, 2026), /no saved payload matches/);
});
