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

/** Source id systems we crosswalk, in the order they are trusted for matching.
 *
 *  `pfr` was added in Phase 2c. It is the ONLY id the snap-count feed carries, and without it in the
 *  registry that feed had to be routed through `player_ids` by (name_key, position) in a second
 *  resolver -- a parallel route that can disagree with this one, which is the shape of every
 *  identity bug in this store. It sits below sleeper because it is a scraped-site id rather than a
 *  league one, and above fantasypros for the same reason. */
export const ID_SOURCES = ["gsis", "espn", "sleeper", "pfr", "fantasypros"] as const;
export type IdSource = typeof ID_SOURCES[number];

export interface ResolveInput {
  name: string; nameKey: string; position: string; birthdate?: string | null;
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
  // NAME + BIRTHDATE. Birthdate is the stable discriminator; POSITION IS NOT ONE, and using it here
  // split 178 real players into two surrogate keys each -- every man a source reclassified (Bredeson
  // RB -> TE, Ojulari LB -> EDGE) became two people, and ESPN grants multi-position eligibility as a
  // matter of course. Measured on the crosswalk: of 493 name keys that look ambiguous by position,
  // 230 are genuinely different people whom birthdate separates, and 178 are one person who moved.
  const bd = inp.birthdate || null;
  if (bd) {
    const byBirth = db.prepare(
      "SELECT player_sk FROM player_identity WHERE name_key = ? AND birthdate = ?",
    ).get(inp.nameKey, bd) as { player_sk: number } | undefined;
    if (byBirth) return { sk: byBirth.player_sk, matchedBy: "name+birthdate", minted: false };
  } else {
    // No birthdate: fall back to position, but ONLY among rows that also lack one. Matching a
    // birthdate-less row onto a player who HAS a birthdate would merge on the weakest evidence
    // available while stronger evidence sat unused.
    const byPos = db.prepare(
      "SELECT player_sk FROM player_identity WHERE name_key = ? AND birthdate IS NULL AND primary_position = ?",
    ).get(inp.nameKey, normPos(inp.position)) as { player_sk: number } | undefined;
    if (byPos) return { sk: byPos.player_sk, matchedBy: "name+pos-no-birthdate", minted: false };
  }

