/**
 * THE INJURY HORIZON: P(he misses the next k games), for k in 1..4, from what was knowable Friday.
 *
 * The serving half of `tools/train_injury_duration.py`. Pure -- no file reads, no clock -- so the
 * copilot and a test can be shown to evaluate identically, which is worth nothing if either side
 * can reach for a file. `loadInjuryHorizonArtifact` does the reading and the refusing.
 *
 * WHY THIS EXISTS. `missProb` (rosterValue.ts) and `leadMissProb` (handcuff.ts) answer "will he play
 * this week" with the variance model's per-tier games/17. That number is not conditional on anything
 * about the man's actual situation: a top-tier RB is 0.13 whether he is healthy or has been Out for
 * three weeks with a foot. Measured on the men who are ACTUALLY ON THE REPORT it is not merely
 * imprecise, it is far worse than a constant -- nested log loss 0.92 at k=1 against 0.35 for this
 * model and 0.40 for a designation-only baseline. That is not a criticism of the variance model,
 * which was fitted to answer a different, unconditional question; it is the reason a conditional
 * question needs a conditional model.
 *
 * WHAT IT IS NOT. It is not a projection of his points, and it is not a diagnosis. Feed it a
 * designation, a practice status, an injury label and how long the episode has already run, and it
 * returns four probabilities. It knows nothing about a man not on the report -- there is no row for
 * him and `horizonFor` returns null rather than a small number that looks like an answer.
 *
 * THE GOLDEN BLOCK IS THE CONTRACT. The trainer emits six fixture rows with its own probabilities
 * and this file recomputes them at 1e-6. It is the only test where the two implementations are
 * independent, which is the only kind that catches a transform the two sides read differently --
 * the producer-consumer drift this repo has a scar from.
 */

import { existsSync, readFileSync } from "node:fs";
import { openDb } from "../db/db.js";
import { dataPath } from "../data/paths.js";
import { normPos } from "../data/stgPlayer.js";
import { injuryGroup } from "../features/sources/injuryDuration.js";
import { espnStatusToReport } from "../features/sources/weekContext.js";

/** THE PUBLISHED DICTIONARY of fields a feature spec may name. An artifact naming anything else is
 *  REFUSED, so a renamed column is an error rather than a coefficient that silently contributes 0. */
export const HORIZON_FIELDS = [
  "designation", "practice_status", "injury_group", "pos",
  "weeks_missed_so_far", "weeks_in_episode", "prior_episodes_same", "prior_episodes_any",
  "age", "injury_secondary_present",
] as const;
export type HorizonField = typeof HORIZON_FIELDS[number];

export type HorizonTransform = "eq" | "not_in" | "clip" | "center";

export interface HorizonSpec {
  name: string;
  transform: HorizonTransform;
  field: HorizonField;
  /** "eq": the value the field must equal for the indicator to fire. */
  value?: string | number;
  /** "not_in": the indicator fires when the field is NOT one of these. It is an indicator over a
   *  COMPLEMENT rather than a dropped row, so an injury string the fit never saw lands in a bucket
   *  with a coefficient instead of silently becoming the reference category. */
  values?: string[];
  clipLo?: number;
  clipHi?: number;
  center?: number;
  scale?: number;
  /** The POST-TRANSFORM value for a null input. Explicit, for the reason projector.ts states: a
   *  missing input silently becoming 0 is a guess wearing the costume of a default. */
  missing?: number;
}

export type Horizon = 1 | 2 | 3 | 4;
export const HORIZONS: Horizon[] = [1, 2, 3, 4];

export interface HorizonRow {
  designation?: string | null;
  practice_status?: string | null;
  injury_group?: string | null;
  pos?: string | null;
  weeks_missed_so_far?: number | null;
  weeks_in_episode?: number | null;
  prior_episodes_same?: number | null;
  prior_episodes_any?: number | null;
  age?: number | null;
  injury_secondary_present?: number | null;
}

