/**
 * THE AVAILABILITY VOCABULARY, AS A LEAF.
 *
 * Split out of `copilot.ts` on 2026-09-18 so that `weekState.ts` can depend on it without dragging
 * in the verbs -- `simContext -> weekState -> copilot -> simContext` is a cycle, and this is the
 * smallest cut that breaks it. Nothing here knows about a roster, a league or a simulation: it is a
 * vocabulary and the two maps built from it, and that is deliberately all it is.
 *
 * `copilot.ts` re-exports every name, so no existing import changes.
 */
export type AvailabilityStatus = "OUT" | "QUESTIONABLE" | "ACTIVE";

export interface AvailabilityEntry { status: AvailabilityStatus; source: string; detail?: string }
/** name_key -> what the store says about him this week. Built by `loadAvailability`. */
export type AvailabilityMap = Map<string, AvailabilityEntry>;

/**
 * THE STATUS VOCABULARY, AND WHY IT IS NOT A HAND-TYPED LIST OF SEVEN STRINGS.
 *
 * This set used to be `["OUT","IR","PUP","NFI","SUSPENSION","DNR","DOUBTFUL"]`, matched EXACTLY
 * against an upper-cased status. Two producers write into this function and they do not share a
 * spelling: `player_status.injury_status` writes the abbreviation `IR`, while ESPN's game-day feed
 * (`raw_gameday_status.status`) writes it out as **"Injured Reserve"** -- which matched nothing,
 * fell through to the `return "ACTIVE"` at the bottom, and made every man on injured reserve read as
 * fully startable to the lineup serve, the waiver verb and everything else downstream.
 *
 * MEASURED on 2026-09-18: 30 of the 128 players in the latest game-day week, and 89 rows across the
 * season, every one of them `Injured Reserve`. It went unnoticed because the OTHER four values the
 * feed emits (`Out` 44, `Doubtful` 8, `Suspension` 1, `Questionable` 136) all happen to match, so
 * the vocabulary looked handled. The live cost was a waiver recommendation to bid FAAB on a running
 * back who was on IR, with a confident playoff delta attached to it.
 *
 * THREE THINGS CHANGE, and the third is the one that stops this recurring:
 *
 *   1. The comparison is CANONICAL, not literal: case, punctuation and spacing are collapsed, so
 *      "Injured Reserve", "INJURED_RESERVE" and "injured-reserve" are one token.
 *   2. Both vocabularies are covered -- the abbreviations one producer uses AND the phrases the
 *      other does -- listed together so the two can be read against each other.
 *   3. An UNRECOGNISED status is recorded. The default stays ACTIVE, because benching a man on a
 *      string we failed to parse is worse than starting him (the same asymmetry that keeps
 *      QUESTIONABLE startable) -- but silence is what let this run, so it is no longer silent:
 *      `unknownStatusesSeen` collects them and `loadAvailability` reports them. A new spelling from
 *      either feed now shows up as a named warning instead of as a healthy-looking roster.
 *
 * `test/status-vocabulary.test.ts` closes the loop by reading the DISTINCT values out of the store's
 * own tables and requiring every one to be recognised -- so the list is checked against the
 * producers rather than trusted.
 */
export const canonStatus = (raw: string | null | undefined): string =>
  String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

/** Statuses that make a man UNSTARTABLE. QUESTIONABLE deliberately does not: he plays more often
 *  than not, and benching every questionable starter costs more than the occasional zero. */
const OUT_STATUSES = new Set([
  // abbreviations -- `player_status.injury_status`
  "OUT", "IR", "PUP", "NFI", "SUSPENSION", "DNR", "DOUBTFUL", "INACTIVE",
  // spelled out -- ESPN's `raw_gameday_status.status`, and the forms other feeds use
  "INJURED RESERVE", "INJURY RESERVE", "RESERVE INJURED",
  "PHYSICALLY UNABLE TO PERFORM", "NON FOOTBALL INJURY", "NON FOOTBALL ILLNESS",
  "SUSPENDED", "DID NOT REPORT", "RESERVE SUSPENDED", "RESERVE PUP", "RESERVE DNR",
]);

/** Statuses that are KNOWN to leave a man startable. Present so that anything in neither set can be
 *  told apart from a value we have deliberately decided is fine. */
const STARTABLE_STATUSES = new Set(["ACTIVE", "PROBABLE", "NOTE", "AVAILABLE", "FULL", "LIMITED"]);

/** Every unrecognised status this process has seen, with how many times. Read by `loadAvailability`
 *  (and by the vocabulary test) so a spelling nobody has taught this function cannot pass unseen. */
export const unknownStatusesSeen = new Map<string, number>();

export function normalizeStatus(raw: string | null | undefined): AvailabilityStatus {
  const s = canonStatus(raw);
  if (!s) return "ACTIVE";
  if (OUT_STATUSES.has(s)) return "OUT";
  if (s === "QUESTIONABLE") return "QUESTIONABLE";
  // NOT SILENT. See the note above: the default is ACTIVE on purpose, and the record is what makes
  // that a decision rather than an accident.
  if (!STARTABLE_STATUSES.has(s)) unknownStatusesSeen.set(s, (unknownStatusesSeen.get(s) ?? 0) + 1);
  return "ACTIVE";
}

/** True when this function actually recognises the value -- i.e. it is not being defaulted. */
export const isKnownStatus = (raw: string | null | undefined): boolean => {
  const s = canonStatus(raw);
  return !s || OUT_STATUSES.has(s) || s === "QUESTIONABLE" || STARTABLE_STATUSES.has(s);
};
