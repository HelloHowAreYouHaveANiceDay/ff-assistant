/**
 * THE ADAPTER CONTRACT, AND THE THING THAT KEEPS IT HONEST.
 *
 * `PLATFORM_CONTRACT` tells an author what to implement. A list like that is a snapshot of the day
 * it was written: add a method to `interface Platform` and the list keeps passing while quietly
 * describing a contract that no longer exists -- coverage-by-enumeration, which this repo has paid
 * for repeatedly.
 *
 * So the first test does not trust it. It reads the INTERFACE DECLARATION out of
 * `src/league/platform.ts` and asserts the two name exactly the same members, in both directions.
 * That is the same rule the write allowlist follows: compare against what the other side publishes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PLATFORM_CONTRACT, checkPlatformShape, describeContract, describeShape,
} from "../src/league/platformContract.js";
import { KNOWN_PLATFORMS, platformFor } from "../src/league/platform.js";

/** The members of `interface Platform`, read from the source that declares it. */
function interfaceMembers(): { name: string; optional: boolean }[] {
  const src = readFileSync("src/league/platform.ts", "utf8");
  const start = src.indexOf("export interface Platform {");
  assert.ok(start >= 0, "could not find `export interface Platform {` -- if it moved or was renamed, point this test at it rather than deleting it");
  const end = src.indexOf("\n}", start);
  assert.ok(end > start, "could not find the end of the Platform interface");
  const body = src.slice(start, end);
  const out: { name: string; optional: boolean }[] = [];
  for (const line of body.split("\n").slice(1)) {
    // A member line: optional `readonly`, a name, an optional `?`, then `:` or `(`. Comments and
    // blank lines are skipped, and so is anything indented deeper than one level (nested types).
    const m = /^ {2}(?:readonly )?([A-Za-z][A-Za-z0-9_]*)(\??)\s*[(:]/.exec(line);
    if (m) out.push({ name: m[1], optional: m[2] === "?" });
  }
  return out;
}

test("the contract names EXACTLY the members the interface declares", () => {
  const declared = interfaceMembers();
  assert.ok(declared.length >= 8, `only parsed ${declared.length} members -- the parser has probably drifted from the source format`);

  const inContract = new Set(PLATFORM_CONTRACT.map((m) => m.name));
  const inInterface = new Set(declared.map((m) => m.name));

  const undocumented = [...inInterface].filter((n) => !inContract.has(n));
  assert.deepEqual(undocumented, [],
    `interface Platform declares member(s) the adapter contract never mentions: ${undocumented.join(", ")}. ` +
    "An author reading PLATFORM_CONTRACT would not know to implement them. Add them to src/league/platformContract.ts.");

  const stale = [...inContract].filter((n) => !inInterface.has(n));
  assert.deepEqual(stale, [],
    `the adapter contract describes member(s) the interface no longer has: ${stale.join(", ")}. ` +
    "An author would implement something nothing calls.");
});

test("required vs optional agrees with the interface's own `?`", () => {
  // The distinction that decides whether a caller may assume a capability. If the contract says a
  // member is required and the interface marks it optional, an author writes more than they must --
  // and, worse, a CALLER may assume it is always there.
  const declared = new Map(interfaceMembers().map((m) => [m.name, m.optional]));
  for (const m of PLATFORM_CONTRACT) {
    const optionalInSource = declared.get(m.name);
    assert.equal(m.required, optionalInSource === false,
      `${m.name}: the contract says ${m.required ? "REQUIRED" : "optional"} but the interface declares it ${optionalInSource ? "optional" : "required"}`);
  }
});

test("REAL ADAPTORS: espn and yahoo both pass, and report their capabilities honestly", async () => {
  for (const id of KNOWN_PLATFORMS) {
    const p = await platformFor(id);
    const r = checkPlatformShape(p);
    assert.ok(r.ok, `${id} fails the contract it is registered under:\n${describeShape(r)}`);
    // Every optional member must land in exactly one of the two buckets -- a capability that is
    // neither implemented nor declined is a capability nobody can reason about.
    const optional = PLATFORM_CONTRACT.filter((m) => !m.required).map((m) => m.name);
    for (const name of optional) {
      const inOne = r.capabilities.includes(name) !== r.declined.includes(name);
      assert.ok(inOne, `${id}: optional member ${name} is in neither bucket, or both`);
    }
  }
});

test("A HALF-BUILT ADAPTER IS REJECTED, and the message NAMES what is missing", () => {
  // The whole point. An author registering something incomplete should be told which members are
  // absent, not handed a type error or a runtime failure three layers down.
  const partial = { id: "sleeper", host: "sleeper.app", discover: async () => [] };
  const r = checkPlatformShape(partial);
  assert.equal(r.ok, false, "an adaptor missing syncSettings/syncRosters/readTeam/urls must NOT pass");
  const named = r.missing.map((m) => m.name).sort();
  assert.deepEqual(named, ["readTeam", "syncRosters", "syncSettings", "urls"],
    "the report must name every missing required member, not just the first");
  // And each one carries WHAT IT IS FOR, so the author can act on the message alone.
  for (const m of r.missing) assert.ok(m.why.length > 20, `${m.name}'s explanation is too thin to act on: ${m.why}`);
  // The optional ones it did not implement are DECLINED, not missing -- that distinction is the
  // difference between "you forgot this" and "you chose not to, and callers must refuse it by name".
  assert.ok(r.declined.includes("rosterWeek"));
  assert.ok(r.declined.includes("webview"), "a platform that does not run in Electron is legal");
});

test("a PROPERTY supplied as a function, and a method supplied as a value, are both caught", () => {
  // The plausible-looking mistake: `host` as a getter-style function, or `discover` as a value.
  // Both satisfy a naive `in` check and neither works.
  const wrong = {
    id: "x", host: () => "x.com", urls: {}, discover: "not a function",
    syncSettings: async () => ({}), syncRosters: async () => [], readTeam: async () => ({}),
  };
  const r = checkPlatformShape(wrong);
  const named = r.missing.map((m) => m.name).sort();
  assert.deepEqual(named, ["discover", "host"]);
  assert.match(r.missing.find((m) => m.name === "host")!.why, /is a function, expected a value/);
  assert.match(r.missing.find((m) => m.name === "discover")!.why, /is a string, expected a function/);
});

test("the checker SAYS WHAT IT CANNOT SEE", () => {
  // A checker that implies more than it verifies is worse than none: an author would read a pass as
  // "my adaptor works". It is structural, it never calls anything, and the report says so.
  const r = checkPlatformShape({});
  assert.ok(r.limits.length > 0);
  assert.match(describeShape(r), /STRUCTURAL ONLY/);
  assert.match(describeShape(r), /does NOT call them/i);
});

test("the human-readable contract carries the traps, not just the member names", () => {
  const text = describeContract();
  for (const m of PLATFORM_CONTRACT) {
    assert.ok(text.includes(m.name), `${m.name} is missing from the printed contract`);
  }
  // The traps are the part an author cannot derive from the type signature, so their presence is
  // the difference between a checklist and a contract.
  assert.match(text, /NEVER default/);
  assert.match(text, /TRAP:/);
});

test("KNOWN_PLATFORMS is DERIVED from the registry, not retyped beside it", async () => {
  // It was `["espn", "yahoo"]`, hand-written. The existing check iterates KNOWN_PLATFORMS and
  // confirms each resolves -- ONE-DIRECTIONAL, so a registry entry missing from the list was
  // invisible, and the symptom would have been a registered platform silently absent from the app's
  // league tabs. This asserts the other direction: every registered adaptor appears.
  const { platformFor: pf } = await import("../src/league/platform.js");
  for (const id of KNOWN_PLATFORMS) assert.equal((await pf(id)).id, id);

  // The registry's own keys, read from the source that declares them -- the list cannot be checked
  // against itself, and REGISTRY is not exported.
  const src = readFileSync("src/league/platform.ts", "utf8");
  const block = src.slice(src.indexOf("const REGISTRY"), src.indexOf("]);", src.indexOf("const REGISTRY")));
  const keys = [...block.matchAll(/\["([a-z0-9_-]+)",\s*async/gi)].map((m) => m[1]);
  assert.ok(keys.length >= 2, `parsed only ${keys.length} registry keys -- the parser has drifted`);
  assert.deepEqual([...KNOWN_PLATFORMS].sort(), keys.sort(),
    "KNOWN_PLATFORMS and REGISTRY disagree. Derive the list from the registry rather than maintaining both.");
});

test("the refusal for an unknown platform points at the contract", async () => {
  // The refusal is where an author discovers their site is unsupported, so it is where they should
  // learn what supporting it takes.
  await assert.rejects(() => platformFor("sleeper"), (e: Error) => {
    assert.match(e.message, /no platform adaptor for "sleeper"/);
    assert.match(e.message, /platform-contract/, "the refusal must name the command that explains the contract");
    return true;
  });
});
