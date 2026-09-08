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
  theirIdx: number;
  giveName: string;
  getName: string;
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
    projSd: init.projSd, trials, seed, poolRank,
    bootstrap: { outcomes, corr, calibration: "scale" },
  });
}
const clone = (t: SeasonTeamInput[]) => t.map((x) => ({ ...x, roster: x.roster.map((p) => ({ ...p })) }));

parentPort!.on("message", (job: SwapJob | { done: true }) => {
  if ("done" in job) { parentPort!.close(); return; }
  const teams = clone(init.baseTeams);
  const give = teams[job.meIdx].roster.find((p) => p.name === job.giveName);
  const get = teams[job.theirIdx].roster.find((p) => p.name === job.getName);
  if (!give || !get) { parentPort!.postMessage({ idx: job.idx, mine: NaN, theirs: NaN } as SwapResult); return; }
  teams[job.meIdx].roster = teams[job.meIdx].roster.filter((p) => p.name !== job.giveName).concat([{ ...get }]);
  teams[job.theirIdx].roster = teams[job.theirIdx].roster.filter((p) => p.name !== job.getName).concat([{ ...give }]);
  const odds = run(teams, job.trials, job.seed);
  parentPort!.postMessage({ idx: job.idx, mine: odds[job.meIdx].champion * 100, theirs: odds[job.theirIdx].champion * 100 } as SwapResult);
});
