// Analyze the completed mock drafts against the expectations stated BEFORE they ran
// (scripts/expectations.mjs). Nomination/source metrics are recomputed from the LOGS rather than
// read from the records: the suite was already running when parseDraftLog() was added, so those
// fields are absent from the earlier records -- and `(rec.field||[]).length` would report 0, which
// reads exactly like "no problem found".
import fs from "node:fs";
import { parseDraftLog, positionsFromLog, initialKey, nameKey } from "./lib-roster.mjs";

const recs = fs.readFileSync("data/mock-runs.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));

// Match each record to its log by ROOM URL, not by position. Two suites both wrote mock-01.log, so
// the second overwrote the first and the arrays are not parallel -- positional pairing silently
// attributed one draft's metrics to another.
const logByRoom = new Map();
for (const f of fs.readdirSync("data").filter((f) => /^mock-\d+\.log$/.test(f))) {
  const txt = fs.readFileSync(`data/${f}`, "utf8");
  const room = (/practice draft started -> (\S+)/.exec(txt) || [])[1];
  if (room) logByRoom.set(room, txt);
}
const logFor = (r) => (r.roomUrl ? logByRoom.get(r.roomUrl) ?? null : null);

console.log(`MOCK DRAFT ANALYSIS -- ${recs.length} drafts\n`);
console.log("  #  build     filled  spent  min  TE  K/DST  QB RB WR TE  src=ours/espn  noms(dupe/fail)");
const rows = [];
recs.forEach((r) => {
  const txt = logFor(r);
  const L = txt ? parseDraftLog(txt) : null;
  // Re-resolve any roster entry the store could not place, using the log's full names.
  if (txt && (r.unresolved || []).length) {
    const lp = positionsFromLog(txt);
    for (const w of r.won || []) {
      if (w.pos !== "?") continue;
      const got = lp.byFull.get(nameKey(w.name)) || lp.byInitial.get(initialKey(w.name));
      if (got && got !== "?") { w.pos = got; r.byPos[got] = (r.byPos[got] || 0) + 1; r.byPos["?"]--; }
    }
    if (r.byPos["?"] <= 0) delete r.byPos["?"];
    r.unresolved = (r.won || []).filter((w) => w.pos === "?").map((w) => w.name);
    r.teCount = r.byPos.TE || 0;
  }
  const p = r.byPos || {};
  const ours = L?.srcCounts?.["src=ours"] ?? 0;
  const espn = (L?.srcCounts?.["src=espn"] ?? 0) + (L?.srcCounts?.["src=floor"] ?? 0);
  rows.push({ r, L, ours, espn });
  console.log(
    `  ${String(r.i).padStart(2)}  ${(r.build || "?").padEnd(9)} ${String(r.filled + "/" + r.slots).padStart(6)}  ` +
    `$${String(r.spent).padStart(4)}  ${String(r.minutes).padStart(3)}  ${String(r.teCount).padStart(2)}  ` +
    `$${String(r.kdstMax).padStart(4)}  ${String(p.QB || 0).padStart(2)} ${String(p.RB || 0).padStart(2)} ${String(p.WR || 0).padStart(2)} ${String(p.TE || 0).padStart(2)}  ` +
    `${String(ours).padStart(5)}/${String(espn).padEnd(4)}  ${L ? `${L.nominations}(${L.dupeNominations.length}/${L.failedNominations})` : "-"}`,
  );
});

// --- invariants stated up front (mechanics; must hold in ANY room) ---
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); if (!ok) fails.push(name); };
console.log("\nMECHANICS INVARIANTS (pre-registered):");
check("every draft completes 12/12", recs.every((r) => r.filled === 12 && r.slots === 12),
  `${recs.filter((r) => r.filled === 12).length}/${recs.length}`);
check("exactly 2 K/DST per roster", recs.every((r) => ((r.byPos?.K || 0) + (r.byPos?.DST || 0)) === 2),
  recs.map((r) => (r.byPos?.K || 0) + (r.byPos?.DST || 0)).join(","));
check("no K/DST above $2", recs.every((r) => r.kdstMax <= 2), `max seen $${Math.max(...recs.map((r) => r.kdstMax))}`);
check("TE count within 1-4", recs.every((r) => r.teCount >= 1 && r.teCount <= 4),
  `range ${Math.min(...recs.map((r) => r.teCount))}-${Math.max(...recs.map((r) => r.teCount))}`);
// Unresolved = an abbreviated name whose initial+surname matches several players with DIFFERENT
// positions ("J. Williams"). The parser REFUSES to guess there, which is correct, so this is a note
// rather than a failure -- it is only a problem if it hides a TE (the metric we judge on).
const unresolved = recs.flatMap((r) => (r.unresolved || []).map((n) => `${n} (draft ${r.i})`));
console.log(`  note  unresolved (ambiguous initials, parser refused to guess): ${unresolved.length}${unresolved.length ? " -- " + unresolved.join(", ") : ""}`);
const totOurs = rows.reduce((a, x) => a + x.ours, 0), totEspn = rows.reduce((a, x) => a + x.espn, 0);
// The one fallback was "Steelers D/ST" arriving with pos=K, which the name-gated alias (f4277a4)
// fixes. Judge the CURRENT build: a fallback on a post-fix run is a real regression.
const FIXED_FROM = "f4277a4";
const postFix = rows.filter((x) => x.r.build === FIXED_FROM);
const postEspn = postFix.reduce((a, x) => a + x.espn, 0);
check(`value table resolves every bid on the current build (${FIXED_FROM})`, postEspn === 0,
  `${postFix.length} drafts, ${postFix.reduce((a, x) => a + x.ours, 0)} ours / ${postEspn} fallback` +
  ` (all builds: ${totOurs} ours / ${totEspn} fallback)`);
// The stored `stalls` came from an over-broad /failed/ regex that also caught benign FAILED
// NOMINATIONS. Recount from the logs with the narrower detector, and report failed nominations
// separately -- they are expected (a fallback nomination fired when it was not our turn).
const stalls = rows.reduce((a, x) => a + (x.L?.stalls?.length ?? 0), 0);
const failedNoms = rows.reduce((a, x) => a + (x.L?.failedNominations ?? 0), 0);
check("no stalls or errors", stalls === 0, `${stalls} lines`);
console.log(`  note  failed nomination attempts (benign, retried): ${failedNoms}`);

// --- room-dependent: spend/mix, compared to the OFFLINE expectation for OUR league ---
const spends = recs.map((r) => r.spent).sort((a, b) => a - b);
const med = spends[Math.floor(spends.length / 2)];
const mean = (spends.reduce((a, b) => a + b, 0) / spends.length).toFixed(1);
console.log(`\nSPEND (room-dependent -- offline expectation vs THIS league was median $170, range $161-174):`);
console.log(`  live: min $${spends[0]}  median $${med}  mean $${mean}  max $${spends.at(-1)}`);
console.log(`  TE per draft: mean ${(recs.reduce((a, r) => a + r.teCount, 0) / recs.length).toFixed(2)} (offline median 2)`);
console.log(`  minutes: mean ${(recs.reduce((a, r) => a + r.minutes, 0) / recs.length).toFixed(1)}`);

console.log(fails.length ? `\n${fails.length} INVARIANT(S) FAILED: ${fails.join(", ")}` : "\nALL MECHANICS INVARIANTS HOLD");
process.exit(fails.length ? 1 : 0);
