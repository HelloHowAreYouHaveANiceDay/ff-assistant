// SERVE-TIME MISSINGNESS ABLATION OF THE WEEKLY MODEL (M2h). MEASUREMENT ONLY -- nothing ships.
//
//   node --import tsx scripts/weekly-missingness-ablation.mjs --folds <dir> --out <dir> [options]
//
// THE QUESTION, AND WHY IT IS NOT THE TRAINING ABLATION.
//
// Dropping a column from TRAINING measures how much information it carries. That is not the risk the
// live season runs. The live risk is that a feed the model was FITTED ON fails on a Sunday: the
// FantasyPros weekly consensus is scraped on a Friday and a Thursday game is structurally past it;
// the injury feed stopped publishing report dates once already; a Vegas line can be missing for a
// game nobody has posted. In every one of those the model is the model that shipped -- it just has a
// hole where a column should be, and the D19 serve contract says it must degrade to its anchors
// rather than crash or route into a leaf it never trained.
//
// So this harness masks at SERVE only: `EvalOpts.maskServe` nulls the named fields on the SCORED
// rows of every fold, and the folds' TRAINING is untouched. That is fit-with / serve-without, which
// is exactly the Sunday. The projector turns a null into the artifact's own declared `missing` for
// the linear heads and into NaN for the boosted design, i.e. the mask group's absent state.
//
// WHAT IS DERIVED RATHER THAN RETYPED, because an enumeration written today rots the day a column is
// added (CLAUDE.md):
//   - the SINGLE-feature arms are the artifact's OWN `features` list, whatever it holds;
//   - the FAMILY arms are parsed out of tools/train_weekly.py's `MASKABLE_GROUPS`, the dict the
//     trainer's own missingness augmentation uses, so a group added there appears here;
//   - the sub-families of `avail` (designations / practice / the feed flag) are named here because
//     they are a decomposition this screen invented, and each is ASSERTED to be a subset of the
//     parsed `avail` group -- so a rename upstream fails loudly instead of silently masking nothing.
//
// THE CONTROLS ARE ARMS, not prose (a mask that does nothing reads exactly like a feed that costs
// nothing): `__all__` masks every feature and must collapse the model onto its anchor; the level
// column must be the most expensive single mask; `week_no` and `home` must be ~0.
//
// COST. Training is the whole expense and it happens ONCE: pass a `--folds` directory that already
// holds a full set (or let the first, unmasked arm train it) and every later arm reuses it through
// `reuseArtifacts`. Arms run SEQUENTIALLY.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { evaluateWeekly, SCENARIOS } from "../src/weekly/evaluate.ts";

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const artifactPath = val("--artifact", "data/weekly-artifact.json");
const dbPath = val("--db", "data/ff.db");
const foldsDir = val("--folds", null);
const outDir = val("--out", null);
const rosters = Number(val("--rosters", "300"));
const seasons = (val("--seasons", "2012-2025")).split("-").map(Number);
const trainSeasons = (val("--train-seasons", "2010-2025")).split("-").map(Number);
const only = val("--only", null);
const tag = val("--tag", "incumbent");
if (!foldsDir || !outDir) { console.error("--folds <dir> and --out <dir> are required"); process.exit(2); }
mkdirSync(foldsDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const range = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const SEASONS = range(seasons[0], seasons[1] ?? seasons[0]);
const TRAIN = range(trainSeasons[0], trainSeasons[1] ?? trainSeasons[0]);

const art = JSON.parse(readFileSync(artifactPath, "utf8"));
const FEATURES = art.features.map((f) => f.name);

/** MASKABLE_GROUPS, parsed out of the trainer rather than retyped here. */
function maskGroups() {
  const src = readFileSync("tools/train_weekly.py", "utf8");
  const block = src.match(/MASKABLE_GROUPS\s*=\s*\{([\s\S]*?)\n\}/);
  if (!block) throw new Error("could not find MASKABLE_GROUPS in tools/train_weekly.py -- it was renamed or reshaped");
  const out = {};
  const re = /"(\w+)"\s*:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(block[1]))) {
    out[m[1]] = [...m[2].matchAll(/"(\w+)"/g)].map((x) => x[1]);
  }
  if (!Object.keys(out).length) throw new Error("MASKABLE_GROUPS parsed to nothing");
  return out;
}
const GROUPS = maskGroups();

