/**
 * THE SLEEPER ADAPTOR -- the third platform, and the first that is PUBLIC, DYNASTY, and SUPERFLEX.
 *
 * It exists to serve "The Dy-nasty" (league 1353038434335195136, 10 teams, dynasty, SUPER_FLEX, no
 * kicker), and it is the first genuine exercise of the `Platform` contract by something that is not
 * ESPN or Yahoo. Two assumptions baked into that contract only became visible here, and both are
 * recorded at their site rather than worked around silently:
 *
 *   1. `PlatformIO` called itself "an AUTHENTICATED GET" and its doc said a plain Node fetch "gets a
 *      login page". Sleeper publishes every read this repo needs with NO credential at all. Fixed by
 *      `publicPlatformIO` in platform.ts -- a second provider that STATES the platform is public,
 *      rather than by weakening `cookiePlatformIO`, whose strictness about empty jars is load-bearing.
 *
 *   2. `discover(io, wantSeason)` assumes the IO carries our identity, because for ESPN and Yahoo the
 *      session IS the identity. With no session there is nothing to infer from, so Sleeper needs the
 *      username named explicitly. `sleeperUser()` reads it and REFUSES BY NAME when it is absent --
 *      it does not return an empty league list, because "you are in no leagues" and "you did not tell
 *      me who you are" must not produce the same answer.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED HERE. This adaptor is READ-ONLY: no `writes`, so `assertWritable`
 * refuses every write against Sleeper by name. Dynasty VALUATION is not attempted -- see
 * docs/multi-format-design.md "Wall 3". This file's job is to make a Sleeper league indistinguishable
 * from an ESPN one to the four readers downstream, nothing more.
 */
import type {
  DiscoveredLeague, LeagueSettings, Platform, PlatformIO, PlatformRoster, PlatformRosterWeekRow, SyncHints,
} from "./platform.js";
import type { AcquisitionRules, LeagueFormat, LeagueTeam } from "./types.js";
import type { ScoringRules, KickerRules, DefenseRules } from "../draft/scoring.js";
import { ESPN_SLOT_NAME } from "./espnSlots.js";
import { isBenchSlot } from "../draft/slots.js";
import { playoffRounds } from "./index.js";

export const SLEEPER_HOST = "api.sleeper.app";
const API = "https://api.sleeper.app/v1";
const WEB = "https://sleeper.com";

/**
 * SLEEPER PLAYER IDS ARE NAMESPACED before they reach `raw_league_roster_week.espn_player_id`.
 *
 * The contract requires it (see `PlatformRosterWeekRow.platformPlayerId`) and the reason is concrete:
 * Sleeper ids are short numeric strings like "4984", and so are ESPN's. Two platforms writing bare
 * integers into one column would collide, and a collision there attributes one league's player-week
 * to another league's player.
 */
export const SLEEPER_ID_PREFIX = "s:";
export const sleeperPlayerKey = (id: string): string => `${SLEEPER_ID_PREFIX}${id}`;

/**
 * SLEEPER'S ROSTER-POSITION TOKENS -> ESPN'S INTEGER SLOT IDS.
 *
 * ESPN's id space is the repo's lingua franca: `isStarterSlot`, `ESPN_SLOT_NAME` and
 * `startingTemplate` all read it, so emitting anything else produces an unfillable template. The one
 * that matters for this league is SUPER_FLEX -> 7 ("OP"), which is exactly the slot D24/D25.3 taught
 * `baselines()` and `starterBaselines` to fill from QB+RB+WR+TE. That work was built for Yahoo
 * 129048; this league is its second real case, and it needed no change to accept it.
 *
 * TAXI -> 21 (IR) IS AN APPROXIMATION AND IS FLAGGED AS ONE. Both mean "rostered, not startable, not
 * on the active bench", which is all any current consumer asks. It is wrong in the one place a taxi
 * squad differs from an IR slot -- eligibility to be activated -- and no consumer reads that today.
 * The Dy-nasty has `taxi_slots: 0`, so nothing in this session exercises it; a league with a taxi
 * squad should re-check this line before trusting a roster-size number.
 */
const SLOT_ID: Record<string, number> = {
  QB: 0, RB: 2, WR: 4, TE: 6,
  FLEX: 23,           // RB/WR/TE
  WRRB_FLEX: 3,       // RB/WR
  REC_FLEX: 5,        // WR/TE
  SUPER_FLEX: 7,      // QB/RB/WR/TE -- ESPN's "OP"
  K: 17, DEF: 16,
  BN: 20, IR: 21, TAXI: 21,
};

