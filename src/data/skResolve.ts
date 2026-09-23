/**
 * ONE resolver from a raw feed row to the stable player key, shared by every producer.
 *
 * WHY THIS EXISTS. `history-points.csv` and `history-weekly.csv` have been keyed by a DISPLAY NAME
 * since they were written, and every fit script then re-joins on that name. That is the same
 * name-keyed join that put a father's birth year on his son and a linebacker's age on a receiver --
 * except reproduced once per script, each with its own normalisation, so a fix in one does not reach
 * the others. Phase 1 fixed the BOARD's identity; the history files, which are what every model is
 * actually fitted on, were still names.
 *
 * THE ORDER, strongest evidence first, mirroring identity.ts:
 *
 *   1. GSIS. The nflverse feeds carry `player_id`, which IS a gsis id -- the strongest evidence
 *      available, and the reason the history files can be keyed at all. A gsis that stg_player
 *      attaches to more than one surrogate key is refused rather than guessed (stgPlayer.ts already
 *      withholds the ten disputed ones, so in practice this set is empty; the guard stays because a
 *      refreshed crosswalk can add another).
 *   2. (name_key, position, TEAM). Team is load-bearing and was learned the hard way: `nameKey`
 *      strips generational suffixes on purpose, so Marvin Harrison Jr. collapses onto his father,
 *      who is also a WR. Position alone therefore returns a Hall of Famer who retired in 2008.
 *   3. (name_key, position) when exactly one staged player has that pair.
 *
 * A row that resolves to nothing KEEPS ITS PLACE and reports `null`. Dropping it would silently
 * shrink the training set; guessing would restore the bug this module exists to prevent.
 *
 * DST IS A SYNTHETIC KEY, `DST:<TEAM>`, and deliberately not a surrogate one. A team defense is not
 * a person: it has no birth date, no gsis id, and no row in the identity registry, and minting a
 * player_sk for it would put a non-person into the player dimension. `DST:SF` is deterministic,
 * stable across seasons and rebuilds, and self-describing at a glance -- which is the whole job.
 */
import { nameKey } from "../draft/values.js";
import { normPos } from "./stgPlayer.js";
import type { DB } from "../db/db.js";

/** The stable key as it is written into the history CSVs and the feature tables: a surrogate key
 *  rendered as text, or a synthetic `DST:<TEAM>`. Text because those two are not the same domain
 *  and pretending they are would mean inventing an integer for a thing that is not a player. */
export type PlayerKey = string;

export const dstKey = (team: string): PlayerKey => `DST:${(team || "").trim().toUpperCase()}`;

/**
 * THE ONE BRIDGE FROM THE BOARD/VALUE LAYER TO THE MODEL LAYER, and the reason it has to exist.
 *
 * The repo carries TWO key namespaces for the same men, both internally consistent, which is what
 * makes the mismatch invisible:
 *
 *   MODEL LAYER   `feat_player_week`, `fact_roster_week`, `scorecard_prediction.subject` -- TEXT.
 *                 A surrogate key rendered as text, or a synthetic `DST:<TEAM>` per the note above.
 *   BOARD LAYER   `player_value.player_sk`, `board.player_sk` -- INTEGER, and therefore structurally
 *                 incapable of holding `DST:MIN`. The identity registry nonetheless MINTS a
 *                 surrogate for all 32 defences (`player_identity` sk 12089 is `name_key "min"`), so
 *                 those columns hold an integer that joins to NOTHING in the model layer.
 *
 * A join that goes board -> model on `player_sk` therefore resolves every skill player on the first
 * try and silently drops every defence. Measured on league 462233: 8 of 8 starters resolved, both
 * DSTs unresolved, and joining on NAME instead "worked" only because both sides happened to render
 * "MIN D/ST" -- a string coincidence standing in for a missing key mapping. Neither method
 * announces the problem: the key join drops rows, the name join is one rename away from doing the
 * same, and both produce a plausible total.
 *
 * So: never join those two layers on `player_sk` directly, and never on a name. Call this.
 *
 * `null` means the row cannot be keyed at all -- a board row with no staged match -- and is returned
 * rather than guessed, the same rule `resolve` follows.
 */
