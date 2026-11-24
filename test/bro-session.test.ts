/**
 * The bro transport (D55): host allowlist, argv-not-shell, tab retry, NotLoggedIn. `bim` is never
 * run: every case injects the exec function.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { broFetch, broPost, siteForUrl, siteForHost, setExec, NotLoggedIn, type ExecFn } from "../src/browser/broSession.js";

const ESPN = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/462233?view=mRoster";

function fake(opts: { live?: boolean; status?: number; statusText?: string; body?: string; evalFailsOnce?: boolean } = {}) {
  const calls: { file: string; args: string[] }[] = [];
  let evalFailed = false;
  const fn: ExecFn = async (file, args) => {
    calls.push({ file, args });
    if (args[1] === "session" && args[2] === "list") return { stdout: JSON.stringify({ sessions: opts.live === false ? [] : [{ site: "espn", alive: true }] }), stderr: "" };
    if (args[1] === "session") return { stdout: "{}", stderr: "" };
    if (args[2] === "open") return { stdout: "{}", stderr: "" };
    if (args.includes("tabs")) return { stdout: JSON.stringify({ tabs: [{ id: "TAB1", url: "https://fantasy.espn.com/football/" }] }), stderr: "" };
    if (args.includes("eval")) {
      if (opts.evalFailsOnce && !evalFailed) { evalFailed = true; throw new Error("tab died"); }
      return { stdout: JSON.stringify({ value: JSON.stringify({ status: opts.status ?? 200, statusText: opts.statusText ?? "OK", body: opts.body ?? "{}" }) }), stderr: "" };
    }
    return { stdout: "{}", stderr: "" };
  };
  setExec(fn);
  return calls;
}

test("host allowlist: parsed hostname, https only, default port, no userinfo, dot boundary", () => {
  assert.equal(siteForUrl(ESPN), "espn");
  assert.equal(siteForUrl("https://espn.com/x"), "espn");
  assert.equal(siteForUrl("https://LM-API-READS.FANTASY.ESPN.COM/x"), "espn");
  for (const bad of [
    "http://fantasy.espn.com/x", "https://espn.com.evil.test/x", "https://notespn.com/x",
    "https://example.com/?u=https://fantasy.espn.com/", "https://user:pw@fantasy.espn.com/x",
    "https://fantasy.espn.com:8443/x", "not a url", "", "https://fantasysports.yahoo.com/f1/129048",
  ]) assert.equal(siteForUrl(bad), null, bad);
});

test("an off-allowlist URL is refused BEFORE any bim call", async () => {
  const calls = fake();
  try {
    await assert.rejects(() => broFetch("https://espn.com.evil.test/x"), /REFUSED/);
    await assert.rejects(() => broPost("https://example.com/x", "{}"), /REFUSED/);
    assert.equal(calls.length, 0);
  } finally { setExec(null); }
});

test("Yahoo is refused by name", () => {
  assert.throws(() => siteForHost("fantasysports.yahoo.com"), /Yahoo not supported/);
  assert.equal(siteForHost("espn.com"), "espn");
});

test("argv array, never a shell string; the URL is JSON-embedded, not concatenated", async () => {
  const evil = "https://fantasy.espn.com/x?q=\");alert(1);//";
  const calls = fake({ body: "ok" });
  try {
    assert.equal(await broFetch(evil), "ok");
    const ev = calls.find((c) => c.args.includes("eval"))!;
    assert.equal(ev.file, "bim");
    assert.ok(Array.isArray(ev.args));
    const js = ev.args[ev.args.indexOf("--arg") + 1];
    assert.ok(js.includes(JSON.stringify(evil)), "url must be JSON.stringify-injected");
    assert.ok(ev.args.includes("--tab") && ev.args.includes("TAB1"));
  } finally { setExec(null); }
});

test("a stopped session is started on demand (--detach, bare flag)", async () => {
  const calls = fake({ live: false });
  try {
    await broFetch(ESPN);
    const start = calls.find((c) => c.args[2] === "launch")!;
    assert.deepEqual(start.args, ["bro", "session", "launch", "--site", "espn", "--detach"]);
  } finally { setExec(null); }
});

test("non-2xx on a read throws '<status> <statusText> for <url>'", async () => {
  fake({ status: 404, statusText: "Not Found" });
  try { await assert.rejects(() => broFetch(ESPN), (e: Error) => e.message === `404 Not Found for ${ESPN}`); } finally { setExec(null); }
});

test("a POST never throws on non-2xx: the status is the result", async () => {
  fake({ status: 403, statusText: "Forbidden", body: "reason" });
  try { assert.deepEqual(await broPost("https://lm-api-writes.fantasy.espn.com/x", "{}"), { status: 403, body: "reason" }); } finally { setExec(null); }
});

test("401 -> NotLoggedIn with the exact owner action", async () => {
  fake({ status: 401, statusText: "Unauthorized" });
  try {
    await assert.rejects(() => broFetch(ESPN), (e: Error) => e instanceof NotLoggedIn && /bim bro auth --site espn/.test(e.message));
  } finally { setExec(null); }
});

test("a dead tab is re-ensured and retried once", async () => {
  const calls = fake({ evalFailsOnce: true, body: "{\"a\":1}" });
  try {
    assert.equal(await broFetch(ESPN), "{\"a\":1}");
    assert.equal(calls.filter((c) => c.args.includes("eval")).length, 2);
    assert.equal(calls.filter((c) => c.args[2] === "list").length, 2, "re-ensure runs again");
  } finally { setExec(null); }
});
