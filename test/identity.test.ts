// BOARD IDENTITY: whose birth date is on this row?
//
// `player_bio` is keyed by name_key alone, so two real people who share a name share a row. On the
// live board that put the LINEBACKER Justin Jefferson (born 2003) on the WIDE RECEIVER at ECR 9 --
// age 23.5 and a rookie badge on a 27-year-old in his seventh season -- and did the same to DeVonta
// Smith and to Lamar Jackson. Nothing failed: an age is an age, and the column rendered perfectly.
//
// The fixtures below are the real players, with the real dates from stg_player and player_bio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAgeExp, pickStaged, type StgIdentity, type BioRow } from "../src/data/assemble.js";

const ASOF = Date.UTC(2026, 8, 1);   // the same Sep 1 anchor assemble uses
const near = (got: number | "", want: number, tol = 0.3) =>
  typeof got === "number" && Math.abs(got - want) <= tol;

// stg_player holds BOTH Jeffersons, each with his own birth date and team.
const JJ: StgIdentity[] = [
  { position: "LB", team: "CLE", birthdate: "2003-03-20" },
  { position: "WR", team: "MIN", birthdate: "1999-06-16" },
];
// player_bio holds ONE row for the shared name -- and it is the linebacker's.
const JJ_BIO: BioRow = { birth_date: "2003-03-20", exp: 0 };

const resolve = (c: StgIdentity[], pos: string, team: string, bio: BioRow | null) =>
  resolveAgeExp(pickStaged(c, pos, team), bio, c.length > 1, ASOF);

test("the WR Justin Jefferson is aged from HIS birth date, and is not a rookie", () => {
  const { age, exp } = resolve(JJ, "WR", "MIN", JJ_BIO);
  assert.ok(near(age, 27.2), `WR Jefferson must be ~27.2, got ${age} -- 23.5 means the linebacker's row won`);
  assert.notEqual(exp, "R", "a seventh-year receiver must not carry his namesake's rookie badge");
});

test("the LINEBACKER still gets his own age -- the fix must not simply blank the pair", () => {
  // The positive direction. A fix that repaired the receiver by deleting both men's ages would pass
  // the test above; the other Jefferson is a real 23-year-old and must read as one.
  const { age } = resolve(JJ, "LB", "CLE", JJ_BIO);
  assert.ok(near(age, 23.5), `LB Jefferson must be ~23.5, got ${age}`);
});

test("DeVonta Smith likewise", () => {
  const { age, exp } = resolve([{ position: "WR", team: "PHI", birthdate: "1998-11-14" }], "WR", "PHI",
    { birth_date: "2002-12-11", exp: 0 });
  assert.ok(near(age, 27.8), `expected ~27.8, got ${age}`);
  assert.equal(exp, "", "a bio row whose birth date disagrees with staging describes someone else");
});

test("Lamar Jackson gets the RAVENS QB, not the Panthers cornerback", () => {
  const lj: StgIdentity[] = [
    { position: "CB", team: "CAR", birthdate: "1998-04-13" },
    { position: "QB", team: "BAL", birthdate: "1997-01-07" },
  ];
  assert.ok(near(resolve(lj, "QB", "BAL", { birth_date: "1998-04-13", exp: 3 }).age, 29.6),
    "the QB is 29.6; 28.4 is the cornerback");
});

// --- the failure that came from the OPPOSITE direction ---------------------------------------------

test("Marvin Harrison Jr. is not aged from his FATHER, whom the registry mistook him for", () => {
  // nameKey strips generational suffixes on purpose, so father and son collapse to one key -- and
  // staging holds only the father (WR, IND, born 1973, retired 2008). Position matches, so a
  // name+position lookup confidently returns a 53-year-old. TEAM is what separates them, and the
  // right answer here is to fall back to the bio row rather than to a stranger.
  const dad: StgIdentity[] = [{ position: "WR", team: "IND", birthdate: "1973-08-26" }];
  assert.equal(pickStaged(dad, "WR", "ARI"), null,
    "a staged row on a DIFFERENT team must not be accepted as this player");
  const { age, exp } = resolve(dad, "WR", "ARI", { birth_date: "2002-08-11", exp: 3 });
  assert.ok(near(age, 24.1), `the son is ~24.1, got ${age} -- 53 means the father's row was used`);
  assert.equal(exp, 3, "an unambiguous fallback keeps its bio experience");
});

test("pickStaged prefers position+team, tolerates a blank team, and refuses to guess", () => {
  const two: StgIdentity[] = [
    { position: "WR", team: "MIN", birthdate: "1999-06-16" },
    { position: "WR", team: "NYJ", birthdate: "1994-01-01" },
  ];
  assert.equal(pickStaged(two, "WR", "MIN")!.birthdate, "1999-06-16");
  // Two same-position candidates and no team to separate them: refuse rather than take the first.
  assert.equal(pickStaged(two, "WR", ""), null);
  // A staged row with no team recorded is not a contradiction, so it is still usable.
  assert.equal(pickStaged([{ position: "WR", team: null, birthdate: "1995-05-05" }], "WR", "SEA")!.birthdate, "1995-05-05");
});

// --- FAULT INJECTION -------------------------------------------------------------------------------

test("FAULT INJECTION: the old name-only bio join produces the defect this file exists to catch", () => {
  // The pre-fix behaviour, reproduced exactly: read the bio row by name, use it unconditionally.
  const oldWay = (bio: BioRow) => {
    const d = Date.parse(String(bio.birth_date).slice(0, 10));
    return { age: Math.round((ASOF - d) / (365.25 * 864e5) * 10) / 10, exp: bio.exp === 0 ? "R" : bio.exp };
  };
  const bad = oldWay(JJ_BIO);
  assert.ok(bad.age < 24, `the old join gives the WR ${bad.age}`);
  assert.equal(bad.exp, "R");
  // ...and the new one does not. Asserting BOTH halves is what makes this a control rather than a
  // restatement: it shows the input really does trigger the defect, and that the fix is what stops it.
  const now = resolve(JJ, "WR", "MIN", JJ_BIO);
  assert.ok(typeof now.age === "number" && now.age - bad.age > 3,
    `the fix must move him by years, not decimals: ${bad.age} -> ${now.age}`);
});

// --- the common case, which a too-aggressive fix would break ---------------------------------------

test("an unambiguous player with no staged birth date still gets his bio age and experience", () => {
  const { age, exp } = resolve([{ position: "RB", team: "ATL", birthdate: null }], "RB", "ATL",
    { birth_date: "1997-03-10", exp: 5 });
  assert.ok(near(age, 29.5), `expected ~29.5, got ${age}`);
  assert.equal(exp, 5);
});

test("a SHARED name with no usable staged row gets no age at all, rather than a coin flip", () => {
  const { age, exp } = resolveAgeExp(null, { birth_date: "2003-03-20", exp: 0 }, true, ASOF);
  assert.equal(age, "", "a blank cell is a visibly missing value; a confidently wrong age is not");
  assert.equal(exp, "");
});
