// THE WEEKLY MODEL'S CONTRIBUTION LEDGER (M2g) -- a training-time ablation of the served two-part
// weekly model, driven entirely through the EXISTING harness. This file is a DRIVER: it trains the
// nested-CV folds with `tools/train_weekly.py` (the same binary `src/weekly/evaluate.ts` shells), it
// scores each arm with `ff evaluate-weekly --keep-artifacts <arm dir> --reuse-artifacts`, and it reads
// the arm JSONs back through scripts/lib/arbiter.mjs's `admissionVerdict` -- the SAME paired season
// floor scripts/weekly-paired-floor.mjs applies. Nothing here re-implements a statistic and nothing
// here writes to data/.
//
// WHY A LEDGER. docs/feature-frontier.md screens CANDIDATES (does adding X help?). Nothing has ever
// asked the complementary question about the 25 features that already ship: what does each one carry,
// and is any of them carrying nothing? A leave-one-out is the lower bound on a feature's worth (what
// is lost when it goes, with every correlate still present); a knock-in from the floor is the upper
// bound (what it carries alone). Reporting only one of the two is how a redundant block reads as
// worthless and how a unique block reads as decisive. docs/contribution-ledger-2026-09-16.md is the
// same study one horizon up, on the SEASON projector; this is its weekly twin.
//
// THE UNIT OF ANALYSIS IS THE SEASON (CLAUDE.md). Each arm is 14 leave-one-season-out folds; the arms
// share the harness's seeds and roster draws, so the per-season pooled CRPS deltas are matched pairs.
//
// WHY THE DRIVER TRAINS THE FOLDS ITSELF INSTEAD OF LETTING `evaluate-weekly` DO IT.
// One fold of the shipped recipe (25 features, two-part, gbm) is ~4.7 minutes and is SINGLE-CORE
// bound -- MEASURED 2026-09-16 on this box: the same fold takes 4m44s with all 32 cores available and
// 5m25s with OMP_NUM_THREADS=1, i.e. the boosted heads do not scale across cores at this data size.
// `evaluateWeekly` runs its folds in a plain sequential `for`, so one arm is ~66 minutes of wall clock
// on one core of 32 and a 31-arm study is 33 core-hours serialised into 33 wall-hours. Training the
// (arm, season) grid as independent single-core jobs in a bounded pool turns that into ~1.5 hours
// without changing a single byte of what is fitted: the trainer invocation below is character-for-
// character the one `trainHoldout` issues, and `--reuse-artifacts` then makes the harness LOAD the
// fold rather than refit it. That equivalence is not assumed -- `--verify` re-reads every fold and
// asserts its `features` list is exactly the arm's, on the producer's own bytes.
//
// A HARD CONSTRAINT THIS DRIVER DOES NOT FIGHT. `tools/train_weekly.py` REFUSES `--zero-model
// two-part` (what the shipped artifact is) unless `inj_out`, `depth_rank`, `teammates_out` and
// `prior_snap_share` are all in the fitted set -- a two-part model whose stage one cannot see the
// injury fits the CONSEQUENCE of the injury. Those four therefore have NO training-time
// leave-one-out arm, and neither do the availability/usage families as wholes, nor a bare
// season-line-only knock-in floor. The driver marks them REFUSED rather than working around a
// deliberate guard, and substitutes a SERVE-TIME MASK arm (`--mask-serve`), which is a DIFFERENT
// quantity (fit-with, serve-without) and is reported in its own table, never in the LOO one.
//
// USAGE:
//   node --import tsx scripts/weekly-contribution-ledger.mjs --plan
//   node --import tsx scripts/weekly-contribution-ledger.mjs --train  --out-dir <dir> [--db <path>] [--concurrency N] [--only <re>]
//   node --import tsx scripts/weekly-contribution-ledger.mjs --verify --out-dir <dir>
//   node --import tsx scripts/weekly-contribution-ledger.mjs --score  --out-dir <dir> [--db <path>] [--concurrency N] [--only <re>]
//   node --import tsx scripts/weekly-contribution-ledger.mjs --report --out-dir <dir>
import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { admissionVerdict, familyAdjust, normalSf } from "./lib/arbiter.mjs";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The 26 features the shipped artifact fits, in artifact order. Not retyped from the trainer's
 *  ALL_FEATURES (which is 29 -- it also carries rz_share_td and prior_vol_cv, both REJECTED
 *  candidates). CLAUDE.md: measure against the baseline you intend to ship.
 *
 *  HISTORY, because this list has moved twice in two days and each move retired a table:
 *  - 2026-09-17, D27/WP16b: `ecr_wk_rank`/`ecr_wk_sd` PROMOTED, 25 -> 27, and a new `ecr` family.
 *  - 2026-09-18, D30/WP18: `inj_feed` DROPPED, 27 -> 26. It is the one row this ledger resolved as a
 *    proof rather than a measurement -- a constant 1 plus a missingness pattern over the fitted
 *    population, whose leave-one-out and serve-mask arms both reproduced the full design BIT FOR BIT
 *    on all fourteen seasons. The re-screen against the 27-column design (scripts/weekly-drop-screen.mjs)
 *    reproduced that exactly, and the served artifact's six golden rows are unchanged to 1e-6 across
 *    the promotion. The COLUMN is still built, stored and audited; it is only no longer FITTED.
 *
 *  **THE PUBLISHED LEDGER (docs/weekly-contribution-ledger-2026-09-16.md) WAS MEASURED ON THE
 *  25-COLUMN DESIGN**; the 2026-09-18 section of that same file is the rerun against this one. The
 *  driver is corrected here rather than left behind because the test that pins it asserts exactly one
 *  thing -- that the arms ablate the design that SHIPS -- and a driver pinned to a superseded design
 *  would ablate a model nobody is served from, which is the failure the pin exists to catch. */
