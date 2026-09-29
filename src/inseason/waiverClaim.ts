// Place, list, edit and cancel FAAB waiver claims -- the second thing in the system that can write to
// the league (after propose-trade), under the same discipline: resolve + validate + SHOW by default,
// and send only behind an explicit gate. Nothing here runs on the automation loop.
//
// WHY A CLAIM, AND NOT A FREE-AGENT ADD. A claim sits PENDING until ESPN's nightly process and can be
// withdrawn until then, so a mistake is recoverable. An instant add is not. See ESPN_WRITE_TYPES.
//
// EVERYTHING IS READ LIVE through the app session -- who is on waivers, our roster, our FAAB left, the
// scoring period and our pending claims -- because each of those changes hour to hour and a claim
// built from a stale store names a player who has already moved.
//
// AND EVERY SEND IS VERIFIED BY A RE-READ. ESPN answering 200 is not the claim existing; the pending
// transactions feed listing it is. `verified` says which was observed.
import { openDb } from "../db/db.js";
import { resolveLeagueContext } from "../data/leagueContext.js";
import { ESPN_READS_BASE } from "../data/espnApi.js";
import { nameKey } from "../draft/values.js";
import type { PlatformWriteIO, WriteRequest } from "../league/writeIO.js";

export interface PendingClaim {
  id: string; bid: number; addId: string; addName: string; dropId: string | null; dropName: string | null;
  scoringPeriodId: number; proposedAt: string | null;
}

export interface ClaimState {
  season: number; leagueId: string; myTeamId: string; memberId: string | null;
  scoringPeriodId: number; budget: number; spent: number; remaining: number; minimumBid: number;
  pending: PendingClaim[];
  /** Pending bids are NOT deducted by ESPN until processed; this is their sum, for the budget check. */
  pendingTotal: number;
  /** playerId -> name for everyone this state saw (our roster + the pool), for readable output. */
  names: Map<string, string>;
}

type Get = (url: string, headers?: Record<string, string>) => Promise<unknown>;

async function bridgeGet(): Promise<Get> {
  const { bridgeAvailable, bridgeFetch } = await import("../browser/appBridge.js");
  if (!bridgeAvailable()) throw new Error("the desktop app is not running -- claims are read and written through its ESPN session");
  return async (url, headers) => JSON.parse(await bridgeFetch(url, headers));
}

interface EspnTeam {
  id: number; owners?: string[]; primaryOwner?: string;
  transactionCounter?: { acquisitionBudgetSpent?: number };
  roster?: { entries?: { playerId: number; playerPoolEntry?: { player?: { fullName?: string } } }[] };
}
interface EspnTxn {
  id: string; type: string; executionType: string; status: string; teamId: number; bidAmount?: number;
  scoringPeriodId: number; proposedDate?: number;
  items?: { playerId: number; type: string }[];
}

