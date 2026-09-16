// FACE VALIDITY FOR THE SNAKE MODEL (charter rule 4: a plausible-looking output is the default
// failure mode). Three of the four checks live here because they are cheap and deterministic; the
// fourth -- the draft-slot sweep -- is a measurement, and its numbers are in docs/validation.md.
//
//   POSITIVE CONTROL   with no per-bot noise and OUR book equal to the room's, we must finish with a
//                      roster indistinguishable from the field average. A non-zero answer here would
//                      be an edge manufactured by the HARNESS (seat order, tie-breaks, the bench
//                      rule applied asymmetrically), and every later number would inherit it.
//   FAULT INJECTION    a strategy that drafts the WORST available must collapse to a near-zero
//                      playoff rate THROUGH THE REAL BACKTEST. A guard that can only ever say "no"
//                      is dead code; a harness that can only ever say "you won" is worse.
//   SUPERFLEX SHAPE    quarterbacks must go early, and they must do so BECAUSE OF THE SLOT.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSnakeDraft, vorBook, SnakeModel, type DraftModel } from "../src/draft/draftModel.ts";
import { resolveValueLeague, type PointsRow } from "../src/draft/values.ts";
import { runBacktest, type Weekly } from "../src/draft/backtest.ts";
import { mulberry32 } from "../src/draft/sim.ts";

const YAHOO = ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "FLEX", "FLEX", "SUPERFLEX",
  "BE", "BE", "BE", "BE", "BE", "BE", "BE", "IR", "IR"];
const LG = { teams: 12, budget: 200, slots: YAHOO };
const VL = resolveValueLeague(LG);

function pool(): PointsRow[] {
  const rows: PointsRow[] = [];
  // QBs top the board under 6-pt/PPR superflex scoring, exactly as the Yahoo target does.
  const shape: [string, number, number, number][] = [["QB", 40, 420, 6], ["RB", 90, 300, 2.5], ["WR", 110, 295, 2], ["TE", 40, 210, 4]];
  for (const [pos, n, top, step] of shape) for (let i = 0; i < n; i++) rows.push({ name: `${pos}${i + 1}`, pos, points: top - i * step });
  return rows;
}
function gauss(r: () => number) { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
/** The market's view, built the way `runBacktest` builds it: the pool times one SHARED lognormal error. */
function marketView(p: PointsRow[], seed: number, sd = 0.30): PointsRow[] {
  const r = mulberry32(seed * 104729 + 3);
  return p.map((x) => ({ ...x, points: Math.max(0, x.points * (1 + gauss(r) * sd)) }));
}

test("POSITIVE CONTROL: our book == the room's book and no per-bot view => no edge, by construction", () => {
  const P = pool();
  const diffs: number[] = [];
  for (let seed = 1; seed <= 60; seed++) {
    const mk = marketView(P, seed);
    const room = vorBook(mk, VL);                 // the room's book -- and ours, identically
    const truth = vorBook(P, VL);                 // MEASURE ON THE TRUTH, never on the noisy book:
    // scoring a roster with the same noisy book the room drafted from rewards agreeing with the
    // noise rather than being right, and it reported a 60% deficit for a perfect book before it was
    // corrected. (charter rule 3: explain a surprising number before acting on it.)
    const teams = runSnakeDraft(mk, LG, { botIdioSd: 0 }, { values: room, cfg: { benchDiscount: 0.25 } }, seed);
    const val = teams.map((t) => t.reduce((a, p) => a + (truth.get(p.name) ?? 0), 0));
    const avg = val.reduce((a, b) => a + b, 0) / val.length;
    diffs.push(100 * (val[0] - avg) / avg);
  }
  const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - m) ** 2, 0) / (diffs.length - 1));
  const se = sd / Math.sqrt(diffs.length);
  assert.ok(Math.abs(m) < 3 * se + 1,
    `no-edge control must be null: our roster is ${m.toFixed(2)}% off the field average (se ${se.toFixed(2)})`);
});

