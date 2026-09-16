// FORMAT KEYS -- the content hashes that let two leagues SHARE a model when their rules match, and
// force a new model only where they genuinely differ (docs/multi-format-design.md, "layered cache keys").
//
// The model decomposes into layers of increasing specificity; each layer reuses whatever a league
// matches at that layer:
//   scoringKey = hash(ScoringRules)                          -> the projection TARGET + trained heads
//   valueKey   = hash(scoring + roster/eligibility + teams)  -> the value book (added when Layer 2 lands)
//   formatKey  = hash(everything incl. playoff calendar)     -> strategy/levers + golden master
//
// This module owns scoringKey today; the wider keys join it as their layers are built. A key must be
// STABLE: the SAME rules must always produce the SAME key regardless of object key order or float
// noise, or a league would silently retrain every run and never reuse a model. So the input is
// canonicalized (keys sorted, numbers rounded, tier arrays sorted) before hashing.
import { createHash } from "node:crypto";
import { DEFAULT_SCORING, DEFAULT_KICKER, DEFAULT_DEFENSE, type ScoringRules, type KickerRules, type DefenseRules } from "../draft/scoring.js";
import { resolveValueLeague } from "../draft/values.js";

/** Round to 6 dp so 0.1 vs 0.09999999999 (JSON float noise) cannot fork the key. */
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Canonical, order-independent JSON of any value: object keys sorted, numbers rounded, arrays kept in
 *  a canonical order (tier arrays are sorted by their first element so [[400,3],[300,2]] == [[300,2],[400,3]]).
 *  Absent/undefined fields are dropped so `{rec:1}` and `{rec:1, recByPos:undefined}` hash identically. */
function canonical(v: unknown): unknown {
  // `undefined` is ABSENCE and must vanish, not become null (2026-09-16, WP3). The header above has
  // always claimed `{rec:1}` and `{rec:1, recByPos:undefined}` hash identically; they did not --
  // `v == null` caught undefined and emitted `null`, so an explicitly-undefined optional field forked
  // the key against the same rules with the field simply absent. The object loop below already drops
  // an `undefined` result, so returning it here is all that was missing. Neither live key moves
  // (neither config carries an undefined value); test/format-key.test.ts asserts both.
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "number") return r6(v);
  if (Array.isArray(v)) {
    const items = v.map(canonical);
    // A tier array is an array of [number, number] pairs; sort those canonically. Leave other arrays
    // (there are none in ScoringRules today) in place.
    if (items.every((x) => Array.isArray(x) && x.length === 2 && typeof (x as unknown[])[0] === "number")) {
      return [...items].sort((a, b) => ((a as number[])[0] - (b as number[])[0]) || ((a as number[])[1] - (b as number[])[1]));
    }
    return items;
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const cv = canonical((v as Record<string, unknown>)[k]);
      if (cv !== undefined) out[k] = cv;
    }
    return out;
  }
  return v;
}

/** Deterministic canonical JSON string -- the exact bytes that get hashed (also useful in a manifest). */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(canonical(v));
}

/** The scoring-layer key: `sc-<12 hex>` of the canonicalized scoring rules. Determines the projection
 *  target and the trained heads; any two leagues with byte-identical scoring share them. */
export function scoringKey(scoring: ScoringRules): string {
  const h = createHash("sha256").update(canonicalJson(scoring)).digest("hex").slice(0, 12);
  return `sc-${h}`;
}

const hash12 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

/**
 * THE SCORING KEY INCLUDING K/DST, BY DEFAULT-ELISION (WP3 decision, 2026-09-16).
 *
 * The problem: `scoringKey(rules)` hashes the OFFENCE table only, so two leagues whose kicker or
 * defense tables genuinely differ would share one projection target -- and the target CSVs DO carry K
 * and DST rows (history.ts scores them), so that would be a real, silent collision.
 *
 * The two ways to fix it were (i) DEFAULT-ELISION -- fold kicker/defense into the hash only where a
 * league actually declares something different from the incumbent ESPN tables -- or (ii) a full re-key
 * (hash `{rules, kicker, defense}` unconditionally), which changes BOTH live keys and would require
 * renaming `data/formats/sc-a845f67652fb/` and migrating every `scorecard_*.format_key` row.
 *
 * (i) was chosen because it is sound, not merely cheap:
 *   - the two live leagues are exactly the two cases elision was designed for. ESPN 462233 stores
 *     `kicker`/`defense` byte-equal to `DEFAULT_KICKER`/`DEFAULT_DEFENSE`; Yahoo 129048 stores `null`
 *     for both (it rosters no K and no DST). Neither declares anything the default target does not
 *     already express, so neither SHOULD fork the key -- and neither does.
 *   - a league that declares a kicker or defense table differing from the default in any field gets a
 *     different key, which is the property that actually matters. `test/format-key.test.ts` proves it
 *     by moving one kicker field and asserting the key moves, and asserts both live keys unchanged.
 *
 * WHAT ELISION DELIBERATELY DOES NOT DISTINGUISH: "kicker null (no K slot)" from "kicker at the ESPN
 * default". Both produce the same TARGET (history.ts scores K/DST rows under the defaults either way),
 * so they genuinely share a projection layer; whether a league STARTS a kicker is a roster fact and is
 * carried by `valueKey`, one layer down. That is the reuse the layered keys exist for.
 */
