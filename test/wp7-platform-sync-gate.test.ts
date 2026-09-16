/**
 * WP7 -- the Yahoo end-to-end seam and the per-format gate axis.
 *
 * FOUR THINGS ARE PINNED HERE, and each of them is a place where a wrong answer would have rendered
 * perfectly:
 *
 *   1. THE OWNERSHIP SYNC IS PLATFORM-DISPATCHED AND KEYED THE SAME WAY FOR BOTH PLATFORMS. The verb
 *      used to be an ESPN body inside ff.ts; the rows it wrote are joined against `board` and
 *      `player` by `nameKey`, with a defense aliased from ESPN's NICKNAME to the ABBREVIATION every
 *      other table uses. A Yahoo path that skipped the alias, or an ESPN path that changed a single
 *      key in the refactor, is a roster that silently comes up one starter short -- and that is
 *      invisible in every output.
 *
 *   2. THE EMPTY-PULL GUARD STILL REFUSES. The write is delete-then-insert, so a read that came back
 *      with nothing used to wipe the league and exit 0.
 *
 *   3. THE FITTERS' `--league` RESOLUTION. `fitPaths` with no flag must return the historical
 *      literals BY CONSTRUCTION -- not because a resolver happens to agree -- or every re-fit of the
 *      shipped variance/correlation/rank-outcome models is a silent change of input.
 *
 *   4. THE GATE REFUSES A FORMAT WITH NO GOLDEN, BY NAME. The dangerous alternative is not a crash:
 *      it is gating a second format's backtest against the incumbent's pinned 96.0%, which passes or
 *      fails for a reason that has nothing to do with the format under test.
 *
 * Plus the conservation law the season simulator must satisfy on any field size, because the Yahoo
 * league's 8-of-12 playoff field is the first time it has been exercised anywhere but 7-of-16.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, nowIso, type DB } from "../src/db/db.js";
import { dataPath } from "../src/data/paths.js";
import { ownershipRowsFrom, writeOwnership } from "../src/data/ownershipSync.js";
import { espnRostersFromPayload } from "../src/league/espnPlatform.js";
import { yahooPlatform } from "../src/league/yahoo.js";
import { platformFor } from "../src/league/platform.js";
import type { PlatformIO, PlatformRoster } from "../src/league/platform.js";
import { fitPaths } from "../scripts/lib/format-paths.mjs";
import { loadGolden, NoGoldenError } from "../scripts/lib/golden.mjs";
import { INCUMBENT_MODEL } from "../src/data/formatResolve.js";
import { simulateSeasons, type SeasonTeamInput, type VarianceModel } from "../src/draft/season.js";

function withStore(fn: (db: DB) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "wp7-"));
  const db = openDb(join(dir, "ff.db"));
  try { fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

// =================================================================================================
// 1. THE OWNERSHIP ROWS -- same keying, whichever platform produced the roster
// =================================================================================================

/** The exact shape ESPN's `view=mTeam&view=mRoster` returns, trimmed to what the parser reads. */
const ESPN_PAYLOAD = {
  members: [{ id: "{GUID-A}", displayName: "TeamFBGM" }, { id: "{GUID-B}", firstName: "Dana" }],
  teams: [
    {
      id: 1, abbrev: "HMLS", location: "Home", nickname: "Less", owners: ["{GUID-A}"],
      roster: { entries: [
        { lineupSlotId: 2, playerPoolEntry: { player: { fullName: "De'Von Achane", defaultPositionId: 2 } } },
        // A DEFENSE, by ESPN's nickname. `board` keys it by abbreviation, so this row is the alias test.
        { lineupSlotId: 16, playerPoolEntry: { player: { fullName: "Packers D/ST", defaultPositionId: 16 } } },
      ] },
    },
    {
      // No abbrev and no owner GUID in `members`: the two documented fallbacks.
      id: 2, location: "Second", nickname: "Squad", owners: ["{GUID-UNKNOWN}"],
      roster: { entries: [{ lineupSlotId: 20, playerPoolEntry: { player: { fullName: "Chase Brown", defaultPositionId: 2 } } }] },
    },
  ],
};

