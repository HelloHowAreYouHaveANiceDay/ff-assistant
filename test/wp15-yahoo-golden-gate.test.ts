/**
 * THE YAHOO FORMAT'S GOLDEN IS REACHABLE FROM A LEAGUE, AND ITS ABSENCE IS A REFUSAL (W-4, WP15).
 *
 * WHAT WAS MISSING. `test/wp7-platform-sync-gate.test.ts` proves the golden LOADER: a synthetic file
 * parses, a file with no `playoffPct` throws, a missing file throws `NoGoldenError`, and the
 * INCUMBENT's shipped golden carries 96.0 / 38.5. What nothing asserted is the other format's SHIPPED
 * number -- 99.2 / 39.8 -- or that a league can actually REACH it. That tripwire lived only in a JSON
 * file that only a full `cpcv` run reads, and that run was itself broken under plain `node` (D-1). A
 * gate number nothing loads is a number nobody is checking.
 *
 * WHY IT GOES THROUGH `resolveFormat`. Reading `data/formats/sc-a845f67652fb/golden.json` by path
 * would assert that a file I just named exists -- the system compared against itself. The question
 * that matters is the one `scripts/cpcv.mjs` asks: given a LEAGUE, does the chain
 * config -> scoringKey -> format directory -> golden.json arrive at the pinned numbers? So the fixture
 * builds a store whose league config carries this format's OWN scoring rules (read from the
 * directory's `scoring.json`, never retyped) and walks the same two calls cpcv makes.
 *
 * FAULT INJECTION, and it is a PERMANENT test rather than a one-off: the last case below perturbs a
 * single scoring rule in the league's config. That moves the content hash, so the chain must land on
 * a format nobody has built and REFUSE BY NAME -- it must not arrive at this golden anyway. Injecting
 * into the shipped `golden.json` itself was deliberately NOT done: it is a live artifact another
 * session may be reading, and a fault injection that needs a revert is one a crash can leave behind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, nowIso } from "../src/db/db.js";
import { resolveFormat } from "../src/data/formatResolve.js";
import { loadGolden, NoGoldenError } from "../scripts/lib/golden.mjs";

const YAHOO_KEY = "sc-a845f67652fb";
const FORMAT_DIR = join("data", "formats", YAHOO_KEY);
const SEASON = 2026;

/** The format's own declared rules, read from the directory rather than retyped. */
function declaredScoring(): { rules: unknown; kicker: unknown; defense: unknown } {
  return JSON.parse(readFileSync(join(FORMAT_DIR, "scoring.json"), "utf8"));
}

function withLeagueStore(fn: (dbPath: string, db: ReturnType<typeof openDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ff-golden-"));
  const path = join(dir, "t.db");
  const db = openDb(path);
  try {
    const sc = declaredScoring();
    const now = nowIso();
    db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?,?,?,?,?,?)")
      .run("129048", "yahoo", "superflex", SEASON, "1", now);
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)").run(
      "config:129048",
      JSON.stringify({ season: SEASON, draftType: "snake", scoring_rules: sc.rules, kicker: sc.kicker, defense: sc.defense }),
      now,
    );
    fn(path, db);
  } finally {
    db.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ }
  }
}

test("a Yahoo-format league resolves to its OWN golden master -- 99.2 playoffs / 39.8 titles", { skip: !existsSync(FORMAT_DIR) && "the format directory is gitignored; skipped on a clone without it" }, () => {
  withLeagueStore((_p, db) => {
    // The two calls `scripts/cpcv.mjs` makes, in its order.
    const fmt = resolveFormat(db, "129048");
    assert.equal(fmt.scoringKey, YAHOO_KEY, "the league's rules must hash to this format, or the rest is vacuous");
    // The golden file records the draft type it was measured under; a gate held against a run of the
    // other kind would be comparing two different engines.
    const pinned = JSON.parse(readFileSync(join(FORMAT_DIR, "golden.json"), "utf8")) as { draftType?: string };
    assert.equal(fmt.spec.draftType, pinned.draftType, "the resolved draft type must be the one the golden was measured under");
    const g = loadGolden(fmt.model, fmt.scoringKey);
    assert.equal(g.playoffPct, 99.2, "the PRIMARY gate for this format (D13 applies per format)");
    assert.equal(g.titlePct, 39.8, "CONTEXT only, never gated");
    assert.equal(g.tolerancePp, 3.0);
    // ...and it is NOT the incumbent's, which is the failure the no-fallback rule exists to prevent.
    assert.notEqual(g.playoffPct, 96.0);
    assert.match(g.path.replace(/\\/g, "/"), new RegExp(`formats/${YAHOO_KEY}/golden.json$`),
      "the numbers must come from the FORMAT's directory, not the data/ root");
  });
});

test("the CANDIDATE status travels with the number -- a tripwire is not an owner-signed posture", { skip: !existsSync(FORMAT_DIR) && "the format directory is gitignored; skipped on a clone without it" }, () => {
  const raw = JSON.parse(readFileSync(join(FORMAT_DIR, "golden.json"), "utf8")) as
    { provenance?: { status?: string; rePinRequired?: string } };
  assert.equal(raw.provenance?.status, "CANDIDATE GOLDEN",
    "this number is an executor-pinned tripwire; the day it becomes a shipped posture it gets a sign-off, not a silent promotion");
  assert.ok(raw.provenance?.rePinRequired, "and it says what invalidates it");
});

test("FAULT INJECTION: one changed scoring rule must NOT still arrive at this golden", { skip: !existsSync(FORMAT_DIR) && "the format directory is gitignored; skipped on a clone without it" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-golden-fi-"));
  const path = join(dir, "t.db");
  const db = openDb(path);
  try {
    const sc = declaredScoring() as { rules: Record<string, unknown>; kicker: unknown; defense: unknown };
    const now = nowIso();
    db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?,?,?,?,?,?)")
      .run("129048", "yahoo", "superflex", SEASON, "1", now);
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)").run(
      "config:129048",
      JSON.stringify({
        season: SEASON, draftType: "snake",
        scoring_rules: { ...sc.rules, rec: 0.77 },   // ONE rule moved -- a different format by definition
        kicker: sc.kicker, defense: sc.defense,
      }),
      now,
    );
    assert.throws(() => resolveFormat(db, "129048"),
      /no model has been built for that format/,
      "a league whose rules changed must be refused by name, never served the old format's gate");
  } finally {
    db.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ }
  }
});

test("a format with NO golden REFUSES rather than borrowing the incumbent's 96.0", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-nogolden-"));
  try {
    // A handle pointing at an empty directory: the same shape `resolveFormat` hands `loadGolden`.
    const handle = { path: () => join(dir, "golden.json") } as never;
    let err: unknown;
    try { loadGolden(handle, "sc-never-built"); } catch (e) { err = e; }
    assert.ok(err instanceof NoGoldenError,
      "cpcv distinguishes THIS from a malformed file by type -- one exits 2 by name, the other throws");
    assert.match(String((err as Error).message), /sc-never-built/, "the refusal names the format");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
