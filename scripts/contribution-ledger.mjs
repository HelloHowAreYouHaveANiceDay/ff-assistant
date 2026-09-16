// CONTRIBUTION LEDGER (M2f) -- a leave-one-out ablation of the SEASON projector's DEFAULT fit list.
//
// WHY. Every feature in the projector's default lists was admitted by its own gate, one at a time,
// against the baseline of the day. Nothing has ever asked the symmetric question of the WHOLE design:
// what does each shipped feature still contribute, TODAY, given every other shipped feature? That is a
// leave-one-out ablation, and `scripts/admit-feature.mjs --remove` already measures exactly one row of
// it (the `contract_year` DROP of 2026-09-14 is the precedent). This script drives that one script over
// every default feature and over FAMILIES of them, and emits the ledger.
//
// DISCIPLINE (all of it inherited, none of it re-invented here):
//   * every arm is the SAME admit-feature version, run as a subprocess -- no second implementation of
//     the verdict, the floor, or the selection/holdout split;
//   * the DECISION is the selection block (2013-2020) and the holdout (2021-2025) is quoted once;
//   * the full-default arm is IDENTICAL for every row, so it is fitted ONCE and served from
//     --baseline-cache (a cache HIT is byte-identical to the run it replaces);
//   * a row whose two arms are identical on every decision season exits 3 = DEGENERATE, and is
//     reported as DEGENERATE, never as a zero contribution;
//   * family-wide BH FDR (WS4) is applied across the LOO rows, because eleven simultaneous keep/drop
//     tests is a family.
//
// READ-ONLY on every database; all artifacts/caches go under --out.
//
// USAGE:
//   node --import tsx scripts/contribution-ledger.mjs --arms <spec.json> --out <dir> [--dry-run]
// The spec is [{ id, candidate, db?, pos?, seasons? }]; `candidate` may be a COMMA LIST (the trainer's
// --remove-features has always split on commas), which is how a FAMILY arm is expressed.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { normalSf, familyAdjust } from "./lib/arbiter.mjs";

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const armsPath = val("--arms", null);
const outDir = val("--out", null);
const dryRun = argv.includes("--dry-run");
if (!armsPath || !outDir) {
  console.error("usage: node --import tsx scripts/contribution-ledger.mjs --arms <spec.json> --out <dir> [--dry-run]");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const arms = JSON.parse(readFileSync(armsPath, "utf8"));

/** Run ONE arm through admit-feature.mjs (or reuse its dumped json if the arm already ran).
 *  Returns the parsed json plus the exit status; never throws on a REJECT/DROP (exit 2) or a
 *  DEGENERATE (exit 3), which are results, not failures. */
function runArm(a) {
  const jsonPath = join(outDir, `${a.id}.json`);
  if (existsSync(jsonPath)) { console.log(`  [skip] ${a.id} (already measured)`); return JSON.parse(readFileSync(jsonPath, "utf8")); }
  const args = ["--import", "tsx", "scripts/admit-feature.mjs", "--candidate", a.candidate, "--remove",
    "--seasons", a.seasons ?? "2013-2025", "--json", jsonPath,
    "--baseline-cache", join(outDir, "baseline-cache.json")];
  if (a.db) args.push("--db", a.db);
  if (a.pos) args.push("--pos", a.pos);
  console.log(`  [run ] ${a.id}: node ${args.join(" ")}`);
  if (dryRun) return null;
  const t0 = Date.now();
  const r = spawnSync("node", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: false });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (!existsSync(jsonPath)) {
    console.error(`  [FAIL] ${a.id} exit ${r.status} (${secs}s) -- no json written\n${(r.stderr || "").slice(-1500)}`);
    return null;
  }
  console.log(`  [done] ${a.id} exit ${r.status} (${secs}s)`);
  return JSON.parse(readFileSync(jsonPath, "utf8"));
}