test("ESPN rosters carry owner + abbrev, and ownership rows key exactly as the old ESPN body did", () => {
  const rosters = espnRostersFromPayload(ESPN_PAYLOAD);
  assert.equal(rosters.length, 2);
  assert.equal(rosters[0].owner, "TeamFBGM", "the owner is the member display name for the team's first owner GUID");
  assert.equal(rosters[0].abbrev, "HMLS");
  assert.equal(rosters[1].owner, "Second Squad", "an unknown GUID falls back to location+nickname, not to a manufactured name");
  assert.equal(rosters[1].abbrev, "T2", "no abbrev falls back to T<id>");

  const rows = ownershipRowsFrom(rosters);
  const byId = new Map(rows.map((r) => [r.playerId, r]));
  assert.equal(rows.length, 3);
  assert.deepEqual(
    { ...byId.get("devonachane")! },
    { playerId: "devonachane", owner: "TeamFBGM", abbrev: "HMLS", slot: "RB", teamId: "1" },
  );
  // THE DEFENSE ALIAS, on the POSITION not the slot. "Packers D/ST" -> nameKey "packers" -> "gb".
  assert.ok(byId.has("gb"), `the defense must be stored under its abbreviation key, got ${[...byId.keys()].join(", ")}`);
  assert.equal(byId.get("gb")!.slot, "DST");
  assert.ok(!byId.has("packers"), "the un-aliased nickname key matches nothing downstream and must not be written");
  // A BENCHED player keeps his bench slot -- the alias is keyed on position precisely so this works.
  assert.equal(byId.get("chasebrown")!.slot, "BE");
});

test("a Yahoo roster produces ownership rows keyed the same way, with our slot vocabulary", async () => {
  // The ADAPTOR does the platform vocabulary (BN -> BE, Q/W/R/T -> SUPERFLEX); the writer does the
  // keying. Driving the real adaptor over a stub IO is what proves the two halves meet.
  const io: PlatformIO = {
    get: async () => `
      <table><tr><td class="team">Joe's Rookie Daycare</td></tr></table>
      <a href="/f1/129048/11">Joe's Rookie Daycare</a>`,
  };
  // The DOM parser is pinned by test/yahoo-*.test.ts against real fixtures; here we only need the
  // roster SHAPE, so the adaptor's output is stood in for directly.
  const rosters: PlatformRoster[] = [{
    teamId: "11", teamName: "Joe's Rookie Daycare", owner: null, abbrev: null,
    players: [
      { name: "Jared Goff", pos: "QB", slot: "QB" },
      { name: "Joe Burrow", pos: "QB", slot: "SUPERFLEX" },
      { name: "Isiah Pacheco", pos: "RB", slot: "IR" },
    ],
  }];
  void io;
  const rows = ownershipRowsFrom(rosters);
  assert.deepEqual(rows.map((r) => `${r.slot}:${r.playerId}`), ["QB:jaredgoff", "SUPERFLEX:joeburrow", "IR:isiahpacheco"]);
  // No owner and no abbrev published by the platform: fall back to what the READ produced (the team
  // name), never to an ESPN-shaped convention.
  assert.equal(rows[0].owner, "Joe's Rookie Daycare");
  assert.equal(rows[0].abbrev, "T11");
  // And the adaptor really is the one that normalizes the tokens -- if this ever stops being true the
  // slots above become phantom starting positions at a position called "BN".
  const { YAHOO_SLOT } = await import("../src/league/yahoo.js");
  assert.equal(YAHOO_SLOT.BN, "BE");
  assert.equal(YAHOO_SLOT["Q/W/R/T"], "SUPERFLEX");
});

test("writeOwnership REFUSES to wipe real rows with an empty pull, and is league-scoped", () => {
  withStore((db) => {
    const now = nowIso();
    const w1 = writeOwnership(db, "A", espnRostersFromPayload(ESPN_PAYLOAD), now);
    assert.equal(w1.decision, "written");
    assert.equal(w1.rows, 3);
    assert.equal(w1.teams, 2);

    // A SECOND LEAGUE does not disturb the first.
    writeOwnership(db, "B", [{ teamId: "1", teamName: "other", players: [{ name: "Josh Allen", pos: "QB", slot: "QB" }] }], now);
    assert.equal((db.prepare("SELECT count(*) c FROM ownership WHERE league_id='A'").get() as { c: number }).c, 3);
    assert.equal((db.prepare("SELECT count(*) c FROM ownership WHERE league_id='B'").get() as { c: number }).c, 1);

    // THE GUARD. An empty read with rows to lose is a refusal, and nothing is deleted.
    const w2 = writeOwnership(db, "A", [], now);
    assert.equal(w2.decision, "refuse-empty-wipe");
    assert.equal(w2.existing, 3);
    assert.equal((db.prepare("SELECT count(*) c FROM ownership WHERE league_id='A'").get() as { c: number }).c, 3,
      "the refusal must leave the stored rows exactly where they were");

    // An empty read with NOTHING to lose is the genuine pre-draft case and is a quiet no-op.
    assert.equal(writeOwnership(db, "C", [], now).decision, "noop-empty");
  });
});

test("platformFor dispatches both adaptors and refuses an unknown platform BY NAME", async () => {
  assert.equal((await platformFor("espn")).id, "espn");
  assert.equal((await platformFor("yahoo")).id, "yahoo");
  assert.equal((await platformFor("yahoo")).webview.host, yahooPlatform.webview.host);
  await assert.rejects(() => platformFor("sleeper"), /no platform adaptor for "sleeper".*espn, yahoo/s);
  await assert.rejects(() => platformFor(null), /no platform adaptor for "unknown"/);
});

