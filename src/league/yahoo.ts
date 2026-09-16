/**
 * YAHOO adaptor -- the ONLY file in the tree that knows Yahoo's vocabulary, beside the HTML parsers
 * in ./yahooDom.ts that it drives.
 *
 * WHY IT EXISTS (P-5). Before this file the Yahoo league had no adaptor at all: its `league` row and
 * its config were typed in by hand, its roster was an 18-name array hardcoded in
 * `scripts/yahoo-waiver-trade.mjs`, and `openLeague` handed it an ESPN adaptor holding a Yahoo league
 * id. None of that failed -- it answered, in ESPN's shape, about a league that is not on ESPN.
 *
 * TRANSPORT. Yahoo has no unauthenticated JSON like ESPN's `lm-api-reads`, so every read here is a
 * credentialed GET of a real page, executed INSIDE the app's `yahooview` guest (the bridge's `/fetch`
 * route now takes a `host`, so it can reach that guest rather than always the ESPN one). The pages are
 * server-rendered, so the markup carries the data.
 *
 * SLOT VOCABULARY. Yahoo's tokens are normalized to OURS on the way in, per the contract in
 * ./types.ts ("Slot names are OURS -- lineup.ts consumes them, normalized by the adaptor"):
 *
 *     Yahoo      ours        why
 *     W/R/T   -> FLEX        identical eligibility; `slotEligibility` parses both, but FLEX is the
 *                            token every consumer in this repo already matches on.
 *     Q/W/R/T -> SUPERFLEX   same, and `resolveValueLeague` keys the flex GROUP by eligibility, so
 *                            the superflex group stays distinct from the W/R/T group either way.
 *     BN      -> BE          NOT cosmetic. Every "is this a bench slot?" test in the repo spells the
 *                            bench `BE|BENCH` (+`IR`/`ER`): values.ts:154, resolveValueLeague:154,
 *                            lineup.ts:62, season.ts:362, winprob.ts:476. A literal `BN` matches none
 *                            of them, so seven bench slots would have become seven phantom STARTING
 *                            slots at a position called "BN" and moved every replacement level in the
 *                            league. (I-3 of the architecture review unifies those four enumerations;
 *                            when it lands, `BN` can be carried verbatim. Until then this is the
 *                            normalization that keeps the value book honest.)
 *     IR      -> IR          already recognized.
 */
import Database from "better-sqlite3";
import type { Database as RawDB } from "better-sqlite3";
import { bridgeFetch } from "../browser/appBridge.js";
import type { DiscoveredLeague, LeagueSettings, Platform, PlatformIO, PlatformRoster } from "./platform.js";
import type { FreeAgent, LeagueProvider, LeagueSchedule, LeagueShape, LeagueTeam } from "./types.js";
import { effectiveFormat, localStamp, playoffRounds } from "./index.js";
import { parseYahooAvailable, parseYahooManagers, parseYahooMyLeagues, parseYahooRosters, parseYahooScheduleWeek, parseYahooScoreboardWeek, parseYahooScoringTables, parseYahooSettingsTable, parseYahooTeamWeek, parseYahooTransactions, yahooScoringFromTables } from "./yahooDom.js";
import { ESPN_SLOT_NAME } from "./espnSlots.js";
import { isBenchSlot } from "../draft/slots.js";

const NFL_WEEKS = 17;
export const YAHOO_HOST = "fantasysports.yahoo.com";
const BASE = "https://football.fantasysports.yahoo.com";

/** Yahoo slot token -> our slot vocabulary. See the file header for why `BN -> BE` is load-bearing. */
export const YAHOO_SLOT: Record<string, string> = {
  QB: "QB", RB: "RB", WR: "WR", TE: "TE", K: "K", DEF: "DST", "D/ST": "DST",
  "W/R": "FLEX", "W/R/T": "FLEX", "W/T": "FLEX", "Q/W/R/T": "SUPERFLEX",
  BN: "BE", IR: "IR", "IR+": "IR",
};
export const yahooSlot = (s: string): string => YAHOO_SLOT[s.trim().toUpperCase()] ?? s.trim().toUpperCase();

