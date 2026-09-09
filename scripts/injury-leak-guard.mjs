#!/usr/bin/env node
/**
 * `node --import tsx scripts/injury-leak-guard.mjs [--season 2019] [--cut 8]`
 *
 * THE POINT-IN-TIME GUARD FOR feat_injury_horizon, WITH ITS OWN FAULT INJECTION.
 *
 * A leakage check that only ever runs against correct code is indistinguishable from a check that
 * cannot fail. This repo has the scar in four layers (docs/validation.md, Track B). So the script
 * runs FOUR builds of the same season against a scratch copy of the store and asserts three things,
 * the third of which is the only one that proves the first two mean anything:
 *
 *   A  NEGATIVE, designations.  Rewrite every raw_injury filing for weeks AFTER the cut to "Out /
 *      Did Not Participate". No FEATURE of any row at or before the cut may move. If the builder
 *      ever read the following week's report -- the single most natural way to write this bug --
 *      this is what would catch it.
 *
 *   B  POSITIVE, targets.  Rewrite the PLAY RECORD after the cut (feat_player_week.pts -> NULL, i.e.
 *      he missed every remaining game). The TARGETS at or before the cut MUST move -- miss_next_2/3/4
 *      look forward by construction -- while the features still must not. A guard whose positive
 *      control never fires is measuring nothing, and this is the half of the pair that proves the
 *      target columns are connected to the play record at all.
 *
 *   C  FAULT INJECTION.  Re-run perturbation A against the builder's `leakNextWeekDesignation`
 *      flag, which deliberately reads each week's designation from the FOLLOWING week's report. The
 *      features at or before the cut MUST now move. If they do not, check A is inert and every
 *      green run of it has been meaningless.
 *
 * Exit code 0 = all three held. Non-zero names the one that did not.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { buildInjuryDuration } from "../src/features/sources/injuryDuration.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : d; };
const SEASON = Number(arg("--season", "2019"));
const CUT = Number(arg("--cut", "8"));
const DIR = "data/tmp-injury-leak";
const SCRATCH = `${DIR}/ff-leak.db`;

const FEATURES = [
  "as_of", "team", "pos", "episode_start_week", "injury_primary", "injury_group",
  "injury_secondary_present", "designation", "practice_status", "weeks_in_episode",
  "weeks_missed_so_far", "prior_episodes_same", "prior_episodes_any", "age",
];
const TARGETS = ["miss_next_1", "miss_next_2", "miss_next_3", "miss_next_4", "games_remaining"];

function freshScratch() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const src = new Database("data/ff.db", { readonly: true });
  // VACUUM INTO produces a single consistent file with no WAL sidecars, which matters because the
  // scratch build must not be able to reach back into the real store's write-ahead log.
  src.prepare(`VACUUM INTO '${SCRATCH.replace(/'/g, "''")}'`).run();
  src.close();
}

/** (week|player_sk) -> the row, restricted to weeks at or before the cut. */
function snapshot() {
  const db = new Database(SCRATCH, { readonly: true });
  const rows = db.prepare(
    `SELECT * FROM feat_injury_horizon WHERE season = ? AND week <= ? ORDER BY player_sk, week`,
  ).all(SEASON, CUT);
  db.close();
  const m = new Map();
  for (const r of rows) m.set(`${r.player_sk}|${r.week}`, r);
  return m;
}

/** How many (row, column) cells differ, over the columns given. A row present in one snapshot and
 *  absent from the other counts as one difference per column -- a leak that DELETES rows is still a
 *  leak, and a set comparison that ignored it would report zero. */
function diffCells(a, b, cols) {
  let n = 0;
  const keys = new Set([...a.keys(), ...b.keys()]);
  const examples = [];
  for (const k of keys) {
    const ra = a.get(k), rb = b.get(k);
    for (const c of cols) {
      const va = ra ? ra[c] : undefined, vb = rb ? rb[c] : undefined;
      if (va !== vb && !(va == null && vb == null)) {
        n++;
        if (examples.length < 4) examples.push(`${k} ${c}: ${JSON.stringify(va)} -> ${JSON.stringify(vb)}`);
      }
    }
  }
  return { n, examples };
}