/** A Sleeper roster-position token -> our slot NAME, through the one ESPN map. */
export function sleeperSlotId(token: string): number {
  const id = SLOT_ID[String(token).toUpperCase()];
  if (id === undefined) {
    throw new Error(
      `sleeper: unknown roster position "${token}". Known: ${Object.keys(SLOT_ID).join(", ")}. ` +
      "Refusing to guess -- an unrecognised slot silently becoming a bench seat would change the " +
      "starting template and every replacement level derived from it.",
    );
  }
  return id;
}
export const sleeperSlotName = (token: string): string => ESPN_SLOT_NAME[sleeperSlotId(token)] ?? token;

// -------------------------------------------------------------------------------------------------
// SCORING
// -------------------------------------------------------------------------------------------------

/** Sleeper's `scoring_settings`, as the API publishes it. Every value is a number. */
export type SleeperScoring = Record<string, number>;

/** Read a key that MUST be present, or refuse. A missing scoring key defaulted to 0 is a silent
 *  re-scoring of every player-week, which is the failure this repo keeps paying for. */
function req(sc: SleeperScoring, key: string, what: string): number {
  const v = sc[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`sleeper scoring: no "${key}" (${what}). Present keys: ${Object.keys(sc).sort().join(", ")}`);
  }
  return v;
}
/** Read a key that may genuinely be absent (a rule the league does not use). Absent == 0 is correct
 *  HERE and only here, because Sleeper omits a term it does not score. */
const opt = (sc: SleeperScoring, key: string): number => (typeof sc[key] === "number" && Number.isFinite(sc[key]) ? sc[key] : 0);

/**
 * OFFENSE. The twoPt term is read from all three of Sleeper's conversion keys and REFUSES if they
 * disagree, because `ScoringRules.twoPt` is a single number: a league that paid 2 for a passing
 * conversion and 1 for a rushing one cannot be expressed, and quietly picking one would mis-score
 * every week containing the other.
 */
export function sleeperScoringRules(sc: SleeperScoring): ScoringRules {
  const two = [opt(sc, "pass_2pt"), opt(sc, "rush_2pt"), opt(sc, "rec_2pt")];
  const distinct = [...new Set(two)];
  if (distinct.length > 1) {
    throw new Error(
      `sleeper scoring: two-point conversions are scored differently by type (pass=${two[0]}, rush=${two[1]}, rec=${two[2]}). ` +
      "ScoringRules.twoPt is one number, so this ruleset cannot be represented without extending it. Refusing rather than picking one.",
    );
  }
  return {
    passYd: req(sc, "pass_yd", "points per passing yard"),
    passTD: req(sc, "pass_td", "points per passing TD"),
    int: req(sc, "pass_int", "points per interception thrown"),
    rushYd: req(sc, "rush_yd", "points per rushing yard"),
    rushTD: req(sc, "rush_td", "points per rushing TD"),
    recYd: req(sc, "rec_yd", "points per receiving yard"),
    recTD: req(sc, "rec_td", "points per receiving TD"),
    rec: req(sc, "rec", "points per reception"),
    fumble: req(sc, "fum_lost", "points per fumble lost"),
    twoPt: distinct[0],
  };
}

/** KICKING. Sleeper splits 0-19/20-29/30-39 where we carry one 0-39 bucket; they must agree or the
 *  collapse is a lie. Sleeper has no 60+ bucket, so `fg60` takes the 50+ value, which is what the
 *  platform actually pays. */
export function sleeperKickerRules(sc: SleeperScoring): KickerRules {
  const short = [req(sc, "fgm_0_19", "FG 0-19"), req(sc, "fgm_20_29", "FG 20-29"), req(sc, "fgm_30_39", "FG 30-39")];
  if (new Set(short).size > 1) {
    throw new Error(
      `sleeper scoring: FG 0-39 is not one value (0-19=${short[0]}, 20-29=${short[1]}, 30-39=${short[2]}). ` +
      "KickerRules.fg0_39 is a single bucket and collapsing these would mis-score short kicks.",
    );
  }
  const fifty = req(sc, "fgm_50p", "FG 50+");
  return {
    fg0_39: short[0],
    fg40_49: req(sc, "fgm_40_49", "FG 40-49"),
    fg50_59: fifty,
    fg60: fifty,
    pat: req(sc, "xpm", "extra point made"),
    patMiss: opt(sc, "xpmiss"),
    fgMiss: opt(sc, "fgmiss"),
  };
}

