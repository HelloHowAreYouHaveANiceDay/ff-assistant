// The guests' ad/tracker blocklist (app/blockHosts.js): it must block the ad-auction hosts measured in
// the Yahoo and ESPN guests, and must NEVER block a fantasy, login or consent host -- a too-broad
// entry would silently break a logged-in guest, which reads as "ESPN is down", not as a bug here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isBlockedUrl, PROTECTED, BLOCKED_SUFFIXES } = require("../app/blockHosts.js");

test("the ad-auction hosts measured in the guests are blocked", () => {
  // From the 2026-10-01 frame census of the Yahoo guest (31 frames, 24 origins) and the ESPN guest.
  for (const h of ["ads.pubmatic.com", "u.openx.net", "ssp-sync.criteo.com", "gum.criteo.com", "eus.rubiconproject.com",
    "pixel.rubiconproject.com", "cdn.taboola.com", "acdn.adnxs.com", "ads.yieldmo.com", "js-sec.indexww.com",
    "eb2.3lift.com", "sync.cootlogix.com", "rtb.gumgum.com", "cs.emxdgt.com", "sync.go.sonobi.com", "ap.lijit.com",
    "hbx.media.net", "prebid.a-mo.net", "pbs-cs.openwebmp.com", "pbs-cs.minutemedia-prebid.com", "pbs-cs.yellowblue.io",
    "ssum-sec.casalemedia.com", "cdn-gl.imrworldwide.com"]) {
    assert.equal(isBlockedUrl(`https://${h}/x`), true, `${h} was NOT blocked`);
  }
});

test("no fantasy, login or consent host is ever blocked -- the guard can say NO", () => {
  for (const h of PROTECTED) assert.equal(isBlockedUrl(`https://${h}/`), false, `${h} would be blocked -- a logged-in guest would break`);
  // Suffix matching must not catch look-alikes: "media.net" must not block "socialmedia.network".
  assert.equal(isBlockedUrl("https://socialmedia.network/"), false);
  assert.equal(isBlockedUrl("https://notadnxs.com.example.org/"), false);
});

test("no blocked suffix is itself a protected host or a parent of one", () => {
  for (const s of BLOCKED_SUFFIXES) for (const p of PROTECTED) {
    assert.ok(!(p === s || p.endsWith("." + s)), `blocked suffix ${s} covers protected host ${p}`);
  }
});

test("garbage input fails open (not blocked), never throws", () => {
  assert.equal(isBlockedUrl("not a url"), false);
  assert.equal(isBlockedUrl(""), false);
});
