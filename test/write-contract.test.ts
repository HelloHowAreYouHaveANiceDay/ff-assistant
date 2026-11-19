/** THE WRITE ALLOWLIST (D55): one place, src/league/writeIO.ts, run by every provider incl. broWriteIO BEFORE anything reaches bim. The app-vs-TS agreement tests went with app/; fault-injection tests at the bottom prove broWriteIO refuses without spawning bim. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { broWriteIO } from "../src/league/writeIO.js";
import { setExec } from "../src/browser/broSession.js";
import {
  ESPN_WRITE_URL_PATTERN, MAX_WRITE_BODY, ESPN_WRITE_TYPES, ESPN_WAIVER_EXECUTION_TYPES, ESPN_FREEAGENT_EXECUTION_TYPES, assertWritableUrl,
  cookieWriteIO, recordingWriteIO,
} from "../src/league/writeIO.js";

const OK_URL = "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/462233/transactions";
// A MINIMAL PERMITTED BODY. The guard now checks the OPERATION as well as the endpoint, so a test
// about the url, the size cap or a transport must send a body that clears the operation check --
// otherwise it measures the operation check instead of the thing it names.
const OK_BODY = JSON.stringify({ type: "TRADE_PROPOSAL", isLeagueManager: false, items: [] });

// ---------------------------------------------------------------------------------------------
// 1. THE TWO COPIES MUST AGREE
// ---------------------------------------------------------------------------------------------

test("a LINEUP or other non-permitted body is REFUSED at the permitted url", () => {
  // THE REGRESSION THIS EXISTS FOR. Every body below goes to a url the allowlist permits, because
  // it is the same url a trade uses. Before the operation check they would all have been sent.
  // (WAIVER left this list 2026-09-29 and FREEAGENT 2026-09-30 -- both owner-signed -- and are
  //  policed by executionType below.)
  const url = "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/123456/transactions";
  // (ROSTER left this list 2026-10-14, owner-signed D54 -- policed by executionType + item type below.)
  for (const t of ["FUTURE_ROSTER", "TRADE_ACCEPT", "DRAFT"]) {
    assert.throws(() => assertWritableUrl(url, JSON.stringify({ type: t, items: [] })), /REFUSED to write a/,
      `a ${t} transaction was NOT refused -- ESPN serves it from the permitted url`);
  }
  // A body with no type at all, and one that is not JSON: both fail CLOSED.
  assert.throws(() => assertWritableUrl(url, JSON.stringify({ items: [] })), /REFUSED to write a/);
  assert.throws(() => assertWritableUrl(url, "not json"), /not valid JSON/);
});

test("a WAIVER may only PLACE or CANCEL a claim -- any other executionType is refused", () => {
  const url = "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/123456/transactions";
  for (const et of ["PROCESS", "UPHOLD", "", undefined]) {
    assert.throws(() => assertWritableUrl(url, JSON.stringify({ type: "WAIVER", executionType: et, items: [] })), /REFUSED to write a WAIVER/,
      `a WAIVER with executionType ${String(et)} was NOT refused`);
  }
  // Positive controls: the two it exists to permit.
  for (const et of ESPN_WAIVER_EXECUTION_TYPES) assertWritableUrl(url, JSON.stringify({ type: "WAIVER", executionType: et, items: [] }));
  assert.deepEqual([...ESPN_WAIVER_EXECUTION_TYPES], ["EXECUTE", "CANCEL"]);
});

test("a FREEAGENT may only EXECUTE -- any other executionType is refused", () => {
  const url = "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/123456/transactions";
  for (const et of ["CANCEL", "PROCESS", "", undefined]) {
    assert.throws(() => assertWritableUrl(url, JSON.stringify({ type: "FREEAGENT", executionType: et, items: [] })), /REFUSED to write a FREEAGENT/,
      `a FREEAGENT with executionType ${String(et)} was NOT refused`);
  }
  assertWritableUrl(url, JSON.stringify({ type: "FREEAGENT", executionType: "EXECUTE", items: [] }));
  assert.deepEqual([...ESPN_FREEAGENT_EXECUTION_TYPES], ["EXECUTE"]);
});

test("the ESPN free-agent add body matches what ESPN recorded for our own add, and passes the guard", async () => {
  // Observed: our 2026 wk3 kicker add -- FREEAGENT/EXECUTE, bidAmount 0, ADD+DROP items.
  const { espnPlatform } = await import("../src/league/espnPlatform.js");
  const req = espnPlatform.writes!.freeAgentAdd!({ season: 2026, leagueId: "462233", myTeamId: "8", memberId: "{ABC}", addPlayerId: "4571557", dropPlayerId: "17427", scoringPeriodId: 4 });
  const b = JSON.parse(req.body);
  assert.equal(b.type, "FREEAGENT"); assert.equal(b.executionType, "EXECUTE"); assert.equal(b.bidAmount, 0); assert.equal(b.teamId, 8);
  assert.deepEqual(b.items.map((i: { type: string; playerId: number; fromTeamId: number; toTeamId: number }) => [i.type, i.playerId, i.fromTeamId, i.toTeamId]),
    [["ADD", 4571557, 0, 8], ["DROP", 17427, 8, 0]]);
  assert.equal(req.operation, "FREEAGENT");
  assertWritableUrl(req.url, req.body);
});

test("the permitted operations still go through -- the guard can say yes", () => {
  // A guard that can only ever refuse is indistinguishable from a broken one, and would have
  // silently disabled `ff propose-trade --send` while every negative test above stayed green.
  const url = "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/123456/transactions";
  assertWritableUrl(url, JSON.stringify({ type: "TRADE_PROPOSAL", isLeagueManager: false, items: [] }));
  assertWritableUrl(url, JSON.stringify({ type: "WAIVER", executionType: "EXECUTE", bidAmount: 1, items: [] }));
  assertWritableUrl(url, JSON.stringify({ type: "FREEAGENT", executionType: "EXECUTE", bidAmount: 0, items: [] }));
  assertWritableUrl(url, JSON.stringify({ type: "ROSTER", executionType: "EXECUTE", items: [{ playerId: 1, type: "LINEUP", fromLineupSlotId: 20, toLineupSlotId: 23 }] }));
  assert.deepEqual([...ESPN_WRITE_TYPES], ["TRADE_PROPOSAL", "WAIVER", "FREEAGENT", "ROSTER"],
    "the permitted-operation list changed. That is a decision about what this tool may do to a real " +
    "league -- if it was deliberate, update this assertion deliberately.");
});

test("the ESPN claim and cancel bodies match what ESPN itself records, and pass the guard", async () => {
  // Shapes observed in league 462233's own feed (2025 wk1, team 8): a pending claim is WAIVER/EXECUTE
  // with bidAmount and ADD+DROP items; its withdrawal is WAIVER/CANCEL with relatedTransactionId.
  const { espnPlatform } = await import("../src/league/espnPlatform.js");
  const w = espnPlatform.writes!;
  const ctx = { season: 2026, leagueId: "462233", myTeamId: "13", memberId: "{ABC}", addPlayerId: "4372561", dropPlayerId: "15835", scoringPeriodId: 4 };
  const claim = w.waiverClaim!({ ...ctx, bid: 7 });
  const c = JSON.parse(claim.body);
  assert.equal(c.type, "WAIVER"); assert.equal(c.executionType, "EXECUTE"); assert.equal(c.bidAmount, 7);
  assert.equal(c.teamId, 13); assert.equal(c.scoringPeriodId, 4); assert.equal(c.memberId, "{ABC}");
  assert.deepEqual(c.items.map((i: { type: string; playerId: number; toTeamId: number; fromTeamId: number }) => [i.type, i.playerId, i.fromTeamId, i.toTeamId]),
    [["ADD", 4372561, 0, 13], ["DROP", 15835, 13, 0]]);
  assert.equal(claim.operation, "WAIVER");
  assertWritableUrl(claim.url, claim.body);
  const cancel = w.cancelWaiverClaim!({ ...ctx, claimId: "c8e63ab8" });
  const x = JSON.parse(cancel.body);
  assert.equal(x.executionType, "CANCEL"); assert.equal(x.relatedTransactionId, "c8e63ab8"); assert.equal(x.bidAmount, 0);
  assert.deepEqual(x.items, c.items, "a cancel must carry the same add/drop as the claim it withdraws");
  assertWritableUrl(cancel.url, cancel.body);
  // No drop -> an ADD-only claim.
  assert.equal(JSON.parse(w.waiverClaim!({ ...ctx, dropPlayerId: null, bid: 1 }).body).items.length, 1);
});

test("the permitted endpoint is permitted -- the guard can say YES", () => {
  // The positive control. A guard that refuses everything passes every rejection test below and
  // breaks the one feature this path exists to serve, silently, the first time someone sends a trade.
  assert.doesNotThrow(() => assertWritableUrl(OK_URL, OK_BODY));
  assert.doesNotThrow(() => assertWritableUrl(`${OK_URL}/`, OK_BODY), "a trailing slash is the same endpoint");
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
  // EXACTLY AT THE CAP, and still a valid permitted operation -- padded to the byte with filler so
  // this tests the SIZE boundary rather than tripping the operation check on the way past it.
  const pad = MAX_WRITE_BODY - JSON.stringify({ type: "TRADE_PROPOSAL", pad: "" }).length;
  const atCap = JSON.stringify({ type: "TRADE_PROPOSAL", pad: "x".repeat(pad) });
  assert.equal(atCap.length, MAX_WRITE_BODY, "the padded body is not exactly at the cap");
  assert.doesNotThrow(() => assertWritableUrl(OK_URL, atCap), "exactly at the cap is allowed");
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
    const r = await io.post(OK_URL, OK_BODY);
    // A WRITE'S STATUS IS ITS RESULT. Throwing a 403 away loses the body, which is where ESPN puts
    // the reason -- an ineligible player, a locked roster, a passed deadline.
    assert.equal(r.status, 403);
    assert.match(r.body, /ineligible/);
    assert.equal((seen!.init.headers as Record<string, string>).cookie, "SWID=abc; espn_s2=def");
    assert.equal(seen!.init.method, "POST");
    assert.equal(seen!.init.body, OK_BODY, "the transport must forward the body verbatim");
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
    const r = await io.post(OK_URL, OK_BODY);
    assert.equal(called, false, "a dry run that touches the network is not a dry run");
    assert.equal(r.status, 0);
    assert.deepEqual(io.sent, [{ url: OK_URL, body: OK_BODY }]);
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

// ---------------------------------------------------------------------------------------------
// broWriteIO: the guard runs FIRST. Each case injects an exec that records calls and asserts it was
// NEVER called -- a refusal that still spawned `bim` would have already sent the write.
// ---------------------------------------------------------------------------------------------
async function refusedWithoutBim(url: string, body: string, re: RegExp): Promise<void> {
  const calls: string[][] = [];
  setExec(async (_f, args) => { calls.push(args); return { stdout: "{}", stderr: "" }; });
  try {
    await assert.rejects(() => broWriteIO().post(url, body), re);
    assert.equal(calls.length, 0, "a refused write must not spawn bim");
  } finally { setExec(null); }
}

test("broWriteIO refuses a non-allowlisted URL without spawning bim", async () => {
  await refusedWithoutBim("https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/462233/transactions", OK_BODY, /REFUSED to write to/);
  await refusedWithoutBim("https://evil.example.com/transactions", OK_BODY, /REFUSED to write to/);
});

test("broWriteIO refuses a FREEAGENT CANCEL without spawning bim", async () => {
  await refusedWithoutBim(OK_URL, JSON.stringify({ type: "FREEAGENT", executionType: "CANCEL", items: [] }), /REFUSED to write a FREEAGENT/);
});

test("broWriteIO refuses a ROSTER body carrying an ADD item without spawning bim", async () => {
  await refusedWithoutBim(OK_URL, JSON.stringify({ type: "ROSTER", executionType: "EXECUTE", items: [{ type: "ADD", playerId: 1 }] }), /REFUSED to write a ROSTER item/);
});

test("broWriteIO refuses an oversize body without spawning bim", async () => {
  await refusedWithoutBim(OK_URL, "x".repeat(MAX_WRITE_BODY + 1), /over the .* cap/);
});

test("broWriteIO sends a permitted body through bim bro page eval and returns the status", async () => {
  const calls: string[][] = [];
  setExec(async (_f, args) => {
    calls.push(args);
    if (args[1] === "sessions") return { stdout: JSON.stringify({ sessions: [{ site: "espn", alive: true }] }), stderr: "" };
    if (args[1] === "page" && args.includes("tabs")) return { stdout: JSON.stringify({ tabs: [{ id: "T1", url: "https://fantasy.espn.com/football/" }] }), stderr: "" };
    return { stdout: JSON.stringify({ value: JSON.stringify({ status: 403, statusText: "Forbidden", body: "nope" }) }), stderr: "" };
  });
  try {
    const r = await broWriteIO().post(OK_URL, OK_BODY);
    assert.deepEqual(r, { status: 403, body: "nope" });          // a 403 is a RESULT, not a throw
    const ev = calls.find((a) => a.includes("eval"))!;
    assert.ok(ev.includes("--tab") && ev.includes("T1"));
    assert.ok(ev[ev.indexOf("--arg") + 1].includes(OK_URL));
  } finally { setExec(null); }
});
