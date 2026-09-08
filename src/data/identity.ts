/**
 * THE PLAYER DIMENSION: a durable surrogate key, and a crosswalk of source ids around it.
 *
 * WHY THE FIRST VERSION WAS WRONG. stg_player keyed on `gsis_id || "POS:name_key"` -- a NATURAL key,
 * derived from the player's own attributes. Natural keys move when attributes move:
 *
 *   - a player with no gsis today is keyed "RB:antoniowilliams"; when the crosswalk later learns his
 *     gsis, his key becomes "00-0036188" and every stored reference to him breaks
 *   - Max Bredeson reclassified RB -> TE changes key
 *   - a disputed gsis withheld today and trusted tomorrow changes key
 *
 * A foundation table cannot do that. The standard answer is a SURROGATE key: an internal, meaningless
 * integer minted once and never changed, with every source id held as an ATTRIBUTE beside it rather
 * than as the identity itself.
 *
 * THE THREE PIECES, which is the shape most master-data systems converge on:
 *
 *   player_identity   the registry. player_sk (surrogate), when it was minted, and how the player was
 *                     first matched. Append-mostly: a key is never reused or renumbered.
 *   player_xref       (player_sk, source, source_id). MANY rows per player, one per id system. This is
 *                     what makes "one player, many ids" expressible -- a single espn_id column cannot
 *                     represent a player who has two, or an id later reassigned.
 *   stg_player        the conformed dimension keyed by player_sk, rebuilt freely because the KEYS come
 *                     from the registry rather than from the rebuild.
 *
 * MATCHING IS DETERMINISTIC AND ORDERED, strongest evidence first, so a rebuild reproduces the same
 * assignment: gsis, then espn, then sleeper, then (name_key, position). Each step is an exact match --
 * no fuzzy scoring. Fuzzy matching is where MDM systems quietly merge people, and this codebase has
 * already merged two men three separate ways without any fuzziness at all.
 *
 * UNMATCHED IS A STATE, NOT AN ERROR. A player who resolves to nothing gets a fresh sk and is
 * recorded as such. Silently dropping him would lose a current player; guessing would recreate the
 * bug the whole layer exists to prevent.
 */
import { openDb, nowIso, type DB } from "../db/db.js";
import { normPos } from "./stgPlayer.js";

/** Source id systems we crosswalk, in the order they are trusted for matching. */
export const ID_SOURCES = ["gsis", "espn", "sleeper", "fantasypros"] as const;
export type IdSource = typeof ID_SOURCES[number];

export interface ResolveInput {
  name: string; nameKey: string; position: string;
  ids: Partial<Record<IdSource, string | null>>;
}

/**
 * Find an existing player_sk for this person, or mint one.
 *
 * `matchedBy` is returned so the caller can record HOW identity was decided. A dimension that cannot
 * say why two rows are the same player is one nobody can debug later.
 */
export function resolveOrMint(db: DB, inp: ResolveInput, disputed?: Set<string>): { sk: number; matchedBy: string; minted: boolean } {
  const findBySource = db.prepare("SELECT player_sk FROM player_xref WHERE source = ? AND source_id = ?");
  for (const s of ID_SOURCES) {
    const v = inp.ids[s];
    if (!v) continue;
    // A DISPUTED ID MUST NOT MATCH. Without this the registry reproduced, for the third time, the
    // merge it was built to prevent: Bobby McCray shares gsis 00-0022888 with Jake Schum, matched
    // Schum's surrogate key, and ended up with no identity row of his own -- 15 players absorbed.
    //
    // linkId() already REFUSED to write the duplicate link, which is why this was survivable, but
    // refusing the link after matching on it is too late: the merge happens at match time. Both
    // guards are needed and they protect different steps.
    if (disputed?.has(`${s}:${v}`)) continue;
    const hit = findBySource.get(s, v) as { player_sk: number } | undefined;
    if (hit) return { sk: hit.player_sk, matchedBy: s, minted: false };
  }
  // Fall back to the conformed natural key. Weakest evidence, so it is tried last, and it is exact:
  // a name alone is never enough -- that is what merged A.J. Green the WR with A.J. Green the DB.
  const byName = db.prepare(
    "SELECT player_sk FROM player_identity WHERE name_key = ? AND position = ?",
  ).get(inp.nameKey, normPos(inp.position)) as { player_sk: number } | undefined;
  if (byName) return { sk: byName.player_sk, matchedBy: "name+pos", minted: false };

  const r = db.prepare(
    `INSERT INTO player_identity (name_key, position, first_name, matched_by, created_at)
     VALUES (?,?,?,?,?)`,
  ).run(inp.nameKey, normPos(inp.position), inp.name, "minted", nowIso());
  return { sk: Number(r.lastInsertRowid), matchedBy: "minted", minted: true };
}

