// ONE bounded-concurrency primitive for every fan-out in the repo, plus a GLOBAL cpu budget so
// nested fan-outs (candidates x folds, a backtest inside a sweep) can never collectively oversubscribe.
//
// WHY THIS EXISTS. Measured 2026-09-14 on a 32-core box: the nested-CV admission ran the Python
// trainer ONE fold at a time (one python at 99.9% of ONE core, ~8% total CPU) -- 31 cores idle. The
// pipeline had no shared concurrency primitive (only src/draft/simPool.ts, coupled to the sim's
// worker_threads), and carried a "run sweeps sequentially" belief that was an anecdote, never measured.
// This generalises simPool.runPool's proven pattern (results in INPUT order regardless of completion;
// default cores-1) into a task-agnostic map, and adds the global budget that makes it safe for ALL
// callers at once.
//
// THE DETERMINISM CONTRACT: concurrency must NEVER change the output. `pMap` returns results in input
// order, and callers' tasks must be independent + identity-keyed (folds are). test/pool.test.ts proves
// concurrency 1 == concurrency N, which is the acceptance gate for every adopter.
import { cpus } from "node:os";

/** Logical cores (floor 1). */
export function logicalCores(): number {
  return Math.max(1, cpus().length);
}

/** Default concurrency for CPU-bound fan-out: cores minus a small reserve for the coordinator + OS,
 *  overridable by FF_CONCURRENCY. I/O-bound callers should pass a higher explicit concurrency. */
export function defaultCpuConcurrency(): number {
  const env = Number(process.env.FF_CONCURRENCY);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  return Math.max(1, logicalCores() - 1);
}

/**
 * A counting semaphore. `peak` records the high-water mark of simultaneous holders -- bake-in
 * measurement, so utilisation is a number we read rather than an anecdote.
 */
export class Semaphore {
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];
  peak = 0;
  constructor(public limit: number) {}
  /** Acquire a slot; resolves to a release function. Idempotent release. */
  async acquire(): Promise<() => void> {
    if (this.inFlight >= this.limit) await new Promise<void>((r) => this.waiters.push(r));
    this.inFlight++;
    if (this.inFlight > this.peak) this.peak = this.inFlight;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
      this.waiters.shift()?.();
    };
  }
  /** Change the budget at runtime (tuning / tests). Raising it wakes queued waiters. */
  resize(limit: number): void {
    this.limit = Math.max(1, Math.floor(limit));
    while (this.inFlight < this.limit && this.waiters.length) { this.inFlight++; this.waiters.shift()?.(); this.inFlight--; }
  }
}

/** THE process-wide CPU budget. Every CPU-bound task acquires one slot before it spawns, so the whole
 *  fan-out tree shares one budget <= cores no matter how deeply it nests. A module singleton on purpose. */
export const cpuBudget = new Semaphore(defaultCpuConcurrency());

/** Run `fn` holding one slot of the global CPU budget. Wrap the body of any CPU-bound task (a trainer
 *  fold, a backtest cell) in this so nested fan-outs can't exceed the machine. */
export async function withCpuSlot<T>(fn: () => Promise<T>): Promise<T> {
  const release = await cpuBudget.acquire();
  try { return await fn(); } finally { release(); }
}

export interface PMapOpts {
  /** Max tasks of THIS map in flight (default cores-1). The global cpuBudget is the cross-map cap. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  /** Default true: on the first error, stop starting new tasks and reject. False: run all, collect. */
  stopOnError?: boolean;
}

/**
 * Bounded-concurrency map. Runs `fn(item, i)` for every item with at most `concurrency` in flight,
 * returning results in INPUT ORDER regardless of completion order. Generalises simPool.runPool for
 * ANY async task (a subprocess spawn, a worker message, a fetch).
 */
export async function pMap<A, B>(
  items: readonly A[],
  fn: (item: A, index: number) => Promise<B>,
  opts: PMapOpts = {},
): Promise<B[]> {
  const total = items.length;
  const stop = opts.stopOnError ?? true;
  const results = new Array<B>(total);
  let next = 0, done = 0;
  let firstError: unknown = null;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (firstError != null && stop) return;
      const i = next++;
      if (i >= total) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        if (firstError == null) firstError = e;
        if (stop) return;
      }
      done++;
      opts.onProgress?.(done, total);
    }
  };
  const width = Math.max(1, Math.min(opts.concurrency ?? defaultCpuConcurrency(), total || 1));
  await Promise.all(Array.from({ length: width }, () => worker()));
  if (firstError != null && stop) throw firstError;
  return results;
}
