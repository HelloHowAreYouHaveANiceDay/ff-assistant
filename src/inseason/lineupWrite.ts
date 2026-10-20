// SET THE STARTING LINEUP ON ESPN (D54) -- the copilot's own lineup recommendation, written to the
// league as one ROSTER/EXECUTE transaction of LINEUP items, under the same discipline as `ff claim`:
// resolve + validate + SHOW by default, send only behind `--send`, and judge success on a RE-READ of
// the live roster (every man in the slot we asked for), never on a 200 alone.
//
// WHY THIS IS THE SAFEST WRITE THE TOOL MAKES. A lineup move changes no roster: nobody is added,
// dropped or traded, and it can be reversed by another move until the player's game kicks off. The
// guard (src/league/writeIO.ts) admits a ROSTER body ONLY when every item is a LINEUP move inside our
// own team (fromTeamId/toTeamId 0), so this builder cannot be bent into an add or a drop.
//
// WHAT IS NOT DECIDED HERE. Which eight men start is `lineup_recommend`'s answer (the same function
// `ff lineup` prints). This module only maps that answer onto ESPN's slots with the FEWEST moves --
// a WR in FLEX and a WR in WR are the same lineup, so it never shuffles men between equivalent slots
// -- and refuses to touch a man whose game has locked.
import { ESPN_READS_BASE } from "../data/espnApi.js";
import { nameKey, dstAliasKey } from "../draft/values.js";
import { ESPN_SLOT_NAME } from "../league/espnSlots.js";
import type { PlatformWriteIO, WriteRequest } from "../league/writeIO.js";

export const BENCH_SLOT = 20;
export const IR_SLOT = 21;

type Get = (url: string, headers?: Record<string, string>) => Promise<unknown>;

export interface LiveEntry {
  playerId: string;
  name: string;
  slot: number;
  eligible: number[];
  locked: boolean;
  defaultPositionId: number | null;
}

export interface LiveLineup {
  season: number; leagueId: string; myTeamId: string; memberId: string | null;
  scoringPeriodId: number;
  /** lineupSlotId -> how many the league starts there (bench and IR included, as ESPN publishes them). */
  slotCounts: Record<number, number>;
  entries: LiveEntry[];
}

export interface LineupMove { playerId: string; name: string; from: number; to: number }

/** The starting slots: every slot the league fills with a count, except bench and IR. */
export function startingSlots(slotCounts: Record<number, number>): number[] {
  const out: number[] = [];
  for (const [k, n] of Object.entries(slotCounts)) {
    const id = Number(k);
    if (id === BENCH_SLOT || id === IR_SLOT || !(n > 0)) continue;
    for (let i = 0; i < n; i++) out.push(id);
  }
  return out.sort((a, b) => a - b);
}

/**
 * MAP A SET OF STARTERS ONTO SLOTS WITH THE FEWEST MOVES. Pure, so it is tested directly.
 *
 * 1. A wanted starter already in a starting slot he is eligible for STAYS (capacity permitting).
 * 2. The rest are placed by bipartite matching over the open slot instances; an augmenting path may
 *    move a kept man to another eligible slot when that is the only way to seat everyone.
 * 3. Anyone in a starting slot who is not wanted goes to the bench. Bench and IR men who are not
 *    wanted stay where they are.
 * Throws when the wanted set cannot be seated (more starters than slots, or an ineligible mix).
 */
