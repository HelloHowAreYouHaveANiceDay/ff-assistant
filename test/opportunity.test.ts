// The opportunity model. The defects worth guarding here are the silent ones: a factor that is
// always 1 (feature disconnected), a factor that reads the CURRENT season's usage (lookahead, which
// scores beautifully and is worthless), and a factor applied to a position the measurement says has
// no signal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { opportunityFactor, opportunityCoverage, type OpportunityModel } from "../src/draft/opportunity.js";

const M: OpportunityModel = {
  bucket: 6, maxRank: 60, season: 2025,
  amplitude: { RB: 1, WR: 0.68, TE: 1, QB: 0.05 },
  pos: {
    RB: { b0: 0.5, bFd: 0.4, bTs: 0.02, mean: 0.92, amp: 1 },
    QB: null,                                                        // never fitted
    // Fitted but shrunk to nothing -- a DIFFERENT code path from `null`, and the one the shipped
    // model actually uses for a no-signal position once a refit nudges it off exactly zero.
    K: { b0: 0.5, bFd: 0.4, bTs: 0.02, mean: 0.92, amp: 0 },
    // A NEGATIVE amplitude is what the guard actually protects against, and finding that out took
    // three attempts. amp === 0 cannot distinguish a working guard from a missing one, because
    // `1 + (shape - 1) * 0` is already exactly 1 -- the arithmetic does the guard's job. Only a
    // negative amplitude behaves differently, and it inverts the adjustment: a heavily-used player
    // gets marked DOWN. Not hypothetical -- QB measured -0.0014 on the 10-season fit, and a refit
    // that writes a negative lift straight through would silently invert that position's board.
    DST: { b0: 0.5, bFd: 0.4, bTs: 0.02, mean: 0.92, amp: -0.5 },
  },
  players: {
    "2025|Heavy": { fd: 4.0, ts: 0.20 },
    "2025|Light": { fd: 1.0, ts: 0.05 },
    "2024|OldOnly": { fd: 4.0, ts: 0.20 },
  },
  // K gets bucket means too, deliberately. Without them the zero-amplitude test below returns 1 via
  // the MISSING-BUCKET guard instead of the amplitude guard, and passes while proving nothing --
  // which is exactly what it did on the first attempt, staying green under fault injection.
  bucketMeans: {
    RB: { "0": { fd: 2.5, ts: 0.12 } },
    // K and DST get bucket means too, deliberately. Without them the tests below return 1 via the
    // MISSING-BUCKET guard instead of the amplitude guard, and pass while proving nothing -- which
    // is exactly what happened on the first attempt: green under fault injection.
    K: { "0": { fd: 2.5, ts: 0.12 } },
    DST: { "0": { fd: 2.5, ts: 0.12 } },
  },
};

test("more usage than his rank implies raises the projection; less lowers it", () => {
  const heavy = opportunityFactor(M, "Heavy", "RB", 3, 2026);
  const light = opportunityFactor(M, "Light", "RB", 3, 2026);
  assert.ok(heavy > 1, `a heavily-used back should be marked up, got ${heavy}`);
  assert.ok(light < 1, `a lightly-used back should be marked down, got ${light}`);
  assert.ok(heavy > light);
});

// THE POSITIVE DIRECTION. Everything else here could pass against a function that returns 1.
test("the factor actually moves -- it is not pinned at 1", () => {
  const f = opportunityFactor(M, "Heavy", "RB", 3, 2026);
  assert.notEqual(f, 1, "a fitted position with known usage must produce something other than 1");
  assert.ok(Math.abs(f - 1) > 0.02, `expected a material adjustment, got ${f}`);
});

// LOOKAHEAD is the expensive failure: it makes every backtest look excellent and helps nothing live.
test("usage is read from the PRIOR season, never the season being projected", () => {
  // "2025|Heavy" must be consulted when projecting 2026...
  assert.notEqual(opportunityFactor(M, "Heavy", "RB", 3, 2026), 1);
  // ...and must NOT be consulted when projecting 2025, where it would be that season's own truth.
  assert.equal(opportunityFactor(M, "Heavy", "RB", 3, 2025), 1,
    "projecting 2025 may only use 2024 usage; using 2025 usage is lookahead");
  // A player with only 2024 data is adjustable for 2025 and not for 2026.
  assert.notEqual(opportunityFactor(M, "OldOnly", "RB", 3, 2025), 1);
  assert.equal(opportunityFactor(M, "OldOnly", "RB", 3, 2026), 1);
});