export async function readClaimState(dbPath?: string, leagueIdArg?: string | null, get?: Get): Promise<ClaimState> {
  const db = openDb(dbPath);
  let season: number, leagueId: string | null, myTeamId: string | null, platform: string | null;
  try {
    const ctx = resolveLeagueContext(db, leagueIdArg);
    season = ctx.config.season; leagueId = ctx.leagueId; myTeamId = ctx.teamId; platform = ctx.platformRaw ?? ctx.platform ?? null;
  } finally { db.close(); }
  if (!leagueId || !myTeamId) throw new Error("no league/team in the store (sync the league first)");
  if (platform && platform !== "espn") throw new Error(`league ${leagueId} is on ${platform}; waiver claims are ESPN-only`);
  const g = get ?? await bridgeGet();
  const base = `${ESPN_READS_BASE}/seasons/${season}/segments/0/leagues/${leagueId}`;
  const j = await g(`${base}?view=mSettings&view=mTeam&view=mRoster&view=mStatus&view=mPendingTransactions`) as {
    scoringPeriodId?: number;
    settings?: { acquisitionSettings?: { acquisitionBudget?: number; minimumBid?: number; isUsingAcquisitionBudget?: boolean } };
    teams?: EspnTeam[]; pendingTransactions?: EspnTxn[];
  };
  // mPendingTransactions puts its list under `pendingTransactions`, NOT `transactions` (mTransactions2's
  // key). Reading the wrong key reported "0 pending" with a real claim live on ESPN (2026-09-29), so a
  // payload with no such array FAILS CLOSED rather than reading as "no claims".
  if (!Array.isArray(j.pendingTransactions)) throw new Error("ESPN's mPendingTransactions payload carried no pendingTransactions array -- cannot tell which claims are pending");
  const acq = j.settings?.acquisitionSettings ?? {};
  if (!acq.isUsingAcquisitionBudget) throw new Error("this league does not use a FAAB budget -- nothing here knows how to claim without one");
  const me = (j.teams ?? []).find((t) => String(t.id) === String(myTeamId));
  if (!me) throw new Error(`team ${myTeamId} is not in ESPN's team list for league ${leagueId}`);
  const spid = Number(j.scoringPeriodId);
  if (!Number.isFinite(spid) || spid < 1) throw new Error("ESPN returned no current scoringPeriodId -- refusing to build a claim without it");
  const names = new Map<string, string>();
  for (const t of j.teams ?? []) for (const e of t.roster?.entries ?? []) {
    const n = e.playerPoolEntry?.player?.fullName; if (n) names.set(String(e.playerId), n);
  }
  const budget = Number(acq.acquisitionBudget ?? 0);
  const spent = Number(me.transactionCounter?.acquisitionBudgetSpent ?? 0);
  // A claimed man is a FREE AGENT, so he is on no roster above; name him from the pool by id.
  const unknown = [...new Set(j.pendingTransactions.flatMap((t) => (t.items ?? []).map((i) => String(i.playerId))))].filter((id) => !names.has(id));
  if (unknown.length) {
    try {
      const pj = await g(`${base}?scoringPeriodId=${spid}&view=kona_player_info`,
        { "x-fantasy-filter": JSON.stringify({ players: { filterIds: { value: unknown.map(Number) } } }) }) as { players?: { id: number; player?: { fullName?: string } }[] };
      for (const p of pj.players ?? []) if (p.player?.fullName) names.set(String(p.id), p.player.fullName);
    } catch { /* ids stay as ids -- a label, not a decision */ }
  }
  const pending: PendingClaim[] = j.pendingTransactions
    .filter((t) => t.type === "WAIVER" && t.executionType === "EXECUTE" && t.status === "PENDING" && String(t.teamId) === String(myTeamId))
    .map((t) => {
      const add = t.items?.find((i) => i.type === "ADD"); const drop = t.items?.find((i) => i.type === "DROP");
      return {
        id: t.id, bid: Number(t.bidAmount ?? 0),
        addId: String(add?.playerId ?? ""), addName: names.get(String(add?.playerId)) ?? String(add?.playerId ?? "?"),
        dropId: drop ? String(drop.playerId) : null, dropName: drop ? names.get(String(drop.playerId)) ?? String(drop.playerId) : null,
        scoringPeriodId: t.scoringPeriodId, proposedAt: t.proposedDate ? new Date(t.proposedDate).toISOString() : null,
      };
    });
  return {
    season, leagueId, myTeamId: String(myTeamId),
    memberId: me.primaryOwner ?? me.owners?.[0] ?? null,
    scoringPeriodId: spid, budget, spent, remaining: budget - spent, minimumBid: Number(acq.minimumBid ?? 0),
    pending, pendingTotal: pending.reduce((a, c) => a + c.bid, 0), names,
  };
}

/** A free agent or waiver-wire player by name, from ESPN's live pool. Ambiguity is an error, not a pick. */
async function findPoolPlayer(st: ClaimState, name: string, g: Get): Promise<{ id: string; name: string; status: string; waiverProcessDate: string | null }> {
  const url = `${ESPN_READS_BASE}/seasons/${st.season}/segments/0/leagues/${st.leagueId}?scoringPeriodId=${st.scoringPeriodId}&view=kona_player_info`;
  const filter = { players: { filterStatus: { value: ["FREEAGENT", "WAIVERS"] }, sortPercOwned: { sortPriority: 1, sortAsc: false }, limit: 2000 } };
  const j = await g(url, { "x-fantasy-filter": JSON.stringify(filter) }) as { players?: { id: number; status: string; waiverProcessDate?: number; player?: { fullName?: string } }[] };
  const want = nameKey(name);
  const hits = (j.players ?? []).filter((p) => nameKey(p.player?.fullName ?? "") === want);
  if (!hits.length) throw new Error(`"${name}" is not a free agent or on waivers in league ${st.leagueId} (rostered, or misspelled)`);
  if (hits.length > 1) throw new Error(`"${name}" is ambiguous in the pool: ${hits.map((h) => `${h.player?.fullName} [${h.id}]`).join(", ")}`);
  const h = hits[0];
  st.names.set(String(h.id), h.player?.fullName ?? name);
  return { id: String(h.id), name: h.player?.fullName ?? name, status: h.status, waiverProcessDate: h.waiverProcessDate ? new Date(h.waiverProcessDate).toISOString() : null };
}

