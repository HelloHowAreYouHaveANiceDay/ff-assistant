/**
 * `streamRecommend` -- the tenth copilot verb, on the fixture league.
 *
 * The function is pure: it takes a SimContext, a week, a position and a pool, and returns a decision.
 * So the whole verb runs here with no store, no artifact and no live league, and every assertion is
 * about the DECISION rather than about the projection that fed it.
 *
 * EVERY GUARD IS FAULT-INJECTED, and for the predicates the injection is in BOTH directions. A guard
 * that has only ever been seen to refuse is indistinguishable from a guard that cannot accept -- the
 * failure CLAUDE.md records as three defects in one 40-line function -- so for the legality refusal
 * there is a case that must be refused AND a case that must be allowed, and for the "add is worth
 * it" predicate there is a pool that must trigger it and one that must not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { streamRecommend, type AvailabilityMap, type StreamPlayer } from "../src/inseason/copilot.js";
import { fixtureCtx, key } from "./fixtures/copilot-league.js";
import { artifactForPos, SHIPPED_STREAMING_POSITIONS, topStreamPick, type StreamProj } from "../src/weekly/streamingServe.js";

/** Build a pool row. `ours`/`rostered` are what the caller resolves from the league. */
const P = (o: Partial<StreamPlayer> & { name: string; pos: string; proj: number }): StreamPlayer => ({
  team: "FA", p10: o.proj * 0.3, p90: o.proj * 1.8, pZero: 0.1, ours: false, rostered: false,
  unavailable: null, artifact: "weekly-artifact-lineonly.json", ...o,
});

/** Our own DST and a set of free ones, in the shape the dispatcher hands in. */
function dstPool(ctx = fixtureCtx(), freeBest = 12): StreamPlayer[] {
  const mine = ctx.teams[ctx.meIdx].roster.find((p) => p.pos === "DST")!;
  return [
    P({ name: mine.name, pos: "DST", proj: 6.5, ours: true, rostered: true }),
    P({ name: "Free Defense", pos: "DST", proj: freeBest }),
    P({ name: "Other Defense", pos: "DST", proj: 4.0 }),
    // A defence on ANOTHER roster. He must never be recommended as an add: he is not claimable, and
    // listing him is how a "recommendation" becomes something the user cannot act on.
    P({ name: ctx.teams[1].roster.find((p) => p.pos === "DST")!.name, pos: "DST", proj: 99, rostered: true }),
  ];
}

test("stream: ranks ours and the pool, names the start, and recommends the add when it is better", () => {
  const ctx = fixtureCtx();
  const r = streamRecommend(ctx, 5, "DST", { pool: dstPool(ctx) });
  assert.equal(r.pos, "DST");
  assert.equal(r.week, 5);
  assert.equal(r.ours.length, 1, "our own defence should be in `ours`");
  assert.ok(r.start, "we own a startable defence, so there is a start");
  assert.equal(r.start!.name, ctx.teams[ctx.meIdx].roster.find((p) => p.pos === "DST")!.name);
  assert.equal(r.pool[0].name, "Free Defense", "the pool is ranked by projection");
  assert.ok(!r.pool.some((p) => p.rostered),
    "a defence on another roster appeared in the streamable pool -- he cannot be claimed, and " +
    "recommending him is advice the user cannot act on");
  assert.ok(r.add, "a free defence projecting 12.0 against our 6.5 should be an add");
  assert.equal(r.add!.add, "Free Defense");
  assert.ok(Math.abs(r.add!.gainPts - 5.5) < 1e-6, `gain was ${r.add!.gainPts}, want 5.5`);
  assert.equal(r.add!.legal, true);
});

test("FAULT (the other direction): a pool that is WORSE than ours produces NO add", () => {
  // The predicate's positive value is exercised above; this is the negative one. A verb that
  // recommends an add whatever the pool looks like is not reading the projection at all, and the
  // test above cannot tell that apart from a correct one.
  const ctx = fixtureCtx();
  const r = streamRecommend(ctx, 5, "DST", { pool: dstPool(ctx, 2.0) });
  assert.equal(r.add, null, "a free defence projecting 2.0 against our 6.5 was recommended as an add");
  assert.ok(r.start, "we should still be told whom to start");
});

