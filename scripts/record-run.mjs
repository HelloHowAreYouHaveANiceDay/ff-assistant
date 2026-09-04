// Append one mock-draft record from a finished run's log + a live roster read. Used when the suite
// supervisor was stopped mid-run (e.g. to lift a too-short timeout) but the draft itself completed:
// the result is real data and should not be thrown away just because the parent process is gone.
//
//   node scripts/record-run.mjs 1 <build-sha> <minutes>
import fs from "node:fs";
import { execSync } from "node:child_process";
import { loadPositionIndex, parseRoster } from "./lib-roster.mjs";

const [, , idxArg, shaArg, minsArg] = process.argv;
const i = Number(idxArg || 1);
const logPath = `data/mock-${String(i).padStart(2, "0")}.log`;

const idx = loadPositionIndex();
const rosterTxt = execSync("npx tsx src/ff.ts roster --app", { encoding: "utf8", timeout: 240000 });
const R = parseRoster(rosterTxt, idx);
const won = R.won;

const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
const rec = {
  i,
  started: null,
  minutes: Number(minsArg || 0),
  build: shaArg || "unknown",
  roomUrl: (/practice draft started -> (\S+)/.exec(log) || [])[1] || null,
  complete: R.filled != null && R.filled === R.slots,
  filled: R.filled, slots: R.slots, spent: R.spent,
  byPos: R.byPos, teCount: R.teCount, kdstMax: R.kdstMax, unresolved: R.unresolved,
  srcCounts: (log.match(/src=[a-z()-]+/g) || []).reduce((a, s) => (a[s] = (a[s] || 0) + 1, a), {}),
  dupeNominations: (() => {
    const noms = (log.match(/NOMINATE ([A-Za-z'.\- ]+?)\s+\(/g) || []).map((x) => x.replace(/^NOMINATE /, "").trim());
    const seen = new Map();
    for (const n of noms) seen.set(n, (seen.get(n) || 0) + 1);
    return [...seen.entries()].filter(([, c]) => c > 1).map(([n, c]) => `${n} x${c}`);
  })(),
  stalls: log.split("\n").filter((l) => /stall|disconnect|error|Error|cannot|failed/i.test(l)).slice(0, 10),
  won,
};
fs.appendFileSync("data/mock-runs.jsonl", JSON.stringify(rec) + "\n");
console.log(JSON.stringify(rec, null, 1).slice(0, 1800));
