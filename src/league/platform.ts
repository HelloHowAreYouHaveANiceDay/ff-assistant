/**
 * THE PLATFORM SEAM -- the SYNC/DISCOVER/URL half of a fantasy provider, beside the read-side
 * `LeagueProvider` in ./types.ts.
 *
 * WHY IT EXISTS (P-1/P-5 of docs/architecture-review-2026-09-16.md). `LeagueProvider` answers "who is
 * on which roster" for a league that is ALREADY in the store. Everything that puts it there -- finding
 * the leagues, reading their settings, building their URLs, knowing which webview holds their login --
 * had no seam at all: `discover_leagues` hardcoded `platform: 'espn'`, `league_sync`/`read_league`/
 * `sync-rosters` built ESPN URLs for whatever league id they resolved, and the renderer's page tabs
 * built `fantasy.espn.com/...?leagueId=<any id>` for a Yahoo league. None of those FAILED on a Yahoo
 * league; they produced ESPN-shaped answers about a league that is not on ESPN.
 *
 * So the rule this file exists to enforce: EVERY per-platform fact has exactly one home, and asking
 * for a platform that has no adaptor REFUSES BY NAME rather than falling back to ESPN.
 *
 * IO IS INJECTED. An adaptor never opens a browser or a database. It is handed a `PlatformIO` -- one
 * authenticated GET against that platform's own logged-in webview -- and returns plain data. That is
 * what makes every parser in an adaptor testable against a saved fixture (test/yahoo-settings.test.ts)
 * rather than only against the live site, and it is why `syncSettings` can be the SAME code that
 * produced the stored config rather than a note describing how someone once produced it by hand.
 */
import type { ScoringRules, KickerRules, DefenseRules } from "../draft/scoring.js";
import type { AcquisitionRules, LeagueFormat, LeagueTeam } from "./types.js";

/** The platforms this repo has (or refuses) an adaptor for. Same vocabulary as `league.platform`. */
export type PlatformId = "espn" | "yahoo";

/** Which embedded webview holds this platform's login. The app mounts one per platform, each on its
 *  own persistent partition, so both stay signed in at once (app/renderer/index.html). `host` is the
 *  string the app bridge resolves a guest by -- see `guestWebContents({host})` in app/main.js. */
/**
 * ELECTRON PRESENTATION ONLY. `elementId` and `partition` are `<webview>` concepts and mean nothing
 * outside the desktop app, which is why `host` no longer lives here: the host is a PLATFORM FACT
 * needed to choose a session, and reaching it through an Electron-shaped struct is what made two
 * transport call sites read `plat.webview.host` to configure something that is not a webview.
 */
export interface WebviewSpec { elementId: string; partition: string }

/** Where a league's pages live. One builder per page the app's tabs offer, so the renderer never
 *  concatenates a platform's URL itself (P-4: it did, for every league, always ESPN-shaped). */
export interface PlatformUrls {
  home: string;
  league(leagueId: string, season: number): string;
  team(leagueId: string, season: number, teamId: string | null): string;
  scoreboard(leagueId: string, season: number, week?: number | null): string;
  standings(leagueId: string, season: number): string;
  draftRoom(leagueId: string, season: number, teamId: string | null): string;
}

/** A league found by browsing the platform's own "my leagues" surface. */
export interface DiscoveredLeague {
  leagueId: string;
  season: number | null;
  teamId: string | null;
  name: string | null;
}

/**
 * EVERYTHING A SYNC LEARNS ABOUT A LEAGUE'S RULES, in OUR vocabulary.
 *
 * `kicker`/`defense` are `null` -- not "the defaults" -- for a league that rosters neither. A league
 * with no K and no D/ST slot has no kicking or defensive scoring to read, and substituting another
 * league's constants there is the exact shape of the bug this whole review is about: it looks
 * configured, nothing fails, and a downstream consumer scores 27 seasons of kickers under rules the
 * league does not have. `budget` is `null` for a draft that has no dollars.
 */