export interface HorizonGolden { f: HorizonRow; expect: Record<string, number> }

export interface InjuryHorizonArtifact {
  schema: number;
  kind: "injury_duration";
  fittedFrom: string;
  fittedAt?: string;
  seasons: number[];
  holdoutSeason: number | null;
  horizons: number[];
  features: HorizonSpec[];
  coef: Record<string, Record<string, number>>;
  /** The designation-only baseline, fitted by the same code path, carried ON the artifact so the
   *  comparison the consumer prints cannot be against a differently-fitted straw man. */
  baselineDesignation?: Record<string, Record<string, number>>;
  baselineFeatures?: HorizonSpec[];
  trainRows?: Record<string, number>;
  golden?: HorizonGolden[];
  notes?: string;
}

const SCHEMA = 1;

/** One spec against one row. Exported so the golden check and the evaluator cannot become two
 *  implementations of the same transform. Mirrors `feature_value` in the trainer, line for line. */
export function horizonFeatureValue(spec: HorizonSpec, row: HorizonRow): number {
  const raw = (row as Record<string, unknown>)[spec.field];
  if (spec.transform === "eq") return raw === spec.value ? 1 : 0;
  if (spec.transform === "not_in") {
    return typeof raw === "string" && (spec.values ?? []).includes(raw) ? 0 : 1;
  }
  const miss = spec.missing ?? 0;
  if (raw == null || typeof raw !== "number" || !Number.isFinite(raw)) return miss;
  let x = raw;
  if (spec.clipLo != null) x = Math.max(spec.clipLo, x);
  if (spec.clipHi != null) x = Math.min(spec.clipHi, x);
  if (spec.transform === "clip") return x;
  if (spec.transform === "center") {
    const s = spec.scale ?? 1;
    return s === 0 ? miss : (x - (spec.center ?? 0)) / s;
  }
  return miss;
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, z))));

function evalHead(coef: Record<string, number>, specs: HorizonSpec[], row: HorizonRow): number {
  let lin = coef.intercept ?? 0;
  for (const s of specs) lin += (coef[s.name] ?? 0) * horizonFeatureValue(s, row);
  return sigmoid(lin);
}

export interface HorizonPrediction {
  /** P(he misses the next k games), k = 1..4. */
  p: Record<Horizon, number>;
  /** Expected GAMES missed over the next four, = sum_k P(miss next k). It is exactly that sum
   *  because P(misses at least k of the next four consecutively from now) sums to the expectation
   *  of a run length truncated at four -- and it is truncated, so it is a FLOOR on a long injury,
   *  not an estimate of one. A man who will miss the rest of the season reads 4.0. */
  expectedGamesOut4: number;
  /** The same four probabilities from the DESIGNATION-ONLY baseline, where the artifact carries it.
   *  Present so a consumer can print what the extra features changed rather than assert it. */
  baseline?: Record<Horizon, number>;
}

/** Evaluate one row. Pure. */
export function horizonFor(a: InjuryHorizonArtifact, row: HorizonRow): HorizonPrediction {
  const p = {} as Record<Horizon, number>;
  for (const k of HORIZONS) p[k] = evalHead(a.coef[String(k)] ?? {}, a.features, row);
  const out: HorizonPrediction = {
    p, expectedGamesOut4: HORIZONS.reduce((s, k) => s + p[k], 0),
  };
  if (a.baselineDesignation && a.baselineFeatures) {
    const b = {} as Record<Horizon, number>;
    for (const k of HORIZONS) b[k] = evalHead(a.baselineDesignation[String(k)] ?? {}, a.baselineFeatures, row);
    out.baseline = b;
  }
  return out;
}

