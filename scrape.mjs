// Scrape league 462233 draft history: per-team picks (recaps) + stable owner identities (API).
// Needs a live logged-in ESPN bro session (bro session start espn). Writes data/recaps.json +
// data/owners.json; run `node analyze.mjs` afterward for the per-manager breakdown.
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
const SEASONS = [2022, 2023, 2024, 2025];
const LEAGUE = 462233;

const b = await chromium.connectOverCDP("http://127.0.0.1:9223").catch(() => chromium.connectOverCDP("http://127.0.0.1:9224"));
const pages = b.contexts().flatMap((c) => c.pages());
const page = pages.find((p) => /espn\.com/.test(p.url())) || pages[0];

// 1) per-team picks from the draft-recap page DOM (player, pos, price)
const grabRecap = async (yr) => {
  await page.goto(`https://fantasy.espn.com/football/league/draftrecap?leagueId=${LEAGUE}&seasonId=${yr}`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(2500);
  return await page.evaluate((season) => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const teams = [];
    for (const t of document.querySelectorAll(".draftRecapTable")) {
      const name = clean(t.querySelector(".Table__Title")?.textContent).replace(/NO\.Player.*$/, "").trim();
      const picks = [];
      for (const r of t.querySelectorAll("tbody tr, .Table__TR")) {
        const m = clean(r.textContent).match(/^(\d+)(.+?) ([A-Za-z]{2,4}), ([A-Za-z/]+)\$(\d+)$/);
        if (m) picks.push({ pick: +m[1], player: m[2].trim(), pos: m[4], price: +m[5] });
      }
      if (picks.length) teams.push({ season, name, picks });
    }
    return teams;
  }, yr);
};

// 2) stable owner identity from the authenticated JSON API (owner GUID + person name per season)
const grabOwners = async (yr) => {
  return await page.evaluate(async ({ year, league }) => {
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}/segments/0/leagues/${league}?view=mTeam`;
    const r = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
    if (!r.ok) return { year, error: r.status };
    const j = await r.json();
    const members = {};
    for (const m of j.members || []) members[m.id] = ((m.firstName || "") + " " + (m.lastName || "")).replace(/\s+/g, " ").trim();
    const teams = (j.teams || []).map((t) => ({
      id: t.id, abbrev: t.abbrev,
      name: ((t.location || "") + " " + (t.nickname || "")).trim() || t.name || t.abbrev,
      owners: (t.owners || []).map((o) => ({ guid: o, name: members[o] || o })),
    }));
    return { year, teams };
  }, { year: yr, league: LEAGUE });
};

const recaps = [], owners = [];
for (const yr of SEASONS) {
  const r = await grabRecap(yr); recaps.push(...r);
  const o = await grabOwners(yr); owners.push(o);
  console.log(`${yr}: ${r.length} recap teams, ${r.reduce((s, x) => s + x.picks.length, 0)} picks; owners ${o.error ? "ERR " + o.error : o.teams.length}`);
}
writeFileSync("data/recaps.json", JSON.stringify(recaps, null, 0));
writeFileSync("data/owners.json", JSON.stringify(owners, null, 0));
console.log("wrote data/recaps.json + data/owners.json");
await b.close();
