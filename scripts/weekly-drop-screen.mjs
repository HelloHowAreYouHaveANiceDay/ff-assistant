// THE WEEKLY DROP SCREEN (D30) -- does the served weekly design still need `inj_feed`, and does it
// still need the five droppable usage columns?
//
// WHY THIS EXISTS. docs/weekly-contribution-ledger-2026-09-16.md (M2g) ended with exactly two DROP
// candidates and an explicit refusal to act on them:
//
//   1. `inj_feed` -- a CONSTANT 1 across the fitted population plus a missingness pattern. Its
//      leave-one-out arm and its serve-mask arm both reproduced the full design BIT FOR BIT on all
//      fourteen seasons. Not a small contribution: a proof of none.
//   2. the five droppable usage columns `td_fd`, `td_ts`, `td_attempts`, `td_rush_yards`,
//      `prior_route_share`, as a JOINT selection of five -- leave-family-out +0.00131 +/- 0.00147
//      (4/9) inside its 0.00425 floor, holdout +0.00472 (4/5) also inside, and lineup regret
//      fractionally BETTER without them.
//
// Both were measured on the 25-column pre-D27 design. D27 then promoted `ecr_wk_rank`/`ecr_wk_sd`,
// so the served design is 27 and a DROP verdict on the old one is a claim about a model nobody is
// served (CLAUDE.md: re-measure a candidate against the baseline you intend to SHIP). This screen
// re-measures both drops against the 27-column design, as two arms:
//
//   cand26  = the served 27 minus `inj_feed`
//   cand21  = cand26 minus the five droppable usage columns
//
// THE ASYMMETRY THIS SCREEN EXISTS TO RESOLVE, and it is the ledger's own biggest finding. `usage` is
// the CHEAPEST family to remove from the design (+0.0013, inside the floor) and the MOST EXPENSIVE to
// lose at serve (+0.3995, 3x the next family). Those are not in conflict -- a leave-one-out measures
// REDUNDANCY, a serve mask measures RELIANCE -- but they pull opposite ways on the decision, so the
// screen measures BOTH for every design and reports them side by side. A design that never fits a
// column cannot be hurt by that column's feed dying on a Sunday; the question is whether the columns
// it KEEPS become more load-bearing as a result. So every mask block below is drawn from the 21
// columns ALL THREE designs share, which is the only way the three mask costs are comparable.
//
// A DROP HOLDS ONLY IF REMOVING COSTS LESS THAN THE FLOOR. The statistic is the repo's paired-season
// 2.9*SE floor (scripts/lib/arbiter.mjs `admissionVerdict`, the same one scripts/weekly-paired-floor.mjs
// applies), the unit of analysis is the SEASON, the decision block is 2012-2020 and the holdout
// 2021-2025 confirms. Nothing here re-implements a statistic and nothing here writes to data/.
//
// THE PLUMBING IS IMPORTED, NOT COPIED. `trainFold`/`scoreArm`/`trainArgs` come from
// scripts/weekly-contribution-ledger.mjs, so the trainer invocation is character-for-character the one
// `src/weekly/evaluate.ts`'s `trainHoldout` issues and the arms are scored by the same
// `ff evaluate-weekly --keep-artifacts <dir> --reuse-artifacts --json` call the ledger used.
//
// USAGE:
//   node --import tsx scripts/weekly-drop-screen.mjs --arms
//   node --import tsx scripts/weekly-drop-screen.mjs --fit    --out-dir <dir> --db <snapshot> [--concurrency N]
//   node --import tsx scripts/weekly-drop-screen.mjs --check   --out-dir <dir>
//   node --import tsx scripts/weekly-drop-screen.mjs --measure --out-dir <dir> --db <snapshot> [--concurrency N] [--rosters 300]
//   node --import tsx scripts/weekly-drop-screen.mjs --table   --out-dir <dir>
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SHIPPED, ALL_SEASONS, ordered, twoPartFeasible, runPool, trainFold, scoreArm, log,
  crpsBySeason, contribution, isDegenerate, signs, lineupOf, foldPath,
} from "./weekly-contribution-ledger.mjs";

/** The dead column (M2g section 1): one distinct non-null value in every fitted season. */
export const DEAD = ["inj_feed"];

/** The five usage columns the two-part contract PERMITS dropping. `prior_snap_share` and `depth_rank`
 *  are the other two members of the usage family and are REQUIRED by the trainer's availability
 *  guard, so they stay in every arm -- which is also why they are in the shared mask blocks below. */
export const USAGE5 = ["td_fd", "td_ts", "td_attempts", "td_rush_yards", "prior_route_share"];

