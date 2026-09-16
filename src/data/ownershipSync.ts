/**
 * THE OWNERSHIP OVERLAY -- who owns each player in a league -- written from a PLATFORM ROSTER READ.
 *
 * WHY IT IS ITS OWN FILE (P-1, WP7). `ff sync-rosters` used to be one 80-line ESPN body inside
 * `src/ff.ts`: it connected over CDP, ran an ESPN fetch inside the `espnview` guest, walked ESPN's
 * `teams[].roster.entries[]`, translated ESPN's lineupSlotId and wrote the rows. A Yahoo league
 * reaching that verb had exactly two possible outcomes, and neither was "Yahoo rosters in the store":
 * refuse (what WP5 made it do), or write ESPN's answer under a Yahoo league id.
 *
 * So the ESPN vocabulary now lives in the ESPN adaptor, the Yahoo vocabulary in the Yahoo adaptor, and
 * this file holds the part that is the SAME for both: turn `PlatformRoster[]` into `ownership` rows,
 * keyed the way every downstream join expects, and refuse to wipe real rows with an empty read.
 *
 * THE KEY IS THE REPO'S NAME KEY, NOT THE PLATFORM'S ID. `ownership.player_id` joins against `board`
 * and `player`, both of which are keyed by `nameKey(name)`. A defense is the one exception and it has
 * bitten this repo twice: ESPN names a defense by NICKNAME ("Packers D/ST" -> `packers`) while every
 * table we join against keys it by ABBREVIATION ("GB D/ST" -> `gb`), so an un-aliased defense row
 * matches nothing and each roster silently comes up one starter short. The alias is applied on
 * POSITION (`DST`), not on the lineup slot, because a benched defense sits in a bench slot.
 */
import type { DB } from "../db/db.js";
import { nameKey, dstAliasKey } from "../draft/values.js";
import type { PlatformRoster } from "../league/platform.js";

export interface OwnershipRow {
  playerId: string;
  owner: string;
  abbrev: string;
  slot: string;
  teamId: string;
}

/**
 * PURE: platform rosters -> the rows `ownership` holds. Exported so a test can assert the KEYING
 * (name key, DST alias, slot token, team id) against a fixture with no store and no browser.
 *
 * `owner` falls back to the team NAME and `abbrev` to `T<teamId>` when the adaptor could not read
 * them. That is a fallback to something the read actually produced -- never to another platform's
 * convention, and never to a manufactured manager name.
 */
export function ownershipRowsFrom(rosters: PlatformRoster[]): OwnershipRow[] {
  const out: OwnershipRow[] = [];
  for (const t of rosters) {
    const owner = (t.owner ?? "").trim() || t.teamName || `Team ${t.teamId}`;
    const abbrev = (t.abbrev ?? "").trim() || `T${t.teamId}`;
    for (const p of t.players) {
      let k = nameKey(p.name);
      if (!k) continue;
      if (String(p.pos).toUpperCase() === "DST") k = dstAliasKey(k) ?? k;
      out.push({ playerId: k, owner, abbrev, slot: p.slot, teamId: String(t.teamId) });
    }
  }
  return out;
}

export interface OwnershipWrite {
  /** "written" | "noop-empty" | "refuse-empty-wipe" -- the caller prints/fails on this, it does not
   *  have to re-derive the decision. */
  decision: "written" | "noop-empty" | "refuse-empty-wipe";
  rows: number;
  teams: number;
  existing: number;
}

/**
 * DELETE-THEN-INSERT, league-scoped, behind the empty-pull guard.
 *
 * The guard is the one the ESPN body already had and it is kept verbatim in MEANING: this verb wipes
 * the league's rows before inserting, so a read that came back with nothing (an expired session, a
 * markup change) used to delete everything, insert nothing, and exit 0 printing "0 players across 0
 * teams". Pre-draft an empty roster is genuine, so wiping an already-empty table is a quiet no-op;
 * an empty pull with rows to lose is a FAILURE.
 */
export function writeOwnership(db: DB, leagueId: string, rosters: PlatformRoster[], now: string): OwnershipWrite {
  const rows = ownershipRowsFrom(rosters);
  const existing = (db.prepare("SELECT count(*) AS c FROM ownership WHERE league_id=?").get(leagueId) as { c: number }).c;
  if (!rows.length) return { decision: existing > 0 ? "refuse-empty-wipe" : "noop-empty", rows: 0, teams: 0, existing };
  const up = db.prepare(
    "INSERT OR REPLACE INTO ownership (league_id, player_id, owner, team_abbrev, slot, team_id, updated_at) VALUES (@lid,@pid,@own,@abr,@slot,@tid,@now)",
  );
  db.transaction(() => {
    db.prepare("DELETE FROM ownership WHERE league_id=?").run(leagueId);
    for (const r of rows) up.run({ lid: leagueId, pid: r.playerId, own: r.owner, abr: r.abbrev, slot: r.slot, tid: r.teamId, now });
  })();
  const teams = new Set(rosters.filter((t) => t.players.length).map((t) => String(t.teamId))).size;
  return { decision: "written", rows: rows.length, teams, existing };
}
