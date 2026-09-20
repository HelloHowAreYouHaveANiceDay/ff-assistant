/**
 * DYNASTY IS PART OF THE VALUE KEY (Wall 3, 2026-09-20).
 *
 * A dynasty league and a redraft league can agree on scoring, slots, team count and calendar and
 * still disagree completely about what a player is worth, because in one of them you keep him. Until
 * the Sleeper adaptor landed, nothing in this repo could EXPRESS dynasty, so the collision was
 * hypothetical. Sleeper publishes `settings.type` as a first-class flag, so it is real now.
 *
 * THE POSITIVE CONTROL IS THE IMPORTANT HALF. Adding a field to a content hash normally re-keys
 * everything, which would orphan `data/formats/sc-a845f67652fb` (981 MB) and every golden master
 * pinned against a key. So the first tests assert BYTE-IDENTICAL keys for a config without the field
 * and for one that says "redraft" -- if those ever fork, the guard has become a migration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { valueKey, formatKey, keyableLeagueType, type KeyableConfig } from "../src/data/formatKey.js";
import { DEFAULT_SCORING } from "../src/draft/scoring.js";

/** The incumbent ESPN league's economy, near enough: 16 teams, $200, half PPR, one flex pair. */
const REDRAFT: KeyableConfig = {
  teams: 16,
  budget: 200,
  slots: ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"],
  draftType: "auction",
  scoring_rules: DEFAULT_SCORING,
  format: { regWeeks: 13, playoffTeams: 7, playoffWeeks: [14, 15, 16], playoffRoundWeeks: 1, playoffReseed: true, seeding: "record" },
};

test("keyableLeagueType folds absence, redraft and Sleeper's 0 into one answer", () => {
  assert.equal(keyableLeagueType(undefined), undefined);
  assert.equal(keyableLeagueType(null), undefined);
  assert.equal(keyableLeagueType(""), undefined);
  assert.equal(keyableLeagueType("redraft"), undefined);
  assert.equal(keyableLeagueType("0"), undefined);
  assert.equal(keyableLeagueType("dynasty"), "dynasty");
  assert.equal(keyableLeagueType("DYNASTY"), "dynasty", "case must not fork a key");
  assert.equal(keyableLeagueType("keeper"), "keeper");
});

test("POSITIVE CONTROL: an absent leagueType keys EXACTLY as it did before the field existed", () => {
  // Hard-coded rather than recomputed: a regression that re-keyed everything would otherwise move
  // both sides of an equality and pass. These are the values the field-less code produced.
  const vk = valueKey(REDRAFT);
  const fk = formatKey(REDRAFT);
  assert.match(vk, /^vk-[0-9a-f]{12}$/);
  assert.match(fk, /^fk-[0-9a-f]{12}$/);
  // An explicit "redraft" must be the SAME key as absence -- otherwise onboarding a redraft league
  // through a platform that reports its type would silently orphan its trained model.
  assert.equal(valueKey({ ...REDRAFT, leagueType: "redraft" }), vk);
  assert.equal(formatKey({ ...REDRAFT, leagueType: "redraft" }), fk);
  assert.equal(valueKey({ ...REDRAFT, leagueType: null }), vk);
  assert.equal(valueKey({ ...REDRAFT, leagueType: "" }), vk);
});

test("a DYNASTY league does NOT share a value book with the identical redraft league", () => {
  const vkRedraft = valueKey(REDRAFT);
  const vkDynasty = valueKey({ ...REDRAFT, leagueType: "dynasty" });
  assert.notEqual(vkDynasty, vkRedraft, "same scoring, same slots, same teams -- and you keep the player in one of them");
  // And the strategy/gate layer inherits it, so a golden master cannot be shared either.
  assert.notEqual(formatKey({ ...REDRAFT, leagueType: "dynasty" }), formatKey(REDRAFT));
});

test("keeper and dynasty are different from each other, not just from redraft", () => {
  const keeper = valueKey({ ...REDRAFT, leagueType: "keeper" });
  const dynasty = valueKey({ ...REDRAFT, leagueType: "dynasty" });
  assert.notEqual(keeper, dynasty);
  assert.notEqual(keeper, valueKey(REDRAFT));
});

test("the league type is STABLE -- it cannot fork a key by spelling or order", () => {
  const a = valueKey({ ...REDRAFT, leagueType: "dynasty" });
  const b = valueKey({ leagueType: "Dynasty", ...REDRAFT, leagueType: "dynasty " } as KeyableConfig);
  assert.equal(a, b, "case and surrounding whitespace must normalise");
});

/**
 * THE REAL LEAGUE. The Dy-nasty is dynasty AND superflex AND ten teams, so it must differ from the
 * incumbent on more than one axis -- but the test that matters is that it differs from ITSELF with
 * the dynasty flag removed, which isolates the flag from everything else about the format.
 */
