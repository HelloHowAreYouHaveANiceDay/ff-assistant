// The CONTRIBUTION LEDGER driver (scripts/contribution-ledger.mjs), tested WITHOUT running a trainer.
//
// The driver's own logic is: reuse an arm whose json already exists, shape the ledger rows, apply the
// BH family adjustment across the LOO rows only (a family arm is not a member of the LOO family), and
// report a DEGENERATE arm BY NAME rather than as a zero contribution. All four are exercised by
// pre-seeding the out-dir with admit-feature's `--json` dumps, which is exactly the contract the two
// scripts share. The FAULT case is the one that matters: a degenerate row must NOT read as a DROP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEASONS = [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const SEL = SEASONS.filter((s) => s < 2021);
const HELD = SEASONS.filter((s) => s >= 2021);

function dump(dir: string, id: string, o: Record<string, unknown>) {
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    candidate: id, pos: null, removeMode: true, db: "data/ff.db",
    seasons: SEASONS, selectionSeasons: SEL, holdoutSeasons: HELD,
    perSeason: SEASONS.map((s, i) => ({ season: s, base: 12 + i * 0.01, cand: 12 + i * 0.01, contribution: 0 })),
    ...o,
  }, null, 2));
}
const verdict = (improvement: number, se: number, pass: boolean) =>
  ({ improvement, se, t: improvement / se, floor: 2.9 * se, wins: 6, nSeasons: 8, ciLo: 0, ciHi: 0, pass });

function runLedger(arms: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "ff-ledger-test-"));
  const armsPath = join(dir, "arms.json");
  writeFileSync(armsPath, JSON.stringify(arms));
  return { dir, armsPath };
}

test("ledger: reuses existing arm dumps, shapes KEEP/DROP, and adds a BH q to the LOO family", () => {
  const { dir, armsPath } = runLedger([
    { id: "loo-big", candidate: "big" },
    { id: "loo-small", candidate: "small" },
    { id: "fam-x", candidate: "big,small", family: true },
  ]);
  dump(dir, "loo-big", { status: "OK", decision: verdict(0.45, 0.06, true), confirm: verdict(0.24, 0.05, true) });
  dump(dir, "loo-small", { status: "OK", decision: verdict(0.004, 0.05, false), confirm: verdict(-0.01, 0.04, false) });
  dump(dir, "fam-x", { status: "OK", decision: verdict(0.5, 0.07, true), confirm: verdict(0.3, 0.06, true) });

  const r = spawnSync("node", ["--import", "tsx", "scripts/contribution-ledger.mjs", "--arms", armsPath, "--out", dir],
    { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const ledger = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
  const by = Object.fromEntries(ledger.map((x: { id: string }) => [x.id, x]));
  assert.equal(by["loo-big"].verdict, "KEEP");
  assert.equal(by["loo-small"].verdict, "DROP");
  assert.equal(by["loo-big"].holdout.confirmed, true);
  // BH is applied across the LOO rows only -- a family arm is a different comparison, not a 3rd member.
  assert.ok(by["loo-big"].q != null && by["loo-big"].q < 0.05, `q ${by["loo-big"].q}`);
  assert.ok(by["loo-small"].q > 0.2, `q ${by["loo-small"].q}`);
  assert.equal(by["fam-x"].q, null);
  assert.equal(by["fam-x"].family, true);
  // per-season contributions survive for the per-era table.
  assert.equal(by["loo-big"].perSeason.length, SEASONS.length);
});

test("FAULT: a DEGENERATE arm is reported as DEGENERATE, never as a zero contribution", () => {
  const { dir, armsPath } = runLedger([{ id: "loo-dead", candidate: "dead" }]);
  dump(dir, "loo-dead", { status: "DEGENERATE" });
  const r = spawnSync("node", ["--import", "tsx", "scripts/contribution-ledger.mjs", "--arms", armsPath, "--out", dir],
    { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const ledger = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
  assert.equal(ledger[0].status, "DEGENERATE");
  assert.equal(ledger[0].contribution, undefined);
  assert.equal(ledger[0].verdict, undefined);
  assert.match(r.stdout, /DEGENERATE/);
});