test("stream: an OUT starter is not the start, and the free man becomes the comparison", () => {
  const ctx = fixtureCtx();
  const mine = ctx.teams[ctx.meIdx].roster.find((p) => p.pos === "DST")!;
  const availability: AvailabilityMap = new Map([[key(mine.name), { status: "OUT", source: "test", detail: "ruled out" }]]);
  const r = streamRecommend(ctx, 5, "DST", { pool: dstPool(ctx, 5.0), availability });
  assert.equal(r.start, null, "an OUT defence must not be the start");
  assert.equal(r.sit.length, 1);
  assert.match(r.sit[0].reason, /OUT/);
  // And the add is now worth making even though the free man projects LESS than our own: he can
  // actually play, and 5.0 from somebody beats 6.5 from nobody. A verb that compared against our
  // best MAN rather than our best LEGAL starter would return null here.
  assert.ok(r.add, "with our defence ruled out, a free 5.0 should be an add");
  assert.equal(r.add!.add, "Free Defense");
  assert.ok(Math.abs(r.add!.gainPts - 5.0) < 1e-6, `gain was ${r.add!.gainPts}, want 5.0`);
});

test("stream: a bye is read from the ROSTER, not from the availability map", () => {
  // The fixture's QB carries bye week 6. `unavailableReason` reads it off the roster entry, so a
  // caller that supplies no availability map at all still gets the bye right -- which is the case
  // that matters, because the bye is the single most common reason to stream.
  const ctx = fixtureCtx();
  const mine = ctx.teams[ctx.meIdx].roster.find((p) => p.pos === "QB")!;
  const pool = [
    P({ name: mine.name, pos: "QB", proj: 18, ours: true, rostered: true }),
    P({ name: "Free Passer", pos: "QB", proj: 9 }),
  ];
  const onBye = streamRecommend(ctx, 6, "QB", { pool });
  assert.equal(onBye.start, null, "our quarterback is on bye in week 6 and must not be the start");
  assert.ok(onBye.add, "with our quarterback on bye, a free 9.0 is worth claiming");
  // POSITIVE CONTROL ON THE SAME PREDICATE: in any other week he starts and there is no add.
  const notBye = streamRecommend(ctx, 7, "QB", { pool });
  assert.equal(notBye.start?.name, mine.name);
  assert.equal(notBye.add, null, "off his bye our 18.0 quarterback beats a free 9.0");
});

/** A minimal roster whose CHEAPEST body is the only kicker, so the legality refusal is forced to
 *  fire rather than being hoped for. On the standard fixture roster the cheapest man is a third
 *  tight end and no refusal ever happens -- which is what the first draft of this test asserted, and
 *  it would have passed against a `rosterGaps` call that had been deleted. */
function thinCtx(extra: { name: string; pos: string; proj: number }[] = []) {
  const ctx = fixtureCtx();
  const teams = ctx.clone();
  teams[ctx.meIdx].roster = ([
    ["QB", "Solo Passer", 20], ["RB", "Solo Runner", 15], ["RB", "Second Runner", 12],
    ["WR", "Solo Receiver", 14], ["WR", "Second Receiver", 11], ["TE", "Solo Tight", 8],
    ["K", "Solo Kicker", 1], ["DST", "Solo Defense", 5],
  ] as [string, string, number][]).map(([pos, name, proj]) => ({ name, pos, proj, team: "MY", bye: null }))
    .concat(extra.map((e) => ({ name: e.name, pos: e.pos, proj: e.proj, team: "SP", bye: null })));
  return { ...ctx, teams };
}

test("stream: a drop that leaves a mandatory slot unfillable is REFUSED and NAMED", () => {
  // The cheapest body on this roster IS the only kicker. Dropping him to stream a defence leaves the
  // K slot empty, `rosterGaps` refuses it, the refusal is named, and the verb goes on to find a
  // legal drop instead of giving up.
  const ctx = thinCtx([{ name: "Spare Receiver", pos: "WR", proj: 2 }]);
  const r = streamRecommend(ctx, 5, "DST", { pool: dstPool(ctx, 20) });
  assert.ok(r.add, "a 20-point free defence should be an add");
  assert.ok(r.refused.length > 0,
    "no drop was refused. The cheapest man on this roster is the ONLY kicker, so a refusal must " +
    "have happened -- if none did, the legality check is not running at all");
  assert.equal(r.refused[0].drop, "Solo Kicker");
  assert.ok(r.refused.every((x) => x.why && x.why.length > 5), "a refusal with no reason is a silent skip");
  assert.equal(r.add!.legal, true, "there IS a legal drop -- the spare receiver");
  assert.equal(r.add!.drop, "Spare Receiver");
});

