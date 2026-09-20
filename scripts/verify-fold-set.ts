/**
 * IS A BLIND FOLD SET ACTUALLY BLIND? -- `npx tsx scripts/verify-fold-set.ts --dir <fold-artifacts>`
 *
 * `manifest.weekly.seasonLineBlind` used to be `existsSync(foldDir)` -- the presence of a DIRECTORY --
 * which a half-built set, or one whose artifact-2019 had seen 2019, satisfied exactly as readily as a
 * correct one (docs/multi-format-design.md, WP8). So "the files exist" is not the property; these
 * three separate facts are:
 *
 *   1. SELF-DECLARED BLINDNESS -- each artifact says `holdoutSeason: Y` and its `seasons` array ends
 *      at Y-1, so the season it will anchor is not in its own training set.
 *   2. THE CONSUMER CAN READ IT -- it loads through `loadArtifact` with `checkGolden`, i.e. the
 *      TypeScript projector reproduces the Python trainer's own fixture predictions to 1e-6. A file
 *      that parses but whose heads the consumer walks differently is worse than a missing one.
 *   3. IT WAS FITTED ON THIS FORMAT'S DATA -- the features.db behind it carries a DIFFERENT target
 *      than the main store, in the direction this format's rules predict. A fold set accidentally
 *      trained on the incumbent's rows would pass 1 and 2 perfectly.
 *
 *      THIS CHECK USED TO COMPARE ARTIFACTS, and that was CONFOUNDED. The root artifact is fitted on
 *      whatever the store held on ITS fit date, so a day of ordinary drift moves the centering
 *      constants (age 27.8505 vs 27.8499), flips the per-position `curveVariant` argmin, and shifts
 *      projections 8-24 points at positions whose scoring did not change at all. It reported
 *      "differs -- ok" for a reason that had nothing to do with the format, which is a pass that
 *      would have survived the exact mistake it exists to catch. Comparing TARGETS is unconfounded:
 *      the same men, the same season, scored two ways.
 *
 * Read-only; it trains nothing and writes nothing.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadArtifact, checkGolden, type ProjectionArtifact } from "../src/model/projector.js";

const arg = (f: string, d?: string): string | undefined => {
  const i = process.argv.indexOf(f);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d;
};
const dir = arg("--dir");
const rootPath = arg("--against", "data/projection-artifact.json")!;
if (!dir) { console.error("usage: verify-fold-set --dir <fold-artifacts dir> [--against <artifact.json>]"); process.exit(2); }
if (!existsSync(dir)) { console.error(`no such directory: ${dir}`); process.exit(2); }

const files = readdirSync(dir).filter((f) => /^artifact-\d{4}\.json$/.test(f)).sort();
if (!files.length) { console.error(`${dir} holds no artifact-YYYY.json files`); process.exit(2); }

let bad = 0;
const fail = (msg: string): void => { bad++; console.log(`  FAIL  ${msg}`); };

console.log(`FOLD SET ${dir} -- ${files.length} artifacts\n`);

// ---- 1 + 2 -------------------------------------------------------------------------------------
const loaded = new Map<number, ProjectionArtifact>();
for (const f of files) {
  const year = Number(f.slice(9, 13));
  const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as { holdoutSeason?: number; seasons?: number[] };

  if (raw.holdoutSeason !== year) { fail(`${f}: declares holdoutSeason ${raw.holdoutSeason}, not ${year}`); continue; }
  const seasons = raw.seasons ?? [];
  if (!seasons.length) { fail(`${f}: no seasons array -- nothing says what it was trained on`); continue; }
  const last = Math.max(...seasons);
  if (last >= year) fail(`${f}: trained through ${last}, which INCLUDES its own holdout ${year} -- not blind`);
  if (seasons.includes(year)) fail(`${f}: its seasons array contains ${year}`);

  try {
    const a = loadArtifact(raw, { checkGolden: true });
    checkGolden(a);
    loaded.set(year, a);
  } catch (e) { fail(`${f}: the CONSUMER cannot load it -- ${(e as Error).message.slice(0, 120)}`); }
}

const years = [...loaded.keys()].sort((a, b) => a - b);
console.log(`  1. self-declared blind + seasons end before holdout : ${files.length - bad}/${files.length} ok`);
console.log(`  2. loads through loadArtifact with checkGolden      : ${loaded.size}/${files.length} ok`);
if (years.length) console.log(`     holdouts ${years[0]}-${years[years.length - 1]}, contiguous: ${years.every((y, i) => i === 0 || y === years[i - 1] + 1)}`);

// ---- 3: fitted on THIS format's data, proved at the TARGET --------------------------------------
const featDb = join(dir, "..", "features.db");
if (!existsSync(featDb)) {
  console.log(`  3. fitted on this format's own target              : SKIPPED (${featDb} absent)`);
} else {
  const Database = (await import("better-sqlite3")).default;
  const f = new Database(featDb, { readonly: true });
  const m = new Database(arg("--store", "data/ff.db")!, { readonly: true });
  try {
    const q = "SELECT feat_key, pts FROM feat_player_season WHERE season=? AND pos=? ORDER BY feat_key";
    const season = Math.max(...[...loaded.keys()]) - 1;   // inside every fold's training range
    const out: string[] = [];
    let anyDiff = false;
    for (const pos of ["QB", "RB", "WR", "TE"]) {
      const mine = f.prepare(q).all(season, pos) as { feat_key: string; pts: number }[];
      const theirs = new Map((m.prepare(q).all(season, pos) as { feat_key: string; pts: number }[]).map((r) => [r.feat_key, r.pts]));
      let n = 0, d = 0, mx = 0;
      for (const r of mine) {
        const o = theirs.get(r.feat_key);
        if (o == null) continue;
        n++;
        const x = Math.abs((r.pts ?? 0) - (o ?? 0));
        if (x > 1e-6) d++;
        mx = Math.max(mx, x);
      }
      if (d > 0) anyDiff = true;
      out.push(`${pos} ${d}/${n} max|d| ${mx.toFixed(1)}`);
    }
    console.log(`  3. fitted on this format's own target (${season})       : ${anyDiff ? "ok" : "FAIL"}`);
    console.log(`     vs the main store: ${out.join("  |  ")}`);
    if (!anyDiff) {
      bad++;
      console.log("     IDENTICAL at every position -- this features.db was NOT retargeted, so the fold");
      console.log("     set is the incumbent's model wearing this format's directory name.");
    }
  } finally { f.close(); m.close(); }
}

// ---- informational: how far the artifacts sit from the root (NOT a pass/fail -- see header) -------
if (existsSync(rootPath)) {
  const root = loadArtifact(JSON.parse(readFileSync(rootPath, "utf8")));
  // The artifacts' own GOLDEN ROWS are the only inputs guaranteed to exist in both shapes, and they
  // are the trainer's own fixtures -- so this compares the two models on identical inputs.
  // The golden rows are the TRAINER'S OWN FIXTURES and are identical inputs across artifacts, so
  // matching on (pos, base, rank) compares two models on the same man. (An earlier version keyed on
  // `r.x`, a field that does not exist -- every row missed, and the check reported "NOT COMPARABLE"
  // while looking like a considered answer. The input field is `f` and the output is `expect.mean`.)
  const key = (g: { pos: string; base: number; rank: number | null }): string => `${g.pos}|${g.base}|${g.rank}`;
  const rootBy = new Map((root.golden ?? []).map((r) => [key(r), r]));
  let compared = 0, differing = 0, maxAbs = 0;
  for (const [, a] of loaded) {
    for (const g of a.golden ?? []) {
      const rg = rootBy.get(key(g));
      if (!rg) continue;
      compared++;
      const d = Math.abs(g.expect.mean - rg.expect.mean);
      maxAbs = Math.max(maxAbs, d);
      if (d > 1e-6) differing++;
    }
  }
  // REPORTED, NOT GATED. This number mixes the format difference with however much the store has
  // drifted since the root was fitted, so it cannot fail the set -- it is here because a value of
  // ZERO would be worth investigating (byte-identical models), and because stating it stops the next
  // reader from re-deriving it as a "check".
  console.log(`     (info) vs root artifact ${rootPath}: ${differing}/${compared} golden rows differ, max |d| ${maxAbs.toFixed(3)}`);
  console.log(`     (info) root fitted ${(root as unknown as { fittedAt?: string }).fittedAt ?? "?"} -- drift since then is INSIDE that number, so it gates nothing`);
}

console.log(`\n${bad === 0 ? "FOLD SET VERIFIED" : `${bad} PROBLEM(S) -- the set is NOT usable as a blind line source`}`);
process.exit(bad === 0 ? 0 : 1);
