// PHASE 4 (A6 continuous loop): the re-measurement registry, MECHANIZED.
//
//   node scripts/experiments-status.mjs
//
// Reads the arbiter ledger (data/experiments.jsonl), recomputes each experiment's draft-arbiter
// dependency fingerprint AS IT IS NOW, and compares it to the fingerprint stored when the experiment
// ran. Three states:
//   CURRENT  -- every dependency is byte-for-byte where it was; the number still stands.
//   STALE    -- a dependency drifted since measurement; the number is no longer trustworthy, re-run it.
//   LEGACY   -- logged before Phase 4, so it has no measurement-time fingerprint; re-run to enrol it.
// For a STALE row it names WHICH inputs moved (the whole point of a registry: not "something changed"
// but "this changed, so re-run that").
//
// It also reports T, the number of arbiter runs the ledger has spent. That is the multiple-testing
// count behind PBO / a deflated ship threshold (Lopez de Prado): every extra config tried raises the
// bar a genuine edge must clear, so a system that consults the backtest freely without tracking T is
// deceiving itself about significance. This makes T impossible to lose track of.
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fingerprintDraftArbiter, DRAFT_ARBITER_DEPS } from "./lib/deps.mjs";

const LEDGER = process.argv.includes("--ledger") ? process.argv[process.argv.indexOf("--ledger") + 1] : "data/experiments.jsonl";
const VERBOSE = process.argv.includes("--verbose");
// --rerun-stale re-runs every STALE experiment that carries a `spec` (reconstructing its cpcv command),
// re-enrolling it at the current fingerprint. It runs BACKTESTS, so it PREVIEWS by default; pass --run
// to execute. This is the A6 loop's active half: detect drift AND close it.
const RERUN = process.argv.includes("--rerun-stale");
const RUN = process.argv.includes("--run");