export const SHIPPED = [
  "td_ppg", "t4_mean", "t4_sd", "td_games", "spread_line", "total_line", "implied_team_total",
  "days_rest", "week_no", "season_line_pg", "td_fd", "td_ts", "td_attempts", "td_rush_yards",
  "ecr_wk_rank", "ecr_wk_sd",
  "prior_snap_share", "prior_route_share", "depth_rank", "teammates_out", "home", "inj_out",
  "inj_doubtful", "inj_questionable", "prac_dnp", "prac_limited",
];

/** tools/train_weekly.py AVAILABILITY_REQUIRED -- the two-part refusal set. */
export const REQUIRED = ["inj_out", "depth_rank", "teammates_out", "prior_snap_share"];

/**
 * FAMILIES. The SEMANTIC grouping (what the block is about), which is the brief's and the trainer's
 * own comment structure. NOTE it is NOT identical to the trainer's MASKABLE_GROUPS, which groups by
 * HOW A BLOCK GOES ABSENT AT SERVE: there `td_fd/td_ts/td_attempts/td_rush_yards` sit in "form"
 * (they vanish with the rest of the to-date block on a forward week) while here they sit in "usage"
 * (they are workload, not scoring), and there `spread_line/total_line/implied_team_total` are their
 * own "odds" group while here they sit inside game context with `home`/`days_rest`/`week_no`.
 * Both groupings are right about different questions; this one is about what the model LEARNS from,
 * so the divergence is stated rather than reconciled.
 */
export const FAMILIES = {
  level: ["season_line_pg"],
  form: ["td_ppg", "t4_mean", "t4_sd", "td_games"],
  usage: ["td_fd", "td_ts", "td_attempts", "td_rush_yards", "prior_snap_share", "prior_route_share", "depth_rank"],
  // D30/WP18 dropped `inj_feed` from the design, so it leaves this family too: FAMILIES must
  // PARTITION `SHIPPED` (test/weekly-contribution-ledger.test.ts asserts it), and a family naming a
  // column nobody fits would produce a leave-family-out arm that drops one column fewer than it says.
  avail: ["inj_out", "inj_doubtful", "inj_questionable", "prac_dnp", "prac_limited", "teammates_out"],
  context: ["spread_line", "total_line", "implied_team_total", "days_rest", "home", "week_no"],
  // D27/WP16b. Its OWN family rather than a member of `form`: the weekly expert consensus is an
  // outside opinion about the coming week, not a summary of what this player has already done, and
  // it goes absent at serve for its own reason (the scrape did not run) rather than with the
  // to-date block. It is also the one family that is NULL on nine of the fourteen seasons.
  ecr: ["ecr_wk_rank", "ecr_wk_sd"],
};

/** The smallest design the two-part contract permits: the level anchor plus the four columns stage
 *  one may not run without. Every knock-in arm is this plus one family, so the four required columns
 *  are held CONSTANT across the whole knock-in table rather than being credited to any family. */
export const FLOOR_PLUS = ["season_line_pg", ...REQUIRED];

const SELECTION = [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020];
const HOLDOUT = [2021, 2022, 2023, 2024, 2025];
export const ALL_SEASONS = [...SELECTION, ...HOLDOUT];

/** Can this feature set be fitted at all under the shipped two-part zero model? */
export function twoPartFeasible(features) {
  const s = new Set(features);
  return REQUIRED.every((c) => s.has(c));
}

