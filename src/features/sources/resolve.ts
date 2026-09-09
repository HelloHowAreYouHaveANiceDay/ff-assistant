/**
 * ONE resolver for the RAW SOURCE FEEDS, from whatever id a feed carries to `player_sk`.
 *
 * WHY A SECOND ONE. `src/data/skResolve.ts` resolves a gsis id or a (name, position, team) triple,
 * which is everything the nflverse player-week feed offers. The feeds added in this branch offer
 * different ids and no gsis at all in two cases: snap counts carry a PFR id, contracts carry a name
 * and a birth date, the depth chart's new schema carries an ESPN id. A resolver that only knows gsis
 * would return null for every snap-count row and the feature column would be uniformly empty, which
 * reads exactly like "this feed has no signal".
 *
 * EVERY MAP IS BUILT FROM `stg_player`. Until Phase 2c that was a measured necessity rather than a
 * preference: the two tables held DIFFERENT SURROGATE KEY SPACES for the same men -- of the 7,961
 * gsis ids present in both, 7,902 disagreed -- because `stgPlayer.ts` called
 * `resolveOrMint(db, { ..., ids: {} })` with an EMPTY id bag and minted its own keys. A resolver
 * going through `player_xref` therefore returned keys that joined NOTHING, and the first cut of this
 * file did exactly that: 1 (one) overlapping key between 1,283 resolved participation players and
 * the 2023 feature rows, while reporting a 75% resolution rate. The rate was true; the keys were
 * from the wrong space.
 *
 * Staging now reads the registry, so the two spaces are one and either table would do. Reading
 * staging remains the rule anyway, for a reason that outlives the bug: staging is where a disputed
 * id is WITHHELD and an ambiguous name is FLAGGED, and a resolver built on the registry alone would
 * have to re-derive both -- which is how the two came to disagree in the first place.
 *
 * THE ORDER, strongest evidence first, and every step is an EXACT match:
 *   1. gsis, from stg_player.gsis_id. An id two staged rows claim is refused rather than guessed.
 *   2. espn / sleeper / fantasypros, from stg_player's own id columns.
 *   3. pfr, from stg_player.pfr_id. It is the only id the snap-count feed carries.
 *   4. (name_key, position, team). Team is load-bearing: `nameKey` strips generational suffixes on
 *      purpose, so Marvin Harrison Jr. collapses onto his father, who is also a WR.
 *   5. (name_key, position) where exactly one staged player has that pair.
 *
 * There is no name-only step and there will not be one. A row that resolves to nothing returns null
 * and is COUNTED -- `stats()` reports the resolution rate per source, so a feed that resolves at 4%
 * is a number in the build report rather than a column of nulls nobody questions.
 */
import { nameKey } from "../../draft/values.js";
import { normPos } from "../../data/stgPlayer.js";
import type { DB } from "../../db/db.js";

export type Rule = "gsis" | "espn" | "sleeper" | "fantasypros" | "pfr" | "name-pos-team" | "name-pos" | "unresolved";

export interface ResolveResult { sk: number | null; by: Rule }

export interface SourceResolver {
  resolve(opts: { gsis?: string | null; espn?: string | null; sleeper?: string | null; fantasypros?: string | null; pfr?: string | null; name?: string | null; pos?: string | null; team?: string | null }): ResolveResult;
  /** Count a resolution against a named source feed, so the build can report per-source rates. */
  count(source: string, r: ResolveResult): void;
  stats(): { source: string; rows: number; resolved: number; byRule: Record<string, number> }[];
  staged: number;
}

/** Put, with a REFUSAL on conflict: an id two people claim resolves to nobody. Silently keeping the
 *  first is how a crosswalk merges two men, which is the bug this whole layer exists for. */
function put(m: Map<string, number | null>, k: string, sk: number): void {
  if (!m.has(k)) m.set(k, sk);
  else if (m.get(k) !== sk) m.set(k, null);
}

