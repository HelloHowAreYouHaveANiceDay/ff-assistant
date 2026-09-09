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
 * HOW THE PLAYOFF FIELD IS SEEDED.
 *
 *   "record"                    wins, then the tiebreak, across the whole league. What this repo has
 *                               always done, and what a single-division league means.
 *   "division-winners-first"    each division's best team takes a top seed (ordered among themselves
 *                               by record), and everyone else fills the remaining seeds by record.
 *                               The NFL's rule, and ESPN's documented behaviour when a league has
 *                               divisions -- a division winner is GUARANTEED a seed even with a
 *                               worse record than a team left out.
 *
 * The two coincide exactly whenever the division winners happen to be the best D teams outright,
 * which is why a season can agree with both and prove neither.
 */
export type SeedingRule = "record" | "division-winners-first";

/** One division and the teams in it, by the platform's team ids. */
export interface LeagueDivision { id: string; name: string; teamIds: string[] }

/**
 * THE LEAGUE'S CALENDAR AND PLAYOFF FORMAT, as a FACT WITH A SOURCE.
 *
 * Every field here used to be a default sitting in code (`regWeeks ?? 14`, `playoffTeams ?? 7`,
 * "seed by record"), and every one of them was right for this league by coincidence. A default that
 * is right is indistinguishable from a value that was read, which is the whole problem: nothing
 * fails, nothing warns, and the first season the league changes its calendar every downstream number
 * is quietly computed for a league that does not exist.
 *
 * `source` is not decoration. The owner can legitimately overrule ESPN -- ESPN's stored settings
 * describe how ESPN will run the bracket, and a league that has agreed among itself to end the
 * regular season a week earlier is not a bug in anything. So both blocks are kept, both are printed,
 * and exactly one is in force.
 */
export interface LeagueFormat {
  /** Last week of the fantasy regular season. */
  regWeeks: number;
  /** Size of the playoff field. */
  playoffTeams: number;
  /** NFL weeks per playoff ROUND (ESPN's playoffMatchupPeriodLength). 1 = one week per round. */
  playoffRoundWeeks: number;
  /** The actual bracket weeks, e.g. [15,16,17]. Explicit, not re-derived by each consumer. */
  playoffWeeks: number[];
  seeding: SeedingRule;
  /**
   * Does the bracket RE-SEED between rounds? (ESPN's `playoffReseed`.)
   *
   * true  -- after each round the highest remaining seed plays the lowest remaining seed.
   * false -- a fixed bracket: the round-1 pairings determine who can meet whom, so the 2 seed
   *          cannot meet the 1 seed before the final even if the 1 seed's half is wiped out.
   *
   * It is stored rather than assumed because the two differ in who wins the title, and the repo
   * simulated a fixed bracket for its whole life while this league reseeds.
   */
  playoffReseed: boolean;
  /** The tiebreak between equal records, in the platform's own vocabulary. */
  tiebreak: string;
  divisions: LeagueDivision[];
  source: "espn" | "owner-override";
  /** LOCAL date-time the block was written, so a stale block is visible rather than plausible. */
  fetchedAt: string;
  /** Present on an owner override: what ESPN said at the time, for the diff `ff format show` prints. */
  note?: string;
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

  /** OPTIONAL capability: the head-to-head schedule and division layout. */
  matchups?(season?: number): Promise<LeagueSchedule>;

  /** OPTIONAL capability: past seasons of this same league -- format changes and draft history.
   *  Takes the whole list so an adaptor can batch per-season lookups it would otherwise repeat. */
  history?(seasons: number[]): Promise<SeasonSnapshot[]>;
}

/** The fantasy head-to-head schedule, with divisions, for fairness and playoff-path analysis. */
export interface LeagueSchedule {
  divisions: { id: string; name: string; teamIds: string[] }[];
  games: { week: number; homeId: string; awayId: string }[];
}

export interface DraftPick {
  teamId: string;
  name: string;
  pos: string;
  price: number;
  /** The human, not the team slot. Team names change yearly; owner identity is what persists, and
   *  it is the only key a multi-season manager profile can legitimately be built on. */
  ownerId?: string;
  owner?: string;
}

/**
 * One PAST season of this league -- enough to answer "did the format change?" and "how has each
 * manager drafted historically?".
 *
 * `available: false` rather than a throw is a DELIBERATE exception to the adaptor's throw-on-empty
 * rule. An empty current-season read means something broke. A missing 2019 means the league did not
 * exist yet, or this owner had no access -- an ordinary fact about the past, not a failure, and a
 * history sweep must be able to report it per-season and carry on.
 */
export interface SeasonSnapshot {
  season: number;
  available: boolean;
  note?: string;
  size: number | null;
  auctionBudget: number | null;
  /** Points per reception. The single most format-defining number: a league moving 0 -> 0.5 makes
   *  every prior year's pass-catcher spend an understatement of what the room will now pay. */
  pprPoints: number | null;
  slotCounts: Record<string, number>;
  /**
   * THE SEASON'S OWN CALENDAR AND PLAYOFF FORMAT, from that season's `scheduleSettings`.
   *
   * The format is not a property of the league, it is a property of the SEASON: this room played 13
   * weeks with a 6-team field and one division through 2020, then 14 weeks, then grew to 16 teams
   * and four divisions in 2025 and back to 13 weeks in 2026. Any historical scorer that assumes one
   * format is measuring a league that never existed, quietly and with plausible numbers.
   *
   * `null` when the season is unavailable or ESPN returned no scheduleSettings -- never defaulted.
   */
  format: {
    regWeeks: number;
    playoffTeams: number;
    playoffRoundWeeks: number;
    playoffReseed: boolean;
    /** Our seeding vocabulary: "record" with one division, "division-winners-first" with more. */
    seedingRule: SeedingRule;
    /** ESPN's own tiebreak name, e.g. TOTAL_POINTS_SCORED. */
    tiebreak: string;
    divisionCount: number;
  } | null;
  teams: SeasonTeam[];
  picks: DraftPick[];
}

/**
 * One team's season: who owned it, how they BEHAVED in-season, and how they finished.
 *
 * The behaviour fields are what make in-season tendencies possible at all. A draft recap says how
 * a manager values positions in August; it says nothing about whether they stream defenses, hoard
 * FAAB, or stop setting a lineup in November. Pairing activity with `finalRank` also answers the
 * only question that matters about a tendency: whether it is associated with winning IN THIS ROOM.
 */
export interface SeasonTeam {
  id: string;
  name: string;
  ownerId: string;
  owner: string;
  // in-season activity
  acquisitions: number;
  faabSpent: number;
  drops: number;
  trades: number;
  lineupMoves: number;                          // bench <-> starter changes; engagement proxy
  acquisitionsByWeek: Record<string, number>;   // when they were active
  // outcome
  wins: number;
  losses: number;
  pointsFor: number;
  /** Final PLACEMENT after playoffs -- a 9-5 champion outranks an 11-3 team here, so this cannot
   *  be used to ask how the league SEEDED anyone. */
  finalRank: number | null;
  /** Regular-season playoff SEED. This is the field that answers whether division winners get
   *  auto-bids: a seed above a team with a strictly better record means they do. */
  playoffSeed: number | null;
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
