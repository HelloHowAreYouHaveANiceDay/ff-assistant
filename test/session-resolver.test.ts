/**
 * ONE PLACE DECIDES WHICH SESSION A REQUEST USES.
 *
 * `PlatformIO` was always injectable, but the desktop bridge was named directly at seven call sites,
 * so driving this engine with another browser tool meant editing seven defaults and `--cookie-file`
 * reached 2 verbs out of ~40.
 *
 * TWO PROPERTIES, AND BOTH HAVE TO BE TESTED OR THE MODULE IS THEATRE:
 *
 *   IT STILL DEFAULTS TO THE BRIDGE. Every existing install must behave exactly as before. A
 *   resolver that changed the default would move every number that comes through a session.
 *
 *   IT CAN ACTUALLY RETURN THE OTHERS. A resolver that can only ever hand back the bridge is
 *   indistinguishable from the seven hardcoded calls it replaced -- the dead-lever shape wearing a
 *   new file name. This is the assertion that would have caught "centralized" work that centralized
 *   nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveIO, resolveWriteIO, sessionKind } from "../src/league/session.js";

/** The env this module reads, saved and restored so one test cannot leak into the next. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!;
    }
  }
}

const CLEAN = { FF_SESSION: undefined, FF_SESSION_COOKIE_FILE: undefined };

const cookieFileWith = (text: string): string => {
  const f = join(mkdtempSync(join(tmpdir(), "ff-sess-")), "cookie.txt");
  writeFileSync(f, text);
  return f;
};

test("THE DEFAULT IS THE BRIDGE -- an existing install is unchanged", () => {
  withEnv(CLEAN, () => {
    assert.equal(sessionKind(), "bridge");
    // `via` is the attributable name of the transport, so asserting it is asserting WHICH session
    // was built -- not merely that something was. (An earlier draft of this line compared
    // `resolveIO(...).constructor === Object ? "ok" : "ok"`, which passes on every possible input.)
    assert.equal(resolveWriteIO().via, "the desktop app's authenticated ESPN webview");
  });
});

test("IT CAN RETURN A COOKIE SESSION -- the resolver is not a bridge with extra steps", () => {
  // The positive control. Without this, every assertion above passes on a module that resolves
  // nothing, which is exactly the seven hardcoded calls it was written to replace.
  withEnv(CLEAN, () => {
    const w = resolveWriteIO({ kind: "cookie", cookie: "SWID=abc; espn_s2=def" });
    assert.equal(w.via, "a supplied ESPN cookie");
    assert.notEqual(w.via, resolveWriteIO().via, "the cookie session and the bridge must differ");
  });
});

test("THE ENVIRONMENT can select it, for an agent that cannot pass flags", () => {
  const f = cookieFileWith("SWID=abc; espn_s2=def");
  withEnv({ FF_SESSION: "cookie", FF_SESSION_COOKIE_FILE: f }, () => {
    assert.equal(sessionKind(), "cookie");
    assert.equal(resolveWriteIO().via, "a supplied ESPN cookie");
  });
  // AND IT IS READ AT CALL TIME, not captured at import: the line above and the line below run in
  // the same process against the same module instance. A resolver that cached the environment when
  // it was first imported would still say "cookie" here.
  withEnv(CLEAN, () => assert.equal(sessionKind(), "bridge"));
});

test("A COOKIE FILE ALONE is an unambiguous request for a cookie session", () => {
  const f = cookieFileWith("SWID=abc");
  withEnv({ FF_SESSION: undefined, FF_SESSION_COOKIE_FILE: f }, () => {
    assert.equal(sessionKind(), "cookie", "a cookie file with no FF_SESSION must still select cookie");
  });
});

test("AN EXPLICIT PROVIDER WINS over the environment", () => {
  const io = { get: async () => "supplied" };
  withEnv({ FF_SESSION: "cookie", FF_SESSION_COOKIE_FILE: cookieFileWith("x") }, () => {
    assert.equal(sessionKind({ io }), "supplied");
    assert.equal(resolveIO("espn.com", { io }), io, "a caller-supplied io must be returned verbatim");
  });
});

test("A COOKIE SESSION WITH NO COOKIE THROWS rather than quietly using the app's login", () => {
  // The dangerous silent failure this prevents: a caller asks for a cookie identity, the cookie is
  // missing, and the request goes out as WHOEVER IS LOGGED INTO THE DESKTOP APP. For a write that
  // is acting as the wrong person in somebody's league.
  withEnv(CLEAN, () => {
    assert.throws(() => resolveWriteIO({ kind: "cookie" }), /no cookie was supplied/);
    assert.throws(() => resolveIO("espn.com", { kind: "cookie" }), /no cookie was supplied/);
  });
});

test("AN UNKNOWN FF_SESSION VALUE falls back to the bridge rather than failing closed on a typo", () => {
  // Deliberate, and the opposite of the write allowlist's rule. A misspelled session name should not
  // brick every read verb; it should behave as it always did. The write GUARD is where failing
  // closed matters, and it is unaffected by this.
  withEnv({ FF_SESSION: "chrome", FF_SESSION_COOKIE_FILE: undefined }, () => {
    assert.equal(sessionKind(), "bridge");
  });
});

test("A: the platform's host is readable WITHOUT going through the Electron webview spec", async () => {
  // The change that made a non-Electron consumer possible. `host` used to live on `WebviewSpec`, so
  // two transport call sites read `plat.webview.host` to configure something that is not a webview.
  // The values must be unchanged -- this is a move, not a retune.
  const { platformFor } = await import("../src/league/platform.js");
  const espn = await platformFor("espn");
  const yahoo = await platformFor("yahoo");
  assert.equal(espn.host, "espn.com");
  assert.equal(yahoo.host, "fantasysports.yahoo.com");
  // And the Electron spec is now OPTIONAL, carrying only Electron's own vocabulary.
  assert.equal(espn.webview?.elementId, "espnview");
  assert.equal(yahoo.webview?.elementId, "yahooview");
  assert.ok(!("host" in (espn.webview as object)), "host must no longer live on the webview spec");
});

test("D: the Yahoo adapter does not statically import the Electron bridge", async () => {
  // A Yahoo-only agent should not pull the desktop app into its module graph. Asserted on the
  // SOURCE rather than on behaviour, because a static import has its effect at load time and a
  // behavioural test would happily pass with it present.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/league/yahoo.ts", "utf8");
  const importLines = src.split("\n").filter((l) => /^\s*import .*from ["']/.test(l));
  assert.ok(!importLines.some((l) => l.includes("appBridge")),
    `src/league/yahoo.ts statically imports the app bridge again: ${
      importLines.filter((l) => l.includes("appBridge")).join(" | ")}`);
});
