/**
 * A REAL player-identity crosswalk, replacing "the normalised name is the id".
 *
 * WHAT WAS WRONG. Every table in this store keys on `nameKey(name)` -- lowercase, suffixes stripped,
 * non-letters removed. The schema comment has always called the source-id columns "the crosswalk
 * seam", but gsis_id and espn_id were populated on 0 of 541 players, so the seam was decorative and
 * every cross-source join was a string match on a mangled name.
 *
 * That is not a theoretical fragility; it has produced two real defects in this codebase:
 *
 *   - resolvePlayer() matched "Josh Allen" to "Josh Allen Jr." because nameKey strips suffixes, so a
 *     draft-room lookup could return the wrong man. Fixed there with a raw-exact-match first pass,
 *     which patches the symptom at one call site.
 *   - The ECR ingest merged "A.J. Green" the WR with "A.J. Green" the DB, and "Anthony Brown" the QB
 *     with "Anthony Brown" the DB -- 64 name keys spanned multiple positions, silently overwriting
 *     one player's ranking with another's on any shared scrape date.
 *
 * Both are the same root cause reached from different directions, which is the signature of a
 * missing abstraction rather than two bugs.
 *
 * WHAT THIS PROVIDES. DynastyProcess publishes db_playerids.csv: 12k players with gsis, espn,
 * sleeper, yahoo, pfr, fantasypros and mfl ids alongside name, position, team and birthdate. Loaded
 * into `player_ids`, it lets a join go through a STABLE id instead of a string, and -- immediately
 * useful even before any migration -- it makes the ambiguous names ENUMERABLE. You cannot fix what
 * you cannot list.
 *
 * WHAT THIS DOES NOT DO, stated plainly: it does not migrate the existing joins. Every table still
 * keys on name_key today. Repointing them is a larger change that touches every ingest, and doing it
 * blind would be worse than the status quo. The first honest step is the crosswalk plus a collision
 * report that says exactly how big the problem is.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { openDb, nowIso, type DB } from "../db/db.js";
import { nameKey } from "../draft/values.js";
import { splitCsv } from "./ecrHistory.js";

export const PLAYERIDS_URL = "https://github.com/DynastyProcess/data/raw/master/files/db_playerids.csv";

/** Columns we carry. The archive has ~20 id systems; these are the ones anything here touches. */
const ID_COLS = ["gsis_id", "espn_id", "sleeper_id", "yahoo_id", "pfr_id", "fantasypros_id", "mfl_id", "sportradar_id"];

export interface IdIngestResult {
  read: number; kept: number; withGsis: number; withEspn: number; ambiguous: number;
  /** (name_key, position) keys that stand for more than one real person, distinguished by birthdate. */
  collided: number;
  /** Rows written to player_ids_variant -- every side of every collision, kept in full. */
  variants: number;
}

/** The fields two rows sharing a key may legitimately disagree about. A disagreement here is the
 *  signature of two different PEOPLE, not of a stale record. */
const IDENTITY_FIELDS = ["name", "team", "bd", "gsis", "espn", "sleeper", "yahoo", "pfr", "fp", "mfl", "sr"] as const;

