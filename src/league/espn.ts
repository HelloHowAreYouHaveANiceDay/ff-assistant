/**
 * ESPN adaptor -- the ONLY file in the tree that knows ESPN's vocabulary.
 *
 * Everything ESPN-specific is contained here: the lm-api-reads host, the `view=` query parameters,
 * the `x-fantasy-filter` header, and `defaultPositionId` (ESPN numbers positions; 4 is a tight end).
 * Consumers see nothing but the types in ./types.
 *
 * Transport is the app's embedded webview via WebviewPage.fetchText, so requests carry the user's
 * real session. We never hold ESPN credentials, and the same path serves any authenticated site --
 * a Sleeper or Yahoo adaptor reuses it unchanged.
 */
import type { Database as DB } from "better-sqlite3";
import { attachWebview } from "../browser/webviewPage.js";
import type { WebviewPage } from "../browser/webviewPage.js";
import type { Browser } from "playwright-core";
import type { AcquisitionRules, DraftPick, FreeAgent, LeagueFormat, LeagueProvider, LeagueSchedule, LeagueShape, LeagueTeam, SeasonSnapshot } from "./types.js";
// The calendar is a fact with a source; these two functions are where it is read and validated.
// (index.ts imports this adaptor DYNAMICALLY, so this static edge does not close a cycle.)
import { effectiveFormat, formatFromEspnSettings } from "./index.js";
// The ESPN id maps live in ONE place now (src/league/espnSlots.ts). They used to be duplicated here
// and in src/data/eligibility.ts and had already drifted; SLOT_NAME here is the complete map.
import { ESPN_POS, DEDICATED_SLOT_POS as SLOT_POS, ESPN_SLOT_NAME as SLOT_NAME } from "./espnSlots.js";
import { ESPN_READS_BASE as HOST } from "../data/espnApi.js";
/** ESPN statId for a reception -- the PPR dial. */
const RECEPTION_STAT_ID = 53;

interface EspnPlayer { fullName?: string; defaultPositionId?: number; proTeamId?: number; ownership?: { percentOwned?: number } }
interface EspnEntry { playerPoolEntry?: { player?: EspnPlayer }; player?: EspnPlayer }
interface EspnTeam { id: number; name?: string; location?: string; nickname?: string; roster?: { entries?: EspnEntry[] } }

/** The synced league config as the app stores it in settings.'config'. */
interface EspnConfig { season: number; slots: string[]; teams?: number; scoring?: string; format?: unknown }

const NFL_WEEKS = 17;

/**
 * ONE SEASON'S FORMAT, from that season's own `scheduleSettings`.
 *
 * Deliberately returns `null` rather than a partial or defaulted block when any required field is
 * missing. A half-read format is worse than none: it looks configured, and the consumer that gets it
 * -- the per-season calibration -- would then score a season against a format nobody played. The
 * live path (`formatFromEspnSettings`) THROWS on the same input, because there the answer is needed
 * now and a wrong calendar is an immediate defect; here a missing season is an ordinary fact (ESPN
 * 404s every year before this league existed) and the sweep must not abort on one.
 */