/** Always emit a feature list in SHIPPED order, so two arms with the same set produce the same
 *  `--features` string and therefore the same fold bytes. Order is not a free variable here. */
export function ordered(features) {
  const s = new Set(features);
  return SHIPPED.filter((f) => s.has(f));
}

/** The full arm list, in RUN ORDER: the full design first (its folds are what every serve-mask arm
 *  reuses), then the family answers, then the knock-ins, then the 21 single-column leave-one-outs. */
export function buildArms() {
  const arms = [];
  arms.push({ id: "full", kind: "full", features: SHIPPED, label: `all ${SHIPPED.length} (the shipped design)` });

  // LEAVE-FAMILY-OUT, retrained. A family containing a required column is dropped only down to the
  // columns the contract allows, and is labelled "partial" so nobody reads it as the whole block.
  for (const [fam, cols] of Object.entries(FAMILIES)) {
    const droppable = cols.filter((c) => !REQUIRED.includes(c));
    if (cols.length === 1 && droppable.length === 1) continue;   // level == its own LOO arm
    const feats = ordered(SHIPPED.filter((x) => !droppable.includes(x)));
    arms.push({
      id: `famloo__${fam}`, kind: "famloo", family: fam, drop: droppable, features: feats,
      partial: droppable.length !== cols.length,
      label: `all ${SHIPPED.length} minus ${fam} (${droppable.length} of ${cols.length})`,
    });
  }

  // KNOCK-IN FROM THE FLOOR.
  arms.push({ id: "knockin__floor", kind: "knockin", family: "(floor)", add: [], features: ordered(FLOOR_PLUS), label: "floor: line + the four required columns" });
  for (const [fam, cols] of Object.entries(FAMILIES)) {
    const add = cols.filter((c) => !FLOOR_PLUS.includes(c));
    if (!add.length) continue;                        // level and the required columns ARE the floor
    arms.push({
      id: `knockin__${fam}`, kind: "knockin", family: fam, add, features: ordered([...FLOOR_PLUS, ...add]),
      label: `floor + ${fam} (${add.length} columns)`,
    });
  }

  // LEAVE-ONE-OUT, retrained.
  for (const f of SHIPPED) {
    const feats = ordered(SHIPPED.filter((x) => x !== f));
    arms.push({
      id: `loo__${f}`, kind: "loo", drop: [f], features: feats, label: `all ${SHIPPED.length} minus ${f}`,
      refused: twoPartFeasible(feats) ? null : "two-part needs " + REQUIRED.join(", "),
    });
  }

  // SERVE-TIME MASKS. NO training at all -- they reuse the FULL arm's 14 fold artifacts and only
  // re-score, with the named columns nulled on the SCORED rows (src/weekly/evaluate.ts
  // `applyServeMask`). A different quantity from a leave-one-out (fit-WITH, serve-WITHOUT) and the
  // ONLY measurement available for the four columns the trainer will not let the design drop.
  for (const f of SHIPPED) {
    arms.push({
      id: `mask__${f}`, kind: "mask", features: SHIPPED, mask: [f], reuseFrom: "full",
      label: `serve-mask ${f}`, substitutes: REQUIRED.includes(f) ? `loo__${f}` : null,
    });
  }
  for (const [fam, cols] of Object.entries(FAMILIES)) {
    arms.push({
      id: `maskfam__${fam}`, kind: "maskfam", family: fam, features: SHIPPED, mask: cols, reuseFrom: "full",
      label: `serve-mask family ${fam} (all ${cols.length})`,
    });
  }

  // THE DEGENERACY POSITIVE CONTROL, and it costs no training. `full_dup` scores the full arm's own
  // folds a second time with an EMPTY mask. It must come back bit-identical to `full`; if it does
  // not, the harness is not deterministic and no delta below is a feature's contribution. It is also
  // the only thing that proves `isDegenerate` can return TRUE against a real pair of runs rather than
  // against a fixture -- a guard that has only ever been exercised on the negative path is a guard
  // nobody has seen work (CLAUDE.md, "prove the guard can return its POSITIVE value").
  arms.push({ id: "full_dup", kind: "control", features: SHIPPED, mask: [], reuseFrom: "full", label: "full design, re-scored (degeneracy positive control)" });
  return arms;
}

/** Every (arm, season) fold this study needs, skipping the arms that never train. */
export function foldJobs(arms) {
  const jobs = [];
  for (const arm of arms) {
    if (arm.refused || arm.reuseFrom) continue;
    for (const yr of ALL_SEASONS) jobs.push({ arm: arm.id, season: yr, features: arm.features });
  }
  return jobs;
}