export async function ingestPlayerIds(opts: { dbPath?: string; file?: string; url?: string } = {}): Promise<IdIngestResult> {
  const db: DB = openDb(opts.dbPath);
  const source = opts.file
    ? createReadStream(opts.file)
    : Readable.fromWeb((await fetch(opts.url ?? PLAYERIDS_URL)).body as never);
  const rl = createInterface({ input: source, crlfDelay: Infinity });

  // NO `DO UPDATE` THAT MERGES IDENTITY FIELDS, and that is the whole fix for D2.
  //
  // The previous form took name, team and birthdate from the LAST row seen and COALESCEd the ids
  // from the FIRST. Applied to Marvin Harrison Sr. and Jr. -- one key, because nameKey strips the
  // suffix on purpose -- it produced a row carrying the father's name, team and 1973 birthdate with
  // the son's gsis and espn ids. That row describes neither man, and nothing downstream could
  // notice, because a merged row is exactly as well-formed as a real one.
  //
  // Collisions are now resolved BEFORE the insert, in one pass over the parsed rows, so this
  // statement never sees two rows for one key at all. `DO UPDATE` remains only for re-running the
  // ingest over an existing table, where it overwrites the whole row from a single source row.
  const ins = db.prepare(
    `INSERT INTO player_ids (name_key, name, position, team, birthdate, gsis_id, espn_id, sleeper_id, yahoo_id, pfr_id, fantasypros_id, mfl_id, sportradar_id, ambiguous, updated_at)
     VALUES (@nk,@name,@pos,@team,@bd,@gsis,@espn,@sleeper,@yahoo,@pfr,@fp,@mfl,@sr,@amb,@now)
     ON CONFLICT(name_key, position) DO UPDATE SET
       name=excluded.name, team=excluded.team, birthdate=excluded.birthdate,
       gsis_id=excluded.gsis_id, espn_id=excluded.espn_id, sleeper_id=excluded.sleeper_id,
       yahoo_id=excluded.yahoo_id, pfr_id=excluded.pfr_id, fantasypros_id=excluded.fantasypros_id,
       mfl_id=excluded.mfl_id, sportradar_id=excluded.sportradar_id,
       ambiguous=excluded.ambiguous, updated_at=excluded.updated_at`,
  );
  const insVar = db.prepare(
    `INSERT INTO player_ids_variant (name_key, position, birthdate, name, team, gsis_id, espn_id,
       sleeper_id, yahoo_id, pfr_id, fantasypros_id, mfl_id, sportradar_id, updated_at)
     VALUES (@nk,@pos,@bd,@name,@team,@gsis,@espn,@sleeper,@yahoo,@pfr,@fp,@mfl,@sr,@now)
     ON CONFLICT(name_key, position, birthdate) DO UPDATE SET
       name=excluded.name, team=excluded.team, gsis_id=excluded.gsis_id, espn_id=excluded.espn_id,
       sleeper_id=excluded.sleeper_id, yahoo_id=excluded.yahoo_id, pfr_id=excluded.pfr_id,
       fantasypros_id=excluded.fantasypros_id, mfl_id=excluded.mfl_id,
       sportradar_id=excluded.sportradar_id, updated_at=excluded.updated_at`,
  );
  const now = nowIso();
  let idx: Record<string, number> | null = null;
  const res: IdIngestResult = { read: 0, kept: 0, withGsis: 0, withEspn: 0, ambiguous: 0, collided: 0, variants: 0 };
  const rows: Record<string, unknown>[] = [];

  for await (const line of rl) {
    if (!idx) {
      idx = {};
      splitCsv(line).forEach((h, i) => (idx![h.trim()] = i));
      for (const need of ["name", "position", ...ID_COLS.slice(0, 3)]) {
        if (idx[need] === undefined) { db.close(); throw new Error(`db_playerids missing '${need}'; columns: ${Object.keys(idx).join(",")}`); }
      }
      continue;
    }
    res.read++;
    const f = splitCsv(line);
    const name = (f[idx.name] ?? "").trim();
    const pos = (f[idx.position] ?? "").trim().toUpperCase();
    if (!name || !pos) continue;
    const val = (c: string) => { const v = (f[idx![c]] ?? "").trim(); return v === "" || v === "NA" ? null : v; };
    const gsis = val("gsis_id"), espn = val("espn_id");
    if (gsis) res.withGsis++;
    if (espn) res.withEspn++;
    rows.push({
      nk: nameKey(name), name, pos, team: val("team"), bd: val("birthdate"),
      gsis, espn, sleeper: val("sleeper_id"), yahoo: val("yahoo_id"), pfr: val("pfr_id"),
      fp: val("fantasypros_id"), mfl: val("mfl_id"), sr: val("sportradar_id"), now,
    });
    res.kept++;
  }
  // ---- COLLISION RESOLUTION, before anything is written ------------------------------------------
  //
  // Two source rows sharing (name_key, position) but carrying DIFFERENT birthdates are two people.
  // The store has one slot for them, so the slot is filled with what they AGREE on and every field
  // they disagree about is NULLed and the key flagged `ambiguous`. Both sides are kept in full in
  // player_ids_variant, so the information is not lost -- only the false certainty is.
  //
  // The alternative -- picking one -- is what produced the Harrison row, and it is worse than a NULL
  // for the same reason stg_player already refuses a disputed gsis id: a wrong value that looks
  // authoritative is read by everything and questioned by nothing.
  const byKey = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const k = `${r.nk}|${r.pos}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
  }
  const toInsert: Record<string, unknown>[] = [];
  const variantRows: Record<string, unknown>[] = [];
  for (const group of byKey.values()) {
    const births = new Set(group.map((g) => g.bd).filter((b) => b != null && b !== ""));
    if (group.length === 1 || births.size <= 1) {
      // One person, possibly listed twice. The LAST row wins, which is the file's own ordering and
      // was the previous behaviour for a non-colliding key.
      toInsert.push({ ...group[group.length - 1], amb: 0 });
      continue;
    }
    res.collided++;
    const merged: Record<string, unknown> = { ...group[0], amb: 1 };
    for (const f of IDENTITY_FIELDS) {
      const vals = new Set(group.map((g) => g[f]));
      if (vals.size > 1) merged[f] = null;           // they disagree -> we do not know
    }
    toInsert.push(merged);
    for (const g of group) if (g.bd) variantRows.push(g);
  }
  res.variants = variantRows.length;

  db.transaction(() => {
    for (const r of toInsert) ins.run(r);
    for (const r of variantRows) insVar.run(r);
  })();

  // BACKFILL the player table's long-empty crosswalk columns. Matched on (name_key, position) so a
  // shared name cannot pull in the wrong man's ids -- which is the entire point of this exercise.
  db.prepare(
    `UPDATE player SET
       gsis_id = (SELECT gsis_id FROM player_ids i WHERE i.name_key = player.player_id AND i.position = player.position),
       espn_id = (SELECT espn_id FROM player_ids i WHERE i.name_key = player.player_id AND i.position = player.position),
       updated_at = @now
     WHERE EXISTS (SELECT 1 FROM player_ids i WHERE i.name_key = player.player_id AND i.position = player.position)`,
  ).run({ now });

  res.ambiguous = (db.prepare(
    "SELECT COUNT(*) c FROM (SELECT name_key FROM player_ids GROUP BY name_key HAVING COUNT(DISTINCT position) > 1)",
  ).get() as { c: number }).c;
  db.close();
  return res;
}

/** Every recorded side of an ambiguous key. The list a consumer needs to pick the right man ITSELF,
 *  using something better than a name -- a gsis id, a birthdate, a draft year. */
export function variantsFor(db: DB, name: string, pos: string): Record<string, string | null>[] {
  return db.prepare(
    "SELECT * FROM player_ids_variant WHERE name_key = ? AND position = ? ORDER BY birthdate",
  ).all(nameKey(name), pos.toUpperCase()) as Record<string, string | null>[];
}

export interface Ambiguity { name_key: string; names: string; positions: string; n: number }

/** Every name_key that stands for more than one real player. The list you cannot fix without. */
export function ambiguousNames(db: DB, limit = 50): Ambiguity[] {
  return db.prepare(
    `SELECT name_key, GROUP_CONCAT(DISTINCT name) names, GROUP_CONCAT(DISTINCT position) positions, COUNT(*) n
     FROM player_ids GROUP BY name_key HAVING COUNT(DISTINCT position) > 1
     ORDER BY n DESC LIMIT ?`,
  ).all(limit) as Ambiguity[];
}

/**
 * Resolve a name (+ position when known) to the crosswalk row.
 *
 * Position is REQUIRED to be safe and optional to be usable. Without it, a name shared by two players
 * returns null rather than a guess -- returning either one would be exactly the silent wrong answer
 * this module exists to remove.
 */
export function resolveIds(db: DB, name: string, pos?: string): Record<string, string | null> | null {
  const nk = nameKey(name);
  if (pos) {
    return (db.prepare("SELECT * FROM player_ids WHERE name_key = ? AND position = ?").get(nk, pos.toUpperCase()) as Record<string, string | null>) ?? null;
  }
  const all = db.prepare("SELECT * FROM player_ids WHERE name_key = ?").all(nk) as Record<string, string | null>[];
  return all.length === 1 ? all[0] : null;
}
