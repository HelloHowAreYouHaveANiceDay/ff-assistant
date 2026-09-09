/**
 * MIGRATING A FROZEN TABLE THROUGH `identity_rekey`.
 *
 * `scorecard_prediction` is WRITE-ONCE by design: a prediction that can be edited after the fact is
 * not a prediction. Its `subject` column, for the `season` and `weekly` kinds, holds a `player_sk` --
 * so when Phase 2c moved 11,946 of those keys, every frozen row silently stopped naming anybody.
 * Nothing failed: a scorecard row with an unjoinable subject still renders, still carries its value,
 * and still gets scored against a result it can no longer be matched to.
 *
 * REGENERATING THE ROWS IS NOT AN OPTION and that is the whole point of the table. They are migrated
 * instead: the value, the model, the as_of and the created_at are untouched, and only the pointer
 * moves -- which is exactly what a surrogate-key migration is for.
 *
 * A SPLIT IS THE ONE CASE THAT NEEDS EVIDENCE. Where one old key became several (Marvin Harrison
 * Sr./Jr.), the map alone cannot say which man the frozen row meant, so the row's own `name` and
 * `pos` are checked against staging and a row that still cannot be told apart is LEFT ALONE and
 * COUNTED. Picking one would be the merge this phase exists to undo, performed on the one table
 * nobody is allowed to rewrite.
 */
import type { DB } from "../db/db.js";

export interface FrozenMigration {
  rows: number;          // rows whose subject is a surrogate key at all
  migrated: number;      // pointers moved
  unchanged: number;     // already pointing at a live key
  ambiguous: number;     // a split the row's own name/pos could not resolve -- left alone
  unmapped: number;      // no rekey entry and not a live key -- left alone
  collided: number;      // the target key already has a frozen row here (a MERGE) -- left alone
}

/** old_sk -> the new keys it became. Several when the old key was a SPLIT. */
export function rekeyMap(db: DB): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let rows: { old_sk: number; new_sk: number | null }[] = [];
  try { rows = db.prepare("SELECT old_sk, new_sk FROM identity_rekey WHERE new_sk IS NOT NULL").all() as typeof rows; }
  catch { return out; }
  for (const r of rows) (out.get(r.old_sk) ?? out.set(r.old_sk, []).get(r.old_sk)!).push(r.new_sk!);
  return out;
}

/**
 * Move `scorecard_prediction.subject` from the old key space to the new one.
 *
 * IDEMPOTENT BY A STAMP, not by inspection, and the difference is not pedantic. The old and new key
 * spaces OVERLAP -- old key 12097 is a real key in both -- so "is this subject a live staging key?"
 * cannot distinguish a migrated row from an unmigrated one, and a second run would happily migrate
 * the migrated rows a second time. `settings.scorecard_rekey` records which rekey this table has
 * been through; a run against the same one is a no-op that says so. The table's guarantee is that a
 * stored prediction never changes, and a migration that is not idempotent is a second writer.
 *
 * TWO PASSES, for the same reason. Checking "is the target subject already taken?" against the table
 * MID-MIGRATION compares against rows that have not moved yet -- and because the key spaces overlap,
 * another player's OLD key can be sitting on the value this row is moving to. The first cut did
 * exactly that and reported five real moves as merge collisions: Andy Borregales' frozen rows were
 * blocked by a row whose own (old) subject was 12097 and which then moved away. So every target is
 * computed FIRST, collisions are detected in the FINAL assignment, and the writes go through a
 * temporary prefixed form so no intermediate state can conflict.
 */
