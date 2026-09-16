// THE FORMAT RESOLVER -- the ONE place that turns "which league" into "which model's files".
//
// WHAT THIS REPLACED (F-2/F-3/F-4/F-7, 2026-09-16). Every per-scoring artifact in this repo was read
// from the `data/` ROOT through `dataPath("...")`, regardless of which league was being served:
// `points.csv`, `values.csv`, `current-actuals.csv`, `history-*.csv`, the projection artifact, all
// four weekly artifacts, `variance-model.json`, `rank-outcomes.json`, `correlation-model.json`,
// `def-ratings.csv`. `data/formats/<key>/` existed, held a trained Yahoo model, and NOTHING in `src/`
// read it -- so the Yahoo league's board, weekly serve and simulator would all have been the ESPN
// half-PPR numbers wearing Yahoo's dollar signs. That is not a missing feature, it is a wrong answer
// that renders perfectly.
//
// THE TWO RULES THAT MAKE THIS SAFE, and they are both refusals:
//
//   1. THE INCUMBENT ALIAS. The ESPN half-PPR key maps to the `data/` ROOT. It is pinned as a
//      constant (`INCUMBENT_SCORING_KEY`, src/data/formatKey.ts, asserted at module load against
//      `DEFAULT_SCORING`) and asserted AGAIN here against the resolving league's stored config, so a
//      config edit that moves the incumbent's key is named on the spot instead of silently orphaning
//      every root artifact.
//
//   2. ANY OTHER KEY MUST PROVE ITSELF. `data/formats/<key>/` must exist AND carry a `scoring.json`
//      whose canonical re-hash EQUALS the directory name (the F-5/F-7 preimage check -- a directory
//      name is a claim, and without a preimage nothing can falsify it). A miss THROWS, naming the
//      build command. There is deliberately NO fallback to `data/`: a fallback would serve every
//      unbuilt format the incumbent's numbers, which is the exact blocker this module exists to make
//      impossible.
//
// AND THE THIRD, which is what a consumer actually calls: PER-ARTIFACT AVAILABILITY IS EXPLICIT.
// `model.has(name)` / `model.require(name)` let a reader refuse BY NAME ("format sc-a845f67652fb has
// no weekly artifact") instead of quietly reading the root file that happens to be there.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DB, AppConfig } from "../db/db.js";
import { dataPath, DATA_ROOT } from "./paths.js";
import {
  scoringKeyFor, valueKey, formatKey, INCUMBENT_SCORING_KEY, type KeyableConfig,
} from "./formatKey.js";
import type { ScoringRules, KickerRules, DefenseRules } from "../draft/scoring.js";
import { resolveValueLeague, type ValueLeague } from "../draft/values.js";
import { resolveLeagueContext } from "./leagueContext.js";
// The two weekly artifact FILENAMES are imported, never retyped: test/weekly-artifact-consistency.ts
// asserts that src/weekly/projector.ts is the only file that writes either literal, because a second
// place to type the name is how the lineup surface and the scorecard came to serve different models
// with nothing failing. The streaming pair below are still literals -- their constants live in
// streamingServe.ts, which imports THIS module, so importing them back would close a cycle; they are
// re-asserted against those constants in test/format-resolve.test.ts instead.
import { SHIPPED_WEEKLY_ARTIFACT, CHALLENGER_WEEKLY_ARTIFACT } from "../weekly/projector.js";

// =================================================================================================
// THE ARTIFACT TABLE
// =================================================================================================

/**
 * Every artifact that BELONGS TO A FORMAT -- i.e. whose contents depend on the scoring rules or the
 * roster economics, so serving one format's copy to another format is a wrong number.
 *
 * `root` is the filename at the `data/` root (the incumbent's home); `fmt` is the filename inside
 * `data/formats/<key>/`. They differ in exactly two places, both for a good reason:
 *   - `features-db`: the incumbent's feature tables live IN the store itself (`data/ff.db`), while a
 *     format's live in a copy of it (`features.db`) so `train_projection.py --db <that>` needs no
 *     python change.
 *   - `fold-artifacts`: the root's blind-artifact directory carries the D16 suffix it was built with.
 */