function build(opts = {}) {
  buildInjuryDuration({ dbPath: SCRATCH, seasons: [SEASON - 2, SEASON - 1, SEASON], ...opts });
  return snapshot();
}

function perturbDesignations() {
  const db = new Database(SCRATCH);
  const r = db.prepare(
    `UPDATE raw_injury SET report_status = 'Out', practice_status = 'Did Not Participate In Practice',
       report_primary_injury = 'Achilles', practice_primary_injury = 'Achilles'
     WHERE season = ? AND week > ?`,
  ).run(SEASON, CUT);
  db.close();
  return r.changes;
}

function perturbPlayRecord() {
  const db = new Database(SCRATCH);
  const r = db.prepare(
    "UPDATE feat_player_week SET pts = NULL WHERE season = ? AND week > ? AND is_bye = 0",
  ).run(SEASON, CUT);
  db.close();
  return r.changes;
}

let failed = null;
const say = (ok, label, detail) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${label}${detail ? " -- " + detail : ""}`);
  if (!ok && !failed) failed = label;
};

console.log(`INJURY HORIZON LEAK GUARD -- season ${SEASON}, cut after week ${CUT}`);
console.log(`  scratch store: ${SCRATCH} (a VACUUM INTO copy; the real store is never written)`);

// ---- baseline -------------------------------------------------------------------------------
freshScratch();
const base = build();
console.log(`\n  baseline: ${base.size} horizon rows at weeks 1-${CUT} of ${SEASON}`);
if (base.size < 100) { console.log("  REFUSING: too few rows to be a test."); process.exit(3); }

// ---- A: perturb the designations after the cut ------------------------------------------------
console.log("\nA  NEGATIVE CONTROL: every filing after the cut rewritten to Out/DNP/Achilles");
const nA = perturbDesignations();
console.log(`   ${nA} raw_injury rows rewritten`);
const afterA = build();
const fA = diffCells(base, afterA, FEATURES);
say(fA.n === 0, "no FEATURE at or before the cut moved", fA.n ? `${fA.n} cells moved: ${fA.examples.join("; ")}` : `${FEATURES.length} columns x ${base.size} rows unchanged`);
const tA = diffCells(base, afterA, TARGETS);
say(tA.n === 0, "no TARGET moved either (the play record was untouched)", tA.n ? `${tA.n} cells: ${tA.examples.join("; ")}` : "as expected");

// ---- C: the SAME perturbation, with the leak deliberately switched on --------------------------
// Run before B so it uses the same perturbed store: the fault injection must be against the exact
// input check A passed on, or it is testing a different thing.
console.log("\nC  FAULT INJECTION: the same store, built with leakNextWeekDesignation = true");
const afterC = build({ leakNextWeekDesignation: true });
const fC = diffCells(base, afterC, FEATURES);
say(fC.n > 0, "the leak MOVES features at or before the cut, so check A can fail", `${fC.n} cells moved: ${fC.examples.slice(0, 2).join("; ")}`);

// ---- B: perturb the play record after the cut --------------------------------------------------
console.log("\nB  POSITIVE CONTROL: the play record after the cut rewritten to `did not play`");
freshScratch();
const base2 = build();
const nB = perturbPlayRecord();
console.log(`   ${nB} feat_player_week rows set to pts = NULL`);
const afterB = build();
const fB = diffCells(base2, afterB, FEATURES);
say(fB.n === 0, "still no FEATURE at or before the cut moved", fB.n ? `${fB.n} cells: ${fB.examples.join("; ")}` : "unchanged");
const tB = diffCells(base2, afterB, TARGETS);
say(tB.n > 0, "the TARGETS at or before the cut DID move", `${tB.n} cells moved: ${tB.examples.slice(0, 2).join("; ")}`);

rmSync(DIR, { recursive: true, force: true });
console.log(existsSync(DIR) ? "\n  (scratch dir left behind)" : "\n  scratch removed");
if (failed) { console.log(`\nLEAK GUARD FAILED: ${failed}`); process.exit(1); }
console.log("\nLEAK GUARD HELD: features are blind after the cut, targets are not, and the guard can fail.");
