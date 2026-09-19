/**
 * A SESSION PROVIDER THAT CANNOT ANSWER MUST SAY SO. IT MUST NOT ANSWER "EMPTY".
 *
 * `PlatformIO` is one method -- "GET this URL with the user's session, return the body" -- and for a
 * long time `bridgePlatformIO` was its only implementation, so the repo assumed every caller could
 * speak the Electron app's bridge protocol. `cookiePlatformIO` and `filePlatformIO` are the two ways
 * in that do not need the app: a cookie plus a plain fetch, and a map from URL token to saved file.
 *
 * Both of them exist in a codebase whose recurring, expensive bug is SILENCE READ AS AGREEMENT. Every
 * consumer downstream of an IO -- `syncSettings`, `syncRosters`, the ownership writer -- treats a
 * parseable body with no teams in it as "this league has no teams". So the two failures that MUST
 * NOT return a body are:
 *
 *   - "there is no saved payload for this view" (filePlatformIO). Returning "" or "{}" here would
 *     parse into an empty league and wipe the real rosters.
 *   - "your session expired" (cookiePlatformIO). ESPN answers an expired session with HTTP 401 and a
 *     VALID JSON BODY that simply has no teams. The body alone is indistinguishable from an empty
 *     league; only the status can tell them apart, which is why the status is checked in the IO and
 *     not left to the caller.
 *
 * Both directions are asserted throughout: a provider that refuses everything is as useless as one
 * that refuses nothing, and neither is visible in a row count.
 *
 * `globalThis.fetch` is monkey-patched for the transport tests and restored in a `finally` so a
 * failing assertion cannot leak a fake fetch into the rest of the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cookiePlatformIO, filePlatformIO } from "../src/league/platform.js";

// ---------------------------------------------------------------------------------------------
// 1. filePlatformIO
// ---------------------------------------------------------------------------------------------

/** One temp directory holding named files; the caller removes it. */
function tempDirWith(files: Record<string, string>): { dir: string; path: (n: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "ff-platform-io-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf8");
  return { dir, path: (n: string) => join(dir, n) };
}

const ESPN = "https://fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/462233";