/**
 * OUR slot name -> the NUMERIC lineup-slot id `raw_league_roster_week.lineup_slot_id` holds.
 *
 * WHY A YAHOO ROW CARRIES AN ESPN SLOT NUMBER. That column is an INTEGER and four consumers read it
 * as ESPN's encoding: `isStarterSlot` (20 = bench, 21 = IR) decides `is_starter`, `rosterState`'s
 * `SLOT_NAME` turns it back into a name for `optimalLineup`, `startingTemplate` builds the league's
 * starting template out of the modal multiset of those ids, and the lineup builder excludes 21 from
 * the hindsight optimum. Writing Yahoo's own token there -- or a private id space -- would make every
 * one of those read "slot 37" and silently produce a league whose template is unfillable.
 *
 * So the id space is ESPN's, exactly as `ESPN_SLOT_NAME` defines it, and the mapping is one-to-one
 * and round-trips: 0 QB, 2 RB, 4 WR, 6 TE, 7 OP (== SUPERFLEX, the token `slotEligibility` reads as
 * QB/RB/WR/TE), 23 FLEX, 20 BE, 21 IR, 16 DST, 17 K. `yahooSlotId` THROWS on a token it has no id
 * for, because a defaulted slot id is the one failure this whole mapping exists to prevent.
 */
export const YAHOO_SLOT_ID: Record<string, number> = {
  QB: 0, RB: 2, WR: 4, TE: 6, OP: 7, SUPERFLEX: 7, DST: 16, K: 17, BE: 20, IR: 21, FLEX: 23, "RB/WR": 3, "WR/TE": 5,
};
export function yahooSlotId(slot: string): number {
  const ours = yahooSlot(slot);
  const id = YAHOO_SLOT_ID[ours];
  if (id == null) {
    throw new Error(`yahoo slot "${slot}" (normalized "${ours}") has no lineup-slot id. raw_league_roster_week.lineup_slot_id is ESPN's integer encoding and every reader of it (isStarterSlot, SLOT_NAME, startingTemplate) would silently mis-handle an invented number. Add it to YAHOO_SLOT_ID in src/league/yahoo.ts.`);
  }
  // A one-line guard against the map drifting away from the id space it claims to be in.
  if (ESPN_SLOT_NAME[id] == null) throw new Error(`YAHOO_SLOT_ID maps ${ours} to ${id}, which ESPN_SLOT_NAME does not name -- the two have drifted.`);
  return id;
}

/**
 * THE PREFIX ON A YAHOO PLAYER ID STORED IN `raw_league_roster_week.espn_player_id`.
 *
 * The column is named for ESPN because ESPN was the only platform when it was created; what it holds
 * is "the PLATFORM's own player id". A Yahoo id must be prefixed there and this is not cosmetic:
 * `buildEspnResolver` looks every value up in `player_xref` WHERE source='espn', and 3,618 of those
 * 8,099 ESPN ids are five digits or fewer -- the same shape as a Yahoo id. An unprefixed Yahoo
 * 32671 would therefore have a real chance of resolving to whichever player ESPN numbers 32671, and
 * a wrong `player_sk` produces a complete, plausible lineup about the wrong men.
 *
 * With the prefix the xref lookup MISSES (as it should -- there is no Yahoo cross-reference), the
 * negative-id defence arithmetic misses, and identity falls to the resolver's third stage: name +
 * position against `stg_player`, only where that pair is unambiguous. That is a real, reported
 * coverage number rather than a silent collision.
 */
export const YAHOO_ID_PREFIX = "y:";
export const yahooPlayerKey = (yahooId: string): string => `${YAHOO_ID_PREFIX}${yahooId}`;

/** The league's page URLs. One builder per tab the app offers, so the renderer never concatenates. */
export const yahooUrls = {
  home: `${BASE}/`,
  league: (leagueId: string): string => `${BASE}/f1/${leagueId}`,
  settings: (leagueId: string): string => `${BASE}/f1/${leagueId}/settings`,
  rosters: (leagueId: string): string => `${BASE}/f1/${leagueId}/starters`,
  managers: (leagueId: string): string => `${BASE}/f1/${leagueId}/teams`,
  team: (leagueId: string, teamId: string | null): string => (teamId ? `${BASE}/f1/${leagueId}/${teamId}` : `${BASE}/f1/${leagueId}`),
  /** ONE team's roster AS IT STOOD IN WEEK N, with that week's actual points (WP9). The all-rosters
   *  page takes `?week=` too but has no points column at all, so it cannot seed anything. */
  teamWeek: (leagueId: string, teamId: string, week: number): string => `${BASE}/f1/${leagueId}/${teamId}?week=${week}`,
  scoreboard: (leagueId: string, week?: number | null): string => `${BASE}/f1/${leagueId}/${week ? `?matchup_week=${week}` : ""}`,
  standings: (leagueId: string): string => `${BASE}/f1/${leagueId}/standings`,
  draftRoom: (leagueId: string): string => `${BASE}/f1/${leagueId}/draftresults`,
  /** The AVAILABLE pool, 25 rows a page. `count` is an OFFSET, not a page size. `sort=OR` is the
   *  preseason overall rank -- a stable ordering that exists in every week, unlike a points sort,
   *  which needs a `stat1` week token and silently reorders the pool when that token is wrong. */
  players: (leagueId: string, offset = 0): string => `${BASE}/f1/${leagueId}/players?status=A&pos=O&sort=OR&count=${offset}`,
  transactions: (leagueId: string, offset = 0): string => `${BASE}/f1/${leagueId}/transactions?count=${offset}`,
  /** "My Teams & Leagues" -- the one surface whose shape does not depend on how many leagues we have. */
  myLeagues: `${BASE}/f1/myleagues`,
};