// ---- RUN ------------------------------------------------------------------------------------

/** A bounded worker pool: `n` tasks in flight, in list order. */
export async function runPool(items, n, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(n, queue.length)) }, async () => {
    for (let it = queue.shift(); it !== undefined; it = queue.shift()) await fn(it);
  });
  await Promise.all(workers);
}

export const log = (outDir, line) => {
  appendFileSync(join(outDir, "_run.log"), `[${new Date().toISOString()}] ${line}\n`);
  console.log(line);
};

/** The trainer invocation, character-for-character `trainHoldout`'s (src/weekly/evaluate.ts). The
 *  shipped recipe is two-part + gbm and is read OFF the artifact there; it is pinned here because
 *  this driver bypasses that read, and `--verify` checks the produced folds say so. */
export function trainArgs(dbPath, holdout, features, out) {
  return [
    "run", "--with", "scikit-learn", "--with", "numpy", "tools/train_weekly.py",
    "--db", dbPath, "--seasons", "2012-2025", "--holdout-season", String(holdout),
    "--features", features.join(","), "--zero-model", "two-part", "--learner", "gbm",
    "--out", out, "--quiet",
  ];
}

/**
 * ONE OPENMP THREAD PER FOLD, and it is the difference between a 1.5-hour study and a 6-hour one.
 *
 * MEASURED on this box, 2026-09-16. A fold ALONE takes 4m44s with all 32 cores available and 5m25s
 * pinned to one thread -- HistGradientBoosting does not scale across cores at this data size, so the
 * extra threads were buying 12%. But scikit-learn's default is one OpenMP thread PER CORE, so 26
 * folds in flight ask for 26 x 32 = 832 threads on 32 cores, and the measured per-fold time went to
 * 20-24 MINUTES: a 5.6x speedup for 26x the processes, i.e. the pool spent its time in the scheduler.
 * Pinning each child to one thread makes the pool's arithmetic honest again.
 *
 * IT DOES NOT CHANGE WHAT IS FITTED, and that is checked rather than argued: a fold retrained under
 * this env is byte-compared against the same fold trained without it (see the doc's controls). Thread
 * count is a scheduling decision; HistGradientBoosting's histogram splits are exact and deterministic.
 */
export const SINGLE_THREAD = {
  OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1",
  NUMEXPR_NUM_THREADS: "1", VECLIB_MAXIMUM_THREADS: "1",
};

export function foldPath(outDir, armId, season) { return join(outDir, "_folds", armId, `weekly-${season}.json`); }

export async function trainFold(job, outDir, dbPath) {
  const out = foldPath(outDir, job.arm, job.season);
  mkdirSync(dirname(out), { recursive: true });
  if (existsSync(out) && statSync(out).size > 1000) {
    try { const j = JSON.parse(readFileSync(out, "utf8")); if (j.features?.length) return "cached"; } catch { /* retrain */ }
  }
  const args = trainArgs(dbPath, job.season, job.features, out);
  const once = () => new Promise((res, rej) => {
    execFile("uv", args, { cwd: REPO, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...SINGLE_THREAD } },
      (err, _so, se) => (err ? rej(new Error(String(se).slice(-1200))) : res()));
  });
  const t0 = Date.now();
  try { await once(); } catch (e) {
    // A shelled run can fail because a source file was mid-edit by another session. Wait and retry ONCE.
    log(outDir, `TRAIN ${job.arm}/${job.season} failed once: ${e.message.slice(-500)}`);
    await new Promise((r) => setTimeout(r, 60000));
    try { await once(); } catch (e2) {
      log(outDir, `TRAIN ${job.arm}/${job.season} FAILED TWICE: ${e2.message.slice(-500)}`);
      return "failed";
    }
  }
  log(outDir, `trained ${job.arm}/${job.season} in ${((Date.now() - t0) / 1000).toFixed(0)}s (${job.features.length}f)`);
  return "ran";
}

/**
 * VERIFY, and it is a POSITIVE CONTROL, not a formality. Reading an arm's fold artifacts back and
 * asserting `features` is EXACTLY the arm's list is the one check that distinguishes "this arm
 * measured the design without X" from "this arm silently reused a fold that still had X" -- and the
 * second is invisible in every number the report prints, because a stale fold produces a perfectly
 * well-formed CRPS. It checks the producer's own bytes, the way the season ledger's control 2 did.
 */
