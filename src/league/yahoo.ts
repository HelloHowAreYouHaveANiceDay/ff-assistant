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
import { parseYahooManagers, parseYahooRosters, parseYahooScheduleWeek, parseYahooScoringTables, parseYahooSettingsTable, yahooScoringFromTables } from "./yahooDom.js";

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

/** The league's page URLs. One builder per tab the app offers, so the renderer never concatenates. */
export const yahooUrls = {
  home: `${BASE}/`,
  league: (leagueId: string): string => `${BASE}/f1/${leagueId}`,
  settings: (leagueId: string): string => `${BASE}/f1/${leagueId}/settings`,
  rosters: (leagueId: string): string => `${BASE}/f1/${leagueId}/starters`,
  managers: (leagueId: string): string => `${BASE}/f1/${leagueId}/teams`,
  team: (leagueId: string, teamId: string | null): string => (teamId ? `${BASE}/f1/${leagueId}/${teamId}` : `${BASE}/f1/${leagueId}`),
  scoreboard: (leagueId: string, week?: number | null): string => `${BASE}/f1/${leagueId}/${week ? `?matchup_week=${week}` : ""}`,
  standings: (leagueId: string): string => `${BASE}/f1/${leagueId}/standings`,
  draftRoom: (leagueId: string): string => `${BASE}/f1/${leagueId}/draftresults`,
};

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

  async discover(io): Promise<DiscoveredLeague[]> {
    const html = await io.get(yahooUrls.home);
    const seen = new Set<string>();
    const out: DiscoveredLeague[] = [];
    for (const m of html.matchAll(/href="\/f1\/(\d+)"[^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({ leagueId: m[1], season: null, teamId: null, name: m[2].replace(/<[^>]*>/g, "").trim() || null });
    }
    return out;
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
   * NOT BUILT, and it says so. Yahoo's free-agent list is paged and filtered behind query parameters
   * this adaptor has not been pinned against a fixture, and `types.ts` is explicit that an adaptor
   * must throw rather than return an empty array: an empty FA pool and a failed read look identical to
   * a caller, and a waiver script that scores an empty pool reports "no upgrade available".
   */
  async freeAgents(): Promise<FreeAgent[]> {
    throw new Error(`yahoo freeAgents: not implemented for league ${this.leagueId}. The FA pool is read today by scripts/yahoo-waiver-trade.mjs from data/formats/<key>/fa-pool.json; wire that through this method before any consumer relies on it.`);
  }

  async close(): Promise<void> { /* the guest is the app's; nothing of ours to close */ }
}

/** Open the Yahoo league read-side provider against a store path (the WP4 positive control entry). */
export async function openYahoo(dbPath = "data/ff.db", leagueId = "129048"): Promise<YahooLeague> {
  const db = new Database(dbPath, { readonly: true });
  try { return await YahooLeague.open(db, leagueId); } finally { db.close(); }
}
