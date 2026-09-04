// Run N COMPLETE ESPN practice auctions end-to-end through the app's embedded webview, and record
// what the agent actually built each time. This is the reliability + quality harness: the backtest
// says what SHOULD happen, this says what does happen against a live room.
//
//   node scripts/mock-suite.mjs 10            # run 10 drafts
//   node scripts/mock-suite.mjs 1 --keep      # one draft, leave the room open for inspection
//
// Per draft it records: whether the roster filled 12/12, $ spent, positional mix, TE count, the
// most ever paid for a K/DST, and every stall/error line. Results append to data/mock-runs.jsonl
// (gitignored) so a crashed run never loses earlier drafts.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const N = Number(process.argv[2] || 1);
const KEEP = process.argv.includes("--keep");
const OUT = path.join("data", "mock-runs.jsonl");
// A 192-pick ESPN auction runs ~60-100 min of WALL time (their nomination clock, not our polling),
// and the cheap endgame -- where we fill most slots -- is the slowest part per slot. Measured mock 1
// at ~64 min to reach 4/12. A timeout shorter than the draft records a spurious INCOMPLETE, which
// would look exactly like an engine failure.
const DRAFT_TIMEOUT_MS = 150 * 60 * 1000;
// auto-draft's own round cap must also outlast the draft: it exits when rounds are exhausted, with
// slots still open. ~3.6s/round observed => 4000 rounds ~ 4h of headroom.
const DRAFT_ROUNDS = 4000;
const LAUNCH_TIMEOUT_MS = 5 * 60 * 1000;

const run = (args, timeoutMs, logPath) => new Promise((resolve) => {
  const log = fs.createWriteStream(logPath, { flags: "a" });
  const c = spawn("npx", ["tsx", "src/ff.ts", ...args], { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  let out = "";
  const cap = (d) => { const s = d.toString(); out += s; log.write(s); };
  c.stdout.on("data", cap); c.stderr.on("data", cap);
  const timer = setTimeout(() => { try { c.kill(); } catch {} resolve({ out, timedOut: true, code: null }); }, timeoutMs);
  c.on("close", (code) => { clearTimeout(timer); log.end(); resolve({ out, timedOut: false, code }); });
});

import { loadPositionIndex, parseRoster } from "./lib-roster.mjs";
const posIndex = loadPositionIndex();

// Record WHICH BUILD produced each draft. The suite runs for hours and the tree can move under it
// (it did: benchDiscount shipped mid-suite), so a record without a SHA cannot be compared later.
let buildSha = "unknown";
try { buildSha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch {}

const results = [];
for (let i = 1; i <= N; i++) {
  const started = new Date().toISOString();
  const logPath = path.join("data", `mock-${String(i).padStart(2, "0")}.log`);
  try { fs.unlinkSync(logPath); } catch {}
  console.log(`\n=== MOCK ${i}/${N} -- launching (${started}) ===`);

  const launch = await run(["launch-practice", "--app"], LAUNCH_TIMEOUT_MS, logPath);
  const roomUrl = (/practice draft started -> (\S+)/.exec(launch.out) || [])[1] || null;
  if (!roomUrl) {
    console.log("  LAUNCH FAILED:", launch.out.trim().split("\n").slice(-2).join(" | ").slice(0, 200));
    results.push({ i, started, launched: false, error: launch.out.trim().slice(-300) });
    fs.appendFileSync(OUT, JSON.stringify(results.at(-1)) + "\n");
    continue;
  }
  console.log(`  room: ${roomUrl.slice(0, 90)}`);

  const t0 = Date.now();
  const draft = await run(["auto-draft", "--app", "--rounds", String(DRAFT_ROUNDS)], DRAFT_TIMEOUT_MS, logPath);
  const mins = Math.round((Date.now() - t0) / 60000);

  const rosterRes = await run(["roster", "--app"], 3 * 60 * 1000, logPath);
  const roster = parseRoster(rosterRes.out, posIndex);

  const lines = draft.out.split("\n");
  const stalls = lines.filter((l) => /stall|disconnect|error|Error|cannot|failed/i.test(l)).slice(0, 10);
  const byPos = roster.byPos;
  const kdstMax = roster.kdstMax;

  let shaNow = buildSha;
  try { shaNow = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch {}
  const rec = {
    i, started, minutes: mins, roomUrl, build: shaNow,
    complete: roster.filled === roster.slots && roster.slots > 0,
    filled: roster.filled, slots: roster.slots, spent: roster.spent,
    byPos, teCount: roster.teCount, kdstMax, unresolved: roster.unresolved,
    timedOut: draft.timedOut, exitCode: draft.code,
    won: roster.won, stalls,
  };
  results.push(rec);
  fs.appendFileSync(OUT, JSON.stringify(rec) + "\n");
  console.log(`  ${rec.complete ? "COMPLETE" : "INCOMPLETE"} ${rec.filled}/${rec.slots} spent $${rec.spent} in ${mins}m | TE ${rec.teCount} | maxK/DST $${rec.kdstMax}${rec.timedOut ? " | TIMED OUT" : ""}`);
  if (stalls.length) console.log(`  stalls/errors: ${stalls.length} (first: ${stalls[0].slice(0, 110)})`);
}

console.log("\n=== SUMMARY ===");
const done = results.filter((r) => r.complete);
console.log(`complete drafts: ${done.length}/${results.length}`);
if (done.length) {
  const avg = (f) => (done.reduce((s, r) => s + f(r), 0) / done.length).toFixed(2);
  console.log(`avg spent $${avg((r) => r.spent)} | avg TE ${avg((r) => r.teCount)} | worst K/DST $${Math.max(...done.map((r) => r.kdstMax))}`);
  console.log(`avg minutes ${avg((r) => r.minutes)}`);
}
for (const r of results) {
  console.log(` ${String(r.i).padStart(2)}: ${r.complete ? "OK  " : "FAIL"} ${r.filled ?? "?"}/${r.slots ?? "?"} $${r.spent ?? "?"} TE${r.teCount ?? "?"} ${r.timedOut ? "timeout" : ""}`);
}
console.log(`\nrecords -> ${OUT}`);
if (!KEEP) console.log("(rooms are left as-is; ESPN cleans up practice rooms)");