export function seasonFormat(ss: Record<string, unknown> | undefined): SeasonSnapshot["format"] {
  if (!ss || typeof ss !== "object") return null;
  const num = (k: string): number | null => {
    const v = ss[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const regWeeks = num("matchupPeriodCount");
  const playoffTeams = num("playoffTeamCount");
  const playoffRoundWeeks = num("playoffMatchupPeriodLength");
  const tiebreak = ss.playoffSeedingRule;
  const divisions = ss.divisions;
  if (regWeeks == null || playoffTeams == null || playoffRoundWeeks == null) return null;
  if (typeof tiebreak !== "string" || !tiebreak) return null;
  if (ss.playoffReseed == null || !Array.isArray(divisions)) return null;
  return {
    regWeeks, playoffTeams, playoffRoundWeeks,
    playoffReseed: Boolean(ss.playoffReseed),
    // Same rule as the live block: ESPN does not publish "division winners seeded first" as a flag,
    // it is implied by HAVING divisions. With one division the two rules are provably the same rule,
    // so "record" there is a fact rather than an assumption.
    seedingRule: divisions.length > 1 ? "division-winners-first" : "record",
    tiebreak,
    divisionCount: divisions.length,
  };
}

export class EspnLeague implements LeagueProvider {
  readonly platform = "espn";
  private constructor(
    private readonly browser: Browser,
    private readonly wv: WebviewPage,
    private readonly leagueId: string,
    private readonly teamId: string,
    private readonly cfg: EspnConfig,
  ) {}

  /** Attach to the running app and make sure the guest is on an ESPN origin (the fetch is
   *  same-origin credentialed, so a webview parked elsewhere returns a login page, not data). */
  static async open(db: DB, leagueId?: string | null): Promise<EspnLeague> {
    // ONE RESOLVER. This used to take the most-recently-synced row while its caller resolved the
    // league a different way, and read the legacy config mirror -- two chances to open a league whose
    // id and whose rules came from two different leagues.
    const { resolveLeagueContext, requireLeagueId, requireTeamId } =
      await import("../data/leagueContext.js");
    const ctx = resolveLeagueContext(db as unknown as import("../db/db.js").DB, leagueId);
    const row = { league_id: requireLeagueId(ctx, "open the ESPN league"), team_id: requireTeamId(ctx, "open the ESPN league") };
    const cfg = ctx.config as unknown as EspnConfig;
    if (!Array.isArray(cfg.slots) || !cfg.slots.length) throw new Error(`config:${row.league_id} has no lineup slots -- re-sync the league.`);

    const { browser, raw: wv } = await attachWebview();
    if (!/fantasy\.espn\.com/.test(await wv.refreshUrl())) {
      await wv.goto("https://fantasy.espn.com/football/");
      await wv.waitForTimeout(4000);
      if (!/fantasy\.espn\.com/.test(await wv.refreshUrl())) {
        await browser.close().catch(() => {});
        throw new Error("could not bring the webview to ESPN -- open the app and log in.");
      }
    }
    return new EspnLeague(browser, wv, row.league_id, String(row.team_id), cfg);
  }

  /** The shape, with the calendar taken from the stored FORMAT BLOCK rather than a literal 14.
   *  `regWeeks ?? 14` used to live here; it was right for this league and unfalsifiable, because a
   *  league whose settings had never been read looked exactly like one that had. */
  async shape(): Promise<LeagueShape> {
    const fmt = effectiveFormat(this.cfg);
    return {
      season: this.cfg.season, size: this.cfg.teams ?? 0, slots: this.cfg.slots,
      scoring: this.cfg.scoring ?? "STANDARD",
      regWeeks: fmt.regWeeks, nflWeeks: NFL_WEEKS, playoffWeeks: fmt.playoffWeeks,
    };
  }

  /** THE FORMAT, read from ESPN. Read-only, and the only place the settings view is interpreted. */
  async formatBlock(season = this.cfg.season): Promise<LeagueFormat> {
    const url = `${HOST}/seasons/${season}/segments/0/leagues/${this.leagueId}?view=mSettings&view=mTeam`;
    return formatFromEspnSettings(await this.wv.fetchJson<unknown>(url));
  }

  async teams(): Promise<LeagueTeam[]> {
    const url = `${HOST}/seasons/${this.cfg.season}/segments/0/leagues/${this.leagueId}?view=mRoster&view=mTeam`;
    const j = await this.wv.fetchJson<{ teams?: EspnTeam[] }>(url);
    const teams = (j.teams ?? []).map((t) => ({
      id: String(t.id),
      name: (t.name || `${t.location ?? ""} ${t.nickname ?? ""}`).trim() || `Team ${t.id}`,
      mine: String(t.id) === this.teamId,
      roster: (t.roster?.entries ?? []).map((e) => {
        const pl = e.playerPoolEntry?.player ?? e.player ?? {};
        return { name: pl.fullName ?? "", pos: ESPN_POS[pl.defaultPositionId ?? -1] ?? "?", proj: 0 };
      }).filter((p) => p.name),
    }));
    // An empty read means the session lapsed or the shape changed. Returning [] here would make
    // every downstream analysis report "nothing to do" instead of "I could not read the league".
    if (!teams.length) throw new Error("ESPN returned no teams -- session expired, or the API shape changed.");
    if (!teams.some((t) => t.mine)) throw new Error(`no team matched our team_id ${this.teamId} -- re-sync the league.`);
    return teams;
  }

  async myTeam(): Promise<LeagueTeam> {
    const t = (await this.teams()).find((x) => x.mine);
    if (!t) throw new Error("our team not present in the league read.");
    return t;
  }

  async freeAgents(limit = 250): Promise<FreeAgent[]> {
    const filter = { players: { filterStatus: { value: ["FREEAGENT", "WAIVERS"] }, limit,
      sortDraftRanks: { sortPriority: 1, sortAsc: true, value: "STANDARD" } } };
    const url = `${HOST}/seasons/${this.cfg.season}/segments/0/leagues/${this.leagueId}?view=kona_player_info`;
    const j = await this.wv.fetchJson<{ players?: ({ player?: EspnPlayer; onTeamId?: number; status?: string })[] }>(
      url, { "x-fantasy-filter": JSON.stringify(filter) });
    return (j.players ?? []).map((pe) => {
      const pl = pe.player ?? {};
      return { name: pl.fullName ?? "", pos: ESPN_POS[pl.defaultPositionId ?? -1] ?? "?", proj: 0,
        pctOwned: Math.round(pl.ownership?.percentOwned ?? 0), waivers: pe.status === "WAIVERS" };
    }).filter((p) => p.name);
  }

  /**
   * Per-team in-season activity scraped from the RENDERED Transaction Counter page, as an
   * alternative to the JSON `transactionCounter`.
   *
   * Why both exist. The JSON views are gated and can go quiet without warning -- mTransactions2
   * returns an empty array and the league communication feed 404s, both silently. The rendered page
   * is what the user actually sees, so it keeps working when a view is withdrawn.
   *
   * Verified 2026-09-07: for 2025 the two agree EXACTLY, column for column (TRADE/ACQ/DROP/ACTIVATE
   * vs trades/acquisitions/drops/moveToActive). But the page carries NO FAAB column, so the JSON is
   * strictly richer here -- which is why `history()` prefers JSON and falls back to this, rather
   * than the other way round. Set FF_LEAGUE_SOURCE=browser to force the scrape.
   *
   * Columns are read BY HEADER NAME, never by position: a page redesign that inserts a column would
   * otherwise silently shift every value one to the left and still parse.
   */
  private async activityFromDom(season: number): Promise<Map<string, { trades: number; acquisitions: number; drops: number; lineupMoves: number }>> {
    await this.wv.goto(`https://fantasy.espn.com/football/league/transactioncounter?leagueId=${this.leagueId}&seasonId=${season}`);
    for (let i = 0; i < 10; i++) {
      await this.wv.waitForTimeout(2000);
      if (Number(await this.wv.evaluate(`return document.querySelectorAll('tr').length;`)) > 3) break;
    }
    const raw = await this.wv.evaluate(`
      var tables = document.querySelectorAll('table');
      if (tables.length < 2) return null;
      var names = [];
      tables[0].querySelectorAll('tbody tr').forEach(function(r){ names.push((r.innerText||'').trim()); });
      var hdr = [];
      tables[1].querySelectorAll('thead tr th, thead tr td').forEach(function(c){ hdr.push((c.innerText||'').trim().toUpperCase()); });
      var rows = [];
      tables[1].querySelectorAll('tbody tr').forEach(function(r){
        rows.push(Array.prototype.map.call(r.querySelectorAll('td,th'), function(c){ return (c.innerText||'').trim(); }));
      });
      return { names: names, hdr: hdr, rows: rows };
    `) as { names: string[]; hdr: string[]; rows: string[][] } | null;

    const out = new Map<string, { trades: number; acquisitions: number; drops: number; lineupMoves: number }>();
    if (!raw?.names?.length || !raw.rows?.length) return out;
    const col = (want: string) => raw.hdr.indexOf(want);
    const iT = col("TRADE"), iA = col("ACQ"), iD = col("DROP"), iM = col("ACTIVATE");
    if (iT < 0 || iA < 0 || iD < 0 || iM < 0) return out;   // headers moved -> report nothing, do not guess
    const num = (r: string[], i: number) => Number(String(r[i] ?? "").replace(/[^0-9-]/g, "")) || 0;
    for (let i = 0; i < Math.min(raw.names.length, raw.rows.length); i++) {
      out.set(raw.names[i], { trades: num(raw.rows[i], iT), acquisitions: num(raw.rows[i], iA),
        drops: num(raw.rows[i], iD), lineupMoves: num(raw.rows[i], iM) });
    }
    return out;
  }

  /**
   * playerId -> position/name for one season, from the PUBLIC pool. ESPN slots most auction picks
   * straight to the bench, so `lineupSlotId` alone cannot give a position. Cached because a history
   * sweep asks for the same season repeatedly.
   */
  private readonly poolCache = new Map<number, Map<number, { pos: string; name: string }>>();
  private async playerPool(season: number): Promise<Map<number, { pos: string; name: string }>> {
    const hit = this.poolCache.get(season);
    if (hit) return hit;
    const out = new Map<number, { pos: string; name: string }>();
    try {
      const filter = { players: { limit: 2000, sortDraftRanks: { sortPriority: 1, sortAsc: true, value: "STANDARD" } } };
      const pool = await this.wv.fetchJson<{ players?: { player?: EspnPlayer & { id?: number } }[] }>(
        `${HOST}/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`,
        { "x-fantasy-filter": JSON.stringify(filter) });
      for (const pe of pool.players ?? []) {
        const pl = pe.player ?? {};
        if (pl.id != null) out.set(pl.id, { pos: ESPN_POS[pl.defaultPositionId ?? -1] ?? "?", name: pl.fullName ?? "" });
      }
    } catch { /* callers fall back to slot ids */ }
    this.poolCache.set(season, out);
    return out;
  }

  /** The completed draft for one season, with OWNER identity attached (team names change; owners
   *  persist, and a multi-season profile is only meaningful keyed on the human). */
  private async picksFor(season: number): Promise<{ picks: DraftPick[]; teams: SeasonSnapshot["teams"] }> {
    const posById = await this.playerPool(season);
    const url = `${HOST}/seasons/${season}/segments/0/leagues/${this.leagueId}?view=mDraftDetail&view=mTeam`;
    const j = await this.wv.fetchJson<{
      draftDetail?: { picks?: { teamId: number; playerId: number; bidAmount?: number; lineupSlotId?: number; memberId?: string }[] };
      members?: { id: string; displayName?: string; firstName?: string }[];
      teams?: (EspnTeam & {
        primaryOwner?: string;
        rankCalculatedFinal?: number;
        playoffSeed?: number;
        transactionCounter?: Record<string, unknown>;
        record?: { overall?: { wins?: number; losses?: number; pointsFor?: number } };
      })[];
    }>(url);
    const member = new Map((j.members ?? []).map((m) => [m.id, m.displayName || m.firstName || m.id]));
    const teams = (j.teams ?? []).map((t) => {
      // transactionCounter is ESPN's per-team in-season activity tally -- the only reliable source
      // for it here: mTransactions2 returns an empty array and the communication feed 404s.
      const tc = t.transactionCounter ?? {};
      const rec = t.record?.overall ?? {};
      return {
        id: String(t.id),
        name: (t.name || `${t.location ?? ""} ${t.nickname ?? ""}`).trim() || `Team ${t.id}`,
        ownerId: t.primaryOwner ?? "",
        owner: member.get(t.primaryOwner ?? "") ?? (t.primaryOwner ?? ""),
        acquisitions: Number(tc.acquisitions ?? 0),
        faabSpent: Number(tc.acquisitionBudgetSpent ?? 0),
        drops: Number(tc.drops ?? 0),
        trades: Number(tc.trades ?? 0),
        lineupMoves: Number(tc.moveToActive ?? 0),
        acquisitionsByWeek: (tc.matchupAcquisitionTotals ?? {}) as Record<string, number>,
        wins: Number(rec.wins ?? 0),
        losses: Number(rec.losses ?? 0),
        pointsFor: Number(rec.pointsFor ?? 0),
        finalRank: t.rankCalculatedFinal ?? t.playoffSeed ?? null,
        playoffSeed: t.playoffSeed ?? null,
      };
    });
    const picks = (j.draftDetail?.picks ?? []).map((p) => {
      const meta = posById.get(p.playerId);
      return {
        teamId: String(p.teamId),
        name: meta?.name || `#${p.playerId}`,
        pos: meta?.pos || SLOT_POS[p.lineupSlotId ?? -1] || "?",
        price: p.bidAmount || 0,
        ownerId: p.memberId ?? "",
        owner: p.memberId ? (member.get(p.memberId) ?? p.memberId) : "",
      };
    });
    return { picks, teams };
  }

  async draftPicks(): Promise<DraftPick[]> {
    const { picks } = await this.picksFor(this.cfg.season);
    if (!picks.length) throw new Error("no draft picks found -- has the draft completed?");
    return picks;
  }

  /**
   * Past seasons of this same league. Per-season failures are REPORTED, not thrown: a season the
   * league did not exist for is an ordinary fact, and one missing year must not abort the sweep.
   */
  async history(seasons: number[]): Promise<SeasonSnapshot[]> {
    const out: SeasonSnapshot[] = [];
    for (const season of seasons) {
      const empty = { season, size: null, auctionBudget: null, pprPoints: null, slotCounts: {}, format: null, teams: [], picks: [] };
      let settings;
      try {
        settings = await this.wv.fetchJson<{ settings?: {
          size?: number;
          draftSettings?: { auctionBudget?: number };
          scoringSettings?: { scoringItems?: { statId: number; points: number }[] };
          rosterSettings?: { lineupSlotCounts?: Record<string, number> };
          scheduleSettings?: Record<string, unknown>;
        } }>(`${HOST}/seasons/${season}/segments/0/leagues/${this.leagueId}?view=mSettings`);
      } catch (e) {
        out.push({ ...empty, available: false, note: String((e as Error).message).slice(0, 120) });
        continue;
      }
      const s = settings.settings ?? {};
      const slotCounts: Record<string, number> = {};
      for (const [k, n] of Object.entries(s.rosterSettings?.lineupSlotCounts ?? {})) {
        if (n > 0) slotCounts[SLOT_NAME[Number(k)] ?? `slot${k}`] = n;
      }
      const rec = (s.scoringSettings?.scoringItems ?? []).find((it) => it.statId === RECEPTION_STAT_ID);

      let picks: DraftPick[] = [], teams: SeasonSnapshot["teams"] = [];
      try { ({ picks, teams } = await this.picksFor(season)); } catch { /* settings without a draft is still useful */ }

      // Activity source. JSON is preferred because it is the only one carrying FAAB, but a gated or
      // withdrawn view returns all-zero counters that look exactly like a genuinely inactive league
      // -- so an all-zero read on a season that clearly WAS played falls back to the rendered page.
      const played = teams.some((t) => t.wins + t.losses > 0);
      const jsonEmpty = teams.length > 0 && teams.every((t) => t.acquisitions === 0 && t.drops === 0 && t.lineupMoves === 0);
      const forceBrowser = process.env.FF_LEAGUE_SOURCE === "browser";
      if (teams.length && (forceBrowser || (played && jsonEmpty))) {
        try {
          const dom = await this.activityFromDom(season);
          if (dom.size) {
            for (const t of teams) {
              const d = dom.get(t.name);
              if (!d) continue;
              t.acquisitions = d.acquisitions;
              t.drops = d.drops;
              t.trades = d.trades;
              t.lineupMoves = d.lineupMoves;
              // faabSpent deliberately untouched -- the page has no FAAB column, and overwriting a
              // real JSON value with 0 would silently turn "unknown" into "spent nothing".
            }
          }
        } catch { /* keep whatever JSON gave us */ }
      }

      out.push({
        season, available: true,
        size: s.size ?? null,
        auctionBudget: s.draftSettings?.auctionBudget ?? null,
        pprPoints: rec?.points ?? null,
        format: seasonFormat(s.scheduleSettings),
        slotCounts, teams, picks,
      });
    }
    return out;
  }

  /** ESPN's acquisitionSettings, normalized. Its flags are inverted in places (isUsingWaiverOrder
   *  defaults true when absent) and -1 means unlimited -- both are translated here, not by callers. */
  async acquisitionRules(): Promise<AcquisitionRules> {
    const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    const url = `${HOST}/seasons/${this.cfg.season}/segments/0/leagues/${this.leagueId}?view=mSettings`;
    const j = await this.wv.fetchJson<{ settings?: { acquisitionSettings?: Record<string, unknown> } }>(url);
    const a = j.settings?.acquisitionSettings ?? {};
    const lim = (v: unknown) => (v === -1 || v == null ? null : Number(v));
    return {
      waivers: a.isUsingWaiverOrder !== false,
      faabBudget: a.isUsingAcquisitionBudget ? Number(a.acquisitionBudget ?? 0) : null,
      processDays: ((a.waiverProcessDays as (number | string)[]) ?? []).map((d) => (typeof d === "number" ? DAYS[d] : String(d))),
      processHour: a.waiverHours == null ? null : Number(a.waiverHours),
      seasonLimit: lim(a.acquisitionLimit),
      weeklyLimit: lim(a.acquisitionLimitPerWeek),
    };
  }

  /** Head-to-head schedule + divisions. `matchupPeriodId` is the fantasy WEEK; entries past the
   *  regular season are playoff brackets and are excluded by the caller via LeagueShape.regWeeks. */
  async matchups(season = this.cfg.season): Promise<LeagueSchedule> {
    // mMatchup is required for the `schedule` array -- mSettings+mTeam alone return divisions but no
    // games, which the guard below catches rather than reporting an empty schedule as balanced.
    // (mMatchupScore also works but embeds every roster, for a far larger payload.)
    const url = `${HOST}/seasons/${season}/segments/0/leagues/${this.leagueId}?view=mSettings&view=mTeam&view=mMatchup`;
    const j = await this.wv.fetchJson<{
      settings?: { scheduleSettings?: { divisions?: { id: number; name: string }[] } };
      teams?: (EspnTeam & { divisionId?: number })[];
      schedule?: {
        matchupPeriodId?: number;
        // `totalPoints` is the side's SCORED total for that week. Verified present in a real cached
        // payload (league 462233, week 1: 97.6 / 92.46 / 115.61 ...), so the score columns
        // `raw_league_matchup` gained are fillable rather than decorative.
        home?: { teamId?: number; totalPoints?: number };
        away?: { teamId?: number; totalPoints?: number };
      }[];
    }>(url);
    const divs = j.settings?.scheduleSettings?.divisions ?? [];
    const teams = j.teams ?? [];
    const divisions = divs.map((d) => ({
      id: String(d.id), name: d.name,
      teamIds: teams.filter((t) => t.divisionId === d.id).map((t) => String(t.id)),
    }));
    const games = (j.schedule ?? [])
      .filter((m) => m.home?.teamId != null && m.away?.teamId != null)
      .map((m) => ({
        week: Number(m.matchupPeriodId ?? 0),
        homeId: String(m.home!.teamId),
        awayId: String(m.away!.teamId),
        // NULL, NOT 0, for an unplayed week. ESPN reports 0.0 for a week that has not happened AND
        // for a genuine shutout, so the two are indistinguishable in the payload -- but a future
        // week cannot be a shutout, and storing 0 there would put a fabricated result in the
        // warehouse. A score is kept only when the week is behind us, which the CALLER cannot
        // decide (it has no clock) and this reader can only approximate, so the rule is: keep a
        // strictly positive total, drop 0 and absent alike. A real 0-point fantasy week is not a
        // thing that happens with a full lineup; a 0 here is overwhelmingly "not played yet".
        homeScore: typeof m.home!.totalPoints === "number" && m.home!.totalPoints > 0 ? m.home!.totalPoints : null,
        awayScore: typeof m.away!.totalPoints === "number" && m.away!.totalPoints > 0 ? m.away!.totalPoints : null,
      }));
    if (!games.length) throw new Error("ESPN returned no schedule entries -- session expired, or the API shape changed.");
    return { divisions, games };
  }

  async close(): Promise<void> { await this.browser.close().catch(() => {}); }
}