/**
 * LOAD AND VALIDATE. An artifact this evaluator cannot FULLY evaluate is REFUSED, loudly.
 *
 * The quiet failure being prevented: a renamed field, an unknown transform or a missing horizon all
 * degrade to "that coefficient contributes 0", which produces a slightly different probability and
 * no error. A horizon that is silently 20% short is far more expensive than one that will not load.
 */
export function loadInjuryHorizonArtifact(json: unknown, opts: { checkGolden?: boolean; tol?: number } = {}): InjuryHorizonArtifact {
  const bad = (m: string): never => { throw new Error(`injury duration artifact: ${m}`); };
  const a = json as InjuryHorizonArtifact;
  if (!a || typeof a !== "object") bad("not an object");
  if (a.kind !== "injury_duration") bad(`kind is ${JSON.stringify(a.kind)}, expected "injury_duration"`);
  if (Number(a.schema) !== SCHEMA) bad(`schema ${a.schema}, this evaluator understands ${SCHEMA}`);
  if (!Array.isArray(a.features) || !a.features.length) bad("no features");
  const seen = new Set<string>();
  for (const s of a.features) {
    if (!s.name || seen.has(s.name)) bad(`duplicate or missing feature name ${JSON.stringify(s.name)}`);
    seen.add(s.name);
    if (!(HORIZON_FIELDS as readonly string[]).includes(s.field)) {
      bad(`feature ${s.name} names field ${JSON.stringify(s.field)}, which is not in HORIZON_FIELDS ` +
        `-- either the trainer renamed a column or this evaluator is behind it, and both would ` +
        `otherwise show up as a coefficient quietly contributing zero`);
    }
    if (!["eq", "not_in", "clip", "center"].includes(s.transform)) bad(`feature ${s.name} has unknown transform ${JSON.stringify(s.transform)}`);
    if (s.transform === "eq" && s.value === undefined) bad(`feature ${s.name} is "eq" with no value`);
    if (s.transform === "not_in" && !Array.isArray(s.values)) bad(`feature ${s.name} is "not_in" with no values`);
    if (s.transform === "center" && (s.center == null || s.scale == null)) bad(`feature ${s.name} is "center" with no centre/scale`);
  }
  for (const k of HORIZONS) {
    const c = a.coef?.[String(k)];
    if (!c || typeof c !== "object") bad(`no coefficients for horizon k=${k}`);
    for (const s of a.features) {
      if (typeof c[s.name] !== "number" || !Number.isFinite(c[s.name])) {
        bad(`horizon k=${k} has no finite coefficient for ${s.name} -- a partial head evaluates as ` +
          `if that feature were zero for every player, which is a different model with no error`);
      }
    }
  }
  if (opts.checkGolden !== false && a.golden?.length) checkHorizonGolden(a, opts.tol ?? 1e-6);
  return a;
}

/** Recompute the trainer's own fixtures with THIS evaluator. See the header: it is the only check
 *  where the two implementations are independent. */
export function checkHorizonGolden(a: InjuryHorizonArtifact, tol = 1e-6): void {
  for (const [i, g] of (a.golden ?? []).entries()) {
    const got = horizonFor({ ...a, golden: [] }, g.f);
    for (const k of HORIZONS) {
      const want = g.expect[String(k)];
      if (want == null) continue;
      if (Math.abs(got.p[k] - want) > tol) {
        throw new Error(
          `injury duration artifact: golden row ${i} horizon k=${k} -- trainer said ${want}, ` +
          `this evaluator says ${got.p[k]} (tol ${tol})`);
      }
    }
  }
}

// ==================================================================================================
// THE STORE SIDE. Kept out of the pure evaluator above so a test can drive the model with no db.
// ==================================================================================================

export const INJURY_HORIZON_ARTIFACT = "injury-duration-artifact.json";

/** Load the shipped artifact from data/, or null where it has not been fitted. A missing model is
 *  reported by the caller as an assumption ("tier rate, no injury model on file"), never silently
 *  replaced by one -- which is exactly how `opportunity-model.json` used to degrade. */