export function scoringKeyFor(s: {
  rules: ScoringRules;
  kicker?: KickerRules | null;
  defense?: DefenseRules | null;
}): string {
  const kick = s.kicker && canonicalJson(s.kicker) !== canonicalJson(DEFAULT_KICKER) ? s.kicker : undefined;
  const def = s.defense && canonicalJson(s.defense) !== canonicalJson(DEFAULT_DEFENSE) ? s.defense : undefined;
  if (!kick && !def) return scoringKey(s.rules);
  return `sc-${hash12(canonicalJson({ ...s.rules, ...(kick ? { kicker: kick } : {}), ...(def ? { defense: def } : {}) }))}`;
}

/** The shape of a config this module can key. A structural subset of `AppConfig`, declared here so
 *  formatKey.ts does not import db.ts (db.ts imports THIS module). */
export interface KeyableConfig {
  teams: number;
  budget: number;
  slots: string[];
  draftType?: "auction" | "snake";
  scoring_rules: ScoringRules;
  kicker?: KickerRules | null;
  defense?: DefenseRules | null;
  format?: { regWeeks?: number; playoffTeams?: number; playoffWeeks?: number[]; playoffRoundWeeks?: number; playoffReseed?: boolean; seeding?: string } | null;
}

/**
 * LAYER 2 -- the VALUE BOOK key. `vk-<12 hex>` over the scoring key plus the roster ECONOMICS: the
 * eligibility structure `resolveValueLeague` actually emits (dedicated counts + flex GROUPS with their
 * eligible positions), the team count, the budget and the draft type.
 *
 * It keys on the EMITTED shape rather than on the raw `slots` array on purpose: `["FLEX"]` and
 * `["W/R/T"]` and `["RB/WR/TE"]` are three spellings of one economy and must share a value book, while
 * `SUPERFLEX` must not share one with `FLEX`. Hashing the raw strings would fork the first three and
 * hashing `starters` alone would MERGE the last two (both collapse to `FLEX` in the legacy map).
 */
export function valueKey(cfg: KeyableConfig): string {
  const vl = resolveValueLeague({ teams: cfg.teams, budget: cfg.budget, slots: cfg.slots });
  const payload = {
    scoring: scoringKeyFor({ rules: cfg.scoring_rules, kicker: cfg.kicker, defense: cfg.defense }),
    teams: vl.teams,
    budget: vl.budget,
    rosterSpots: vl.rosterSpots,
    dedicated: vl.dedicated ?? {},
    // Flex groups are a SET: sorted by their eligibility signature so slot order in the config cannot
    // fork the key. Each group's own `elig` is sorted for the same reason.
    flexGroups: (vl.flexGroups ?? [])
      .map((g) => ({ elig: [...g.elig].sort(), count: g.count }))
      .sort((a, b) => (a.elig.join("/") < b.elig.join("/") ? -1 : a.elig.join("/") > b.elig.join("/") ? 1 : a.count - b.count)),
    draftType: cfg.draftType ?? "auction",
  };
  return `vk-${hash12(canonicalJson(payload))}`;
}

/**
 * LAYER 3 -- the STRATEGY / GATE key. `fk-<12 hex>` over the value key plus the PLAYOFF CALENDAR, which
 * is what a golden master and a lever set are actually fitted against.
 *
 * Only the calendar FIELDS THAT CHANGE THE SIMULATION are included -- regular-season length, playoff
 * size, which weeks, round length, reseeding and the seeding rule. Divisions, tiebreak prose,
 * `source`/`fetchedAt`/`note` are identity and provenance, not format, and including them would fork
 * the key every time a sync re-stamped a timestamp.
 */
export function formatKey(cfg: KeyableConfig): string {
  const f = cfg.format ?? null;
  const cal = f == null ? null : {
    regWeeks: f.regWeeks ?? null,
    playoffTeams: f.playoffTeams ?? null,
    playoffWeeks: f.playoffWeeks ?? null,
    playoffRoundWeeks: f.playoffRoundWeeks ?? null,
    playoffReseed: f.playoffReseed ?? null,
    seeding: f.seeding ?? null,
  };
  return `fk-${hash12(canonicalJson({ value: valueKey(cfg), calendar: cal }))}`;
}

/**
 * THE INCUMBENT'S SCORING KEY -- the one key that means "the `data/` root", and the single source for
 * it in this repo (db.ts's `ESPN_SCORING_KEY` is an alias of this constant).
 *
 * PINNED, not computed, so it is a claim a test can falsify: if someone edits `DEFAULT_SCORING`, the
 * module-load assertion below fires at import time rather than the whole incumbent silently acquiring a
 * new identity and every root artifact becoming unreachable.
 */
export const INCUMBENT_SCORING_KEY = "sc-f6143a8dfb13";

{
  const computed = scoringKeyFor({ rules: DEFAULT_SCORING, kicker: DEFAULT_KICKER, defense: DEFAULT_DEFENSE });
  if (computed !== INCUMBENT_SCORING_KEY) {
    throw new Error(
      `formatKey: the incumbent scoring key is pinned as ${INCUMBENT_SCORING_KEY} but DEFAULT_SCORING now ` +
      `hashes to ${computed}. Every artifact at the data/ root belongs to the pinned key, so this is either ` +
      "an unintended edit to src/draft/scoring.ts's DEFAULT_SCORING/DEFAULT_KICKER/DEFAULT_DEFENSE, or a " +
      "deliberate re-key that must move data/ into data/formats/<new key>/ and migrate scorecard_*.format_key.",
    );
  }
}
