/**
 * LINEUP WRITES (D54): the guard admits a ROSTER body only as LINEUP moves inside our team, the app's
 * copy agrees, the builder matches ESPN's recorded shape, the slot mapper uses the FEWEST moves, and
 * `setLineup` refuses a locked man and verifies every move on a re-read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertWritableUrl, ESPN_ROSTER_EXECUTION_TYPES, ESPN_ROSTER_ITEM_TYPES, recordingWriteIO } from "../src/league/writeIO.js";
import { assignSlots, diffMoves, matchStarter, setLineup, BENCH_SLOT, type LiveEntry } from "../src/inseason/lineupWrite.js";

const URL = "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/462233/transactions";
const mv = (o: Record<string, unknown> = {}) => ({ playerId: 1, type: "LINEUP", fromLineupSlotId: 20, toLineupSlotId: 23, ...o });

// --- the guard ---------------------------------------------------------------------------------

test("a ROSTER body may only EXECUTE LINEUP moves inside our team", () => {
  assertWritableUrl(URL, JSON.stringify({ type: "ROSTER", executionType: "EXECUTE", items: [mv()] }));
  assertWritableUrl(URL, JSON.stringify({ type: "ROSTER", executionType: "EXECUTE", items: [mv({ fromTeamId: 0, toTeamId: 0 })] }));
  for (const et of ["PROCESS", "CANCEL", "", undefined]) {
    assert.throws(() => assertWritableUrl(URL, JSON.stringify({ type: "ROSTER", executionType: et, items: [mv()] })), /REFUSED to write a ROSTER with executionType/);
  }
  for (const it of ["ADD", "DROP", "TRADE", undefined]) {
    assert.throws(() => assertWritableUrl(URL, JSON.stringify({ type: "ROSTER", executionType: "EXECUTE", items: [mv(), mv({ type: it })] })), /may only carry LINEUP/);
  }
  assert.throws(() => assertWritableUrl(URL, JSON.stringify({ type: "ROSTER", executionType: "EXECUTE", items: [mv({ toTeamId: 3 })] })), /stays inside our team/);
  assert.throws(() => assertWritableUrl(URL, JSON.stringify({ type: "ROSTER", executionType: "EXECUTE", items: [] })), /no items/);
  assert.throws(() => assertWritableUrl(URL, JSON.stringify({ type: "ROSTER", executionType: "EXECUTE" })), /no items/);
});

test("the app's ROSTER rules are identical to the shared lists", () => {
  const main = readFileSync("app/main.js", "utf8");
  const list = (name: string) => {
    const line = main.split("\n").find((l) => l.includes(`const ${name}`));
    assert.ok(line, `could not find ${name} in app/main.js`);
    const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(line!);
    return m![1].split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  };
  assert.deepEqual(list("ALLOWED_ROSTER_EXECUTION_TYPES"), [...ESPN_ROSTER_EXECUTION_TYPES]);
  assert.deepEqual(list("ALLOWED_ROSTER_ITEM_TYPES"), [...ESPN_ROSTER_ITEM_TYPES]);
});

test("the ESPN lineup body matches the shape this league records for a lineup move, and passes the guard", async () => {
  // Recorded (raw_league_transaction, 2026 wk6): ROSTER / EXECUTE, items LINEUP with from/to lineup slot.
  const { espnPlatform } = await import("../src/league/espnPlatform.js");
  const req = espnPlatform.writes!.setLineup!({ season: 2026, leagueId: "462233", myTeamId: "8", memberId: "{ABC}", scoringPeriodId: 6,
    moves: [{ playerId: "4599739", fromSlotId: 20, toSlotId: 23 }] });
  const b = JSON.parse(req.body);
  assert.equal(b.type, "ROSTER"); assert.equal(b.executionType, "EXECUTE"); assert.equal(b.teamId, 8); assert.equal(b.scoringPeriodId, 6);
  assert.deepEqual(b.items, [{ playerId: 4599739, type: "LINEUP", fromLineupSlotId: 20, toLineupSlotId: 23 }]);
  assert.equal(req.operation, "ROSTER");
  assertWritableUrl(req.url, req.body);
});

// --- the slot mapper ---------------------------------------------------------------------------

const COUNTS = { 0: 1, 2: 1, 4: 1, 6: 1, 16: 1, 17: 1, 20: 4, 21: 0, 23: 2 };
const RB = [2, 3, 23, 7, 20, 21], WR = [3, 4, 5, 23, 7, 20, 21], TE = [5, 6, 23, 7, 20, 21], QB = [0, 7, 20, 21];
// ESPN ids are numeric; the tests speak in labels. `pid(label)` is the id, `name` is the label.
const IDS = new Map<string, string>();
const pid = (label: string) => { if (!IDS.has(label)) IDS.set(label, String(1000 + IDS.size)); return IDS.get(label)!; };
const e = (label: string, slot: number, eligible: number[], extra: Partial<LiveEntry> = {}): LiveEntry =>
  ({ playerId: pid(label), name: label, slot, eligible, locked: false, defaultPositionId: null, ...extra });
const ids = (labels: string[]) => new Set(labels.map(pid));
// The live 2026 wk6 roster before the fix: one FLEX EMPTY, Miller on the bench.
const LIVE = [
  e("nix", 0, QB), e("allen", 2, RB), e("bernard", 4, WR), e("loveland", 6, TE), e("wilson", 23, WR),
  e("buf", 16, [16, 20, 21]), e("shrader", 17, [17, 20, 21]),
  e("miller", 20, RB), e("hall", 20, RB), e("asb", 20, WR), e("jwill", 20, WR), e("goff", 20, QB),
];
const STARTER_LABELS = ["nix", "allen", "bernard", "loveland", "wilson", "buf", "shrader", "miller"];
const STARTERS = ids(STARTER_LABELS);

test("one empty FLEX is filled with ONE move -- equivalent slots are never shuffled", () => {
  const moves = diffMoves(LIVE, assignSlots(LIVE, STARTERS, COUNTS));
  assert.deepEqual(moves, [{ playerId: pid("miller"), name: "miller", from: 20, to: 23 }]);
});

test("an already-optimal lineup needs no moves", () => {
  const set = LIVE.map((x) => (x.name === "miller" ? { ...x, slot: 23 } : x));
  assert.deepEqual(diffMoves(set, assignSlots(set, STARTERS, COUNTS)), []);
});

test("a benched starter swaps with the man he replaces; the replaced man goes to the bench", () => {
  const set = LIVE.map((x) => (x.name === "miller" ? { ...x, slot: 23 } : x));
  const want = ids(STARTER_LABELS.filter((s) => s !== "allen").concat("hall"));
  const moves = diffMoves(set, assignSlots(set, want, COUNTS));
  assert.deepEqual(moves.map((m) => [m.name, m.from, m.to]).sort(), [["allen", 2, BENCH_SLOT], ["hall", 20, 2]]);
});

test("a man can be shifted when that is the only way to seat everyone", () => {
  // The FLEX holds an RB, the RB slot is empty, and a second WR must start: the RB shifts to RB.
  const set = [e("a", 23, RB), e("w1", 4, WR), e("w2", 20, WR)];
  const counts = { 2: 1, 4: 1, 23: 1, 20: 1 };
  const t = assignSlots(set, ids(["a", "w1", "w2"]), counts);
  assert.equal(t.get(pid("w2")), 23);
  assert.equal(t.get(pid("w1")), 4);
  assert.equal(t.get(pid("a")), 2);
});

test("IR men are never touched, and an unseatable set throws", () => {
  const set = [...LIVE, e("ir", 21, RB)];
  assert.equal(assignSlots(set, STARTERS, COUNTS).get(pid("ir")), 21);
  assert.throws(() => assignSlots(LIVE, ids(STARTER_LABELS.filter((s) => s !== "nix").concat("goff", "hall")), COUNTS), /starters for 8|cannot seat/);
  assert.throws(() => assignSlots(LIVE, ids(["nix", "goff"]), COUNTS), /cannot seat/);
});

test("a recommended DST matches ESPN's nickname spelling", () => {
  const live = [e("-16002", 16, [16, 20], { name: "Bills D/ST", defaultPositionId: 16 }), e("x", 20, RB, { name: "Kendre Miller" })];
  assert.equal(matchStarter(live, { name: "BUF D/ST", pos: "DST" }).name, "Bills D/ST");
  assert.equal(matchStarter(live, { name: "Kendre Miller", pos: "RB" }).name, "Kendre Miller");
  assert.throws(() => matchStarter(live, { name: "MIN D/ST", pos: "DST" }), /not on our live ESPN roster/);
});

// --- setLineup end to end against a fake ESPN ---------------------------------------------------

function fakeEspn(entries: LiveEntry[]) {
  const state = entries.map((x) => ({ ...x }));
  const get = async () => ({
    scoringPeriodId: 6,
    settings: { rosterSettings: { lineupSlotCounts: Object.fromEntries(Object.entries(COUNTS).map(([k, v]) => [k, v])) } },
    teams: [{ id: 8, primaryOwner: "{ME}", roster: { entries: state.map((x) => ({ playerId: Number(x.playerId), lineupSlotId: x.slot,
      playerPoolEntry: { lineupLocked: x.locked, player: { fullName: x.name, eligibleSlots: x.eligible, defaultPositionId: x.defaultPositionId } } })) } }],
  });
  return { state, get };
}
const STARTER_ROWS = STARTER_LABELS.map((n) => ({ slot: "X", name: n, pos: n === "buf" ? "DST" : "RB", proj: 1 }));

test("setLineup: dry run builds the one move and sends nothing", async () => {
  const { get } = fakeEspn(LIVE);
  const w = recordingWriteIO();
  const run = await setLineup({ starters: STARTER_ROWS, get, writer: w, ...ctxOverride() });
  assert.deepEqual(run.moves.map((m) => [m.name, m.from, m.to]), [["miller", 20, 23]]);
  assert.equal(w.sent.length, 0); assert.equal(run.sent, false);
});

test("setLineup: an \"(empty)\" placeholder (only D/ST on bye) is skipped, not matched against the roster", async () => {
  const { get } = fakeEspn(LIVE);
  const rows = STARTER_ROWS.map((r) => (r.name === "buf" ? { ...r, name: "(empty)", proj: 0 } : r));
  const run = await setLineup({ starters: rows, get, writer: recordingWriteIO(), ...ctxOverride() });
  assert.deepEqual(run.problems.filter((p) => !p.startsWith("note:")), []);
  assert.ok(run.problems.some((p) => /slot\(s\) stay EMPTY/.test(p)));
  assert.ok(run.moves.some((m) => m.name === "miller" && m.to === 23));
});

test("setLineup: send posts once and VERIFIES on the re-read; a write ESPN ignored is reported", async () => {
  const fake = fakeEspn(LIVE);
  const applying = { via: "fake", async post(_u: string, body: string) {
    for (const it of JSON.parse(body).items) { const x = fake.state.find((s) => s.playerId === String(it.playerId)); if (x) x.slot = it.toLineupSlotId; }
    return { status: 200, body: "{}" };
  } };
  const ok = await setLineup({ starters: STARTER_ROWS, get: fake.get, writer: applying, send: true, ...ctxOverride() });
  assert.match(ok.verified ?? "", /roster confirmed/);
  // A 200 that changed nothing must NOT read as success (positive control on the verifier).
  const fake2 = fakeEspn(LIVE);
  const ignoring = { via: "fake", async post() { return { status: 200, body: "{}" }; } };
  const bad = await setLineup({ starters: STARTER_ROWS, get: fake2.get, writer: ignoring, send: true, verifyPolls: 1, ...ctxOverride() });
  assert.match(bad.verified ?? "", /CHECK ESPN/);
});

test("setLineup: a LOCKED man is never moved -- the run is not sendable", async () => {
  const live = LIVE.map((x) => (x.name === "miller" ? { ...x, locked: true } : x));
  const { get } = fakeEspn(live);
  const sent: string[] = [];
  const run = await setLineup({ starters: STARTER_ROWS, get, send: true, writer: { via: "x", async post(_u, b) { sent.push(b); return { status: 200, body: "" }; } }, ...ctxOverride() });
  assert.ok(run.problems.some((p) => /LOCKED/.test(p)));
  assert.equal(sent.length, 0);
});

/** Skip the store: league/team/season come straight in. */
function ctxOverride() {
  return { leagueCtx: { season: 2026, leagueId: "462233", myTeamId: "8" } };
}
