// THE PER-FORMAT WEEKLY DESIGN SCREEN (D31) -- re-measure a format's weekly feature design against
// the design the ESPN serve actually carries, on the FORMAT's own rows, through the format's own gate.
//
// WHY. `docs/multi-format-design.md` (WP8) fitted the Yahoo format's weekly artifact with
// `--features all`, which at that moment was 27 columns INCLUDING `rz_share_td` and `prior_vol_cv` --
// two candidates the ESPN track SCREENED AND REJECTED -- and EXCLUDING the two `ecr_wk_*` columns the
// ESPN track has since promoted (D27). `--features all` is a moving set, so an artifact fitted on it
// is pinned to whatever the trainer happened to declare that day; WP16b removed that default from the
// ESPN path for exactly this reason. This screen asks the format the question the ESPN track asks
// itself: does THIS format's weekly model do better on the design the serve carries, or on the one it
// was accidentally handed?
//
// WHAT IS COMPARED. Two designs, each nested by season on the format's own `features.db`, scored by
// `ff evaluate-weekly --league <id>` -- which resolves the format, its rows, its season window and,
// decisively, its OWN ROSTER TEMPLATE (`scenariosForSlots`), so the decision metric is a lineup
// somebody in that league actually sets. The floor is not an arm: `evaluateWeekly` scores the
// season-line-only model and the shipped `week()` baseline on the same rows in the same invocation,
// which is what the pre-registered gate clauses (a)/(b)/(c) are computed against.
//
// THE UNIT OF ANALYSIS IS THE SEASON. Both arms hold out the same seasons and draw the same
// common-random-number rosters, so the per-season pooled CRPS deltas are matched pairs and go through
// scripts/lib/arbiter.mjs's 2.9*SE floor -- the same statistic scripts/weekly-paired-floor.mjs applies.
// Nothing here re-implements a statistic and nothing here writes to data/.
//
// THE TRAINER INVOCATION IS IMPORTED, not retyped: `trainArgs`/`trainFold` come from
// scripts/weekly-contribution-ledger.mjs and are character-for-character what `trainHoldout`
// (src/weekly/evaluate.ts) issues, so a fold trained here and a fold trained by the harness are the
// same fit. The SCORING call is local because it needs `--league`, which the incumbent-only ledger
// driver has no reason to pass.
//
// A DESIGN MAY BE NAMED BY ITS ARTIFACT (`@path/to/weekly-artifact.json`) rather than by a column
// list. That is the point: "the design the serve carries" is a fact about the served file, and
// retyping it is how a screen ends up measuring a design nobody serves.
//
// USAGE:
//   node --import tsx scripts/weekly-format-design-screen.mjs --arms \
//        --base '@data/formats/<key>/weekly-artifact.json' --cand '@data/weekly-artifact.json'
//   ... --fit --out-dir <dir> --features-db <path> [--concurrency N] [--seasons 2012-2025]
//   ... --check --out-dir <dir>
//   ... --measure --out-dir <dir> --league <id> [--concurrency N] [--rosters 300]
//   ... --table --out-dir <dir>
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPO, runPool, trainFold, log, foldPath, crpsBySeason, contribution, isDegenerate, signs, lineupOf,
} from "./weekly-contribution-ledger.mjs";

const argv = process.argv.slice(2);
const v = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

/** `@path` = read the list off that artifact's own bytes; anything else is a literal comma list. */
export function designFeatures(spec) {
  if (!spec) throw new Error("a design needs --base/--cand");
  if (!spec.startsWith("@")) return spec.split(",").map((s) => s.trim()).filter(Boolean);
  const j = JSON.parse(readFileSync(spec.slice(1), "utf8"));
  const f = (j.features ?? []).map((x) => x.name ?? x);
  if (!f.length) throw new Error(`${spec.slice(1)} declares no features -- it is not a fitted design`);
  return f;
}

const seasonRange = (spec) => { const [a, b] = String(spec).split("-").map(Number); const o = []; for (let y = a; y <= (b ?? a); y++) o.push(y); return o; };
const SEASONS = seasonRange(v("--seasons", "2012-2025"));
const SELECTION = SEASONS.filter((y) => y <= 2020);
const HOLDOUT = SEASONS.filter((y) => y >= 2021);

export function buildArms() {
  const base = { id: "base", features: designFeatures(v("--base", null)), label: v("--base", "") };
  const cand = { id: "cand", features: designFeatures(v("--cand", null)), label: v("--cand", "") };
  // The degeneracy positive control, scored LAST. If `base_dup` is not bit-identical to `base`, the
  // harness moved under the screen and no delta below is a design's contribution -- and it is the only
  // thing that proves `isDegenerate` can return TRUE against a real pair of runs.
  const dup = { id: "base_dup", features: base.features, reuseFrom: "base", label: "base re-scored (degeneracy control)" };
  return [base, cand, dup];
}

/** `ff evaluate-weekly --league <id>` for one arm, stdout streamed STRAIGHT TO A FILE (a 14-season
 *  `--json` result is megabytes; a pipe buffer truncates it and the failure reads like a bad arm). */
