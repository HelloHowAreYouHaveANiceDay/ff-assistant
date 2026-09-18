/**
 * THE PROBE'S CONTRACT IS THAT ITS FAILURES ARE TELLABLE APART.
 *
 * ESPN answers an expired session with a 200 and valid JSON that simply has no teams in it, so
 * "logged out" and "the league is empty" arrive as the same bytes. `probeEspnSession` exists to
 * split them -- which means the thing worth testing is not that it returns `ok: false` (a function
 * that returned `ok: false` unconditionally would pass that), but that each distinguishable failure
 * produces a DIFFERENT sentence, and that a healthy payload still comes back `ok: true`.
 *
 * So every test below is paired with its opposite direction:
 *   - a healthy payload must pass                (or the probe is a stuck "no", useless as a gate)
 *   - a wrong-league payload must fail BY NAME   (the negative control for the identity check)
 *   - the four failure reasons must all differ   (the actual contract; asserted explicitly)
 *
 * The IO is a plain fake object -- `PlatformIO` is one method, `get(url) => Promise<string>`, which
 * is precisely why the probe takes it instead of building a transport. Nothing here touches the
 * network, ESPN, or the store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeEspnSession, espnSessionProbeUrl, type SessionProbe } from "../src/data/espnSession.js";
import type { PlatformIO } from "../src/league/platform.js";

const LEAGUE = "123456";
const SEASON = 2026;

/** A PlatformIO whose single method returns exactly what the test hands it. `calls` is captured so
 *  the URL assertion below is about the request the probe REALLY made, not one retyped in the test. */
function fakeIo(respond: (url: string) => string | Promise<string>): PlatformIO & { calls: string[] } {
  const calls: string[] = [];
  return { calls, get: async (url: string) => { calls.push(url); return respond(url); } };
}

/** A payload shaped like the one ESPN returns for a live session. */
const healthy = JSON.stringify({ id: Number(LEAGUE), seasonId: SEASON, settings: { size: 16, name: "Test League" } });

// --- the positive direction ----------------------------------------------------------------------

test("a healthy payload probes ok, and says which league it read", async () => {
  const io = fakeIo(() => healthy);
  const p = await probeEspnSession(io, LEAGUE, SEASON);
  assert.equal(p.ok, true, `expected ok, got: ${p.reason}`);
  assert.equal(p.gotLeagueId, LEAGUE);
  assert.equal(p.seasonId, SEASON);
  assert.equal(p.teams, 16);
  // NOT 200: `PlatformIO.get` hands back a body and no status, so a 200 here would be invented --
  // and plainly false over `filePlatformIO`, where nothing was fetched. A status appears only when
  // one was actually observed (see the 401 case below).
  assert.equal(p.status, null, "a body-returning transport reports no status, rather than assuming 200");
  assert.match(p.reason, /OK/);
  assert.match(p.reason, new RegExp(LEAGUE), "the happy reason must still name the league it read");
  assert.ok(p.elapsedMs >= 0, "elapsedMs is always populated");
});

test("the probe asks the mSettings URL the repo already uses, on the injected IO", async () => {
  // Positive control on the transport seam: if the probe built its own fetch, `calls` would be
  // empty here and every other test in this file would be measuring nothing.
  const io = fakeIo(() => healthy);
  await probeEspnSession(io, LEAGUE, SEASON);
  assert.equal(io.calls.length, 1, "exactly one GET -- a probe that is expensive will not be run before every read");
  assert.equal(io.calls[0], espnSessionProbeUrl(LEAGUE, SEASON));
  assert.match(io.calls[0], /\/seasons\/2026\/segments\/0\/leagues\/123456\?view=mSettings$/);
});

// --- the four failures, each in its own direction -------------------------------------------------

test("a payload for the WRONG league fails, and the reason names BOTH ids", async () => {
  // The negative control that matters most: reading one league and reporting another is how a
  // league inherits another league's rules, and it arrives as a perfectly healthy-looking 200.
  const io = fakeIo(() => JSON.stringify({ id: 999999, seasonId: SEASON, settings: { size: 12 } }));
  const p = await probeEspnSession(io, LEAGUE, SEASON);
  assert.equal(p.ok, false);
  assert.equal(p.gotLeagueId, "999999");
  assert.match(p.reason, new RegExp(LEAGUE), "the reason must name the league we ASKED for");
  assert.match(p.reason, /999999/, "the reason must name the league we GOT");
});