export function assignSlots(entries: LiveEntry[], wanted: Set<string>, slotCounts: Record<number, number>): Map<string, number> {
  const slots = startingSlots(slotCounts);
  const holder: (string | null)[] = slots.map(() => null);
  const byId = new Map(entries.map((e) => [e.playerId, e]));
  const placed = new Map<string, number>();       // playerId -> slot instance index
  for (const id of wanted) if (!byId.has(id)) throw new Error(`starter ${id} is not on the roster`);
  if (wanted.size > slots.length) throw new Error(`${wanted.size} starters for ${slots.length} starting slots`);
  // 1. keep
  for (const e of entries) {
    if (!wanted.has(e.playerId)) continue;
    const i = slots.findIndex((s, k) => s === e.slot && holder[k] == null);
    if (i >= 0 && e.eligible.includes(e.slot)) { holder[i] = e.playerId; placed.set(e.playerId, i); }
  }
  // 2. match the rest by SHORTEST augmenting path (BFS), so an open eligible slot is always taken
  //    before anyone already seated is shifted -- a depth-first search found a 4-move chain where one
  //    move into the empty FLEX did (first live dry run, 2026-10-14).
  const tryPlace = (pid: string): boolean => {
    const prev = new Map<number, number | null>();      // slot k -> the slot whose holder moves into k (null = pid)
    const queue: number[] = [];
    const visit = (who: string, from: number | null) => {
      const e = byId.get(who)!;
      for (let k = 0; k < slots.length; k++) {
        if (prev.has(k) || !e.eligible.includes(slots[k])) continue;
        prev.set(k, from); queue.push(k);
      }
    };
    visit(pid, null);
    while (queue.length) {
      const k = queue.shift()!;
      if (holder[k] == null) {
        // shift along the path back to pid
        let cur: number | null = k;
        while (cur != null) {
          const from: number | null = prev.get(cur)!;
          const mover = from == null ? pid : holder[from]!;
          holder[cur] = mover; placed.set(mover, cur);
          cur = from;
        }
        return true;
      }
      visit(holder[k]!, k);
    }
    return false;
  };
  for (const id of wanted) {
    if (placed.has(id)) continue;
    if (!tryPlace(id)) throw new Error(`cannot seat ${byId.get(id)!.name}: no eligible open starting slot for this set of starters`);
  }
  const out = new Map<string, number>();
  for (const e of entries) {
    if (wanted.has(e.playerId)) out.set(e.playerId, slots[placed.get(e.playerId)!]);
    else out.set(e.playerId, slots.includes(e.slot) ? BENCH_SLOT : e.slot);
  }
  return out;
}

/** The moves between the live lineup and a target. */
export function diffMoves(entries: LiveEntry[], target: Map<string, number>): LineupMove[] {
  return entries.filter((e) => target.get(e.playerId) !== e.slot)
    .map((e) => ({ playerId: e.playerId, name: e.name, from: e.slot, to: target.get(e.playerId)! }));
}

const slotName = (s: number) => ESPN_SLOT_NAME[s] ?? `slot ${s}`;

/**
 * WHICH ESPN ROSTER ENTRY IS THIS RECOMMENDED STARTER. By name key; a defence by its team alias
 * ("BUF D/ST" vs ESPN's "Bills D/ST"). Ambiguity is an error, not a pick.
 */
export function matchStarter(entries: LiveEntry[], s: { name: string; pos: string }): LiveEntry {
  let hits = entries.filter((e) => nameKey(e.name) === nameKey(s.name));
  if (!hits.length && s.pos === "DST") {
    const want = dstAliasKey(s.name);
    hits = want == null ? [] : entries.filter((e) => e.defaultPositionId === 16 && dstAliasKey(e.name) === want);
  }
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`recommended starter "${s.name}" is not on our live ESPN roster -- refresh (sync-league) and re-run`);
  throw new Error(`recommended starter "${s.name}" matches ${hits.length} roster entries`);
}

async function bridgeGet(): Promise<Get> {
  const { bridgeAvailable, bridgeFetch } = await import("../browser/appBridge.js");
  if (!bridgeAvailable()) throw new Error("the desktop app is not running -- lineups are read and written through its ESPN session");
  return async (url, headers) => JSON.parse(await bridgeFetch(url, headers));
}

/** League/team/season given directly (tests); otherwise resolved from the store. */
export interface LeagueCtxOverride { season: number; leagueId: string; myTeamId: string }