function findOurPlayer(st: ClaimState, rosterIds: Set<string>, name: string): { id: string; name: string } {
  const want = nameKey(name);
  const hits = [...rosterIds].filter((id) => nameKey(st.names.get(id) ?? "") === want);
  if (!hits.length) throw new Error(`"${name}" is not on our roster`);
  return { id: hits[0], name: st.names.get(hits[0])! };
}

async function ourRosterIds(st: ClaimState, g: Get): Promise<Set<string>> {
  const j = await g(`${ESPN_READS_BASE}/seasons/${st.season}/segments/0/leagues/${st.leagueId}?view=mRoster`) as { teams?: EspnTeam[] };
  const me = (j.teams ?? []).find((t) => String(t.id) === st.myTeamId);
  return new Set((me?.roster?.entries ?? []).map((e) => String(e.playerId)));
}

export interface ClaimRun {
  action: "place" | "cancel" | "edit";
  state: ClaimState;
  problems: string[];
  requests: WriteRequest[];
  /** What each request is, in words, index-aligned with `requests`. */
  describe: string[];
  sent: boolean;
  responses: { status: number; body: string }[];
  /** Observed on a re-read of ESPN's pending transactions after sending. */
  verified: string | null;
  after?: PendingClaim[];
  error?: string;
}

async function espnWrites() {
  const { platformFor } = await import("../league/platform.js");
  const plat = await platformFor("espn");
  if (!plat.writes?.waiverClaim || !plat.writes.cancelWaiverClaim) throw new Error("ESPN declares no waiver-claim write capability");
  return plat.writes;
}

/**
 * RE-READ UNTIL THE EXPECTED STATE APPEARS, or give up and return what is there. ESPN's read replica
 * lags its write side by a second or two: an edit whose two writes both returned 200 re-read as "no
 * claim pending" immediately and as the new claim five seconds later (measured 2026-09-29). A single
 * re-read therefore reports a false failure; polling reports the truth, and a real failure still
 * surfaces -- just ~15s later.
 */
async function rereadUntil(settled: ((p: PendingClaim[]) => boolean) | null, dbPath?: string, leagueId?: string | null, get?: Get): Promise<PendingClaim[]> {
  let last: PendingClaim[] = [];
  for (let i = 0; i < (settled ? 8 : 1); i++) {
    if (i) await new Promise((r) => setTimeout(r, 2000));
    last = (await readClaimState(dbPath, leagueId, get)).pending;
    if (!settled || settled(last)) return last;
  }
  return last;
}

async function send(run: ClaimRun, settled: (p: PendingClaim[]) => boolean, writer: PlatformWriteIO | undefined, dbPath?: string, leagueId?: string | null, get?: Get): Promise<ClaimRun> {
  const { assertWritable } = await import("../league/writeIO.js");
  const writes = await espnWrites();
  const w = writer ?? (await import("../league/session.js")).resolveWriteIO();
  for (const req of run.requests) {
    assertWritable(writes, req);
    const r = await w.post(req.url, req.body);
    run.responses.push(r);
    // Stop at the first refusal: an edit whose NEW claim was refused must not go on to cancel the old one.
    if (r.status >= 400) { run.error = `ESPN refused with HTTP ${r.status} via ${w.via}: ${r.body.slice(0, 400)}`; break; }
  }
  run.sent = run.responses.length > 0 && !run.error;
  try { run.after = await rereadUntil(run.error ? null : settled, dbPath, leagueId, get); } catch (e) { run.error = (run.error ? run.error + "; " : "") + `re-read failed: ${String(e)}`; }
  return run;
}

function budgetProblems(st: ClaimState, bid: number, excludeClaimId?: string): string[] {
  const out: string[] = [];
  if (!Number.isInteger(bid)) out.push(`bid must be a whole number of dollars (got ${bid})`);
  if (bid < st.minimumBid) out.push(`bid $${bid} is below the league minimum $${st.minimumBid}`);
  if (bid > st.remaining) out.push(`bid $${bid} is more than our remaining FAAB $${st.remaining}`);
  const others = st.pending.filter((c) => c.id !== excludeClaimId).reduce((a, c) => a + c.bid, 0);
  // ESPN does not reserve pending bids, so this is a WARNING-level fact, reported but not blocking:
  // claims process in priority order and a later one fails FAILED_AUCTIONBUDGETEXCEEDED if money ran out.
  if (bid + others > st.remaining) out.push(`note: with our other pending bids ($${others}) this totals $${bid + others} against $${st.remaining} left -- a later claim would fail on budget if all win`);
  return out;
}
const blocking = (p: string[]) => p.filter((x) => !x.startsWith("note:"));

