// The CANDIDATE median floor (FF_WEEKLY_MEAN_FLOOR=1, src/weekly/projector.ts): off = byte-identical
// serve; on = a likely-to-play man's mean is never below his own p50, only ever raised, and a man more
// likely than not to miss is untouched. Run on the SERVED artifact and the store's live 2026 wk4 rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { openDb } from "../src/db/db.js";
import { loadWeeklyRows } from "../src/weekly/features.js";
import { loadWeeklyArtifact, projectWeekly } from "../src/weekly/projector.js";

const ART = "data/weekly-artifact.json";
const ready = existsSync(ART) && existsSync("data/ff.db");

function run(floor: boolean) {
  const prev = process.env.FF_WEEKLY_MEAN_FLOOR;
  // "off" FORCES the floor off even when the served artifact carries `meanFloor: true` (D49).
  process.env.FF_WEEKLY_MEAN_FLOOR = floor ? "1" : "off";
  try {
    const db = openDb("data/ff.db");
    try {
      const rows = loadWeeklyRows(db as never, 2026, 4);
      return projectWeekly({ artifact: loadWeeklyArtifact(JSON.parse(readFileSync(ART, "utf8"))), rows });
    } finally { db.close(); }
  } finally { if (prev === undefined) delete process.env.FF_WEEKLY_MEAN_FLOOR; else process.env.FF_WEEKLY_MEAN_FLOOR = prev; }
}

test("median floor: off is the serve unchanged; on never lowers, floors likely players at p50, leaves likely-misses alone", (t) => {
  if (!ready) return t.skip("no served artifact / store");
  const off = run(false), on = run(true);
  assert.equal(on.length, off.length);
  const byKey = new Map(off.map((r) => [`${r.week}|${r.feat_key}`, r]));
  let raised = 0;
  for (const x of on) {
    const c = byKey.get(`${x.week}|${x.feat_key}`)!;
    assert.ok(c, `row ${x.name} missing from the control`);
    assert.equal(x.p10, c.p10); assert.equal(x.p50, c.p50); assert.equal(x.p90, c.p90);   // bands untouched
    assert.ok(x.mean >= c.mean - 1e-9, `${x.name}: the floor LOWERED a mean (${c.mean} -> ${x.mean})`);
    const pz = x.pZero ?? 0;
    if (pz < 0.5 && x.p50 > 0) assert.ok(x.mean >= x.p50 - 1e-9, `${x.name}: mean ${x.mean} still below p50 ${x.p50}`);
    else assert.equal(x.mean, c.mean, `${x.name}: a likely-miss (pZero ${pz}) was changed`);
    if (x.mean > c.mean + 1e-9) raised++;
  }
  // POSITIVE CONTROL: the floor must actually fire on the live week that motivated it (Wilson et al.).
  assert.ok(raised > 0, "the floor raised nothing -- a dead lever reads exactly like a null");
  const gw = on.find((r) => r.name === "Garrett Wilson");
  if (gw) assert.ok(gw.mean >= gw.p50 - 1e-9);
});

test("D49: the SERVED artifact carries meanFloor, so the floor is on with no env switch -- and still loads (golden)", (t) => {
  if (!ready) return t.skip("no served artifact / store");
  const json = JSON.parse(readFileSync(ART, "utf8"));
  assert.equal(json.meanFloor, true, "data/weekly-artifact.json does not carry meanFloor: true");
  const prev = process.env.FF_WEEKLY_MEAN_FLOOR; delete process.env.FF_WEEKLY_MEAN_FLOOR;
  try {
    const db = openDb("data/ff.db");
    try {
      const rows = loadWeeklyRows(db as never, 2026, 4);
      const served = projectWeekly({ artifact: loadWeeklyArtifact(json), rows });   // loads => golden passed
      for (const r of served) if ((r.pZero ?? 0) < 0.5 && r.p50 > 0) assert.ok(r.mean >= r.p50 - 1e-9, `${r.name}: served mean below p50`);
    } finally { db.close(); }
  } finally { if (prev === undefined) delete process.env.FF_WEEKLY_MEAN_FLOOR; else process.env.FF_WEEKLY_MEAN_FLOOR = prev; }
});