export const DESIGNS = [
  { id: "served27", features: ordered(SHIPPED), label: "the served design (D27)" },
  { id: "cand26", features: ordered(SHIPPED.filter((f) => !DEAD.includes(f))), label: "served minus inj_feed" },
  { id: "cand21", features: ordered(SHIPPED.filter((f) => ![...DEAD, ...USAGE5].includes(f))), label: "served minus inj_feed and the five droppable usage columns" },
];

/**
 * THE SHARED MASK BLOCKS. Every column here is in ALL THREE designs, so "what does this design lose
 * on a Sunday this block is dark" is the same question asked of three models rather than three
 * different questions. `usage5` is the exception and is deliberately NOT in this list: it exists only
 * for the two designs that fit it, and its whole point is that cand21 CANNOT have that exposure.
 */
export const SHARED_MASKS = {
  level: ["season_line_pg"],
  form: ["td_ppg", "t4_mean", "t4_sd", "td_games"],
  usage2: ["prior_snap_share", "depth_rank"],
  avail6: ["inj_out", "inj_doubtful", "inj_questionable", "prac_dnp", "prac_limited", "teammates_out"],
  context: ["spread_line", "total_line", "implied_team_total", "days_rest", "home", "week_no"],
  ecr: ["ecr_wk_rank", "ecr_wk_sd"],
};

const SELECTION = [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020];
const HOLDOUT = [2021, 2022, 2023, 2024, 2025];

export function buildArms() {
  const arms = [];
  for (const d of DESIGNS) {
    if (!twoPartFeasible(d.features)) throw new Error(`${d.id} violates the two-part contract`);
    arms.push({ id: d.id, kind: "design", features: d.features, label: `${d.label} (${d.features.length}f)` });
  }
  for (const d of DESIGNS) {
    for (const [blk, cols] of Object.entries(SHARED_MASKS)) {
      arms.push({
        id: `${d.id}__mask__${blk}`, kind: "mask", design: d.id, block: blk,
        features: d.features, mask: cols, reuseFrom: d.id,
        label: `${d.id}: serve-mask ${blk} (${cols.length})`,
      });
    }
  }
  // The exposure cand21 does not have. Measured on the two designs that fit those columns, so the
  // "fewer feeds to fail on a Sunday" claim is a number rather than an argument.
  for (const d of DESIGNS) {
    if (!USAGE5.every((c) => d.features.includes(c))) continue;
    arms.push({
      id: `${d.id}__mask__usage5`, kind: "mask", design: d.id, block: "usage5",
      features: d.features, mask: USAGE5, reuseFrom: d.id,
      label: `${d.id}: serve-mask the five droppable usage columns`,
    });
  }
  // THE DEGENERACY POSITIVE CONTROL, scored LAST and alone. `served27` re-scored with an EMPTY mask
  // must come back bit-identical; if it does not, the harness moved under the study and no delta in
  // this screen is a design's contribution. It is also the only thing that proves `isDegenerate` can
  // return TRUE against a real pair of runs rather than against a fixture.
  arms.push({ id: "served27_dup", kind: "control", features: DESIGNS[0].features, mask: [], reuseFrom: "served27", label: "served27 re-scored (degeneracy control)" });
  return arms;
}

export function foldJobs(arms) {
  const jobs = [];
  for (const a of arms) {
    if (a.reuseFrom) continue;
    for (const yr of ALL_SEASONS) jobs.push({ arm: a.id, season: yr, features: a.features });
  }
  return jobs;
}

/** The same positive control the ledger's `--verify` is: read every fold artifact back and assert it
 *  fitted EXACTLY its arm's list. A stale or mis-targeted fold produces a perfectly well-formed CRPS
 *  and is invisible in every number this screen prints. */
export function verifyFolds(outDir, arms) {
  const problems = [];
  for (const a of arms) {
    if (a.reuseFrom) continue;
    for (const yr of ALL_SEASONS) {
      const p = foldPath(outDir, a.id, yr);
      if (!existsSync(p)) { problems.push(`${a.id}/${yr}: missing`); continue; }
      let j;
      try { j = JSON.parse(readFileSync(p, "utf8")); } catch (e) { problems.push(`${a.id}/${yr}: unreadable (${e.message})`); continue; }
      const got = (j.features ?? []).map((f) => f.name).sort().join(",");
      const want = [...a.features].sort().join(",");
      if (got !== want) problems.push(`${a.id}/${yr}: fitted [${got}] but the arm is [${want}]`);
      if (j.learner !== "gbm" || j.zeroModel !== "two-part") problems.push(`${a.id}/${yr}: ${j.zeroModel}/${j.learner}, not the shipped two-part/gbm`);
      if (j.population !== "rostered" || (j.rowFilter ?? "season_line_pg") !== "in_population") problems.push(`${a.id}/${yr}: wrong population contract`);
      if ((j.seasons ?? []).includes(yr)) problems.push(`${a.id}/${yr}: the holdout season is in its own training list`);
    }
  }
  return problems;
}

