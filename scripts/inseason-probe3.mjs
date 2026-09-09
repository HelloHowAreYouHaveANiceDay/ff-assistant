/**
 * Third probe. Probe 2 established that leagueHistory+mRoster IGNORES scoringPeriodId (identical
 * roster and identical starters for weeks 1/3/8/14 of 2020), so mRoster cannot be the per-week
 * source for past seasons. The per-week lineup lives in the BOXSCORE view instead. This probe
 * checks mBoxscore/mMatchupScore, and re-tries transactions on the /seasons/ path for past years.
 * READ-ONLY, cached, one request at a time.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";

const HOST = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
const LEAGUE = "462233";
const CACHE = "data/cache/espn";

function info() { const i = JSON.parse(readFileSync("data/app-bridge.json", "utf8")); process.kill(i.pid, 0); return i; }
function bridgeFetch(url, headers = {}, timeoutMs = 45000) {
  const i = info();
  const payload = JSON.stringify({ url, headers });
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: i.port, path: "/fetch", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "x-ff-token": i.token }, timeout: timeoutMs },
      (res) => { let o = ""; res.on("data", (d) => (o += d)); res.on("end", () => resolve(o)); });
    req.on("timeout", () => req.destroy(new Error("bridge timeout")));
    req.on("error", reject); req.write(payload); req.end();
  }).then((body) => { const p = JSON.parse(body); if (p.error) throw new Error("bridge: " + p.error);
    if (p.status && p.status >= 400) throw new Error("HTTP " + p.status); return p.body; });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(key, url, headers) {
  mkdirSync(CACHE, { recursive: true });
  const f = `${CACHE}/${key}.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const txt = await bridgeFetch(url, headers);
  let j; try { j = JSON.parse(txt); } catch { throw new Error("non-JSON: " + txt.slice(0, 200)); }
  writeFileSync(f, JSON.stringify(j)); await sleep(700); return j;
}
const root = (j) => (Array.isArray(j) ? j[0] : j);

async function main() {
  // A. boxscore per scoring period, past season
  for (const w of [3, 8]) {
    try {
      const j = root(await get(`box-2020-w${w}`, `${HOST}/leagueHistory/${LEAGUE}?seasonId=2020&scoringPeriodId=${w}&view=mBoxscore&view=mMatchupScore`));
      const sched = (j.schedule ?? []).filter((m) => m.matchupPeriodId === w);
      console.log(`box 2020 w${w}: scheduleAll=${(j.schedule ?? []).length} thisWeek=${sched.length}`);
      const h = sched[0]?.home;
      if (h) {
        const ent = h.rosterForCurrentScoringPeriod?.entries ?? [];
        console.log(`  home team ${h.teamId} totalPoints=${h.totalPoints} rosterForCurrentScoringPeriod n=${ent.length}`);
        console.log("  slots:", JSON.stringify(ent.map((e) => [e.playerId, e.lineupSlotId, e.playerPoolEntry?.appliedStatTotal])).slice(0, 700));
      }
    } catch (e) { console.log(`box 2020 w${w}: FAIL ${e.message}`); }
  }
  // B. do the boxscore lineups actually differ week to week?
  try {
    const a = root(await get(`box-2020-w3`, ""));
    const b = root(await get(`box-2020-w8`, ""));
    const pick = (j, w) => {
      const m = (j.schedule ?? []).find((x) => x.matchupPeriodId === w && x.home?.teamId === 1) ?? (j.schedule ?? []).find((x) => x.matchupPeriodId === w && x.away?.teamId === 1);
      const side = m?.home?.teamId === 1 ? m.home : m?.away;
      return (side?.rosterForCurrentScoringPeriod?.entries ?? []).filter((e) => e.lineupSlotId !== 20 && e.lineupSlotId !== 21).map((e) => e.playerId).sort((x, y) => x - y).join(",");
    };
    console.log("team1 w3 starters:", pick(a, 3));
    console.log("team1 w8 starters:", pick(b, 8));
  } catch (e) { console.log("compare: FAIL " + e.message); }

  // C. transactions on the /seasons/ path for past years, no filter
  for (const season of [2018, 2020, 2024, 2025]) {
    try {
      const j = root(await get(`tx-seasons-${season}`, `${HOST}/seasons/${season}/segments/0/leagues/${LEAGUE}?view=mTransactions2`));
      const tx = j.transactions ?? [];
      const types = {};
      for (const t of tx) types[t.type] = (types[t.type] ?? 0) + 1;
      console.log(`tx /seasons/${season}: n=${tx.length} types=${JSON.stringify(types)}`);
    } catch (e) { console.log(`tx /seasons/${season}: FAIL ${e.message}`); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
