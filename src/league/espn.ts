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
import type { AcquisitionRules, DraftPick, FreeAgent, LeagueProvider, LeagueSchedule, LeagueShape, LeagueTeam } from "./types.js";

const ESPN_POS: Record<number, string> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };
/** lineupSlotId -> position, the fallback when a drafted player is missing from the public pool. */
const SLOT_POS: Record<number, string> = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "DST", 17: "K" };
const HOST = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";

interface EspnPlayer { fullName?: string; defaultPositionId?: number; proTeamId?: number; ownership?: { percentOwned?: number } }
interface EspnEntry { playerPoolEntry?: { player?: EspnPlayer }; player?: EspnPlayer }
interface EspnTeam { id: number; name?: string; location?: string; nickname?: string; roster?: { entries?: EspnEntry[] } }

/** The synced league config as the app stores it in settings.'config'. */
interface EspnConfig { season: number; slots: string[]; teams?: number; scoring?: string; regWeeks?: number }

const NFL_WEEKS = 17;

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
  static async open(db: DB): Promise<EspnLeague> {
    const row = db.prepare("SELECT league_id, team_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get() as
      { league_id: string; team_id: string } | undefined;
    if (!row?.league_id) throw new Error("no league synced -- run the app once and sync your league.");
    const raw = db.prepare("SELECT value FROM settings WHERE key='config'").get() as { value: string } | undefined;
    if (!raw) throw new Error("no config in settings -- run the app once.");
    const cfg = JSON.parse(raw.value) as EspnConfig;
    if (!Array.isArray(cfg.slots) || !cfg.slots.length) throw new Error("config.slots missing -- re-sync the league.");

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

  async shape(): Promise<LeagueShape> {
    const regWeeks = this.cfg.regWeeks ?? 14;
    const playoffWeeks: number[] = [];
    for (let w = regWeeks + 1; w <= NFL_WEEKS; w++) playoffWeeks.push(w);
    return {
      season: this.cfg.season, size: this.cfg.teams ?? 0, slots: this.cfg.slots,
      scoring: this.cfg.scoring ?? "STANDARD", regWeeks, nflWeeks: NFL_WEEKS, playoffWeeks,
    };
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
   * The completed draft. ESPN slots most auction picks straight to the bench, so `lineupSlotId`
   * cannot give a position -- the public player pool is fetched separately to map playerId ->
   * position, with the slot id as a fallback for anyone missing from it.
   */
  async draftPicks(): Promise<DraftPick[]> {
    const posById = new Map<number, { pos: string; name: string }>();
    try {
      const filter = { players: { limit: 2000, sortDraftRanks: { sortPriority: 1, sortAsc: true, value: "STANDARD" } } };
      const pool = await this.wv.fetchJson<{ players?: { player?: EspnPlayer & { id?: number } }[] }>(
        `${HOST}/seasons/${this.cfg.season}/segments/0/leaguedefaults/3?view=kona_player_info`,
        { "x-fantasy-filter": JSON.stringify(filter) });
      for (const pe of pool.players ?? []) {
        const pl = pe.player ?? {};
        if (pl.id != null) posById.set(pl.id, { pos: ESPN_POS[pl.defaultPositionId ?? -1] ?? "?", name: pl.fullName ?? "" });
      }
    } catch { /* fall back to slot ids below */ }

    const url = `${HOST}/seasons/${this.cfg.season}/segments/0/leagues/${this.leagueId}?view=mDraftDetail&view=mTeam&view=mRoster`;
    const j = await this.wv.fetchJson<{ draftDetail?: { picks?: { teamId: number; playerId: number; bidAmount?: number; lineupSlotId?: number }[] } }>(url);
    const picks = j.draftDetail?.picks ?? [];
    if (!picks.length) throw new Error("no draft picks found -- has the draft completed?");
    return picks.map((p) => {
      const meta = posById.get(p.playerId);
      const name = meta?.name || `#${p.playerId}`;
      return { teamId: String(p.teamId), name,
        pos: meta?.pos || SLOT_POS[p.lineupSlotId ?? -1] || "?", price: p.bidAmount || 0 };
    });
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
  async matchups(): Promise<LeagueSchedule> {
    // mMatchup is required for the `schedule` array -- mSettings+mTeam alone return divisions but no
    // games, which the guard below catches rather than reporting an empty schedule as balanced.
    // (mMatchupScore also works but embeds every roster, for a far larger payload.)
    const url = `${HOST}/seasons/${this.cfg.season}/segments/0/leagues/${this.leagueId}?view=mSettings&view=mTeam&view=mMatchup`;
    const j = await this.wv.fetchJson<{
      settings?: { scheduleSettings?: { divisions?: { id: number; name: string }[] } };
      teams?: (EspnTeam & { divisionId?: number })[];
      schedule?: { matchupPeriodId?: number; home?: { teamId?: number }; away?: { teamId?: number } }[];
    }>(url);
    const divs = j.settings?.scheduleSettings?.divisions ?? [];
    const teams = j.teams ?? [];
    const divisions = divs.map((d) => ({
      id: String(d.id), name: d.name,
      teamIds: teams.filter((t) => t.divisionId === d.id).map((t) => String(t.id)),
    }));
    const games = (j.schedule ?? [])
      .filter((m) => m.home?.teamId != null && m.away?.teamId != null)
      .map((m) => ({ week: Number(m.matchupPeriodId ?? 0), homeId: String(m.home!.teamId), awayId: String(m.away!.teamId) }));
    if (!games.length) throw new Error("ESPN returned no schedule entries -- session expired, or the API shape changed.");
    return { divisions, games };
  }

  async close(): Promise<void> { await this.browser.close().catch(() => {}); }
}
