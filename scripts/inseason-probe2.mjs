/**
 * Second probe: does scoringPeriodId actually move the roster, and where do transactions live?
 * READ-ONLY, cached, one request at a time.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";

const HOST = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
const LEAGUE = "462233";
const CACHE = "data/cache/espn";

function info() { const i = JSON.parse(readFileSync("data/app-bridge.json", "utf8")); process.kill(i.pid, 0); return i; }
function bridgeFetch(url, headers = {}, timeoutMs = 30000) {
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
  // 1. Does scoringPeriodId move the roster?
  const sigs = {};
  for (const w of [1, 3, 8, 14]) {
    const j = root(await get(`roster-2020-w${w}`, `${HOST}/leagueHistory/${LEAGUE}?seasonId=2020&view=mRoster&view=mTeam&scoringPeriodId=${w}`));
    const t1 = (j.teams ?? []).find((t) => t.id === 1);
    const ids = (t1?.roster?.entries ?? []).map((e) => e.playerId).sort((a, b) => a - b);
    const starters = (t1?.roster?.entries ?? []).filter((e) => e.lineupSlotId !== 20 && e.lineupSlotId !== 21).map((e) => e.playerId).sort((a, b) => a - b);
    sigs[w] = { ids: ids.join(","), starters: starters.join(",") };
    console.log(`2020 team1 w${w}: n=${ids.length} starters=${starters.length}`);
  }
  const ws = Object.keys(sigs);
  console.log("roster identical across weeks?", new Set(ws.map((w) => sigs[w].ids)).size === 1);
  console.log("starters identical across weeks?", new Set(ws.map((w) => sigs[w].starters)).size === 1);
  for (const w of ws) console.log(`  w${w} starters: ${sigs[w].starters}`);

  // 2. weekly points present per scoring period?
  const j3 = root(await get(`roster-2020-w3`, `${HOST}/leagueHistory/${LEAGUE}?seasonId=2020&view=mRoster&view=mTeam&scoringPeriodId=3`));
  const e = (j3.teams ?? []).find((t) => t.id === 1)?.roster?.entries?.[0];
  console.log("stats entries for that player:", JSON.stringify((e?.playerPoolEntry?.player?.stats ?? []).map((s) => ({ id: s.id, sp: s.scoringPeriodId, st: s.statSourceId, sst: s.statSplitTypeId, tot: s.appliedTotal }))).slice(0, 800));

  // 3. Transactions -- try several shapes
  const attempts = [
    ["tx2-cur-2026", `${HOST}/seasons/2026/segments/0/leagues/${LEAGUE}?view=mTransactions2`, { "x-fantasy-filter": JSON.stringify({ transactions: { limit: 1000 } }) }],
    ["tx2-cur-2026-nofilter", `${HOST}/seasons/2026/segments/0/leagues/${LEAGUE}?view=mTransactions2`, undefined],
    ["comm-2026", `${HOST}/seasons/2026/segments/0/leagues/${LEAGUE}/communication/?view=kona_league_communication`,
      { "x-fantasy-filter": JSON.stringify({ topics: { filterType: { value: ["ACTIVITY_TRANSACTIONAL"] }, limit: 1000, offset: 0, sortMessageDate: { sortPriority: 1, sortAsc: false } } }) }],
    ["comm-2024-b", `${HOST}/leagueHistory/${LEAGUE}/communication/?seasonId=2024&view=kona_league_communication`,
      { "x-fantasy-filter": JSON.stringify({ topics: { filterType: { value: ["ACTIVITY_TRANSACTIONAL"] }, limit: 1000, offset: 0, sortMessageDate: { sortPriority: 1, sortAsc: false } } }) }],
    ["tx2-hist-2024-sp", `${HOST}/leagueHistory/${LEAGUE}?seasonId=2024&scoringPeriodId=10&view=mTransactions2`, { "x-fantasy-filter": JSON.stringify({ transactions: { limit: 1000 } }) }],
    ["mteam-tx-2024", `${HOST}/leagueHistory/${LEAGUE}?seasonId=2024&view=mTeam&view=mPendingTransactions&view=mSettings`, undefined],
  ];
  for (const [key, url, hdr] of attempts) {
    try {
      const j = root(await get(key, url, hdr));
      const tx = j.transactions ?? [];
      const tp = j.topics ?? [];
      console.log(`${key}: keys=${Object.keys(j).join(",")} transactions=${tx.length} topics=${tp.length}`);
      if (tx.length) console.log("  tx sample:", JSON.stringify(tx[0]).slice(0, 700));
      if (tp.length) console.log("  topic sample:", JSON.stringify(tp[0]).slice(0, 700));
    } catch (err) { console.log(`${key}: FAIL ${err.message}`); }
  }

  // 4. acquisitionDate/Type on the CURRENT season
  const cur = root(await get("roster-2026-w2", `${HOST}/seasons/2026/segments/0/leagues/${LEAGUE}?view=mRoster&view=mTeam&scoringPeriodId=2`));
  const ents = (cur.teams ?? [])[0]?.roster?.entries ?? [];
  console.log("2026 acquisitionTypes:", JSON.stringify(ents.map((x) => [x.acquisitionType, x.acquisitionDate])).slice(0, 600));
}
main().catch((e) => { console.error(e); process.exit(1); });
