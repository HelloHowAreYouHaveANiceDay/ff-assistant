/**
 * A worker pool for roster-swap simulations.
 *
 * The sweep is embarrassingly parallel -- every candidate is an independent simulation over the same
 * read-only inputs -- and it was previously running on one core while the other N-1 sat idle. A
 * 700-candidate sweep at 3200 trials takes ~40 minutes serially and should take a few minutes.
 *
 * THE PRECONDITION IS DETERMINISM, which the identity-keyed RNG provides and the old sequential
 * stream did not. Under the old scheme a job's result depended on how many draws had already been
 * consumed, so in a pool it would depend on scheduling -- producing run-to-run variation that is
 * indistinguishable from Monte Carlo noise and impossible to debug. `assertDeterministic` below
 * exists to keep that guarantee honest rather than assumed.
 */
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";
import type { SeasonTeamInput } from "./season.js";
import type { SwapJob, SwapResult } from "./simWorker.js";

export interface PoolInit {
  baseTeams: SeasonTeamInput[];
  weeks: [number, number][][];
  slots: string[];
  playoffTeams: number;
  projSd: number;
  poolRank: Map<string, { rank: number; of: number }>;
  varianceModelPath: string;
  outcomesPath: string;
  corrPath: string;
}

const WORKER_URL = new URL("./simWorker.ts", import.meta.url);

/** Run `jobs` across a pool, returning results in the ORDER OF `jobs` regardless of completion order. */
export async function runPool(
  init: PoolInit,
  jobs: SwapJob[],
  opts: { workers?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<SwapResult[]> {
  // Leave one core for the OS and the parent; a fully saturated box makes the whole machine
  // unresponsive and finishes no sooner.
  const n = Math.max(1, Math.min(opts.workers ?? Math.max(1, cpus().length - 1), jobs.length));
  const workerData = { ...init, poolRank: [...init.poolRank.entries()] };
  const results = new Array<SwapResult>(jobs.length);
  let next = 0, done = 0;

  await new Promise<void>((resolve, reject) => {
    let alive = 0;
    const spawn = () => {
      // execArgv carries the tsx loader into the worker: without it the worker cannot import .ts,
      // and the failure is an opaque "Unknown file extension" from inside a thread.
      const w = new Worker(fileURLToPath(WORKER_URL), { workerData, execArgv: ["--import", "tsx"] });
      alive++;
      const feed = () => {
        if (next >= jobs.length) { w.postMessage({ done: true }); return; }
        w.postMessage(jobs[next++]);
      };
      w.on("message", (r: SwapResult) => {
        results[r.idx] = r;
        opts.onProgress?.(++done, jobs.length);
        feed();
      });
      w.on("error", reject);
      w.on("exit", () => { if (--alive === 0) resolve(); });
      feed();
    };
    for (let i = 0; i < n; i++) spawn();
  });
  return results;
}

/**
 * Prove the pool returns the same numbers as a serial run.
 *
 * This is the check the whole design rests on, and it is cheap: run a handful of jobs through the
 * pool twice with DIFFERENT worker counts. If any result differs, scheduling is leaking into the
 * answer and every sweep number is suspect. Compared exactly rather than within a tolerance --
 * identity-keyed draws make the results bit-identical, so any drift at all is a real defect and not
 * floating-point slop.
 */
export async function assertDeterministic(init: PoolInit, jobs: SwapJob[]): Promise<void> {
  const sample = jobs.slice(0, Math.min(6, jobs.length));
  const [a, b] = await Promise.all([runPool(init, sample, { workers: 1 }), runPool(init, sample, { workers: 4 })]);
  for (let i = 0; i < sample.length; i++) {
    if (a[i].mine !== b[i].mine || a[i].theirs !== b[i].theirs) {
      throw new Error(
        `POOL IS NOT DETERMINISTIC: job ${i} gave ${a[i].mine}/${a[i].theirs} on 1 worker and ` +
        `${b[i].mine}/${b[i].theirs} on 4. Scheduling is affecting the result -- every sweep number is suspect.`,
      );
    }
  }
}
