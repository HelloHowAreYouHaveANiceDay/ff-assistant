/**
 * STAGING: one row per real player, identity decided ONCE.
 *
 * This is the layer the store never had. Raw feeds land keyed by whatever the source used -- usually
 * a name -- and every consumer then re-solved identity for itself, ad hoc and inconsistently. Three
 * bugs came out of that in one week, the last one shipping a +19.5% markup on a 29-year-old because
 * the age curve read another man's birth year. See docs/data-layers.md.
 *
 * THE KEY comes from the identity registry (data/identity.ts): player_sk, an internal integer minted
 * once and never changed. It was previously derived here as gsis-else-POS:name_key -- a NATURAL key,
 * which moves whenever an attribute moves, so a player learning his gsis silently became a different
 * row. Staging no longer decides identity; it READS it, which is why the registry exists.
 *
 * AMBIGUITY IS MARKED, NEVER GUESSED. When a name_key maps to several real players, each gets its
 * own row and all of them are flagged `ambiguous = 1`. A consumer that cannot tell them apart should
 * skip them -- which is exactly what ageFactor already does by returning 1 for an unknown player.
 * Silently picking one would restore the bug this layer exists to prevent.
 *
 * NO BUSINESS LOGIC. Conforming is not valuing. Nothing here computes a projection, a price or a
 * rank; those are consumer concerns. If a column would change when our strategy changes, it does not
 * belong in staging.
 */
import { openDb, nowIso, type DB } from "../db/db.js";
import { resolveOrMint } from "./identity.js";

export interface StgBuildResult {
  rows: number; withGsis: number; ambiguous: number; fromBoardOnly: number;
}

/**
 * CONFORM THE POSITION VOCABULARY. Sources do not agree on what a position is called, and until this
 * existed the layer produced TWO rows for every kicker: the board says `K`, the crosswalk says `PK`,
 * so Cairo Santos was two different people. That is the precise failure staging is supposed to end,
 * committed by staging itself.
 *
 * Only aliases that are genuinely the SAME position are mapped. Defensive line detail (DE/DT/DL) is
 * deliberately left alone: those are different roles, our league does not use them, and collapsing
 * them would invent a merge to make a count look tidier.
 */
export function normPos(pos: string): string {
  const p = (pos || "").trim().toUpperCase();
  if (p === "PK") return "K";                     // crosswalk calls kickers PK, our board calls them K
  if (p === "D/ST" || p === "DEF") return "DST";
  return p;
}

/**
 * Rebuild `stg_player` from the raw crosswalk plus whatever the board knows.
 *
 * Full rebuild rather than incremental: it is derived, cheap, and a staging table that drifts from
 * its sources is worse than one that is rebuilt on demand.
 */