export function verifyFolds(outDir, arms) {
  const problems = [];
  for (const arm of arms) {
    if (arm.refused || arm.reuseFrom) continue;
    for (const yr of ALL_SEASONS) {
      const p = foldPath(outDir, arm.id, yr);
      if (!existsSync(p)) { problems.push(`${arm.id}/${yr}: missing`); continue; }
      let j;
      try { j = JSON.parse(readFileSync(p, "utf8")); } catch (e) { problems.push(`${arm.id}/${yr}: unreadable (${e.message})`); continue; }
      const got = (j.features ?? []).map((f) => f.name).sort().join(",");
      const want = [...arm.features].sort().join(",");
      if (got !== want) problems.push(`${arm.id}/${yr}: fitted [${got}] but the arm is [${want}]`);
      if (j.learner !== "gbm" || j.zeroModel !== "two-part") problems.push(`${arm.id}/${yr}: ${j.zeroModel}/${j.learner}, not the shipped two-part/gbm`);
      if (j.population !== "rostered" || (j.rowFilter ?? "season_line_pg") !== "in_population") problems.push(`${arm.id}/${yr}: wrong population contract`);
      if ((j.seasons ?? []).includes(yr)) problems.push(`${arm.id}/${yr}: the holdout season is in its own training list`);
    }
  }
  return problems;
}

/** Score one arm: `ff evaluate-weekly --json`, stdout streamed STRAIGHT TO A FILE.
 *  The predecessor of this driver captured stdout into a buffer and the run died on
 *  `Expected ',' or ']' after array element at position 2,000,000` -- a truncated pipe, not a bad
 *  arm. A `--json` result for 14 seasons is megabytes; nothing here ever holds it in a pipe buffer. */