// Sub-families of `avail`: this screen's own decomposition, checked against the parsed group so a
// rename upstream is a hard failure and not a silently empty mask.
const SUB = {
  injury_designations: ["inj_out", "inj_doubtful", "inj_questionable"],
  practice_status: ["prac_dnp", "prac_limited"],
  injury_feed_flag: ["inj_feed"],
  teammates_out: ["teammates_out"],
};
for (const [n, cols] of Object.entries(SUB)) {
  for (const c of cols) {
    if (!(GROUPS.avail ?? []).includes(c)) throw new Error(`sub-family ${n} names "${c}", which is not in the trainer's avail group -- the decomposition is stale`);
  }
}

/** The arms. `null` mask = the unmasked reference. Only features the ARTIFACT carries are masked --
 *  naming a column this artifact never fitted would be an arm that masks nothing and reports 0. */
const keep = (cols) => cols.filter((c) => FEATURES.includes(c));
const arms = [{ name: "__none__", kind: "reference", mask: null }];
for (const f of FEATURES) arms.push({ name: f, kind: "single", mask: [f] });
for (const [g, cols] of Object.entries(GROUPS)) {
  const k = keep(cols);
  if (k.length) arms.push({ name: `family:${g}`, kind: "family", mask: k });
}
for (const [n, cols] of Object.entries(SUB)) {
  const k = keep(cols);
  if (k.length) arms.push({ name: `family:${n}`, kind: "family", mask: k });
}
arms.push({ name: "family:__all__", kind: "control", mask: [...FEATURES] });
// `--extra name=col,col,...` (repeatable): an arm this screen names for a REAL serve state rather than
// for a trainer group -- e.g. the exact set of columns measured dark in the live 2026 week. Members
// are checked against the artifact so a typo is a hard failure and not an arm that masks nothing.
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--extra") continue;
  const [n, cols] = String(argv[i + 1] ?? "").split("=");
  const list = (cols ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!n || !list.length) throw new Error(`--extra wants name=col,col (got "${argv[i + 1]}")`);
  const bad = list.filter((c) => !FEATURES.includes(c));
  if (bad.length) throw new Error(`--extra ${n} names ${bad.join(",")}, absent from ${artifactPath}`);
  arms.push({ name: `extra:${n}`, kind: "serve-state", mask: list });
}

const selected = only ? arms.filter((a) => a.name === "__none__" || only.split(",").includes(a.name)) : arms;

const STD = SCENARIOS[0].name, DEEP = SCENARIOS[SCENARIOS.length - 1].name;
const outPath = join(outDir, `arms-${tag}.jsonl`);

