/**
 * THREE GAPS IN THE D42 EXPECTED-POINTS RANKING, found 2026-09-25 on a live question ("with Santos
 * questionable, would we stream a kicker?") that the tool could not answer:
 *
 *   1. The like-for-like swap was never priced. Drops came from our cheapest bodies only, so while our
 *      kicker out-projected the bench, "claim a kicker, drop ours" did not exist -- the only kicker
 *      move on offer was carrying two.
 *   2. A QUESTIONABLE man counted as certain to play. He plays 64.5% of the time (measured,
 *      `QUESTIONABLE_PLAY_RATE`).
 *   3. A free agent whose game had already KICKED OFF was credited with this week -- Thursday's
 *      kickers were scored as if they could still play for us.
 *
 * Each assertion was run against the code with its fix removed and FAILED there before this file
 * was kept (fault injection noted per test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { QUESTIONABLE_PLAY_RATE, waiverTargets } from "../src/inseason/copilot.js";
import { withStatusOverrides } from "../src/inseason/copilotActions.js";
import { fixtureCtx, key } from "./fixtures/copilot-league.js";
import type { SimContext } from "../src/draft/simContext.js";

const OPTS = { trials: 60, seeds: [3], adds: 3, dropsPerAdd: 2, positions: ["K"], handcuffAdds: 0, needAdds: 0 };

function ctxWithKicker(): { ctx: SimContext; ourK: string; ourKProj: number } {
  const ctx = fixtureCtx({ strong: 0, mult: 1 }); // league-average: the INSECURE regime, whose window includes this week
  const k = ctx.teams[ctx.meIdx].roster.find((p) => p.pos === "K")!;
  ctx.board.set(key("Better Kicker"), { name: "Better Kicker", pos: "K", proj: k.proj + 5, team: "FA" });
  return { ctx, ourK: k.name, ourKProj: k.proj };
}
const swapGain = (r: ReturnType<typeof waiverTargets>, ourK: string): number => {
  const row = r.targets.find((t) => t.add === "Better Kicker");
  assert.ok(row, "Better Kicker was not scored");
  const d = row!.drops.find((x) => x.name === ourK);
  assert.ok(d, `the like-for-like swap (drop ${ourK}) was not priced; drops: ${row!.drops.map((x) => x.name).join(", ")}`);
  return d!.expGainPts;
};

test("gap 1: a kicker claim is priced against dropping OUR kicker, not only against carrying two", () => {
  // Fault-injected: with `samePosDrop` returning undefined the swap is absent and this fails.
  const { ctx, ourK } = ctxWithKicker();
  const g = swapGain(waiverTargets(ctx, OPTS), ourK);
  // Our kicker for one projected 5 points better over a full season: a small POSITIVE gain.
  assert.ok(g > 0 && g < 10, `swap gain ${g}`);
});

test("gap 2: our kicker QUESTIONABLE raises the swap's gain by his missing 35.5% of one week", () => {
  // Fault-injected: with playRate returning 1 for QUESTIONABLE the two gains are equal.
  const a = ctxWithKicker();
  const healthy = swapGain(waiverTargets(a.ctx, OPTS), a.ourK);
  const b = ctxWithKicker();
  const q = withStatusOverrides(b.ctx, { [b.ourK]: "Q" });
  const hurt = swapGain(waiverTargets(q, OPTS), b.ourK);
  const ourRate = a.ourKProj / 17;
  const want = ourRate * (1 - QUESTIONABLE_PLAY_RATE);
  assert.ok(Math.abs(hurt - healthy - want) < 0.1, `Q moved the swap by ${(hurt - healthy).toFixed(2)}, expected ${want.toFixed(2)}`);
});

test("gap 3: a free agent whose game has kicked off adds nothing THIS week", () => {
  // Fault-injected: without `lockedNow` on the add the two gains are equal.
  const a = ctxWithKicker();
  const open = swapGain(waiverTargets(a.ctx, OPTS), a.ourK);
  const b = ctxWithKicker();
  b.ctx.week = { ...b.ctx.week, locked: new Set(["FA"]) };
  const locked = swapGain(waiverTargets(b.ctx, OPTS), b.ourK);
  // Locking the free agent removes exactly HIS week: the swap no longer gets his points this week
  // (and, having dropped ours, leaves the K slot empty -- which is why this row now ranks last).
  const want = (a.ourKProj + 5) / 17;
  assert.ok(Math.abs(open - locked - want) < 0.1, `kickoff lock moved the swap by ${(open - locked).toFixed(2)}, expected ${want.toFixed(2)}`);
});

test("status override: unknown names and statuses are REFUSED by name; ACTIVE clears a feed status", () => {
  const { ctx, ourK } = ctxWithKicker();
  assert.throws(() => withStatusOverrides(ctx, { "Nobody Atall": "OUT" }), /Nobody Atall/);
  assert.throws(() => withStatusOverrides(ctx, { [ourK]: "maybe" }), /maybe/);
  const out = withStatusOverrides(ctx, { [ourK]: "doubtful" });
  assert.equal(out.week.availability.get(key(ourK))?.status, "OUT");
  assert.equal(ctx.week.availability.has(key(ourK)), false, "the override mutated the caller's context");
  assert.equal(withStatusOverrides(out, { [ourK]: "active" }).week.availability.has(key(ourK)), false);
});