const results = [];
for (const a of arms) {
  const j = runArm(a);
  results.push({ ...a, result: j });
}
if (dryRun) process.exit(0);

// ---- FAMILY-WIDE FDR (WS4) over the LOO rows -------------------------------------------------------
// Eleven leave-one-out tests against one shared baseline is a family of simultaneous comparisons; the
// per-row 2.9*SE floor controls each test in isolation and nothing controls the set. The one-sided
// p-value comes from the row's OWN season-bootstrap t (effect/SE), the same statistic the floor uses.
const looRows = results.filter((r) => r.family !== true && r.result?.status === "OK");
const { q } = familyAdjust(looRows.map((r) => normalSf(r.result.decision.t)));
looRows.forEach((r, i) => { r.q = q[i]; r.p = normalSf(r.result.decision.t); });

const ledger = results.map((r) => {
  const j = r.result;
  if (!j) return { id: r.id, status: "FAILED" };
  if (j.status === "DEGENERATE") return { id: r.id, candidate: r.candidate, pos: r.pos, status: "DEGENERATE" };
  const d = j.decision, c = j.confirm;
  return {
    id: r.id, candidate: r.candidate, pos: r.pos ?? "all", family: r.family === true, status: "OK",
    contribution: d.improvement, se: d.se, t: d.t, floor: d.floor, wins: `${d.wins}/${d.nSeasons}`,
    verdict: d.pass ? "KEEP" : "DROP",
    p: r.p ?? null, q: r.q ?? null,
    holdout: c ? { contribution: c.improvement, se: c.se, floor: c.floor, wins: `${c.wins}/${c.nSeasons}`, confirmed: c.pass } : null,
    perSeason: j.perSeason.map((s) => ({ season: s.season, contribution: s.contribution })),
  };
});
writeFileSync(join(outDir, "ledger.json"), JSON.stringify(ledger, null, 2));

// ---- the tables -----------------------------------------------------------------------------------
const f = (x, n = 4) => (x == null || Number.isNaN(x) ? "--" : x.toFixed(n));
console.log("\n| arm | pos | contribution +/- SE | floor (2.9*SE) | wins | verdict | BH q | holdout | confirmed |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of ledger) {
  if (r.status !== "OK") { console.log(`| ${r.id} | ${r.pos ?? "all"} | ${r.status} | -- | -- | ${r.status} | -- | -- | -- |`); continue; }
  console.log(`| ${r.id} | ${r.pos} | ${f(r.contribution)} +/- ${f(r.se)} | ${f(r.floor)} | ${r.wins} | ${r.verdict} | ${r.q == null ? "--" : f(r.q, 3)} | ${r.holdout ? f(r.holdout.contribution) : "--"} | ${r.holdout ? (r.holdout.confirmed ? "yes" : "no") : "--"} |`);
}

// PER-SEASON SIGN STRIP. The decision block and the holdout are already two eras; the per-season signs
// make a REGIME FLIP visible inside each (a feature that is positive in every recent season and
// negative in every old one averages to a null, and the two-block summary alone cannot show that).
const allSeasons = [...new Set(ledger.flatMap((r) => (r.perSeason ?? []).map((s) => s.season)))].sort();
if (allSeasons.length) {
  console.log(`\nper-season sign of the contribution (+ = removing it HURTS, i.e. the feature earns its place that season)`);
  console.log(`| arm | ${allSeasons.join(" | ")} |`);
  console.log(`|---|${allSeasons.map(() => "---").join("|")}|`);
  for (const r of ledger) {
    if (!r.perSeason) continue;
    const m = new Map(r.perSeason.map((s) => [s.season, s.contribution]));
    console.log(`| ${r.id} | ${allSeasons.map((s) => (m.has(s) ? (m.get(s) > 0 ? "+" : m.get(s) < 0 ? "-" : "0") : ".")).join(" | ")} |`);
  }
}
console.log(`\nledger written to ${join(outDir, "ledger.json")}`);