// ---- REPORT MODE: read the arms already measured and print the paired tables. ----
if (has("--report")) {
  const rows = readFileSync(outPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const base = rows.find((r) => r.name === "__none__");
  if (!base) throw new Error(`${outPath} has no __none__ reference arm`);
  const yrs = Object.keys(base.crpsBySeason).sort();
  const stat = (r) => {
    // PAIRED BY SEASON. The unit of analysis is the season, not the row: 60k rows over 14 seasons is
    // not 60k independent observations, and a pooled difference of two aggregates would quote a
    // standard error ~70x too small (CLAUDE.md).
    const d = yrs.map((y) => r.crpsBySeason[y] - base.crpsBySeason[y]);
    const n = d.length;
    const mean = d.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
    return {
      mean, se: sd / Math.sqrt(n), n,
      wins: d.filter((x) => x > 1e-12).length,
      zero: d.filter((x) => Math.abs(x) < 1e-12).length,
      d: Object.fromEntries(yrs.map((y, i) => [y, d[i]])),
    };
  };
  const out = rows.filter((r) => r.name !== "__none__").map((r) => {
    const s = stat(r);
    return {
      name: r.name, kind: r.kind, crps: r.crps, dCrps: s.mean, se: s.se, wins: s.wins,
      zeroSeasons: s.zero, seasons: s.n, coverage: r.coverage, dCoverage: r.coverage - base.coverage,
      dStd15: r.std15 - base.std15, dDeep18: r.deep18 - base.deep18, perSeason: s.d,
    };
  });
  out.sort((a, b) => b.dCrps - a.dCrps);
  const f = (x, n = 4) => (Number.isFinite(x) ? x.toFixed(n) : "n/a");
  console.log(`SERVE-TIME MISSINGNESS -- ${base.artifact}, ${base.seasons ?? yrs.length} seasons ${yrs[0]}-${yrs[yrs.length - 1]}`);
  console.log(`reference (nothing masked): CRPS ${f(base.crps)}  coverage ${f(base.coverage, 3)}  std15 ${f(base.std15, 3)}  deep18 ${f(base.deep18, 3)}\n`);
  const head = ["arm", "dCRPS", "+/-SE", "win", "0-yr", "cov", "dStd15", "dDeep18"];
  console.log(head[0].padEnd(26) + head.slice(1).map((h) => h.padStart(9)).join(""));
  for (const r of out) {
    console.log(r.name.padEnd(26) +
      [f(r.dCrps), f(r.se), `${r.wins}/${r.seasons}`, String(r.zeroSeasons), f(r.coverage, 3), f(r.dStd15, 3), f(r.dDeep18, 3)]
        .map((s) => String(s).padStart(9)).join(""));
  }
  writeFileSync(join(outDir, `report-${tag}.json`), JSON.stringify({ base, arms: out }, null, 1));
  process.exit(0);
}

const done = new Set();
if (existsSync(outPath) && !has("--fresh")) {
  for (const line of readFileSync(outPath, "utf8").split("\n")) {
    if (line.trim()) done.add(JSON.parse(line).name);
  }
  console.log(`resuming: ${done.size} arms already recorded in ${outPath}`);
}

for (const a of selected) {
  if (done.has(a.name)) continue;
  const t0 = Date.now();
  const res = await evaluateWeekly({
    dbPath, seasons: SEASONS, trainSeasons: TRAIN, rosters,
    // THE FOLDS FIT THE ARTIFACT'S OWN FEATURE LIST, NOT `all`. `--features all` is the trainer's
    // default and it is a MOVING SET: it expands the day a candidate column is declared, so today it
    // is 29 columns while `data/weekly-artifact.json` carries 25 (rz_share_td, prior_vol_cv and the
    // two M2a consensus columns were declared after the shipped file was built). A fold fitted on a
    // superset is a different model from the one that serves, and masking a column the served model
    // never had would report a cost nobody is exposed to. Reading the list off the artifact makes the
    // fold and the ship the same model by construction.
    features: FEATURES.join(","),
    keepArtifacts: foldsDir,
    reuseArtifacts: true,
    maskServe: a.mask ?? undefined,
    ...(artifactPath === "data/weekly-artifact.json" ? {} : {
      // A non-root candidate artifact is reached through the same `model` seam the format work uses;
      // only `require("weekly")` is read by the harness.
      model: { dir: "data", scoringKey: tag, provenance: "candidate", path: () => artifactPath, has: () => true, require: (n) => (n === "weekly" ? artifactPath : dbPath), shared: () => "", inventory: () => [] },
    }),
  });
  const row = {
    name: a.name, kind: a.kind, mask: a.mask, tag, artifact: artifactPath,
    seconds: Math.round((Date.now() - t0) / 1000),
    n: res.pooled.weekly.n,
    crps: res.pooled.weekly.crps,
    rmse: res.pooled.weekly.rmse,
    coverage: res.pooled.weekly.coverage,
    crpsBySeason: Object.fromEntries(Object.entries(res.bySeason).map(([y, m]) => [y, m.weekly.crps])),
    std15: res.lineup[STD]?.weekly.meanCaptured ?? NaN,
    deep18: res.lineup[DEEP]?.weekly.meanCaptured ?? NaN,
    std15Base: res.lineup[STD]?.shipped_week.meanCaptured ?? NaN,
  };
  writeFileSync(outPath, JSON.stringify(row) + "\n", { flag: "a" });
  console.log(`${a.name.padEnd(24)} crps=${row.crps.toFixed(4)} cov=${row.coverage.toFixed(3)} std15=${row.std15.toFixed(3)} deep18=${row.deep18.toFixed(3)} (${row.seconds}s)`);
}

console.log(`\nwrote ${outPath}`);
