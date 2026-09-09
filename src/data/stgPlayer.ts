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
 * ...AND FOR A YEAR IT DID NOT ACTUALLY READ IT. `resolveOrMint` was called with an EMPTY id bag and
 * no birthdate, so every match attempt fell through to the "name_key + position, among rows that
 * also have no birthdate" branch -- which misses every registry row, because registry rows DO carry
 * a birthdate. Staging therefore minted a fresh key for almost everybody, and the store ended up
 * holding TWO DISJOINT SURROGATE KEY SPACES for the same men: of the 7,961 gsis ids present in both
 * `stg_player` and `player_xref`, 7,902 disagreed. Anything resolving through the registry joined
 * nothing, silently, with a plausible-looking resolution rate. Fixed in Phase 2c by passing the real
 * id bag and birthdate; `identity_rekey` records where every old key went.
 *
 * THE TIE-BREAK, when the registry and the old staging disagree about who a row is: THE REGISTRY
 * WINS, always. docs/data-layers.md makes it the foundation and staging the reader, and a reader that
 * overrides its own source of truth is not a reader. Concretely, `resolveOrMint`'s ordered evidence
 * (gsis, espn, sleeper, pfr, fantasypros, then name+birthdate) decides, and the previous staging key
 * is not consulted at all -- it only appears in `identity_rekey` as the old side of the map.
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
import { resolveOrMint, crosswalkPeople, disputedIds, idBag } from "./identity.js";

export interface RekeySummary {
  rows: number; unchanged: number; moved: number; merged: number; split: number; dropped: number;
  /** true = this rebuild moved no key, so the map from the rebuild that DID move keys was kept. */
  preserved?: boolean;
}

export interface StgBuildResult {
  rows: number; withGsis: number; ambiguous: number; fromBoardOnly: number;
  /** How identity was decided, per rule. `minted` here is the number of people the REGISTRY did not
   *  already know -- the figure that says whether staging is reading the registry or writing it. */
  matched: Record<string, number>;
  rekey: RekeySummary;
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
 *
 * (The function itself is below `normTeam`, which is the same idea applied to the other vocabulary.)
 */

/**
 * CONFORM THE TEAM VOCABULARY, for exactly the reason `normPos` conforms the position one.
 *
 * The DynastyProcess crosswalk writes PFR-style codes -- SFO, NEP, GNB, KCC, TBB -- and everything
 * else in this store (the board, ECR, nflverse) writes SF, NE, GB, KC, TB. Nothing ever compared
 * them, so every consumer that used team as a DISCRIMINATOR silently lost it: `pickStaged` filters
 * candidates whose team CONTRADICTS the board's, and against a staging row reading "SFO" the board's
 * "SF" is a contradiction, so Christian McCaffrey had no usable staged row at all and his age fell
 * back to the name-keyed bio table -- the precise join this layer exists to remove, defeated by a
 * spelling.
 *
 * Mapped here rather than at each call site because two copies of a vocabulary map that must agree
 * is a drift waiting to happen; `TEAM_ALIAS` in nflverse.ts is the same table for the nflverse
 * spellings and this is deliberately kept next to the layer whose job conforming is.
 * `FA`/`FA*`/`NA` mean "no team", which is a real state and stays empty rather than becoming a code.
 */
const TEAM_CONFORM: Record<string, string> = {
  GBP: "GB", KCC: "KC", LVR: "LV", NEP: "NE", NOS: "NO", SFO: "SF", TBB: "TB",
  RAM: "LAR", SDC: "LAC", STL: "LAR", OAK: "LV", ARZ: "ARI", JAX: "JAC", WSH: "WAS", LA: "LAR",
};
export function normTeam(team: string | null | undefined): string | null {
  const t = (team || "").trim().toUpperCase().replace(/\*+$/, "");
  if (!t || t === "FA" || t === "NA" || t === "NONE") return null;
  return TEAM_CONFORM[t] ?? t;
}

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