export function loadShippedHorizonArtifact(dataPathOf: (f: string) => string, read: (p: string) => string, exists: (p: string) => boolean): InjuryHorizonArtifact | null {
  const p = dataPathOf(INJURY_HORIZON_ARTIFACT);
  if (!exists(p)) return null;
  return loadInjuryHorizonArtifact(JSON.parse(read(p)));
}

export interface LiveEpisode extends HorizonRow {
  playerSk: number | null;
  name: string;
  season: number;
  week: number;
  /** Where the row came from: "archive" (feat_injury_horizon, dated filings) or "live" (the store's
   *  ESPN status plus the news table's injury detail). Travels into `assumptions` because the two
   *  are NOT the same evidence and a consumer must be able to say which it used. */
  source: "archive" | "live";
}

/** One player's horizon, as a decision surface reads it. */
export interface InjuryOutlook {
  nameKey: string;
  name: string;
  designation: string;
  injuryGroup: string;
  /** The injury as the feed wrote it ("Knee - ACL"), for display. Never parsed for the model. */
  detail: string;
  p: Record<Horizon, number>;
  expectedGamesOut4: number;
  /** The designation-only baseline's expectation, from the artifact's own baseline block. */
  baselineExpectedGamesOut4: number | null;
  source: "archive" | "live";
}

export interface InjuryOutlookSet {
  artifactPresent: boolean;
  source: "archive" | "live" | "none";
  asOf: string | null;
  byName: Map<string, InjuryOutlook>;
  /**
   * THE NUMBER THIS REPLACES, kept callable so a consumer can print both rather than assert an
   * improvement. It is `missProb` from rosterValue.ts and `leadMissProb` from handcuff.ts -- the
   * same function, ported nowhere: the variance model is read here and the arithmetic is the one
   * line those two already share.
   */
  tierMissProb: (pos: string, poolRankFrac: number) => number;
  /** One sentence for `assumptions.basisNote`. Says which evidence was used and what is missing. */
  note: string;
}

/** The empty set: no artifact, no rows, and a tier rate that still works. Returned rather than null
 *  so a consumer never has to branch on undefined and never silently gets a different code path. */
export function emptyOutlookSet(tierMissProb: (pos: string, f: number) => number, note: string): InjuryOutlookSet {
  return { artifactPresent: false, source: "none", asOf: null, byName: new Map(), tierMissProb, note };
}

/**
 * BUILD THE OUTLOOK SET FOR ONE (season, week), FROM WHICHEVER EVIDENCE EXISTS.
 *
 * TWO SOURCES, AND THEY ARE NOT THE SAME EVIDENCE, so the set records which it used:
 *
 *   "archive"  feat_injury_horizon rows for that exact (season, week). Dated filings, read at this
 *              team's own Friday cutoff. Available 2010-2024 and nowhere else, because the feed
 *              stopped publishing a report date in 2025.
 *   "live"     `player_status` (ESPN's designation plus `injury_body`, which is the injury type the
 *              archive's report_primary_injury carries) escalated by high-severity `news` rows --
 *              the SAME two feeds the lineup optimizer's OUT refusal reads, deliberately, so a man
 *              the lineup refuses to start and a man the handcuff board prices as likely out cannot
 *              be different men.
 *
 * WHAT THE LIVE PATH CANNOT SUPPLY, stated rather than guessed: PRACTICE STATUS. A live status feed
 * publishes a designation, not Wednesday and Friday participation -- and the ablation in
 * docs/validation.md puts practice status at 0.026 of log loss at k=1, the largest single block
 * after the designation itself. So a live outlook is the model running with `practice_status` at its
 * declared missing value, which is materially weaker than an archive one, and `note` says so.
 */