const FORMAT_ARTIFACTS = {
  "history-points": { root: "history-points.csv", fmt: "history-points.csv", what: "the frozen backtest season target" },
  "history-weekly": { root: "history-weekly.csv", fmt: "history-weekly.csv", what: "the frozen backtest weekly target" },
  "current-actuals": { root: "current-actuals.csv", fmt: "current-actuals.csv", what: "the live season's re-scored actuals" },
  "features-db": { root: "ff.db", fmt: "features.db", what: "the feature tables the projector trains on" },
  projection: { root: "projection-artifact.json", fmt: "projection-artifact.json", what: "the season projector" },
  "fold-artifacts": { root: "fold-artifacts-d16", fmt: "fold-artifacts", what: "one blind projection artifact per held-out season" },
  weekly: { root: CHALLENGER_WEEKLY_ARTIFACT, fmt: CHALLENGER_WEEKLY_ARTIFACT, what: "the weekly FORM model (the served challenger)" },
  "weekly-lineonly": { root: SHIPPED_WEEKLY_ARTIFACT, fmt: SHIPPED_WEEKLY_ARTIFACT, what: "the season-line-only weekly floor" },
  streaming: { root: "streaming-artifact.json", fmt: "streaming-artifact.json", what: "the two-part streaming model" },
  "dst-stream": { root: "dst-stream-artifact.json", fmt: "dst-stream-artifact.json", what: "the DST streaming model" },
  variance: { root: "variance-model.json", fmt: "variance-model.json", what: "the per-position season variance fit" },
  "rank-outcomes": { root: "rank-outcomes.json", fmt: "rank-outcomes.json", what: "the preseason-rank outcome pools" },
  correlation: { root: "correlation-model.json", fmt: "correlation-model.json", what: "the teammate correlation fit" },
  points: { root: "points.csv", fmt: "points.csv", what: "the served season projection pool" },
  values: { root: "values.csv", fmt: "values.csv", what: "the served value book" },
  "def-ratings": { root: "def-ratings.csv", fmt: "def-ratings.csv", what: "per-defense strength ratings" },
  golden: { root: "golden.json", fmt: "golden.json", what: "this format's championship gate number" },
  scoring: { root: "scoring.json", fmt: "scoring.json", what: "the scoring preimage of the format key" },
  manifest: { root: "manifest.json", fmt: "manifest.json", what: "what built this format dir, and how honestly" },
} as const;

export type ArtifactName = keyof typeof FORMAT_ARTIFACTS;
export const ARTIFACT_NAMES = Object.keys(FORMAT_ARTIFACTS) as ArtifactName[];

/**
 * SHARED-NFL artifacts: fitted on facts about FOOTBALL, not about a ruleset, so one copy at the root
 * serves every format and a per-format copy would be a second fit of the same thing.
 *
 * Each of these was checked individually rather than assumed (F-7): injury duration is games missed;
 * opponent correlation and the age curve are in RATIO form; the opportunity model is a usage factor;
 * `ros-blend.json`'s K is asserted to be an NFL-level stabilization constant (D18, and the design doc
 * says so explicitly); the nflverse cache is raw feed bytes; `ff.db` is the shared component substrate
 * plus every per-LEAGUE table, which is keyed by `league_id`, not by format.
 */
const SHARED_ARTIFACTS = {
  "injury-duration": "injury-duration-artifact.json",
  "opponent-correlation": "opponent-correlation.json",
  "age-curve": "age-curve.json",
  "opportunity-model": "opportunity-model.json",
  "ros-blend": "ros-blend.json",
  "nflverse-cache": "cache",
  store: "ff.db",
} as const;

export type SharedArtifactName = keyof typeof SHARED_ARTIFACTS;

// =================================================================================================
// THE HANDLE
// =================================================================================================

export type FormatProvenance = "incumbent-root" | "format-dir";

export interface ModelHandle {
  /** The directory this format's artifacts live in: `data/` for the incumbent, `data/formats/<key>/`
   *  otherwise. Absolute-or-relative exactly as `dataPath` produces. */
  readonly dir: string;
  readonly scoringKey: string;
  readonly provenance: FormatProvenance;
  /** The resolved path for an artifact. Says nothing about whether it EXISTS -- a writer needs the
   *  path of a file that does not exist yet. Readers use `require`. */
  path(name: ArtifactName): string;
  /** Does this format own this artifact today? */
  has(name: ArtifactName): boolean;
  /** The path, or a refusal that NAMES the format and the artifact. The whole point: a consumer that
   *  cannot serve a format says which format and which file, instead of reading the root's copy. */
  require(name: ArtifactName): string;
  /** A root-resident, NFL-level artifact. Same path for every format, by design. */
  shared(name: SharedArtifactName): string;
  /** Every artifact this format owns, for a report or a status verb. */
  inventory(): { name: ArtifactName; path: string; present: boolean; what: string }[];
}