async function scoreArm(arm, outDir, leagueId, rosters) {
  const out = join(outDir, `${arm.id}.json`);
  if (existsSync(out)) { try { const j = JSON.parse(readFileSync(out, "utf8")); if (j.bySeason) return "cached"; } catch { /* rescore */ } }
  const foldDir = join(outDir, "_folds", arm.reuseFrom ?? arm.id);
  const args = [
    "--import", "tsx", "src/ff.ts", "evaluate-weekly",
    "--league", String(leagueId),
    "--seasons", `${SEASONS[0]}-${SEASONS[SEASONS.length - 1]}`,
    "--train-seasons", `${SEASONS[0]}-${SEASONS[SEASONS.length - 1]}`,
    "--rosters", String(rosters),
    "--features", arm.features.join(","),
    "--keep-artifacts", foldDir, "--reuse-artifacts",
    "--json",
  ];
  const t0 = Date.now();
  await new Promise((res, rej) => {
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
        // THE `--league` PATH PRINTS A PREAMBLE BEFORE THE JSON, and it is not noise to be silenced:
        // `evaluate-weekly` announces which format it resolved and where the rows and the season
        // window came from, which is exactly the provenance a per-format number needs attached. So it
        // is kept in the file and the JSON is parsed from the first line that starts an object. The
        // incumbent path prints nothing and this is a no-op there.
        const raw = readFileSync(tmp, "utf8");
        const at = raw.indexOf("\n{");
        const body = at >= 0 ? raw.slice(at + 1) : raw;
        const j = JSON.parse(body);
        if (!j.bySeason) return rej(new Error("no bySeason in the result"));
        writeFileSync(out, body);
        writeFileSync(out.replace(/\.json$/, ".provenance.txt"), at >= 0 ? raw.slice(0, at + 1) : "");
        res();
      } catch (e) { rej(new Error(`unparseable result: ${e.message}`)); }
    }));
  });
  log(outDir, `scored ${arm.id} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return "ran";
}

/** The same positive control the ledger's `--verify` is: every fold fitted EXACTLY its arm's list. */
export function verifyFolds(outDir, arms) {
  const problems = [];
  for (const a of arms) {
    if (a.reuseFrom) continue;
    for (const yr of SEASONS) {
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
const gateBlock = (ev, name) => {
  const g = ev.gate;
  const head = `**${name}**: GATE ${g?.passed ? "PASSED" : "FAILED"}`;
  const lines = (g?.clauses ?? []).map((c) => `  - (${c.id}) ${c.passed ? "PASS" : "FAIL"} -- ${c.evidence}`);
  return [head, ...lines].join("\n");
};

function table(outDir) {
  const arms = buildArms();
  const load = (id) => { const p = join(outDir, `${id}.json`); if (!existsSync(p)) return null; try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
  const base = load("base"), cand = load("cand");
  if (!base || !cand) { console.error("need both arms scored in " + outDir); process.exit(1); }
  const baseM = crpsBySeason(base), candM = crpsBySeason(cand);

  console.log(`# PER-FORMAT WEEKLY DESIGN SCREEN -- ${outDir}\n`);
  console.log(`base: ${arms[0].label} (${arms[0].features.length}f)`);
  console.log(`cand: ${arms[1].label} (${arms[1].features.length}f)`);
  console.log(`base only: ${arms[0].features.filter((f) => !arms[1].features.includes(f)).join(", ") || "(none)"}`);
  console.log(`cand only: ${arms[1].features.filter((f) => !arms[0].features.includes(f)).join(", ") || "(none)"}\n`);

  const dup = load("base_dup");
  if (dup) {
    const m = crpsBySeason(dup);
    const worst = Math.max(...SEASONS.filter((y) => m.has(y)).map((y) => Math.abs(m.get(y) - baseM.get(y))));
    console.log(`DEGENERACY POSITIVE CONTROL (base re-scored): ${isDegenerate(baseM, m, SEASONS) ? "DEGENERATE as required" : "NOT DEGENERATE -- THE SCREEN IS VOID"} (largest per-season |delta| ${worst.toExponential(2)})\n`);
  }

  console.log("## 1. PAIRED-SEASON FLOOR -- candidate against the format's incumbent design\n");
  console.log("| block | improvement (base - cand) | SE | floor 2.9*SE | wins | verdict |");
  console.log("|---|---|---|---|---|---|");
  for (const [name, ys] of [["SELECTION 2012-2020", SELECTION], ["HOLDOUT 2021-2025", HOLDOUT], ["ALL", SEASONS]]) {
    const c = contribution(candM, baseM, ys);   // improvement = base - cand; positive = cand is better
    if (!c) { console.log(`| ${name} | (too few seasons) | | | | |`); continue; }
    console.log(`| ${name} | ${fmt(c.improvement)} | ${c.se.toFixed(5)} | ${c.floor.toFixed(5)} | ${c.wins}/${c.nSeasons} | ${c.pass ? "ADMIT -- clears the floor" : "inside the floor (no measurable difference) or negative"} |`);
  }
  console.log(`\nper-season pooled CRPS (base -> cand):`);
  for (const y of SEASONS) {
    if (!baseM.has(y) || !candM.has(y)) continue;
    console.log(`  ${y}  ${baseM.get(y).toFixed(4)} -> ${candM.get(y).toFixed(4)}   ${fmt(baseM.get(y) - candM.get(y), 4)}${HOLDOUT.includes(y) ? "  (holdout)" : ""}`);
  }
  console.log(`\nsigns (cand - base) 2012..: ${signs(candM, baseM, SEASONS)}`);

  console.log("\n## 2. POOLED, AND THE GATE (the format's own line-only floor is scored in the same invocation)\n");
  console.log("| arm | model | RMSE | CRPS | coverage | cov(nonzero) | bias | zeroP | zeroA |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const [nm, ev] of [["base", base], ["cand", cand]]) {
    for (const mdl of Object.keys(ev.pooled ?? {})) {
      const p = ev.pooled[mdl];
      if (!p) continue;
      console.log(`| ${nm} | ${mdl} | ${p.rmse?.toFixed(3)} | ${p.crps?.toFixed(4)} | ${p.coverage?.toFixed(3)} | ${p.coverageNonZero?.toFixed(3) ?? "NA"} | ${p.bias?.toFixed(3)} | ${p.zeroPred?.toFixed(3) ?? "NA"} | ${p.zeroActual?.toFixed(3) ?? "NA"} |`);
    }
  }
  console.log("");
  console.log(gateBlock(base, "base"));
  console.log(gateBlock(cand, "cand"));

  console.log("\n## 3. THE DECISION LAYER -- lineup regret on the format's own roster template\n");
  const bl = lineupOf(base), cl = lineupOf(cand);
  console.log("| scenario | base | cand | delta |");
  console.log("|---|---|---|---|");
  for (const s of Object.keys(bl)) console.log(`| ${s} | ${bl[s]?.toFixed(3)} | ${cl[s]?.toFixed(3)} | ${(cl[s] - bl[s]).toFixed(3)} |`);
}

