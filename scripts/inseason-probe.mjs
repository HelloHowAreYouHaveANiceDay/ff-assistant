/**
 * Probe ESPN's per-week roster and transaction views through the running app's bridge.
 *
 * READ-ONLY. One request at a time. Nothing is written to the store; payloads are cached under
 * data/cache/espn/ so a re-run costs nothing and so the shape can be inspected offline.
 *
 * Usage: node scripts/inseason-probe.mjs
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";

const HOST = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
const LEAGUE = "462233";
const CACHE = "data/cache/espn";

function info() {
  const i = JSON.parse(readFileSync("data/app-bridge.json", "utf8"));
  process.kill(i.pid, 0);
  return i;
}

export function bridgeFetch(url, headers = {}, timeoutMs = 30000) {
  const i = info();
  const payload = JSON.stringify({ url, headers });
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port: i.port, path: "/fetch", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "x-ff-token": i.token },
      timeout: timeoutMs,
    }, (res) => { let o = ""; res.on("data", (d) => (o += d)); res.on("end", () => resolve(o)); });
    req.on("timeout", () => req.destroy(new Error("bridge timeout")));
    req.on("error", reject);
    req.write(payload); req.end();
  }).then((body) => {
    const p = JSON.parse(body);
    if (p.error) throw new Error("bridge: " + p.error);
    if (p.status && p.status >= 400) throw new Error("HTTP " + p.status);
    return p.body;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(key, url, headers) {
  mkdirSync(CACHE, { recursive: true });
  const f = `${CACHE}/${key}.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const txt = await bridgeFetch(url, headers);
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error("non-JSON: " + txt.slice(0, 200)); }
  writeFileSync(f, JSON.stringify(j));
  await sleep(700);
  return j;
}

function summarize(label, j) {
  const teams = Array.isArray(j) ? (j[0]?.teams ?? []) : (j.teams ?? []);
  const n = teams.length;
  const sizes = teams.map((t) => (t.roster?.entries ?? []).length);
  const e0 = teams[0]?.roster?.entries?.[0];
  console.log(`${label}: teams=${n} rosterSizes=${JSON.stringify(sizes)}`);
  if (e0) console.log("  entry keys:", Object.keys(e0).join(","), "| player keys:", Object.keys(e0.playerPoolEntry?.player ?? e0.player ?? {}).slice(0, 20).join(","));
}

async function main() {
  // Past season through leagueHistory
  for (const [season, week] of [[2020, 3], [2018, 5], [2024, 10]]) {
    try {
      const j = await get(`roster-${season}-w${week}`,
        `${HOST}/leagueHistory/${LEAGUE}?seasonId=${season}&view=mRoster&view=mTeam&scoringPeriodId=${week}`);
      summarize(`leagueHistory ${season} w${week}`, j);
      const t0 = (Array.isArray(j) ? j[0] : j).teams?.[0];
      if (t0) console.log("  sample entry:", JSON.stringify(t0.roster?.entries?.[0]).slice(0, 900));
    } catch (e) { console.log(`leagueHistory ${season} w${week}: FAIL ${e.message}`); }
  }
  // Current season
  for (const week of [1, 2]) {
    try {
      const j = await get(`roster-2026-w${week}`,
        `${HOST}/seasons/2026/segments/0/leagues/${LEAGUE}?view=mRoster&view=mTeam&scoringPeriodId=${week}`);
      summarize(`2026 w${week}`, j);
    } catch (e) { console.log(`2026 w${week}: FAIL ${e.message}`); }
  }
  // Transactions
  const filt = { transactions: { limit: 1000 } };
  for (const season of [2020, 2024]) {
    try {
      const j = await get(`tx-${season}`,
        `${HOST}/leagueHistory/${LEAGUE}?seasonId=${season}&view=mTransactions2`,
        { "x-fantasy-filter": JSON.stringify(filt) });
      const root = Array.isArray(j) ? j[0] : j;
      console.log(`mTransactions2 ${season}: keys=${Object.keys(root).join(",")} tx=${(root.transactions ?? []).length}`);
      if ((root.transactions ?? []).length) console.log("  sample:", JSON.stringify(root.transactions[0]).slice(0, 900));
    } catch (e) { console.log(`mTransactions2 ${season}: FAIL ${e.message}`); }
  }
  try {
    const j = await get("comm-2024",
      `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/leagueHistory/${LEAGUE}?seasonId=2024&view=kona_league_communication`,
      { "x-fantasy-filter": JSON.stringify({ topics: { filterType: { value: ["ACTIVITY_TRANSACTIONAL"] }, limit: 1000, offset: 0, sortMessageDate: { sortPriority: 1, sortAsc: false } } }) });
    const root = Array.isArray(j) ? j[0] : j;
    console.log("comm 2024: keys=" + Object.keys(root).join(",") + " topics=" + (root.topics ?? []).length);
    if ((root.topics ?? []).length) console.log("  sample:", JSON.stringify(root.topics[0]).slice(0, 900));
  } catch (e) { console.log("comm 2024: FAIL " + e.message); }
}

main().catch((e) => { console.error(e); process.exit(1); });
