/**
 * IS THE ESPN SESSION ACTUALLY LOGGED IN? -- one cheap GET that answers it, and CANNOT be mistaken
 * for an answer about the league.
 *
 * THE FAILURE MODE THIS EXISTS TO PREVENT. ESPN does not answer an expired session with a 401 on
 * every path. It frequently answers 200, with well-formed JSON, that simply has no teams in it (and
 * sometimes no league `id` at all). Every consumer downstream reads that as "the league is empty"
 * rather than "you are logged out": `syncSettings` refuses with a hollow-payload message about
 * lineup slots, the roster sync writes nobody, and the copilot reports a league with no players as
 * though that were a fact about the league. The bug is not that any one of them is wrong -- it is
 * that "logged out" and "empty" arrive as the same bytes, so nothing upstream can tell them apart.
 *
 * So this module does exactly one thing: it asks the cheapest league-scoped question there is
 * (`view=mSettings`) and reports WHICH of the distinguishable failures happened, with a different
 * `reason` string for each. It deliberately does NOT parse settings, validate slots, or return
 * anything a sync would want. A probe that also tried to be a sync would have the same problem the
 * sync has.
 *
 * IO IS INJECTED, ALWAYS. It takes a `PlatformIO` (src/league/platform.ts) rather than building a
 * transport, so the same probe covers the Electron bridge (`bridgePlatformIO`), a server-side
 * cookie session (`cookiePlatformIO`) and a saved-payload file handoff (`filePlatformIO`). A probe
 * that constructed its own `fetch` would be measuring a session nobody uses.
 *
 * IT DOES NOT THROW ON A FAILED PROBE. The whole point is to be usable as a pre-flight check --
 * `if (!(await probeEspnSession(io, id, yr)).ok) ...` -- and a pre-flight check that throws is just
 * the original failure wearing a stack trace. Transport errors are caught and returned as
 * `ok: false` with the transport's own message folded into `reason`. (An invalid ARGUMENT -- an
 * empty league id, a missing io -- still throws: that is a caller bug, not a session state.)
 */
import { ESPN_READS_BASE } from "./espnApi.js";
import { espnIdentityProblem } from "../league/espnPlatform.js";
import type { PlatformIO } from "../league/platform.js";

/**
 * The result of one probe. `ok` is the only field a caller must read; everything else exists so a
 * human (or a log line) can tell the four failures apart after the fact.
 *
 * `status` is `null` when the TRANSPORT threw -- we never saw an HTTP status. It is not 0 and not
 * -1, because a numeric sentinel would sort and compare like a real status. `PlatformIO.get`
 * returns a body, not a response, so on the happy path there is no status to report either; see
 * `statusFromTransportError` for the one case where a number is recoverable.
 */
export interface SessionProbe {
  ok: boolean;
  /** HTTP status when known, null when the transport threw before one was observed. */
  status: number | null;
  /** The league id we ASKED for -- echoed so a log line is self-contained. */
  leagueId: string;
  /** The league id the payload CLAIMS (`payload.id`), null when the payload carries none. */
  gotLeagueId: string | null;
  seasonId: number | null;
  /** How many teams the payload describes, null when it describes none in a readable way. */
  teams: number | null;
  /** ALWAYS populated -- why ok, or why not. Never the same string for two different failures. */
  reason: string;
  elapsedMs: number;
}

/**
 * The URL, copied from the shape already in use in `ff format sync` (src/ff.ts) rather than invented
 * here: `/seasons/{season}/segments/0/leagues/{leagueId}`. Only `view=mSettings` is requested --
 * this is a session probe, not a sync, and the smaller the payload the cheaper it is to run before
 * every other read. `mSettings` still carries both of the facts the probe needs: the league's own
 * `id` (identity) and `settings.size` (the team count that goes missing on a dead session).
 */
export function espnSessionProbeUrl(leagueId: string, season: number): string {
  return `${ESPN_READS_BASE}/seasons/${season}/segments/0/leagues/${leagueId}?view=mSettings`;
}

/**
 * Dig an HTTP status out of a transport error message when one is there.
 *
 * `cookiePlatformIO` throws `"401 Unauthorized for https://..."` -- the status is the most useful
 * thing in that string, and losing it would make a 401 (definitely logged out) indistinguishable
 * from a socket timeout (maybe just offline) in the returned struct. The bridge and file providers
 * throw messages with no status, and those correctly stay `null`. Anchored at the start so a league
 * id or a year inside the URL cannot be read as a status.
 */
function statusFromTransportError(message: string): number | null {
  const m = /^\s*(\d{3})\b/.exec(message);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 100 && n <= 599 ? n : null;
}

/** Best-effort team count. `mSettings` publishes `settings.size`; a payload that also carries a
 *  `teams` array (a caller may pass a fuller view through a file provider) is counted directly,
 *  because the ARRAY is the thing that empties out on a dead session while `size` may not. */
function teamCount(payload: unknown): number | null {
  const p = payload as { teams?: unknown; settings?: { size?: unknown } } | null;
  if (Array.isArray(p?.teams)) return p.teams.length;
  const size = Number(p?.settings?.size);
  return Number.isFinite(size) && size > 0 ? size : null;
}

