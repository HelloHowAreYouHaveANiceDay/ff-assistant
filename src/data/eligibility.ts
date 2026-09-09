/**
 * ESPN POSITION ELIGIBILITY, as raw -- and then staged onto the surrogate key.
 *
 * WHY IT EXISTS. `docs/data-layers.md` already says position is an ATTRIBUTE and multi-valued, and
 * `player_position` is the table that says so. What it actually holds, though, is cross-source
 * SPELLINGS (PK vs K, a man reclassified RB -> TE between feeds). ESPN's own answer to "which slots
 * may this player be started in" -- `eligibleSlots` on every `kona_player_info` player object -- was
 * fetched for free on every board build and thrown away. This ingests it.
 *
 * READ-ONLY, THROUGH THE BRIDGE. src/browser/appBridge.ts posts a GET into the desktop app's
 * logged-in webview. No ESPN write happens here and none can: the only route used is `/fetch`.
 *
 * THE SLOT TABLE IS THE WHOLE SUBTLETY, so it is written out rather than inferred. ESPN's
 * `eligibleSlots` mixes two different kinds of id:
 *
 *   DEDICATED slots, which name one position    0 QB, 2 RB, 4 WR, 6 TE, 16 D/ST, 17 K
 *   COMBO slots, which name a set               3 RB/WR, 5 WR/TE, 7 OP (any offensive player),
 *                                               23 FLEX (RB/WR/TE)
 *   BENCH-like slots, which name no position    20 BE, 21 IR, 24 ER
 *
 * Every wide receiver in the league carries slot 3 (RB/WR) and slot 23 (FLEX). Reading those as
 * positions would make the ENTIRE board dual-eligible and the feature meaningless -- which is exactly
 * the failure mode this comment exists to prevent. Only the DEDICATED ids become positions; the combo
 * and bench ids are recorded raw and otherwise ignored.
 */
import { bridgeAvailable, bridgeFetch } from "../browser/appBridge.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nowIso, type DB } from "../db/db.js";
import { dataPath } from "./paths.js";

const HOST = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";

/** Every lineupSlotId ESPN uses, with its name. Kept complete so an unknown id is visibly unknown
 *  rather than silently absent. Mirrors SLOT_NAME in src/league/espn.ts. */
export const ESPN_SLOT_NAME: Record<number, string> = {
  0: "QB", 1: "TQB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP",
  8: "DT", 9: "DE", 10: "LB", 11: "DL", 12: "CB", 13: "S", 14: "DB", 15: "DP",
  16: "DST", 17: "K", 18: "P", 19: "HC", 20: "BE", 21: "IR", 23: "FLEX", 24: "ER",
  // 25 appears on 89 of the 1,036 players in the 2026 pool and ESPN does not publish a name for it
  // in any documentation this repo has found. It is recorded as unknown rather than guessed at, and
  // it is NOT in DEDICATED_SLOT_POS, so it contributes no position either way.
  25: "?25",
};

/** The ONLY slot ids that name a single position in our vocabulary. A combo slot (3, 5, 7, 23) is
 *  eligibility at a SET and is deliberately absent: treating it as a position would mark every
 *  receiver in football RB-eligible. */
export const DEDICATED_SLOT_POS: Record<number, string> = {
  0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "DST", 17: "K",
};

/** ESPN's defaultPositionId -- the same table src/league/espn.ts keeps. */
const ESPN_POS: Record<number, string> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };

/** The positions a value book and a lineup actually distinguish. */
export const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];

export interface EligibilityRow {
  season: number;
  espnPlayerId: string;
  name: string;
  /** ESPN's defaultPositionId mapped to our vocabulary, or "" when it is one we do not carry. */
  defaultPosition: string;
  /** Our-vocabulary positions from the DEDICATED slot ids, deduped, in QB/RB/WR/TE/K/DST order. */
  eligiblePositions: string[];
  /** Every raw slot id ESPN returned, unfiltered -- so a future slot table change is auditable. */
  rawSlots: number[];
}

export interface EligibilityFetch {
  ok: boolean;
  reason: string;
  rows: EligibilityRow[];
  /** How many player objects came back at all, whether or not they carried eligibleSlots. */
  players: number;
}

interface EspnPlayerObj { id?: number; fullName?: string; defaultPositionId?: number; eligibleSlots?: number[] }
interface EspnEntry { id?: number; player?: EspnPlayerObj; playerPoolEntry?: { player?: EspnPlayerObj } }

const POS_ORDER = ["QB", "RB", "WR", "TE", "K", "DST"];

