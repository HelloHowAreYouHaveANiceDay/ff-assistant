// TRACK I: injury episodes and the point-in-time horizon.
//
// Three layers, and each catches a different way this table is wrong without being broken:
//
//   PURE      -- the injury-group collapse and the designation/practice normalisers. They are a
//                PUBLISHED CONTRACT: the trainer encodes these strings, the artifact names them and
//                the copilot looks them up, so a silent rename breaks three files at once and none
//                of them throws. The tests assert the strings, not a symptom.
//   BUILT     -- invariants on the built tables that no per-column count can express: a censored
//                episode must have no return week, a target must be NULL wherever the games it
//                looks at do not exist, and the play signal must ORDER by designation.
//   FAULT     -- the leak guard's own fault injection, asserted here rather than only in a script,
//                so `npm test` proves the guard can fail.
//
// The BUILT tests skip with a message where the table is absent. A skipped test reporting a pass is
// worse than no test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { injuryGroup, normDesignation, normPractice, INJURY_GROUPS, buildInjuryDuration } from "../src/features/sources/injuryDuration.js";

const DBP = "data/ff.db";

function built(table: string): boolean {
  if (!existsSync(DBP)) return false;
  const db = new Database(DBP, { readonly: true });
  try { return ((db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c) > 0; }
  catch { return false; } finally { db.close(); }
}
const skipIf = (t: string) => (built(t) ? false : `${t} not built -- run: ff build-injury-horizon`);
const open = () => new Database(DBP, { readonly: true });

// ==================================================================================================
// PURE: the published vocabulary
// ==================================================================================================

test("every group the collapse can emit is in the PUBLISHED list", () => {
  const samples = ["Knee", "right Knee", "Knee/Ankle", "ACL", "Hamstring", "Achilles", "Concussion",
    "Head", "Illness", "Not Injury Related", "Thumb", "Wrist", "Pectoral", "Shin", "Stinger",
    "Sports Hernia", "Unicorn Horn", "", null, undefined];
  for (const s of samples) {
    assert.ok((INJURY_GROUPS as readonly string[]).includes(injuryGroup(s)),
      `injuryGroup(${JSON.stringify(s)}) = ${injuryGroup(s)}, which is not a declared group`);
  }
});

test("the collapse is ORDERED, and the order is the documented one", () => {
  // "Knee/Ankle" is a knee ON PURPOSE: first match wins in severity order, not alphabetical order.
  assert.equal(injuryGroup("Knee/Ankle"), "knee");
  assert.equal(injuryGroup("Achilles"), "achilles");
  // and an Achilles is NOT swallowed by the calf pattern that also mentions it
  assert.equal(injuryGroup("Achilles Tendon"), "achilles");
  assert.equal(injuryGroup("right Hamstring"), "hamstring");
  assert.equal(injuryGroup("Not Injury Related"), "illness");
  assert.equal(injuryGroup("Unicorn Horn"), "other");
  assert.equal(injuryGroup(""), "none");
});

test("designations and practice status normalise to the strings the model encodes", () => {
  assert.equal(normDesignation("Out"), "Out");
  assert.equal(normDesignation("out"), "Out");
  assert.equal(normDesignation("Doubtful"), "Doubtful");
  assert.equal(normDesignation("Questionable"), "Questionable");
  assert.equal(normDesignation("Probable"), "Probable");
  // A practice-only row carries "", which is a REAL state -- on the report, no designation named --
  // and must not become "Questionable" or null.
  assert.equal(normDesignation(null), "");
  assert.equal(normDesignation("  "), "");
  assert.equal(normPractice("Did Not Participate In Practice"), "DNP");
  assert.equal(normPractice("Limited Participation in Practice"), "Limited");
  assert.equal(normPractice("Full Participation in Practice"), "Full");
  assert.equal(normPractice("Out (Definitely Will Not Play)"), "DNP");
  assert.equal(normPractice(""), "");
});

// ==================================================================================================
// BUILT: invariants a coverage count cannot express
// ==================================================================================================

test("a CENSORED episode has no return week, and an uncensored one does where it missed games", { skip: skipIf("fact_injury_episode") }, () => {
  const db = open();
  const bad = db.prepare(
    "SELECT COUNT(*) c FROM fact_injury_episode WHERE censored = 1 AND returned_week IS NOT NULL",
  ).get() as { c: number };
  assert.equal(bad.c, 0, "a censored episode by definition never saw a return");
  const bad2 = db.prepare(
    "SELECT COUNT(*) c FROM fact_injury_episode WHERE censored = 0 AND weeks_missed > 0 AND returned_week IS NULL",
  ).get() as { c: number };
  assert.equal(bad2.c, 0, "an uncensored episode that missed games must name the week he came back");
  const bad3 = db.prepare(
    "SELECT COUNT(*) c FROM fact_injury_episode WHERE returned_week IS NOT NULL AND returned_week <= start_week",
  ).get() as { c: number };
  assert.equal(bad3.c, 0, "a return cannot precede the episode that caused it");
  db.close();
});

test("miss_next_k is NULL exactly where fewer than k games remain -- censored, never zero", { skip: skipIf("feat_injury_horizon") }, () => {
  const db = open();
  for (const k of [1, 2, 3, 4]) {
    const r = db.prepare(
      `SELECT SUM(miss_next_${k} IS NULL AND games_remaining >= ${k}) a,
              SUM(miss_next_${k} IS NOT NULL AND games_remaining < ${k}) b
       FROM feat_injury_horizon`,
    ).get() as { a: number; b: number };
    assert.equal(r.a, 0, `k=${k}: a row with ${k} games left must carry a target`);
    assert.equal(r.b, 0, `k=${k}: a row with fewer than ${k} games left must carry NULL, not 0`);
  }
  db.close();
});

test("miss_next_k is MONOTONE: missing the next 4 implies missing the next 1", { skip: skipIf("feat_injury_horizon") }, () => {
  const db = open();
  const r = db.prepare(
    `SELECT SUM(miss_next_2 = 1 AND miss_next_1 = 0) a, SUM(miss_next_3 = 1 AND miss_next_2 = 0) b,
            SUM(miss_next_4 = 1 AND miss_next_3 = 0) c FROM feat_injury_horizon`,
  ).get() as { a: number; b: number; c: number };
  assert.equal(r.a + r.b + r.c, 0, "he cannot miss the next k and have played inside them");
  db.close();
});

test("THE PLAY SIGNAL IS CONNECTED: P(miss) orders Out > Doubtful > Questionable > Probable", { skip: skipIf("feat_injury_horizon") }, () => {
  // A broken join between the horizon and our weekly history reads `missed` for everybody, or for
  // nobody, and every column would still be populated. This is the assertion that a flat column
  // cannot pass.
  const db = open();
  const rows = db.prepare(
    "SELECT designation d, COUNT(*) n, AVG(miss_next_1) p FROM feat_injury_horizon GROUP BY 1",
  ).all() as { d: string; n: number; p: number }[];
  const p = new Map(rows.map((r) => [r.d, r.p]));
  assert.ok((p.get("Out") ?? 0) > 0.95, `P(miss | Out) = ${p.get("Out")}`);
  assert.ok((p.get("Out") ?? 0) > (p.get("Doubtful") ?? 0));
  assert.ok((p.get("Doubtful") ?? 0) > (p.get("Questionable") ?? 0));
  assert.ok((p.get("Questionable") ?? 0) > (p.get("Probable") ?? 0));
  assert.ok((p.get("Probable") ?? 1) < 0.30, `P(miss | Probable) = ${p.get("Probable")}`);
  db.close();
});

test("INJURY TYPE SEPARATES THE HORIZON among men listed Out -- the whole reason this table exists", { skip: skipIf("feat_injury_horizon") }, () => {
  // If a designation said everything, P(miss next 4 | Out) would be the same for every injury and
  // the model in step 2 could not beat the designation-only baseline at any horizon. It is not.
  const db = open();
  const rows = db.prepare(
    `SELECT injury_group g, COUNT(*) n, AVG(miss_next_4) p FROM feat_injury_horizon
     WHERE designation = 'Out' AND miss_next_4 IS NOT NULL GROUP BY 1 HAVING n >= 80`,
  ).all() as { g: string; n: number; p: number }[];
  assert.ok(rows.length >= 6, `only ${rows.length} groups with n >= 80 among the men listed Out`);
  const ps = rows.map((r) => r.p);
  assert.ok(Math.max(...ps) - Math.min(...ps) > 0.15,
    `spread in P(miss next 4 | Out) across injury groups is only ${(Math.max(...ps) - Math.min(...ps)).toFixed(3)}`);
  db.close();
});

// ==================================================================================================
// FAULT INJECTION -- the leak guard, asserted in the suite rather than only in a script
// ==================================================================================================

test("FAULT INJECTION: reading the FOLLOWING week's report moves features the guard protects", { skip: skipIf("feat_injury_horizon") }, () => {
  const dir = "data/tmp-injury-test";
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const scratch = `${dir}/ff.db`;
  const src = new Database(DBP, { readonly: true });
  src.prepare(`VACUUM INTO '${scratch}'`).run();
  src.close();
  try {
    const seasons = [2018, 2019];
    const snap = () => {
      const db = new Database(scratch, { readonly: true });
      const rows = db.prepare(
        "SELECT player_sk, week, episode_start_week, injury_group, designation, weeks_in_episode FROM feat_injury_horizon WHERE season = 2019 ORDER BY player_sk, week",
      ).all();
      db.close();
      return JSON.stringify(rows);
    };
    buildInjuryDuration({ dbPath: scratch, seasons });
    const clean = snap();
    assert.ok(clean.length > 1000, "the scratch build produced no rows -- the test proves nothing");
    buildInjuryDuration({ dbPath: scratch, seasons, leakNextWeekDesignation: true });
    const leaked = snap();
    assert.notEqual(leaked, clean,
      "the injected leak changed NOTHING, so the point-in-time guard is inert and every green run of " +
      "it has been meaningless");
    // and the honest build is reproducible, which is the other half: a builder whose output moves
    // on its own would make the comparison above meaningless in the other direction.
    buildInjuryDuration({ dbPath: scratch, seasons });
    assert.equal(snap(), clean, "two honest builds of the same store disagreed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