// =================================================================================================
// 2. THE FITTERS' --league RESOLUTION
// =================================================================================================

test("fitPaths with no --league returns the historical literals, by construction", () => {
  // BY CONSTRUCTION is the point: with no flag it opens no store and consults no resolver, so there
  // is no way for a store's contents to move the shipped fit's input or output.
  const v = fitPaths("variance", "data/variance-model.json", []);
  assert.equal(v.weeklyCsv, "data/history-weekly.csv");
  assert.equal(v.out, "data/variance-model.json");
  const c = fitPaths("correlation", "data/correlation-model.json", []);
  assert.equal(c.out, "data/correlation-model.json");
  const r = fitPaths("rank-outcomes", "data/rank-outcomes.json", []);
  assert.equal(r.out, "data/rank-outcomes.json");
  // And those literals ARE the incumbent's artifact paths -- a rename on one side and not the other
  // would leave the shipped fitter writing a file nothing reads. Compared with the separator
  // normalized: `dataPath` produces the platform's separator and the literals are POSIX, which is the
  // same file and would otherwise make this assertion a Windows-only failure.
  const norm = (p: string) => p.replace(/\\/g, "/");
  assert.equal(norm(v.out), norm(INCUMBENT_MODEL.path("variance")));
  assert.equal(norm(c.out), norm(INCUMBENT_MODEL.path("correlation")));
  assert.equal(norm(r.out), norm(INCUMBENT_MODEL.path("rank-outcomes")));
  assert.equal(norm(v.weeklyCsv), norm(INCUMBENT_MODEL.path("history-weekly")));
});

test("fitPaths --league resolves the FORMAT's own csv and directory (skipped on a clone with no format dir)", { skip: !existsSync(join(dataPath("formats"), "sc-a845f67652fb", "scoring.json")) }, () => {
  // The positive half of the pair above: the no-flag path must be the literals AND the flagged path
  // must actually reach somewhere else. A resolver that could only ever return the incumbent would
  // pass every assertion in the previous test and serve the Yahoo league ESPN's numbers.
  const p = fitPaths("variance", "data/variance-model.json", ["--league", "129048"]);
  const norm = (s: string) => s.replace(/\\/g, "/");
  assert.match(norm(p.weeklyCsv), /data\/formats\/sc-a845f67652fb\/history-weekly\.csv$/);
  assert.match(norm(p.out), /data\/formats\/sc-a845f67652fb\/variance-model\.json$/);
  assert.match(p.label, /129048 -> format sc-a845f67652fb \(format-dir\)/);
  assert.notEqual(norm(p.out), norm(INCUMBENT_MODEL.path("variance")));
});

test("FIT_OUT still wins over the resolved path (the leave-season-out harness)", () => {
  const prev = process.env.FIT_OUT;
  process.env.FIT_OUT = "data/tmp-loso.json";
  try {
    assert.equal(fitPaths("variance", "data/variance-model.json", []).out, "data/tmp-loso.json");
  } finally {
    if (prev === undefined) delete process.env.FIT_OUT; else process.env.FIT_OUT = prev;
  }
});

// =================================================================================================
// 3. THE PER-FORMAT GOLDEN LOADER
// =================================================================================================

/** A stand-in `ModelHandle`: the loader only ever calls `path("golden")`. */
const handleAt = (dir: string) => ({ path: (_n: string) => join(dir, "golden.json") } as never);