/**
 * TEAM DEFENSE. The points-allowed ladder is built from Sleeper's seven `pts_allow_*` buckets into
 * the `[maxPointsAllowed, points]` ascending form `paLadder` wants, last bound `Infinity`.
 *
 * `passDefended` and `tacklesForLoss` are 0 because Sleeper does not score them for a team defence
 * in this ruleset -- 0 here is READ, not defaulted: `opt` returns 0 only where the platform omitted
 * the term, which for Sleeper means "not scored".
 */
export function sleeperDefenseRules(sc: SleeperScoring): DefenseRules {
  return {
    sack: req(sc, "sack", "points per sack"),
    interception: req(sc, "int", "points per defensive interception"),
    // Sleeper distinguishes the DEF/ST recovery from a generic one; the DST scorer wants the former.
    fumbleRec: opt(sc, "def_st_fum_rec") || opt(sc, "fum_rec"),
    forcedFumble: opt(sc, "def_st_ff") || opt(sc, "ff"),
    blockedKick: opt(sc, "blk_kick"),
    safety: opt(sc, "safe"),
    passDefended: opt(sc, "pass_def"),
    tacklesForLoss: opt(sc, "tkl_loss"),
    tflProviderScale: 1,
    // Sleeper splits the defensive score three ways -- `def_td` (defence), `def_st_td` and `st_td`
    // (special teams). `DefenseRules.td` is one number, so they must agree; The Dy-nasty pays 6 for
    // all three. Refusing on disagreement rather than picking `def_td` keeps a league that pays
    // differently for a pick-six and a kick return from being scored as though it did not.
    td: (() => {
      const tds = [opt(sc, "def_td"), opt(sc, "def_st_td"), opt(sc, "st_td")].filter((n) => n !== 0);
      const distinct = [...new Set(tds)];
      if (distinct.length > 1) {
        throw new Error(
          `sleeper scoring: defensive/special-teams TDs are scored differently (def_td=${opt(sc, "def_td")}, ` +
          `def_st_td=${opt(sc, "def_st_td")}, st_td=${opt(sc, "st_td")}). DefenseRules.td is one number.`,
        );
      }
      return distinct[0] ?? 0;
    })(),
    paLadder: [
      [0, req(sc, "pts_allow_0", "PA 0")],
      [6, req(sc, "pts_allow_1_6", "PA 1-6")],
      [13, req(sc, "pts_allow_7_13", "PA 7-13")],
      [20, req(sc, "pts_allow_14_20", "PA 14-20")],
      [27, req(sc, "pts_allow_21_27", "PA 21-27")],
      [34, req(sc, "pts_allow_28_34", "PA 28-34")],
      [Infinity, req(sc, "pts_allow_35p", "PA 35+")],
    ],
  };
}

/** Which consensus variant the board should use. The same three-way split ESPN and Yahoo resolve to. */
export function sleeperScoringBucket(sc: SleeperScoring): "STD" | "HALF" | "PPR" {
  const r = req(sc, "rec", "points per reception");
  return r >= 0.75 ? "PPR" : r > 0 ? "HALF" : "STD";
}

// -------------------------------------------------------------------------------------------------
// IDENTITY -- who we are, which Sleeper cannot infer
// -------------------------------------------------------------------------------------------------

/**
 * OUR SLEEPER USERNAME OR USER ID.
 *
 * ESPN and Yahoo learn this from the session; Sleeper has no session, so it must be told. `hints.swid`
 * is the contract's existing "our identity on this platform" channel -- named for ESPN's cookie, but
 * it is the only such field and inventing a parallel one would give the same fact two homes.
 *
 * The refusal is the point: with no username, `discover` would otherwise return `[]`, and "you are in
 * no leagues" is indistinguishable from "nobody told me who you are".
 */
export function sleeperUser(hints?: SyncHints): string {
  const who = (hints?.swid ?? process.env.FF_SLEEPER_USER ?? "").trim();
  if (!who) {
    throw new Error(
      "sleeper: no username. Sleeper's API is public and therefore anonymous -- it cannot infer whose " +
      "leagues to list. Set FF_SLEEPER_USER=<your sleeper username> (or pass hints.swid). " +
      "Refusing rather than reporting zero leagues, which would look like a successful read.",
    );
  }
  return who;
}