/** The Yahoo players page is fixed at 25 rows; `count` pages it. Named because two call sites need it. */
const PLAYERS_PAGE = 25;
const TRANSACTIONS_PAGE = 15;

/** The default IO: one credentialed GET inside the app's `yahooview` guest. */
export const yahooIO: PlatformIO = {
  get: (url, headers) => bridgeFetch(url, headers, 25000, { host: YAHOO_HOST }),
};

// ---------------------------------------------------------------------------------------------
// settings -> LeagueSettings
// ---------------------------------------------------------------------------------------------

/** "8 teams - Week 15, 16 and 17 (ends Monday, Jan 4)" -> { teams: 8, weeks: [15,16,17] }. */
export function parseYahooPlayoffs(cell: string): { teams: number; weeks: number[] } {
  const t = /(\d+)\s*teams?/i.exec(cell);
  if (!t) throw new Error(`yahoo format: the Playoffs setting does not state a field size (got "${cell}")`);
  // The first number in the cell is the FIELD SIZE; everything after "Week" is a week number. The
  // parenthetical ("ends Monday, Jan 4") carries a date and is cut before any digit is read.
  const head = cell.split("(")[0];
  const wpart = /Week\s*(.*)$/i.exec(head);
  const ws = wpart ? [...wpart[1].matchAll(/\d+/g)].map((m) => Number(m[0])) : [];
  if (!ws.length) throw new Error(`yahoo format: the Playoffs setting names no playoff weeks (got "${cell}")`);
  return { teams: Number(t[1]), weeks: ws.sort((a, b) => a - b) };
}

const yesNo = (v: string | undefined, what: string): boolean => {
  if (/^yes$/i.test(String(v ?? "").trim())) return true;
  if (/^no$/i.test(String(v ?? "").trim())) return false;
  throw new Error(`yahoo settings: "${what}" is "${v ?? ""}", not Yes or No -- refusing to guess it.`);
};

/**
 * PURE: the settings page HTML -> `LeagueSettings`. Everything is read from a NAMED row of Yahoo's own
 * settings table or from its scoring tables; nothing is defaulted. A row that is absent throws and
 * names itself, for the same reason `formatFromEspnSettings` does: a calendar that is right by
 * coincidence is indistinguishable from one that was read.
 *
 * `managersHtml` is optional and supplies ONE fact the settings page does not publish: the FAB budget.
 * Yahoo states the waiver TYPE ("FAB w/ Continual rolling list tiebreak") but never the dollar figure,
 * so it is taken from the Managers page as the balance of a team that has made ZERO moves -- i.e. an
 * OBSERVED full budget, not an assumed $100. With no such team it stays null rather than invented.
 */
