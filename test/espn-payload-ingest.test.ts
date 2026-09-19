/**
 * A SAVED PAYLOAD MUST BE REFUSED BEFORE IT IS WRITTEN, NOT EXPLAINED AFTERWARDS.
 *
 * `src/data/espnPayload.ts` exists because an agent whose ESPN login lives in a server-side browser
 * cannot speak the desktop app's bridge protocol. Its only route in used to be prose: read a 2.27 MB
 * boxscore and describe it. A description has lost the identity fields the guards check, so the
 * handoff became a FILE -- and a file on disk carries NO record of what was requested. A live fetch
 * at least asked for the league it got; a file did not ask for anything.
 *
 * That makes three guards load-bearing, and all three fail SILENTLY if they are wrong:
 *
 *   1. KIND. `--kind` is declared, never sniffed, because a settings payload and a boxscore payload
 *      share their top-level shape (`id`, `seasonId`, `teams`). A sniffer would guess, and guessing
 *      which view a file holds means writing one view's data under another's name.
 *   2. LEAGUE. A file from league 111111 ingested as 462233 is how a league inherits another
 *      league's rules -- and it would look like a perfectly successful ingest.
 *   3. SEASON. Same shape, one year out: yesterday's download re-ingested as today's.
 *
 * Every refusal below asserts the literal phrase "Nothing was written". That phrase is the CONTRACT
 * that the guard fired BEFORE any write, and it is the only thing in the message that distinguishes
 * "refused early" from "threw halfway through writing". Each guard is asserted in BOTH directions:
 * a guard that always refuses is exactly as broken as one that never does, and in a green run the
 * two are indistinguishable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PAYLOAD_KINDS, KIND_VIEW, ingestEspnPayload, kindMismatch, payloadIdentity, readPayload,
  type PayloadKind,
} from "../src/data/espnPayload.js";

// --- fixtures -------------------------------------------------------------------------------

const LEAGUE = "462233";
const SEASON = 2026;

/** Write one temp file and hand back its path; the caller removes the whole directory. */
function tempFile(name: string, body: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ff-payload-"));
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return { path, dir };
}

/** A minimal boxscore payload: one matchup in `week`, one entry per side. */
const boxscorePayload = (week: number, opts: { id?: string; seasonId?: number } = {}) => ({
  id: opts.id ?? LEAGUE,
  seasonId: opts.seasonId ?? SEASON,
  schedule: [{
    matchupPeriodId: week,
    home: {
      teamId: 8,
      rosterForCurrentScoringPeriod: {
        entries: [{
          playerId: 4262921, lineupSlotId: 23,
          playerPoolEntry: { appliedStatTotal: 12.3, player: { fullName: "Home Starter", defaultPositionId: 3 } },
        }],
      },
    },
    away: {
      teamId: 13,
      rosterForCurrentScoringPeriod: {
        entries: [{
          playerId: 3117251, lineupSlotId: 20,
          playerPoolEntry: { appliedStatTotal: 0, player: { fullName: "Away Bench", defaultPositionId: 2 } },
        }],
      },
    },
  }],
});

// ---------------------------------------------------------------------------------------------
// 1. payloadIdentity -- what the FILE says it is
// ---------------------------------------------------------------------------------------------

test("IDENTITY: a normal object payload reports its own league, season, team count and settings", () => {
  const id = payloadIdentity({ id: 462233, seasonId: 2026, teams: [{}, {}, {}], settings: { name: "X" } });
  // `id` is stringified deliberately: ESPN publishes it as a NUMBER and the store keys leagues by
  // STRING, so an un-normalised compare ("462233" !== 462233) would refuse every correct file.
  assert.equal(id.id, "462233");
  assert.equal(typeof id.id, "string");
  assert.equal(id.seasonId, 2026);
  assert.equal(typeof id.seasonId, "number");
  assert.equal(id.teams, 3);
  assert.equal(id.hasSettings, true);
});

test("IDENTITY: ESPN's one-element ARRAY form reads identically to the object form", () => {
  // Some ESPN league endpoints answer with `[{...}]` and others with `{...}` -- `espnRoot` unwraps
  // both. If identity only understood the object form, every array-shaped file would report
  // `id: null` and the league guard would SKIP (it only fires when id is non-null), so a file from
  // the wrong league would sail straight through. That is why this asserts equality, not just
  // non-null-ness.
  const obj = { id: 462233, seasonId: 2026, teams: [{}, {}], settings: {} };
  assert.deepEqual(payloadIdentity([obj]), payloadIdentity(obj));
  assert.equal(payloadIdentity([obj]).id, "462233");
});

