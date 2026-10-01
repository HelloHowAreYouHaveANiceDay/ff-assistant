// AD / TRACKER BLOCKLIST for the two logged-in guests (persist:espn, persist:yahoo).
//
// WHY (measured 2026-10-01): with both guests mounted the app ran 27 renderer processes (~870 MB),
// because Chromium's site isolation gives every cross-origin iframe its own process -- and the Yahoo
// guest alone carried 31 frames across 24 origins, nearly all header-bidding ad exchanges, running
// whether or not anyone was looking at it. ESPN carried 7 frames across 6 origins.
//
// WHAT IT IS NOT: a general ad blocker. It is a SUFFIX list of the ad-auction / tracking hosts those
// guests actually load, matched on the request's hostname. The fantasy, login and consent hosts are
// never on it -- test/app-block-hosts.test.ts asserts both directions, so a too-broad entry that
// would break a login fails the suite rather than the Sunday-morning lineup.
//
// Dependency-free so the test can require it without Electron (same pattern as bridgeHosts.js).
const BLOCKED_SUFFIXES = [
  // header bidding / SSPs seen in the Yahoo guest
  "adnxs.com", "pubmatic.com", "openx.net", "criteo.com", "criteo.net", "rubiconproject.com",
  "casalemedia.com", "indexww.com", "3lift.com", "taboola.com", "yieldmo.com", "media.net",
  "lijit.com", "sonobi.com", "gumgum.com", "emxdgt.com", "cootlogix.com", "a-mo.net",
  "openwebmp.com", "minutemedia-prebid.com", "yellowblue.io",
  // common ad / measurement hosts on both guests
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "amazon-adsystem.com",
  "adsrvr.org", "outbrain.com", "teads.tv", "sharethrough.com", "smartadserver.com", "bidswitch.net",
  "moatads.com", "doubleverify.com", "adsafeprotected.com", "imrworldwide.com",
  "scorecardresearch.com", "quantserve.com", "krxd.net", "bluekai.com",
];

/** Hosts that must NEVER be blocked, whatever is added above (checked by the test). */
const PROTECTED = [
  "fantasy.espn.com", "www.espn.com", "lm-api-reads.fantasy.espn.com", "lm-api-writes.fantasy.espn.com",
  "registerdisney.go.com", "cdn.registerdisney.go.com", "www.google.com",
  "football.fantasysports.yahoo.com", "fantasysports.yahoo.com", "login.yahoo.com", "api.login.yahoo.com",
  "guce.yahoo.com", "consent.yahoo.com", "s.yimg.com",
];

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ""; }
}

/** True when the request URL's host is, or is a subdomain of, a blocked suffix. */
function isBlockedUrl(url) {
  const h = hostOf(url);
  if (!h) return false;
  return BLOCKED_SUFFIXES.some((s) => h === s || h.endsWith("." + s));
}

module.exports = { BLOCKED_SUFFIXES, PROTECTED, isBlockedUrl, hostOf };
