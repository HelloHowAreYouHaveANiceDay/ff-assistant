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

export interface SkResolver {
  /** gsis first, then (name_key, position, team), then (name_key, position). null = unresolved. */
  resolve(opts: { gsis?: string | null; name: string; pos: string; team?: string | null }): PlayerKey | null;
  /** How many staged rows the maps were built from -- reported, never assumed. */
  staged: number;
}

export function buildSkResolver(db: DB): SkResolver {
  const rows = db.prepare(
    "SELECT player_sk, name_key, position, team, gsis_id FROM stg_player",
  ).all() as { player_sk: number; name_key: string; position: string; team: string | null; gsis_id: string | null }[];

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
