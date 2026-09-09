/**
 * Fifth probe. Probe 4 found the working shape: the /seasons/{season}/ path (NOT leagueHistory)
 * serves past seasons and, with view=mBoxscore + scoringPeriodId, carries a real per-week roster
 * with lineup slots. This probe pins down the entry shape, whether lineups actually move week to
 * week, and whether the bench is included. READ-ONLY, cached, one request at a time.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";

const HOST = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
const LEAGUE = "462233";
const CACHE = "data/cache/espn";

function info() { const i = JSON.parse(readFileSync("data/app-bridge.json", "utf8")); process.kill(i.pid, 0); return i; }
function bridgeFetch(url, headers = {}, timeoutMs = 60000) {
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
const boxUrl = (s, w) => `${HOST}/seasons/${s}/segments/0/leagues/${LEAGUE}?scoringPeriodId=${w}&view=mBoxscore`;

function sides(j, week) {
  const out = [];
  for (const m of (j.schedule ?? [])) {
    if (m.matchupPeriodId !== week) continue;
    for (const side of [m.home, m.away]) if (side) out.push(side);
  }
  return out;
}

async function main() {
  const j3 = root(await get("box5-2020-w3", boxUrl(2020, 3)));
  const s = sides(j3, 3);
  const t = s[0];
  const cur = t.rosterForCurrentScoringPeriod?.entries ?? [];
  const mp = t.rosterForMatchupPeriod?.entries ?? [];
  console.log(`team ${t.teamId}: current=${cur.length} matchupPeriod=${mp.length} totalPoints=${t.totalPoints}`);
  console.log("entry keys:", Object.keys(cur[0] ?? {}).join(","));
  console.log("ppe keys:", Object.keys(cur[0]?.playerPoolEntry ?? {}).join(","));
  console.log("slots+pts:", JSON.stringify(cur.map((e) => [e.playerId, e.lineupSlotId, e.playerPoolEntry?.appliedStatTotal])));
  console.log("mp slots:", JSON.stringify(mp.map((e) => [e.playerId, e.lineupSlotId, e.playerPoolEntry?.appliedStatTotal])));
  const st = (cur[0]?.playerPoolEntry?.player?.stats ?? []).map((x) => ({ sp: x.scoringPeriodId, src: x.statSourceId, split: x.statSplitTypeId, tot: x.appliedTotal }));
  console.log("stats rows:", JSON.stringify(st));

  // do lineups actually move week to week?
  const j8 = root(await get("box5-2020-w8", boxUrl(2020, 8)));
  const key = (jj, w, team) => {
    const side = sides(jj, w).find((x) => x.teamId === team);
    return (side?.rosterForCurrentScoringPeriod?.entries ?? []).filter((e) => e.lineupSlotId !== 20 && e.lineupSlotId !== 21)
      .map((e) => e.playerId).sort((a, b) => a - b).join(",");
  };
  const tm = s[0].teamId;
  console.log(`team ${tm} w3 starters:`, key(j3, 3, tm));
  console.log(`team ${tm} w8 starters:`, key(j8, 8, tm));

  // coverage: how many sides per week, and roster sizes, across a season
  for (const w of [1, 7, 14, 15, 16, 17]) {
    try {
      const jj = root(await get(`box5-2020-w${w}`, boxUrl(2020, w)));
      const ss = sides(jj, w);
      const ns = ss.map((x) => (x.rosterForCurrentScoringPeriod?.entries ?? []).length);
      console.log(`2020 w${w}: sides=${ss.length} sizes=${JSON.stringify(ns)}`);
    } catch (e) { console.log(`2020 w${w}: FAIL ${e.message}`); }
  }
  // and 2018 (earliest)
  try {
    const jj = root(await get("box5-2018-w5", boxUrl(2018, 5)));
    const ss = sides(jj, 5);
    console.log(`2018 w5: sides=${ss.length} sizes=${JSON.stringify(ss.map((x) => (x.rosterForCurrentScoringPeriod?.entries ?? []).length))}`);
  } catch (e) { console.log("2018 w5: FAIL " + e.message); }
}
main().catch((e) => { console.error(e); process.exit(1); });
