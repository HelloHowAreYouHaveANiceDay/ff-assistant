// THE APP BRIDGE'S PER-PLATFORM HOST ALLOWLIST -- in its own dependency-free CommonJS module so it
// can be unit-tested (test/platform-bridge-allowlist.test.ts) without loading Electron.
//
// WHY AN ALLOWLIST AT ALL. The bridge exists to reuse a REAL LOGIN, so a route that would request an
// arbitrary url with a guest's cookies attached is a credential-forwarding proxy any local process can
// aim anywhere. It was already narrow to espn.com; with a second logged-in platform "narrow" becomes a
// PER-HOST question -- a Yahoo url must never be requested with the ESPN guest's session, or the other
// way round -- so the allowed url pattern is keyed by the guest the request will run in.
//
//   key   = the host substring a <webview> guest is matched by (guestWebContents in main.js)
//   value = the ONLY url pattern /fetch will request with that guest's credentials
const BRIDGE_HOSTS = {
  "espn.com": /^https:\/\/[a-z0-9.-]*espn\.com\//i,
  "fantasysports.yahoo.com": /^https:\/\/[a-z0-9.-]*fantasysports\.yahoo\.com\//i,
};

// A caller may name the PLATFORM instead of the host ("yahoo" -> fantasysports.yahoo.com).
const PLATFORM_HOST = { espn: "espn.com", yahoo: "fantasysports.yahoo.com" };

/**
 * The allowlisted host for `h`, or null.
 *
 * An OMITTED host resolves to espn.com, which is what keeps every pre-existing caller byte-identical:
 * the routes were ESPN-only before this parameter existed. An UNKNOWN host returns null and the route
 * refuses -- it never falls through to a default guest, which is the P-3 bug in miniature.
 */
function resolveBridgeHost(h) {
  const raw = String(h == null || h === "" ? "espn.com" : h).toLowerCase();
  const host = Object.prototype.hasOwnProperty.call(PLATFORM_HOST, raw) ? PLATFORM_HOST[raw] : raw;
  return Object.prototype.hasOwnProperty.call(BRIDGE_HOSTS, host) ? host : null;
}

/** True when `url` may be fetched with `host`'s guest. */
function bridgeUrlAllowed(host, url) {
  const h = resolveBridgeHost(host);
  return !!h && BRIDGE_HOSTS[h].test(String(url));
}

/**
 * True when `url`'s HOSTNAME is `host` or a subdomain of it (dot boundary, case-insensitive) -- the
 * rule guestWebContents picks a guest by, and the same one `isBlockedUrl` (blockHosts.js) uses.
 *
 * Never a substring/regex over the whole url (issue #25): a signed-out Yahoo guest is on
 * login.yahoo.com with the return address `...fantasysports.yahoo.com...` in its query string, and
 * percent-encoding leaves the dots alone, so the old unanchored test said it was on the platform.
 */
function urlOnHost(url, host) {
  const want = String(host || "").toLowerCase();
  if (!want) return false;
  let h;
  try { h = new URL(String(url)).hostname.toLowerCase(); } catch (_) { return false; }
  return h === want || h.endsWith("." + want);
}

module.exports = { BRIDGE_HOSTS, PLATFORM_HOST, resolveBridgeHost, bridgeUrlAllowed, urlOnHost };
