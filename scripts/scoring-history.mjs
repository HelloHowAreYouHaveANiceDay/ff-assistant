// Step 9b: did this league CHANGE its scoring for 2026? Fetches league settings for several
// seasons through the desktop app's logged-in ESPN webview (the same credentialed path
// cmdScrapeLeague uses -- private-league endpoints need the session cookies) and diffs the PPR
// value. If the league moved 0 -> 0.5 this year, the 2023-25 spend history in
// docs/league-tendencies.md understates what the room will pay for pass-catchers.
//
// Read-only. Run: node scripts/scoring-history.mjs   (the desktop app must be open)
import { chromium } from "playwright-core";
import Database from "better-sqlite3";

const PORT = process.env.FF_CDP_PORT ?? "9223";
const db = new Database("data/ff.db", { readonly: true });
const cfg = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='config'").get().value);
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
db.close();
const leagueId = lg.league_id;

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null);
if (!browser) { console.log("app not running -- open the desktop app (its logged-in session is needed)"); process.exit(1); }
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file://"));
if (!page) { console.log("app renderer not found"); await browser.close(); process.exit(1); }

const wvEval = (js) => page.evaluate(async (code) => {
  const wv = document.getElementById("espnview");
  if (!wv?.executeJavaScript) return "";
  try { return await wv.executeJavaScript(code); } catch (e) { return "ERR:" + (e?.message ?? e); }
}, js);

const cur = await wvEval("location.href");
if (!/fantasy\.espn\.com/.test(String(cur))) {
  await page.evaluate(() => {
    const w = window; if (w.setView) w.setView("live");
    const wv = document.getElementById("espnview");
    if (wv?.loadURL) wv.loadURL("https://fantasy.espn.com/football/");
  });
  await page.waitForTimeout(4000);
}

const seasons = [];
for (let y = cfg.season - 3; y <= cfg.season; y++) seasons.push(y);
console.log(`league ${leagueId} -- scoring settings for ${seasons.join(", ")}\n`);

// ESPN scoring item 53 = receptions; its points value IS the PPR rate.
const RECEPTION_STAT_ID = 53;
// ESPN lineupSlotId -> slot name (the subset this league uses). 23 is FLEX, NOT IR (IR is 21) --
// getting this backwards would hide the 2 FLEX slots the whole value curve is built on.
const SLOT_NAME = { 0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP", 16: "DST", 17: "K", 20: "BE", 21: "IR", 23: "FLEX" };
const out = [];
for (const yr of seasons) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${yr}/segments/0/leagues/${leagueId}?view=mSettings`;
  const raw = await wvEval(`fetch(${JSON.stringify(url)},{credentials:'include'}).then(function(r){return r.ok?r.text():('HTTP '+r.status)}).catch(function(e){return 'ERR '+e.message})`);
  const s = String(raw ?? "");
  if (!s || s.startsWith("HTTP") || s.startsWith("ERR")) { console.log(`  ${yr}: ${s || "no data"}`); out.push({ yr, rec: null, note: s }); continue; }
  let j; try { j = JSON.parse(s); } catch { console.log(`  ${yr}: parse error`); out.push({ yr, rec: null, note: "parse error" }); continue; }
  const sc = j.settings?.scoringSettings;
  const item = (sc?.scoringItems ?? []).find((it) => it.statId === RECEPTION_STAT_ID);
  const rec = item?.points ?? null;
  const roster = j.settings?.rosterSettings?.lineupSlotCounts ?? {};
  const live = Object.entries(roster).filter(([, n]) => n > 0);
  const slots = live.map(([k, n]) => `${SLOT_NAME[k] ?? "slot" + k}x${n}`).join(" ");
  const teams = j.settings?.size ?? "?";
  const budget = j.settings?.draftSettings?.auctionBudget ?? "?";
  console.log(`  ${yr}: reception pts = ${rec === null ? "?" : rec}  | teams ${teams} | budget $${budget} | ${slots}`);
  const counts = {};
  for (const [k, n] of live) counts[SLOT_NAME[k] ?? "slot" + k] = n;
  out.push({ yr, rec, teams, budget, counts });
}
await browser.close();

const known = out.filter((r) => r.rec !== null);
console.log("");
if (known.length < 2) { console.log("VERDICT: not enough seasons returned data to diff."); process.exit(0); }
const vals = [...new Set(known.map((r) => r.rec))];
if (vals.length === 1) {
  console.log(`VERDICT: scoring UNCHANGED across ${known.map((r) => r.yr).join(", ")} -- reception pts = ${vals[0]} every year.`);
  console.log(vals[0] === 0.5
    ? "  The league has always been half-PPR; the recap spend history is directly comparable."
    : `  NOTE: every season reads ${vals[0]}, which does NOT match the synced config (HALF/0.5) -- investigate.`);
} else {
  console.log(`VERDICT: scoring CHANGED -- ${known.map((r) => `${r.yr}:${r.rec}`).join("  ")}`);
  console.log("  If it moved 0 -> 0.5 for 2026, expect the room to pay HOTTER for WR/pass-catchers");
  console.log("  than the 2023-25 recap history implies. Add that note to the runbook.");
}

// Cross-check: our whole value curve is built on teams x starters (2 FLEX is what the weighted
// baseline allocates). Verify the SYNCED config against what ESPN itself reports for this season,
// rather than against our own copy of it.
const now = out.find((r) => r.yr === cfg.season);
console.log("");
if (!now?.counts) { console.log(`CONFIG CROSS-CHECK: no ${cfg.season} settings returned -- skipped.`); process.exit(0); }
const espnSlots = [];
for (const [name, n] of Object.entries(now.counts)) { if (name === "IR") continue; for (let i = 0; i < n; i++) espnSlots.push(name); }
const norm = (a) => a.map((s) => (s === "BENCH" ? "BE" : s)).sort().join(",");
const ok = { slots: norm(espnSlots) === norm(cfg.slots), teams: now.teams === cfg.teams, budget: now.budget === cfg.budget, ppr: now.rec === 0.5 && cfg.scoring === "HALF" };
console.log(`CONFIG CROSS-CHECK (${cfg.season}, ESPN vs our synced config):`);
console.log(`  slots   ${ok.slots ? "MATCH" : "MISMATCH"}  espn=[${espnSlots.join(",")}]  ours=[${cfg.slots.join(",")}]`);
console.log(`  teams   ${ok.teams ? "MATCH" : "MISMATCH"}  espn=${now.teams} ours=${cfg.teams}`);
console.log(`  budget  ${ok.budget ? "MATCH" : "MISMATCH"}  espn=$${now.budget} ours=$${cfg.budget}`);
console.log(`  scoring ${ok.ppr ? "MATCH" : "MISMATCH"}  espn rec=${now.rec} ours=${cfg.scoring}`);
const bad = Object.entries(ok).filter(([, v]) => !v).map(([k]) => k);
console.log(bad.length ? `\n${bad.length} MISMATCH(ES): ${bad.join(", ")} -- the value curve is built on these; fix before drafting.` : "\nALL MATCH -- the format the values were computed for is the format ESPN will run.");
process.exit(bad.length ? 1 : 0);