export function migrateScorecardSubjects(db: DB): FrozenMigration {
  const res: FrozenMigration = { rows: 0, migrated: 0, unchanged: 0, ambiguous: 0, unmapped: 0, collided: 0 };
  const map = rekeyMap(db);
  const stampRow = db.prepare("SELECT value FROM settings WHERE key = 'scorecard_rekey'").get() as { value: string } | undefined;
  const stamp = (db.prepare("SELECT rebuilt_at FROM identity_rekey LIMIT 1").get() as { rebuilt_at: string } | undefined)?.rebuilt_at ?? null;
  if (stamp && stampRow?.value === stamp) return res;   // already migrated for this rekey
  const live = new Set((db.prepare("SELECT player_sk FROM stg_player").all() as { player_sk: number }[]).map((r) => r.player_sk));
  const stg = new Map<number, { name_key: string; position: string; name: string }>();
  for (const r of db.prepare("SELECT player_sk, name_key, position, name FROM stg_player")
    .all() as { player_sk: number; name_key: string; position: string; name: string }[]) stg.set(r.player_sk, r);

  // ONLY the player kinds. `odds` rows are keyed by TEAM id -- also small integers, also numeric,
  // and belonging to a completely different domain. Migrating them through a player map would have
  // rewritten team 7 into whichever player key that happened to hit, and the first attempt did
  // exactly that and was caught only by a UNIQUE constraint. A numeric column is not a key space.
  const rows = db.prepare(
    "SELECT rowid AS rid, subject, name, pos FROM scorecard_prediction WHERE kind IN ('season','weekly') AND subject GLOB '[0-9]*'",
  ).all() as { rid: number; subject: string; name: string | null; pos: string | null }[];
  const upd = db.prepare("UPDATE scorecard_prediction SET subject = ? WHERE rowid = ?");
  const slot = db.prepare("SELECT season, week, kind, model FROM scorecard_prediction WHERE rowid = ?");

  // ---- PASS 1: decide every target, and only then look for collisions among the targets ---------
  const plan: { rid: number; to: string; slot: string }[] = [];
  const stay = new Set<string>();          // slots occupied by rows that are NOT moving
  for (const r of rows) {
    const old = Number(r.subject);
    if (!Number.isInteger(old)) continue;
    res.rows++;
    const s = slot.get(r.rid) as { season: number; week: number | null; kind: string; model: string };
    const key = (sub: string) => `${s.season}|${s.week}|${s.kind}|${s.model}|${sub}`;
    const cands = map.get(old) ?? [];
    if (!cands.length) {
      if (live.has(old)) res.unchanged++; else res.unmapped++;
      stay.add(key(r.subject));
      continue;
    }
    let pick: number | null = cands.length === 1 ? cands[0] : null;
    if (pick == null) {
      // A SPLIT. Use the row's own recorded name and position -- evidence the frozen row carries
      // about itself -- and refuse if that still leaves more than one candidate.
      const want = (r.name ?? "").trim().toLowerCase(), pos = (r.pos ?? "").trim().toUpperCase();
      const hits = cands.filter((c) => {
        const st = stg.get(c); if (!st) return false;
        return (!pos || (st.position ?? "").toUpperCase() === pos) && (!want || (st.name ?? "").trim().toLowerCase() === want);
      });
      if (hits.length === 1) pick = hits[0];
    }
    if (pick == null) { res.ambiguous++; stay.add(key(r.subject)); continue; }
    if (pick === old) { res.unchanged++; stay.add(key(r.subject)); continue; }
    plan.push({ rid: r.rid, to: String(pick), slot: key(String(pick)) });
  }

  // ---- collisions, in the FINAL assignment only --------------------------------------------------
  // A MERGE can send two frozen rows to one key, and the table's uniqueness is what says a
  // prediction is made once. The LATER row stays where it is and is counted; deleting it, or
  // overwriting the first, would be a write to a write-once table.
  const claimed = new Set(stay);
  const doIt: typeof plan = [];
  for (const p of plan) {
    if (claimed.has(p.slot)) { res.collided++; continue; }
    claimed.add(p.slot);
    doIt.push(p);
  }

  // ---- PASS 2: write, through a temporary form so no intermediate state can conflict -------------
  db.transaction(() => {
    for (const p of doIt) upd.run(`~${p.to}`, p.rid);
    for (const p of doIt) { upd.run(p.to, p.rid); res.migrated++; }
    if (stamp) {
      db.prepare("INSERT INTO settings (key, value) VALUES ('scorecard_rekey', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(stamp);
    }
  })();
  return res;
}