// -------------------------------------------------------------------------------------------------
// THE PLAYER INDEX -- Sleeper rosters carry ids, not names
// -------------------------------------------------------------------------------------------------

export interface SleeperPlayer { name: string; pos: string; team: string | null }

/**
 * Sleeper's global player map, projected down to the three fields any consumer here needs.
 *
 * THE FULL PAYLOAD IS ~14.6 MB OF 12,228 PLAYERS WITH 53 FIELDS EACH, and Sleeper's own docs ask
 * callers to fetch it at most once a day. So it is fetched through the injected `io` (which keeps it
 * testable against a fixture like every other read) and cached on the module for the process. It is
 * NOT written to `data/` -- a 14 MB blob that changes daily is not an artifact this repo should own,
 * and the read is free and unauthenticated, so re-fetching costs a second on a cold process.
 */
let PLAYER_CACHE: Map<string, SleeperPlayer> | null = null;

export function parseSleeperPlayers(json: string): Map<string, SleeperPlayer> {
  const raw = JSON.parse(json) as Record<string, { full_name?: string; first_name?: string; last_name?: string; position?: string; team?: string | null }>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("sleeper players: payload is not an id->player object");
  const out = new Map<string, SleeperPlayer>();
  for (const [id, p] of Object.entries(raw)) {
    const pos = String(p?.position ?? "").toUpperCase();
    if (!pos) continue;
    // A team DEFENCE has no personal name; Sleeper keys it by the team abbreviation ("MIN") and
    // leaves full_name null. Naming it "<TEAM> D/ST" is what every other surface in this repo calls
    // a defence, which is what makes `lineupNameKey` collapse it onto our own DST rows.
    const nm = (p?.full_name ?? [p?.first_name, p?.last_name].filter(Boolean).join(" ")).trim();
    const name = pos === "DEF" ? `${id} D/ST` : nm;
    if (!name) continue;
    out.set(id, { name, pos: pos === "DEF" ? "DST" : pos, team: (p?.team ?? null) || null });
  }
  if (out.size < 1000) throw new Error(`sleeper players: only ${out.size} usable players parsed -- refusing a payload this thin, which would silently blank most rosters`);
  return out;
}

export async function sleeperPlayers(io: PlatformIO, opts: { refresh?: boolean } = {}): Promise<Map<string, SleeperPlayer>> {
  if (PLAYER_CACHE && !opts.refresh) return PLAYER_CACHE;
  PLAYER_CACHE = parseSleeperPlayers(await io.get(`${API}/players/nfl`));
  return PLAYER_CACHE;
}

/** Test seam: drop the process cache so a fixture-driven test cannot inherit a live fetch. */
export function __resetSleeperPlayerCache(): void { PLAYER_CACHE = null; }

// -------------------------------------------------------------------------------------------------
// SHAPES OF THE API PAYLOADS WE READ
// -------------------------------------------------------------------------------------------------

interface SleeperLeague {
  league_id: string; name: string; season: string; status: string;
  total_rosters: number; roster_positions: string[]; previous_league_id: string | null;
  scoring_settings: SleeperScoring;
  settings: Record<string, number>;
}
interface SleeperRoster {
  roster_id: number; owner_id: string | null; players: string[] | null;
  starters: string[] | null; reserve: string[] | null; taxi: string[] | null;
}
interface SleeperUser { user_id: string; display_name: string; metadata?: { team_name?: string } | null }
interface SleeperMatchup {
  roster_id: number; starters: string[] | null; players: string[] | null;
  players_points?: Record<string, number> | null;
}

const j = <T>(s: string, what: string): T => {
  const v = JSON.parse(s) as T;
  if (v === null || v === undefined) throw new Error(`sleeper: ${what} returned null -- that is "no such object", not an empty one.`);
  return v;
};

/** The league's STARTING slot tokens, in the order Sleeper aligns `starters` to. */
export const startingTokens = (rosterPositions: string[]): string[] => rosterPositions.filter((t) => t !== "BN" && t !== "TAXI");

// -------------------------------------------------------------------------------------------------
// THE ADAPTOR
// -------------------------------------------------------------------------------------------------

