/**
 * One worker in the simulation pool. Receives roster-swap jobs, returns championship odds.
 *
 * WHY THIS IS SAFE TO PARALLELISE AT ALL, and it was NOT before the RNG change. The old simulator
 * drew from one sequential stream, so a result depended on how many draws had already been consumed
 * -- which in a pool depends on which worker picked up the job and in what order. Identical inputs
 * would have produced different answers run to run, and the parallel version would have been
 * non-reproducible in a way that looks exactly like Monte Carlo noise. Now every draw is a pure
 * function of (seed, trial, week, player, purpose), so a job's result depends only on the job. Order,
 * worker count and scheduling are all irrelevant. The determinism the keyed RNG bought for pairing
 * turns out to be the same property that makes the work distributable.
 *
 * Each worker loads the fitted models ONCE at startup rather than receiving them per job:
 * rank-outcomes.json is ~2 MB and structured-cloning it per candidate would cost more than the
 * simulation it feeds.
 */
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { simulateSeasons, type SeasonTeamInput, type VarianceModel } from "./season.js";

interface InitData {
  baseTeams: SeasonTeamInput[];
  weeks: [number, number][][];
  slots: string[];
  /** The league flex_ok; without it the worker silently defaults to RB/WR/TE. */
  flexOk?: string[];
  /** The streaming floor. Omitting it makes every worker result a DIFFERENT model from the caller's
   *  own baseline -- arms scored with empty slots at zero, base scored with replacement level -- and
   *  the two would have been printed side by side in one table. */
  replacement?: Record<string, number>;
  playoffTeams: number;
  projSd: number;
  poolRank: [string, { rank: number; of: number }][];
  varianceModelPath: string;
  outcomesPath: string;
  corrPath: string;
}
export interface SwapJob {
  /** index into the candidate list, echoed back so results can be reassembled in order */
  idx: number;
  meIdx: number;
  /** Index of the partner team, or -1 for a WAIVER move -- a one-sided add/drop where the incoming
   *  player belongs to nobody and is carried on the job itself. Without this the pool could only
   *  express trades, and a waiver sweep had to run single-threaded at ~6 seconds a claim. */
  theirIdx: number;
  giveName: string;
  getName: string;
  /** Required when theirIdx is -1: the free agent being claimed. */
  getPlayer?: { name: string; pos: string; proj: number; team?: string; bye?: number | null };
  trials: number;
  seed: number;
}
export interface SwapResult { idx: number; mine: number; theirs: number }

const init = workerData as InitData;
const vm = JSON.parse(readFileSync(init.varianceModelPath, "utf8")) as VarianceModel;
const outcomes = JSON.parse(readFileSync(init.outcomesPath, "utf8"));
const corr = JSON.parse(readFileSync(init.corrPath, "utf8"));
const poolRank = new Map(init.poolRank);

function run(teams: SeasonTeamInput[], trials: number, seed: number) {
  return simulateSeasons(teams, init.weeks, vm, {
    weeks: init.weeks.length, playoffTeams: init.playoffTeams, slots: init.slots,
    projSd: init.projSd, trials, seed, poolRank, flexOk: init.flexOk, replacement: init.replacement,
    bootstrap: { outcomes, corr, calibration: "scale" },
  });
}
const clone = (t: SeasonTeamInput[]) => t.map((x) => ({ ...x, roster: x.roster.map((p) => ({ ...p })) }));

parentPort!.on("message", (job: SwapJob | { done: true }) => {
  if ("done" in job) { parentPort!.close(); return; }
  const teams = clone(init.baseTeams);
  const give = teams[job.meIdx].roster.find((p) => p.name === job.giveName);
  if (!give) { parentPort!.postMessage({ idx: job.idx, mine: NaN, theirs: NaN } as SwapResult); return; }

  if (job.theirIdx < 0) {
    // WAIVER: the player comes from the free-agent pool, so only our roster changes and there is no
    // partner to report on. `theirs` is NaN rather than 0 -- a zero would read as a real measurement
    // of somebody, and this job has no somebody.
    if (!job.getPlayer) { parentPort!.postMessage({ idx: job.idx, mine: NaN, theirs: NaN } as SwapResult); return; }
    teams[job.meIdx].roster = teams[job.meIdx].roster
      .filter((p) => p.name !== job.giveName).concat([{ ...job.getPlayer }]);
    const o = run(teams, job.trials, job.seed);
    parentPort!.postMessage({ idx: job.idx, mine: o[job.meIdx].champion * 100, theirs: NaN } as SwapResult);
    return;
  }

  const get = teams[job.theirIdx].roster.find((p) => p.name === job.getName);
  if (!get) { parentPort!.postMessage({ idx: job.idx, mine: NaN, theirs: NaN } as SwapResult); return; }
  teams[job.meIdx].roster = teams[job.meIdx].roster.filter((p) => p.name !== job.giveName).concat([{ ...get }]);
  teams[job.theirIdx].roster = teams[job.theirIdx].roster.filter((p) => p.name !== job.getName).concat([{ ...give }]);
  const odds = run(teams, job.trials, job.seed);
  parentPort!.postMessage({ idx: job.idx, mine: odds[job.meIdx].champion * 100, theirs: odds[job.theirIdx].champion * 100 } as SwapResult);
});