export async function placeClaim(o: { add: string; drop?: string | null; bid: number; send?: boolean; dbPath?: string; leagueId?: string | null; writer?: PlatformWriteIO; get?: Get }): Promise<ClaimRun> {
  const g = o.get ?? await bridgeGet();
  const st = await readClaimState(o.dbPath, o.leagueId, g);
  const run: ClaimRun = { action: "place", state: st, problems: [], requests: [], describe: [], sent: false, responses: [], verified: null };
  try {
    const add = await findPoolPlayer(st, o.add, g);
    const roster = await ourRosterIds(st, g);
    const drop = o.drop ? findOurPlayer(st, roster, o.drop) : null;
    run.problems.push(...budgetProblems(st, o.bid));
    const dup = st.pending.find((c) => c.addId === add.id && c.dropId === (drop?.id ?? null));
    if (dup) run.problems.push(`we already have a pending claim for ${add.name}${drop ? ` dropping ${drop.name}` : ""} at $${dup.bid} (id ${dup.id}) -- use --edit to change its bid`);
    if (add.status !== "WAIVERS") run.problems.push(`note: ${add.name} is ${add.status}, not on waivers -- ESPN may reject a claim on him`);
    const writes = await espnWrites();
    run.requests.push(writes.waiverClaim!({ season: st.season, leagueId: st.leagueId, myTeamId: st.myTeamId, memberId: st.memberId,
      addPlayerId: add.id, dropPlayerId: drop?.id ?? null, bid: o.bid, scoringPeriodId: st.scoringPeriodId }));
    run.describe.push(`CLAIM ${add.name} [${add.id}]${drop ? ` / DROP ${drop.name} [${drop.id}]` : ""} for $${o.bid}` +
      (add.waiverProcessDate ? ` (processes ${add.waiverProcessDate})` : ""));
  } catch (e) { run.problems.push(String(e instanceof Error ? e.message : e)); }
  if (!o.send || blocking(run.problems).length || !run.requests.length) return run;
  const addIdOf = (req: WriteRequest) => String((JSON.parse(req.body) as { items: { playerId: number; type: string }[] }).items.find((i) => i.type === "ADD")?.playerId ?? "");
  await send(run, (p) => p.some((c) => c.addId === addIdOf(run.requests[0]) && c.bid === o.bid), o.writer, o.dbPath, o.leagueId, g);
  const a = run.requests.length ? JSON.parse(run.requests[0].body) as { items: { playerId: number; type: string }[] } : null;
  const addId = String(a?.items.find((i) => i.type === "ADD")?.playerId ?? "");
  const got = run.after?.find((c) => c.addId === addId && c.bid === o.bid);
  run.verified = got ? `ESPN lists the claim as PENDING (id ${got.id}, $${got.bid})` : "NOT FOUND in ESPN's pending claims after sending";
  return run;
}

function pickClaim(st: ClaimState, which: string): PendingClaim {
  const byId = st.pending.find((c) => c.id === which);
  if (byId) return byId;
  const byName = st.pending.filter((c) => nameKey(c.addName) === nameKey(which));
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`${byName.length} pending claims add "${which}" -- name one by id: ${byName.map((c) => c.id).join(", ")}`);
  throw new Error(`no pending claim matches "${which}" (pending: ${st.pending.map((c) => `${c.addName} $${c.bid} [${c.id}]`).join("; ") || "none"})`);
}

export async function cancelClaim(o: { which: string; send?: boolean; dbPath?: string; leagueId?: string | null; writer?: PlatformWriteIO; get?: Get }): Promise<ClaimRun> {
  const g = o.get ?? await bridgeGet();
  const st = await readClaimState(o.dbPath, o.leagueId, g);
  const run: ClaimRun = { action: "cancel", state: st, problems: [], requests: [], describe: [], sent: false, responses: [], verified: null };
  let c: PendingClaim | null = null;
  try {
    c = pickClaim(st, o.which);
    const writes = await espnWrites();
    run.requests.push(writes.cancelWaiverClaim!({ season: st.season, leagueId: st.leagueId, myTeamId: st.myTeamId, memberId: st.memberId,
      addPlayerId: c.addId, dropPlayerId: c.dropId, scoringPeriodId: c.scoringPeriodId, claimId: c.id }));
    run.describe.push(`CANCEL claim ${c.id}: ${c.addName}${c.dropName ? ` / drop ${c.dropName}` : ""} at $${c.bid}`);
  } catch (e) { run.problems.push(String(e instanceof Error ? e.message : e)); }
  if (!o.send || blocking(run.problems).length || !c) return run;
  await send(run, (p) => !p.some((x) => x.id === c!.id), o.writer, o.dbPath, o.leagueId, g);
  run.verified = run.after && !run.after.some((x) => x.id === c!.id) ? `claim ${c.id} is no longer pending` : `claim ${c.id} is STILL PENDING after sending`;
  return run;
}

