/**
 * A PLATFORM ID THAT IS GUARANTEED NOT TO HAVE AN ADAPTOR.
 *
 * WHY THIS EXISTS. Seven tests used `"sleeper"` as their stand-in for "a platform with no adaptor",
 * because on the day they were written it was a plausible fantasy site this repo did not support.
 * On 2026-09-20 a Sleeper adaptor landed, and all seven failed at once -- each of them asserting
 * that a real, registered platform is unknown.
 *
 * That is the same rot this repo keeps paying for in a new costume: a guard keyed on a NAME, where
 * the name was chosen for being absent and nothing noticed when it became present. The fix is not
 * to pick a different real-sounding site -- that is the same bet again, and the next adaptor collects
 * on it. It is to use a name that CANNOT become an adaptor, and to ASSERT that it has not, so the
 * day someone proves this wrong the failure says so in one line instead of seven.
 */
import assert from "node:assert/strict";
import { isRegisteredPlatform } from "../../src/league/platform.js";

/** Deliberately not a real product. If this ever becomes a fantasy platform, rename it. */
export const UNKNOWN_PLATFORM = "not-a-fantasy-platform";

/** Call once per test that depends on the id being unregistered. Cheap, and it fails LOUDLY and
 *  specifically rather than as a confusing "expected a refusal, got a result" three asserts later. */
export function assertUnregistered(id: string = UNKNOWN_PLATFORM): string {
  assert.equal(
    isRegisteredPlatform(id), false,
    `"${id}" is meant to be a platform with NO adaptor, but the registry has one. ` +
    "This test asserts a refusal, so a registered id makes it assert something false. Pick another id.",
  );
  return id;
}
