/**
 * THE WRITE ALLOWLIST, AND THE FACT THAT IT LIVES IN TWO PLACES THAT CANNOT SHARE CODE.
 *
 * Until 2026-09-18 the only thing restricting what this system could write to ESPN was a regex
 * inside `app/main.js`. That guard is real, but it belonged to ONE TRANSPORT: `bridgeWriteTransaction`
 * posts to the app, and the app checks the url. Giving writes a portable provider -- the whole point
 * of a write path an agent outside the desktop app can drive -- would have created a second route to
 * ESPN's write API with no allowlist at all. The safety property was a property of the Electron app,
 * not of the system.
 *
 * `src/league/writeIO.ts` now carries the allowlist, and every provider runs it. The app keeps its
 * own copy as defence in depth: two independent checks, neither relying on the other being right.
 *
 * THEY CANNOT SHARE CODE -- `app/main.js` is plain JavaScript in its own package with its own
 * `node_modules` -- so this file checks them against each other instead. That is the same rule the
 * repo applies wherever a guard is duplicated: derive or compare, never retype and trust.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ESPN_WRITE_URL_PATTERN, MAX_WRITE_BODY, assertWritableUrl,
  cookieWriteIO, recordingWriteIO,
} from "../src/league/writeIO.js";

const OK_URL = "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/462233/transactions";

// ---------------------------------------------------------------------------------------------
// 1. THE TWO COPIES MUST AGREE
// ---------------------------------------------------------------------------------------------

test("the app's allowlist regex is CHARACTER-IDENTICAL to the shared one", () => {
  // If these ever diverge, one transport can write somewhere the other refuses -- and which one you
  // got would depend on whether the desktop app happened to be running. That is the worst kind of
  // safety property: real on the machine you tested and absent on the one you shipped to.
  // ANCHORED ON THE WRITE HOST, not on a generic `^https` -- the first version used a non-greedy
  // `.*?` and matched a DIFFERENT regex earlier in the file (`^https?:\/\/`), then reported the two
  // allowlists as disagreeing. The comparison was invalidated by its own extraction, which is the
  // failure this repo records as "suspect your own pipeline before the artifacts".
  const main = readFileSync("app/main.js", "utf8");
  const line = main.split("\n").find((l) => l.includes("lm-api-writes") && l.includes(".test(String(url))"));
  assert.ok(line, "could not find the app's write allowlist line in app/main.js -- if it moved, point this test at it rather than deleting it");
  const m = /\/(\^https[^\n]*?)\/i\.test\(String\(url\)\)/.exec(line!);
  assert.ok(m, `found the allowlist line but could not extract its regex: ${line!.trim().slice(0, 120)}`);
  const appPattern = m[1];
  const shared = ESPN_WRITE_URL_PATTERN.source;
  assert.equal(appPattern, shared,
    "app/main.js and src/league/writeIO.ts disagree about what may be written. Make them identical.");
});

test("the app's body cap matches the shared one", () => {
  const main = readFileSync("app/main.js", "utf8");
  assert.ok(main.includes("tbody.length > 1e5"),
    "the app's write body cap moved or changed -- the shared MAX_WRITE_BODY must be updated with it");
  assert.equal(MAX_WRITE_BODY, 1e5);
});

// ---------------------------------------------------------------------------------------------
// 2. WHAT THE ALLOWLIST PERMITS, AND WHAT IT MUST NOT
// ---------------------------------------------------------------------------------------------

test("the permitted endpoint is permitted -- the guard can say YES", () => {
  // The positive control. A guard that refuses everything passes every rejection test below and
  // breaks the one feature this path exists to serve, silently, the first time someone sends a trade.
  assert.doesNotThrow(() => assertWritableUrl(OK_URL, "{}"));
  assert.doesNotThrow(() => assertWritableUrl(`${OK_URL}/`, "{}"), "a trailing slash is the same endpoint");
});

test("everything else is REFUSED, by name", () => {
  const refuse: [string, string][] = [
    ["the READS host", OK_URL.replace("lm-api-writes", "lm-api-reads")],
    ["another ESPN path", "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/462233/settings"],
    ["another game", OK_URL.replace("/ffl/", "/fba/")],
    ["a non-numeric league", OK_URL.replace("462233", "abc")],
    ["a different segment", OK_URL.replace("segments/0", "segments/1")],
    ["an entirely different host", "https://evil.example.com/transactions"],
    ["a path-traversal suffix", `${OK_URL}/../settings`],
    ["a query string appended", `${OK_URL}?x=1`],
    ["http rather than https", OK_URL.replace("https://", "http://")],
    ["empty", ""],
  ];
  for (const [why, url] of refuse) {
    assert.throws(() => assertWritableUrl(url, "{}"), /REFUSED to write/, `${why} must be refused: ${url}`);
  }
});

test("an oversized or non-string body is REFUSED", () => {
  assert.throws(() => assertWritableUrl(OK_URL, "x".repeat(MAX_WRITE_BODY + 1)), /over the/);
  assert.throws(() => assertWritableUrl(OK_URL, undefined as unknown as string), /must be a JSON string/);
  assert.doesNotThrow(() => assertWritableUrl(OK_URL, "x".repeat(MAX_WRITE_BODY)), "exactly at the cap is allowed");
});

// ---------------------------------------------------------------------------------------------
// 3. EVERY PROVIDER RUNS THE GUARD -- not the call site
// ---------------------------------------------------------------------------------------------

test("the COOKIE writer refuses a non-allowlisted url BEFORE it reaches the network", async () => {
  // The single most important assertion in this file. This provider exists so an agent outside the
  // desktop app can send a trade; if it could POST anywhere with the user's cookies, it would be a
  // credential-forwarding hole rather than a write path.
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response("", { status: 200 }); }) as typeof fetch;
  try {
    const io = cookieWriteIO("SWID=x; espn_s2=y");
    await assert.rejects(() => io.post("https://evil.example.com/x", "{}"), /REFUSED to write/);
    assert.equal(called, false, "the request must never be issued -- refusing after sending is not refusing");
  } finally { globalThis.fetch = realFetch; }
});

test("the COOKIE writer sends the cookie and returns the status rather than throwing on 4xx", async () => {
  const realFetch = globalThis.fetch;
  let seen: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response("{\"messages\":[\"ineligible\"]}", { status: 403 });
  }) as unknown as typeof fetch;
  try {
    const io = cookieWriteIO("SWID=abc; espn_s2=def");
    const r = await io.post(OK_URL, "{\"x\":1}");
    // A WRITE'S STATUS IS ITS RESULT. Throwing a 403 away loses the body, which is where ESPN puts
    // the reason -- an ineligible player, a locked roster, a passed deadline.
    assert.equal(r.status, 403);
    assert.match(r.body, /ineligible/);
    assert.equal((seen!.init.headers as Record<string, string>).cookie, "SWID=abc; espn_s2=def");
    assert.equal(seen!.init.method, "POST");
    assert.equal(seen!.init.body, "{\"x\":1}");
  } finally { globalThis.fetch = realFetch; }
});

test("the cookie writer refuses to be constructed with no session", () => {
  for (const bad of ["", "   "]) assert.throws(() => cookieWriteIO(bad), /empty cookie/);
});

test("the DRY-RUN writer records and sends NOTHING, and still runs the guard", async () => {
  // Dry run as a provider rather than a flag: a caller handed this cannot send, whatever it does.
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response("", { status: 200 }); }) as typeof fetch;
  try {
    const io = recordingWriteIO();
    const r = await io.post(OK_URL, "{\"a\":1}");
    assert.equal(called, false, "a dry run that touches the network is not a dry run");
    assert.equal(r.status, 0);
    assert.deepEqual(io.sent, [{ url: OK_URL, body: "{\"a\":1}" }]);
    // A rehearsal that skipped the allowlist would rehearse something the real run refuses.
    await assert.rejects(() => io.post("https://evil.example.com/x", "{}"), /REFUSED to write/);
    assert.equal(io.sent.length, 1, "the refused call must not be recorded as sent");
  } finally { globalThis.fetch = realFetch; }
});

test("every provider reports HOW it authenticated", () => {
  // A write nobody can attribute is a write nobody can audit, so `via` is part of the contract and
  // the three must not read alike.
  const vias = [cookieWriteIO("a=b").via, recordingWriteIO().via];
  assert.equal(new Set(vias).size, vias.length, "providers must be distinguishable by `via`");
  assert.match(recordingWriteIO().via, /DRY RUN/);
});