test("FILE IO: a URL containing a known token is served the matching file's body", async () => {
  // The positive direction, and it is not a formality: a provider that only ever threw would pass
  // every refusal test below while making the file-handoff loop completely unusable.
  const t = tempDirWith({
    "roster.json": '{"teams":[{"id":8}]}',
    "settings.json": '{"settings":{"name":"X"}}',
  });
  try {
    const io = filePlatformIO({ "view=mRoster": t.path("roster.json"), "view=mSettings": t.path("settings.json") });
    assert.equal(await io.get(`${ESPN}?view=mRoster`), '{"teams":[{"id":8}]}');
    // ...and the token really selects, rather than the map's first entry always winning.
    assert.equal(await io.get(`${ESPN}?view=mSettings&view=mTeam`), '{"settings":{"name":"X"}}');
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("FILE IO: the token matches ANYWHERE in the URL, not just at the end", async () => {
  // Real ESPN URLs carry the view in the middle of a query string with other parameters after it
  // (`?scoringPeriodId=2&view=mBoxscore&foo=1`). A match anchored at the end would refuse every one
  // of them, and the refusal would look exactly like "no payload saved".
  const t = tempDirWith({ "box.json": '{"schedule":[]}' });
  try {
    const io = filePlatformIO({ "view=mBoxscore": t.path("box.json") });
    assert.equal(await io.get(`${ESPN}?scoringPeriodId=2&view=mBoxscore&rand=7`), '{"schedule":[]}');
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("FILE IO: an UNMATCHED url REFUSES -- and lists the tokens it does know", async () => {
  // THE POINT OF THE WHOLE PROVIDER. "No saved payload for this view" must never reach a parser as
  // an empty body, because an empty body parses into an empty league and the ownership writer's
  // refuse-empty-wipe guard is the only thing left standing between that and erased rosters.
  const t = tempDirWith({ "roster.json": "{}" });
  try {
    const io = filePlatformIO({ "view=mRoster": t.path("roster.json"), "view=mTeam": t.path("roster.json") });
    await assert.rejects(() => io.get(`${ESPN}?view=mTransactions2`), (e: Error) => {
      assert.ok(/no saved payload/.test(e.message), e.message);
      // The known tokens are listed because the operator's next move is to save the missing view --
      // and they cannot do that without knowing which token the map is keyed on.
      assert.ok(e.message.includes("view=mRoster"), `must list the known tokens: ${e.message}`);
      assert.ok(e.message.includes("view=mTeam"), `must list ALL the known tokens: ${e.message}`);
      // And it must say what it is doing instead, so a caller reading a log cannot mistake this for
      // a transport error that a retry would fix.
      assert.ok(/Refusing rather than returning an empty body/.test(e.message), e.message);
      return true;
    });
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("FILE IO: an EMPTY map refuses every url and says it knows none", async () => {
  // The degenerate case that a careless implementation gets wrong in the other direction: with no
  // entries, `find` returns undefined for everything, and any "well, nothing matched, return ''"
  // fallback would make a misconfigured provider silently report every league as empty.
  const io = filePlatformIO({});
  await assert.rejects(() => io.get(`${ESPN}?view=mRoster`), (e: Error) => {
    assert.ok(/no saved payload/.test(e.message), e.message);
    assert.ok(e.message.includes("(none)"), `an empty map must say so explicitly: ${e.message}`);
    return true;
  });
});

test("FILE IO: a token that maps to a MISSING file throws rather than returning empty", async () => {
  // A mapped-but-absent file is the same failure wearing a different hat: the token matched, so the
  // refusal above does not fire, and only the read itself can catch it.
  const dir = mkdtempSync(join(tmpdir(), "ff-platform-io-"));
  try {
    const io = filePlatformIO({ "view=mRoster": join(dir, "never-saved.json") });
    await assert.rejects(() => io.get(`${ESPN}?view=mRoster`), /ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------
// 2. cookiePlatformIO -- construction
// ---------------------------------------------------------------------------------------------

test("COOKIE IO: an empty or whitespace-only cookie is refused at CONSTRUCTION", async () => {
  // Refused when the provider is built, not when it is first used, because an IO that is going to
  // fail every request should not be handed to a sync at all. The message says why: a session
  // provider with no session produces a 401, and a 401 body is what gets misread as an empty league.
  for (const bad of ["", "   ", "\t\n "]) {
    assert.throws(() => cookiePlatformIO(bad), (e: Error) => {
      assert.ok(/empty cookie/.test(e.message), e.message);
      return true;
    }, `cookiePlatformIO(${JSON.stringify(bad)}) must refuse`);
  }
});

test("COOKIE IO: a non-empty cookie CONSTRUCTS -- the check is not just 'always throw'", () => {
  // The positive direction of the construction guard.
  const io = cookiePlatformIO("SWID={abc}; espn_s2=xyz");
  assert.equal(typeof io.get, "function");
});

// ---------------------------------------------------------------------------------------------
// 3. cookiePlatformIO -- transport
//
// `globalThis.fetch` is replaced for the duration of each test and restored in `finally`, including
// when an assertion throws. A leaked fake fetch would silently corrupt every later test in the
// process, which is precisely the kind of cross-contamination that is impossible to attribute later.
// ---------------------------------------------------------------------------------------------

interface Call { url: string; init: RequestInit }

/** Install a fake fetch returning one canned response; returns the captured calls and a restore fn. */
function fakeFetch(res: { ok: boolean; status: number; statusText: string; body: string }) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return { ok: res.ok, status: res.status, statusText: res.statusText, text: async () => res.body };
  }) as unknown as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const headerOf = (init: RequestInit, name: string) => {
  const h = (init.headers ?? {}) as Record<string, string>;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key == null ? undefined : h[key];
};

test("COOKIE IO: a 200 returns the body verbatim", async () => {
  const f = fakeFetch({ ok: true, status: 200, statusText: "OK", body: '{"id":462233,"teams":[{"id":8}]}' });
  try {
    const io = cookiePlatformIO("SWID={abc}; espn_s2=xyz");
    // Verbatim matters: the parsers downstream do their own `JSON.parse`, and an IO that trimmed,
    // re-encoded or "cleaned" the body would be a second implementation of something nobody asked
    // it to implement.
    assert.equal(await io.get(`${ESPN}?view=mTeam`), '{"id":462233,"teams":[{"id":8}]}');
    assert.equal(f.calls.length, 1, "exactly one request per get");
    assert.equal(f.calls[0].url, `${ESPN}?view=mTeam`);
  } finally { f.restore(); }
});

test("COOKIE IO: the COOKIE is actually sent -- the whole reason this provider exists", async () => {
  // Without this assertion the provider could be silently unauthenticated: ESPN would answer the
  // public shape of the league, the body would parse, and the sync would report a successful read
  // of a league it never actually logged into. The header is the only observable difference.
  const f = fakeFetch({ ok: true, status: 200, statusText: "OK", body: "{}" });
  try {
    const io = cookiePlatformIO("  SWID={abc}; espn_s2=xyz  ", { userAgent: "ff-assistant-test" });
    await io.get(`${ESPN}?view=mTeam`);
    const init = f.calls[0].init;
    // Trimmed, because a cookie pasted out of a browser devtools panel usually carries whitespace,
    // and a leading space in a header value is the sort of thing that fails only on some servers.
    assert.equal(headerOf(init, "cookie"), "SWID={abc}; espn_s2=xyz");
    assert.equal(headerOf(init, "user-agent"), "ff-assistant-test");
    assert.ok(String(headerOf(init, "accept")).includes("application/json"), "JSON is asked for by name");
    assert.ok(init.signal, "the request must be abortable, or a hung read hangs the whole sync");
  } finally { f.restore(); }
});

test("COOKIE IO: caller headers are merged, and a user-agent is omitted when not supplied", async () => {
  const f = fakeFetch({ ok: true, status: 200, statusText: "OK", body: "{}" });
  try {
    const io = cookiePlatformIO("SWID={abc}");
    await io.get(`${ESPN}?view=mTeam`, { "x-fantasy-filter": '{"players":{}}' });
    const init = f.calls[0].init;
    // ESPN's player endpoints are driven entirely by `x-fantasy-filter`; an IO that dropped caller
    // headers would return the unfiltered default page and look like a working read.
    assert.equal(headerOf(init, "x-fantasy-filter"), '{"players":{}}');
    assert.equal(headerOf(init, "cookie"), "SWID={abc}", "merging must not lose the cookie");
    assert.equal(headerOf(init, "user-agent"), undefined, "no UA is sent unless one was asked for");
  } finally { f.restore(); }
});

test("COOKIE IO: a 401 THROWS, and the message forbids reading it as an empty league", async () => {
  // THE DEFECT THIS PROVIDER IS BUILT AROUND. The body below is valid JSON and would parse happily;
  // only the status distinguishes "logged out" from "a league with no teams". If this ever returns
  // the body, an expired cookie becomes a league-wide roster wipe with a green log line.
  const f = fakeFetch({ ok: false, status: 401, statusText: "Unauthorized", body: '{"teams":[]}' });
  try {
    const io = cookiePlatformIO("SWID={stale}");
    await assert.rejects(() => io.get(`${ESPN}?view=mRoster`), (e: Error) => {
      assert.ok(e.message.includes("401"), `the status must survive: ${e.message}`);
      assert.ok(/not authenticated/.test(e.message), e.message);
      assert.ok(/do NOT treat this as an empty league/i.test(e.message),
        `the message must name the misreading it is preventing: ${e.message}`);
      assert.ok(/Refresh the cookie/.test(e.message), `and the fix: ${e.message}`);
      return true;
    });
  } finally { f.restore(); }
});

test("COOKIE IO: a 403 is treated as the same authentication failure as a 401", async () => {
  // ESPN uses both for a private league read without a session; a provider that only handled 401
  // would let a 403 through the auth branch into the generic one, where the advice is wrong.
  const f = fakeFetch({ ok: false, status: 403, statusText: "Forbidden", body: '{"teams":[]}' });
  try {
    const io = cookiePlatformIO("SWID={stale}");
    await assert.rejects(() => io.get(`${ESPN}?view=mRoster`), (e: Error) => {
      assert.ok(e.message.includes("403"), e.message);
      assert.ok(/not authenticated/.test(e.message), e.message);
      return true;
    });
  } finally { f.restore(); }
});

test("COOKIE IO: a 500 throws with the STATUS and a BODY EXCERPT", async () => {
  // A server error is a different problem with a different fix (wait and retry, not re-auth), so it
  // carries different evidence: the excerpt is what lets an operator tell a real ESPN outage from a
  // malformed request without re-running anything.
  const f = fakeFetch({
    ok: false, status: 500, statusText: "Internal Server Error",
    body: "ESPN backend unavailable: request id 7f3a",
  });
  try {
    const io = cookiePlatformIO("SWID={abc}");
    await assert.rejects(() => io.get(`${ESPN}?view=mRoster`), (e: Error) => {
      assert.ok(e.message.includes("500"), `the status must survive: ${e.message}`);
      assert.ok(e.message.includes("ESPN backend unavailable"), `the body excerpt must survive: ${e.message}`);
      assert.ok(/body starts/.test(e.message), e.message);
      return true;
    });
  } finally { f.restore(); }
});

test("COOKIE IO: the 401 message and the 500 message DIFFER -- distinguishable failures", async () => {
  // Two failures that produce the same text are one failure with two causes, and an operator facing
  // it has to guess between "refresh the cookie" and "wait for ESPN". This asserts the branch is
  // real: same URL, same provider, different status, materially different message.
  const auth = fakeFetch({ ok: false, status: 401, statusText: "Unauthorized", body: "AUTH-BODY-MARKER" });
  let authMsg = "";
  try {
    await cookiePlatformIO("SWID={x}").get(`${ESPN}?view=mRoster`).catch((e: Error) => { authMsg = e.message; });
  } finally { auth.restore(); }

  const boom = fakeFetch({ ok: false, status: 500, statusText: "Internal Server Error", body: "SERVER-BODY-MARKER" });
  let boomMsg = "";
  try {
    await cookiePlatformIO("SWID={x}").get(`${ESPN}?view=mRoster`).catch((e: Error) => { boomMsg = e.message; });
  } finally { boom.restore(); }

  assert.ok(authMsg && boomMsg, "both requests must have thrown");
  assert.notEqual(authMsg, boomMsg);
  // Specifically: the auth branch gives ADVICE and withholds the body (an auth failure's body is
  // noise and is exactly the thing that gets misread); the error branch gives the BODY and no advice.
  assert.ok(!authMsg.includes("AUTH-BODY-MARKER"), `a 401 body must not be quoted back: ${authMsg}`);
  assert.ok(boomMsg.includes("SERVER-BODY-MARKER"), `a 500 body must be quoted: ${boomMsg}`);
  assert.ok(!/not authenticated/.test(boomMsg), `a 500 must not send anyone to re-auth: ${boomMsg}`);
});

test("COOKIE IO: globalThis.fetch is the real one again after every test above", () => {
  // The guard on the guards. Every test here restores in a `finally`, but a `finally` that was
  // forgotten in a future edit would leak a fake fetch into unrelated tests in the same process,
  // where the failure would be attributed to anything but this file.
  assert.equal(typeof globalThis.fetch, "function");
  assert.ok(!/calls.push/.test(String(globalThis.fetch)), "a fake fetch is still installed");
});