const MODES = ["--arms", "--fit", "--check", "--measure", "--table"];
if (argv.some((a) => MODES.includes(a))) {
  const outDir = v("--out-dir", null);
  const arms = buildArms();
  if (argv.includes("--arms")) {
    for (const a of arms) console.log(`${a.id}\t${a.features.length}f\t${a.reuseFrom ? "reuses " + a.reuseFrom : "trains"}\t${a.label}`);
    console.log(`\n${arms.filter((a) => !a.reuseFrom).length} trained arms x ${SEASONS.length} folds = ${arms.filter((a) => !a.reuseFrom).length * SEASONS.length} fold trainings`);
  } else if (!outDir) {
    console.error("that mode needs --out-dir"); process.exit(1);
  } else if (argv.includes("--fit")) {
    mkdirSync(outDir, { recursive: true });
    const db = v("--features-db", null);
    if (!db) { console.error("--fit needs --features-db (the format's own rows)"); process.exit(1); }
    const conc = Math.max(1, Number(v("--concurrency", "21")));
    const jobs = [];
    for (const a of arms) { if (a.reuseFrom) continue; for (const yr of SEASONS) jobs.push({ arm: a.id, season: yr, features: a.features }); }
    log(outDir, `FIT: ${jobs.length} folds, concurrency ${conc}, db ${db}`);
    let done = 0;
    await runPool(jobs, conc, async (j) => { const st = await trainFold(j, outDir, db); log(outDir, `  (${++done}/${jobs.length}) ${j.arm}/${j.season}: ${st}`); });
  } else if (argv.includes("--check")) {
    const problems = verifyFolds(outDir, arms);
    if (!problems.length) console.log(`CHECK OK: every fold of ${arms.filter((a) => !a.reuseFrom).length} trained arms carries exactly its arm's feature list, two-part/gbm, rostered/in_population, holdout excluded.`);
    else { console.error(`CHECK FAILED (${problems.length}):`); for (const p of problems) console.error("  " + p); process.exit(1); }
  } else if (argv.includes("--measure")) {
    mkdirSync(outDir, { recursive: true });
    const leagueId = v("--league", null);
    if (!leagueId) { console.error("--measure needs --league"); process.exit(1); }
    const rosters = Number(v("--rosters", "300"));
    const conc = Math.max(1, Number(v("--concurrency", "2")));
    log(outDir, `MEASURE: league ${leagueId}, rosters ${rosters}, concurrency ${conc}`);
    await runPool(arms.filter((a) => !a.reuseFrom), conc, async (a) => log(outDir, `  ${a.id}: ${await scoreArm(a, outDir, leagueId, rosters)}`));
    for (const a of arms.filter((a) => a.reuseFrom)) log(outDir, `  ${a.id} (control, last): ${await scoreArm(a, outDir, leagueId, rosters)}`);
  } else {
    table(outDir);
  }
}
