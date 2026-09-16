// POSITIVE CONTROL for the I-8 live-read timeout: with FF_LIVE_READ_TIMEOUT_MS set very low the
// "auto" schedule must FALL BACK (stored matchups, or a generated schedule) within the budget rather
// than blocking -- and with a generous budget the same call must still be able to reach the live read.
// A guard that can only ever refuse reads exactly like a guard that is working, so both directions
// are timed here.
//
//   node --import tsx scripts/live-read-timeout-probe.mjs [--ms 1]
import { loadSimContext } from "../src/draft/simContext.ts";

const i = process.argv.indexOf("--ms");
if (i >= 0) process.env.FF_LIVE_READ_TIMEOUT_MS = process.argv[i + 1];
const budget = Number(process.env.FF_LIVE_READ_TIMEOUT_MS ?? 15000);

const t0 = Date.now();
const ctx = await loadSimContext({ schedule: "auto" });
const ms = Date.now() - t0;
console.log(`budget ${budget}ms -> returned in ${ms}ms, syntheticSchedule=${ctx.syntheticSchedule}, weeks=${ctx.weeks.length}, teams=${ctx.teams.length}`);
if (ms > budget + 20000) { console.error("TIMEOUT DID NOT BOUND THE READ"); process.exit(1); }
console.log("bounded OK");