const fmt = (x, d = 5) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "NA");

function gateLine(ev) {
  const g = ev.gate;
  if (!g) return "no gate block";
  return `${g.passed ? "PASSED" : "FAILED"} [` + (g.clauses ?? []).map((c) => `${c.id}:${c.passed ? "pass" : "FAIL"}`).join(" ") + "]";
}
function gateDetail(ev) {
  return (ev.gate?.clauses ?? []).map((c) => `(${c.id}) ${c.passed ? "PASS" : "FAIL"} -- ${c.evidence}`);
}

function table(outDir) {
  const arms = buildArms();
  const load = (id) => { const p = join(outDir, `${id}.json`); if (!existsSync(p)) return null; try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

  const base = load("served27");
  if (!base) { console.error("no served27 arm in " + outDir); process.exit(1); }
  const baseM = crpsBySeason(base), baseL = lineupOf(base);

  console.log(`# WEEKLY DROP SCREEN (D30) -- ${outDir}\n`);
  const dup = load("served27_dup");
  if (dup) {
    const m = crpsBySeason(dup);
    const worst = Math.max(...ALL_SEASONS.filter((y) => m.has(y)).map((y) => Math.abs(m.get(y) - baseM.get(y))));
    console.log(`DEGENERACY POSITIVE CONTROL (served27 re-scored): ${isDegenerate(baseM, m, ALL_SEASONS) ? "DEGENERATE as required" : "NOT DEGENERATE -- THE SCREEN IS VOID"} (largest per-season |delta| ${worst.toExponential(2)})\n`);
  } else console.log("DEGENERACY POSITIVE CONTROL: not run.\n");

  console.log("## 1. THE DESIGNS -- pooled CRPS, and the cost of the drop\n");
  console.log(`served27 per-season CRPS: ${[...baseM.entries()].map(([y, v]) => `${y} ${v.toFixed(4)}`).join(", ")}`);
  console.log(`served27 pooled CRPS ${base.pooled?.weekly?.crps?.toFixed(5)}  gate ${gateLine(base)}  lineup ${JSON.stringify(baseL)}\n`);
  console.log("| design | f | cost of the drop (sel 2012-2020) | SE | floor 2.9*SE | wins/9 | verdict | holdout 2021-2025 | all 14 | signs |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const d of DESIGNS.slice(1)) {
    const ev = load(d.id); if (!ev) { console.log(`| ${d.id} | ${d.features.length} | (not run) | | | | | | | |`); continue; }
    const m = crpsBySeason(ev);
    const s = contribution(baseM, m, SELECTION), h = contribution(baseM, m, HOLDOUT), a = contribution(baseM, m, ALL_SEASONS);
    const deg = isDegenerate(baseM, m, ALL_SEASONS);
    // A DROP HOLDS when removing costs LESS than the floor: `pass` here means the removal was
    // RESOLVABLE, i.e. the column was carrying something, i.e. the drop FAILS.
    const verdict = deg ? "DROP (degenerate -- bit-identical)" : s.pass ? "KEEP (the drop costs more than the floor)" : "DROP (cost inside the floor)";
    console.log(`| ${d.id} | ${d.features.length} | ${fmt(s.improvement)} | ${s.se.toFixed(5)} | ${s.floor.toFixed(5)} | ${s.wins}/${s.nSeasons} | ${verdict} | ${fmt(h.improvement)} (${h.wins}/${h.nSeasons}) | ${fmt(a.improvement)} | ${signs(baseM, m, ALL_SEASONS)} |`);
  }

  console.log("\n## 2. THE GATE, clause by clause\n");
  for (const d of DESIGNS) {
    const ev = load(d.id); if (!ev) continue;
    console.log(`**${d.id}** (${d.features.length}f): ${gateLine(ev)}`);
    for (const l of gateDetail(ev)) console.log(`  - ${l}`);
  }

  console.log("\n## 3. THE DECISION LAYER -- lineup regret (mean captured points, weekly model)\n");
  const scen = Object.keys(baseL);
  console.log(`| arm | ${scen.map((s) => `${s} | delta`).join(" | ")} |`);
  console.log(`|---|${scen.map(() => "---|---|").join("")}`);
  console.log(`| served27 | ${scen.map((s) => `${baseL[s].toFixed(3)} | 0.000`).join(" | ")} |`);
  for (const a of arms) {
    if (a.id === "served27") continue;
    const ev = load(a.id); if (!ev) continue;
    const L = lineupOf(ev);
    if (!Object.keys(L).length) continue;
    console.log(`| ${a.id} | ${scen.map((s) => `${L[s]?.toFixed(3) ?? "NA"} | ${(L[s] - baseL[s]).toFixed(3)}`).join(" | ")} |`);
  }

  console.log("\n## 4. THE SERVE-TIME MASK, per design -- what a dark feed costs each model\n");
  console.log("Each cell is CRPS(design, block masked on the scored rows) - CRPS(design), decision block,");
  console.log("so a LARGER number means that design leans harder on that block at serve time.\n");
  const blocks = [...Object.keys(SHARED_MASKS), "usage5"];
  console.log(`| block | ${DESIGNS.map((d) => `${d.id} (sel) | wins`).join(" | ")} |`);
  console.log(`|---|${DESIGNS.map(() => "---|---|").join("")}`);
  for (const blk of blocks) {
    const cells = DESIGNS.map((d) => {
      const dev = load(d.id), mev = load(`${d.id}__mask__${blk}`);
      if (!dev || !mev) return "n/a | ";
      const dm = crpsBySeason(dev), mm = crpsBySeason(mev);
      const s = contribution(dm, mm, SELECTION);
      return `${fmt(s.improvement)} | ${s.wins}/${s.nSeasons}`;
    });
    console.log(`| ${blk} | ${cells.join(" | ")} |`);
  }
  console.log("\n| block | " + DESIGNS.map((d) => `${d.id} holdout`).join(" | ") + " |");
  console.log(`|---|${DESIGNS.map(() => "---|").join("")}`);
  for (const blk of blocks) {
    const cells = DESIGNS.map((d) => {
      const dev = load(d.id), mev = load(`${d.id}__mask__${blk}`);
      if (!dev || !mev) return "n/a";
      const h = contribution(crpsBySeason(dev), crpsBySeason(mev), HOLDOUT);
      return `${fmt(h.improvement)} (${h.wins}/${h.nSeasons})`;
    });
    console.log(`| ${blk} | ${cells.join(" | ")} |`);
  }
}

const MODES = ["--arms", "--fit", "--check", "--measure", "--table"];
const argv = process.argv.slice(2);
if (argv.some((a) => MODES.includes(a))) {
  const v = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const outDir = v("--out-dir", null);
  const arms = buildArms();
  if (argv.includes("--arms")) {
    for (const a of arms) console.log(`${a.id}\t${a.kind}\t${a.features.length}f\t${a.mask?.length ? "mask " + a.mask.join(",") : ""}\t${a.label}`);
    console.log(`\n${arms.filter((a) => !a.reuseFrom).length} trained arms x ${ALL_SEASONS.length} folds = ${foldJobs(arms).length} fold trainings, ${arms.filter((a) => a.reuseFrom).length} fold-reusing score-only arms`);
  } else if (!outDir) {
    console.error("that mode needs --out-dir"); process.exit(1);
  } else if (argv.includes("--fit")) {
    mkdirSync(outDir, { recursive: true });
    const db = v("--db", null);
    if (!db) { console.error("--fit needs --db (a VACUUM INTO snapshot)"); process.exit(1); }
    const conc = Math.max(1, Number(v("--concurrency", "21")));
    const jobs = foldJobs(arms);
    log(outDir, `FIT: ${jobs.length} folds, concurrency ${conc}, db ${db}`);
    let done = 0;
    await runPool(jobs, conc, async (j) => { const st = await trainFold(j, outDir, db); log(outDir, `  (${++done}/${jobs.length}) ${j.arm}/${j.season}: ${st}`); });
  } else if (argv.includes("--check")) {
    const problems = verifyFolds(outDir, arms);
    if (!problems.length) console.log(`CHECK OK: every fold of ${arms.filter((a) => !a.reuseFrom).length} trained arms carries exactly its arm's feature list, two-part/gbm, rostered/in_population, holdout excluded.`);
    else { console.error(`CHECK FAILED (${problems.length}):`); for (const p of problems) console.error("  " + p); process.exit(1); }
  } else if (argv.includes("--measure")) {
    mkdirSync(outDir, { recursive: true });
    const db = v("--db", null);
    const rosters = Number(v("--rosters", "300"));
    const conc = Math.max(1, Number(v("--concurrency", "6")));
    const designs = arms.filter((a) => a.kind === "design");
    const rest = arms.filter((a) => a.kind === "mask");
    const last = arms.filter((a) => a.kind === "control");
    log(outDir, `MEASURE: ${arms.length} arms, concurrency ${conc}, rosters ${rosters}`);
    for (const a of designs) log(outDir, `  ${a.id}: ${await scoreArm(a, outDir, db, rosters)}`);
    let done = 0;
    await runPool(rest, conc, async (a) => { const st = await scoreArm(a, outDir, db, rosters); log(outDir, `  (${++done}/${rest.length}) ${a.id}: ${st}`); });
    for (const a of last) log(outDir, `  ${a.id} (control, last): ${await scoreArm(a, outDir, db, rosters)}`);
  } else {
    table(outDir);
  }
}