export function yahooSettingsFromHtml(
  settingsHtml: string,
  opts: { leagueId: string; season: number; managersHtml?: string | null; now?: Date },
): LeagueSettings {
  const t = parseYahooSettingsTable(settingsHtml);
  const need = (label: string): string => {
    const v = t[label];
    if (v == null || v === "") throw new Error(`yahoo settings: league ${opts.leagueId}'s settings page has no "${label}" row -- refusing to default it. (Read ${yahooUrls.settings(opts.leagueId)}.)`);
    return v;
  };
  const gotId = need("League ID#");
  if (String(gotId) !== String(opts.leagueId)) {
    throw new Error(`yahoo syncSettings REFUSED: asked for league ${opts.leagueId} but the page is league ${gotId} -- reading one league and writing another is how a league inherits another league's rules. Nothing was written.`);
  }

  const teams = Number(need("Max Teams"));
  if (!(teams > 0)) throw new Error(`yahoo settings: "Max Teams" is "${t["Max Teams"]}", not a positive number.`);

  const rawSlots = need("Roster Positions").split(",").map((s) => s.trim()).filter(Boolean);
  if (!rawSlots.length) throw new Error("yahoo settings: \"Roster Positions\" is empty.");
  const slots = rawSlots.map(yahooSlot);

  const draftCell = need("Draft Type");
  const draftType: "auction" | "snake" = /auction|salary\s*cap/i.test(draftCell) ? "auction" : "snake";

  const { teams: playoffTeams, weeks: playoffWeeks } = parseYahooPlayoffs(need("Playoffs"));
  const regWeeks = playoffWeeks[0] - 1;
  const rounds = playoffRounds(playoffTeams);
  const playoffRoundWeeks = playoffWeeks.length / rounds;
  if (!Number.isInteger(playoffRoundWeeks) || playoffRoundWeeks < 1) {
    throw new Error(`yahoo format: ${playoffTeams} playoff teams need ${rounds} rounds but the page names ${playoffWeeks.length} playoff weeks (${playoffWeeks.join(", ")}) -- the calendar does not divide into rounds and will NOT be guessed.`);
  }
  const hasDivisions = yesNo(t["Divisions"], "Divisions");

  const { rules, unmapped } = yahooScoringFromTables(parseYahooScoringTables(settingsHtml));
  const scoringBucket: LeagueSettings["scoringBucket"] = rules.rec >= 1 ? "PPR" : rules.rec >= 0.5 ? "HALF" : "STD";

  // NO KICKER, NO DEFENSE -- and that is a READ, not an omission. This league's settings page carries
  // exactly four scoring tables (QB/RB/WR/TE) and its roster names no K and no D/ST slot, so there is
  // no kicking or defensive rule set to read. `null` says that; the ESPN defaults would say the
  // opposite while looking identical in the store.
  const rostersK = slots.some((s) => s === "K");
  const rostersDst = slots.some((s) => s === "DST");
  if (rostersK || rostersDst) {
    // A league that DOES roster them has kicking/defensive rules somewhere, and this reader has never
    // been pinned against a Yahoo page that publishes them. Refuse by name rather than hand back
    // `null` (which a consumer would read as "this league scores no kickers") or another league's
    // constants (which is the fabrication this whole pass exists to remove).
    throw new Error(`yahoo settings: league ${opts.leagueId} rosters ${[rostersK ? "K" : "", rostersDst ? "DST" : ""].filter(Boolean).join(" and ")}, but this reader has only been pinned against the four offensive scoring tables. Extend yahooScoringFromTables before syncing a league with those slots.`);
  }

  const waiverType = need("Waiver Type");
  const usesFaab = /\bFAB\b|FAAB/i.test(waiverType);
  const weekly = t["Weekly Waivers"] ?? "";
  const dayM = /(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)/i.exec(weekly);
  const noMax = (label: string): number | null => {
    const v = t[label];
    if (v == null) return null;
    if (/no\s*maximum/i.test(v)) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  let faabBudget: number | null = null;
  if (usesFaab && opts.managersHtml) {
    const untouched = parseYahooManagers(opts.managersHtml).filter((m) => m.moves === 0 && m.faabRemaining != null);
    if (untouched.length) faabBudget = Math.max(...untouched.map((m) => m.faabRemaining as number));
  }

  const stamp = localStamp(opts.now ?? new Date());
  return {
    leagueId: opts.leagueId, platform: "yahoo", season: opts.season,
    name: t["League Name"] ?? null,
    // Yahoo's settings page names the league's rules, not WHICH of the twelve teams is ours -- that
    // is on the Managers page and is read separately. `null` = "this read cannot tell", so the caller
    // keeps the stored `team_id` rather than blanking our seat.
    teamId: null,
    teams, slots, draftType,
    // A snake draft has no dollars. `null` rather than a number is the whole point: `requireAuction`
    // already refuses the auction-only verbs by name, and a budget here would be a value with no referent.
    budget: draftType === "auction" ? Number(t["Salary Cap"]) || null : null,
    scoring: rules, scoringBucket,
    // Read, not omitted: the settings page carries four scoring tables (QB/RB/WR/TE) and the roster
    // names no K and no D/ST slot, so there is no kicking or defensive rule set to read.
    kicker: null,
    defense: null,
    format: {
      regWeeks, playoffTeams, playoffRoundWeeks, playoffWeeks,
      // Yahoo says "Divisions: No" outright, so "record" here is a READ, not the one-division
      // coincidence ESPN's payload leaves us to infer.
      seeding: hasDivisions ? "division-winners-first" : "record",
      playoffReseed: yesNo(t["Playoff Reseeding"], "Playoff Reseeding"),
      tiebreak: need("Playoff Tie-Breaker"),
      divisions: [],
      // NOT "yahoo": LeagueFormat.source is the two-valued fact "did the PLATFORM's own settings sync
      // write this, or did a person?" and this repo's sync-from-platform value is "espn". A block read
      // from Yahoo's page by a reader Yahoo does not know about is an owner override in that sense --
      // and `note` below names exactly where every field came from.
      source: "owner-override",
      fetchedAt: stamp,
      note: `read from ${yahooUrls.settings(opts.leagueId)} (Yahoo settings table) on ${stamp}`,
    },
    acquisition: {
      waivers: true,
      faabBudget,
      processDays: dayM ? [dayM[1]] : [],
      processHour: null,
      seasonLimit: noMax("Max Acquisitions for Entire Season"),
      weeklyLimit: noMax("Max Acquisitions per Week"),
    },
    rosterSettings: { ...t, "Unmapped scoring terms": Object.entries(unmapped).map(([k, v]) => `${k}=${v}`).join("; ") },
    provenance: `yahoo ${yahooUrls.settings(opts.leagueId)} + ${yahooUrls.managers(opts.leagueId)}, read ${stamp}`,
  };
}

// ---------------------------------------------------------------------------------------------
// The Platform
// ---------------------------------------------------------------------------------------------

export const yahooPlatform: Platform = {
  id: "yahoo",
  webview: { elementId: "yahooview", host: YAHOO_HOST, partition: "persist:yahoo" },
  urls: {
    home: yahooUrls.home,
    league: (leagueId) => yahooUrls.league(leagueId),
    team: (leagueId, _season, teamId) => yahooUrls.team(leagueId, teamId),
    scoreboard: (leagueId, _season, week) => yahooUrls.scoreboard(leagueId, week),
    standings: (leagueId) => yahooUrls.standings(leagueId),
    draftRoom: (leagueId) => yahooUrls.draftRoom(leagueId),
  },

  /**
   * THE LEAGUES THIS LOGIN IS IN, from `/f1/myleagues`.
   *
   * WHAT CHANGED AND WHY (WP9). This read `/` and matched every `/f1/<digits>` anchor on it. The
   * fantasy home renders a MINI-HOME for whichever league you looked at last -- its markup carries
   * matchup links, team links and ad payloads with league ids in them -- so the result depended on
   * browsing history, and `teamId` was hardcoded `null`. A `null` team id there is not harmless:
   * `discover_leagues` writes the row, and blanking our seat breaks every verb that needs it.
   * `/f1/myleagues` is a four-column table (league, team, status, delete) whose shape does not change
   * with how many leagues we have, and it is the only surface that names our team beside the league.
   *
   * SEASON is the caller's `wantSeason`, and that is a statement about the HOST, not a guess: the
   * unprefixed `football.fantasysports.yahoo.com/f1/<id>` serves the current NFL season only (a past
   * season lives behind its own year-prefixed game key), so a league found here is a league of the
   * season the caller is asking about. If that ever stops being true the filter in `discover_leagues`
   * would silently keep a stale league rather than skip it, so it is stated here rather than implied.
   */
  async discover(io, wantSeason): Promise<DiscoveredLeague[]> {
    const html = await io.get(yahooUrls.myLeagues);
    const rows = parseYahooMyLeagues(html);
    if (!rows.length) {
      throw new Error(`yahoo discover: ${yahooUrls.myLeagues} listed no leagues -- not logged in to Yahoo in the app's yahooview guest, or Yahoo changed the markup. Refusing to report "you have no leagues".`);
    }
    return rows.map((r) => ({ leagueId: r.leagueId, season: wantSeason, teamId: r.teamId, name: r.name }));
  },

  async syncSettings(io, leagueId, season): Promise<LeagueSettings> {
    const settingsHtml = await io.get(yahooUrls.settings(leagueId));
    let managersHtml: string | null = null;
    try { managersHtml = await io.get(yahooUrls.managers(leagueId)); } catch { managersHtml = null; }
    return yahooSettingsFromHtml(settingsHtml, { leagueId, season, managersHtml });
  },

  async syncRosters(io, leagueId): Promise<PlatformRoster[]> {
    const html = await io.get(yahooUrls.rosters(leagueId));
    return parseYahooRosters(html).map((r) => ({
      teamId: r.teamId, teamName: r.teamName,
      players: r.players.map((p) => ({ name: p.name, pos: p.pos, slot: yahooSlot(p.slot), team: p.team })),
    }));
  },

  /**
   * EVERY TEAM'S WEEK-N LINEUP AND THAT WEEK'S ACTUAL POINTS -- the D18 seed's missing input (WP9).
   *
   * ONE FETCH PER TEAM, and that is the cheaper of the two honest options. `/starters?week=N` returns
   * all twelve rosters in one page and IS week-aware, but it has exactly two columns (Pos, Player)
   * and no points anywhere; the seed scores each settled week from the started lineup, so a source
   * with no points cannot seed it at all. `/f1/<lg>/<team>?week=N` carries the slot, the man and his
   * Fan Pts together.
   *
   * THE TEAM LIST COMES FROM THE ALL-ROSTERS PAGE, not from `1..cfg.teams`: a league's team ids are
   * whatever Yahoo assigned and need not be a dense range, and counting to twelve would silently miss
   * a thirteenth or fetch a 404 for a gap. One extra page, and the ids are then observed.
   *
   * WHAT IS NOT CLAIMED. `acquisition_type`/`acquisition_date` stay null -- Yahoo's team page does not
   * say how a man arrived; that lives on the transactions page under a different key and deriving it
   * here would put a join into the raw layer. `as_of` is stamped by the loader from `raw_nfl_game`,
   * exactly as it is for an ESPN row.
   */
  async rosterWeek(io, leagueId, season, week): Promise<import("./platform.js").PlatformRosterWeekRow[]> {
    const teamIds = (await this.syncRosters(io, leagueId, season)).map((r) => r.teamId);
    if (!teamIds.length) throw new Error(`yahoo rosterWeek: league ${leagueId} returned no teams -- refusing to report an empty week.`);
    const out: import("./platform.js").PlatformRosterWeekRow[] = [];
    for (const teamId of teamIds) {
      const html = await io.get(yahooUrls.teamWeek(leagueId, teamId, week));
      const rows = parseYahooTeamWeek(html);
      if (!rows.length) throw new Error(`yahoo rosterWeek: team ${teamId} of league ${leagueId} carried no players in week ${week} -- refusing to record an empty roster, which the seed would score as zero.`);
      for (const r of rows) {
        const slotId = yahooSlotId(r.slot);
        out.push({
          teamId,
          platformPlayerId: yahooPlayerKey(r.playerId),
          name: r.name,
          position: r.pos,
          lineupSlotId: slotId,
          // THE BENCH TEST IS src/draft/slots.ts's, not a literal `!== 20 && !== 21`. Same answer for
          // every slot Yahoo can produce (BE 20 and IR 21 are the only bench-like ones this league
          // has), and it cannot drift away from the definition every other consumer uses.
          isStarter: !isBenchSlot(ESPN_SLOT_NAME[slotId] ?? String(slotId)),
          appliedPoints: r.points,
          proTeam: r.team || null,
        });
      }
    }
    return out;
  },

  async readTeam(io, leagueId, season, teamId): Promise<LeagueTeam> {
    const rosters = await this.syncRosters(io, leagueId, season);
    const t = rosters.find((r) => r.teamId === String(teamId));
    if (!t) throw new Error(`yahoo readTeam: league ${leagueId} has no team ${teamId} (has ${rosters.map((r) => r.teamId).join(", ")})`);
    return { id: t.teamId, name: t.teamName, mine: true, roster: t.players.map((p) => ({ name: p.name, pos: p.pos, proj: 0, team: p.team })) };
  },
};

// ---------------------------------------------------------------------------------------------
// The read-side provider (what openLeague attaches OUR valuation to)
// ---------------------------------------------------------------------------------------------

interface YahooCfg { season: number; slots: string[]; teams?: number; scoring?: string; format?: unknown }

export class YahooLeague implements LeagueProvider {
  readonly platform = "yahoo";
  private constructor(
    private readonly leagueId: string,
    private readonly teamId: string | null,
    private readonly cfg: YahooCfg,
    private readonly io: PlatformIO,
  ) {}

  static async open(db: RawDB, leagueId?: string | null, io: PlatformIO = yahooIO): Promise<YahooLeague> {
    const { resolveLeagueContext, requireLeagueId } = await import("../data/leagueContext.js");
    const ctx = resolveLeagueContext(db as unknown as import("../db/db.js").DB, leagueId);
    const id = requireLeagueId(ctx, "open the Yahoo league");
    const cfg = ctx.config as unknown as YahooCfg;
    if (!Array.isArray(cfg.slots) || !cfg.slots.length) throw new Error(`config:${id} has no lineup slots -- re-sync the league.`);
    return new YahooLeague(id, ctx.teamId, cfg, io);
  }

  /** Open against an explicit league id + team, with no store. Used by the WP4 positive control. */
  static direct(leagueId: string, teamId: string | null, cfg: YahooCfg, io: PlatformIO = yahooIO): YahooLeague {
    return new YahooLeague(leagueId, teamId, cfg, io);
  }

  async shape(): Promise<LeagueShape> {
    const fmt = effectiveFormat(this.cfg);
    return {
      season: this.cfg.season, size: this.cfg.teams ?? 0, slots: this.cfg.slots,
      scoring: this.cfg.scoring ?? "PPR",
      regWeeks: fmt.regWeeks, nflWeeks: NFL_WEEKS, playoffWeeks: fmt.playoffWeeks,
    };
  }

  async teams(): Promise<LeagueTeam[]> {
    const rosters = await yahooPlatform.syncRosters(this.io, this.leagueId, this.cfg.season);
    if (!rosters.length) throw new Error(`yahoo teams: league ${this.leagueId} returned no rosters -- not logged in, or Yahoo changed the all-rosters page.`);
    return rosters.map((r) => ({
      id: r.teamId, name: r.teamName, mine: this.teamId != null && r.teamId === String(this.teamId),
      roster: r.players.map((p) => ({ name: p.name, pos: p.pos, proj: 0, team: p.team })),
    }));
  }

  async myTeam(): Promise<LeagueTeam> {
    if (!this.teamId) throw new Error(`yahoo myTeam: league ${this.leagueId} has no team_id in the store -- this store does not know which of the twelve teams is ours.`);
    const all = await this.teams();
    const me = all.find((t) => t.mine);
    if (!me) throw new Error(`yahoo myTeam: team ${this.teamId} is not among league ${this.leagueId}'s teams (${all.map((t) => t.id).join(", ")}).`);
    return me;
  }

  /** The REGULAR-SEASON schedule, one scoreboard page per week. Playoff weeks are deliberately not
   *  read: Yahoo publishes no bracket until it is seeded, and an empty week there is a fact, not a
   *  failure -- so asking for them would only produce weeks with zero games. */
  async matchups(): Promise<LeagueSchedule> {
    const fmt = effectiveFormat(this.cfg);
    const games: LeagueSchedule["games"] = [];
    for (let w = 1; w <= fmt.regWeeks; w++) {
      const html = await this.io.get(yahooUrls.scoreboard(this.leagueId, w));
      const wk = parseYahooScheduleWeek(html, w);
      if (!wk.length) throw new Error(`yahoo matchups: week ${w} of league ${this.leagueId} carried no games -- refusing to report a schedule with a silent hole in it.`);
      for (const g of wk) games.push({ week: w, homeId: g.homeId, awayId: g.awayId });
    }
    return { divisions: fmt.divisions, games };
  }

  /**
   * THE REAL FREE-AGENT POOL, from `/players?status=A` (WP9).
   *
   * `status=A` is Yahoo's own "available" filter -- the complement of the twelve rosters -- so the
   * pool is defined by the platform rather than reconstructed by us from a board minus an ownership
   * table. `pos=O` is all offensive positions at once, which is the whole pool for this league (it
   * rosters no K and no D/ST); a league that rostered them would need those groups asked for too, and
   * that is stated rather than silently missing.
   *
   * PAGING: 25 rows per page, `count` is the OFFSET. `limit` is a number of PLAYERS; the loop stops
   * early on a short page, which is how the end of the pool announces itself.
   *
   * `waivers` is Yahoo's Roster Status: "FA" is a straight add, "W (Sep 19)" is a claim that must be
   * bid on. `proj` is 0 -- valuation is attached by the caller from OUR model, exactly as the ESPN
   * adaptor leaves it -- and `pctOwned` is Yahoo's cross-platform rostered share.
   */
  async freeAgents(limit = 250): Promise<FreeAgent[]> {
    const out: FreeAgent[] = [];
    const seen = new Set<string>();
    for (let offset = 0; out.length < limit; offset += PLAYERS_PAGE) {
      const page = parseYahooAvailable(await this.io.get(yahooUrls.players(this.leagueId, offset)));
      for (const p of page) {
        if (seen.has(p.playerId)) continue;
        seen.add(p.playerId);
        out.push({ name: p.name, pos: p.pos, proj: 0, team: p.team, pctOwned: Math.round(p.pctRostered ?? 0), waivers: /^W\b/i.test(p.status) });
        if (out.length >= limit) break;
      }
      if (page.length < PLAYERS_PAGE) break;             // the last page -- the pool is exhausted
    }
    if (!out.length) throw new Error(`yahoo freeAgents: league ${this.leagueId} reported no available players at all. That is not a state this league can be in; treat it as a failed read.`);
    return out;
  }

  /**
   * THE LEAGUE'S TRANSACTION LOG, as Yahoo publishes it.
   *
   * NOT on `LeagueProvider` -- it is this adaptor's own capability, read by
   * `ingestYahooTransactions`. `limit` is a number of ROWS (Yahoo pages 15 at a time).
   *
   * Yahoo publishes the WINNING FAB bid on every team's claim, which is strictly more than ESPN's
   * rendered transaction counter gives; it publishes no losing bid, no transaction id and no absolute
   * timestamp (only "Sep 16, 4:55 am" in the viewer's zone). See `parseYahooTransactions`.
   */
  async transactions(limit = 150): Promise<ReturnType<typeof parseYahooTransactions>> {
    const out: ReturnType<typeof parseYahooTransactions> = [];
    // DEDUPED ACROSS PAGES BY THE DERIVED KEY. Yahoo's `count` offset does not partition the log
    // cleanly -- page 2 repeats rows from page 1 (measured: 21 rows read, 17 distinct events) -- and
    // without this the caller's "transactions read" count is inflated by the overlap while the store,
    // which upserts by that same key, quietly holds the right number. Two counts that disagree for a
    // reason nobody has written down is how a number stops meaning anything.
    const seen = new Set<string>();
    for (let offset = 0; out.length < limit; offset += TRANSACTIONS_PAGE) {
      const page = parseYahooTransactions(await this.io.get(yahooUrls.transactions(this.leagueId, offset)), this.leagueId);
      let fresh = 0;
      for (const t of page) {
        if (seen.has(t.key)) continue;
        seen.add(t.key); out.push(t); fresh++;
        if (out.length >= limit) break;
      }
      // A page that is entirely repeats means the log has ended and Yahoo is clamping the offset.
      if (page.length < TRANSACTIONS_PAGE || fresh === 0) break;
    }
    return out;
  }

  /** WHICH LEAGUE this provider is for -- read by the ingesters, so they stamp the rows with the id
   *  the pages were actually fetched from rather than one resolved a second time. */
  get id(): string { return this.leagueId; }

  /**
   * THE SETTLED WEEK'S SCORES, straight from Yahoo's own scoreboard.
   *
   * NOT what the D18 seed reads -- it sums the STARTED LINEUP from `raw_league_roster_week`, which is
   * why WP9 added no score columns to `raw_league_matchup`. This exists as the INDEPENDENT check on
   * that sum: two numbers from two different pages, and a disagreement means the lineup snapshot is
   * wrong in a way that no amount of internal consistency could reveal.
   */
  async weekScores(week: number): Promise<{ week: number; homeId: string; awayId: string; homePts: number | null; awayPts: number | null }[]> {
    return parseYahooScoreboardWeek(await this.io.get(yahooUrls.scoreboard(this.leagueId, week)), week);
  }

  async close(): Promise<void> { /* the guest is the app's; nothing of ours to close */ }
}

/** Open the Yahoo league read-side provider against a store path (the WP4 positive control entry). */
export async function openYahoo(dbPath = "data/ff.db", leagueId = "129048"): Promise<YahooLeague> {
  const db = new Database(dbPath, { readonly: true });
  try { return await YahooLeague.open(db, leagueId); } finally { db.close(); }
}