export function buildStgPlayer(dbPath?: string): StgBuildResult {
  const db: DB = openDb(dbPath);
  const now = nowIso();

  // How many DISTINCT people share each name_key. Computed once, in SQL, so the flag cannot
  // disagree with the data it describes.
  const ambiguity = new Map<string, number>();
  for (const r of db.prepare(
    "SELECT name_key, COUNT(DISTINCT CASE position WHEN 'PK' THEN 'K' ELSE position END) n FROM player_ids GROUP BY name_key",
  ).all() as { name_key: string; n: number }[]) ambiguity.set(r.name_key, r.n);

  // THE SOURCE'S OWN IDS ARE NOT ALL TRUSTWORTHY, and taking them on faith made this layer reproduce
  // the exact bug it exists to prevent. Ten gsis ids in the crosswalk are attached to more than one
  // real person -- 00-0022888 belongs to both Jake Schum (punter) and Bobby McCray (defensive end).
  // Keying on gsis blindly merged those pairs into one staging row, silently, which is precisely
  // what a name_key does and what this layer is supposed to stop.
  //
  // So a gsis id earns the right to be the key only if it maps to ONE person. Where it does not, the
  // row falls back to POS:name_key and is flagged ambiguous, because a bad id is worse than no id:
  // it looks authoritative.
  const badGsis = new Set<string>();
  for (const r of db.prepare(
    `SELECT gsis_id FROM player_ids WHERE gsis_id IS NOT NULL
     GROUP BY gsis_id HAVING COUNT(DISTINCT name_key || '|' || position) > 1`,
  ).all() as { gsis_id: string }[]) badGsis.add(r.gsis_id);

  const ins = db.prepare(
    `INSERT INTO stg_player (player_sk, name_key, name, position, team, birthdate, gsis_id, espn_id,
                             sleeper_id, fantasypros_id, ambiguous, source, updated_at)
     VALUES (@key,@nk,@name,@pos,@team,@bd,@gsis,@espn,@sleeper,@fp,@amb,@src,@now)
     ON CONFLICT(player_sk) DO UPDATE SET
       name=excluded.name, team=excluded.team, birthdate=excluded.birthdate,
       gsis_id=COALESCE(excluded.gsis_id, stg_player.gsis_id),
       espn_id=COALESCE(excluded.espn_id, stg_player.espn_id),
       ambiguous=excluded.ambiguous, updated_at=excluded.updated_at`,
  );
  const res: StgBuildResult = { rows: 0, withGsis: 0, ambiguous: 0, fromBoardOnly: 0 };

  db.transaction(() => {
    db.prepare("DELETE FROM stg_player").run();

    // 1. everyone the crosswalk knows -- the authoritative source of identity
    for (const p of db.prepare(
      "SELECT name_key, position, name, team, birthdate, gsis_id, espn_id, sleeper_id, fantasypros_id FROM player_ids",
    ).all() as Record<string, string | null>[]) {
      const nk = p.name_key!, pos = normPos(p.position!);
      const gsisOk = p.gsis_id && !badGsis.has(p.gsis_id);
      const amb = ((ambiguity.get(nk) ?? 1) > 1 || (p.gsis_id && badGsis.has(p.gsis_id))) ? 1 : 0;
      ins.run({
        key: resolveOrMint(db, { name: p.name ?? "", nameKey: nk, position: pos, ids: {} }).sk,
        nk, name: p.name, pos, team: p.team, bd: p.birthdate,
        gsis: gsisOk ? p.gsis_id : null,          // a disputed id is not recorded as this man's id
        espn: p.espn_id, sleeper: p.sleeper_id, fp: p.fantasypros_id,
        amb, src: "playerids", now,
      });
      res.rows++;
      if (gsisOk) res.withGsis++;
      if (amb) res.ambiguous++;
    }

    // 2. anyone on our board the crosswalk does NOT know -- rookies and late additions mostly.
    //    Added rather than dropped, because a staging layer that silently loses current players is
    //    worse than one that admits it does not have their ids. They carry source='board' so the gap
    //    is visible and countable rather than inferred from a row that looks complete.
    for (const b of db.prepare(
      "SELECT player_id, row_json FROM board WHERE season = (SELECT CAST(json_extract(value,'$.season') AS INTEGER) FROM settings WHERE key='config')",
    ).all() as { player_id: string; row_json: string }[]) {
      const j = JSON.parse(b.row_json) as Record<string, unknown>;
      const pos = normPos(String(j.Pos ?? ""));
      if (!pos) continue;
      // Match on NAME_KEY ALONE first, not name_key+position. Two sources routinely disagree about a
      // player's position -- our board had Max Bredeson at RB while the crosswalk has him at TE --
      // and requiring both to agree created a SECOND row for the same man, which is exactly the
      // duplicate this layer exists to prevent, arrived at from the opposite direction.
      //
      // Where the crosswalk knows the name unambiguously, it is the identity authority and its row
      // stands; the board's disagreement is about classification, not about who he is. Only when the
      // name is genuinely shared do we fall through and add a distinct row.
      const byName = db.prepare("SELECT COUNT(*) c FROM stg_player WHERE name_key = ?").get(b.player_id) as { c: number };
      if (byName.c === 1) continue;
      const known = db.prepare("SELECT 1 FROM stg_player WHERE name_key = ? AND position = ?").get(b.player_id, pos);
      if (known) continue;
      ins.run({
        key: resolveOrMint(db, { name: String(j.Player ?? ""), nameKey: b.player_id, position: pos, ids: {} }).sk,
        nk: b.player_id, name: String(j.Player ?? ""), pos,
        team: String(j.Team ?? ""), bd: null, gsis: null, espn: null, sleeper: null, fp: null,
        amb: (ambiguity.get(b.player_id) ?? 1) > 1 ? 1 : 0, src: "board", now,
      });
      res.rows++; res.fromBoardOnly++;
    }
  })();
  db.close();
  return res;
}

/**
 * Resolve a (name, position) to a stable player_key.
 *
 * Position is required rather than optional, and that is the whole point: a lookup that accepts a
 * bare name has to guess when the name is shared, and guessing is what produced the shipped bug.
 * Returns null when unknown so the caller must decide, instead of receiving a plausible wrong row.
 */
export function playerKey(db: DB, nameKeyed: string, pos: string): number | null {
  const r = db.prepare("SELECT player_sk FROM stg_player WHERE name_key = ? AND position = ?")
    .get(nameKeyed, normPos(pos)) as { player_sk: number } | undefined;
  return r?.player_sk ?? null;
}
