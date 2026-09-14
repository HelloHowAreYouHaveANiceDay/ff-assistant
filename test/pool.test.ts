import { test } from "node:test";
import assert from "node:assert/strict";
import { pMap, Semaphore, cpuBudget, withCpuSlot } from "../src/util/pool.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("pMap returns results in INPUT order regardless of completion order", async () => {
  // Reverse delays: item 0 finishes LAST. Output must still be [0,1,2,...].
  const items = [0, 1, 2, 3, 4, 5, 6, 7];
  const out = await pMap(items, async (x) => { await sleep((items.length - x) * 5); return x * 10; }, { concurrency: 8 });
  assert.deepEqual(out, items.map((x) => x * 10));
});

test("pMap never runs more than `concurrency` tasks at once", async () => {
  let live = 0, peak = 0;
  await pMap(Array.from({ length: 40 }, (_, i) => i), async () => {
    live++; peak = Math.max(peak, live);
    await sleep(3);
    live--;
  }, { concurrency: 4 });
  assert.ok(peak <= 4, `peak ${peak} exceeded concurrency 4`);
  assert.ok(peak >= 2, `peak ${peak} suspiciously low -- did it actually parallelise?`);
});

test("DETERMINISM CONTRACT: concurrency 1 == concurrency N (the adopter gate)", async () => {
  const items = Array.from({ length: 30 }, (_, i) => i);
  const pure = async (x: number) => x * x - 7;
  const serial = await pMap(items, pure, { concurrency: 1 });
  const parallel = await pMap(items, pure, { concurrency: 12 });
  const plain = items.map((x) => x * x - 7); // a plain synchronous map, the ground truth
  assert.deepEqual(parallel, serial);
  assert.deepEqual(serial, plain);
});

test("FAULT: stopOnError rejects on the first error and stops early", async () => {
  let started = 0;
  await assert.rejects(
    pMap(Array.from({ length: 50 }, (_, i) => i), async (x) => {
      started++;
      if (x === 3) throw new Error("boom at 3");
      await sleep(2);
      return x;
    }, { concurrency: 2, stopOnError: true }),
    /boom at 3/,
  );
  assert.ok(started < 50, `stopOnError should not start all tasks (started ${started})`);
});

test("stopOnError:false runs every task and still returns input-order results", async () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  const out = await pMap(items, async (x) => { if (x === 5) throw new Error("x5"); return x; }, { concurrency: 3, stopOnError: false });
  // index 5 is left undefined (its task threw); the rest are placed in order.
  assert.equal(out[4], 4); assert.equal(out[6], 6); assert.equal(out[5], undefined);
});

test("GLOBAL BUDGET: nested fan-outs sharing withCpuSlot never exceed the cpu budget", async () => {
  const savedLimit = cpuBudget.limit;
  cpuBudget.resize(3);
  cpuBudget.peak = 0;
  try {
    // Outer fan-out of 4 candidates, each an inner fan-out of 4 folds -- 16 CPU tasks that would
    // oversubscribe a 3-slot machine if the budget did not gate them.
    await pMap([0, 1, 2, 3], async () =>
      pMap([0, 1, 2, 3], async () => withCpuSlot(async () => { await sleep(5); return 1; }), { concurrency: 4 }),
    { concurrency: 4 });
    assert.ok(cpuBudget.peak <= 3, `global cpu peak ${cpuBudget.peak} exceeded budget 3 -- nested fan-out oversubscribed`);
    assert.ok(cpuBudget.peak >= 2, `global cpu peak ${cpuBudget.peak} too low -- budget not being used`);
  } finally {
    cpuBudget.resize(savedLimit);
    cpuBudget.peak = 0;
  }
});

test("Semaphore releases are idempotent and wake waiters", async () => {
  const s = new Semaphore(1);
  const r1 = await s.acquire();
  let got2 = false;
  const p2 = s.acquire().then((r) => { got2 = true; return r; });
  await sleep(5);
  assert.equal(got2, false, "second acquire must block while the one slot is held");
  r1(); r1(); // double release must not over-credit
  const r2 = await p2;
  assert.equal(got2, true);
  r2();
});