test("FAULT INJECTION: drafting the WORST available collapses the playoff rate through the real backtest", () => {
  const P = pool();
  // Weekly actuals: a player's season split evenly over 14 weeks, so the season is deterministic and
  // the only thing that can move the playoff rate is the DRAFT.
  const weekly: Weekly = new Map();
  for (const p of P) {
    const m = new Map<number, number>();
    for (let w = 1; w <= 17; w++) m.set(w, p.points / 17);
    weekly.set(p.name, m);
  }
  /** A model that runs the real snake with OUR book inverted -- i.e. the worst available, every pick. */
  const Worst: DraftModel = {
    kind: "snake",
    runDraft(poolIn, league, field, ours, seed) {
      const flipped = new Map([...ours.values].map(([n, v]) => [n, -v] as [string, number]));
      return SnakeModel.runDraft(poolIn, league, field, { ...ours, values: flipped }, seed);
    },
  };
  const rate = (model: DraftModel) => {
    let po = 0, n = 0;
    for (let s = 1; s <= 24; s++) {
      const r = runBacktest(P, weekly, new Map(), { benchDiscount: 0.25 }, s, LG, 0.30, 0, undefined, undefined,
        true, false, false, false, 8, 14, new Map(), 0, "vor", false, 0, { idioSd: 0.20 }, false, "record", true,
        undefined, { model });
      if (r.madePlayoffs) po++;
      n++;
    }
    return (100 * po) / n;
  };
  const good = rate(SnakeModel), bad = rate(Worst);
  // The POSITIVE half first (the half fault injection alone cannot prove): the lever must be able to
  // return its good value at all, or "bad is low" says nothing.
  assert.ok(good > 50, `a real book must make the playoffs often in an 8-of-12 field (got ${good.toFixed(0)}%)`);
  assert.ok(bad < 10, `drafting the worst available must nearly never make the playoffs (got ${bad.toFixed(0)}%)`);
});

test("LEVER CONNECTED: --bot-noise reaches the snake room on the FLAGLESS arm", () => {
  // A flag the banner prints and the model never reads is indistinguishable from a flag that works.
  // `--bot-noise` reaches the AUCTION only through `market.idioSd`, which only `--market ecr`
  // populates -- so a naive reuse left the snake room with ONE identical book for all eleven bots and
  // a completely deterministic draft, while the header cheerfully announced "per-bot view 0.2".
  // `DraftOptions.botIdioSd` is the snake's own channel; this asserts it is live end to end.
  const P = pool();
  const weekly: Weekly = new Map();
  for (const p of P) { const m = new Map<number, number>(); for (let w = 1; w <= 17; w++) m.set(w, p.points / 17); weekly.set(p.name, m); }
  const run = (botIdioSd: number | undefined) => runBacktest(
    P, weekly, new Map(), { benchDiscount: 0.25 }, 5, LG, 0.30, 0, undefined, undefined,
    true, false, false, false, 8, 14, new Map(), 0, "vor", false, 0, {}, false, "record", true,
    undefined, { model: SnakeModel, ourSlot: 3, botIdioSd },
  );
  const a = run(undefined), b = run(0.35);
  assert.notDeepEqual(
    [a.projTotal, a.projStart, a.projBench, a.wins],
    [b.projTotal, b.projStart, b.projBench, b.wins],
    "raising --bot-noise must change what the room leaves on the board, and therefore our roster",
  );
  // ...and the same value twice must be IDENTICAL, or the "change" above is just nondeterminism.
  assert.deepEqual(run(0.35), b, "the draft must be deterministic given the seed");
});

test("SUPERFLEX SHAPE: quarterbacks go early, and they do so BECAUSE OF THE SLOT", () => {
  const P = pool();
  const mk = marketView(P, 4242);
  const ours = vorBook(P, VL);
  const qbRound = (slots: string[]) => {
    const lg = { teams: 12, budget: 200, slots };
    const log: { round: number; pos: string; team: number }[] = [];
    runSnakeDraft(mk, lg, { botIdioSd: 0.20 }, { values: vorBook(P, resolveValueLeague(lg)), cfg: { benchDiscount: 0.25 }, slot: 5 }, 4242, { log });
    return log.filter((p) => p.pos === "QB").slice(0, 6).map((p) => p.round);
  };
  const sf = qbRound(YAHOO);
  // A one-QB control: the SAME points table, the superflex slot replaced by a plain FLEX.
  const oneQb = qbRound(YAHOO.map((s) => (s === "SUPERFLEX" ? "FLEX" : s)));
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(mean(sf) <= 2, `under superflex the first six QBs must go in the first rounds (got ${sf.join(",")})`);
  assert.ok(mean(oneQb) > mean(sf),
    `dropping the SUPERFLEX slot must push QBs LATER -- superflex ${sf.join(",")} vs one-QB ${oneQb.join(",")}`);
  void ours;
});