export interface LeagueSettings {
  leagueId: string;
  platform: PlatformId;
  season: number;
  name: string | null;
  teams: number;
  slots: string[];
  draftType: "auction" | "snake";
  budget: number | null;
  scoring: ScoringRules;
  /** The consensus BUCKET the board's ADP/ECR variant is selected by ("STD" | "HALF" | "PPR"). */
  scoringBucket: "STD" | "HALF" | "PPR";
  kicker: KickerRules | null;
  defense: DefenseRules | null;
  format: LeagueFormat;
  /**
   * OUR TEAM in this league, when the adaptor can identify it from the same read (ESPN matches the
   * logged-in SWID against each team's owners). `null` = "this read cannot tell", which is NOT the
   * same as "we have no team": the caller must then KEEP whatever the store already knows rather than
   * blanking `league.team_id`, because a sync that quietly forgets our seat breaks every verb that
   * needs it and looks like a successful sync.
   */
  teamId: string | null;
  acquisition: AcquisitionRules;
  /** The platform's OWN settings table, verbatim, as label -> value. Provenance, not a consumer
   *  surface: it is what makes a stored config auditable against the page it was read from. */
  rosterSettings: Record<string, string>;
  /** One line naming the page(s) this was read from and when. Written into the config. */
  provenance: string;
}

/**
 * One roster as a sync reads it, before OUR valuation is attached.
 *
 * `owner` and `abbrev` are what the OWNERSHIP overlay stores beside the player (`ff sync-rosters`):
 * the manager's display name and the team's short tag. They are optional because not every platform
 * publishes both on the roster read -- a platform that does not gets `null`, and the ownership writer
 * falls back to the team NAME rather than inventing a manager. They live here rather than in a second
 * per-platform roster read because the ownership sync used to be an ESPN-only body inside ff.ts, which
 * is exactly how a Yahoo league ends up with ESPN-shaped rows (P-1).
 */
export interface PlatformRoster {
  teamId: string;
  teamName: string;
  owner?: string | null;
  abbrev?: string | null;
  players: { name: string; pos: string; slot: string; team?: string }[];
}

/**
 * ONE WEEK'S ROSTER FOR ONE TEAM, IN THE SHAPE `raw_league_roster_week` STORES (WP9).
 *
 * Deliberately the raw table's vocabulary rather than a prettier one, because the whole point is that
 * a Yahoo row and an ESPN row are INDISTINGUISHABLE to the four readers downstream:
 *
 *   `platformPlayerId`  the PLATFORM's own player id, as it will be stored in the column named
 *                       `espn_player_id`. A non-ESPN adaptor MUST namespace it -- see YAHOO_ID_PREFIX.
 *   `lineupSlotId`      ESPN's INTEGER slot encoding (20 bench, 21 IR, 23 flex, 7 superflex). Not a
 *                       stylistic choice: `isStarterSlot`, `SLOT_NAME` and `startingTemplate` all
 *                       read it as that, so any other id space produces an unfillable template.
 *   `appliedPoints`     the week's ACTUAL points, or null where the platform does not publish them.
 *                       Never 0 for "unknown": a zero week is a real and common result.
 */
export interface PlatformRosterWeekRow {
  teamId: string;
  platformPlayerId: string;
  name: string;
  position: string;
  lineupSlotId: number;
  isStarter: boolean;
  appliedPoints: number | null;
  /** The NFL team he played for that week, where the platform publishes it -- `raw_league_roster_week.
   *  pro_team`. It is IDENTITY: an adaptor with no player cross-reference in this store resolves by
   *  name + position, which is exactly where a generational suffix collapses a son onto his father. */
  proTeam?: string | null;
}

/**
 * The ONE capability an adaptor needs from the outside world: an authenticated GET, executed inside
 * the webview that holds this platform's login, returning the response body as text.
 *
 * Deliberately not `fetch`. The point is that the request runs in the guest, same-origin and
 * credentialed; a plain Node fetch gets a login page. `host` tells the bridge WHICH guest.
 */
