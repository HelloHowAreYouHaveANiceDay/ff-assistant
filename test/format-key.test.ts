/**
 * THE FORMAT KEYS ARE AN IDENTITY, AND AN IDENTITY MUST BE BOTH STABLE AND DISCRIMINATING.
 *
 * Every artifact this repo trains lives under one of these keys, so two failures are possible and
 * they are opposites:
 *
 *   INSTABILITY -- the same ruleset hashing to two keys because a JSON round trip reordered a key,
 *   a float picked up representation noise, or a tier array came back in a different order. A league
 *   would then retrain on every run and never reuse a model, and nothing would look wrong.
 *
 *   COLLISION -- two genuinely different rulesets hashing to one key, which is far worse: the second
 *   format silently serves the first one's model. The POSITIVE CONTROLS below are the half that
 *   catches this, and they are the reason an invariance test alone is not enough -- `() => "sc-0"`
 *   passes every invariance assertion there is.
 *
 * The two PINNED keys are the live ones: `sc-f6143a8dfb13` is the incumbent ESPN half-PPR format
 * (the `data/` root, and the `format_key` stamped on 3,650 scorecard rows) and `sc-a845f67652fb` is
 * the Yahoo superflex format whose model directory is named after it. Moving either silently orphans
 * real artifacts, so they are asserted here as facts rather than recomputed as expectations.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalJson, scoringKey, scoringKeyFor, valueKey, formatKey, INCUMBENT_SCORING_KEY,
  type KeyableConfig,
} from "../src/data/formatKey.js";
import {
  DEFAULT_SCORING, DEFAULT_KICKER, DEFAULT_DEFENSE, YAHOO_129048_SCORING, type ScoringRules,
} from "../src/draft/scoring.js";

const ESPN_KEY = "sc-f6143a8dfb13";
const YAHOO_KEY = "sc-a845f67652fb";

// The two live configs, in the shape the store holds them (verified against data/ff.db 2026-09-16).
const espnCfg = (): KeyableConfig => ({
  teams: 16, budget: 200, draftType: "auction",
  slots: ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"],
  scoring_rules: { ...DEFAULT_SCORING },
  kicker: { ...DEFAULT_KICKER },
  defense: { ...DEFAULT_DEFENSE, paLadder: DEFAULT_DEFENSE.paLadder.map((p) => [...p] as [number, number]) },
  format: { regWeeks: 13, playoffTeams: 7, playoffWeeks: [14, 15, 16], playoffRoundWeeks: 1, playoffReseed: true, seeding: "division-winners-first" },
});
const yahooCfg = (): KeyableConfig => ({
  teams: 12, budget: 200, draftType: "snake",
  slots: ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "FLEX", "FLEX", "SUPERFLEX",
    "BE", "BE", "BE", "BE", "BE", "BE", "BE", "IR", "IR"],
  scoring_rules: { ...YAHOO_129048_SCORING },
  kicker: null, defense: null,
  format: { regWeeks: 14, playoffTeams: 8, playoffWeeks: [15, 16, 17], playoffRoundWeeks: 1, playoffReseed: true, seeding: "record" },
});

// ---------------------------------------------------------------------------------------------
// THE PINS
// ---------------------------------------------------------------------------------------------

test("PINNED: the two live scoring keys are exactly what the artifacts on disk are named", () => {
  assert.equal(scoringKeyFor({ rules: espnCfg().scoring_rules, kicker: espnCfg().kicker, defense: espnCfg().defense }), ESPN_KEY);
  assert.equal(scoringKeyFor({ rules: yahooCfg().scoring_rules, kicker: null, defense: null }), YAHOO_KEY);
  // and the constant the whole resolver aliases to the data/ root agrees with the ESPN league
  assert.equal(INCUMBENT_SCORING_KEY, ESPN_KEY);
  // the legacy offence-only entry point must still agree, because db.ts's migrations used it
  assert.equal(scoringKey(DEFAULT_SCORING), ESPN_KEY);
  assert.equal(scoringKey(YAHOO_129048_SCORING), YAHOO_KEY);
});

// ---------------------------------------------------------------------------------------------
// INVARIANCE -- the same rules must always be the same key
// ---------------------------------------------------------------------------------------------

test("key ORDER does not move any of the three keys", () => {
  const c = yahooCfg();
  // rebuild scoring_rules with the keys in reverse order
  const reversed = Object.fromEntries(Object.entries(c.scoring_rules).reverse()) as unknown as ScoringRules;
  const c2: KeyableConfig = { ...c, scoring_rules: reversed };
  assert.equal(scoringKeyFor({ rules: c2.scoring_rules }), YAHOO_KEY);
  assert.equal(valueKey(c2), valueKey(c));
  assert.equal(formatKey(c2), formatKey(c));
});

test("FLOAT NOISE below 1e-6 does not move the key (a JSON round trip must not retrain a league)", () => {
  const c = espnCfg();
  const noisy: ScoringRules = { ...c.scoring_rules, passYd: 0.04 + 1e-9, rushYd: 0.1 - 4e-10 };
  assert.equal(scoringKeyFor({ rules: noisy, kicker: c.kicker, defense: c.defense }), ESPN_KEY);
});

test("TIER-ARRAY order does not move the key", () => {
  const c = yahooCfg();
  const swapped: ScoringRules = {
    ...c.scoring_rules,
    passYdBonus: [[400, 3], [300, 2]],
    recYdBonus: [[200, 3], [100, 2]],
  };
  assert.equal(scoringKeyFor({ rules: swapped }), YAHOO_KEY);
});

test("SLOT ORDER does not move the value key, and three spellings of one flex are one economy", () => {
  const c = yahooCfg();
  const shuffled: KeyableConfig = { ...c, slots: [...c.slots].reverse() };
  assert.equal(valueKey(shuffled), valueKey(c));
  // FLEX / W/R/T / RB/WR/TE are the same eligibility set, so they must share a value book.
  const a: KeyableConfig = { ...espnCfg(), slots: ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE"] };
  const b: KeyableConfig = { ...espnCfg(), slots: ["QB", "RB", "WR", "TE", "W/R/T", "RB/WR/TE", "DST", "K", "BE"] };
  assert.equal(valueKey(a), valueKey(b), "three spellings of [RB,WR,TE] must not fork the value book");
});

test("PROVENANCE fields on the calendar (source/fetchedAt/note/divisions) are NOT part of the format key", () => {
  const c = yahooCfg();
  const withNoise: KeyableConfig = {
    ...c,
    format: { ...c.format, ...{ source: "owner-override", fetchedAt: "2026-09-16 02:42", note: "x", divisions: [] } } as KeyableConfig["format"],
  };
  assert.equal(formatKey(withNoise), formatKey(c), "a re-sync stamping a new fetchedAt must not fork the gate");
});

// ---------------------------------------------------------------------------------------------
// POSITIVE CONTROLS -- a real change MUST move the key. Without these, a constant passes above.
// ---------------------------------------------------------------------------------------------

test("POSITIVE CONTROL: a real scoring change moves the scoring key", () => {
  const c = espnCfg();
  const ppr: ScoringRules = { ...c.scoring_rules, rec: 1 };
  assert.notEqual(scoringKeyFor({ rules: ppr, kicker: c.kicker, defense: c.defense }), ESPN_KEY);
});

test("POSITIVE CONTROL: a NON-DEFAULT KICKER RULE moves the scoring key -- the whole elision decision", () => {
  const c = espnCfg();
  // Same offence, one kicker field changed: this league genuinely scores kickers differently and must
  // not share a projection target (history.ts bakes K rows into history-points.csv).
  const movedK = scoringKeyFor({ rules: c.scoring_rules, kicker: { ...DEFAULT_KICKER, fg50_59: 6 }, defense: c.defense });
  assert.notEqual(movedK, ESPN_KEY, "a non-default kicker table must get its own format");
  // and the same for defense
  const movedD = scoringKeyFor({ rules: c.scoring_rules, kicker: c.kicker, defense: { ...DEFAULT_DEFENSE, sack: 2 } });
  assert.notEqual(movedD, ESPN_KEY, "a non-default defense table must get its own format");
  assert.notEqual(movedK, movedD, "two different overrides must not collide with each other");
  // ELISION, stated as the property it is: a kicker EQUAL to the default, and a kicker that is
  // ABSENT, both mean "the default target", so both keep the offence-only key.
  assert.equal(scoringKeyFor({ rules: c.scoring_rules, kicker: { ...DEFAULT_KICKER }, defense: c.defense }), ESPN_KEY);
  assert.equal(scoringKeyFor({ rules: c.scoring_rules }), ESPN_KEY);
});

test("POSITIVE CONTROL: SUPERFLEX is not FLEX, and team count / budget / draft type all move the value key", () => {
  const c = yahooCfg();
  const base = valueKey(c);
  const noSf: KeyableConfig = { ...c, slots: c.slots.map((s) => (s === "SUPERFLEX" ? "FLEX" : s)) };
  assert.notEqual(valueKey(noSf), base, "SUPERFLEX and FLEX are different economies -- that IS superflex");
  assert.notEqual(valueKey({ ...c, teams: 10 }), base);
  assert.notEqual(valueKey({ ...c, budget: 300 }), base);
  assert.notEqual(valueKey({ ...c, draftType: "auction" }), base);
  // a bench slot is not an economy: adding one changes rosterSpots, which IS part of the $1 reserve
  assert.notEqual(valueKey({ ...c, slots: [...c.slots, "BE"] }), base);
});

test("POSITIVE CONTROL: the playoff CALENDAR moves the format key but NOT the value key", () => {
  const c = yahooCfg();
  const other: KeyableConfig = { ...c, format: { ...c.format, playoffTeams: 6 } };
  assert.notEqual(formatKey(other), formatKey(c), "a different playoff field is a different gate");
  assert.equal(valueKey(other), valueKey(c), "the calendar must not fork the VALUE book -- that is the layer reuse");
});

test("the two live leagues differ at EVERY layer -- the worked example in docs/multi-format-design.md", () => {
  const e = espnCfg(), y = yahooCfg();
  assert.notEqual(scoringKeyFor({ rules: e.scoring_rules, kicker: e.kicker, defense: e.defense }),
    scoringKeyFor({ rules: y.scoring_rules }));
  assert.notEqual(valueKey(e), valueKey(y));
  assert.notEqual(formatKey(e), formatKey(y));
});

test("canonicalJson drops undefined and sorts, so an absent field and an undefined one are one value", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ a: 1, z: undefined }), canonicalJson({ a: 1 }));
});