/** Record a source id against a player. Idempotent; conflicting claims are reported, not overwritten. */
export function linkId(db: DB, sk: number, source: IdSource, id: string | null | undefined): string | null {
  if (!id) return null;
  const owner = db.prepare("SELECT player_sk FROM player_xref WHERE source = ? AND source_id = ?").get(source, id) as { player_sk: number } | undefined;
  if (owner && owner.player_sk !== sk) {
    // Two players claiming one id. Real: ten gsis ids in the crosswalk are attached to two people.
    // The link is REFUSED rather than moved, because reassigning it would silently change which
    // player a stored id points at.
    return `${source}:${id} already belongs to sk ${owner.player_sk}, not ${sk}`;
  }
  db.prepare(
    "INSERT INTO player_xref (player_sk, source, source_id, created_at) VALUES (?,?,?,?) ON CONFLICT(source, source_id) DO NOTHING",
  ).run(sk, source, id, nowIso());
  return null;
}

export interface IdentityResult { players: number; minted: number; matched: Record<string, number>; conflicts: string[]; disputedIds: number }

/**
 * Build/refresh the identity registry from the raw crosswalk plus the current board.
 *
 * Rerunnable by construction: existing players match on their ids and keep their surrogate keys, so
 * running this twice changes nothing. That property is the whole point and is asserted in tests --
 * a registry whose keys move on rebuild is not a foundation.
 */
export function buildIdentity(dbPath?: string): IdentityResult {
  const db: DB = openDb(dbPath);
  const res: IdentityResult = { players: 0, minted: 0, matched: {}, conflicts: [], disputedIds: 0 };

  const rows = db.prepare(
    "SELECT name_key, position, name, gsis_id, espn_id, sleeper_id, fantasypros_id FROM player_ids",
  ).all() as Record<string, string | null>[];

  // Every source id claimed by more than one real person, computed from the RAW feed before any
  // matching happens. This has to be known up front: by the time a duplicate link is refused, the
  // second player has already been matched onto the first one's key.
  const disputed = new Set<string>();
  for (const [col, src] of [["gsis_id", "gsis"], ["espn_id", "espn"], ["sleeper_id", "sleeper"], ["fantasypros_id", "fantasypros"]] as const) {
    for (const r of db.prepare(
      `SELECT ${col} v FROM player_ids WHERE ${col} IS NOT NULL
       GROUP BY ${col} HAVING COUNT(DISTINCT name_key || '|' || position) > 1`,
    ).all() as { v: string }[]) disputed.add(`${src}:${r.v}`);
  }
  res.disputedIds = disputed.size;

  db.transaction(() => {
    for (const p of rows) {
      const inp: ResolveInput = {
        name: p.name ?? "", nameKey: p.name_key!, position: p.position!,
        ids: { gsis: p.gsis_id, espn: p.espn_id, sleeper: p.sleeper_id, fantasypros: p.fantasypros_id },
      };
      const { sk, matchedBy, minted } = resolveOrMint(db, inp, disputed);
      res.players++;
      if (minted) res.minted++;
      res.matched[matchedBy] = (res.matched[matchedBy] ?? 0) + 1;
      for (const s of ID_SOURCES) {
        const err = linkId(db, sk, s, inp.ids[s]);
        if (err && res.conflicts.length < 50) res.conflicts.push(err);
      }
    }
  })();
  db.close();
  return res;
}