export function loadInjuryOutlook(opts: {
  dbPath?: string;
  season: number;
  /** The week the decision is about. Omitted, it is the earliest week whose first kickoff is still
   *  AHEAD -- the same point-in-time rule buildLiveWeekContext applies, and for the same reason:
   *  once a game has been played, today's designations are contaminated by it. */
  week?: number;
  /** Injected by tests. Defaults to the shipped artifact under data/. */
  artifact?: InjuryHorizonArtifact | null;
  /** Injectable clock, so the week rule is testable without waiting for Sunday. */
  now?: string;
}): InjuryOutlookSet {
  // Imported lazily-by-module (static imports, evaluated once) rather than passed in, because the
  // two call sites in copilot.ts are synchronous and take no store handle.
  const tier = tierMissProbFrom(readVarianceModel());
  let a: InjuryHorizonArtifact | null;
  if (opts.artifact !== undefined) a = opts.artifact;
  else a = readShippedArtifact();
  if (!a) {
    return emptyOutlookSet(tier,
      "no injury-duration artifact on file (data/" + INJURY_HORIZON_ARTIFACT + ") -- every miss " +
      "probability below is the variance model's per-tier season availability, which knows the " +
      "player's tier and nothing about any injury he has. Fit it with tools/train_injury_duration.py.");
  }

  const db = openDb(opts.dbPath);
  try {
    const week = opts.week ?? imminentWeek(db, opts.season, opts.now) ?? 1;
    const nameOf = new Map<number, { nk: string; name: string; pos: string }>();
    const skOfName = new Map<string, number>();
    for (const r of db.prepare(
      "SELECT player_sk, name_key, name, position FROM stg_player WHERE name_key IS NOT NULL AND COALESCE(ambiguous, 0) = 0",
    ).all() as { player_sk: number; name_key: string; name: string | null; position: string | null }[]) {
      nameOf.set(Number(r.player_sk), { nk: r.name_key, name: r.name ?? r.name_key, pos: normPos(r.position ?? "") });
      if (!skOfName.has(r.name_key)) skOfName.set(r.name_key, Number(r.player_sk));
    }

    // ---- ARCHIVE ----------------------------------------------------------------------------
    const arch = db.prepare(
      `SELECT * FROM feat_injury_horizon WHERE season = ? AND week = ?`,
    ).all(opts.season, week) as Record<string, string | number | null>[];
    if (arch.length) {
      const byName = new Map<string, InjuryOutlook>();
      for (const r of arch) {
        const id = nameOf.get(Number(r.player_sk));
        if (!id) continue;
        const e: LiveEpisode = {
          playerSk: Number(r.player_sk), name: id.name, season: opts.season, week: week,
          source: "archive",
          designation: String(r.designation ?? ""), practice_status: String(r.practice_status ?? ""),
          injury_group: String(r.injury_group ?? ""), pos: String(r.pos ?? id.pos),
          weeks_missed_so_far: Number(r.weeks_missed_so_far ?? 0),
          weeks_in_episode: Number(r.weeks_in_episode ?? 0),
          prior_episodes_same: Number(r.prior_episodes_same ?? 0),
          prior_episodes_any: Number(r.prior_episodes_any ?? 0),
          age: r.age == null ? null : Number(r.age),
          injury_secondary_present: Number(r.injury_secondary_present ?? 0),
        };
        (e as { detail?: string }).detail = String(r.injury_primary ?? "");
        byName.set(id.nk, outlookFrom(a, e, id.nk));
      }
      return {
        artifactPresent: true, source: "archive", asOf: String(arch[0].as_of ?? "") || null, byName,
        tierMissProb: tier,
        note: `${byName.size} injury horizons from feat_injury_horizon, season ${opts.season} week ` +
          `${week}, read at each team's own Friday cutoff. Archive rows carry practice status.`,
      };
    }

    // ---- LIVE -------------------------------------------------------------------------------
    interface Live { report: string | null; body: string; from: string }
    const live = new Map<string, Live>();
    for (const r of db.prepare(
      "SELECT player_id, injury_status, injury_body FROM player_status WHERE injury_status IS NOT NULL AND injury_status <> ''",
    ).all() as { player_id: string; injury_status: string | null; injury_body: string | null }[]) {
      const rep = espnStatusToReport(r.injury_status);
      if (!rep) continue;
      live.set(r.player_id, { report: rep, body: String(r.injury_body ?? ""), from: "player_status" });
    }
    // News ESCALATES only, never clears -- the same rule buildLiveWeekContext and `loadAvailability`
    // follow, so the three surfaces cannot disagree about who can play.
    for (const r of db.prepare(
      "SELECT player_id, severity, detail FROM news WHERE category = 'injury'",
    ).all() as { player_id: string | null; severity: string | null; detail: string | null }[]) {
      if (String(r.severity ?? "").toLowerCase() !== "high" || !r.player_id) continue;
      const cur = live.get(r.player_id);
      if (cur?.report === "Out") continue;
      live.set(r.player_id, { report: "Out", body: cur?.body || String(r.detail ?? ""), from: "news(injury/high)" });
    }

    // Episode history for the live rows: games already missed THIS season, and prior episodes in the
    // two seasons before it. Both are strictly past information; where the season has no play record
    // yet they are honestly zero rather than absent.
    const missedSoFar = new Map<number, number>();
    for (const r of db.prepare(
      `SELECT player_sk, COUNT(*) n FROM feat_player_week
       WHERE season = ? AND week < ? AND COALESCE(is_bye, 0) = 0 AND pts IS NULL AND player_sk IS NOT NULL
       GROUP BY player_sk`,
    ).all(opts.season, week) as { player_sk: string; n: number }[]) {
      missedSoFar.set(Number(r.player_sk), Number(r.n));
    }
    const priorAny = new Map<number, number>(), priorGroup = new Map<string, number>();
    for (const r of db.prepare(
      "SELECT player_sk, injury_group, COUNT(*) n FROM fact_injury_episode WHERE season >= ? AND season < ? GROUP BY player_sk, injury_group",
    ).all(opts.season - 2, opts.season) as { player_sk: number; injury_group: string; n: number }[]) {
      priorAny.set(Number(r.player_sk), (priorAny.get(Number(r.player_sk)) ?? 0) + Number(r.n));
      priorGroup.set(`${r.player_sk}|${r.injury_group}`, Number(r.n));
    }
    const birth = new Map<number, string>();
    for (const r of db.prepare(
      "SELECT player_sk, birthdate FROM player_identity WHERE birthdate IS NOT NULL AND birthdate <> ''",
    ).all() as { player_sk: number; birthdate: string }[]) birth.set(Number(r.player_sk), r.birthdate);
    const today = new Date().toISOString().slice(0, 10);

    const byName = new Map<string, InjuryOutlook>();
    for (const [nk, l] of live) {
      const sk = skOfName.get(nk) ?? null;
      const id = sk != null ? nameOf.get(sk) : undefined;
      const group = injuryGroup(l.body);
      const bd = sk != null ? birth.get(sk) : undefined;
      const e: LiveEpisode = {
        playerSk: sk, name: id?.name ?? nk, season: opts.season, week: week, source: "live",
        designation: l.report ?? "",
        // NOT AVAILABLE LIVE, and left at the model's declared missing value rather than guessed at
        // "DNP because he is Out" -- which would be a designation being counted twice.
        practice_status: "",
        injury_group: group, pos: id?.pos ?? "",
        weeks_missed_so_far: sk != null ? (missedSoFar.get(sk) ?? 0) : 0,
        weeks_in_episode: 0,
        prior_episodes_same: sk != null ? (priorGroup.get(`${sk}|${group}`) ?? 0) : 0,
        prior_episodes_any: sk != null ? (priorAny.get(sk) ?? 0) : 0,
        age: bd ? Math.round(((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${bd}T00:00:00Z`)) / (365.2425 * 864e5)) * 100) / 100 : null,
        injury_secondary_present: 0,
      };
      (e as { detail?: string }).detail = l.body;
      byName.set(nk, outlookFrom(a, e, nk));
    }
    return {
      artifactPresent: true, source: byName.size ? "live" : "none", asOf: today, byName,
      tierMissProb: tier,
      note: byName.size
        ? `${byName.size} injury horizons from the LIVE feeds (player_status designations plus ` +
          `high-severity news), season ${opts.season} week ${week}. feat_injury_horizon has no ` +
          `row for this week: the archive stopped carrying report dates after 2024. PRACTICE STATUS ` +
          `IS NOT AVAILABLE from these feeds and is left at the model's missing value, which is the ` +
          `largest block the live path gives up (0.026 of log loss at k=1).`
        : `no injury designations in the live feeds and no archive row for season ${opts.season} ` +
          `week ${week} -- every miss probability below is the per-tier season availability.`,
    };
  } finally { db.close(); }
}

/** The earliest week whose first kickoff is still AHEAD of `now`. Null where the season holds no
 *  dated games or every week has kicked off -- the caller then falls back to week 1 rather than
 *  guessing a week in the middle. Same rule as buildLiveWeekContext, for the same reason: a
 *  designation read after a week's first kickoff belongs to the NEXT week. */
function imminentWeek(db: ReturnType<typeof openDb>, season: number, now?: string): number | null {
  const today = (now ?? new Date().toISOString()).slice(0, 10);
  const rows = db.prepare(
    "SELECT week, MIN(gameday) d FROM raw_nfl_game WHERE season = ? AND game_type = 'REG' AND gameday IS NOT NULL GROUP BY week ORDER BY week",
  ).all(season) as { week: number; d: string }[];
  for (const r of rows) if (String(r.d) > today) return Number(r.week);
  return null;
}

function readShippedArtifact(): InjuryHorizonArtifact | null {
  const p = dataPath(INJURY_HORIZON_ARTIFACT);
  if (!existsSync(p)) return null;
  return loadInjuryHorizonArtifact(JSON.parse(readFileSync(p, "utf8")));
}

function readVarianceModel(): { tiers?: number; pos: Record<string, { avail: number[] }> } | null {
  const p = dataPath("variance-model.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/** THE OLD NUMBER. Identical arithmetic to `missProb` (rosterValue.ts) and `leadMissProb`
 *  (handcuff.ts), including the bye correction -- reproduced here only because this module must be
 *  able to report it beside the model's answer without importing a season simulator. */
function tierMissProbFrom(vm: { tiers?: number; pos: Record<string, { avail: number[] }> } | null) {
  return (pos: string, poolRankFrac: number): number => {
    const m = vm?.pos?.[pos];
    if (!m) return 0.13;
    const tiers = vm?.tiers ?? m.avail.length;
    const tier = Math.min(m.avail.length - 1, Math.max(0, Math.floor((poolRankFrac || 0) * tiers)));
    const perPlayable = Math.min(1, (m.avail[tier] ?? 0.85) / (16 / 17));
    return Math.max(0, Math.min(1, 1 - perPlayable));
  };
}

/** Turn one point-in-time row into an outlook. Pure; the store side calls it. */
export function outlookFrom(a: InjuryHorizonArtifact, e: LiveEpisode, nk: string): InjuryOutlook {
  const h = horizonFor(a, e);
  return {
    nameKey: nk, name: e.name,
    designation: e.designation ?? "",
    injuryGroup: e.injury_group ?? "",
    detail: (e as { detail?: string }).detail ?? "",
    p: h.p,
    expectedGamesOut4: h.expectedGamesOut4,
    baselineExpectedGamesOut4: h.baseline ? HORIZONS.reduce((s, k) => s + h.baseline![k], 0) : null,
    source: e.source,
  };
}