/** Map one player object. Exported so the mapping can be tested without a network or a database. */
export function mapEligibility(season: number, p: EspnPlayerObj, fallbackId?: number): EligibilityRow | null {
  if (!p?.fullName) return null;
  const rawSlots = (p.eligibleSlots ?? []).filter((n) => Number.isFinite(n)).map(Number);
  const set = new Set<string>();
  for (const s of rawSlots) { const pos = DEDICATED_SLOT_POS[s]; if (pos) set.add(pos); }
  const def = ESPN_POS[p.defaultPositionId ?? -1] ?? "";
  // A player whose eligibleSlots carry no dedicated id at all (ESPN does this for a handful of
  // unlisted men) still has a default position, and dropping him would silently shrink the map.
  if (!set.size && def) set.add(def);
  return {
    season,
    espnPlayerId: String(p.id ?? fallbackId ?? p.fullName),
    name: p.fullName,
    defaultPosition: def,
    eligiblePositions: POS_ORDER.filter((x) => set.has(x)),
    rawSlots,
  };
}

/**
 * Read `eligibleSlots` for the whole pool of `season`.
 *
 * `limit` is the adaptor's own 2000 (src/league/espn.ts playerPool), not the 250 the free-agent view
 * uses: the free-agent list is a slice of the pool and eligibility is a property of the MAN, so
 * asking only about the unowned half would leave every rostered player unclassified.
 */
export async function fetchEspnEligibility(opts: {
  season: number; limit?: number; leagueId?: string;
}): Promise<EligibilityFetch> {
  if (!bridgeAvailable()) {
    return { ok: false, reason: "app bridge not available -- open the desktop app and log in to ESPN", rows: [], players: 0 };
  }
  const limit = opts.limit ?? 2000;
  const base = opts.leagueId
    ? `${HOST}/seasons/${opts.season}/segments/0/leagues/${opts.leagueId}`
    : `${HOST}/seasons/${opts.season}/segments/0/leaguedefaults/3`;
  const url = `${base}?view=kona_player_info`;
  const filter = { players: { limit, sortDraftRanks: { sortPriority: 1, sortAsc: true, value: "STANDARD" } } };
  let body: string;
  try { body = await bridgeFetch(url, { "x-fantasy-filter": JSON.stringify(filter) }); }
  catch (e) { return { ok: false, reason: `bridge fetch failed: ${e instanceof Error ? e.message : e}`, rows: [], players: 0 }; }
  let json: { players?: EspnEntry[] };
  try { json = JSON.parse(body) as { players?: EspnEntry[] }; }
  catch { return { ok: false, reason: `ESPN returned non-JSON (${body.slice(0, 100)})`, rows: [], players: 0 }; }

  const entries = json.players ?? [];
  if (!entries.length) return { ok: false, reason: "ESPN returned no players -- session expired, or the payload shape changed", rows: [], players: 0 };
  const rows: EligibilityRow[] = [];
  for (const e of entries) {
    const r = mapEligibility(opts.season, (e.player ?? e.playerPoolEntry?.player) as EspnPlayerObj, e.id);
    if (r) rows.push(r);
  }
  // A payload that carries players but NO eligibleSlots on any of them is a shape change, not an
  // answer. Say so rather than storing a pool of single-eligible defaults that reads as a measurement.
  const withSlots = rows.filter((r) => r.rawSlots.length).length;
  if (!withSlots) {
    return { ok: false, players: entries.length, rows: [],
      reason: `ESPN returned ${entries.length} players and not one carried eligibleSlots -- the field is ` +
        "not in this payload, so nothing was stored. It is not inferred from defaultPositionId: that " +
        "would be a single position wearing eligibility's name." };
  }
  return { ok: true, reason: `${withSlots} of ${entries.length} players carried eligibleSlots`, rows, players: entries.length };
}

/** Where a fetched payload is cached, so tests and re-runs need no network. */
export function eligibilityCachePath(season: number): string {
  return dataPath(`cache/espn/eligibility-${season}.json`);
}

export function writeEligibilityCache(season: number, rows: EligibilityRow[]): void {
  const f = eligibilityCachePath(season);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(rows, null, 1), "utf8");
}

export function readEligibilityCache(season: number): EligibilityRow[] | null {
  const f = eligibilityCachePath(season);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")) as EligibilityRow[]; } catch { return null; }
}

/** raw_espn_eligibility: ESPN's answer, unjoined and unjudged. */
export function storeRawEligibility(db: DB, rows: EligibilityRow[]): number {
  const now = nowIso();
  const ins = db.prepare(
    `INSERT INTO raw_espn_eligibility (season, espn_player_id, name, default_position, eligible_positions_json, raw_slots_json, fetched_at)
     VALUES (@season,@id,@name,@def,@elig,@raw,@now)
     ON CONFLICT(season, espn_player_id) DO UPDATE SET
       name=excluded.name, default_position=excluded.default_position,
       eligible_positions_json=excluded.eligible_positions_json,
       raw_slots_json=excluded.raw_slots_json, fetched_at=excluded.fetched_at`,
  );
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      ins.run({ season: r.season, id: r.espnPlayerId, name: r.name, def: r.defaultPosition,
        elig: JSON.stringify(r.eligiblePositions), raw: JSON.stringify(r.rawSlots), now });
      n++;
    }
  })();
  return n;
}

export interface StageResult { staged: number; unresolved: number; unresolvedNames: string[] }