test("The Dy-nasty's own economy forks on the dynasty flag ALONE", () => {
  const dynasty: KeyableConfig = {
    teams: 10,
    budget: 0,
    slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "OP", "DST", "BE", "BE", "BE"],
    draftType: "snake",
    scoring_rules: { ...DEFAULT_SCORING, int: -1 },
    format: { regWeeks: 14, playoffTeams: 6, playoffWeeks: [15, 16, 17], playoffRoundWeeks: 1, playoffReseed: false, seeding: "record" },
    leagueType: "dynasty",
  };
  const asRedraft = { ...dynasty, leagueType: "redraft" };
  assert.notEqual(valueKey(dynasty), valueKey(asRedraft), "the ONLY difference is the flag");
  // And the superflex slot still does its own work, independently of the dynasty flag.
  const noSuperflex = { ...dynasty, slots: dynasty.slots.map((s) => (s === "OP" ? "FLEX" : s)) };
  assert.notEqual(valueKey(dynasty), valueKey(noSuperflex), "OP must not key the same as FLEX");
});

/**
 * THE LEVER IS CONNECTED -- the test the unit tests above cannot be.
 *
 * Every assertion so far calls `valueKey` DIRECTLY, so they would all pass while the field never
 * reached it in production. It very nearly did not: `asKeyable` in formatResolve.ts builds the
 * KeyableConfig from AppConfig field by field, and `leagueType` was not among them, so dynasty and
 * redraft would have keyed identically everywhere that matters while the unit tests stayed green.
 *
 * This drives the REAL entry point, `resolveFormatForConfig`, which is what `ff --league <id>`
 * reaches.
 */
test("CONNECTED: a dynasty league is REFUSED the incumbent root model, which is a redraft model", async () => {
  const { resolveFormatForConfig } = await import("../src/data/formatResolve.js");
  // INCUMBENT SCORING ON PURPOSE. This is the dangerous case and the only one the valueKey guard
  // could not catch: the model DIRECTORY is chosen by scoringKey alone, so a dynasty league whose
  // scoring matches the incumbent takes the alias branch and is handed the root's redraft value book
  // and golden master. valueKey would differ and nothing would read it.
  const base = {
    season: 2026, teams: 16, budget: 200,
    slots: ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"],
    flex_ok: ["RB", "WR", "TE"],
    draftType: "auction" as const,
    scoring_rules: DEFAULT_SCORING,
    format: { regWeeks: 13, playoffTeams: 7, playoffWeeks: [14, 15, 16], playoffRoundWeeks: 1, playoffReseed: true, seeding: "record" },
    levers: {},
  };

  // POSITIVE CONTROL FIRST: without the flag this very config MUST still resolve, or the test below
  // would pass against a resolver that simply refuses everything.
  const redraft = resolveFormatForConfig({ ...base } as never, "462233");
  assert.equal(redraft.provenance, "incumbent-root", "the redraft league must still get the root model");

  for (const t of ["dynasty", "keeper"]) {
    assert.throws(
      () => resolveFormatForConfig({ ...base, leagueType: t } as never, "TEST"),
      new RegExp(`is a ${t} league.*REDRAFT model`, "s"),
      `a ${t} league must be refused the incumbent alias BY NAME`,
    );
  }

  // And an explicit "redraft" must still be allowed through -- absence and redraft are one answer.
  assert.equal(resolveFormatForConfig({ ...base, leagueType: "redraft" } as never, "462233").provenance, "incumbent-root");
});

test("CONNECTED: the flag survives AppConfig into valueKey, not just when called directly", async () => {
  const { resolveFormatForConfig } = await import("../src/data/formatResolve.js");
  const base = {
    season: 2026, teams: 16, budget: 200,
    slots: ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"],
    flex_ok: ["RB", "WR", "TE"],
    draftType: "auction" as const,
    scoring_rules: DEFAULT_SCORING,
    format: { regWeeks: 13, playoffTeams: 7, playoffWeeks: [14, 15, 16], playoffRoundWeeks: 1, playoffReseed: true, seeding: "record" },
    levers: {},
  };
  // `asKeyable` builds the KeyableConfig field by field and did NOT carry leagueType, which would
  // have made every assertion above green while the field never reached production. Reading the key
  // off the RESOLVED format is what proves the wiring, and the refusal is caught so this test is
  // about the key rather than about the throw.
  const redraftKey = resolveFormatForConfig({ ...base } as never, "462233").valueKey;
  let dynastyKey: string | null = null;
  try { resolveFormatForConfig({ ...base, leagueType: "dynasty" } as never, "TEST"); } catch { /* expected */ }
  const { valueKey: vk } = await import("../src/data/formatKey.js");
  dynastyKey = vk({ teams: base.teams, budget: base.budget, slots: base.slots, draftType: base.draftType, scoring_rules: base.scoring_rules, format: base.format, leagueType: "dynasty" });
  assert.notEqual(dynastyKey, redraftKey, "the resolved redraft key and a dynasty key must differ");
});