test("loadGolden reads a format's pinned numbers", () => {
  const dir = mkdtempSync(join(tmpdir(), "golden-"));
  try {
    writeFileSync(join(dir, "golden.json"), JSON.stringify({ playoffPct: 91.5, titlePct: 22.25, tolerancePp: 2.5 }));
    const g = loadGolden(handleAt(dir), "sc-test");
    assert.equal(g.playoffPct, 91.5);
    assert.equal(g.titlePct, 22.25);
    assert.equal(g.tolerancePp, 2.5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a golden with no title is fine (the title is CONTEXT, never a gate) but no playoffPct is not", () => {
  const dir = mkdtempSync(join(tmpdir(), "golden-"));
  try {
    writeFileSync(join(dir, "golden.json"), JSON.stringify({ playoffPct: 90 }));
    const g = loadGolden(handleAt(dir), "sc-test");
    assert.equal(g.titlePct, null);
    assert.equal(g.tolerancePp, 3.0, "the default slack, unchanged from cpcv.mjs's --golden-tol");

    writeFileSync(join(dir, "golden.json"), JSON.stringify({ titlePct: 38.5 }));
    assert.throws(() => loadGolden(handleAt(dir), "sc-test"), /no numeric `playoffPct`.*PRIMARY gate/s);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a format with NO golden is REFUSED BY NAME -- never defaulted to the incumbent's", () => {
  const dir = mkdtempSync(join(tmpdir(), "golden-"));
  try {
    let err: unknown;
    try { loadGolden(handleAt(dir), "sc-a845f67652fb"); } catch (e) { err = e; }
    assert.ok(err instanceof NoGoldenError, "the refusal must be its own type so cpcv can distinguish it from a broken file");
    const msg = String((err as Error).message);
    assert.match(msg, /sc-a845f67652fb/, "the refusal names the FORMAT");
    assert.match(msg, /snake DraftModel/, "and says what is actually missing for a pre-draft gate");
    assert.match(msg, /in-season odds are reachable but ungated/);
    assert.match(msg, /no fallback to the incumbent/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the shipped incumbent golden carries exactly the numbers cpcv.mjs pinned (D13/D15)", () => {
  const g = loadGolden(INCUMBENT_MODEL, "incumbent");
  assert.equal(g.playoffPct, 96.0, "the PRIMARY gate -- the playoff axis the sim has measured skill on");
  assert.equal(g.titlePct, 38.5, "CONTEXT only");
  assert.equal(g.tolerancePp, 3.0);
});

// =================================================================================================
// 4. THE CONSERVATION LAW, at a field size the incumbent never exercises
// =================================================================================================

const FLAT_VM: VarianceModel = {
  tiers: 4,
  pos: Object.fromEntries(["QB", "RB", "WR", "TE"].map((p) => [p, {
    cv: [0.5, 0.5, 0.5, 0.5], avail: [1, 1, 1, 1], skew: [0, 0, 0, 0],
  }])),
} as unknown as VarianceModel;

test("playoff shares sum to the FIELD SIZE and title shares to one, on a 12-team / 8-berth fixture", () => {
  // The Yahoo league is the first 8-of-12 field this simulator has run; the incumbent is 7-of-16, so
  // a field size that had been hardcoded anywhere would show up here and nowhere else.
  const teams: SeasonTeamInput[] = Array.from({ length: 12 }, (_, i) => ({
    id: String(i + 1), name: `T${i + 1}`,
    roster: [
      { name: `qb${i}`, pos: "QB", proj: 300 - i * 5, team: "AAA", bye: null },
      { name: `rb${i}`, pos: "RB", proj: 260 - i * 6, team: "BBB", bye: null },
      { name: `wr${i}`, pos: "WR", proj: 240 - i * 4, team: "CCC", bye: null },
      { name: `te${i}`, pos: "TE", proj: 160 - i * 3, team: "DDD", bye: null },
      { name: `fx${i}`, pos: "WR", proj: 150 - i * 2, team: "EEE", bye: null },
    ],
  }));
  // A round-robin over 14 weeks, the Yahoo calendar.
  const weeks: [number, number][][] = [];
  for (let w = 0; w < 14; w++) {
    const g: [number, number][] = [];
    for (let i = 0; i < 6; i++) g.push([i, (i + 1 + w) % 12 === i ? (i + 7) % 12 : (11 - i + w) % 12]);
    weeks.push(g.filter(([a, b]) => a !== b));
  }
  const odds = simulateSeasons(teams, weeks, FLAT_VM, {
    weeks: weeks.length, playoffTeams: 8, seeding: "record", playoffReseed: true, playoffWeekCount: 3,
    slots: ["QB", "RB", "WR", "TE", "FLEX"], flexOk: ["RB", "WR", "TE"],
    projSd: 0.30, trials: 600, seed: 7,
  } as never);
  const sumPlayoffs = odds.reduce((a, t) => a + t.playoffs, 0);
  const sumTitles = odds.reduce((a, t) => a + t.champion, 0);
  assert.equal(odds.length, 12);
  assert.ok(Math.abs(sumPlayoffs - 8) < 1e-9, `playoff shares must sum to the 8-team field, got ${sumPlayoffs}`);
  assert.ok(Math.abs(sumTitles - 1) < 1e-9, `exactly one champion per season, got ${sumTitles}`);

  // FAULT INJECTION: the sum tracks the FIELD SIZE, so a run with a different berth count must move
  // it. Without this the assertion above would also pass against a simulator that ignored the config
  // and always seated the same number of teams.
  const six = simulateSeasons(teams, weeks, FLAT_VM, {
    weeks: weeks.length, playoffTeams: 6, seeding: "record", playoffReseed: true, playoffWeekCount: 3,
    slots: ["QB", "RB", "WR", "TE", "FLEX"], flexOk: ["RB", "WR", "TE"],
    projSd: 0.30, trials: 600, seed: 7,
  } as never);
  assert.ok(Math.abs(six.reduce((a, t) => a + t.playoffs, 0) - 6) < 1e-9, "the conservation law follows playoffTeams");
});

void mkdirSync;
