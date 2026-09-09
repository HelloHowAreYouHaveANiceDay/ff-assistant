/**
 * Fourth probe: hunt for ANY endpoint that yields a per-week lineup or a transaction log for a PAST
 * season of this league. Probes 2 and 3 ruled out leagueHistory+mRoster (scoringPeriodId ignored),
 * leagueHistory+mBoxscore (rosterForCurrentScoringPeriod empty) and every mTransactions2 shape
 * except the current season. READ-ONLY, cached, one request at a time.
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

function reportBox(label, j, week) {
  const sched = (j.schedule ?? []).filter((m) => m.matchupPeriodId === week);
  let filled = 0, total = 0;
  for (const m of sched) for (const side of [m.home, m.away]) {
    if (!side) continue;
    total++;
    const n = (side.rosterForCurrentScoringPeriod?.entries ?? side.rosterForMatchupPeriod?.entries ?? []).length;
    if (n) filled++;
  }
  console.log(`${label}: matchups=${sched.length} sidesWithRoster=${filled}/${total} teams=${(j.teams ?? []).length}`);
  const s0 = sched[0]?.home;
  if (s0) console.log("  side keys:", Object.keys(s0).join(","));
}

async function main() {
  const week = 3, season = 2020;
  const combos = [
    ["A", `${HOST}/leagueHistory/${LEAGUE}?seasonId=${season}&scoringPeriodId=${week}&view=mMatchup&view=mMatchupScore&view=mRoster`],
    ["B", `${HOST}/seasons/${season}/segments/0/leagues/${LEAGUE}?scoringPeriodId=${week}&view=mMatchup&view=mMatchupScore`],
    ["C", `${HOST}/seasons/${season}/segments/0/leagues/${LEAGUE}?scoringPeriodId=${week}&view=mBoxscore`],
    ["D", `${HOST}/leagueHistory/${LEAGUE}?seasonId=${season}&scoringPeriodId=${week}&view=mScoreboard`],
    ["E", `${HOST}/leagueHistory/${LEAGUE}?seasonId=${season}&scoringPeriodId=${week}&view=mMatchupScore&view=mLiveScoring`],
  ];
  for (const [tag, url] of combos) {
    try { const j = root(await get(`box4-${tag}-${season}-w${week}`, url)); reportBox(`${tag}`, j, week); }
    catch (e) { console.log(`${tag}: FAIL ${e.message}`); }
  }
  // current season control: does the SAME shape carry lineups now?
  try {
    const j = root(await get(`box4-cur-2026-w1`, `${HOST}/seasons/2026/segments/0/leagues/${LEAGUE}?scoringPeriodId=1&view=mMatchup&view=mMatchupScore`));
    reportBox("CUR 2026 w1", j, 1);
  } catch (e) { console.log("CUR: FAIL " + e.message); }
  // transactions with a scoringPeriod-scoped filter on the current season, to learn the real shape
  try {
    const j = root(await get(`tx-2026-full`, `${HOST}/seasons/2026/segments/0/leagues/${LEAGUE}?view=mTransactions2`));
    const tx = j.transactions ?? [];
    const types = {}; for (const t of tx) types[t.type] = (types[t.type] ?? 0) + 1;
    console.log("2026 tx types:", JSON.stringify(types));
    const nonDraft = tx.filter((t) => t.type !== "DRAFT");
    console.log("non-draft n=", nonDraft.length);
    if (nonDraft.length) console.log(JSON.stringify(nonDraft[0]).slice(0, 900));
  } catch (e) { console.log("tx 2026: FAIL " + e.message); }
}
main().catch((e) => { console.error(e); process.exit(1); });