test("FAULT (the other direction): the legality check ACCEPTS every drop on a deep roster", () => {
  // The refusal above proves the guard can say no. This proves it can say yes -- and it is the half
  // that catches a `rosterGaps` call that refuses unconditionally, which reads exactly like a
  // working check from the outside. Four spare receivers: no drop breaks a mandatory slot.
  // proj 0.5 so a spare receiver is the CHEAPEST body and is therefore the first candidate tried --
  // otherwise the only kicker (proj 1) is tried first and is correctly refused, and this test would
  // be asserting the absence of a refusal that should happen.
  const ctx = thinCtx(["A", "B", "C", "D"].map((c) => ({ name: `Spare Receiver ${c}`, pos: "WR", proj: 0.5 })));
  const r = streamRecommend(ctx, 5, "DST", { pool: dstPool(ctx, 20) });
  assert.equal(r.refused.length, 0,
    "a drop was refused on a roster where the cheapest man is a fourth spare receiver -- the guard " +
    `is refusing unconditionally: ${JSON.stringify(r.refused)}`);
  assert.equal(r.add!.legal, true);
  assert.match(r.add!.drop, /Spare Receiver/, "the cheapest legal body should be the drop");
});

test("stream: assumptions carry the basis, the artifact and the objective -- never a bare number", () => {
  const ctx = fixtureCtx();
  const r = streamRecommend(ctx, 5, "DST", {
    pool: dstPool(ctx), artifactByPos: { DST: "streaming-artifact.json" },
  });
  assert.equal(r.assumptions.basis, "weekly-model");
  assert.equal(r.assumptions.trials, null, "a one-week points quantity has no simulation behind it");
  assert.match(r.assumptions.basisNote!, /streaming-artifact\.json/,
    "the assumptions must name WHICH artifact served this position -- the gate is per position, so a " +
    "reader cannot infer it");
  assert.ok(r.assumptions.objective, "the objective block travels even where the regime is unknown");
});

test("stream: a position with NO projections says so rather than recommending nothing", () => {
  const ctx = fixtureCtx();
  const r = streamRecommend(ctx, 5, "TE", { pool: [] });
  assert.equal(r.start, null);
  assert.equal(r.add, null);
  assert.match(r.assumptions.basisNote!, /NO row/,
    "'we cannot answer' and 'do nothing' must not be the same output");
});

// =============================================================================================
// THE PER-POSITION SHIP MAPPING
// =============================================================================================

test("artifactForPos: a position outside the shipped list serves the FLOOR, not the streaming model", () => {
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    const want = SHIPPED_STREAMING_POSITIONS.includes(pos) ? "streaming-artifact.json" : "weekly-artifact-lineonly.json";
    assert.equal(artifactForPos(pos), want, `${pos} is served by the wrong artifact`);
  }
  // FAULT INJECTION on the mapping itself: a position that is NOT on the list must not resolve to
  // the streaming artifact, or the mapping is returning one answer for everything.
  const off = ["QB", "RB", "WR", "TE", "K", "DST"].find((p) => !SHIPPED_STREAMING_POSITIONS.includes(p));
  if (off) assert.notEqual(artifactForPos(off), "streaming-artifact.json");
});

test("topStreamPick: picks out of the POOL only, and freezes the board's pick beside ours", () => {
  const mk = (name: string, mean: number, rank: number): StreamProj => ({
    feat_key: name, name, pos: "DST", team: "X", mean, p10: 0, p90: mean * 2, pZero: null, rank,
    artifact: "a.json",
  });
  // Ranks 1-16 are rostered in a 16-team league; 17+ are the pool. The best mean overall belongs to
  // a rostered man, so a picker that ignored the pool boundary would return HIM.
  const rows = [mk("Rostered Ace", 20, 3), mk("Free Best", 9, 20), mk("Free Meh", 4, 18)];
  const picks = topStreamPick(rows, { DST: 16 });
  assert.equal(picks.DST.model!.name, "Free Best", "the pick came from outside the pool");
  // The board's pick is the BEST-RANKED man in the pool -- rank 18, not rank 20 -- which is a
  // different man from the model's pick, which is the only thing that makes the pair informative.
  assert.equal(picks.DST.line!.name, "Free Meh");
  // FAULT: widen the pool to include everybody and the model's pick MUST change, or the boundary is
  // not being read at all.
  assert.equal(topStreamPick(rows, { DST: 0 }).DST.model!.name, "Rostered Ace",
    "moving the pool boundary changed nothing -- topStreamPick is not reading it");
});