class Handle implements ModelHandle {
  constructor(readonly dir: string, readonly scoringKey: string, readonly provenance: FormatProvenance) {}
  path(name: ArtifactName): string {
    const a = FORMAT_ARTIFACTS[name];
    if (!a) throw new Error(`formatResolve: no artifact named "${name}" (have: ${ARTIFACT_NAMES.join(", ")})`);
    return this.provenance === "incumbent-root" ? dataPath(a.root) : join(this.dir, a.fmt);
  }
  has(name: ArtifactName): boolean { return existsSync(this.path(name)); }
  require(name: ArtifactName): string {
    const p = this.path(name);
    if (existsSync(p)) return p;
    const a = FORMAT_ARTIFACTS[name];
    throw new Error(
      `format ${this.scoringKey} has no ${name} artifact (${a.what}): ${p} does not exist. ` +
      (this.provenance === "incumbent-root"
        ? "This is the INCUMBENT format, so the file belongs at the data/ root -- rebuild it (see docs/, `ff models`)."
        : `Build it into ${this.dir} (\`node --import tsx scripts/build-format-features.mjs --league <id>\` for the ` +
          "target/features, then tools/train_projection.py for the artifacts). Nothing here falls back to the " +
          "data/ root: the root's copy is another format's numbers."),
    );
  }
  shared(name: SharedArtifactName): string {
    const f = SHARED_ARTIFACTS[name];
    if (!f) throw new Error(`formatResolve: no shared artifact named "${name}" (have: ${Object.keys(SHARED_ARTIFACTS).join(", ")})`);
    return dataPath(f);
  }
  inventory(): { name: ArtifactName; path: string; present: boolean; what: string }[] {
    return ARTIFACT_NAMES.map((n) => ({ name: n, path: this.path(n), present: this.has(n), what: FORMAT_ARTIFACTS[n].what }));
  }
}

/** The incumbent handle -- `data/` root. Exported because a few pure/legacy call sites (a test
 *  fixture, a script with no store) genuinely mean "the incumbent", and saying so is better than
 *  reaching for `dataPath` and leaving no trace of the decision. */
export const INCUMBENT_MODEL: ModelHandle = new Handle(DATA_ROOT, INCUMBENT_SCORING_KEY, "incumbent-root");

// =================================================================================================
// THE SPEC + THE RESOLVE
// =================================================================================================

/** The format-relevant slice of a league's config -- the ruleset identity, with nothing about the
 *  league's name, owners or sync timestamps in it. */
export interface FormatSpec {
  scoring: ScoringRules;
  kicker: KickerRules | null;
  defense: DefenseRules | null;
  teams: number;
  budget: number;
  slots: string[];
  draftType: "auction" | "snake";
  /** The emitted roster economics -- dedicated counts + flex GROUPS. What `valueKey` hashes. */
  value: ValueLeague;
  /** The playoff calendar block, or null when the league has never synced one. */
  calendar: AppConfig["format"];
}

export interface ResolvedFormat {
  leagueId: string | null;
  spec: FormatSpec;
  scoringKey: string;
  valueKey: string;
  formatKey: string;
  model: ModelHandle;
  provenance: FormatProvenance;
}

const asKeyable = (cfg: AppConfig): KeyableConfig => ({
  teams: cfg.teams,
  budget: cfg.budget,
  slots: cfg.slots,
  draftType: cfg.draftType,
  scoring_rules: cfg.scoring_rules,
  kicker: (cfg as unknown as { kicker?: KickerRules | null }).kicker ?? null,
  defense: (cfg as unknown as { defense?: DefenseRules | null }).defense ?? null,
  format: cfg.format as KeyableConfig["format"],
});

/** The directory a non-incumbent key lives in. One spelling, so a script and the resolver cannot
 *  disagree about where a format dir is. */
export function formatDir(key: string): string {
  return dataPath(join("formats", key));
}

/**
 * THE PREIMAGE CHECK (F-5). A directory NAME is a claim; `scoring.json` is the evidence.
 *
 * Re-hash the rules the dir declares and require the result to equal the dir name. Without this, a
 * hand-copied or half-migrated directory serves a model fitted under rules nobody can name, and the
 * only thing asserting otherwise is the folder's own title.
 */
