/**
 * The platform-agnostic league interface.
 *
 * Everything above this line -- trade finders, waiver evaluators, power rankings, playoff SOS --
 * must speak only these types. Nothing in an analysis script should know that ESPN numbers a tight
 * end `defaultPositionId: 4`, or that free agents arrive under `kona_player_info` behind an
 * `x-fantasy-filter` header. Those are ESPN's private vocabulary and they live in the ESPN adaptor.
 *
 * The split that makes this work: an adaptor answers WHO (identities, rosters, ownership, league
 * shape) and never WHAT THEY ARE WORTH. Valuation is ours -- points.csv, our VOR curve, our levers
 * -- and is attached by openLeague() after the adaptor returns. So a second platform costs one file
 * implementing LeagueProvider, and zero changes to any consumer.
 */

/** A player as any platform can describe him, plus OUR projection (attached by openLeague). */
export interface LeaguePlayer {
  name: string;
  pos: string;              // QB | RB | WR | TE | K | DST -- normalized by the adaptor
  proj: number;             // our season projection; 0 when we have no line on him
  team?: string;            // NFL team abbreviation, for schedule/SOS joins
}

export interface LeagueTeam {
  id: string;
  name: string;
  mine: boolean;            // exactly one team has this set
  roster: LeaguePlayer[];
}

export interface FreeAgent extends LeaguePlayer {
  pctOwned: number;         // 0-100; how widely rostered across the platform
  waivers: boolean;         // true = must be claimed, false = free-agent add
}

/**
 * League shape. Slot names are OURS (lineup.ts consumes them), normalized by the adaptor.
 *
 * regWeeks/playoffWeeks are here so no consumer hardcodes a calendar. Three scripts divided season
 * totals by a literal 17 and playoff-sos.mjs hardcoded weeks 15/16/17 -- both happen to be right
 * for THIS league and silently wrong for a 13-week or 4-round one.
 */
export interface LeagueShape {
  season: number;
  size: number;
  slots: string[];          // e.g. ["QB","RB","WR","TE","FLEX","FLEX","DST","K","BE",...]
  scoring: string;          // "PPR" | "HALF" | "STANDARD"
  regWeeks: number;         // last week of the fantasy regular season
  nflWeeks: number;         // games in an NFL season -- the divisor for season-total projections
  playoffWeeks: number[];   // derived: regWeeks+1 .. nflWeeks
}

/**
 * What every platform adaptor must provide. Deliberately small: these five calls are the complete
 * set the current analysis layer uses, and a new platform is done when they work.
 *
 * Adaptors MUST throw on failure rather than return an empty array. An empty roster and a failed
 * read look identical to a caller, and a trade script that silently scores an empty roster reports
 * "no trade improves both sides" -- a confident wrong answer with no error anywhere.
 */
export interface LeagueProvider {
  readonly platform: string;
  shape(): Promise<LeagueShape>;
  teams(): Promise<LeagueTeam[]>;
  myTeam(): Promise<LeagueTeam>;
  freeAgents(limit?: number): Promise<FreeAgent[]>;
  close(): Promise<void>;

  /**
   * OPTIONAL capability: the completed draft, with prices for an auction.
   *
   * Optional because not every platform exposes draft history, and a snake league has no bid
   * amounts to report. A consumer must check for the method and say so plainly when it is absent,
   * rather than a caller reaching around the interface to the platform API -- which is how the
   * adaptor boundary erodes. `price` is 0 where the format has no auction.
   */
  draftPicks?(): Promise<DraftPick[]>;

  /** OPTIONAL capability: how players are acquired in-season. Normalized, because platforms model
   *  FAAB, waiver order and free-for-all differently and a consumer should not have to care. */
  acquisitionRules?(): Promise<AcquisitionRules>;
}

export interface DraftPick {
  teamId: string;
  name: string;
  pos: string;
  price: number;
}

/**
 * The rules that decide whether you claim tonight or race at the free-agent open. Normalized so a
 * consumer reads intent rather than a platform's flag soup: `faabBudget === null` means the league
 * uses waiver ORDER, not bidding, whatever the platform calls it.
 */
export interface AcquisitionRules {
  waivers: boolean;             // false = free agency is first-come, first-served
  faabBudget: number | null;    // null = waiver order rather than a bidding budget
  processDays: string[];
  processHour: number | null;   // league timezone
  seasonLimit: number | null;   // null = unlimited
  weeklyLimit: number | null;   // null = unlimited
}