export interface PlatformIO {
  get(url: string, headers?: Record<string, string>): Promise<string>;
}

/**
 * The DEFAULT IO: one authenticated GET inside the app guest that holds `host`'s login.
 *
 * One spelling, so `league_sync` (agent.ts), `ff sync-rosters` and any future sync verb cannot end up
 * with three slightly different transports -- which is how the roster sync came to hold its own
 * Playwright/CDP body while `league_sync` went through the bridge.
 */
export function bridgePlatformIO(host: string, timeoutMs = 25000): PlatformIO {
  return { get: async (url, headers) => (await import("../browser/appBridge.js")).bridgeFetch(url, headers, timeoutMs, { host }) };
}

/**
 * A SESSION PROVIDER THAT IS NOT THE ELECTRON APP.
 *
 * `PlatformIO` was always the right contract -- "GET this URL with the user's session, return the
 * body" -- but `bridgePlatformIO` was its only implementation, so in practice the repo assumed the
 * login lived in the desktop app's webview and that a caller could speak its bridge protocol. An
 * agent whose login lives in a server-side browser can do neither, and had no first-class way in.
 *
 * This is that way in: the caller supplies the COOKIES and the transport is a plain fetch. Anything
 * that can produce a valid cookie header for the host -- a headless browser, a saved session, a
 * curl-style export -- is now a provider on equal footing with the app.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE. No cookie is read from a browser profile, no login is
 * automated and nothing is persisted: the cookie arrives from the caller and lives for the process.
 * A credential this module fetched for itself is a credential nobody decided to share.
 */
export function cookiePlatformIO(cookie: string, opts: { timeoutMs?: number; userAgent?: string } = {}): PlatformIO {
  const jar = cookie.trim();
  if (!jar) throw new Error("cookiePlatformIO: empty cookie. A session provider with no session is a 401 waiting to be misread as an empty league.");
  const timeoutMs = opts.timeoutMs ?? 25000;
  return {
    async get(url, headers) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          signal: ctl.signal,
          headers: {
            cookie: jar,
            accept: "application/json, text/plain, */*",
            ...(opts.userAgent ? { "user-agent": opts.userAgent } : {}),
            ...(headers ?? {}),
          },
        });
        const body = await res.text();
        // A 401/403 that returns a body is the trap: ESPN answers an expired session with valid JSON
        // that simply has no teams in it, which reads downstream as "the league is empty" rather
        // than "you are logged out". The status is checked HERE so it cannot be lost.
        if (!res.ok) {
          throw new Error(`${res.status} ${res.statusText} for ${url.slice(0, 120)} -- ` +
            (res.status === 401 || res.status === 403
              ? "the session is not authenticated. Refresh the cookie; do NOT treat this as an empty league."
              : `body starts: ${body.slice(0, 160)}`));
        }
        return body;
      } finally { clearTimeout(t); }
    },
  };
}

/**
 * A PROVIDER THAT READS FROM DISK, for the file-handoff loop.
 *
 * A browser task saves the API JSON into the workspace; this serves it back to the same pure parsers
 * the live path uses, so the identity and hollow-payload guards run exactly as designed instead of
 * being bypassed by a hand-summarised payload. `files` maps a substring of the URL (in practice the
 * `view=` token) to the file holding that view's response.
 *
 * It REFUSES an unmatched URL rather than returning empty. "No file for this view" and "the league
 * has no data" must not produce the same result -- that is the whole failure mode this repo keeps
 * paying for.
 */
export function filePlatformIO(files: Record<string, string>): PlatformIO {
  return {
    async get(url) {
      const hit = Object.entries(files).find(([token]) => url.includes(token));
      if (!hit) {
        throw new Error(`filePlatformIO: no saved payload matches ${url.slice(0, 160)}. ` +
          `Known tokens: ${Object.keys(files).join(", ") || "(none)"}. Refusing rather than returning an empty body.`);
      }
      const { readFileSync } = await import("node:fs");
      return readFileSync(hit[1], "utf8");
    },
  };
}