export function checkPreimage(dir: string, key: string): { ok: true } | { ok: false; why: string } {
  const p = join(dir, FORMAT_ARTIFACTS.scoring.fmt);
  if (!existsSync(p)) {
    return { ok: false, why: `${p} is missing -- the directory name ${key} is an unverifiable claim without it` };
  }
  let doc: { rules?: ScoringRules; kicker?: KickerRules | null; defense?: DefenseRules | null };
  try { doc = JSON.parse(readFileSync(p, "utf8")); } catch (e) {
    return { ok: false, why: `${p} is unparseable: ${(e as Error).message}` };
  }
  if (!doc || typeof doc !== "object" || !doc.rules) {
    return { ok: false, why: `${p} carries no \`rules\` object, so there is nothing to re-hash` };
  }
  const got = scoringKeyFor({ rules: doc.rules, kicker: doc.kicker ?? null, defense: doc.defense ?? null });
  if (got !== key) {
    return { ok: false, why: `${p} re-hashes to ${got}, not ${key} -- the directory holds a model fitted under DIFFERENT rules than its name claims` };
  }
  return { ok: true };
}

/**
 * RESOLVE the format for a league (default: the ACTIVE league).
 *
 * Throws when a non-incumbent key has no built, verified directory. That refusal is the feature: a
 * silent fall back to `data/` is how an unbuilt format gets served the incumbent's numbers.
 */
export function resolveFormat(db: DB, leagueId?: string | null): ResolvedFormat {
  const ctx = resolveLeagueContext(db, leagueId);
  return resolveFormatForConfig(ctx.config, ctx.leagueId);
}

/** The pure half -- a config in, a resolved format out. Separated so a test can resolve a config that
 *  no store holds, and so `resolveFormat` is nothing but "get the config, then this". */
export function resolveFormatForConfig(cfg: AppConfig, leagueId: string | null): ResolvedFormat {
  const keyable = asKeyable(cfg);
  const sk = scoringKeyFor({ rules: keyable.scoring_rules, kicker: keyable.kicker, defense: keyable.defense });
  const spec: FormatSpec = {
    scoring: cfg.scoring_rules,
    kicker: keyable.kicker ?? null,
    defense: keyable.defense ?? null,
    teams: cfg.teams,
    budget: cfg.budget,
    slots: cfg.slots,
    draftType: cfg.draftType ?? "auction",
    value: resolveValueLeague({ teams: cfg.teams, budget: cfg.budget, slots: cfg.slots }),
    calendar: cfg.format,
  };
  const common = { leagueId, spec, scoringKey: sk, valueKey: valueKey(keyable), formatKey: formatKey(keyable) };

  if (sk === INCUMBENT_SCORING_KEY) {
    // RULE 1, THE INCUMBENT ALIAS -- asserted, not assumed. `INCUMBENT_SCORING_KEY` is already checked
    // against DEFAULT_SCORING at formatKey.ts's module load; this branch is reached only BECAUSE the
    // league's own stored rules hash to it, so arriving here IS the assertion that the league's config
    // and the pinned constant agree. The inverse -- an ESPN league whose config drifted -- lands in the
    // branch below and gets a named throw ("no data/formats/sc-xxxx") rather than the root's files.
    return { ...common, model: INCUMBENT_MODEL, provenance: "incumbent-root" };
  }

  const dir = formatDir(sk);
  if (!existsSync(dir)) {
    throw new Error(
      `league ${leagueId ?? "?"} scores as ${sk}, and no model has been built for that format: ${dir} does not exist.\n` +
      `  Build it:  node --import tsx scripts/build-format-features.mjs --league ${leagueId ?? "<id>"}\n` +
      `  then train: uv run --with scikit-learn --with numpy tools/train_projection.py --db ${join(dir, "features.db")} --out ${join(dir, "projection-artifact.json")}\n` +
      `  There is deliberately NO fallback to the data/ root -- the root holds format ${INCUMBENT_SCORING_KEY}'s ` +
      "numbers, and serving them here would be this league's dollar signs on another format's model.",
    );
  }
  const pre = checkPreimage(dir, sk);
  if (!pre.ok) {
    throw new Error(
      `league ${leagueId ?? "?"} resolves to format ${sk}, but that directory does not verify: ${pre.why}.\n` +
      "  Re-write the preimage with: node --import tsx scripts/build-format-target.mjs --league " +
      `${leagueId ?? "<id>"} (it writes scoring.json + manifest.json), or delete the directory and rebuild it.`,
    );
  }
  return { ...common, model: new Handle(dir, sk, "format-dir"), provenance: "format-dir" };
}
