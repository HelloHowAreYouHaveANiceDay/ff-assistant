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
export interface WebviewSpec { elementId: string; host: string; partition: string }

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
  acquisition: AcquisitionRules;
  /** The platform's OWN settings table, verbatim, as label -> value. Provenance, not a consumer
   *  surface: it is what makes a stored config auditable against the page it was read from. */
  rosterSettings: Record<string, string>;
  /** One line naming the page(s) this was read from and when. Written into the config. */
  provenance: string;
}

/** One roster as a sync reads it, before OUR valuation is attached. */
export interface PlatformRoster { teamId: string; teamName: string; players: { name: string; pos: string; slot: string; team?: string }[] }

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

export interface Platform {
  readonly id: PlatformId;
  readonly urls: PlatformUrls;
  readonly webview: WebviewSpec;
  /** The leagues this login can see. */
  discover(io: PlatformIO, wantSeason: number): Promise<DiscoveredLeague[]>;
  /** The league's rules, in our vocabulary. THROWS on anything it cannot read -- never defaults. */
  syncSettings(io: PlatformIO, leagueId: string, season: number): Promise<LeagueSettings>;
  /** Every team's roster. */
  syncRosters(io: PlatformIO, leagueId: string, season: number): Promise<PlatformRoster[]>;
  /** ONE team, as the platform-agnostic type. `proj` is 0 -- valuation is attached by openLeague. */
  readTeam(io: PlatformIO, leagueId: string, season: number, teamId: string): Promise<LeagueTeam>;
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