export async function scoreArm(arm, outDir, dbPath, rosters) {
  const out = join(outDir, `${arm.id}.json`);
  if (existsSync(out)) {
    try { const j = JSON.parse(readFileSync(out, "utf8")); if (j.bySeason) return "cached"; } catch { /* rescore */ }
  }
  if (arm.refused) { writeFileSync(out.replace(/\.json$/, ".refused"), arm.refused); return "refused"; }
  const foldDir = join(outDir, "_folds", arm.reuseFrom ?? arm.id);
  const args = [
    "--import", "tsx", "src/ff.ts", "evaluate-weekly",
    // THE SEASON WINDOW IS EXPLICIT AND ENDS AT 2025. The 2026 rows are being rewritten by another
    // session while this study runs; naming the window rather than taking the default is what keeps
    // an arm from reading them.
    "--seasons", "2012-2025", "--train-seasons", "2012-2025",
    "--rosters", String(rosters),
    "--features", arm.features.join(","),
    // Every arm loads folds this driver already trained. `--reuse-artifacts` is what makes that a
    // LOAD rather than a refit; if a fold were missing the harness would retrain it here, which
    // `--verify` exists to make impossible.
    "--keep-artifacts", foldDir, "--reuse-artifacts",
    "--json",
    // A `VACUUM INTO` SNAPSHOT, not the live store: a study whose arms are spread over hours cannot
    // read a database another session is writing.
    ...(dbPath ? ["--db", dbPath] : []),
    ...(arm.mask?.length ? ["--mask-serve", arm.mask.join(",")] : []),
  ];
  const t0 = Date.now();
  const once = () => new Promise((res, rej) => {
    const tmp = out + ".part";
    const fh = createWriteStream(tmp);
    const cp = spawn(process.execPath, args, { cwd: REPO });
    let err = "";
    cp.stdout.pipe(fh);
    cp.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    cp.on("error", rej);
    cp.on("close", (code) => fh.end(() => {
      if (code !== 0) return rej(new Error(`exit ${code}: ${err}`));
      try {
        const j = JSON.parse(readFileSync(tmp, "utf8"));
        if (!j.bySeason) return rej(new Error("no bySeason in the result"));
        writeFileSync(out, readFileSync(tmp));
        res();
      } catch (e) { rej(new Error(`unparseable result: ${e.message}`)); }
    }));
  });
  try { await once(); } catch (e) {
    log(outDir, `SCORE ${arm.id} failed once: ${String(e.message).slice(-600)}`);
    await new Promise((r) => setTimeout(r, 60000));
    try { await once(); } catch (e2) {
      log(outDir, `SCORE ${arm.id} FAILED TWICE: ${String(e2.message).slice(-600)}`);
      return "failed";
    }
  }
  log(outDir, `scored ${arm.id} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return "ran";
}

// ---- REPORT ---------------------------------------------------------------------------------

/** Map<season, pooled CRPS of the `weekly` model> out of one arm JSON. Same reader as
 *  scripts/weekly-paired-floor.mjs's `crpsBySeason`, on the same field. */
export function crpsBySeason(ev, model = "weekly") {
  const m = new Map();
  for (const [y, byModel] of Object.entries(ev.bySeason ?? {})) {
    const s = byModel?.[model];
    if (s && Number.isFinite(s.crps)) m.set(Number(y), s.crps);
  }
  return m;
}

/**
 * The contribution of whatever an arm dropped: CRPS(ablated) - CRPS(full), so POSITIVE means the
 * dropped thing was CARRYING something. Built by handing `admissionVerdict` the FULL arm as the
 * candidate and the ABLATED arm as the baseline, which is exactly its improvement = base - cand.
 * Nothing about the floor rule is re-implemented here.
 */
export function contribution(fullM, armM, seasons) {
  const ys = seasons.filter((y) => fullM.has(y) && armM.has(y));
  if (ys.length < 3) return null;
  return { ...admissionVerdict(fullM, armM, ys), seasons: ys };
}

/** DEGENERACY CONTROL. Two arms whose per-season CRPS agree to the last bit are not a zero effect,
 *  they are the same run twice -- the lever is disconnected. Reported as its own verdict. */
export function isDegenerate(fullM, armM, seasons) {
  const ys = seasons.filter((y) => fullM.has(y) && armM.has(y));
  return ys.length > 0 && ys.every((y) => Math.abs(fullM.get(y) - armM.get(y)) < 1e-12);
}

/** One character per season, oldest first: the sign of the per-season contribution. */
export function signs(fullM, armM, seasons) {
  return seasons.map((y) => {
    if (!fullM.has(y) || !armM.has(y)) return " ";
    const d = armM.get(y) - fullM.get(y);
    return Math.abs(d) < 1e-9 ? "0" : d > 0 ? "+" : "-";
  }).join("");
}

export function lineupOf(ev) {
  const out = {};
  for (const [scen, byModel] of Object.entries(ev.lineup ?? {})) {
    if (byModel?.weekly) out[scen] = byModel.weekly.meanCaptured;
  }
  return out;
}

function fmt(x, d = 5) { return Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "NA"; }

function report(outDir) {
  const arms = buildArms();
  const load = (id) => {
    const p = join(outDir, `${id}.json`);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
  };
  const fullEv = load("full");
  if (!fullEv) { console.error("no full arm in " + outDir); process.exit(1); }
  const fullM = crpsBySeason(fullEv);
  const fullLineup = lineupOf(fullEv);

  const rows = new Map();
  for (const arm of arms) {
    if (arm.id === "full") continue;
    const ev = load(arm.id);
    if (!ev) { rows.set(arm.id, { arm, missing: true }); continue; }
    const m = crpsBySeason(ev);
    rows.set(arm.id, {
      arm, m,
      sel: contribution(fullM, m, SELECTION),
      hold: contribution(fullM, m, HOLDOUT),
      all: contribution(fullM, m, ALL_SEASONS),
      degenerate: isDegenerate(fullM, m, ALL_SEASONS),
      signs: signs(fullM, m, ALL_SEASONS),
      lineup: lineupOf(ev),
    });
  }

  const verdictOf = (r) => (r.degenerate ? "DEGENERATE" : r.sel.pass ? "KEEP" : r.sel.improvement <= 0 ? "DROP (negative)" : "DROP (sub-floor)");
  const table = (title, kinds) => {
    const sub = [...rows.values()].filter((r) => kinds.includes(r.arm.kind));
    console.log(`\n## ${title}\n`);
    console.log("| arm | contribution (sel 2012-2020) | SE | floor 2.9*SE | wins/9 | verdict | holdout 2021-2025 | all 14 | signs 2012..2025 |");
    console.log("|---|---|---|---|---|---|---|---|---|");
    for (const r of sub) {
      if (r.missing) { console.log(`| ${r.arm.id} | ${r.arm.refused ? "REFUSED -- " + r.arm.refused : "(not run)"} | | | | | | | |`); continue; }
      const s = r.sel, h = r.hold, a = r.all;
      console.log(`| ${r.arm.id} | ${fmt(s.improvement)} | ${s.se.toFixed(5)} | ${s.floor.toFixed(5)} | ${s.wins}/${s.nSeasons} | ${verdictOf(r)} | ${fmt(h.improvement)} (${h.wins}/${h.nSeasons}) | ${fmt(a.improvement)} (${a.wins}/${a.nSeasons}) | ${r.signs} |`);
    }
    return sub;
  };

  console.log(`# weekly contribution ledger -- ${outDir}`);
  console.log(`\nfull arm per-season CRPS: ${[...fullM.entries()].map(([y, v]) => `${y} ${v.toFixed(4)}`).join(", ")}`);
  console.log(`full arm pooled CRPS: ${fullEv.pooled?.weekly?.crps?.toFixed(5)}  lineup: ${JSON.stringify(fullLineup)}`);

  // THE DEGENERACY POSITIVE CONTROL, read before anything else.
  const dup = rows.get("full_dup");
  if (dup && !dup.missing) {
    const worst = Math.max(...ALL_SEASONS.filter((y) => dup.m.has(y)).map((y) => Math.abs(dup.m.get(y) - fullM.get(y))));
    console.log(`\nDEGENERACY POSITIVE CONTROL (full re-scored): ${dup.degenerate ? "DEGENERATE as required" : "NOT DEGENERATE -- THE LEDGER IS VOID"} (largest per-season |delta| ${worst.toExponential(2)})`);
  } else {
    console.log("\nDEGENERACY POSITIVE CONTROL: not run.");
  }

  const loo = table("LEAVE-ONE-OUT (retrained; positive = the feature carries something)", ["loo"]);
  table("LEAVE-FAMILY-OUT (retrained)", ["famloo"]);
  table("SERVE-TIME MASK (fit-with, serve-without; NOT a training-time ablation)", ["mask", "maskfam"]);

  // Knock-in is reported against the FLOOR arm, not against the full arm.
  const floorEv = load("knockin__floor");
  if (floorEv) {
    const floorM = crpsBySeason(floorEv);
    console.log("\n## KNOCK-IN FROM THE FLOOR (floor = line + the four required columns)\n");
    console.log(`floor arm per-season CRPS: ${[...floorM.entries()].map(([y, v]) => `${y} ${v.toFixed(4)}`).join(", ")}`);
    console.log("\n| family | gain over floor (sel) | SE | floor 2.9*SE | wins/9 | verdict | holdout | all 14 | signs |");
    console.log("|---|---|---|---|---|---|---|---|---|");
    for (const arm of arms.filter((x) => x.kind === "knockin" && x.id !== "knockin__floor")) {
      const ev = load(arm.id); if (!ev) { console.log(`| ${arm.family} | (not run) | | | | | | | |`); continue; }
      const m = crpsBySeason(ev);
      const s = contribution(m, floorM, SELECTION), h = contribution(m, floorM, HOLDOUT), a = contribution(m, floorM, ALL_SEASONS);
      console.log(`| ${arm.family} | ${fmt(s.improvement)} | ${s.se.toFixed(5)} | ${s.floor.toFixed(5)} | ${s.wins}/${s.nSeasons} | ${s.pass ? "ADMIT" : "sub-floor"} | ${fmt(h.improvement)} (${h.wins}/${h.nSeasons}) | ${fmt(a.improvement)} | ${signs(m, floorM, ALL_SEASONS)} |`);
    }
  }

  // FAMILY-WIDE FDR (WS4) across the retrained LOO rows -- 21 simultaneous tests against one shared
  // baseline is a family, and the per-row floor controls each test in isolation only. The serve-mask
  // rows are NOT members: they are a different quantity measured on the same folds.
  const fam = loo.filter((r) => !r.missing && r.sel);
  if (fam.length) {
    const ps = fam.map((r) => normalSf(r.sel.t));
    const { q } = familyAdjust(ps);
    console.log(`\n## FAMILY-WIDE FDR over the ${fam.length} retrained leave-one-out rows (BH, one-sided)\n`);
    console.log("| arm | t (sel) | p | BH q | survives q<=0.10 |");
    console.log("|---|---|---|---|---|");
    fam.forEach((r, i) => console.log(`| ${r.arm.id} | ${r.sel.t.toFixed(2)} | ${ps[i].toExponential(2)} | ${q[i].toExponential(2)} | ${q[i] <= 0.1 ? "yes" : "no"} |`));
  }

  // THE DECISION LAYER. A CRPS drop that moves no lineup is a curiosity: `meanCaptured` is the points
  // the weekly model's chosen lineup actually scored, averaged over the drawn rosters.
  console.log("\n## DECISION LAYER -- lineup regret (mean captured points, weekly model)\n");
  const scen = Object.keys(fullLineup);
  console.log(`| arm | ${scen.map((s) => `${s} | delta`).join(" | ")} |`);
  console.log(`|---|${scen.map(() => "---|---|").join("")}`);
  console.log(`| full | ${scen.map((s) => `${fullLineup[s].toFixed(3)} | 0.000`).join(" | ")} |`);
  for (const r of rows.values()) {
    if (r.missing || !Object.keys(r.lineup).length) continue;
    console.log(`| ${r.arm.id} | ${scen.map((s) => `${r.lineup[s]?.toFixed(3) ?? "NA"} | ${(r.lineup[s] - fullLineup[s]).toFixed(3)}`).join(" | ")} |`);
  }
}