test("IDENTITY: a missing `id` is null -- and everything else is still read", () => {
  // Null means "this file cannot say", which is the ONLY reason the league guard is allowed to skip.
  // The rest of the fields must still be populated: an identity that collapses to all-null on one
  // missing key would disable all three guards at once.
  const id = payloadIdentity({ seasonId: 2026, teams: [{}], settings: {} });
  assert.equal(id.id, null);
  assert.equal(id.seasonId, 2026);
  assert.equal(id.teams, 1);
  assert.equal(id.hasSettings, true);
});

test("IDENTITY: a missing `seasonId` is null, and a missing `teams`/`settings` are null/false", () => {
  const id = payloadIdentity({ id: "462233" });
  assert.equal(id.seasonId, null);
  assert.equal(id.id, "462233", "the league is still readable with no season present");
  assert.equal(id.teams, null, "null is 'no teams key', which is NOT the same as a league of 0 teams");
  assert.equal(id.hasSettings, false);
});

test("IDENTITY: an empty or nullish payload is all-null rather than throwing", () => {
  // The guards must be able to run on a junk-but-parseable file; a throw here would surface as a
  // crash instead of a refusal, and a crash is much easier to retry past than a refusal.
  assert.deepEqual(payloadIdentity({}), { id: null, seasonId: null, teams: null, hasSettings: false });
  assert.deepEqual(payloadIdentity(null), { id: null, seasonId: null, teams: null, hasSettings: false });
  assert.deepEqual(payloadIdentity([]), { id: null, seasonId: null, teams: null, hasSettings: false });
});

// ---------------------------------------------------------------------------------------------
// 2. kindMismatch -- BOTH directions, for EVERY kind
// ---------------------------------------------------------------------------------------------

/**
 * The per-kind fixtures. `has` must produce null (the kind is plausible); `lacks` must produce a
 * reason. `draft` is included even though `ingestEspnPayload` refuses to WRITE it -- `kindMismatch`
 * covers it, so this table covers it, and the completeness assertion below would fail if a sixth
 * kind were added without a fixture.
 */
const KIND_FIXTURES: Record<PayloadKind, { has: unknown; lacks: unknown }> = {
  settings: { has: { settings: { name: "X" } }, lacks: { teams: [{}] } },
  // `rosters` is the one kind that is not a bare key check: a `teams` array whose members carry NO
  // `roster` is exactly what a logged-out mRoster read looks like, so it must NOT count as present.
  rosters: { has: { teams: [{ id: 8, roster: { entries: [] } }] }, lacks: { teams: [{ id: 8 }, { id: 13 }] } },
  draft: { has: { draftDetail: { picks: [] } }, lacks: { teams: [{}] } },
  boxscore: { has: { schedule: [] }, lacks: { schedule: { notAnArray: true } } },
  transactions: { has: { transactions: [] }, lacks: { transactions: null } },
};

test("KIND: the fixture table covers every kind in PAYLOAD_KINDS", () => {
  // DERIVED, NOT RETYPED. A hand-enumerated list of kinds is a snapshot of the day it was written:
  // add a sixth kind and this file would silently test five of six. This is the assertion that
  // notices.
  assert.deepEqual(Object.keys(KIND_FIXTURES).sort(), [...PAYLOAD_KINDS].sort());
  assert.deepEqual(Object.keys(KIND_VIEW).sort(), [...PAYLOAD_KINDS].sort(),
    "every kind must publish the `view=` token an operator is told to save");
});

