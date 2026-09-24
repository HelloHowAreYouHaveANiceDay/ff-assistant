// REAP ORPHANED EVALUATION ARMS: clean their output and write the status files their dead shells
// never will.
//
// WHY THIS EXISTS. The harness OOM-killed six background tasks. It killed the SHELL WRAPPERS; the
// node/python trees underneath survived and kept training (fold artifacts kept landing minutes
// later). But each arm was launched as:
//
//     npm run ff -- evaluate-weekly ... > eval-X.json 2> eval-X.err ; echo $? > status-X.txt
//
// and the `echo $?` belonged to the dead shell. So the arms finish, write their JSON through a
// still-open fd, and NO STATUS FILE EVER APPEARS -- leaving the chain waiting forever on a
// condition that cannot occur. This writes those status files from the evidence instead.
//
// AND IT FIXES A LATENT BUG IN THE CHAIN. `npm run` prints its banner to STDOUT, and the evaluator
// prints progress there too, so eval-X.json is banner + progress + JSON. `weekly-paired-floor.mjs`
// does a plain JSON.parse on that file and would have thrown on every gate -- a failure that was
// waiting regardless of the OOM. The file is rewritten here to contain ONLY the JSON object, so
// the chain's existing gate calls work unchanged.
//
// IT REFUSES RATHER THAN GUESSES. A status of 0 is written only for an arm whose JSON parses AND
// carries a plausible per-season block. Anything else gets a non-zero status, which makes the
// chain abort loudly instead of gating a half-finished arm against a complete one -- comparing a
// truncated arm to a whole one would produce a confident, meaningless number.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const S = process.argv[2];
if (!S) { console.error("usage: node scripts/eval-reaper.mjs <scratchpad-dir> [arms...]"); process.exit(1); }
const ARMS = process.argv.slice(3).length ? process.argv.slice(3) : ["base", "cand", "rz", "vol"];
const MIN_SEASONS = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How many evaluate-weekly node processes are still alive. Zero means every arm has exited. */
function liveEvals() {
  try {
    const out = execSync(
      'powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process | ' +
      "Where-Object { $_.CommandLine -like '*evaluate-weekly*' -and $_.Name -eq 'node.exe' } | " +
      'Measure-Object).Count"',
      { encoding: "utf8", timeout: 120000 },
    );
    return Number(String(out).trim()) || 0;
  } catch { return -1; }
}

/**
 * Pull the trailing JSON object out of a file that also contains npm's banner and the evaluator's
 * human-readable progress. `--json` prints JSON.stringify(res, null, 2) last, so the object starts
 * at a line that is exactly "{". Try each such position and keep the first that parses to the end
 * -- which is stricter than taking the last "{", because a progress line could contain a brace.
 */
function extractJson(text) {
  const positions = [];
  if (text.startsWith("{")) positions.push(0);
  for (let i = 0; (i = text.indexOf("\n{", i)) !== -1; i++) positions.push(i + 1);
  for (const p of positions) {
    const slice = text.slice(p).trim();
    try {
      const v = JSON.parse(slice);
      if (v && typeof v === "object") return { json: v, text: slice };
    } catch { /* not this one */ }
  }
  return null;
}

/** A parsed result is only usable if it carries a per-season block the gate can actually read. */
function seasonsIn(j) {
  const by = j?.bySeason ?? j?.result?.bySeason ?? null;
  if (!by || typeof by !== "object") return 0;
  return Object.keys(by).length;
}

console.log(`reaper: watching ${ARMS.join(", ")} in ${S}`);
let quiet = 0;
for (;;) {
  const n = liveEvals();
  const done = ARMS.filter((a) => existsSync(`${S}/status-${a}.txt`)).length;
  console.log(`[${new Date().toTimeString().slice(0, 8)}] live evaluate-weekly procs: ${n} | status files: ${done}/${ARMS.length}`);
  // Require TWO consecutive zero readings before reaping: a single zero could be sampled in the
  // gap between one fold's subprocess exiting and the next one starting.
  if (n === 0) { quiet++; if (quiet >= 2) break; } else { quiet = 0; }
  if (done === ARMS.length) break;
  await sleep(60000);
}

console.log("reaper: no evaluation processes left -- reaping.");
for (const arm of ARMS) {
  const path = `${S}/eval-${arm}.json`;
  const statusPath = `${S}/status-${arm}.txt`;
  if (existsSync(statusPath)) { console.log(`  ${arm}: status already present (${readFileSync(statusPath, "utf8").trim()}) -- left alone`); continue; }
  if (!existsSync(path)) { writeFileSync(statusPath, "127\n"); console.log(`  ${arm}: NO OUTPUT FILE -> status 127`); continue; }
  const raw = readFileSync(path, "utf8");
  const got = extractJson(raw);
  if (!got) {
    writeFileSync(statusPath, "1\n");
    console.log(`  ${arm}: ${raw.length} bytes but NO PARSEABLE JSON -> status 1 (the chain will refuse to gate it)`);
    continue;
  }
  const ns = seasonsIn(got.json);
  if (ns < MIN_SEASONS) {
    writeFileSync(statusPath, "1\n");
    console.log(`  ${arm}: parsed but only ${ns} season(s) < ${MIN_SEASONS} -> status 1 (truncated run)`);
    continue;
  }
  writeFileSync(path, got.text + "\n");
  writeFileSync(statusPath, "0\n");
  console.log(`  ${arm}: OK -- ${ns} seasons, rewrote ${raw.length} -> ${got.text.length} bytes (JSON only), status 0`);
}
console.log("reaper: done.");