export function buildSourceResolver(db: DB): SourceResolver {
  const staged = db.prepare(
    "SELECT player_sk, name_key, position, team, gsis_id, espn_id, sleeper_id, pfr_id, fantasypros_id FROM stg_player",
  ).all() as { player_sk: number; name_key: string; position: string; team: string | null; gsis_id: string | null; espn_id: string | null; sleeper_id: string | null; pfr_id: string | null; fantasypros_id: string | null }[];

  // From STAGING's own id columns -- the key space every feature table is keyed by. See the header.
  const byXref = new Map<string, Map<string, number | null>>();
  for (const s of ["gsis", "espn", "sleeper", "fantasypros"]) byXref.set(s, new Map());
  for (const r of staged) {
    if (r.gsis_id) put(byXref.get("gsis")!, r.gsis_id, r.player_sk);
    if (r.espn_id) put(byXref.get("espn")!, r.espn_id, r.player_sk);
    if (r.sleeper_id) put(byXref.get("sleeper")!, r.sleeper_id, r.player_sk);
    if (r.fantasypros_id) put(byXref.get("fantasypros")!, r.fantasypros_id, r.player_sk);
  }

  const byNamePosTeam = new Map<string, number | null>();
  const byNamePos = new Map<string, number | null>();
  const skOfNamePos = new Map<string, number>();
  for (const r of staged) {
    const pos = normPos(r.position ?? "");
    const nk = r.name_key ?? "";
    if (!nk) continue;
    put(byNamePos, `${nk}|${pos}`, r.player_sk);
    skOfNamePos.set(`${nk}|${pos}`, r.player_sk);
    const tm = (r.team ?? "").trim().toUpperCase();
    if (tm) put(byNamePosTeam, `${nk}|${pos}|${tm}`, r.player_sk);
  }

  // PFR ids now come from STAGING like every other id. They used to be mapped from the raw crosswalk
  // through (name_key, position) -- a SECOND route into the key space, which is how two resolvers
  // come to disagree about who a player is. `stg_player.pfr_id` is written by the same pass that
  // decides identity, so there is one route and it cannot drift from the others.
  const byPfr = new Map<string, number | null>();
  for (const r of staged) if (r.pfr_id) put(byPfr, r.pfr_id, r.player_sk);

  const counters = new Map<string, { rows: number; resolved: number; byRule: Record<string, number> }>();

  const lookup = (m: Map<string, number | null> | undefined, k: string | null | undefined): number | null => {
    if (!m || !k) return null;
    const v = m.get(k);
    return v == null ? null : v;
  };

  return {
    staged: staged.length,
    resolve(o) {
      let sk = lookup(byXref.get("gsis"), o.gsis);
      if (sk != null) return { sk, by: "gsis" };
      sk = lookup(byXref.get("espn"), o.espn);
      if (sk != null) return { sk, by: "espn" };
      sk = lookup(byXref.get("sleeper"), o.sleeper);
      if (sk != null) return { sk, by: "sleeper" };
      sk = lookup(byXref.get("fantasypros"), o.fantasypros);
      if (sk != null) return { sk, by: "fantasypros" };
      sk = lookup(byPfr, o.pfr);
      if (sk != null) return { sk, by: "pfr" };
      const nk = o.name ? nameKey(o.name) : "";
      if (!nk) return { sk: null, by: "unresolved" };
      const pos = normPos(o.pos ?? "");
      const tm = (o.team ?? "").trim().toUpperCase();
      if (tm) {
        sk = lookup(byNamePosTeam, `${nk}|${pos}|${tm}`);
        if (sk != null) return { sk, by: "name-pos-team" };
      }
      sk = lookup(byNamePos, `${nk}|${pos}`);
      if (sk != null) return { sk, by: "name-pos" };
      return { sk: null, by: "unresolved" };
    },
    count(source, r) {
      const c = counters.get(source) ?? { rows: 0, resolved: 0, byRule: {} };
      c.rows++;
      if (r.sk != null) c.resolved++;
      c.byRule[r.by] = (c.byRule[r.by] ?? 0) + 1;
      counters.set(source, c);
    },
    stats() {
      return [...counters.entries()].map(([source, c]) => ({ source, ...c }))
        .sort((a, b) => a.source.localeCompare(b.source));
    },
  };
}