export async function readLiveLineup(o: { dbPath?: string; leagueId?: string | null; scoringPeriodId?: number; get?: Get; leagueCtx?: LeagueCtxOverride } = {}): Promise<LiveLineup> {
  let season: number, leagueId: string | null, myTeamId: string | null, platform: string | null = null;
  if (o.leagueCtx) ({ season, leagueId, myTeamId } = o.leagueCtx);
  else {
    const { openDb } = await import("../db/db.js");
    const { resolveLeagueContext } = await import("../data/leagueContext.js");
    const db = openDb(o.dbPath);
    try {
      const ctx = resolveLeagueContext(db, o.leagueId);
      season = ctx.config.season; leagueId = ctx.leagueId; myTeamId = ctx.teamId; platform = ctx.platformRaw ?? ctx.platform ?? null;
    } finally { db.close(); }
  }
  if (!leagueId || !myTeamId) throw new Error("no league/team in the store (sync the league first)");
  if (platform && platform !== "espn") throw new Error(`league ${leagueId} is on ${platform}; lineup writes are ESPN-only`);
  const g = o.get ?? await bridgeGet();
  const base = `${ESPN_READS_BASE}/seasons/${season}/segments/0/leagues/${leagueId}`;
  const sp = o.scoringPeriodId != null ? `&scoringPeriodId=${o.scoringPeriodId}` : "";
  const j = await g(`${base}?forTeamId=${myTeamId}&view=mRoster&view=mSettings&view=mStatus&view=mTeam${sp}`) as {
    scoringPeriodId?: number;
    settings?: { rosterSettings?: { lineupSlotCounts?: Record<string, number> } };
    teams?: { id: number; primaryOwner?: string; owners?: string[]; roster?: { entries?: {
      playerId: number; lineupSlotId: number;
      playerPoolEntry?: { lineupLocked?: boolean; player?: { fullName?: string; eligibleSlots?: number[]; defaultPositionId?: number } };
    }[] } }[];
  };
  const me = (j.teams ?? []).find((t) => String(t.id) === String(myTeamId));
  if (!me?.roster?.entries?.length) throw new Error(`ESPN returned no roster for team ${myTeamId} -- refusing to plan a lineup against nothing`);
  const counts = j.settings?.rosterSettings?.lineupSlotCounts;
  if (!counts) throw new Error("ESPN returned no lineupSlotCounts -- cannot tell which slots exist");
  const spid = Number(o.scoringPeriodId ?? j.scoringPeriodId);
  if (!Number.isFinite(spid) || spid < 1) throw new Error("ESPN returned no current scoringPeriodId");
  const entries: LiveEntry[] = me.roster.entries.map((e) => {
    const p = e.playerPoolEntry?.player;
    if (!Array.isArray(p?.eligibleSlots)) throw new Error(`roster entry ${e.playerId} carries no eligibleSlots -- ESPN payload changed; refusing`);
    return {
      playerId: String(e.playerId), name: p?.fullName ?? String(e.playerId), slot: Number(e.lineupSlotId),
      eligible: p!.eligibleSlots!.map(Number), locked: e.playerPoolEntry?.lineupLocked === true,
      defaultPositionId: p?.defaultPositionId ?? null,
    };
  });
  return {
    season, leagueId, myTeamId: String(myTeamId), memberId: me.primaryOwner ?? me.owners?.[0] ?? null,
    scoringPeriodId: spid, slotCounts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [Number(k), Number(v)])), entries,
  };
}

export interface LineupRun {
  live: LiveLineup;
  week: number;
  starters: { slot: string; name: string; pos: string; proj: number }[];
  totalProj: number | null;
  moves: LineupMove[];
  problems: string[];
  request: WriteRequest | null;
  sent: boolean;
  response: { status: number; body: string } | null;
  verified: string | null;
  error?: string;
}

/**
 * Plan (and with `send`, make) the moves that put the copilot's recommended lineup on ESPN.
 * `starters` may be passed in (tests, or an explicit override); otherwise `lineup_recommend` runs for
 * `week` (default: ESPN's current scoring period) and is logged in action_log like any copilot call.
 */