  // THE PEOPLE, with collapsed ambiguous keys expanded back into individuals. Shared with the
  // registry (identity.ts) on purpose: two readers of `player_ids` that disagree about how many
  // people an ambiguous key stands for is exactly how the two key spaces diverged the first time.
  const people = crosswalkPeople(db);

  // How many DISTINCT people share each name_key, counted over the SAME row set the flag describes.
  // It used to be a SQL COUNT(DISTINCT position) over player_ids, which cannot see the case the flag
  // matters most for: Marvin Harrison Sr. and Jr. are two people at ONE position, so that count
  // said 1 and both men went unflagged inside a single row.
  const ambiguity = new Map<string, number>();
  for (const p of people) {
    const k = p.name_key;
    ambiguity.set(k, (ambiguity.get(k) ?? 0) + 1);
  }

  // THE SOURCE'S OWN IDS ARE NOT ALL TRUSTWORTHY, and taking them on faith made this layer reproduce
  // the exact bug it exists to prevent. Ten gsis ids in the crosswalk are attached to more than one
  // real person -- 00-0022888 belongs to both Jake Schum (punter) and Bobby McCray (defensive end).
  // Keying on gsis blindly merged those pairs into one staging row, silently, which is precisely
  // what a name_key does and what this layer is supposed to stop.
  //
  // So a gsis id earns the right to be recorded only if it maps to ONE person. Where it does not,
  // the row is flagged ambiguous and the id is withheld, because a bad id is worse than no id: it
  // looks authoritative.
  const disputed = disputedIds(people);
  const badGsis = (g: string | null) => !!g && disputed.has(`gsis:${g}`);

  const ins = db.prepare(
    `INSERT INTO stg_player (player_sk, name_key, name, position, team, birthdate, gsis_id, espn_id,
                             sleeper_id, pfr_id, fantasypros_id, ambiguous, source, updated_at)
     VALUES (@key,@nk,@name,@pos,@team,@bd,@gsis,@espn,@sleeper,@pfr,@fp,@amb,@src,@now)
     ON CONFLICT(player_sk) DO UPDATE SET
       name=excluded.name, team=excluded.team, birthdate=excluded.birthdate,
       gsis_id=COALESCE(excluded.gsis_id, stg_player.gsis_id),
       espn_id=COALESCE(excluded.espn_id, stg_player.espn_id),
       pfr_id=COALESCE(excluded.pfr_id, stg_player.pfr_id),
       ambiguous=excluded.ambiguous, updated_at=excluded.updated_at`,
  );
  const res: StgBuildResult = {
    rows: 0, withGsis: 0, ambiguous: 0, fromBoardOnly: 0, matched: {},
    rekey: { rows: 0, unchanged: 0, moved: 0, merged: 0, split: 0, dropped: 0 },
  };