for (const kind of PAYLOAD_KINDS) {
  test(`KIND ${kind}: a payload that HAS the required field passes (the positive direction)`, () => {
    // Without this half, a `kindMismatch` that returned a reason unconditionally would look like a
    // working guard while refusing every correct file in the repo.
    assert.equal(kindMismatch(KIND_FIXTURES[kind].has, kind), null);
    // And it must survive the array wrapper, since that is how half of ESPN's endpoints answer.
    assert.equal(kindMismatch([KIND_FIXTURES[kind].has], kind), null, "array-wrapped payloads too");
  });

  test(`KIND ${kind}: a payload that LACKS it is refused, by name, with the view to save`, () => {
    const reason = kindMismatch(KIND_FIXTURES[kind].lacks, kind);
    assert.ok(reason, `${kind} must refuse a payload missing its required field`);
    // The message has to be ACTIONABLE by whoever saved the file. Naming the kind alone tells them
    // it went wrong; naming the `view=` token tells them what to save instead, which is the whole
    // difference between a refusal and a dead end.
    assert.ok(reason!.includes(kind), `the reason must name the declared kind: ${reason}`);
    assert.ok(reason!.includes(`view=${KIND_VIEW[kind]}`), `the reason must name the view: ${reason}`);
    assert.ok(reason!.includes("Nothing was written"), `the reason must state that nothing was written: ${reason}`);
  });
}

test("KIND: an empty payload fails EVERY kind -- no kind is accidentally satisfied by nothing", () => {
  // The cross-check the per-kind fixtures cannot make. If one kind's required field were spelled
  // wrong (or checked with a truthiness test that an absent key satisfies), that kind would accept
  // an empty object and the whole guard would be decorative for that view.
  for (const kind of PAYLOAD_KINDS) {
    assert.ok(kindMismatch({}, kind), `an empty payload must not pass as ${kind}`);
  }
});

test("KIND: the kinds are DISCRIMINATING -- a boxscore is not accepted as settings", () => {
  // The reason `--kind` is declared rather than sniffed is that these payloads overlap at the top
  // level. This asserts the check actually separates them, rather than passing everything that
  // merely looks like an ESPN league.
  const box = boxscorePayload(2);
  assert.equal(kindMismatch(box, "boxscore"), null);
  assert.ok(kindMismatch(box, "settings"), "a boxscore has no `settings`");
  assert.ok(kindMismatch(box, "rosters"), "a boxscore has no `teams[].roster`");
  assert.ok(kindMismatch(box, "transactions"), "a boxscore has no `transactions`");
});

// ---------------------------------------------------------------------------------------------
// 3. readPayload
// ---------------------------------------------------------------------------------------------