export const sleeperPlatform: Platform = {
  id: "sleeper",
  host: SLEEPER_HOST,
  // No `webview`: Sleeper never runs in an Electron guest here, because it needs no login to read.
  // Absence is the statement -- see Platform.webview.
  // No `writes`: this adaptor is read-only, so every write refuses by name.

  urls: {
    home: WEB,
    league: (leagueId) => `${WEB}/leagues/${leagueId}`,
    team: (leagueId) => `${WEB}/leagues/${leagueId}/team`,
    scoreboard: (leagueId) => `${WEB}/leagues/${leagueId}/matchup`,
    standings: (leagueId) => `${WEB}/leagues/${leagueId}/standings`,
    draftRoom: (leagueId) => `${WEB}/leagues/${leagueId}/draft`,
  },

  /**
   * THE LEAGUES THIS USER IS IN, for `wantSeason`.
   *
   * `teamId` is our ROSTER ID in that league, resolved by matching our user_id against each roster's
   * owner. It is not left null: blanking our seat breaks every verb that needs it and still looks
   * like a successful sync (the same trap Yahoo's `discover` documents).
   */
  async discover(io, wantSeason): Promise<DiscoveredLeague[]> {
    const who = sleeperUser();
    const user = j<{ user_id?: string } | null>(await io.get(`${API}/user/${encodeURIComponent(who)}`), `user "${who}"`);
    const uid = user?.user_id;
    if (!uid) throw new Error(`sleeper: no such user "${who}".`);
    const leagues = j<SleeperLeague[]>(await io.get(`${API}/user/${uid}/leagues/nfl/${wantSeason}`), `leagues for ${who} in ${wantSeason}`);
    const out: DiscoveredLeague[] = [];
    for (const l of leagues) {
      let teamId: string | null = null;
      try {
        const rosters = j<SleeperRoster[]>(await io.get(`${API}/league/${l.league_id}/rosters`), `rosters of ${l.league_id}`);
        teamId = rosters.find((r) => r.owner_id === uid)?.roster_id?.toString() ?? null;
      } catch { teamId = null; }
      out.push({ leagueId: l.league_id, season: Number(l.season) || wantSeason, teamId, name: l.name ?? null });
    }
    return out;
  },

  /**
   * THE LEAGUE'S RULES.
   *
   * `kicker` IS NULL FOR THIS LEAGUE AND THAT IS THE CONTRACT WORKING. The Dy-nasty rosters a DEF but
   * no K, and `LeagueSettings` says in so many words that a league which rosters neither gets null
   * rather than another league's constants. Sleeper still PUBLISHES kicking values (`fgm_*`, `xpm`) --
   * they are simply unreachable, because no slot can hold a kicker. Reading them anyway would look
   * configured and score 27 seasons of kickers under rules this league does not have.
   *
   * `playoffReseed` IS NOT PUBLISHED BY SLEEPER. Its 44 settings keys carry no reseed flag. The repo's
   * own rule is that this must be stored rather than assumed "because the two differ in who wins the
   * title", and the type is a boolean, so the assumption is made EXPLICIT in `rosterSettings` where an
   * auditor will see it, rather than buried as a silent `false`.
   */
  async syncSettings(io, leagueId, season, hints): Promise<LeagueSettings> {
    void hints;
    const l = j<SleeperLeague>(await io.get(`${API}/league/${leagueId}`), `league ${leagueId}`);
    const st = l.settings ?? {};
    const sc = l.scoring_settings ?? {};
    const slots = (l.roster_positions ?? []).map(sleeperSlotName);
    if (!slots.length) throw new Error(`sleeper: league ${leagueId} published no roster_positions -- refusing an empty slot template.`);

    const hasK = slots.includes("K");
    const hasDst = slots.includes("DST");
    const playoffTeams = st.playoff_teams ?? 0;
    const startWeek = st.playoff_week_start ?? 0;
    if (!playoffTeams || !startWeek) throw new Error(`sleeper: league ${leagueId} published no playoff_teams/playoff_week_start -- the calendar would be a guess.`);
    const rounds = playoffRounds(playoffTeams);
    const format: LeagueFormat = {
      regWeeks: startWeek - 1,
      playoffTeams,
      playoffRoundWeeks: 1,   // playoff_round_type 0 == one week per round
      playoffWeeks: Array.from({ length: rounds }, (_, i) => startWeek + i),
      seeding: "record",
      playoffReseed: false,
      tiebreak: "sleeper-default",
      divisions: [],
      // "owner-override", NOT "sleeper", and deliberately -- src/league/yahoo.ts:283 records the
      // convention: `source` is the two-valued fact "did THIS REPO'S platform sync write it, or did a
      // person?", where the sync value is "espn". A block read from an API this repo added is an
      // override in that sense, and `note` carries the real provenance. Following the precedent
      // rather than widening a union a documented decision chose to keep narrow. It also means
      // `ff format set`'s guard (ff.ts:4563) will not silently clobber this block.
      source: "owner-override",
      fetchedAt: new Date().toISOString(),
      note: `read from ${API}/league/${leagueId} (Sleeper public API) at ${new Date().toISOString()}`,
    };
    const acquisition: AcquisitionRules = {
      waivers: (st.waiver_type ?? 0) !== 0,
      faabBudget: st.waiver_budget ?? null,
      processDays: st.waiver_day_of_week === undefined ? [] : [["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][st.waiver_day_of_week] ?? String(st.waiver_day_of_week)],
      processHour: null,
      seasonLimit: null,
      weeklyLimit: null,
    };

    let teamId: string | null = null;
    try {
      const who = sleeperUser(hints);
      const u = j<{ user_id?: string } | null>(await io.get(`${API}/user/${encodeURIComponent(who)}`), `user "${who}"`);
      if (u?.user_id) {
        const rosters = j<SleeperRoster[]>(await io.get(`${API}/league/${leagueId}/rosters`), `rosters of ${leagueId}`);
        teamId = rosters.find((r) => r.owner_id === u.user_id)?.roster_id?.toString() ?? null;
      }
    } catch { teamId = null; }   // "cannot tell" -- the caller KEEPS what the store holds (see LeagueSettings.teamId)

    const DYNASTY = { 0: "redraft", 1: "keeper", 2: "dynasty" } as Record<number, string>;
    return {
      leagueId: String(l.league_id ?? leagueId),
      platform: "sleeper",
      season: Number(l.season) || season,
      name: l.name ?? null,
      teams: l.total_rosters ?? st.num_teams ?? 0,
      slots,
      // Sleeper dynasty startups and rookie drafts are both SNAKE. There is no auction here, so
      // `budget` is null -- the field means auction dollars, and a FAAB budget is not that.
      draftType: "snake",
      budget: null,
      scoring: sleeperScoringRules(sc),
      scoringBucket: sleeperScoringBucket(sc),
      kicker: hasK ? sleeperKickerRules(sc) : null,
      defense: hasDst ? sleeperDefenseRules(sc) : null,
      format,
      teamId,
      acquisition,
      // Sleeper publishes this as a first-class flag, which is what made the key hazard real rather
      // than hypothetical -- so it is carried as a first-class field, not just as provenance below.
      leagueType: (DYNASTY[st.type ?? 0] ?? null) as "redraft" | "keeper" | "dynasty" | null,
      rosterSettings: {
        league_type: `${st.type ?? 0} (${DYNASTY[st.type ?? 0] ?? "unknown"})`,
        roster_positions: (l.roster_positions ?? []).join(" "),
        taxi_slots: String(st.taxi_slots ?? 0),
        reserve_slots: String(st.reserve_slots ?? 0),
        draft_rounds: String(st.draft_rounds ?? 0),
        previous_league_id: String(l.previous_league_id ?? ""),
        best_ball: String(st.best_ball ?? 0),
        kicker_slot: hasK ? "yes" : "NO -- kicker scoring is published by Sleeper but UNREACHABLE, so kicker rules are null",
        playoff_reseed: "NOT PUBLISHED BY SLEEPER -- assumed false (fixed bracket). Verify before trusting a title number.",
      },
      provenance: `sleeper api ${API}/league/${leagueId} (public, unauthenticated) at ${new Date().toISOString()}`,
    };
  },

  /** Every team's roster, with each man's slot taken from his index in `starters`. */
  async syncRosters(io, leagueId): Promise<PlatformRoster[]> {
    const l = j<SleeperLeague>(await io.get(`${API}/league/${leagueId}`), `league ${leagueId}`);
    const rosters = j<SleeperRoster[]>(await io.get(`${API}/league/${leagueId}/rosters`), `rosters of ${leagueId}`);
    const users = j<SleeperUser[]>(await io.get(`${API}/league/${leagueId}/users`), `users of ${leagueId}`);
    const players = await sleeperPlayers(io);
    const byUser = new Map(users.map((u) => [u.user_id, u]));
    const tokens = startingTokens(l.roster_positions ?? []);

    return rosters.map((r) => {
      const u = r.owner_id ? byUser.get(r.owner_id) : undefined;
      const starters = r.starters ?? [];
      const reserve = new Set(r.reserve ?? []);
      const taxi = new Set(r.taxi ?? []);
      const startedAt = new Map<string, string>();
      starters.forEach((pid, i) => { if (pid && pid !== "0") startedAt.set(pid, tokens[i] ?? "FLEX"); });

      const seen = new Set<string>();
      const out: PlatformRoster["players"] = [];
      for (const pid of r.players ?? []) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        const p = players.get(pid);
        if (!p) continue;   // an id the global map does not carry; dropping is visible as a short roster
        const token = startedAt.get(pid) ?? (reserve.has(pid) ? "IR" : taxi.has(pid) ? "TAXI" : "BN");
        out.push({ name: p.name, pos: p.pos, slot: sleeperSlotName(token), team: p.team ?? undefined });
      }
      return {
        teamId: String(r.roster_id),
        teamName: u?.metadata?.team_name?.trim() || u?.display_name || `Roster ${r.roster_id}`,
        owner: u?.display_name ?? null,
        abbrev: null,
        players: out,
      };
    });
  },

  /**
   * EVERY TEAM'S WEEK-N LINEUP AND THAT WEEK'S ACTUAL POINTS -- the D18 seed's input.
   *
   * ONE FETCH FOR THE WHOLE WEEK. `/matchups/<week>` returns every roster's `starters` (positionally
   * aligned to the league's starting slots), `players`, and `players_points`. That is strictly better
   * than the Yahoo path's fetch-per-team, and it is week-aware for real -- unlike the ESPN
   * `leagueHistory + mRoster` trap where four different weeks returned byte-identical starters.
   *
   * `appliedPoints` is null, never 0, for a man the week has no entry for. A zero week is a real and
   * common result and must not be manufactured.
   */
  async rosterWeek(io, leagueId, season, week): Promise<PlatformRosterWeekRow[]> {
    void season;
    const l = j<SleeperLeague>(await io.get(`${API}/league/${leagueId}`), `league ${leagueId}`);
    const ms = j<SleeperMatchup[]>(await io.get(`${API}/league/${leagueId}/matchups/${week}`), `matchups week ${week} of ${leagueId}`);
    if (!ms.length) throw new Error(`sleeper rosterWeek: league ${leagueId} week ${week} returned no matchups -- refusing to report an empty week.`);
    const players = await sleeperPlayers(io);
    const tokens = startingTokens(l.roster_positions ?? []);
    const out: PlatformRosterWeekRow[] = [];

    for (const m of ms) {
      const starters = m.starters ?? [];
      const pts = m.players_points ?? {};
      const startedAt = new Map<string, string>();
      starters.forEach((pid, i) => { if (pid && pid !== "0") startedAt.set(pid, tokens[i] ?? "FLEX"); });
      const seen = new Set<string>();
      for (const pid of m.players ?? []) {
        if (!pid || pid === "0" || seen.has(pid)) continue;
        seen.add(pid);
        const p = players.get(pid);
        if (!p) continue;
        const token = startedAt.get(pid) ?? "BN";
        const slotId = sleeperSlotId(token);
        out.push({
          teamId: String(m.roster_id),
          platformPlayerId: sleeperPlayerKey(pid),
          name: p.name,
          position: p.pos,
          lineupSlotId: slotId,
          // The bench test is src/draft/slots.ts's, not a literal -- same reason the Yahoo adaptor
          // gives: it cannot drift away from the definition every other consumer uses.
          isStarter: !isBenchSlot(ESPN_SLOT_NAME[slotId] ?? String(slotId)),
          appliedPoints: Object.prototype.hasOwnProperty.call(pts, pid) ? pts[pid] : null,
          proTeam: p.team ?? null,
        });
      }
    }
    return out;
  },

  async readTeam(io, leagueId, season, teamId): Promise<LeagueTeam> {
    const rosters = await this.syncRosters(io, leagueId, season);
    const t = rosters.find((r) => r.teamId === String(teamId));
    if (!t) throw new Error(`sleeper readTeam: league ${leagueId} has no roster ${teamId} (has ${rosters.map((r) => r.teamId).join(", ")})`);
    return { id: t.teamId, name: t.teamName, mine: true, roster: t.players.map((p) => ({ name: p.name, pos: p.pos, proj: 0, team: p.team })) };
  },
};