/** What the CALLER knows and the platform's own pages do not publish. See `Platform.syncSettings`. */
export interface SyncHints {
  /** Our identity on the platform (ESPN's SWID cookie), so the sync can name OUR team. */
  swid?: string | null;
  /** What the store holds today, for fields a platform genuinely does not publish. */
  prevBudget?: number;
  prevTeams?: number;
}

export interface Platform {
  readonly id: PlatformId;
  readonly urls: PlatformUrls;
  /** The session host -- whose login a request to this platform needs. A platform fact, not a
   *  rendering detail, so it is readable without knowing anything about Electron. */
  readonly host: string;
  /** How the desktop app embeds this platform, where it does. OPTIONAL: a platform that never runs
   *  in Electron is legal and says so by absence rather than inventing an element id. */
  readonly webview?: WebviewSpec;
  /** The leagues this login can see. */
  discover(io: PlatformIO, wantSeason: number): Promise<DiscoveredLeague[]>;
  /**
   * The league's rules, in our vocabulary. THROWS on anything it cannot read -- never defaults.
   *
   * `hints` carries the two things only the CALLER can know: who we are on this platform (`swid` for
   * ESPN), and the values the store already holds for fields the platform does not publish (a
   * non-auction league has no `auctionBudget`). They are hints, never substitutes: an adaptor that
   * cannot read a field still throws rather than reaching for `prevX`.
   */
  syncSettings(io: PlatformIO, leagueId: string, season: number, hints?: SyncHints): Promise<LeagueSettings>;
  /** Every team's roster. */
  syncRosters(io: PlatformIO, leagueId: string, season: number): Promise<PlatformRoster[]>;
  /** ONE team, as the platform-agnostic type. `proj` is 0 -- valuation is attached by openLeague. */
  readTeam(io: PlatformIO, leagueId: string, season: number, teamId: string): Promise<LeagueTeam>;

  /**
   * OPTIONAL CAPABILITY: every team's roster AS IT STOOD in week `week`, with that week's points.
   *
   * Optional because not every platform publishes a historical week's lineup, and an adaptor without
   * it must be refused BY NAME by the caller rather than fall back to "the current roster wearing a
   * week number" -- which is precisely the ESPN `leagueHistory + mRoster` trap documented at the top
   * of src/data/leagueRosters.ts, where four different weeks returned byte-identical starters.
   *
   * ESPN does not implement this: its roster-week history comes from a JSON boxscore view with its
   * own cache, and routing it through here would be a second spelling of an ingester that works.
   */
  rosterWeek?(io: PlatformIO, leagueId: string, season: number, week: number): Promise<PlatformRosterWeekRow[]>;
}

const REGISTRY = new Map<string, () => Promise<Platform>>([
  ["espn", async () => (await import("./espnPlatform.js")).espnPlatform],
  ["yahoo", async () => (await import("./yahoo.js")).yahooPlatform],
]);

/**
 * The adaptor for a platform, or a REFUSAL THAT NAMES IT.
 *
 * `openLeague` used to dispatch on a config field that did not exist, so its `default:` refusal was
 * unreachable and a Yahoo league silently got an ESPN adaptor holding a Yahoo league id (S-12). A
 * registry lookup cannot do that: an unknown key has no entry and there is nothing to fall back to.
 */
export async function platformFor(platform: string | null | undefined): Promise<Platform> {
  const key = String(platform ?? "");
  const load = REGISTRY.get(key);
  if (!load) {
    throw new Error(
      `no platform adaptor for "${key || "unknown"}" -- known platforms: ${[...REGISTRY.keys()].join(", ")}. ` +
      "Implement Platform in src/league/<platform>.ts and register it in src/league/platform.ts.",
    );
  }
  return load();
}

/** The platform ids that HAVE an adaptor. Used by tests and by the app to render the league tabs. */
export const KNOWN_PLATFORMS: PlatformId[] = ["espn", "yahoo"];