test("a position with no signal is exactly 1, by EITHER mechanism", () => {
  assert.equal(opportunityFactor(M, "Heavy", "QB", 3, 2026), 1, "never fitted (null)");
  // The one that matters in production: fitted, but with its amplitude shrunk to zero. Guarding
  // only the null case leaves this wide open, and a refit can move a position between the two.
  assert.equal(opportunityFactor(M, "Heavy", "K", 3, 2026), 1, "fitted but zero amplitude");
  // The case the guard EXISTS for. A negative amplitude inverts the adjustment rather than
  // disabling it, so without the guard a heavily-used player is marked DOWN. Zero amplitude cannot
  // test this: `1 + (shape - 1) * 0` is 1 whether the guard runs or not.
  assert.equal(opportunityFactor(M, "Heavy", "DST", 3, 2026), 1,
    "a negative measured lift must disable the adjustment, never invert it");
});

test("unknown player, unknown bucket and out-of-range rank all return 1, never a guess", () => {
  assert.equal(opportunityFactor(M, "Nobody", "RB", 3, 2026), 1, "a rookie has no prior usage");
  assert.equal(opportunityFactor(M, "Heavy", "RB", 400, 2026), 1, "rank beyond the fitted range");
  assert.equal(opportunityFactor(M, "Heavy", "RB", 0, 2026), 1, "rank 0 is not a rank");
  assert.equal(opportunityFactor(null, "Heavy", "RB", 3, 2026), 1, "no model at all");
  assert.equal(opportunityFactor(M, "Heavy", "TE", 3, 2026), 1, "position present in amplitude but not fitted");
});

test("the clamp bounds the adjustment in both directions", () => {
  const extreme: OpportunityModel = { ...M, players: { "2025|Wild": { fd: 500, ts: 5 }, "2025|Zero": { fd: 0, ts: 0 } } };
  const hi = opportunityFactor(extreme, "Wild", "RB", 3, 2026);
  const lo = opportunityFactor(extreme, "Zero", "RB", 3, 2026);
  assert.ok(hi <= 1.25 + 1e-9, `clamped above, got ${hi}`);
  assert.ok(lo >= 0.75 - 1e-9, `clamped below, got ${lo}`);
});

test("a zero-usage bucket does not divide by ~0 and blow the factor up", () => {
  const degenerate: OpportunityModel = { ...M, bucketMeans: { RB: { "0": { fd: 0, ts: 0 } } } };
  const f = opportunityFactor(degenerate, "Heavy", "RB", 3, 2026);
  assert.ok(Number.isFinite(f) && f > 0.5 && f < 1.5, `expected a sane factor, got ${f}`);
});

test("coverage counts prior-season entries for the season asked about", () => {
  assert.deepEqual(opportunityCoverage(M, ["Heavy", "Light", "Nobody"], 2026), { known: 2, total: 3 });
  assert.deepEqual(opportunityCoverage(M, ["Heavy", "OldOnly"], 2025), { known: 1, total: 2 });
  assert.deepEqual(opportunityCoverage(null, ["Heavy"], 2026), { known: 0, total: 1 });
});

// --- the SHIPPED model, so a bad refit cannot pass unnoticed ---------------------------------------
test("the shipped model keeps QB flat and every position inside the clamp", (t) => {
  if (!existsSync("data/opportunity-model.json")) return t.skip("model not built");
  const real = JSON.parse(readFileSync("data/opportunity-model.json", "utf8")) as OpportunityModel;
  // QB measured ~0 across 20 seasons; its amplitude must stay negligible or the top of the board
  // moves on a signal that is not there. This is the mistake the age curve shipped and had to undo.
  const qbAmp = real.pos?.QB?.amp ?? 0;
  assert.ok(qbAmp <= 0.15, `QB amplitude ${qbAmp} -- measured signal is ~0, it must not swing the board`);
  const names = Object.keys(real.players).filter((k) => k.startsWith(`${real.season}|`)).slice(0, 400);
  for (const key of names) {
    const name = key.slice(String(real.season).length + 1);
    for (const pos of ["RB", "WR", "TE", "QB"]) {
      for (const rank of [1, 12, 30, 55]) {
        const f = opportunityFactor(real, name, pos, rank, real.season + 1);
        assert.ok(Number.isFinite(f) && f >= 0.7 && f <= 1.3, `${name} ${pos}${rank} -> ${f}`);
      }
    }
  }
});