  db.transaction(() => {
    // THE OLD KEYS, read before anything is deleted. Without this snapshot the rebuild would move
    // almost every surrogate key with no record of where it went, and every table keyed by the old
    // space would join nothing -- which is the failure this whole step exists to end, repeated.
    const oldRows = db.prepare(
      "SELECT player_sk, name_key, position, birthdate FROM stg_player",
    ).all() as { player_sk: number; name_key: string; position: string; birthdate: string | null }[];
    db.prepare("DELETE FROM stg_player").run();

    // 1. everyone the crosswalk knows -- the authoritative source of identity
    for (const p of people) {
      const nk = p.name_key, pos = normPos(p.position);
      const bad = badGsis(p.gsis_id);
      const gsisOk = p.gsis_id && !bad;
      const amb = ((ambiguity.get(nk) ?? 1) > 1 || bad) ? 1 : 0;
      // THE REGISTRY DECIDES. The full id bag AND the birthdate are passed, which is the entire fix:
      // with `ids: {}` and no birthdate every call fell through to the no-birthdate name+position
      // branch, matched nothing in a registry whose rows all carry birthdates, and minted.
      const r = resolveOrMint(db, { name: p.name ?? "", nameKey: nk, position: pos, birthdate: p.birthdate, ids: idBag(p) }, disputed);
      res.matched[r.matchedBy] = (res.matched[r.matchedBy] ?? 0) + 1;
      ins.run({
        key: r.sk,
        nk, name: p.name, pos, team: normTeam(p.team), bd: p.birthdate,
        gsis: gsisOk ? p.gsis_id : null,          // a disputed id is not recorded as this man's id
        espn: p.espn_id, sleeper: p.sleeper_id, pfr: p.pfr_id, fp: p.fantasypros_id,
        amb, src: p.variant ? "playerids-variant" : "playerids", now,
      });
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
      const r = resolveOrMint(db, { name: String(j.Player ?? ""), nameKey: b.player_id, position: pos, ids: {} }, disputed);
      res.matched[r.matchedBy] = (res.matched[r.matchedBy] ?? 0) + 1;
      ins.run({
        key: r.sk,
        nk: b.player_id, name: String(j.Player ?? ""), pos,
        team: normTeam(String(j.Team ?? "")), bd: null, gsis: null, espn: null, sleeper: null, pfr: null, fp: null,
        amb: (ambiguity.get(b.player_id) ?? 1) > 1 ? 1 : 0, src: "board", now,
      });
      res.fromBoardOnly++;
    }

    // ROWS is counted from the table rather than from the loop: two crosswalk people can resolve to
    // one surrogate key (the registry says they are the same man), and an incremented counter would
    // then report more rows than exist. A count that can disagree with its own table is not a count.
    res.rows = (db.prepare("SELECT COUNT(*) c FROM stg_player").get() as { c: number }).c;
    res.rekey = writeRekey(db, oldRows, now);
  })();
  db.close();
  return res;
}

/**
 * THE REKEY MAP: where every OLD staging key went.
 *
 * Old and new rows are matched on the NATURAL key `(name_key, position)` -- the only thing both
 * spaces share, since the surrogate keys are exactly what moved. Where one natural key now stands
 * for several people (Harrison Sr./Jr.), birthdate picks the successor; where it cannot, the old key
 * is mapped to EVERY successor and the row reads `split`, which is the truth: the old key stood for
 * all of them.
 *
 * The reason is DERIVED from the shape of the mapping, never asserted by the caller. A hand-set
 * label is a name, and a guard keyed on a name keeps passing after the thing it names changes.
 */