  const r = db.prepare(
    `INSERT INTO player_identity (name_key, birthdate, primary_position, first_name, matched_by, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(inp.nameKey, bd, normPos(inp.position), inp.name, "minted", nowIso());
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

export interface IdentityResult { players: number; minted: number; matched: Record<string, number>; conflicts: string[]; disputedIds: number; fromVariants: number }

/** One crosswalk person, as the registry and staging both need to see him. */
export interface CrosswalkPerson {
  name_key: string; position: string; name: string | null; team: string | null; birthdate: string | null;
  gsis_id: string | null; espn_id: string | null; sleeper_id: string | null; pfr_id: string | null;
  fantasypros_id: string | null;
  /** true when this row came from player_ids_variant -- i.e. the source key stands for two people. */
  variant: boolean;
}

/**
 * THE CROSSWALK'S PEOPLE, with the collapsed rows EXPANDED back into the individuals they hide.
 *
 * `player_ids` is keyed (name_key, position) and the ingest resolves a key claimed by two men by
 * NULLing every field they disagree about and flagging it `ambiguous`. That row describes nobody:
 * Marvin Harrison Sr. and Jr. are both `marvinharrison|WR`, so the stored row is a WR with no
 * birthdate, no gsis and no espn id. Reading only that table, the registry can mint at most ONE key
 * for the pair -- which is the merge the whole layer exists to prevent, arrived at from the raw
 * side rather than the consumer side.
 *
 * `player_ids_variant` holds every side of every collision in full, which is precisely the
 * information needed to separate them. So: where a key has variants, the variants ARE the people and
 * the collapsed row is dropped; everywhere else the base row stands. Both the registry and staging
 * read this one function, because two readers of an ambiguous key that disagree about how many
 * people it is would put the two layers back into different key spaces.
 */
export function crosswalkPeople(db: DB): CrosswalkPerson[] {
  const cols = "name_key, position, name, team, birthdate, gsis_id, espn_id, sleeper_id, pfr_id, fantasypros_id";
  let variants: CrosswalkPerson[] = [];
  try {
    variants = (db.prepare(`SELECT ${cols} FROM player_ids_variant`).all() as Omit<CrosswalkPerson, "variant">[])
      .map((v) => ({ ...v, variant: true }));
  } catch { /* a store predating the variant table simply has no collisions recorded */ }
  const collapsed = new Set(variants.map((v) => `${v.name_key}|${v.position}`));
  const base = (db.prepare(`SELECT ${cols} FROM player_ids`).all() as Omit<CrosswalkPerson, "variant">[])
    .filter((r) => !collapsed.has(`${r.name_key}|${r.position}`))
    .map((r) => ({ ...r, variant: false }));
  return [...base, ...variants];
}

/** The id column each crosswalk source is carried in. One list, so the registry and staging cannot
 *  disagree about which column is which source. */
export const ID_COLUMN: Record<IdSource, keyof CrosswalkPerson> = {
  gsis: "gsis_id", espn: "espn_id", sleeper: "sleeper_id", pfr: "pfr_id", fantasypros: "fantasypros_id",
};

export const idBag = (p: CrosswalkPerson): Partial<Record<IdSource, string | null>> =>
  Object.fromEntries(ID_SOURCES.map((s) => [s, (p[ID_COLUMN[s]] as string | null) ?? null]));

/**
 * Every source id claimed by more than one PERSON, computed from the expanded crosswalk before any
 * matching happens. This has to be known up front: by the time a duplicate link is refused, the
 * second player has already been matched onto the first one's key.
 *
 * A person is (name_key, position, birthdate) here rather than (name_key, position), because the
 * whole reason variants exist is that one (name_key, position) is two men.
 */
export function disputedIds(people: CrosswalkPerson[]): Set<string> {
  const claims = new Map<string, Set<string>>();
  for (const p of people) {
    const who = `${p.name_key}|${p.position}|${p.birthdate ?? ""}`;
    for (const s of ID_SOURCES) {
      const v = p[ID_COLUMN[s]] as string | null;
      if (!v) continue;
      const k = `${s}:${v}`;
      (claims.get(k) ?? claims.set(k, new Set()).get(k)!).add(who);
    }
  }
  const out = new Set<string>();
  for (const [k, who] of claims) if (who.size > 1) out.add(k);
  return out;
}

/**
 * Build/refresh the identity registry from the raw crosswalk plus the current board.
 *
 * Rerunnable by construction: existing players match on their ids and keep their surrogate keys, so
 * running this twice changes nothing. That property is the whole point and is asserted in tests --
 * a registry whose keys move on rebuild is not a foundation.
 */
export function buildIdentity(dbPath?: string, opts: { rebuild?: boolean } = {}): IdentityResult {
  const db: DB = openDb(dbPath);
  // A FULL REMINT, and the only circumstance that justifies one: the registry itself was built from
  // corrupt input and cannot be repaired incrementally.
  //
  // The registry was minted from `player_ids` BEFORE the ingest learned to expand a collided key, so
  // Marvin Harrison Jr.'s gsis sits on an identity row carrying his father's birthdate -- one row
  // standing for two men. Matching the son by gsis and the father by (name, birthdate) then lands
  // both on that row, so an incremental rebuild REPRODUCES the merge no matter how good the new
  // evidence is. On top of that, ~10.9k of the 22,814 keys were minted by staging's empty-id-bag
  // call and stand for nobody the registry can reach.
  //
  // Never routine: `identity_rekey` exists precisely so a remint is a recorded migration rather than
  // a silent renumbering, and every `player_sk`-keyed table must be rebuilt behind it.
  if (opts.rebuild) {
    db.pragma("foreign_keys = OFF");
    db.transaction(() => {
      // stg_player is deliberately NOT cleared: it still holds the OLD surrogate keys, and
      // `buildStgPlayer` reads them to write `identity_rekey` before replacing them. Clearing them
      // here would perform the renumbering and destroy the record of it in the same breath.
      for (const t of ["player_xref", "player_position", "player_identity"]) db.prepare(`DELETE FROM ${t}`).run();
      db.prepare("DELETE FROM sqlite_sequence WHERE name = 'player_identity'").run();
    })();
    db.pragma("foreign_keys = ON");
  }
  const res: IdentityResult = { players: 0, minted: 0, matched: {}, conflicts: [], disputedIds: 0, fromVariants: 0 };

  const rows = crosswalkPeople(db);
  res.fromVariants = rows.filter((r) => r.variant).length;

  // Computed over the EXPANDED people, not over player_ids alone. A variant row carries the id that
  // the collapsed row had to NULL, so an id present only on variants is invisible to a query over
  // the base table -- and an id two variants of DIFFERENT keys claim is exactly as disputed as one
  // two base rows claim.
  const disputed = disputedIds(rows);
  res.disputedIds = disputed.size;

  db.transaction(() => {
    for (const p of rows) {
      const inp: ResolveInput = {
        name: p.name ?? "", nameKey: p.name_key, position: p.position, birthdate: p.birthdate,
        ids: idBag(p),
      };
      const { sk, matchedBy, minted } = resolveOrMint(db, inp, disputed);
      // Position is recorded as ELIGIBILITY, many rows per player, because that is what it is: ESPN
      // qualifies one man at several positions and sources reclassify him between seasons. Holding a
      // single position on the identity row is what made those look like different people.
      db.prepare(
        "INSERT INTO player_position (player_sk, position, source) VALUES (?,?,?) ON CONFLICT DO NOTHING",
      ).run(sk, normPos(p.position), "playerids");
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
