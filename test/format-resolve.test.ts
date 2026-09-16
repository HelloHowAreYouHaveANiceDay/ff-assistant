/**
 * THE FORMAT RESOLVER: the one place that turns "which league" into "which model's files".
 *
 * Two failures are possible and they are not symmetric.
 *
 *   The SILENT one: a league whose model has not been built resolves to the `data/` root and is
 *   served the incumbent's numbers. Every file exists, every number renders, the board has dollar
 *   signs on it -- this HAPPENED on the live store (529 rows of ESPN half-PPR projections stamped
 *   with the Yahoo key). So the tests that matter most below are the ones asserting a THROW.
 *
 *   The LOUD one: the incumbent stops resolving to the root, which breaks everything at once and is
 *   caught by the first test run. It still gets a test -- byte-identity against the exact
 *   `dataPath(...)` strings the code used before -- because the incumbent alias is what makes the
 *   refusals affordable, and a refactor that quietly moved the ESPN board into `data/formats/` would
 *   pass every other assertion in this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, setConfig, setActiveLeagueId, nowIso, type DB } from "../src/db/db.js";
import { dataPath } from "../src/data/paths.js";
import {
  resolveFormat, resolveFormatForConfig, formatDir, checkPreimage, INCUMBENT_MODEL, ARTIFACT_NAMES,
} from "../src/data/formatResolve.js";
import { INCUMBENT_SCORING_KEY, canonicalJson } from "../src/data/formatKey.js";
import { DEFAULT_SCORING, DEFAULT_KICKER, DEFAULT_DEFENSE, YAHOO_129048_SCORING } from "../src/draft/scoring.js";

const YAHOO_KEY = "sc-a845f67652fb";

const YAHOO_SLOTS = ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "FLEX", "FLEX", "SUPERFLEX",
  "BE", "BE", "BE", "BE", "BE", "BE", "BE", "IR", "IR"];

function withStore(fn: (db: DB) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "fmt-resolve-"));
  const db = openDb(join(dir, "ff.db"));
  try { fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

function addLeague(db: DB, id: string, platform: string, cfg: Record<string, unknown>): void {
  db.prepare("INSERT INTO league (league_id, platform, team_id, season, name, last_synced_at) VALUES (?,?,?,?,?,?)")
    .run(id, platform, "1", 2026, `league ${id}`, nowIso());
  setConfig(db, cfg as never, id);
  setActiveLeagueId(db, id);
}

const ESPN_CFG = {
  teams: 16, budget: 200, draftType: "auction",
  slots: ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"],
  scoring_rules: { ...DEFAULT_SCORING },
  kicker: { ...DEFAULT_KICKER },
  defense: { ...DEFAULT_DEFENSE, paLadder: DEFAULT_DEFENSE.paLadder.map((p) => [...p] as [number, number]) },
};
const YAHOO_CFG = {
  teams: 12, budget: 200, draftType: "snake", slots: YAHOO_SLOTS,
  scoring_rules: { ...YAHOO_129048_SCORING }, kicker: null, defense: null,
};

// =================================================================================================
// THE INCUMBENT ALIAS
// =================================================================================================

test("the INCUMBENT resolves to the data/ ROOT, and every path is byte-identical to the old dataPath string", () => {
  withStore((db) => {
    addLeague(db, "462233", "espn", ESPN_CFG);
    const f = resolveFormat(db, "462233");
    assert.equal(f.scoringKey, INCUMBENT_SCORING_KEY);
    assert.equal(f.provenance, "incumbent-root");
    // The literal strings every consumer used before this module existed. Written out rather than
    // derived, so a change to the artifact table cannot quietly agree with itself.
    const before: Record<string, string> = {
      "history-points": dataPath("history-points.csv"),
      "history-weekly": dataPath("history-weekly.csv"),
      "current-actuals": dataPath("current-actuals.csv"),
      "features-db": dataPath("ff.db"),
      projection: dataPath("projection-artifact.json"),
      "fold-artifacts": dataPath("fold-artifacts-d16"),
      weekly: dataPath("weekly-artifact.json"),
      "weekly-lineonly": dataPath("weekly-artifact-lineonly.json"),
      streaming: dataPath("streaming-artifact.json"),
      "dst-stream": dataPath("dst-stream-artifact.json"),
      variance: dataPath("variance-model.json"),
      "rank-outcomes": dataPath("rank-outcomes.json"),
      // WP8: ros-blend moved from SHARED to per-format. The incumbent's path is UNCHANGED, which is
      // the whole content of that claim and is what this line pins.
      "ros-blend": dataPath("ros-blend.json"),
      correlation: dataPath("correlation-model.json"),
      points: dataPath("points.csv"),
      values: dataPath("values.csv"),
      "def-ratings": dataPath("def-ratings.csv"),
      golden: dataPath("golden.json"),
      scoring: dataPath("scoring.json"),
      manifest: dataPath("manifest.json"),
    };
    // COVERAGE BY DERIVATION, not by enumeration: every artifact the table declares must appear in
    // the expectation above, so adding one without pinning its incumbent path fails here.
    assert.deepEqual([...ARTIFACT_NAMES].sort(), Object.keys(before).sort());
    for (const [name, path] of Object.entries(before)) {
      assert.equal(f.model.path(name as never), path, `incumbent path for ${name} moved`);
    }
  });
});

test("the STREAMING artifact filenames in the resolver's table equal the constants that define them", async () => {
  // formatResolve.ts cannot IMPORT these two -- their module imports formatResolve, so it would close
  // a cycle -- so it writes them as literals. `test/weekly-artifact-consistency.test.ts` polices the
  // other two filenames by grep; this is the same guard for the pair that grep cannot cover, and it
  // is the reason the literals are acceptable rather than merely convenient.
  const { STREAMING_ARTIFACT, DST_STREAM_ARTIFACT } = await import("../src/weekly/streamingServe.js");
  assert.equal(INCUMBENT_MODEL.path("streaming"), dataPath(STREAMING_ARTIFACT));
  assert.equal(INCUMBENT_MODEL.path("dst-stream"), dataPath(DST_STREAM_ARTIFACT));
});

test("SHARED-NFL artifacts stay at the root for every format -- they are facts about football", () => {
  assert.equal(INCUMBENT_MODEL.shared("age-curve"), dataPath("age-curve.json"));
  assert.equal(INCUMBENT_MODEL.shared("injury-duration"), dataPath("injury-duration-artifact.json"));
  assert.equal(INCUMBENT_MODEL.shared("store"), dataPath("ff.db"));
});

test("a store with NO league at all still resolves (a fresh clone is the incumbent, not a throw)", () => {
  withStore((db) => {
    const f = resolveFormat(db);
    assert.equal(f.provenance, "incumbent-root");
    assert.equal(f.leagueId, null);
  });
});

// =================================================================================================
// THE REFUSALS -- the half that makes this worth having
// =================================================================================================

test("a league resolving to a key with NO DIRECTORY throws, names the key, and names the build command", () => {
  withStore((db) => {
    // A ruleset nothing has ever built: full PPR with 8-point passing TDs.
    addLeague(db, "999", "espn", { ...ESPN_CFG, scoring_rules: { ...DEFAULT_SCORING, rec: 1, passTD: 8 } });
    assert.throws(() => resolveFormat(db, "999"), (e: Error) => {
      assert.match(e.message, /^league 999 scores as sc-[0-9a-f]{12}/);
      assert.match(e.message, /build-format-features\.mjs --league 999/);
      assert.match(e.message, /NO fallback to the data\/ root/);
      return true;
    });
  });
});

test("FAULT INJECTION: a directory whose scoring.json does not RE-HASH to its name throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "fmt-preimage-"));
  try {
    // 1. no preimage at all -> the directory name is an unverifiable claim
    let r = checkPreimage(dir, YAHOO_KEY);
    assert.equal(r.ok, false);
    assert.match((r as { why: string }).why, /unverifiable claim/);

    // 2. a preimage for the WRONG rules -> re-hash disagrees with the name. This is the case a
    //    hand-copied or half-migrated directory produces, and the only one the file system cannot
    //    tell apart from a correct build.
    writeFileSync(join(dir, "scoring.json"), JSON.stringify({ rules: DEFAULT_SCORING }), "utf8");
    r = checkPreimage(dir, YAHOO_KEY);
    assert.equal(r.ok, false);
    assert.match((r as { why: string }).why, /re-hashes to sc-f6143a8dfb13, not sc-a845f67652fb/);

    // 3. POSITIVE CONTROL: the RIGHT rules verify. Without this the check could be `return false`.
    writeFileSync(join(dir, "scoring.json"), JSON.stringify({ rules: YAHOO_129048_SCORING, kicker: null, defense: null }), "utf8");
    assert.deepEqual(checkPreimage(dir, YAHOO_KEY), { ok: true });

    // 4. and the preimage is canonical-insensitive: a re-serialized copy with reordered keys verifies
    const reordered = Object.fromEntries(Object.entries(YAHOO_129048_SCORING).reverse());
    writeFileSync(join(dir, "scoring.json"), canonicalJson({ rules: reordered }), "utf8");
    assert.deepEqual(checkPreimage(dir, YAHOO_KEY), { ok: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a BUILT-BUT-UNVERIFIED directory throws rather than resolving to it", () => {
  withStore((db) => {
    addLeague(db, "129048", "yahoo", YAHOO_CFG);
    // The Yahoo dir exists in this working tree; point the resolver at a key whose dir exists but
    // whose preimage is wrong, by building a throwaway one for a made-up ruleset.
    const rules = { ...DEFAULT_SCORING, rec: 0.75 };
    const cfg = { ...ESPN_CFG, scoring_rules: rules };
    const key = resolveFormatForConfigKeyOnly(cfg);
    const dir = formatDir(key);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, "scoring.json"), JSON.stringify({ rules: DEFAULT_SCORING }), "utf8");
      addLeague(db, "777", "espn", cfg);
      assert.throws(() => resolveFormat(db, "777"), /does not verify.*re-hashes to/s);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// A tiny helper so the test above does not re-implement the key derivation it is testing.
function resolveFormatForConfigKeyOnly(cfg: Record<string, unknown>): string {
  try { resolveFormatForConfig(cfg as never, null); } catch (e) {
    const m = /scores as (sc-[0-9a-f]{12})/.exec((e as Error).message);
    if (m) return m[1];
    throw e;
  }
  throw new Error("expected the resolve to refuse an unbuilt format");
}

// =================================================================================================
// THE POSITIVE RESOLVE -- and per-artifact availability
// =================================================================================================

test("the LIVE Yahoo league resolves to data/formats/sc-a845f67652fb with provenance format-dir", () => {
  withStore((db) => {
    addLeague(db, "129048", "yahoo", YAHOO_CFG);
    const f = resolveFormat(db, "129048");
    assert.equal(f.scoringKey, YAHOO_KEY);
    assert.equal(f.provenance, "format-dir");
    assert.equal(f.model.dir, formatDir(YAHOO_KEY));
    assert.equal(f.model.path("projection"), join(formatDir(YAHOO_KEY), "projection-artifact.json"));
    assert.equal(f.model.path("features-db"), join(formatDir(YAHOO_KEY), "features.db"));
    // The SHARED artifacts do NOT move with it.
    assert.equal(f.model.shared("age-curve"), dataPath("age-curve.json"));
    // ...but the ROS blend DOES (WP8): K is fitted by minimising RMSE in POINTS on this format's own
    // season lines and weekly scores, so it is not a constant of football. The incumbent still reads
    // the root file; this format reads its own.
    assert.equal(f.model.path("ros-blend"), join(formatDir(YAHOO_KEY), "ros-blend.json"));
    assert.equal(INCUMBENT_MODEL.path("ros-blend"), dataPath("ros-blend.json"));
    // and the format spec carries the superflex economy, not a copy of ESPN's
    assert.equal(f.spec.draftType, "snake");
    assert.ok((f.spec.value.flexGroups ?? []).some((g) => g.elig.includes("QB")),
      "the Yahoo spec must carry a QB-eligible flex group -- that is what superflex IS");
  });
});

test("model.require THROWS BY NAME for an artifact the format does not have, and returns the path for one it does", () => {
  withStore((db) => {
    addLeague(db, "129048", "yahoo", YAHOO_CFG);
    const f = resolveFormat(db, "129048");
    // NEGATIVE: the Yahoo dir has no DST streaming artifact (none has been trained for it -- the
    // league rosters no defence). The refusal must name the format and the artifact, so a copilot can
    // say "this league has no DST model" instead of reading the ESPN one.
    //
    // This used to be asserted on `weekly`, which WP8 trained, so the negative case moved to an
    // artifact that is genuinely absent rather than being deleted -- a negative control that has
    // become positive is not a passing test, it is an untested rule.
    assert.equal(f.model.has("dst-stream"), false);
    assert.throws(() => f.model.require("dst-stream"), (e: Error) => {
      assert.match(e.message, /format sc-a845f67652fb has no dst-stream artifact/);
      assert.match(e.message, /Nothing here falls back to the\s+data\/ root/s);
      return true;
    });
    // ...and the weekly artifact WP8 trained resolves INSIDE the format directory, never at the root.
    assert.equal(f.model.has("weekly"), true);
    assert.equal(f.model.path("weekly"), join(formatDir(YAHOO_KEY), "weekly-artifact.json"));
    assert.equal(f.model.path("weekly-lineonly"), join(formatDir(YAHOO_KEY), "weekly-artifact-lineonly.json"));
    // POSITIVE: the artifacts it DOES have come back, so this is a measurement and not a mute.
    assert.equal(f.model.has("projection"), true);
    assert.ok(f.model.require("projection").endsWith("projection-artifact.json"));
    assert.equal(f.model.has("scoring"), true);
  });
});

test("THE SERVE RULE (F-4), per position: an artifact this format does not have serves NOTHING, and is named", async () => {
  const { projectStreamingWith } = await import("../src/weekly/streamingServe.js");
  withStore((db) => {
    addLeague(db, "129048", "yahoo", YAHOO_CFG);
    const f = resolveFormat(db, "129048");
    // WHAT THIS ASSERTED BEFORE WP8, and why it had to change: the Yahoo format had NO weekly
    // artifact, so the whole call returned null and the consumer fell back to the season line. WP8
    // trained one, so the all-or-nothing form of the rule is no longer reachable from a live format.
    // The rule itself is unchanged and is asserted where it still bites -- PER POSITION: DST maps to
    // `dst-stream-artifact.json`, this format has none, and DST must therefore come back in
    // `missing` with no DST row anywhere, rather than being served the ROOT's DST model.
    const p = projectStreamingWith(db as never, 2026, 1, f.model);
    assert.ok(p, "the format has weekly artifacts now, so this is a projection, not a null");
    assert.ok(p.missing.includes("DST"), "DST has no artifact for this format and must be NAMED as missing");
    assert.equal(p.artifactByPos.DST, undefined);
    assert.equal(p.rows.filter((r) => r.pos === "DST").length, 0, "a missing artifact must serve nothing at all");
    // ...and every position that IS served names a file from THIS format's table, never the root's.
    assert.equal(p.artifactByPos.QB, "weekly-artifact.json");
    assert.ok(p.rows.length > 0 && p.rows.every((r) => r.pos !== "DST"));
    // POSITIVE CONTROL on the refusal itself: the incumbent HAS the DST artifact, so "missing" above
    // is a statement about this format and not about the file being absent everywhere.
    assert.equal(INCUMBENT_MODEL.has("dst-stream"), true,
      "the incumbent DOES have a DST artifact -- if this fails the assertion above proves nothing");
  });
});