test("a payload with NO id fails -- this is the expired-session shape", async () => {
  // Valid JSON, 200, no teams, no id. Downstream this reads as "the league is empty"; here it must
  // read as "the payload cannot be shown to be ours".
  const io = fakeIo(() => JSON.stringify({ seasonId: SEASON, settings: {} }));
  const p = await probeEspnSession(io, LEAGUE, SEASON);
  assert.equal(p.ok, false);
  assert.equal(p.gotLeagueId, null);
  assert.equal(p.teams, null, "no readable team count is reported as null, never as 0");
  assert.match(p.reason, /NO LEAGUE ID/);
});

test("a non-JSON body fails and says so -- an ESPN login page is not a league", async () => {
  const io = fakeIo(() => "<!DOCTYPE html><html><body>Log in to ESPN</body></html>");
  const p = await probeEspnSession(io, LEAGUE, SEASON);
  assert.equal(p.ok, false);
  assert.match(p.reason, /NOT JSON/);
  assert.match(p.reason, /not authenticated/, "the whole point is that this one is diagnosable as a logout");
});

test("a transport that throws returns ok:false -- and the probe itself does NOT throw", async () => {
  // A pre-flight check that throws is just the original failure wearing a stack trace, so this is
  // asserted directly rather than implied by the fields.
  const io = fakeIo(() => { throw new Error("socket hang up"); });
  await assert.doesNotReject(() => probeEspnSession(io, LEAGUE, SEASON));
  const p = await probeEspnSession(io, LEAGUE, SEASON);
  assert.equal(p.ok, false);
  assert.equal(p.status, null, "no HTTP status was ever observed, so it is null and not a sentinel number");
  assert.match(p.reason, /TRANSPORT FAILED/);
  assert.match(p.reason, /socket hang up/, "the transport's own message must survive into the reason");
});

test("a transport error that CARRIES a status keeps it -- 401 is not a socket timeout", async () => {
  // cookiePlatformIO throws "401 Unauthorized for https://...". Losing that number would make
  // "definitely logged out" indistinguishable from "maybe just offline".
  const io = fakeIo(() => { throw new Error("401 Unauthorized for https://lm-api-reads.fantasy.espn.com/..."); });
  const p = await probeEspnSession(io, LEAGUE, SEASON);
  assert.equal(p.ok, false);
  assert.equal(p.status, 401);
});

// --- the actual contract --------------------------------------------------------------------------

test("all four failure reasons are DISTINCT -- a probe whose failures read alike is useless", async () => {
  const cases: Record<string, string> = {
    wrongLeague: JSON.stringify({ id: 999999, settings: { size: 12 } }),
    noId: JSON.stringify({ seasonId: SEASON, settings: {} }),
    notJson: "<!DOCTYPE html><html>login</html>",
  };
  const probes: Record<string, SessionProbe> = {};
  for (const [name, body] of Object.entries(cases)) {
    probes[name] = await probeEspnSession(fakeIo(() => body), LEAGUE, SEASON);
  }
  probes.threw = await probeEspnSession(fakeIo(() => { throw new Error("ECONNRESET"); }), LEAGUE, SEASON);

  for (const [name, p] of Object.entries(probes)) assert.equal(p.ok, false, `${name} must not be ok`);

  const reasons = Object.values(probes).map((p) => p.reason);
  assert.equal(new Set(reasons).size, reasons.length,
    `four different failures produced ${new Set(reasons).size} different messages:\n  ${reasons.join("\n  ")}`);

  // And distinct from the healthy one too -- otherwise "distinct failures" would be satisfied by a
  // probe that said the same thing whether or not it worked.
  const ok = await probeEspnSession(fakeIo(() => healthy), LEAGUE, SEASON);
  assert.ok(!reasons.includes(ok.reason));
});

// --- caller bugs are NOT session states -----------------------------------------------------------

test("an invalid argument throws rather than reporting a dead session", async () => {
  // Returning a tidy ok:false for an empty league id would diagnose the wrong machine.
  await assert.rejects(() => probeEspnSession(fakeIo(() => healthy), "", SEASON), /empty leagueId/);
  await assert.rejects(() => probeEspnSession(null as unknown as PlatformIO, LEAGUE, SEASON), /PlatformIO/);
});
