/**
 * Sixth probe: last attempts at a PAST-season transaction log. Every mTransactions2 shape tried so
 * far returns an empty array for 2018-2025 while the same view returns 206 rows for 2026, which
 * points at ESPN retaining the log only for the current season. Before recording that as fact, try
 * the communication topic feed on both hosts and a scoringPeriod-scoped transaction query.
 * READ-ONLY, cached, one request at a time.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";

const HOST = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
const ALT = "https://fantasy.espn.com/apis/v3/games/ffl";
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
const TOPICS = JSON.stringify({ topics: { filterType: { value: ["ACTIVITY_TRANSACTIONAL"] }, limit: 1000, offset: 0, sortMessageDate: { sortPriority: 1, sortAsc: false } } });

async function main() {
  const attempts = [
    ["c1", `${ALT}/seasons/2024/segments/0/leagues/${LEAGUE}/communication/?view=kona_league_communication`, { "x-fantasy-filter": TOPICS }],
    ["c2", `${HOST}/seasons/2024/segments/0/leagues/${LEAGUE}/communication?view=kona_league_communication`, { "x-fantasy-filter": TOPICS }],
    ["c3", `${ALT}/seasons/2026/segments/0/leagues/${LEAGUE}/communication/?view=kona_league_communication`, { "x-fantasy-filter": TOPICS }],
    ["t1", `${HOST}/seasons/2024/segments/0/leagues/${LEAGUE}?scoringPeriodId=5&view=mTransactions2`, undefined],
    ["t2", `${ALT}/seasons/2024/segments/0/leagues/${LEAGUE}?view=mTransactions2`, undefined],
    ["t3", `${HOST}/seasons/2025/segments/0/leagues/${LEAGUE}?view=mTransactions2&view=mTeam&view=mSettings`, undefined],
  ];
  for (const [k, url, h] of attempts) {
    try {
      const j = root(await get(`probe6-${k}`, url, h));
      console.log(`${k}: keys=${Object.keys(j).join(",")} tx=${(j.transactions ?? []).length} topics=${(j.topics ?? []).length}`);
    } catch (e) { console.log(`${k}: FAIL ${e.message}`); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