/** `seasonId` as the payload spells it, or null. Informational only -- a mismatched season is not a
 *  session problem and must not be reported as one. */
function seasonOf(payload: unknown): number | null {
  const n = Number((payload as { seasonId?: unknown } | null)?.seasonId);
  return Number.isFinite(n) ? n : null;
}

/**
 * Probe the ESPN session behind `io` by asking for one league's settings.
 *
 * FIVE OUTCOMES, FIVE DISTINCT `reason` STRINGS. They are distinct on purpose and the test asserts
 * it: a probe whose failures all read the same is exactly as useless as the empty-league payload it
 * was written to catch.
 *
 *   ok           the body parsed and its `id` is the league we asked for
 *   transport    `io.get` threw -- no status seen unless the message carried one
 *   non-JSON     a body came back but it is not JSON (an ESPN login/interstitial HTML page is the
 *                usual cause, and it is the single clearest "you are logged out" signal there is)
 *   no id        JSON, but it carries no `id` -- the hollow-payload shape
 *   wrong id     JSON for a DIFFERENT league than the one requested
 *
 * The last two are delegated to `espnIdentityProblem` (src/league/espnPlatform.ts), the same check
 * `espnSettingsFromPayload` refuses on, so the probe and the sync cannot drift apart about what
 * counts as the right league.
 */
export async function probeEspnSession(io: PlatformIO, leagueId: string, season: number): Promise<SessionProbe> {
  // Argument bugs throw. A caller that probed the empty string would otherwise get back a tidy
  // `ok: false` and conclude the session is dead, which is a diagnosis of the wrong machine.
  if (!io || typeof io.get !== "function") throw new Error("probeEspnSession: needs a PlatformIO with a get(). Pass bridgePlatformIO/cookiePlatformIO/filePlatformIO -- the probe never builds its own transport.");
  const id = String(leagueId ?? "").trim();
  if (!id) throw new Error("probeEspnSession: empty leagueId. Probing for no league cannot tell you anything about the session.");
  if (!Number.isFinite(season)) throw new Error(`probeEspnSession: season must be a number, got ${JSON.stringify(season)}.`);

  const url = espnSessionProbeUrl(id, season);
  const started = Date.now();
  const base = { leagueId: id, gotLeagueId: null, seasonId: null, teams: null } as const;

  let body: string;
  try {
    body = await io.get(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ...base, ok: false,
      status: statusFromTransportError(msg),
      reason: `TRANSPORT FAILED: the request for ${url} never returned a body -- ${msg}`,
      elapsedMs: Date.now() - started,
    };
  }

  // An empty body is a transport-shaped failure that DID return: separate message, because "the
  // request failed" and "the request succeeded and said nothing" have different fixes.
  if (!body || !body.trim()) {
    return {
      ...base, ok: false, status: null,
      reason: `EMPTY BODY: the request for league ${id} returned zero bytes. The session provider answered but said nothing -- this is not an empty league.`,
      elapsedMs: Date.now() - started,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return {
      ...base, ok: false, status: null,
      reason: `NOT JSON: league ${id} answered with ${body.length} bytes that do not parse as JSON -- ` +
        `almost always an ESPN login or interstitial page, i.e. the session is not authenticated. Body starts: ${body.slice(0, 120).replace(/\s+/g, " ")}`,
      elapsedMs: Date.now() - started,
    };
  }

  const gotRaw = (payload as { id?: unknown } | null)?.id;
  const gotLeagueId = gotRaw == null || gotRaw === "" ? null : String(gotRaw);
  const teams = teamCount(payload);
  const seasonId = seasonOf(payload);

  // The identity check itself is NOT re-implemented here. `espnIdentityProblem` already distinguishes
  // "no id" from "wrong id" with two different sentences, and it is what the real sync refuses on.
  const idProblem = espnIdentityProblem(payload, id);
  if (idProblem) {
    return {
      // STATUS IS NULL, NOT 200. `PlatformIO.get` returns a BODY and nothing else -- it has no
      // status to give -- so 200 here would be a number the probe invented. It is exactly wrong
      // for `filePlatformIO`, where no HTTP request happened at all, and unknowable for the
      // bridge. A status is reported only where one is genuinely observed: the transport error
      // path, where `cookiePlatformIO` puts the real code in its message.
      ok: false, status: null, leagueId: id, gotLeagueId, seasonId, teams,
      // Prefixed by WHICH of the two identity failures it is, so the two never read alike even at a
      // glance, and so a grep for one cannot match the other.
      reason: `${gotLeagueId === null ? "NO LEAGUE ID" : "WRONG LEAGUE"}: ${idProblem}`,
      elapsedMs: Date.now() - started,
    };
  }

  return {
    // Null for the same reason as above: a body came back, which is what "the session works"
    // means here; the HTTP status is not something this contract carries.
    ok: true, status: null, leagueId: id, gotLeagueId, seasonId, teams,
    reason: `OK: the session read league ${id} and the payload is league ${gotLeagueId}` +
      (teams == null
        // Still ok: identity is the session question. But say so, because a live session over a
        // league with no readable team count is worth seeing in the log.
        ? ", though it publishes no readable team count."
        : ` with ${teams} teams.`),
    elapsedMs: Date.now() - started,
  };
}