// ---- CLI ------------------------------------------------------------------------------------

const MODES = ["--plan", "--train", "--verify", "--score", "--report"];
// ONLY when this file is the entry point. scripts/weekly-drop-screen.mjs IMPORTS the plumbing
// below so its arms are trained and scored by character-identical invocations; without this
// guard a mode flag in the IMPORTER's argv would make this module run its own study too.
const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (IS_MAIN && process.argv.slice(2).some((a) => MODES.includes(a))) {
  const argv = process.argv.slice(2);
  const v = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const outDir = v("--out-dir", null);
  const only = v("--only", null);
  const armsAll = buildArms();
  const arms = armsAll.filter((a) => !only || new RegExp(only).test(a.id));
  if (argv.includes("--plan")) {
    for (const a of armsAll) console.log(`${a.id}\t${a.kind}\t${a.features.length}f\t${a.refused ? "REFUSED: " + a.refused : a.label}`);
    const trained = armsAll.filter((a) => !a.refused && !a.reuseFrom);
    console.log(`\n${trained.length} trained arms x ${ALL_SEASONS.length} folds = ${foldJobs(armsAll).length} fold trainings, ` +
      `${armsAll.filter((a) => a.reuseFrom).length} fold-reusing score-only arms, ` +
      `${armsAll.filter((a) => a.refused).length} refused by the two-part contract`);
  } else if (!outDir) {
    console.error("that mode needs --out-dir"); process.exit(1);
  } else if (argv.includes("--train")) {
    mkdirSync(outDir, { recursive: true });
    const db = v("--db", null);
    if (!db) { console.error("--train needs --db (a VACUUM INTO snapshot)"); process.exit(1); }
    // CONCURRENCY. One fold is SINGLE-CORE bound (measured: 4m44s with 32 cores free, 5m25s with
    // OMP_NUM_THREADS=1), so N folds in flight use ~N of 32 cores and do not oversubscribe. Every job
    // reads the same snapshot and writes only its own artifact, so there is no shared writer either.
    const conc = Math.max(1, Number(v("--concurrency", "24")));
    const jobs = foldJobs(arms);
    log(outDir, `TRAIN: ${jobs.length} folds, concurrency ${conc}, db ${db}`);
    let done = 0;
    await runPool(jobs, conc, async (j) => {
      const st = await trainFold(j, outDir, db);
      log(outDir, `  (${++done}/${jobs.length}) ${j.arm}/${j.season}: ${st}`);
    });
  } else if (argv.includes("--verify")) {
    const problems = verifyFolds(outDir, arms);
    if (!problems.length) console.log(`VERIFY OK: every fold of ${arms.filter((a) => !a.refused && !a.reuseFrom).length} trained arms carries exactly its arm's feature list, two-part/gbm, rostered/in_population, holdout excluded.`);
    else { console.error(`VERIFY FAILED (${problems.length}):`); for (const p of problems) console.error("  " + p); process.exit(1); }
  } else if (argv.includes("--score")) {
    mkdirSync(outDir, { recursive: true });
    const db = v("--db", null);
    const rosters = Number(v("--rosters", "300"));
    const conc = Math.max(1, Number(v("--concurrency", "6")));
    // PHASES, ordered by dependency: `full` first (its folds are what every mask arm reuses -- and
    // they are already trained, so this is only its scoring pass), then everything else.
    const first = arms.filter((a) => a.id === "full");
    const rest = arms.filter((a) => a.id !== "full" && a.kind !== "control");
    // The CONTROL arm is scored LAST, on purpose and alone. `src/weekly/**` is being edited by
    // another session while these arms run, and a mid-study change to the scoring path would make an
    // early arm and a late arm two different experiments whose difference reads as a contribution.
    // `full_dup` re-scores the FIRST arm's own folds at the END: if it is not bit-identical to
    // `full`, the harness moved under the study and the ledger says so instead of printing a table.
    const last = arms.filter((a) => a.kind === "control");
    log(outDir, `SCORE: ${arms.length} arms, concurrency ${conc}, rosters ${rosters}`);
    for (const a of first) log(outDir, `  ${a.id}: ${await scoreArm(a, outDir, db, rosters)}`);
    let done = 0;
    await runPool(rest, conc, async (a) => {
      const st = await scoreArm(a, outDir, db, rosters);
      log(outDir, `  (${++done}/${rest.length}) ${a.id}: ${st}`);
    });
    for (const a of last) log(outDir, `  ${a.id} (control, last): ${await scoreArm(a, outDir, db, rosters)}`);
  } else {
    report(outDir);
  }
}