function writeRekey(
  db: DB,
  oldRows: { player_sk: number; name_key: string; position: string; birthdate: string | null }[],
  now: string,
): RekeySummary {
  const byNatural = new Map<string, { sk: number; bd: string | null }[]>();
  const byNameBirth = new Map<string, number[]>();
  for (const r of db.prepare("SELECT player_sk, name_key, position, birthdate FROM stg_player")
    .all() as { player_sk: number; name_key: string; position: string; birthdate: string | null }[]) {
    const k = `${r.name_key}|${normPos(r.position)}`;
    (byNatural.get(k) ?? byNatural.set(k, []).get(k)!).push({ sk: r.player_sk, bd: r.birthdate });
    if (r.birthdate) {
      const b = `${r.name_key}|${r.birthdate}`;
      (byNameBirth.get(b) ?? byNameBirth.set(b, []).get(b)!).push(r.player_sk);
    }
  }

  const edges: [number, number][] = [];
  const dropped: number[] = [];
  for (const o of oldRows) {
    const cands = byNatural.get(`${o.name_key}|${normPos(o.position)}`) ?? [];
    if (cands.length === 1) { edges.push([o.player_sk, cands[0].sk]); continue; }
    if (cands.length > 1) {
      const exact = o.birthdate ? cands.filter((c) => c.bd === o.birthdate) : [];
      for (const c of (exact.length === 1 ? exact : cands)) edges.push([o.player_sk, c.sk]);
      continue;
    }
    // NO ROW AT THIS (name_key, position) ANY MORE. Almost always that is a MERGE, not a loss: the
    // registry decided this row and another one are the same man, and kept the other one's position.
    // Calling it `dropped` without looking would have reported the seven real merges in this store
    // as seven lost players -- a count that is wrong in the alarming direction, which is worse than
    // one that is wrong in the reassuring direction only because it gets acted on.
    const same = o.birthdate ? (byNameBirth.get(`${o.name_key}|${o.birthdate}`) ?? []) : [];
    if (same.length === 1) { edges.push([o.player_sk, same[0]]); continue; }
    dropped.push(o.player_sk);
  }

  const newOf = new Map<number, Set<number>>();
  const oldOf = new Map<number, Set<number>>();
  for (const [o, n] of edges) {
    (newOf.get(o) ?? newOf.set(o, new Set()).get(o)!).add(n);
    (oldOf.get(n) ?? oldOf.set(n, new Set()).get(n)!).add(o);
  }

  // A REBUILD THAT MOVES NOTHING MUST NOT ERASE THE MAP OF THE ONE THAT DID. `build-staging` is
  // idempotent by design, so the second run reads the NEW keys as its "old" side and derives a
  // perfect identity map -- writing that over the real migration would delete the only record of
  // where 11,953 keys went, silently, on a command whose whole selling point is that re-running it
  // is safe. Nothing moved means nothing to record.
  if (!dropped.length && edges.every(([o, n]) => o === n)) {
    const held = db.prepare("SELECT COUNT(*) c FROM identity_rekey").get() as { c: number };
    if (held.c) return { rows: held.c, unchanged: edges.length, moved: 0, merged: 0, split: 0, dropped: 0, preserved: true };
  }

  const sum: RekeySummary = { rows: 0, unchanged: 0, moved: 0, merged: 0, split: 0, dropped: dropped.length };
  const ins = db.prepare(
    "INSERT INTO identity_rekey (old_sk, new_sk, reason, rebuilt_at) VALUES (?,?,?,?) ON CONFLICT(old_sk,new_sk) DO UPDATE SET reason=excluded.reason, rebuilt_at=excluded.rebuilt_at",
  );
  db.prepare("DELETE FROM identity_rekey").run();
  for (const [o, ns] of newOf) {
    const reason = ns.size > 1 ? "split"
      : [...ns].some((n) => (oldOf.get(n)?.size ?? 1) > 1) ? "merged"
      : [...ns][0] === o ? "unchanged" : "moved";
    for (const n of ns) ins.run(o, n, reason, now);
    sum.rows++;
    sum[reason as "unchanged" | "moved" | "merged" | "split"]++;
  }
  for (const o of dropped) { ins.run(o, null, "dropped", now); sum.rows++; }
  return sum;
}

/**
 * Resolve a (name, position) to a stable player_key.
 *
 * Position is required rather than optional, and that is the whole point: a lookup that accepts a
 * bare name has to guess when the name is shared, and guessing is what produced the shipped bug.
 * Returns null when unknown so the caller must decide, instead of receiving a plausible wrong row.
 */
export function playerKey(db: DB, nameKeyed: string, pos: string): number | null {
  // ALL of them, then exactly-one-or-null. `.get()` returned whichever row SQLite reached first, so
  // the moment staging learned to hold Marvin Harrison Sr. AND Jr. -- two men, one (name_key,
  // position) -- this function started guessing between them, quietly, which is the bug the layer
  // exists to prevent wearing the layer's own API.
  const r = db.prepare("SELECT player_sk FROM stg_player WHERE name_key = ? AND position = ?")
    .all(nameKeyed, normPos(pos)) as { player_sk: number }[];
  return r.length === 1 ? r[0].player_sk : null;
}