if (!existsSync(LEDGER)) { console.error(`no ledger at ${LEDGER}`); process.exit(1); }
const entries = readFileSync(LEDGER, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

const { default: Database } = await import("better-sqlite3");
const db = new Database("data/ff.db", { readonly: true });
const now = fingerprintDraftArbiter(db);
db.close();

console.log(`\n${"=".repeat(92)}`);
console.log(`EXPERIMENT LEDGER STATUS -- ${entries.length} arbiter runs in ${LEDGER}`);
console.log(`current draft-arbiter fingerprint: ${now.hash}`);
console.log(`${"=".repeat(92)}\n`);

let current = 0, stale = 0, legacy = 0;
const drifted = new Map(); // input -> count of experiments it staled

for (const e of entries) {
  const short = (e.treatment_label || e.config_hash || "?").slice(0, 46).padEnd(46);
  const lift = e.mean_lift != null ? `${e.mean_lift >= 0 ? "+" : ""}${e.mean_lift.toFixed(2)}pp` : "   -  ";
  let status;
  if (e.deps_hash == null) { status = "LEGACY"; legacy++; }
  else if (e.deps_hash === now.hash) { status = "CURRENT"; current++; }
  else {
    status = "STALE"; stale++;
    // name the inputs that moved, if the entry stored its parts
    if (e.deps_parts) {
      for (const k of Object.keys(now.parts)) {
        if (e.deps_parts[k] !== now.parts[k]) drifted.set(k, (drifted.get(k) ?? 0) + 1);
      }
      for (const k of Object.keys(e.deps_parts)) {
        if (!(k in now.parts)) drifted.set(`${k} (removed)`, (drifted.get(`${k} (removed)`) ?? 0) + 1);
      }
    }
  }
  const mark = status === "CURRENT" ? "  ok " : status === "STALE" ? " DRIFT" : " ----";
  console.log(`  ${status.padEnd(7)}${mark}  ${short}  ${lift.padStart(8)}  ${(e.timestamp || "").slice(0, 10)}`);
  if (VERBOSE && e.deps_parts && status === "STALE") {
    for (const k of Object.keys(now.parts)) {
      if (e.deps_parts[k] !== now.parts[k]) console.log(`             ~ ${k}: ${e.deps_parts[k]} -> ${now.parts[k]}`);
    }
  }
}

console.log(`\n${"-".repeat(92)}`);
console.log(`  T = ${entries.length} arbiter runs spent (the multiple-testing count behind PBO / a deflated threshold).`);
console.log(`  ${current} CURRENT   ${stale} STALE   ${legacy} LEGACY`);
if (drifted.size) {
  console.log(`\n  Dependencies that drifted (and how many experiments each staled):`);
  for (const [k, n] of [...drifted.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)}x  ${k}`);
  console.log(`\n  Re-run the STALE experiments (reuse the golden-master command through scripts/cpcv.mjs) and`);
  console.log(`  the ledger re-enrols them at the current fingerprint.`);
} else if (stale === 0 && legacy === 0) {
  console.log(`\n  All experiments are CURRENT -- every arbiter result still stands on its measured inputs.`);
}
if (legacy) {
  console.log(`\n  ${legacy} LEGACY row(s) predate Phase 4 (no measurement-time fingerprint). Re-running any one`);
  console.log(`  enrols it; until then its staleness cannot be judged mechanically.`);
}
console.log(`\n  Fingerprint covers ${DRAFT_ARBITER_DEPS.files.length} data files, ${DRAFT_ARBITER_DEPS.tables.length} tables, ` +
  `${DRAFT_ARBITER_DEPS.dirs.length} artifact dir(s), ${DRAFT_ARBITER_DEPS.code.length} source files, and the stored levers.`);
console.log("");

// ---- --rerun-stale: close the loop ----------------------------------------------------------------
if (RERUN) {
  // STALE (drifted) entries that carry a spec, DEDUP by config_hash keeping the latest -- so an
  // experiment re-run many times is re-run ONCE. Stale-without-spec (pre-spec rows) cannot be
  // reconstructed and are reported, not run.
  const staleWithSpec = [], staleNoSpec = [], seen = new Set();
  for (const e of entries.slice().reverse()) {
    if (e.deps_hash == null || e.deps_hash === now.hash) continue;   // legacy-no-hash or CURRENT
    if (seen.has(e.config_hash)) continue; seen.add(e.config_hash);
    (e.spec ? staleWithSpec : staleNoSpec).push(e);
  }
  console.log(`${"=".repeat(92)}`);
  console.log(`RERUN-STALE -- ${staleWithSpec.length} re-runnable, ${staleNoSpec.length} stale-without-spec (cannot reconstruct)`);
  if (staleNoSpec.length) console.log(`  (pre-spec rows, re-run manually once to enrol: ${staleNoSpec.map((e) => e.treatment_label).slice(0, 6).join("; ")}${staleNoSpec.length > 6 ? " ..." : ""})`);
  if (!staleWithSpec.length) { console.log(`  nothing to re-run.\n`); process.exit(0); }

  // group by BASELINE spec so the baseline arm is run ONCE per group and reused across its treatments.
  const groups = new Map();
  for (const e of staleWithSpec) {
    const s = e.spec, gk = JSON.stringify([s.base_flags, s.seasons, s.n, s.artifact_dir]);
    (groups.get(gk) ?? groups.set(gk, []).get(gk)).push(e);
  }
  const nBt = groups.size + staleWithSpec.length;   // 1 baseline/group + 1 treatment/experiment
  console.log(`  ${groups.size} baseline group(s), ${staleWithSpec.length} treatments -> ~${nBt} backtests` + (RUN ? "" : " (PREVIEW -- pass --run to execute)"));
  for (const [gk, es] of groups) {
    const s = es[0].spec;
    console.log(`\n  baseline: backtest ${s.base_flags} --seasons ${s.seasons} --n ${s.n} --artifact-dir ${s.artifact_dir}`);
    for (const e of es) console.log(`    + treatment ${e.spec.treatment}   [${e.treatment_label}]`);
  }
  if (!RUN) { console.log(`\n  Preview only. Re-run with --run (this executes ~${nBt} backtests).\n`); process.exit(0); }

  mkdirSync("data/trials", { recursive: true });
  let done = 0;
  for (const [gk, es] of groups) {
    const s = es[0].spec;
    const baseDump = path.join("data/trials", `rerun-base-${Date.now()}.tsv`);
    console.log(`\n$ (baseline) backtest ${s.base_flags} ...`);
    execSync(`npm run -s ff -- backtest ${s.base_flags} --seasons ${s.seasons} --n ${s.n} --artifact-dir ${s.artifact_dir} --dump-trials ${baseDump}`, { stdio: "inherit" });
    for (const e of es) {
      console.log(`\n$ (rerun) ${e.treatment_label}`);
      execSync(`node scripts/cpcv.mjs --base-flags "${s.base_flags}" --baseline-dump ${baseDump} --treatment "${e.spec.treatment}" --seasons ${s.seasons} --n ${s.n} --artifact-dir ${s.artifact_dir} --baseline-label ${JSON.stringify(e.baseline_label)} --treatment-label ${JSON.stringify(e.treatment_label)}`, { stdio: "inherit" });
      done++;
    }
  }
  console.log(`\n  re-ran ${done} experiment(s); each appended a fresh CURRENT ledger row. Run experiments-status again to confirm.\n`);
}