export function boardModelKey(row: { position?: string | null; player_id?: string | null; team?: string | null; player_sk?: number | string | null }): PlayerKey | null {
  const pos = normPos(row.position ?? "");
  // A defence's board `player_id` IS its team code ("min"), which is the only identity it has here;
  // `team` is preferred where the caller has it, because it is the field that means what it says.
  if (pos === "DST") {
    const t = (row.team || row.player_id || "").trim();
    return t ? dstKey(t) : null;
  }
  return row.player_sk == null ? null : String(row.player_sk);
}

export interface SkResolver {
  /** gsis first, then (name_key, position, team), then (name_key, position). null = unresolved. */
  resolve(opts: { gsis?: string | null; name: string; pos: string; team?: string | null }): PlayerKey | null;
  /** How many staged rows the maps were built from -- reported, never assumed. */
  staged: number;
  /**
   * The staged OFFENSIVE position for a gsis id, or null when unknown or not a skill position.
   *
   * Exists for the two-way case in `history.ts`: when a defensively-listed player turns out to have
   * a real offensive workload, guessing his position from touch type only distinguishes RB from WR,
   * and Jordan Thomas 2018 is a TIGHT END who would land as a WR. The staged table already knows --
   * it has a primary position for all 12,122 players -- so this reads it rather than inferring it.
   */
  offensivePos(gsis: string | null | undefined): string | null;
}

export function buildSkResolver(db: DB): SkResolver {
  const rows = db.prepare(
    "SELECT player_sk, name_key, position, team, gsis_id FROM stg_player",
  ).all() as { player_sk: number; name_key: string; position: string; team: string | null; gsis_id: string | null }[];

  // gsis -> staged position, for `offensivePos`. Only skill positions are returned; anything else is
  // null so a caller cannot accidentally promote a defender on the strength of this lookup.
  const SKILL = new Set(["QB", "RB", "WR", "TE"]);
  const posByGsis = new Map<string, string>();
  for (const r of rows) {
    const p = (r.position || "").toUpperCase();
    if (r.gsis_id && SKILL.has(p)) posByGsis.set(r.gsis_id, p);
  }

  const byGsis = new Map<string, number | null>();          // null = the id is claimed by two people
  const byNamePosTeam = new Map<string, number | null>();
  const byNamePos = new Map<string, number | null>();
  const put = (m: Map<string, number | null>, k: string, sk: number) => {
    if (!m.has(k)) m.set(k, sk);
    else if (m.get(k) !== sk) m.set(k, null);
  };
  for (const r of rows) {
    const pos = normPos(r.position ?? "");
    if (r.gsis_id) put(byGsis, r.gsis_id, r.player_sk);
    const nk = r.name_key ?? "";
    if (!nk) continue;
    put(byNamePos, `${nk}|${pos}`, r.player_sk);
    const tm = (r.team ?? "").trim().toUpperCase();
    if (tm) put(byNamePosTeam, `${nk}|${pos}|${tm}`, r.player_sk);
  }

  return {
    staged: rows.length,
    offensivePos(gsis) { return gsis ? (posByGsis.get(gsis) ?? null) : null; },
    resolve({ gsis, name, pos, team }) {
      const p = normPos(pos ?? "");
      if (p === "DST") return dstKey(team || name.replace(/\s+D\/?ST$/i, ""));
      if (gsis) { const s = byGsis.get(gsis); if (s != null) return String(s); }
      const nk = nameKey(name);
      if (!nk) return null;
      const tm = (team ?? "").trim().toUpperCase();
      if (tm) { const s = byNamePosTeam.get(`${nk}|${p}|${tm}`); if (s != null) return String(s); }
      const s2 = byNamePos.get(`${nk}|${p}`);
      return s2 != null ? String(s2) : null;
    },
  };
}