/**
 * CHANGE A PENDING CLAIM'S BID. ESPN has no edit operation -- only place and cancel -- and it REFUSES a
 * second pending claim for the same add/drop (HTTP 409 "A pending transaction of this type already
 * exists", measured 2026-09-29). So the order is forced: CANCEL the old claim, then PLACE the new bid.
 * The window between them is the risk -- if ESPN refuses the new bid, the old claim is gone -- so a
 * refused new bid RE-PLACES THE OLD ONE, and the result says which of the three states it ended in.
 */
export async function editClaim(o: { which: string; bid: number; send?: boolean; dbPath?: string; leagueId?: string | null; writer?: PlatformWriteIO; get?: Get }): Promise<ClaimRun> {
  const g = o.get ?? await bridgeGet();
  const st = await readClaimState(o.dbPath, o.leagueId, g);
  const run: ClaimRun = { action: "edit", state: st, problems: [], requests: [], describe: [], sent: false, responses: [], verified: null };
  let c: PendingClaim | null = null;
  let restore: WriteRequest | null = null;
  try {
    c = pickClaim(st, o.which);
    if (c.bid === o.bid) run.problems.push(`the claim is already $${o.bid}`);
    run.problems.push(...budgetProblems(st, o.bid, c.id));
    const writes = await espnWrites();
    const base = { season: st.season, leagueId: st.leagueId, myTeamId: st.myTeamId, memberId: st.memberId, addPlayerId: c.addId, dropPlayerId: c.dropId };
    run.requests.push(writes.cancelWaiverClaim!({ ...base, scoringPeriodId: c.scoringPeriodId, claimId: c.id }));
    run.describe.push(`CANCEL claim ${c.id} (the old $${c.bid} bid)`);
    run.requests.push(writes.waiverClaim!({ ...base, bid: o.bid, scoringPeriodId: st.scoringPeriodId }));
    run.describe.push(`CLAIM ${c.addName}${c.dropName ? ` / DROP ${c.dropName}` : ""} for $${o.bid} (the new bid) -- if ESPN refuses it, the old $${c.bid} claim is RE-PLACED`);
    restore = writes.waiverClaim!({ ...base, bid: c.bid, scoringPeriodId: st.scoringPeriodId });
  } catch (e) { run.problems.push(String(e instanceof Error ? e.message : e)); }
  if (!o.send || blocking(run.problems).length || !c || !restore) return run;
  await send(run, (p) => p.some((x) => x.addId === c!.addId && x.bid === o.bid) && !p.some((x) => x.id === c!.id), o.writer, o.dbPath, o.leagueId, g);
  // The cancel went through but the new bid did not: put the old claim back, then re-read.
  if (run.error && run.responses.length === 2 && run.responses[0].status < 400) {
    const w = o.writer ?? (await import("../league/session.js")).resolveWriteIO();
    const { assertWritable } = await import("../league/writeIO.js");
    assertWritable(await espnWrites(), restore);
    const r = await w.post(restore.url, restore.body);
    run.responses.push(r);
    run.error += r.status < 400 ? `; the old $${c.bid} claim was RE-PLACED` : `; RE-PLACING the old $${c.bid} claim ALSO FAILED (HTTP ${r.status}) -- NO CLAIM IS PENDING`;
    try { run.after = await rereadUntil((p) => p.some((x) => x.addId === c!.addId && x.bid === c!.bid), o.dbPath, o.leagueId, g); } catch { /* reported below as a missing re-read */ }
  }
  const now = run.after ?? [];
  const fresh = now.find((x) => x.addId === c!.addId && x.bid === o.bid);
  const same = now.find((x) => x.addId === c!.addId && x.bid === c!.bid);
  const oldGone = !now.some((x) => x.id === c!.id);
  run.verified = fresh && oldGone ? `new claim PENDING at $${o.bid} (id ${fresh.id}); old claim ${c.id} cancelled`
    : same ? `CHECK ESPN: the bid was NOT changed -- a $${c.bid} claim is pending (id ${same.id})`
    : `CHECK ESPN: NO claim for ${c.addName} is pending`;
  return run;
}