test("READ: a valid JSON file parses to the object it holds", () => {
  const { path, dir } = tempFile("ok.json", JSON.stringify({ id: "462233", seasonId: 2026 }));
  try {
    assert.deepEqual(readPayload(path), { id: "462233", seasonId: 2026 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("READ: a NON-JSON file throws, and the message tells the operator what to save instead", () => {
  // This is the single most likely operator error in the whole file-handoff loop: saving the
  // RENDERED PAGE (or a chat summary of it) instead of the API response. `JSON.parse`'s own message
  // ("Unexpected token <") does not tell anyone that, so the wrapper must.
  const { path, dir } = tempFile("page.html", "<!doctype html><html><body>Fantasy Football</body></html>");
  try {
    assert.throws(() => readPayload(path), (e: Error) => {
      assert.ok(/not JSON/.test(e.message), e.message);
      assert.ok(/Save the raw API response/.test(e.message),
        `the message must name the fix, not just the symptom: ${e.message}`);
      assert.ok(e.message.includes(path), `the message must name the file that failed: ${e.message}`);
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("READ: a missing file throws too -- an absent payload is never an empty one", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-payload-"));
  try {
    assert.throws(() => readPayload(join(dir, "does-not-exist.json")), /ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------
// 4. ingestEspnPayload -- the refusals
//
// All three of these throw BEFORE `openDb` is reached, so they are asserted with no `db`/`dbPath`
// at all. That is itself part of the contract: if a guard ever moved below the db open, this block
// would start touching the caller's real `data/ff.db`.
// ---------------------------------------------------------------------------------------------

test("REFUSAL: a file from a DIFFERENT league is refused, and both league ids are named", async () => {
  const { path, dir } = tempFile("wrong-league.json", JSON.stringify(boxscorePayload(2, { id: "111111" })));
  try {
    await assert.rejects(
      () => ingestEspnPayload({ file: path, kind: "boxscore", leagueId: LEAGUE, season: SEASON, week: 2, dryRun: true }),
      (e: Error) => {
        // BOTH ids, because "wrong league" without the numbers leaves the operator guessing which
        // of the two is the mistake -- the asked-for one or the saved one.
        assert.ok(e.message.includes("111111"), `must name the file's league: ${e.message}`);
        assert.ok(e.message.includes(LEAGUE), `must name the requested league: ${e.message}`);
        assert.ok(e.message.includes("Nothing was written"), `the write-barrier contract: ${e.message}`);
        return true;
      },
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("REFUSAL: a file from a DIFFERENT season is refused, and both seasons are named", async () => {
  // Same league, one year out. This is the shape a stale download takes: the league guard passes
  // (correct league!), so the season guard is the only thing standing between last year's rosters
  // and this year's table.
  const { path, dir } = tempFile("wrong-season.json", JSON.stringify(boxscorePayload(2, { seasonId: 2025 })));
  try {
    await assert.rejects(
      () => ingestEspnPayload({ file: path, kind: "boxscore", leagueId: LEAGUE, season: SEASON, week: 2, dryRun: true }),
      (e: Error) => {
        assert.ok(e.message.includes("2025"), `must name the file's season: ${e.message}`);
        assert.ok(e.message.includes("2026"), `must name the requested season: ${e.message}`);
        assert.ok(e.message.includes("Nothing was written"), `the write-barrier contract: ${e.message}`);
        return true;
      },
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("REFUSAL: a KIND MISMATCH is refused before anything else happens", async () => {
  // The file is a perfectly good boxscore for the right league and season -- declared as `settings`.
  // Nothing about the identity fields is wrong, so only the kind check can catch it.
  const { path, dir } = tempFile("box.json", JSON.stringify(boxscorePayload(2)));
  try {
    await assert.rejects(
      () => ingestEspnPayload({ file: path, kind: "settings", leagueId: LEAGUE, season: SEASON, dryRun: true }),
      (e: Error) => {
        assert.ok(/REFUSED/.test(e.message), e.message);
        assert.ok(e.message.includes("settings"), `must name the declared kind: ${e.message}`);
        assert.ok(e.message.includes(`view=${KIND_VIEW.settings}`), `must name the view to save: ${e.message}`);
        assert.ok(e.message.includes("Nothing was written"), `the write-barrier contract: ${e.message}`);
        return true;
      },
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("REFUSAL: the kind check runs BEFORE the identity check -- one refusal, not a cascade", async () => {
  // A file that is wrong in two ways must still produce the message an operator can act on first.
  // If the order ever inverted, the operator would fix the league id, re-run, and only then learn
  // the file was the wrong view at all.
  const { path, dir } = tempFile("both-wrong.json", JSON.stringify({ id: "111111", seasonId: 2025, teams: [{}] }));
  try {
    await assert.rejects(
      () => ingestEspnPayload({ file: path, kind: "boxscore", leagueId: LEAGUE, season: SEASON, week: 2, dryRun: true }),
      (e: Error) => {
        assert.ok(e.message.includes("view=mBoxscore"), `the KIND refusal wins: ${e.message}`);
        return true;
      },
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------
// 5. THE POSITIVE CONTROL
//
// The refusals above prove the guards can say NO. On their own, a `ingestEspnPayload` that threw
// unconditionally would pass every one of them. These prove it can also say YES -- which is the
// half that fault injection cannot reach.
//
// NOTE ON THE DB. `ingestEspnPayload` opens a database BEFORE the switch, so even a `--dry-run`
// needs one: with no `db`/`dbPath` it would open the caller's real `data/ff.db`. These tests pass
// `dbPath: ":memory:"` rather than faking it. Nothing is written either way (the dry-run branches
// return before any INSERT), but the open is real, so the path must be too.
// ---------------------------------------------------------------------------------------------

test("DRY RUN boxscore: a well-formed payload parses, reports rows, and writes nothing", async () => {
  const { path, dir } = tempFile("good-box.json", JSON.stringify(boxscorePayload(2)));
  try {
    const r = await ingestEspnPayload({
      file: path, kind: "boxscore", leagueId: LEAGUE, season: SEASON, week: 2,
      dryRun: true, dbPath: ":memory:",
    });
    assert.equal(r.kind, "boxscore");
    assert.equal(r.leagueId, LEAGUE);
    assert.equal(r.season, SEASON);
    // Two entries across the matchup's two sides. A row count of 0 with a cheerful note is the
    // failure this asserts against: it is what a hollow payload produces, and it reads as success.
    assert.equal(r.rows, 2, "both sides' entries must be parsed");
    assert.ok(/DRY RUN/.test(r.note), `the note must say it was a dry run: ${r.note}`);
    assert.ok(r.note.includes("2"), `the note must carry the count: ${r.note}`);
    // Identity is reported on EVERY ingest, so the operator can see the file was the one they meant.
    assert.deepEqual(r.identity, { id: LEAGUE, seasonId: SEASON, teams: null, hasSettings: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("DRY RUN boxscore: the WEEK must be declared -- a boxscore file does not say which week it is", async () => {
  // ESPN answers a `scoringPeriodId` query with a payload that does not restate it, so the week is
  // knowledge the SAVER has and the file does not. Defaulting it would file week 7's roster under
  // week 1 and report success.
  const { path, dir } = tempFile("good-box.json", JSON.stringify(boxscorePayload(2)));
  try {
    await assert.rejects(
      () => ingestEspnPayload({ file: path, kind: "boxscore", leagueId: LEAGUE, season: SEASON, dryRun: true, dbPath: ":memory:" }),
      /needs --week/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("DRY RUN rosters: a well-formed mRoster payload parses to rostered players", async () => {
  // A second kind, because a dry run that only ever worked for boxscores would still pass the test
  // above. `rosters` is also the kind whose real write carries the refuse-empty-wipe guard, so
  // knowing the parse reaches real players is what makes that guard meaningful.
  const payload = {
    id: LEAGUE, seasonId: SEASON,
    members: [{ id: "{M1}", displayName: "Manager One" }],
    teams: [{
      id: 8, name: "Team Eight", abbrev: "T8", owners: ["{M1}"],
      roster: {
        entries: [
          { lineupSlotId: 0, playerPoolEntry: { player: { fullName: "Starting QB", defaultPositionId: 1 } } },
          { lineupSlotId: 20, playerPoolEntry: { player: { fullName: "Bench RB", defaultPositionId: 2 } } },
        ],
      },
    }],
  };
  const { path, dir } = tempFile("good-rosters.json", JSON.stringify(payload));
  try {
    const r = await ingestEspnPayload({
      file: path, kind: "rosters", leagueId: LEAGUE, season: SEASON, dryRun: true, dbPath: ":memory:",
    });
    assert.equal(r.kind, "rosters");
    assert.equal(r.rows, 2, "both rostered players must be counted");
    assert.ok(/DRY RUN/.test(r.note), r.note);
    assert.equal(r.identity.teams, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("DRY RUN: a matching league and season are NOT refused -- the guards can say yes", async () => {
  // The direct positive control on the two identity guards. Asserted separately from the parse
  // above so that a failure here points at the guard rather than at the parser.
  const { path, dir } = tempFile("good-box.json", JSON.stringify(boxscorePayload(2)));
  try {
    await assert.doesNotReject(() => ingestEspnPayload({
      file: path, kind: "boxscore", leagueId: LEAGUE, season: SEASON, week: 2, dryRun: true, dbPath: ":memory:",
    }));
    // ...and a NUMERIC league id in the file still matches the STRING the caller passes, because the
    // comparison is stringified. If it were not, every real ESPN file would be refused.
    const numeric = tempFile("numeric.json", JSON.stringify({ ...boxscorePayload(2), id: 462233 }));
    try {
      await assert.doesNotReject(() => ingestEspnPayload({
        file: numeric.path, kind: "boxscore", leagueId: LEAGUE, season: SEASON, week: 2, dryRun: true, dbPath: ":memory:",
      }));
    } finally { rmSync(numeric.dir, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("DRAFT: the unwired kind refuses LOUDLY rather than accepting a file and writing nothing", async () => {
  // `kindMismatch` covers `draft`, so a draft payload gets all the way past the guards -- and then
  // must refuse. A verb that accepted the file and silently wrote nothing would be indistinguishable
  // from a successful ingest, which is the exact failure this whole module is built against.
  const { path, dir } = tempFile("draft.json", JSON.stringify({ id: LEAGUE, seasonId: SEASON, draftDetail: { picks: [] } }));
  try {
    assert.equal(kindMismatch(readPayload(path), "draft"), null,
      "the payload really is a plausible draft payload -- so the refusal below is not a kind mismatch");
    await assert.rejects(
      () => ingestEspnPayload({ file: path, kind: "draft", leagueId: LEAGUE, season: SEASON, dryRun: true, dbPath: ":memory:" }),
      /not wired yet/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
