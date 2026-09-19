/**
 * BARE POSITIONALS IN argv, AND THE FLAG VALUES THEY KEPT SWALLOWING.
 *
 * Found in a bug bash. `ff copilot depth-risk --week 2` answered:
 *
 *   "2" is not on our roster -- he is on HMLS.
 *
 * The scan for the bare player name was `rest.filter((r) => !r.startsWith("--"))[0]`, which reads
 * "the first token that is not a flag". A flag's VALUE is not a flag, so it returned "2" -- and the
 * name resolver then fuzzy-matched that to a real person on another team. A documented flag broke
 * the verb and the error blamed somebody nobody had typed, which is worse than failing.
 *
 * THE SAME COMMAND HAD IT TWICE: `ff copilot --week 2 lineup` resolved the VERB to "2" and silently
 * printed usage.
 *
 * AND IT WAS A KNOWN BUG. `cmdIngestSource` carries a comment describing the identical defect
 * (`--seasons 2018-2026` read as the asset id) next to its fix. It was fixed there, fixed in
 * `ff ingest-raw`, and missed everywhere else -- the fix-two-of-three-callers shape this repo
 * records. The rule now lives once in `src/util/argv.ts` and every scan calls it.
 *
 * These tests exercise THAT function, not a copy of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { positionals, firstPositional } from "../src/util/argv.js";

/** The copilot's own set, read from the source that declares it -- a test describing a stale set
 *  would pass while the real parser used a different one. */
function copilotValueFlags(): Set<string> {
  const src = readFileSync("src/ff.ts", "utf8");
  const i = src.indexOf("const COPILOT_VALUE_FLAGS = new Set([");
  assert.ok(i >= 0, "could not find COPILOT_VALUE_FLAGS in src/ff.ts -- if it moved, point this test at it rather than deleting it");
  const flags = [...src.slice(i, src.indexOf("]);", i)).matchAll(/"(--[a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(flags.length >= 10, `parsed only ${flags.length} copilot value flags -- the parser has drifted from the source format`);
  return new Set(flags);
}

const VF = copilotValueFlags();

test("A FLAG'S VALUE IS NEVER A POSITIONAL -- the bug, for every flag that takes one", () => {
  assert.equal(firstPositional(["depth-risk", "--week", "2"], VF), "depth-risk",
    "only the verb should remain; the value of --week must not be a positional");
  for (const f of VF) {
    const got = positionals(["depth-risk", f, "somevalue"], VF);
    assert.deepEqual(got, ["depth-risk"], `the value of ${f} was taken as a positional`);
  }
});

test("A REAL POSITIONAL STILL RESOLVES -- in every order", () => {
  // The half that matters more: a scan that only ever returns the verb would pass every assertion
  // above while silently disabling the calling convention it exists to support.
  const player = (argv: string[]) => positionals(argv, VF).filter((t) => t !== "depth-risk")[0];
  assert.equal(player(["depth-risk", "Breece Hall"]), "Breece Hall");
  assert.equal(player(["depth-risk", "--week", "2", "Breece Hall"]), "Breece Hall",
    "a positional AFTER a value flag must still be found");
  assert.equal(player(["depth-risk", "Breece Hall", "--week", "2"]), "Breece Hall",
    "a positional BEFORE a value flag must still be found");
  assert.equal(player(["depth-risk", "--json", "Breece Hall"]), "Breece Hall",
    "a BOOLEAN flag consumes nothing, so the token after it IS a positional");
  assert.equal(player(["depth-risk", "--free", "--json", "Breece Hall"]), "Breece Hall");
});

test("THE VERB IS FOUND even when a flag comes first", () => {
  // `ff copilot --week 2 lineup` used to resolve the verb to "2" and print usage.
  assert.equal(firstPositional(["--week", "2", "lineup"], VF), "lineup");
  assert.equal(firstPositional(["--json", "lineup"], VF), "lineup");
  assert.equal(firstPositional(["lineup", "--week", "2"], VF), "lineup");
});

test("a token that LOOKS like a number is a positional when it is not a flag's value", () => {
  // The fix must not make a legitimate bare value unreachable.
  assert.deepEqual(positionals(["depth-risk", "--week", "2", "2"], VF), ["depth-risk", "2"]);
});

test("an EMPTY value-flag set degrades to the old behaviour -- so the set is load-bearing", () => {
  // Proof that the caller's set is what does the work. With no flags declared, "2" comes back as a
  // positional exactly as the buggy version did. This is why each caller's set is checked against
  // its usage text rather than assumed complete.
  assert.deepEqual(positionals(["depth-risk", "--week", "2"], new Set()), ["depth-risk", "2"]);
});

test("COPILOT_VALUE_FLAGS covers every value-taking flag the usage text documents", () => {
  // The enumeration hazard. A flag added to the CLI and not added to the set reopens the bug for
  // that flag alone -- which is precisely how this survived being fixed twice already. Checked
  // against the usage text, which is the contract the verb publishes to its caller.
  const src = readFileSync("src/ff.ts", "utf8");
  // The usage line is BUILT from VERB_OF, so the anchor is the literal prefix that survives that.
  const i = src.indexOf("usage: ff copilot <${Object.keys(VERB_OF)");
  assert.ok(i >= 0, "could not find the copilot usage text -- if it moved, point this test at it rather than deleting it");
  const usage = src.slice(i, src.indexOf("return;", i));
  const documented = [...usage.matchAll(/(--[a-z-]+)\s+(?:N\b|"Name"|"[A-Z],[A-Z]"|"[A-Z]"|<id>|[A-Z]{2},[A-Z]{2}|[a-z]+\|[a-z]+|0\.\d+)/g)]
    .map((m) => m[1]);
  const missing = [...new Set(documented)].filter((f) => !VF.has(f));
  assert.deepEqual(missing, [],
    "these flags take a value per the usage text but are absent from COPILOT_VALUE_FLAGS, so their " +
    `value can still be mistaken for a positional: ${missing.join(", ")}`);
});

test("NO NAIVE POSITIONAL SCAN SURVIVES in a verb that takes value flags", () => {
  // The fix-two-of-three guard. `rest.find((a) => !a.startsWith("--"))` is the buggy idiom; it is
  // banned outright, because deciding case by case is what left three of them in place.
  const src = readFileSync("src/ff.ts", "utf8");
  const naive = src.split("\n")
    .map((l, n) => ({ l, n: n + 1 }))
    .filter(({ l }) => /\.(find|filter)\(\([a-z]\) => !\1?\.startsWith\("--"\)\)/.test(l)
      || /\.(find|filter)\(\(([a-z])\) => !\2\.startsWith\("--"\)\)/.test(l))
    .filter(({ l }) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
  assert.deepEqual(naive.map((x) => `ff.ts:${x.n}`), [],
    "a naive positional scan is back. Use firstPositional/positionals from src/util/argv.ts with " +
    "that verb's value-taking flags:\n" + naive.map((x) => `  ff.ts:${x.n}: ${x.l.trim()}`).join("\n"));
});
