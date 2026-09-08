// The identity-keyed RNG. New random-number code is uniquely dangerous: a subtly bad generator does
// not crash, it produces plausible numbers with a wrong distribution, and every downstream result
// inherits the bias while looking fine. So the properties are asserted rather than assumed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { draw, drawGauss, PURPOSE, PlayerIds } from "../src/draft/rng.js";

const N = 120000;

test("draw() is uniform on [0,1)", () => {
  const bins = new Array(10).fill(0);
  let sum = 0, min = 1, max = 0;
  for (let i = 0; i < N; i++) {
    const u = draw(7, i % 3200, i % 17, i % 500, PURPOSE.perf);
    sum += u; min = Math.min(min, u); max = Math.max(max, u);
    bins[Math.min(9, Math.floor(u * 10))]++;
  }
  assert.ok(Math.abs(sum / N - 0.5) < 0.01, `mean ${sum / N} should be ~0.5`);
  assert.ok(min >= 0 && max < 1, `range [${min}, ${max}) must be [0,1)`);
  // Chi-square against uniform: 9 df, 21.67 is p<.01. A generator with structure fails here.
  const chi = bins.reduce((a, b) => a + (b - N / 10) ** 2 / (N / 10), 0);
  assert.ok(chi < 21.67, `chi-square ${chi.toFixed(1)} indicates non-uniform deciles: ${bins.join(",")}`);
});

test("drawGauss() has the right first two moments", () => {
  let s = 0, s2 = 0;
  for (let i = 0; i < N; i++) { const z = drawGauss(7, i % 3200, i % 17, i % 500, PURPOSE.injury); s += z; s2 += z * z; }
  const mean = s / N, sd = Math.sqrt(s2 / N - mean ** 2);
  assert.ok(Math.abs(mean) < 0.02, `mean ${mean} should be ~0`);
  assert.ok(Math.abs(sd - 1) < 0.02, `sd ${sd} should be ~1`);
});

// THE FAILURE THAT WOULD BE INVISIBLE. Two purposes colliding would correlate a player's injury roll
// with his performance roll -- healthy weeks would systematically score high, which is a plausible
// -looking bias nobody would spot in an odds table.
test("different purposes and different weeks are independent", () => {
  const pear = (a: number[], b: number[]) => {
    const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
    let n = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return n / Math.sqrt(da * db);
  };
  const inj: number[] = [], perf: number[] = [], nextWk: number[] = [], nextTrial: number[] = [];
  for (let i = 0; i < 40000; i++) {
    inj.push(draw(7, i, 5, i % 400, PURPOSE.injury));
    perf.push(draw(7, i, 5, i % 400, PURPOSE.perf));
    nextWk.push(draw(7, i, 6, i % 400, PURPOSE.injury));
    nextTrial.push(draw(7, i + 1, 5, i % 400, PURPOSE.injury));
  }
  assert.ok(Math.abs(pear(inj, perf)) < 0.02, "injury and performance draws must not correlate");
  assert.ok(Math.abs(pear(inj, nextWk)) < 0.02, "consecutive weeks must not correlate");
  assert.ok(Math.abs(pear(inj, nextTrial)) < 0.02, "consecutive trials must not correlate");
});

// THE WHOLE POINT: same identity, same value, regardless of anything else.
test("a draw depends only on its key -- this is what makes CRN work", () => {
  assert.equal(draw(7, 42, 9, 123, PURPOSE.perf), draw(7, 42, 9, 123, PURPOSE.perf));
  assert.equal(drawGauss(7, 42, 9, 123, PURPOSE.perf), drawGauss(7, 42, 9, 123, PURPOSE.perf));
  // ...and changing any component changes the value, or the key is not doing its job.
  const base = draw(7, 42, 9, 123, PURPOSE.perf);
  assert.notEqual(draw(8, 42, 9, 123, PURPOSE.perf), base, "seed must matter");
  assert.notEqual(draw(7, 43, 9, 123, PURPOSE.perf), base, "trial must matter");
  assert.notEqual(draw(7, 42, 10, 123, PURPOSE.perf), base, "week must matter");
  assert.notEqual(draw(7, 42, 9, 124, PURPOSE.perf), base, "player must matter");
  assert.notEqual(draw(7, 42, 9, 123, PURPOSE.injury), base, "purpose must matter");
});

test("player ids are name-derived, not encounter-ordered", () => {
  // Assigning ids in the order players are first seen would reintroduce the exact bug this replaces:
  // a roster change would shift everyone's id and therefore every draw.
  const a = new PlayerIds(), b = new PlayerIds();
  a.id("Breece Hall"); a.id("Jahmyr Gibbs"); a.id("Puka Nacua");
  b.id("Puka Nacua"); b.id("Breece Hall");   // different order, different set
  assert.equal(a.id("Breece Hall"), b.id("Breece Hall"), "same name must give the same id in any order");
  assert.equal(a.id("Puka Nacua"), b.id("Puka Nacua"));
});

test("id collisions are recorded, never silently remapped", () => {
  const ids = new PlayerIds();
  const names = ["Breece Hall", "Jahmyr Gibbs", ...Array.from({ length: 700 }, (_, i) => `Player ${i}`)];
  const seen = new Set<number>();
  for (const n of names) seen.add(ids.id(n));
  assert.equal(seen.size, names.length, "every name must end up with a distinct id");
  // A collision is not a bug in itself -- silence about one would be, since two players sharing an id
  // would share every draw for the whole season.
  assert.ok(Array.isArray(ids.collisions), "collisions must be observable");
});
