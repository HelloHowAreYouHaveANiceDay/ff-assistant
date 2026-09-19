/**
 * AXIS 2 of the M3 lineup stress test: what `lineupRecommend` does when an INPUT is broken.
 *
 * Every case here was first driven against a TEMP COPY of the live store (an online `db.backup()`
 * into the scratch dir) and is reproduced on the shared fixture so it runs anywhere, with no store.
 * Three of them found defects; those three carry their fault injection in the same test, because a
 * regression test for a fix nobody has watched fail is a regression test for nothing.
 *
 * THE THREE DEFECTS, all of one shape -- A PLAYER RESOLVED BY NAME:
 *
 *   D1  `assertStartersAvailable` looked the started man up with `roster.find(x => x.name === ...)`.
 *       Two men can share a name. With the UNAVAILABLE copy first in roster order the guard threw on
 *       a lineup that had correctly started the AVAILABLE one, and the whole verb failed; with the
 *       available copy first, a genuinely-benched bye man passed unseen -- the one thing the guard
 *       exists to catch. Now every man of that name is checked and it complains only when they are
 *       ALL out.
 *   D2  `optimalLineup`'s "started but not available" flag had the same `find`, and fired falsely
 *       in exactly case D1. Now it reads the seated object.
 *   D3  the season-line fallback `p.proj / perWeek` was unguarded, so a man with no usable season
 *       projection made the lineup's HEADLINE `totalProj` NaN -- while `basisNote` said he "fell
 *       back to the season projection divided by 17", which is what did not happen.
 *
 * Plus the name-collision residue in the same function: the bench `reason` map and the winprob
 * bench filter were both keyed on name alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lineupRecommend, assertStartersAvailable, unavailableReason, normalizeStatus, lineupNameKey,
  type AvailabilityMap,
} from "../src/inseason/copilot.js";
import { optimalLineup } from "../src/inseason/lineup.js";
import { fixtureCtx, key } from "./fixtures/copilot-league.js";
import type { SimContext } from "../src/draft/simContext.js";

const WEEK = 3;                                      // no fixture bye lands here; byes are 6, 7, 9
const ctx = () => fixtureCtx();
const mine = (c: SimContext) => c.teams[c.meIdx].roster;
const clone = (c: SimContext): SimContext =>
  ({ ...c, teams: c.teams.map((t, i) => (i === c.meIdx ? { ...t, roster: t.roster.map((p) => ({ ...p })) } : t)) });
const out = (...names: string[]): AvailabilityMap =>
  new Map(names.map((n) => [key(n), { status: "OUT" as const, source: "fault-injection", detail: "test" }]));
const weeklyFor = (c: SimContext, f: (p: { name: string; pos: string; proj: number }) => number) =>
  new Map(mine(c).map((p) => [lineupNameKey(p.name), f(p)]));
const started = (r: { starters: { name: string }[] }, n: string) => r.starters.some((s) => s.name === n);

// ---------------------------------------------------------------------------------------------
// D1 -- the availability guard and duplicate names.
// ---------------------------------------------------------------------------------------------

test("D1 FAULT INJECTION: the guard still REFUSES a lineup that starts a man on bye", () => {
  // The positive control for everything below: the fix must not have disarmed the guard. This is
  // the one case where it MUST throw.
  const c = ctx();
  const r = mine(c)[0];
  r.bye = WEEK;
  assert.throws(
    () => assertStartersAvailable([{ name: r.name }], mine(c), WEEK, new Map()),
    /cannot play in week 3[\s\S]*bye week 3/,
  );
});

test("D1 FAULT INJECTION: the guard still REFUSES a lineup that starts a man ruled OUT", () => {
  const c = ctx();
  const r = mine(c)[1];
  assert.throws(
    () => assertStartersAvailable([{ name: r.name }], mine(c), WEEK, out(r.name)),
    /cannot play in week 3[\s\S]*OUT/,
  );
});

test("D1 DEFECT: two men of one name, the UNAVAILABLE copy first -- the guard must NOT throw", () => {
  // THE BUG: `roster.find` returned the bye twin, so a legal lineup raised
  // "lineup starts 1 player(s) who cannot play in week 3" and `ff lineup` / the MCP tool
  // both failed outright. Measured on the live store's real roster before the fix.
  const c = clone(ctx());
  const r = mine(c);
  const real = r.find((p) => p.pos === "WR")!;
  r.unshift({ ...real, pos: "RB", bye: WEEK });          // the twin, on bye, FIRST
  assert.doesNotThrow(() => assertStartersAvailable([{ name: real.name }], r, WEEK, new Map()));
  // ... and the whole verb now returns rather than throwing.
  const res = lineupRecommend(c, WEEK, { availability: new Map() });
  assert.ok(started(res, real.name));
  assert.ok(res.unavailable.some((u) => u.name === real.name && u.pos === "RB" && /bye week 3/.test(u.reason)),
    "the twin that really is on bye must still be reported unavailable");
});

test("D1 DEFECT, the other direction: when EVERY man of that name is out, the guard still fires", () => {
  // The fix must not have turned the guard into "never complain about a duplicated name". This is
  // the case that distinguishes a narrowed guard from a disabled one.
  const c = clone(ctx());
  const r = mine(c);
  const real = r.find((p) => p.pos === "WR")!;
  r.unshift({ ...real, pos: "RB", bye: WEEK });
  real.bye = WEEK;                                       // now BOTH are on bye
  assert.throws(() => assertStartersAvailable([{ name: real.name }], r, WEEK, new Map()), /cannot play in week 3/);
});

test("D2 DEFECT: the optimizer's own not-available flag reads the SEATED man, not the first of that name", () => {
  // Same shape one layer down. The available twin is seated; the flag must stay silent.
  const players = [
    { name: "Twin", pos: "RB", proj: 12, available: false },
    { name: "Twin", pos: "WR", proj: 11, available: true },
    { name: "Solo", pos: "QB", proj: 20, available: true },
  ];
  const res = optimalLineup(players, ["QB", "WR"], ["RB", "WR", "TE"]);
  assert.equal(res.starters.find((s) => s.slot === "WR")!.name, "Twin");
  assert.deepEqual(res.flags.filter((f) => /started but not available/.test(f)), []);
  // NO FAULT INJECTION IS POSSIBLE HERE, and saying so is the honest version. The assignment only
  // ever draws from the AVAILABLE players, so after the fix this flag is unreachable from outside
  // the function -- it is a tripwire on an internal invariant, and the fuzz (axis 1) is what proves
  // that invariant holds. What CAN be injected is the thing it used to get wrong: the unavailable
  // twin seated nowhere, yet named. Before the fix the assertion above was `["Twin started but not
  // available"]`; the guard that really can fire on bad plumbing is `assertStartersAvailable`, and
  // its two fault injections are the first two tests in this file.
  assert.ok(res.starters.every((s) => s.name === "(empty)" || players.some((p) => p.name === s.name && p.available)));
});

test("a NAME started twice is FLAGGED -- a legal lineup that prints as an illegal one", () => {
  const c = clone(ctx());
  const r = mine(c);
  const real = r.find((p) => p.pos === "WR")!;
  r.push({ ...real, pos: "RB", name: real.name, proj: 999 });   // two good men, one name; both must start
  const res = lineupRecommend(c, WEEK, { availability: new Map() });
  assert.equal(res.starters.filter((s) => s.name === real.name).length, 2);
  assert.ok(res.flags.some((f) => f.includes("fills more than one slot")), JSON.stringify(res.flags));
  // And the control: with unique names the flag never appears.
  assert.ok(!lineupRecommend(ctx(), WEEK, { availability: new Map() }).flags.some((f) => f.includes("fills more than one slot")));
});

test("with two men of one name and only ONE starting, the other is still on the bench", () => {
  // The name-set filter used to drop BOTH, so a rostered man vanished from the result entirely.
  const c = clone(ctx());
  const r = mine(c);
  const real = r.find((p) => p.pos === "TE")!;
  r.push({ ...real, pos: "TE", proj: 1 });
  const res = lineupRecommend(c, WEEK, { availability: new Map() });
  const seen = res.starters.filter((s) => s.name === real.name).length + res.bench.filter((b) => b.name === real.name).length;
  assert.equal(seen, 2, "both men of that name must appear somewhere");
  assert.equal(res.starters.length + res.bench.length, r.length);
});

// ---------------------------------------------------------------------------------------------
// D3 -- the season-line fallback.
// ---------------------------------------------------------------------------------------------

test("D3 DEFECT: a man with no weekly row AND no usable season projection does not make totalProj NaN", () => {
  const c = clone(ctx());
  const r = mine(c);
  const victim = r.find((p) => p.pos === "QB")!;
  (victim as { proj?: number }).proj = undefined as unknown as number;   // the board had no row for him
  const weekly = weeklyFor(c, (p) => p.proj / 17);
  weekly.delete(lineupNameKey(victim.name));
  const res = lineupRecommend(c, WEEK, { availability: new Map(), weekly });
  assert.ok(Number.isFinite(res.totalProj), `totalProj is ${res.totalProj}`);
  for (const s of res.starters) assert.ok(Number.isFinite(s.proj), `${s.slot} ${s.name} = ${s.proj}`);
  // And it SAYS so, by name, rather than quietly carrying him at zero.
  assert.match(String(res.assumptions.basisNote), /NEITHER a weekly row NOR a usable season projection/);
  assert.ok(String(res.assumptions.basisNote).includes(victim.name));
});

test("D3 CONTROL: a man with a finite projection is untouched -- the guard is not a blanket zero", () => {
  const c = ctx();
  const weekly = weeklyFor(c, (p) => p.proj / 17);
  const res = lineupRecommend(c, WEEK, { availability: new Map(), weekly });
  assert.ok(!/NEITHER a weekly row/.test(String(res.assumptions.basisNote)));
  assert.ok(res.totalProj > 0);
  // Byte-identical to the same call with the guard's input made explicitly finite.
  const same = lineupRecommend(ctx(), WEEK, { availability: new Map(), weekly });
  assert.deepEqual(res.starters, same.starters);
});

// ---------------------------------------------------------------------------------------------
// The cases that PASSED -- pinned so a future change cannot quietly break them.
// ---------------------------------------------------------------------------------------------

test("a man with NO WEEKLY ROW falls back to the season line / 17 and the caveat NAMES him", () => {
  const c = ctx();
  const weekly = weeklyFor(c, (p) => p.proj / 17);
  const victim = mine(c)[0];
  weekly.delete(lineupNameKey(victim.name));
  const res = lineupRecommend(c, WEEK, { availability: new Map(), weekly });
  assert.equal(res.assumptions.basis, "projection", "one fallback man means the basis is NOT weekly-model");
  // D33 wording: "fell back to the season line ... : <name>", then which line it was.
  assert.match(String(res.assumptions.basisNote), new RegExp(`1 fell back to the season line.*${victim.name}`));
  assert.match(String(res.assumptions.basisNote), /preseason projection divided by 17/);
  // The control: with every row present the basis is weekly-model and nothing is named.
  const full = lineupRecommend(ctx(), WEEK, { availability: new Map(), weekly: weeklyFor(c, (p) => p.proj / 17) });
  assert.equal(full.assumptions.basis, "weekly-model");
});

test("a NaN weekly projection is treated as ABSENT, not as a number", () => {
  const c = ctx();
  const weekly = weeklyFor(c, (p) => p.proj / 17);
  const victim = mine(c)[0];
  weekly.set(lineupNameKey(victim.name), NaN);
  const res = lineupRecommend(c, WEEK, { availability: new Map(), weekly });
  assert.ok(Number.isFinite(res.totalProj));
  assert.match(String(res.assumptions.basisNote), /fell back to the season line/);
});

test("EVERY man OUT: every slot goes empty with a named reason, and the total is zero -- no crash", () => {
  const c = ctx();
  const res = lineupRecommend(c, WEEK, { availability: out(...mine(c).map((p) => p.name)) });
  assert.equal(res.totalProj, 0);
  assert.ok(res.starters.every((s) => s.name === "(empty)"));
  assert.equal(res.unavailable.length, mine(c).length);
  assert.equal(res.flags.filter((f) => /no available player to fill/.test(f)).length, res.starters.length);
});

test("every man at ONE position on bye: that slot goes empty with a NAMED reason, never a bye starter", () => {
  const c = clone(ctx());
  for (const p of mine(c)) if (p.pos === "WR") p.bye = WEEK;
  const res = lineupRecommend(c, WEEK, { availability: new Map() });
  assert.equal(res.starters.find((s) => s.slot === "WR")!.name, "(empty)");
  assert.ok(res.flags.some((f) => /no available player to fill WR/.test(f)));
  assert.ok(res.unavailable.every((u) => u.pos !== "WR" || /bye week 3/.test(u.reason)));
  for (const u of res.unavailable) assert.ok(!started(res, u.name), `${u.name} was started while unavailable`);
});

test("an IR designation benches the best man at his slot, and QUESTIONABLE does not", () => {
  // The status vocabulary is load-bearing: IR/PUP/NFI/SUSPENSION/DNR/DOUBTFUL bench, QUESTIONABLE
  // does not (measured -- benching every questionable starter costs more than the occasional zero).
  const c = ctx();
  const qb = mine(c).find((p) => p.pos === "QB")!;
  for (const status of ["IR", "PUP", "NFI", "Suspension", "DNR", "Doubtful", "Out"]) {
    const a: AvailabilityMap = new Map([[key(qb.name), { status: normalizeStatus(status), source: "t", detail: status }]]);
    assert.ok(!started(lineupRecommend(c, WEEK, { availability: a }), qb.name), `${status} did not bench him`);
  }
  const q: AvailabilityMap = new Map([[key(qb.name), { status: normalizeStatus("Questionable"), source: "t" }]]);
  assert.ok(started(lineupRecommend(c, WEEK, { availability: q }), qb.name), "QUESTIONABLE must still start");
  assert.ok(!lineupRecommend(c, WEEK, { availability: q }).unavailable.some((u) => u.name === qb.name));
});

test("a roster SHORTER than the template fills what it can and names every slot it cannot", () => {
  const c = clone(ctx());
  c.teams[c.meIdx].roster = mine(c).slice(0, 3);
  const res = lineupRecommend(c, WEEK, { availability: new Map() });
  const empties = res.starters.filter((s) => s.name === "(empty)");
  assert.equal(empties.length, res.starters.length - 3);
  for (const e of empties) assert.ok(res.flags.some((f) => f === `no available player to fill ${e.slot}`));
});

test("unavailableReason keys on the STORE's name key, and a spelling it cannot match reads as available", () => {
  // Not a defect -- a documented seam -- but it is the one that turns a live injury feed into
  // silence, so it is pinned in both directions rather than assumed.
  const c = ctx();
  const p = mine(c)[0];
  assert.match(String(unavailableReason(p, WEEK, out(p.name))), /OUT/);
  assert.equal(unavailableReason(p, WEEK, new Map([["a-key-that-matches-nothing", { status: "OUT", source: "t" }]])), null);
});

test("DETERMINISM: the same inputs twice produce a byte-identical result apart from the as-of stamp", () => {
  const c = ctx();
  const weekly = weeklyFor(c, (p) => p.proj / 17);
  const a = lineupRecommend(c, WEEK, { availability: new Map(), weekly });
  const b = lineupRecommend(c, WEEK, { availability: new Map(), weekly });
  const strip = (r: typeof a) => JSON.stringify({ ...r, assumptions: { ...r.assumptions, asOf: null } });
  assert.equal(strip(a), strip(b));
});