export async function setLineup(o: {
  week?: number; send?: boolean; dbPath?: string; leagueId?: string | null;
  objective?: "expected" | "winprob"; status?: Record<string, string>;
  starters?: { slot: string; name: string; pos: string; proj: number }[];
  writer?: PlatformWriteIO; get?: Get;
  leagueCtx?: LeagueCtxOverride;
  /** Re-reads while verifying (2s apart). Default 8. */
  verifyPolls?: number;
}): Promise<LineupRun> {
  const g = o.get ?? await bridgeGet();
  const live = await readLiveLineup({ dbPath: o.dbPath, leagueId: o.leagueId, scoringPeriodId: o.week, get: g, leagueCtx: o.leagueCtx });
  const week = live.scoringPeriodId;
  const run: LineupRun = { live, week, starters: [], totalProj: null, moves: [], problems: [], request: null, sent: false, response: null, verified: null };
  try {
    if (o.starters) run.starters = o.starters;
    else {
      const { runCopilot } = await import("./copilotActions.js");
      const r = await runCopilot("lineup_recommend", { week, ...(o.leagueId ? { league: o.leagueId } : {}), ...(o.objective ? { objective: o.objective } : {}), ...(o.status ? { status: o.status } : {}) } as never, { dbPath: o.dbPath });
      const res = r.result as { starters: LineupRun["starters"]; totalProj?: number; flags?: string[] };
      run.starters = res.starters; run.totalProj = res.totalProj ?? null;
      for (const f of res.flags ?? []) run.problems.push(`note: lineup flag: ${f}`);
    }
    // "(empty)" is lineup.ts's placeholder for a slot nobody can fill (e.g. our only D/ST on bye); it
    // is no roster man, so it must not be matched -- the slot-count note below reports the gap.
    const wanted = new Set(run.starters.filter((s) => s.name !== "(empty)").map((s) => matchStarter(live.entries, s).playerId));
    const nSlots = startingSlots(live.slotCounts).length;
    if (wanted.size < nSlots) run.problems.push(`note: only ${wanted.size} starters for ${nSlots} starting slots -- ${nSlots - wanted.size} slot(s) stay EMPTY`);
    const target = assignSlots(live.entries, wanted, live.slotCounts);
    run.moves = diffMoves(live.entries, target);
    for (const m of run.moves) {
      const e = live.entries.find((x) => x.playerId === m.playerId)!;
      if (e.locked) run.problems.push(`${m.name} is LOCKED (his game has started) -- ESPN will not move him ${slotName(m.from)} -> ${slotName(m.to)}`);
    }
    if (run.moves.length) {
      const { platformFor } = await import("../league/platform.js");
      const plat = await platformFor("espn");
      if (!plat.writes?.setLineup) throw new Error("ESPN declares no lineup write capability");
      run.request = plat.writes.setLineup({ season: live.season, leagueId: live.leagueId, myTeamId: live.myTeamId, memberId: live.memberId,
        scoringPeriodId: live.scoringPeriodId, moves: run.moves.map((m) => ({ playerId: m.playerId, fromSlotId: m.from, toSlotId: m.to })) });
    }
  } catch (e) { run.problems.push(String(e instanceof Error ? e.message : e)); }
  const blocking = run.problems.filter((p) => !p.startsWith("note:"));
  if (!o.send || blocking.length || !run.request) return run;

  const { assertWritable } = await import("../league/writeIO.js");
  const { platformFor } = await import("../league/platform.js");
  const plat = await platformFor("espn");
  const w = o.writer ?? (await import("../league/session.js")).resolveWriteIO();
  assertWritable(plat.writes, run.request);
  const r = await w.post(run.request.url, run.request.body);
  run.response = r;
  if (r.status >= 400) { run.error = `ESPN refused with HTTP ${r.status} via ${w.via}: ${r.body.slice(0, 400)}`; return run; }
  run.sent = true;
  // VERIFY ON THE ROSTER, through the read replica's lag (1-2s, measured for claims).
  let bad: string[] = [];
  for (let i = 0; i < (o.verifyPolls ?? 8); i++) {
    if (i) await new Promise((res) => setTimeout(res, 2000));
    const now = await readLiveLineup({ dbPath: o.dbPath, leagueId: o.leagueId, scoringPeriodId: week, get: g, leagueCtx: o.leagueCtx });
    bad = run.moves.filter((m) => now.entries.find((e) => e.playerId === m.playerId)?.slot !== m.to).map((m) => `${m.name} not in ${slotName(m.to)}`);
    if (!bad.length) break;
  }
  run.verified = bad.length ? `CHECK ESPN: ${bad.join("; ")}` : `roster confirmed: ${run.moves.map((m) => `${m.name} ${slotName(m.from)}->${slotName(m.to)}`).join(", ")}`;
  return run;
}

export { slotName };