/**
 * raw -> player_eligibility, resolved through `player_xref` BY ESPN ID.
 *
 * NEVER BY NAME, and the case that proves it is the two Justin Jeffersons -- the wide receiver and
 * the linebacker share a `nameKey` exactly (nameKey strips suffixes and punctuation on purpose), so a
 * name join hands one man the other's eligibility and there is no symptom. `player_xref` is UNIQUE on
 * (source, source_id), so an ESPN id resolves to one surrogate key or to none; "none" is recorded as
 * unresolved rather than guessed at.
 *
 * `resolveBy` exists for ONE reason: the fault-injection test flips it to "name" and watches the
 * two-Jeffersons fixture fail. A guard nobody has seen fail is not a guard.
 */
export function stageEligibility(
  db: DB, season: number, rows: EligibilityRow[], resolveBy: "espn_id" | "name" = "espn_id",
): StageResult {
  const bySk = new Map<number, Set<string>>();
  const unresolvedNames: string[] = [];

  const xref = db.prepare("SELECT source_id, player_sk FROM player_xref WHERE source='espn'").all() as
    { source_id: string; player_sk: number }[];
  const byEspn = new Map(xref.map((r) => [String(r.source_id), r.player_sk]));

  const byName = new Map<string, number>();
  if (resolveBy === "name") {
    for (const r of db.prepare("SELECT name_key, player_sk FROM player_identity").all() as
      { name_key: string; player_sk: number }[]) byName.set(r.name_key, r.player_sk);
  }

  for (const r of rows) {
    const sk = resolveBy === "espn_id"
      ? byEspn.get(String(r.espnPlayerId))
      : byName.get(nameKeyLocal(r.name));
    if (sk == null) { unresolvedNames.push(r.name); continue; }
    const set = bySk.get(sk) ?? new Set<string>();
    for (const p of r.eligiblePositions) set.add(p);
    bySk.set(sk, set);
  }

  const now = nowIso();
  const ins = db.prepare(
    `INSERT INTO player_eligibility (player_sk, season, positions_json, updated_at)
     VALUES (@sk,@season,@pos,@now)
     ON CONFLICT(player_sk, season) DO UPDATE SET positions_json=excluded.positions_json, updated_at=excluded.updated_at`,
  );
  db.transaction(() => {
    db.prepare("DELETE FROM player_eligibility WHERE season=?").run(season);
    for (const [sk, set] of bySk) ins.run({ sk, season, pos: JSON.stringify(POS_ORDER.filter((p) => set.has(p))), now });
  })();
  return { staged: bySk.size, unresolved: unresolvedNames.length, unresolvedNames: unresolvedNames.slice(0, 20) };
}

/** A local copy of the name normaliser, imported lazily to keep this module free of a value-book
 *  dependency in the hot path. Only the "name" fault-injection mode uses it. */
function nameKeyLocal(s: string): string {
  return s.toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b/g, " ").replace(/\bd\/?st\b/g, " ").replace(/[^a-z]/g, "");
}

/**
 * The consumer-facing map: nameKey -> eligible positions, for the board of one season.
 *
 * Keyed by nameKey because that is what the board, the value book and points.csv are keyed by; the
 * join to the surrogate key happens HERE, once, rather than in each consumer. Rows whose eligibility
 * is a single position are OMITTED: a consumer treats a missing entry as "[his own position]", so an
 * empty map is exactly the pre-change behaviour and the diff is visible in the map's size.
 */
export function loadEligibilityMap(db: DB, season: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const rows = db.prepare(
    `SELECT i.name_key AS name_key, e.positions_json AS positions_json
       FROM player_eligibility e JOIN player_identity i USING (player_sk)
      WHERE e.season = ?`,
  ).all(season) as { name_key: string; positions_json: string }[];
  for (const r of rows) {
    let pos: string[];
    try { pos = JSON.parse(r.positions_json) as string[]; } catch { continue; }
    const skill = pos.filter((p) => SKILL_POSITIONS.includes(p));
    if (skill.length > 1) out.set(r.name_key, skill);
  }
  return out;
}

/** Ingest end to end: fetch (or read the cache), store raw, stage. Returns the raw row count. */
export async function ingestEligibility(opts: {
  db: DB; season: number; leagueId?: string; useCache?: boolean;
}): Promise<{ rows: number; staged: StageResult; reason: string }> {
  let rows = opts.useCache ? readEligibilityCache(opts.season) : null;
  let reason = rows ? `read ${rows.length} rows from the cache` : "";
  if (!rows) {
    const res = await fetchEspnEligibility({ season: opts.season, leagueId: opts.leagueId });
    if (!res.ok) throw new Error(res.reason);
    rows = res.rows;
    reason = res.reason;
    writeEligibilityCache(opts.season, rows);
  }
  const n = storeRawEligibility(opts.db, rows);
  const staged = stageEligibility(opts.db, opts.season, rows);
  return { rows: n, staged, reason };
}
