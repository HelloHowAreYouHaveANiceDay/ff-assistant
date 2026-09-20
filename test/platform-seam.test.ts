/**
 * THE PLATFORM SEAM: the registry, the ESPN pure parsers, and the app bridge's host allowlist.
 *
 * Three defects this pins, all of which were SILENT (docs/architecture-review-2026-09-16.md, P-1/P-3):
 *   - `openLeague` dispatched on a config field that does not exist, so its "no adaptor" refusal was
 *     unreachable and a Yahoo league got an ESPN adaptor holding a Yahoo league id.
 *   - the bridge's guest resolver fell back to ANY webview when none was on the requested host, so a
 *     read meant for ESPN acted on the Yahoo guest.
 *   - `/fetch` had ONE espn.com allowlist for what is now two logged-in sessions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { knownPlatforms, platformFor } from "../src/league/platform.js";
import { assertUnregistered } from "./helpers/unknown-platform.js";
import { espnDiscoverFromLinks, espnIdentityProblem, espnPlatform, espnSlotsToConfig, espnLeagueApiUrl } from "../src/league/espnPlatform.js";
import { yahooPlatform } from "../src/league/yahoo.js";

const require = createRequire(import.meta.url);
const { resolveBridgeHost, bridgeUrlAllowed, BRIDGE_HOSTS } = require("../app/bridgeHosts.js");

test("the registry resolves every known platform and REFUSES an unknown one by name", async () => {
  for (const id of knownPlatforms()) assert.equal((await platformFor(id)).id, id);
  // Positive first (a registry that could only ever throw would pass a refusal-only test), then the
  // refusal -- which is the thing `openLeague` could not reach before.
  // The id and the expected list are both DERIVED. Hardcoding either is the rot that broke this
  // test when a Sleeper adaptor landed: it asserted that a now-registered platform is unknown, and
  // that the known list is exactly "espn, yahoo". See test/helpers/unknown-platform.ts.
  const unknown = assertUnregistered();
  await assert.rejects(
    () => platformFor(unknown),
    (e: Error) => {
      assert.match(e.message, new RegExp(`no platform adaptor for "${unknown}"`));
      for (const id of knownPlatforms()) assert.ok(e.message.includes(id), `the refusal must list ${id}`);
      return true;
    },
  );
  await assert.rejects(() => platformFor(null), /no platform adaptor for "unknown"/);
  await assert.rejects(() => platformFor(""), /no platform adaptor for "unknown"/);
});

test("each platform names its OWN host, webview and partition", async () => {
  // `host` MOVED OFF `WebviewSpec` (2026-09-19): it is a platform fact used to choose a session,
  // and living on an Electron struct meant two transport call sites read `plat.webview.host` to
  // configure something that is not a webview. Same values, reachable without Electron vocabulary.
  assert.equal(espnPlatform.host, "espn.com");
  assert.equal(yahooPlatform.host, "fantasysports.yahoo.com");
  assert.notEqual(espnPlatform.host, yahooPlatform.host);

  assert.deepEqual(espnPlatform.webview, { elementId: "espnview", partition: "persist:espn" });
  assert.deepEqual(yahooPlatform.webview, { elementId: "yahooview", partition: "persist:yahoo" });
  // Two platforms must never share a guest or a partition -- that is one login, not two.
  assert.notEqual(espnPlatform.webview!.partition, yahooPlatform.webview!.partition);
  assert.notEqual(espnPlatform.webview!.elementId, yahooPlatform.webview!.elementId);
});

test("page urls are built per platform, and each stays on its own host", () => {
  const cases: [string, (u: typeof espnPlatform.urls) => string, RegExp][] = [
    ["team", (u) => u.team("L", 2026, "7"), /L/],
    ["scoreboard", (u) => u.scoreboard("L", 2026, 3), /L/],
    ["standings", (u) => u.standings("L", 2026), /L/],
    ["draftRoom", (u) => u.draftRoom("L", 2026, "7"), /L/],
  ];
  for (const [name, build, hasId] of cases) {
    const e = build(espnPlatform.urls), y = build(yahooPlatform.urls);
    assert.match(e, /^https:\/\/fantasy\.espn\.com\//, `espn ${name}`);
    assert.match(y, /^https:\/\/football\.fantasysports\.yahoo\.com\//, `yahoo ${name}`);
    assert.match(e, hasId); assert.match(y, hasId);
    // The bug P-4 names: a Yahoo league's page must never be an espn.com url carrying its league id.
    assert.ok(!/espn\.com/.test(y), `yahoo ${name} built an espn.com url`);
  }
  assert.equal(espnPlatform.urls.team("462233", 2026, "8"), "https://fantasy.espn.com/football/team?leagueId=462233&seasonId=2026&teamId=8");
  assert.equal(yahooPlatform.urls.team("129048", 2026, "11"), "https://football.fantasysports.yahoo.com/f1/129048/11");
});

test("ESPN slot order and league api url are unchanged from agent.ts", () => {
  // The real league's lineupSlotCounts: 1 QB, 1 RB, 1 WR, 1 TE, 2 FLEX, 1 DST, 1 K, 4 BE.
  assert.deepEqual(
    espnSlotsToConfig({ 0: 1, 2: 1, 4: 1, 6: 1, 23: 2, 16: 1, 17: 1, 20: 4 }),
    ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"],
  );
  assert.equal(
    espnLeagueApiUrl(2026, "462233", ["mSettings", "mTeam"]),
    "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/462233?view=mSettings&view=mTeam",
  );
});

test("ESPN discover keeps this season's leagues and skips another season's placeholder links", () => {
  const links = [
    { h: "https://fantasy.espn.com/football/team?leagueId=462233&seasonId=2026&teamId=8", t: "seacaptaindate.com" },
    { h: "https://fantasy.espn.com/football/league?leagueId=462233&seasonId=2026", t: "seacaptaindate.com" },
    { h: "https://fantasy.espn.com/football/league?leagueId=211696&seasonId=2027", t: "" },
    { h: "not a url", t: "junk" },
  ];
  const { keep, skipped } = espnDiscoverFromLinks(links, 2026);
  // The 2027 link is exactly what wrote the junk `league` row 211696 with a NULL name (S-14).
  assert.deepEqual(skipped.map((l) => l.leagueId), ["211696"]);
  // Two anchors for the same league+season are ONE league: the dedupe key is leagueId|seasonId, and
  // the FIRST anchor wins -- which is why the team link (carrying teamId) must come first to be kept.
  assert.deepEqual(keep.map((l) => l.leagueId), ["462233"]);
  assert.equal(keep[0].teamId, "8");
  assert.equal(keep[0].name, "seacaptaindate.com");
});

test("the ESPN identity guard fires on a payload for another league, and on an unlabelled one", () => {
  assert.equal(espnIdentityProblem({ id: 462233 }, "462233"), null);         // the positive case
  assert.match(String(espnIdentityProblem({ id: 129048 }, "462233")), /asked for league 462233 but the payload is league 129048/);
  assert.match(String(espnIdentityProblem({}, "462233")), /carries no league id/);
});

test("the bridge host allowlist: default espn, platform names, and NO fallback", () => {
  assert.deepEqual(Object.keys(BRIDGE_HOSTS).sort(), ["espn.com", "fantasysports.yahoo.com"]);
  // Omitted host = espn.com. This is what keeps every pre-existing caller byte-identical.
  assert.equal(resolveBridgeHost(undefined), "espn.com");
  assert.equal(resolveBridgeHost(""), "espn.com");
  assert.equal(resolveBridgeHost("espn.com"), "espn.com");
  // A caller may name the PLATFORM instead of the host.
  assert.equal(resolveBridgeHost("yahoo"), "fantasysports.yahoo.com");
  assert.equal(resolveBridgeHost("ESPN"), "espn.com");
  // An unknown host is NULL -- never a default guest, which is the P-3 bug in miniature.
  assert.equal(resolveBridgeHost("example.com"), null);
  assert.equal(resolveBridgeHost("yahoo.com"), null);
  assert.equal(resolveBridgeHost("sleeper.app"), null);
});

test("the allowlist is PER HOST: a url may not be fetched with another platform's session", () => {
  const espnRead = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/462233?view=mTeam";
  const yahooPage = "https://football.fantasysports.yahoo.com/f1/129048/settings";
  // positive: each host may fetch its own urls
  assert.equal(bridgeUrlAllowed("espn.com", espnRead), true);
  assert.equal(bridgeUrlAllowed(undefined, espnRead), true);
  assert.equal(bridgeUrlAllowed("yahoo", yahooPage), true);
  // negative: crossed over, refused both ways
  assert.equal(bridgeUrlAllowed("espn.com", yahooPage), false);
  assert.equal(bridgeUrlAllowed("yahoo", espnRead), false);
  // and nothing else at all
  assert.equal(bridgeUrlAllowed("espn.com", "https://example.com/"), false);
  assert.equal(bridgeUrlAllowed("yahoo", "https://yahoo.com/"), false);
  assert.equal(bridgeUrlAllowed("example.com", "https://example.com/"), false);
  // http, and a host that merely CONTAINS the allowed one, are both refused
  assert.equal(bridgeUrlAllowed("espn.com", "http://fantasy.espn.com/x"), false);
  assert.equal(bridgeUrlAllowed("espn.com", "https://espn.com.evil.test/x"), false);
  assert.equal(bridgeUrlAllowed("yahoo", "https://fantasysports.yahoo.com.evil.test/x"), false);
});
