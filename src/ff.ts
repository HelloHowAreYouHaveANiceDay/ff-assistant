#!/usr/bin/env tsx
// The `ff` CLI -- the engine (D7). Runnable in a terminal for iteration; the
// unattended agent will later reach a constrained subset of these as tools.
//
//   npm run ff -- attach            test the copresent CDP connection, list tabs
//   npm run ff -- inspect-draft     dump the live ESPN draft-room DOM to a file
//   npm run ff -- rank              print top players by VOR from the rankings CSV
//   npm run ff -- mock              run the draft loop (needs real selectors first)

import { attach, attachBro, findPage, detach, type Attached } from "./browser/attach.js";
import { passthrough as broPassthrough } from "./browser/bro.js";
import { inspectDraftDom } from "./draft/espnReader.js";
import { loadRankings } from "./data/rankings.js";
import { replacementBaselines, withVOR, type LeagueSettings } from "./draft/rank.js";
import { runDraft } from "./draft/loop.js";

const DEFAULT_LEAGUE: LeagueSettings = {
  teams: 10,
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "bro":
      // Passthrough to the bro CLI: `ff bro session start espn`, `ff bro sessions`, ...
      return void process.exit(broPassthrough(rest));
    case "attach":
      return cmdAttach(rest);
    case "goto":
      return cmdGoto(rest);
    case "click":
      return cmdClick(rest);
    case "text":
      return cmdText(rest);
    case "launch-practice":
      return cmdLaunchPractice(rest);
    case "read-block":
      return cmdReadBlock(rest);
    case "bid":
      return cmdBid(rest);
    case "roster":
      return cmdRoster(rest);
    case "auto-bid":
      return cmdAutoBid(rest);
    case "auto-draft":
      return cmdAutoDraft(rest);
    case "board":
      return cmdBoard(rest);
    case "dump-values":
      return cmdDumpValues(rest);
    case "values":
      return cmdValues(rest);
    case "project":
      return cmdProject(rest);
    case "lineup":
      return cmdLineup(rest);
    case "calibrate":
      return cmdCalibrate(rest);
    case "sim":
      return cmdSim(rest);
    case "backtest":
      return cmdBacktest(rest);
    case "enter-draft":
      return cmdEnterDraft(rest);
    case "preflight":
      return cmdPreflight(rest);
    case "inspect-draft":
      return cmdInspect(rest);
    case "rank":
      return cmdRank(rest);
    case "mock":
      return cmdMock(rest);
    default:
      console.log(
        "commands:\n" +
          "  bro <args...>              passthrough to the bro CLI (e.g. bro session start espn)\n" +
          "  attach [--site espn|--port N]   test the copresent connection to bro's session\n" +
          "  goto <url> [--site]        navigate the copresent session\n" +
          "  inspect-draft [--out FILE] dump the live ESPN draft-room DOM\n" +
          "  rank [--csv FILE]          top players by VOR (offline)\n" +
          "  mock [--csv FILE]          run the draft loop (needs real selectors)",
      );
  }
}

// Attach via bro's session by default; allow --port for a manually-launched browser.
async function attachFor(rest: string[]): Promise<Attached> {
  const port = valueOf(rest, "--port");
  if (port) return attach(Number(port));
  const site = valueOf(rest, "--site") ?? "espn";
  return attachBro(site);
}

async function cmdAttach(rest: string[]) {
  const a = await attachFor(rest);
  console.log("Attached. Open tabs:");
  for (const p of a.pages) console.log("  -", p.url());
  const espn = findPage(a, "espn.com");
  console.log(espn ? `\nESPN tab found: ${espn.url()}` : "\nNo espn.com tab open yet.");
  await detach(a);
}

// The agent navigating the copresent session itself (D0): drive the user's own
// browser to a URL -- e.g. the ESPN mock-draft lobby -- then act from there.
async function cmdGoto(rest: string[]) {
  const url = rest.find((r) => !r.startsWith("--"));
  if (!url) {
    console.error("usage: ff goto <url>  (e.g. https://fantasy.espn.com/football/mockdraftlobby)");
    process.exit(2);
  }
  const a = await attachFor(rest);
  // Prefer an existing ESPN tab so we stay in the user's logged-in context.
  const page = findPage(a, "espn.com") ?? a.pages[0];
  await page.goto(url, { waitUntil: "domcontentloaded" });
  console.log(`Navigated to ${page.url()}`);
  await detach(a);
}

// Click the first visible link/button whose text contains <text> (copresent action).
async function cmdClick(rest: string[]) {
  const text = rest.find((r) => !r.startsWith("--"));
  if (!text) {
    console.error('usage: ff click "<visible text>"');
    process.exit(2);
  }
  const exact = rest.includes("--exact");
  const a = await attachFor(rest);
  const page = findPage(a, "espn.com") ?? a.pages[0];
  // Prefer a real button/link (by accessible name) over any text node that merely
  // CONTAINS the string (e.g. a heading) -- that was silently clicking the wrong element.
  const byRole = page.getByRole("button", { name: text, exact }).or(
    page.getByRole("link", { name: text, exact }),
  );
  const loc = (await byRole.count()) > 0 ? byRole.first() : page.getByText(text, { exact }).first();
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  // A practice-draft launch may open a popup; capture it if so.
  const popupP = page.waitForEvent("popup", { timeout: 4000 }).catch(() => null);
  await loc.click({ timeout: 8000 });
  const popup = await popupP;
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  if (popup) {
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    console.log(`Clicked "${text}". Popup opened: ${popup.url()}`);
  } else {
    console.log(`Clicked "${text}". Now at: ${page.url()}`);
  }
  await detach(a);
}

// Dump the current page's visible text (copresent read).
async function cmdText(rest: string[]) {
  const a = await attachFor(rest);
  const page = findPage(a, "espn.com") ?? a.pages[0];
  const txt = await page.evaluate("document.body.innerText");
  console.log(String(txt).replace(/\n{3,}/g, "\n\n").slice(0, 3000));
  await detach(a);
}

// Launch the league-specific practice draft AS THE AGENT (no human click). The
// "Practice Draft" button opens the draft app via window.open, which the popup blocker
// drops for programmatic clicks -- so we shim window.open to capture the target URL and
// navigate to it ourselves. This is the draft-day launch path.
async function cmdLaunchPractice(rest: string[]) {
  const a = await attachFor(rest);
  // Use a non-draft page as our working tab; if none, make one. NEVER close the last
  // page (that quits Chrome and ends the bro session).
  let page = a.pages.find((p) => !/\/football\/draft/.test(p.url()));
  if (!page) page = await a.context.newPage();
  // Now close any OTHER draft tabs -- ESPN allows only ONE draft connection; a duplicate
  // triggers "disconnected... from another location". Our working page is not a draft tab.
  for (const p of a.pages) {
    if (p !== page && /\/football\/draft/.test(p.url())) await p.close().catch(() => {});
  }
  // Always land on a freshly-loaded lobby (a finished-draft tab won't have the button).
  const openBtnSel = () => page.getByRole("button", { name: "Practice Draft", exact: true }).first();
  await page.goto("https://fantasy.espn.com/football/mockdraftlobby", { waitUntil: "networkidle" }).catch(() => {});
  let ready = await openBtnSel().waitFor({ state: "visible", timeout: 15000 }).then(() => true).catch(() => false);
  if (!ready) {
    await page.reload({ waitUntil: "networkidle" }).catch(() => {});
    ready = await openBtnSel().waitFor({ state: "visible", timeout: 15000 }).then(() => true).catch(() => false);
  }
  if (!ready) {
    console.error("lobby 'Practice Draft' button never rendered -- aborting launch.");
    await detach(a);
    return;
  }
  // Shim window.open to RECORD the URL only -- do NOT open the real popup (that would
  // create a second draft tab -> duplicate-connection kick). We navigate our one tab.
  await page.evaluate(
    "window.__ffOpen=null; if(!window.__ffPatched){window.__ffPatched=1; window.open=function(u){try{window.__ffOpen=String(u||'');}catch(e){} return {closed:false,focus:function(){},blur:function(){},close:function(){},postMessage:function(){}};};}",
  );
  // Step 1: open the "Configure Practice Draft" modal (retry -- the React app renders late).
  const openBtn = page.getByRole("button", { name: "Practice Draft", exact: true });
  const startBtn = page.getByRole("button", { name: "Start Practice Draft", exact: true });
  await openBtn.first().waitFor({ state: "visible", timeout: 20000 }).catch(() => console.error("Practice Draft button never rendered"));
  let modalOpen = false;
  for (let i = 0; i < 3 && !modalOpen; i++) {
    await openBtn.first().scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
    await openBtn.first().click({ timeout: 6000 }).catch((e) => console.error(`open-modal try ${i}:`, e.message));
    modalOpen = await startBtn
      .first()
      .waitFor({ state: "visible", timeout: 6000 })
      .then(() => true)
      .catch(() => false);
  }
  if (!modalOpen) console.error("Configure-practice modal did not open after retries");
  // Step 1b: pick a draft position -- "Start" silently no-ops until one is chosen. It's a
  // native <select>; choose a concrete option (index 1 skips the placeholder).
  const posSel = page.locator("select").filter({ hasNot: page.locator("option:only-child") }).first();
  if ((await page.locator("select").count()) > 0) {
    const sel = page.locator("select").last();
    await sel.selectOption({ index: 1 }).catch(async () => {
      // Fallback: pick the last option (a concrete position, not the placeholder).
      const opts = await sel.locator("option").count();
      if (opts > 1) await sel.selectOption({ index: opts - 1 }).catch(() => {});
    });
    console.log("Selected a draft position.");
  } else {
    console.error("No <select> for draft position found.");
  }
  void posSel;
  // Step 2: start the draft (opens the draft app via window.open, captured by the shim).
  await startBtn.first().click({ timeout: 8000 }).catch((e) => console.error("start-click:", e.message));
  await page.waitForTimeout(1500);
  // window.open fires synchronously inside the handler; read what it targeted.
  const opened = (await page.evaluate("window.__ffOpen")) as string | null;
  if (opened) {
    const url = opened.startsWith("http") ? opened : new URL(opened, page.url()).href;
    console.log(`Practice draft opened window -> ${url}. Navigating there.`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    console.log(`Now at: ${page.url()} | title: ${await page.title()}`);
  } else {
    console.log(`No window.open captured. Current URL: ${page.url()} | title: ${await page.title()}`);
  }
  await detach(a);
}

const REAL_LEAGUE = "462233"; // seacaptaindate.com (16-team $200 auction)
const REAL_TEAM = "8";

// Enter the REAL league draft room (G1). Same auction app as practice, so once we're in,
// readBlock/readRoster/readBoard/quickBid/jumpBid all transfer. The real draft opens a few
// minutes before start; run this then, then `ff auto-draft`. Tries, in order: an "Enter Draft"
// control from the league (captured window.open), then the direct draft URL.
async function cmdEnterDraft(rest: string[]) {
  const { readRoster } = await import("./draft/espnAuction.js");
  const league = valueOf(rest, "--league") ?? REAL_LEAGUE;
  const team = valueOf(rest, "--team") ?? REAL_TEAM;
  const a = await attachFor(rest);
  // Reuse a non-draft tab (or make one); don't disturb an existing draft tab if already in.
  const existingDraft = a.pages.find((p) => /\/football\/draft/.test(p.url()));
  const inDraft = async (pg: typeof a.pages[number]) => {
    const t = (await pg.title().catch(() => "")) || "";
    if (!/Fantasy Football Draft/i.test(t)) return false;
    const r = await readRoster(pg).catch(() => null);
    return !!r && (r.filled + r.open) > 0;
  };
  if (existingDraft && (await inDraft(existingDraft))) {
    console.log(`Already in a draft room: ${existingDraft.url()}`);
    await detach(a);
    return;
  }
  const page = a.pages.find((p) => !/\/football\/draft/.test(p.url())) ?? (await a.context.newPage());

  // Strategy 1: from the league clubhouse, click an "Enter Draft"/"Draft Now" control (opens the
  // draft app via window.open, like practice). Capture the URL and navigate our single tab.
  await page.goto(`https://fantasy.espn.com/football/team?leagueId=${league}&teamId=${team}`, { waitUntil: "networkidle" }).catch(() => {});
  await page.evaluate("window.__ffOpen=null; if(!window.__ffPatched){window.__ffPatched=1; window.open=function(u){try{window.__ffOpen=String(u||'');}catch(e){} return {closed:false,focus(){},blur(){},close(){},postMessage(){}};};}");
  const enterBtn = page.getByRole("button", { name: /enter draft|draft now|join draft|go to draft|enter live draft/i })
    .or(page.getByRole("link", { name: /enter draft|draft now|join draft|go to draft|enter live draft/i }));
  if ((await enterBtn.count()) > 0) {
    await enterBtn.first().click({ timeout: 6000 }).catch((e) => console.error("enter-click:", e.message));
    await page.waitForTimeout(1500);
    const opened = (await page.evaluate("window.__ffOpen")) as string | null;
    if (opened) {
      await page.goto(opened.startsWith("http") ? opened : new URL(opened, page.url()).href, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
  } else {
    console.log("No 'Enter Draft' control on the clubhouse (draft not open yet?). Trying direct URL.");
  }

  // Strategy 2: direct draft URL (works once the draft room is live).
  if (!(await inDraft(page))) {
    await page.goto(`https://fantasy.espn.com/football/draft?leagueId=${league}&seasonId=2026&teamId=${team}`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  if (await inDraft(page)) {
    const r = await readRoster(page);
    console.log(`IN THE DRAFT ROOM: ${page.url()}`);
    console.log(`roster slots: ${r.filled + r.open} (filled ${r.filled}); open by pos ${JSON.stringify(r.openByBase)} flex ${r.flexOpen} bench ${r.benchOpen}`);
    console.log(`Ready. Run: npm run ff -- auto-draft --csv <values.csv>`);
  } else {
    console.log(`Draft room NOT reachable yet (league ${league}). It opens shortly before start -- retry then. Now at: ${page.url()}`);
  }
  await detach(a);
}

// Pre-draft readiness check (G2/G9): session live + logged in + league reachable + draft state.
async function cmdPreflight(rest: string[]) {
  const { readRoster } = await import("./draft/espnAuction.js");
  const league = valueOf(rest, "--league") ?? REAL_LEAGUE;
  const team = valueOf(rest, "--team") ?? REAL_TEAM;
  let a: Attached;
  try { a = await attachFor(rest); } catch (e) { console.log(`FAIL: cannot attach to bro session -- ${(e as Error).message}`); return; }
  console.log(`OK: attached to browser (${a.pages.length} tabs)`);
  const draftTab0 = a.pages.find((p) => /\/football\/draft/.test(p.url()));
  if (draftTab0) {
    const r0 = await readRoster(draftTab0).catch(() => null);
    console.log(`NOTE: a draft room is already open: ${draftTab0.url()} -- roster reads ${r0 ? r0.filled + r0.open : "?"} slots`);
  }
  // Use a NON-draft tab (or a fresh one) so we never disturb an in-progress draft.
  const page = a.pages.find((p) => !/\/football\/draft/.test(p.url())) ?? (await a.context.newPage());
  await page.goto(`https://fantasy.espn.com/football/team?leagueId=${league}&teamId=${team}`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(1200);
  const title = (await page.title().catch(() => "")) || "";
  const loggedIn = !/log ?in|sign ?in/i.test(title) && /espn/i.test(title.length ? title : page.url());
  console.log(`${loggedIn ? "OK" : "CHECK"}: league page title = "${title}" (logged in: ${loggedIn})`);
  console.log(`When the draft opens: npm run ff -- enter-draft  (then auto-draft)`);
  await detach(a);
}

// Scrape ESPN's full board values (calibrated to our league) into a values CSV.
// Compute OUR auction values from a points table (VOR->$) and write a values CSV.
// Demo the shared projection layer: season / this-week-vs-opponent / rest-of-season for a player.
// In-season weekly lineup optimizer. Reads a roster (offline CSV now: player[,opp][,injury]; live
// copresent read once the season starts), projects each via the shared layer, and recommends the
// optimal legal AVAILABLE lineup. `--set` would submit it (live, at season start).
async function cmdLineup(rest: string[]) {
  const { loadProjections } = await import("./projections.js");
  const { optimalLineup } = await import("./inseason/lineup.js");
  const { isAvailable } = await import("./inseason/espnTeam.js");
  const { SIM_LEAGUE } = await import("./draft/sim.js");
  const { readFileSync } = await import("node:fs");
  const proj = loadProjections(valueOf(rest, "--points") ?? "data/points.csv", valueOf(rest, "--def") ?? "data/def-ratings.csv");
  const rosterFile = valueOf(rest, "--roster");
  if (!rosterFile) { console.log("usage: ff lineup --roster <csv: player[,opp][,injury]>  (live copresent read lands at season start)"); return; }
  const rows = readFileSync(rosterFile, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
  const table = new Map(proj.all().map((p) => [p.name.toLowerCase(), p.pos]));
  const players = rows.map((f) => {
    const name = f[0].trim(), opp = (f[1] ?? "").trim() || undefined, injury = (f[2] ?? "").trim() || undefined;
    const pos = table.get(name.toLowerCase()) ?? "";
    return { name, pos, opponent: opp, starting: false, injuryStatus: injury, proj: proj.week(name, pos, opp), available: isAvailable({ name, pos, opponent: opp, starting: false, injuryStatus: injury }) };
  }).filter((p) => p.pos);
  const res = optimalLineup(players, SIM_LEAGUE.slots);
  console.log(`RECOMMENDED LINEUP (proj ${res.totalProj}):`);
  for (const s of res.starters) console.log(`  ${s.slot.padEnd(5)} ${s.name.padEnd(22)} ${s.proj}`);
  console.log(`BENCH: ${res.bench.map((b) => `${b.name}(${b.proj}${b.available ? "" : " N/A"})`).join(", ")}`);
  if (res.flags.length) console.log(`FLAGS: ${res.flags.join(" | ")}`);
}

async function cmdProject(rest: string[]) {
  const { loadProjections } = await import("./projections.js");
  const name = rest.find((r) => !r.startsWith("--"));
  const opp = valueOf(rest, "--vs");
  const proj = loadProjections(valueOf(rest, "--points") ?? "data/points.csv", valueOf(rest, "--def") ?? "data/def-ratings.csv");
  if (!name) {
    const top = proj.all().sort((a, b) => b.season - a.season).slice(0, 10);
    console.log("top by season projection:"); for (const p of top) console.log(`  ${p.season.toFixed(0)}  ${p.pos}  ${p.name}`);
    return;
  }
  const p = proj.all().find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!p) { console.log(`no projection for "${name}"`); return; }
  console.log(`${p.name} (${p.pos}): season ${proj.season(p.name).toFixed(0)} | this week${opp ? " vs " + opp : ""} ${proj.week(p.name, p.pos, opp).toFixed(1)} | ROS(10 gms) ${proj.ros(p.name, 10).toFixed(0)}`);
}

async function cmdValues(rest: string[]) {
  const { computeValues } = await import("./draft/values.js");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const src = valueOf(rest, "--points") ?? "data/points.csv";
  const out = valueOf(rest, "--out") ?? "data/values.csv";
  const [, ...lines] = readFileSync(src, "utf8").trim().split(/\r?\n/);
  const points = lines.map((l) => { const f = l.split(","); return { name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) }; }).filter((p) => p.name && p.points);
  const vals = computeValues(points);
  writeFileSync(out, "player,pos,value\n" + vals.map((v) => `${v.name},${v.pos},${v.value}`).join("\n") + "\n", "utf8");
  console.log(`wrote ${vals.length} values -> ${out}`);
  console.log("top 12:", vals.slice(0, 12).map((v) => `${v.name}($${v.value})`).join(" "));
}

// Validation harness: run N seeded auction sims with our values+strategy, report roster strength
// vs the field. Change values/strategy and re-run -> higher points/rank = better, lower = regression.
// Calibration: run an all-bot field (the 16 real manager profiles) and check the SIMULATED
// positional spend + concentration reproduce each owner's real history. This is the fault-injection
// guard for the bot model -- if the RB-heavy manager doesn't come out RB-heavy in the sim, the model
// is disconnected from the data. Prints per-position mean-abs-error and per-owner spot checks.
async function cmdCalibrate(rest: string[]) {
  const { draftFieldSeats, SIM_LEAGUE } = await import("./draft/sim.js");
  const { loadManagers } = await import("./draft/managers.js");
  const { readFileSync } = await import("node:fs");
  const readCsv = (p: string) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
  const points = readCsv(valueOf(rest, "--points") ?? "data/points.csv").map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) })).filter((p) => p.name && p.points);
  const ourValues = new Map<string, number>();
  for (const f of readCsv(valueOf(rest, "--values") ?? "data/values.csv")) ourValues.set(f[0].trim(), Number(f[2]));
  const n = Number(valueOf(rest, "--n") ?? 300);
  const POS = ["QB", "RB", "WR", "TE", "K", "DST"];
  const { profiles } = loadManagers();
  // accumulate simulated positional $ + top-3 share per owner
  const acc = new Map<string, { pos: Record<string, number>; tot: number; top3: number; max: number; teams: number }>();
  for (const p of profiles) acc.set(p.owner, { pos: Object.fromEntries(POS.map((k) => [k, 0])), tot: 0, top3: 0, max: 0, teams: 0 });
  for (let s = 0; s < n; s++) {
    const { picks, seatProfiles } = draftFieldSeats(points, ourValues, {}, s + 1, SIM_LEAGUE, { includeUs: false });
    for (let ti = 0; ti < seatProfiles.length; ti++) {
      const prof = seatProfiles[ti]; if (!prof) continue;
      const a = acc.get(prof.owner)!;
      const mine = picks.filter((p) => p.team === ti);
      const tot = mine.reduce((x, p) => x + p.price, 0) || 1;
      for (const p of mine) if (p.pos in a.pos) a.pos[p.pos] += p.price;
      a.tot += tot; a.teams++;
      const sorted = mine.map((p) => p.price).sort((x, y) => y - x);
      a.top3 += sorted.slice(0, 3).reduce((x, y) => x + y, 0) / tot;
      a.max += sorted[0] ?? 0;
    }
  }
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  let mae: Record<string, number[]> = Object.fromEntries(POS.map((k) => [k, []])), concErr: number[] = [];
  console.log(`CALIBRATION -- ${n} all-bot drafts, 16 real manager profiles. sim share vs REAL history:\n`);
  for (const prof of profiles) {
    const a = acc.get(prof.owner)!; if (!a.teams) continue;
    const simShare = Object.fromEntries(POS.map((k) => [k, a.pos[k] / a.tot]));
    const simTop3 = a.top3 / a.teams;
    const simMax = a.max / a.teams;
    for (const k of POS) mae[k].push(Math.abs(simShare[k] - (prof.share[k] ?? 0)));
    concErr.push(Math.abs(simTop3 - prof.conc));
    const line = POS.filter((k) => k !== "K" && k !== "DST").map((k) => `${k} ${pct(simShare[k])}/${pct(prof.share[k] ?? 0)}`).join("  ");
    console.log(`  ${prof.owner.padEnd(20)} ${line}  | top3 ${pct(simTop3)}/${pct(prof.conc)}  | max$ ${simMax.toFixed(0)}/${prof.maxBuy.toFixed(0)}`);
  }
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`\n  MEAN ABS ERROR (sim vs real):  ` + POS.map((k) => `${k} ${pct(avg(mae[k]))}`).join("  ") + `  | top3 ${pct(avg(concErr))}`);
  console.log(`  (each cell above is sim%/real%. Lower error = the field reproduces this league.)`);
}

async function cmdSim(rest: string[]) {
  const { runSim } = await import("./draft/sim.js");
  const { readFileSync } = await import("node:fs");
  const readCsv = (p: string) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
  const pointsFile = valueOf(rest, "--points") ?? "data/points.csv";
  const valuesFile = valueOf(rest, "--values") ?? "data/values.csv";
  const n = Number(valueOf(rest, "--n") ?? 100);
  const points = readCsv(pointsFile).map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) })).filter((p) => p.name && p.points);
  const ourValues = new Map<string, number>();
  for (const f of readCsv(valuesFile)) ourValues.set(f[0].trim(), Number(f[2]));
  const cfg = {
    values: Object.fromEntries(ourValues),
    starterReserve: Number(valueOf(rest, "--starter-reserve") ?? 5),
    benchReserve: 1,
    premium: Number(valueOf(rest, "--premium") ?? 2),
    aggr: Number(valueOf(rest, "--aggr") ?? 1.0),
    maxShare: Number(valueOf(rest, "--max-share") ?? 0.6),
  };
  let sumPts = 0, sumRank = 0, sumField = 0, top1 = 0, top3 = 0, sumTop3Spend = 0;
  for (let s = 0; s < n; s++) {
    const r = runSim(points, ourValues, cfg, s + 1);
    sumPts += r.ourPoints; sumRank += r.ourRank; sumField += r.fieldMean; sumTop3Spend += r.ourSpentTop3;
    if (r.ourRank === 1) top1++; if (r.ourRank <= 3) top3++;
  }
  console.log(`SIM (${n} drafts) values=${valuesFile} reserve=${cfg.starterReserve} maxShare=${cfg.maxShare} premium=${cfg.premium}`);
  console.log(`  our starting pts: ${(sumPts / n).toFixed(0)}  |  field avg: ${(sumField / n).toFixed(0)}  |  edge: ${((sumPts / n) - (sumField / n)).toFixed(0)}`);
  console.log(`  avg finish: ${(sumRank / n).toFixed(2)} of ${16}  |  1st: ${((top1 / n) * 100).toFixed(0)}%  |  top-3: ${((top3 / n) * 100).toFixed(0)}%  |  $ on top3 players: ${(sumTop3Spend / n).toFixed(0)}`);
}

// Championship backtest: draft with a past season's values, play a real H2H season + playoffs on
// that season's ACTUAL weekly results, report OUR championship / playoff rate. The trustworthy
// objective for "optimize championship wins".
async function cmdBacktest(rest: string[]) {
  const { runBacktest } = await import("./draft/backtest.js");
  const { readFileSync } = await import("node:fs");
  const rows = (p: string) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
  const nPerSeason = Number(valueOf(rest, "--n") ?? 300);
  const cfg = {
    values: {} as Record<string, number>,
    starterReserve: Number(valueOf(rest, "--starter-reserve") ?? 5),
    benchReserve: 1, premium: Number(valueOf(rest, "--premium") ?? 2),
    aggr: Number(valueOf(rest, "--aggr") ?? 1.0), maxShare: Number(valueOf(rest, "--max-share") ?? 0.6),
    inflation: rest.includes("--inflation"), scarcity: rest.includes("--scarcity"),
  };
  // Load all seasons from the combined history files, filter to --seasons range (default all).
  const range = (valueOf(rest, "--seasons") ?? "2014-2024").split("-").map(Number);
  const [lo, hi] = [range[0], range[1] ?? range[0]];
  const pts = new Map<number, { name: string; pos: string; points: number }[]>();
  for (const f of rows(valueOf(rest, "--points") ?? "data/history-points.csv")) {
    const yr = Number(f[0]); if (yr < lo || yr > hi) continue;
    (pts.get(yr) ?? pts.set(yr, []).get(yr)!).push({ name: f[1].trim(), pos: f[2].trim().toUpperCase(), points: Number(f[3]) });
  }
  const wk = new Map<number, Map<string, Map<number, number>>>();
  for (const f of rows(valueOf(rest, "--weekly") ?? "data/history-weekly.csv")) {
    const yr = Number(f[0]); if (yr < lo || yr > hi) continue;
    const m = wk.get(yr) ?? wk.set(yr, new Map()).get(yr)!;
    const name = f[1].trim(); (m.get(name) ?? m.set(name, new Map()).get(name)!).set(Number(f[3]), Number(f[4]));
  }
  const marketSd = Number(valueOf(rest, "--market-noise") ?? 0.30);
  const ourSd = valueOf(rest, "--our-noise") != null ? Number(valueOf(rest, "--our-noise")) : undefined; // < marketSd => value edge
  const ourWeeklySd = valueOf(rest, "--our-weekly-noise") != null ? Number(valueOf(rest, "--our-weekly-noise")) : undefined;
  const botWeeklySd = valueOf(rest, "--bot-weekly-noise") != null ? Number(valueOf(rest, "--bot-weekly-noise")) : undefined;
  const full = rest.includes("--full"); // run the REAL lineup optimizer (inseason/lineup.ts) for our team
  const noLookahead = rest.includes("--no-lookahead"); // draft/lineup on LAST season, score by THIS season
  const waivers = rest.includes("--waivers"); // our team works the waiver wire (trailing-avg, no lookahead)
  const drainNom = rest.includes("--drain-nom"); // our team drain-nominates the known position-payers
  const greedyNom = rest.includes("--greedy-nom"); // our team nominates the best player we don't want
  const seasons = [...pts.keys()].sort();
  let champ = 0, playoffs = 0, total = 0;
  const perYear: string[] = [];
  for (const yr of seasons) {
    const projYr = noLookahead ? yr - 1 : yr; // no-lookahead: our projection = prior season's actuals
    const proj = pts.get(projYr); if (!proj) continue; // skip the first year when no prior exists
    let c = 0;
    for (let s = 0; s < nPerSeason; s++) { const r = runBacktest(proj, wk.get(yr)!, new Map(), cfg, s + 1 + yr * 1000, undefined, marketSd, noLookahead ? 0 : ourSd, ourWeeklySd, botWeeklySd, full, waivers, drainNom, greedyNom); if (r.champ) { champ++; c++; } if (r.madePlayoffs) playoffs++; total++; }
    perYear.push(`${yr}:${((c / nPerSeason) * 100).toFixed(0)}%`);
  }
  const mode = `${full ? "FULL-SYSTEM(real lineup)" : "draft-only"}${waivers ? "+waivers" : ""}${drainNom ? "+drain-nom" : ""}${cfg.inflation ? "+inflation" : ""}${cfg.scarcity ? "+scarcity" : ""}${noLookahead ? " no-lookahead(prev-yr proj)" : ""}`;
  console.log(`BACKTEST ${mode}  reserve=${cfg.starterReserve} maxShare=${cfg.maxShare}  market ${marketSd}${ourSd != null && !noLookahead ? ` ourSd ${ourSd}` : ""}`);
  console.log(`  CHAMPIONSHIPS: ${((champ / total) * 100).toFixed(1)}%  (random ${(100 / 16).toFixed(1)}%)  |  playoffs: ${((playoffs / total) * 100).toFixed(0)}%`);
  console.log(`  per season: ${perYear.join("  ")}`);
}

async function cmdDumpValues(rest: string[]) {
  const { dumpValues } = await import("./draft/espnAuction.js");
  const out = valueOf(rest, "--out") ?? "data/values.espn.csv";
  const a = await attachFor(rest);
  const page = findPage(a, "/football/draft") ?? findPage(a, "espn.com") ?? a.pages[0];
  const players = await dumpValues(page);
  const { writeFileSync } = await import("node:fs");
  const rows = ["player,pos,value"];
  for (const p of players) if (p.pos && p.value != null) rows.push(`${p.name},${p.pos},${p.value}`);
  writeFileSync(out, rows.join("\n") + "\n", "utf8");
  console.log(`wrote ${rows.length - 1} player values -> ${out}`);
  await detach(a);
}

async function cmdBoard(rest: string[]) {
  const { readBoard } = await import("./draft/espnAuction.js");
  const a = await attachFor(rest);
  const page = findPage(a, "/football/draft") ?? findPage(a, "espn.com") ?? a.pages[0];
  const board = await readBoard(page);
  console.log(`board (${board.length} visible):`);
  for (const p of board.slice(0, 20)) console.log(`  $${p.value ?? "?"}  ${p.pos ?? "?"}  ${p.name}`);
  await detach(a);
}

async function cmdReadBlock(rest: string[]) {
  const { readBlock } = await import("./draft/espnAuction.js");
  const a = await attachFor(rest);
  const page = findPage(a, "/football/draft") ?? findPage(a, "espn.com") ?? a.pages[0];
  const state = await readBlock(page);
  console.log(JSON.stringify(state, null, 2));
  await detach(a);
}

// Place the quick bid (Offer $current+1) unless the current offer already exceeds --max.
async function cmdBid(rest: string[]) {
  const { readBlock, quickBid } = await import("./draft/espnAuction.js");
  const maxArg = valueOf(rest, "--max");
  const a = await attachFor(rest);
  const page = findPage(a, "/football/draft") ?? findPage(a, "espn.com") ?? a.pages[0];
  const before = await readBlock(page);
  const cap = maxArg ? Number(maxArg) : Infinity;
  if (!before.onBlock) {
    console.log("no player on the block");
  } else if ((before.currentOffer ?? 0) >= cap) {
    console.log(`skip: offer ${before.currentOffer} >= max ${cap} for ${before.player}`);
  } else {
    const ok = await quickBid(page);
    console.log(`${ok ? "BID" : "no-bid"} on ${before.player} (was $${before.currentOffer})`);
  }
  await detach(a);
}

// Read our real drafted roster (POS/Player/$/BYE panel) to verify wins + open slots.
async function cmdRoster(rest: string[]) {
  const { readRoster } = await import("./draft/espnAuction.js");
  const a = await attachFor(rest);
  const page = findPage(a, "/football/draft") ?? findPage(a, "espn.com") ?? a.pages[0];
  const r = await readRoster(page);
  const won = r.slots.filter((s) => s.player).map((s) => `${s.slot} ${s.player} $${s.price}`);
  console.log(`filled ${r.filled}/${r.filled + r.open}  spent $${r.spent}  open ${r.open}`);
  console.log(`open: dedicated=${JSON.stringify(r.openByBase)} flex=${r.flexOpen} bench=${r.benchOpen}`);
  console.log(`won: ${won.join(" | ") || "(none)"}`);
  await detach(a);
}

// v1 auction bidder core: one connection, loop -- bid on whatever is on the block up to
// (Pre-Draft Val + overpay), stop when our roster grows (a win) or rounds run out. Proves
// the actor loop end-to-end. Strategy tuning (nomination, targets) comes later.
async function cmdAutoBid(rest: string[]) {
  const { readBlock, quickBid } = await import("./draft/espnAuction.js");
  const rounds = Number(valueOf(rest, "--rounds") ?? 40);
  const overpay = Number(valueOf(rest, "--overpay") ?? 2);
  const a = await attachFor(rest);
  const page = findPage(a, "/football/draft") ?? findPage(a, "espn.com") ?? a.pages[0];
  const rosterCount = async () =>
    (await page.evaluate(
      `Array.from(new Set(Array.from(document.querySelectorAll('table.Table .playerinfo__playername')).map(e=>(e.textContent||'').trim()).filter(Boolean))).length`,
    )) as number;
  const startRoster = await rosterCount();
  console.log(`starting roster size: ${startRoster}`);
  for (let i = 0; i < rounds; i++) {
    const s = await readBlock(page);
    const now = await rosterCount();
    if (now > startRoster) {
      console.log(`WON a player -- roster grew ${startRoster} -> ${now}.`);
      break;
    }
    if (s.onBlock && s.player) {
      const max = (s.preDraftVal ?? s.currentOffer ?? 0) + overpay;
      if ((s.currentOffer ?? 0) < max && (s.myMax ?? 0) >= (s.currentOffer ?? 0) + 1) {
        const ok = await quickBid(page);
        console.log(`r${i}: ${ok ? "BID" : "no-bid"} ${s.player} $${s.currentOffer}->+1 (val ${s.preDraftVal}, max ${max})`);
      } else {
        console.log(`r${i}: hold ${s.player} $${s.currentOffer} (val ${s.preDraftVal}, our cap ${max})`);
      }
    } else {
      console.log(`r${i}: no player on block`);
    }
    await page.waitForTimeout(2000);
  }
  console.log(`final roster size: ${await rosterCount()}`);
  await detach(a);
}

// Full-auto auction engine (MVP): fill a complete legal roster in budget. Bots nominate
// (ESPN auto-nominates on our turn); we bid on any on-block player that fills an open slot,
// up to min(our value / ESPN pre-draft val / floor, ESPN's legal max). ESPN's myMax already
// reserves $1/open slot, so we can never strand a slot -> the done-bar is structurally safe.
async function cmdAutoDraft(rest: string[]) {
  const { readBlock, readRoster, hasOpenSlotFor, quickBid, jumpBid, readBoard, readLeague, nominate } = await import("./draft/espnAuction.js");
  const { loadRankings } = await import("./data/rankings.js");
  const { makeV2Strategy } = await import("./draft/strategy.js");
  const rounds = Number(valueOf(rest, "--rounds") ?? 400);
  // Default to OUR values table (data/values.csv) if present; else the strategy falls back to
  // ESPN's on-screen value per player. Pass --csv "" to force the ESPN fallback.
  const { existsSync } = await import("node:fs");
  let csv = valueOf(rest, "--csv");
  if (csv === undefined) csv = existsSync("data/values.csv") ? "data/values.csv" : undefined;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

  // OUR value overrides (name -> $) + pos, from an optional CSV (columns include player, pos,
  // value). Without a value column the Strategy falls back to ESPN's on-screen pre-draft value
  // -> the value source is the pluggable knob; budget-aware balancing works either way.
  const values: Record<string, number> = {};
  const posByName = new Map<string, string>();
  if (csv) {
    try {
      for (const p of loadRankings(csv)) {
        posByName.set(norm(p.name), p.pos);
        const v = (p as unknown as { value?: number }).value;
        if (typeof v === "number" && !Number.isNaN(v)) values[p.name] = v;
      }
    } catch { /* optional */ }
  }
  const strat = makeV2Strategy({
    values: Object.keys(values).length ? values : undefined,
    // Defaults from the SIM harness on the FORWARD-LOOKING 2025 projections (docs/validation.md).
    // The projection top is steep + this is a deep 16-team No-PPR league, so CONCENTRATION wins
    // (matches the league's real 61%-are-$1-5 behavior) -- lean aggressive: ~2-3 studs (~$120 on
    // top 3), keep ~$80 for depth. NOT max stars-and-scrubs (the harness may over-reward that;
    // re-run `ff sim` on final projections + apply judgment). Values = OUR VOR->$ (data/values.csv).
    starterReserve: Number(valueOf(rest, "--starter-reserve") ?? 5),
    benchReserve: Number(valueOf(rest, "--bench-reserve") ?? 1),
    premium: Number(valueOf(rest, "--premium") ?? 2),
    aggr: Number(valueOf(rest, "--aggr") ?? 1.0),
    maxShare: Number(valueOf(rest, "--max-share") ?? 0.6),
    // LIVE inflation repricing is ON by default -- backtested +~2 championship pts / +3 playoff pts
    // (docs/validation.md). Scarcity is OFF (backtested NEGATIVE). Toggle: --no-inflation, --scarcity.
    inflation: !rest.includes("--no-inflation"),
    scarcity: rest.includes("--scarcity"),
  });
  const normPos = (p: string | null): string | null => {
    if (!p) return null;
    const u = p.toUpperCase().replace("/", "");
    return ["QB", "RB", "WR", "TE", "K", "DST"].includes(u) ? u : null;
  };

  const a = await attachFor(rest);
  const page = findPage(a, "/football/draft") ?? findPage(a, "espn.com") ?? a.pages[0];
  let lastPlayer = "";
  let emptyReads = 0;
  let idlePolls = 0; // consecutive polls with no player on the block (-> likely our nomination turn)
  // LIVE inflation inputs: the board (remaining player values) + league money change slowly, so read
  // them every few ticks and cache -- a full board scrape every poll would be too slow.
  let liveBoard: { name: string; pos: string | null; value: number | null }[] = [];
  let league = { remainingDollars: 0, teams: 16 };
  const { computeInflation } = await import("./draft/inflation.js");
  let inflBaseline = 0; // raw inflation estimate captured at draft start (to normalize out the
  let liveInflation = 1; // virtualized-board bias); liveInflation = clamp(raw/baseline, 0.8, 1.4).
  for (let i = 0; i < rounds; i++) {
    if (i % 6 === 0) { liveBoard = await readBoard(page).catch(() => liveBoard); league = await readLeague(page).catch(() => league); }
    const r = await readRoster(page);
    if (r.filled === 0 && r.open === 0) {
      // Roster panel not rendered yet (pre-draft countdown) OR not in a draft. Tolerate a
      // startup window before giving up.
      if (++emptyReads > 25) {
        console.log(`no draft roster after ${emptyReads} reads -- not in a draft room. Stopping.`);
        break;
      }
      await page.waitForTimeout(1400);
      continue;
    }
    emptyReads = 0;
    if (r.open === 0) {
      console.log(`DONE: full roster (${r.filled} slots), spent $${r.spent}.`);
      break;
    }
    const b = await readBlock(page);
    if (b.onBlock && b.player && b.canBid) {
      const pos = normPos(b.pos) ?? normPos(posByName.get(norm(b.player)) ?? null);
      const need = pos ? hasOpenSlotFor(r, pos) : r.benchOpen > 0; // unknown pos -> bench only
      if (need && pos) {
        // Delegate the ceiling to the Strategy (budget-aware value); Engine clamps to ESPN's
        // hard legal max (myMax) and slot legality.
        // LIVE inflation: pass the remaining board (values) + a single aggregate "team" carrying the
        // league's total remaining $ and open slots (r.open x teams -- all teams fill ~evenly). The
        // strategy reprices by remaining$/remaining-value when cfg.inflation is on.
        const boardRefs = liveBoard.filter((p) => p.pos).map((p) => ({ name: p.name, pos: p.pos as never, team: "", espnPreDraftVal: p.value }));
        const leagueSlots = r.open * Math.max(1, league.teams);
        // Start-normalized inflation: the raw ratio is biased by the virtualized board, so divide by
        // the first-tick ratio (bias ~constant) and bound it. remaining$ falling faster than board
        // value -> >1 (reprice up); slower -> <1.
        const rawInfl = computeInflation(boardRefs.map((b) => ({ name: b.name, pos: String(b.pos), value: b.espnPreDraftVal ?? 1 })), league.remainingDollars || (200 - r.spent) * league.teams, leagueSlots);
        if (inflBaseline === 0 && rawInfl > 0) inflBaseline = rawInfl;
        liveInflation = inflBaseline > 0 ? Math.max(0.8, Math.min(1.4, rawInfl / inflBaseline)) : 1;
        const decision = strat.maxBid({
          myBudget: 200 - r.spent,
          mySlots: { ...r.openByBase, FLEX: r.flexOpen, BENCH: r.benchOpen },
          myRoster: [],
          onBlock: { name: b.player, pos: pos as never, team: "", espnPreDraftVal: b.preDraftVal },
          currentOffer: b.currentOffer,
          secondsLeft: null,
          iAmHighBidder: !b.canBid,
          liveInflation,
          board: boardRefs,
          teams: [{ name: "LEAGUE", budgetLeft: league.remainingDollars || (200 - r.spent), openSlots: leagueSlots }],
        });
        const cap = Math.min(decision.maxBid, b.myMax ?? 0);
        const offer = b.currentOffer ?? 0;
        if (offer < cap) {
          // For a player we value (big gap to cap), JUMP-bid toward our cap -- the +1 button is
          // too slow to win fast stud auctions. Step ~1/3 of the gap (min $5) so we win at a
          // reasonable price if bots quit early, rather than always paying full cap. Cheap/close
          // players use the +1 quick bid.
          const gap = cap - offer;
          let ok: boolean;
          if (gap >= 6 && cap >= 12) {
            const target = Math.min(cap, offer + Math.max(5, Math.ceil(gap * 0.34)));
            ok = await jumpBid(page, target);
            if (!ok) ok = await quickBid(page); // fallback if the manual field isn't ready
          } else {
            ok = await quickBid(page);
          }
          if (b.player !== lastPlayer)
            console.log(`r${i}: bid ${b.player} (${pos}) $${offer} cap=${cap} infl=${liveInflation.toFixed(2)} [${decision.reason}] myMax=${b.myMax} [$${league.remainingDollars} left, open ${r.open}]${ok ? "" : " (noclick)"}`);
          lastPlayer = b.player;
        } else if (b.player !== lastPlayer) {
          console.log(`r${i}: pass ${b.player} (${pos}) $${offer} cap=${cap} [${decision.reason}] [open ${r.open}]`);
          lastPlayer = b.player;
        }
      } else if (b.player !== lastPlayer) {
        console.log(`r${i}: skip ${b.player} (${pos ?? "?"}) -- no open slot [open ${r.open}]`);
        lastPlayer = b.player;
      }
    }
    // Anti-stall nomination (G3): if the draft sits idle (no player on the block) it is likely
    // our nomination turn -- nominate the cheapest board player that fills an open slot so the
    // draft never stalls waiting for us (and we pick up cheap fillers). Bots auto-nominate in
    // practice rooms, so this rarely fires there; it is the real-draft safety net.
    if (!b.onBlock) {
      if (++idlePolls >= 4) {
        const board = await readBoard(page);
        const fits = board.filter((p) => { const q = normPos(p.pos); return q && hasOpenSlotFor(r, q); });
        const pick = (fits.length ? fits : board).sort((x, y) => (x.value ?? 999) - (y.value ?? 999))[0];
        if (pick) {
          const ok = await nominate(page, pick.name);
          console.log(`r${i}: NOMINATE ${pick.name} ($${pick.value}) ${ok ? "" : "(failed -- maybe not our turn)"}`);
        }
        idlePolls = 0;
      }
    } else {
      idlePolls = 0;
    }
    await page.waitForTimeout(1400);
  }
  const fin = await readRoster(page);
  console.log(`final: filled ${fin.filled}/${fin.filled + fin.open} spent $${fin.spent} open ${fin.open}`);
  await detach(a);
}

async function cmdInspect(rest: string[]) {
  const out = valueOf(rest, "--out") ?? "data/draft-dom-snapshot.json";
  const a = await attachFor(rest);
  const page = findPage(a, "espn.com");
  if (!page) {
    console.error("No espn.com tab open. Navigate into an ESPN mock draft first.");
    await detach(a);
    process.exit(2);
  }
  const path = await inspectDraftDom(page, out);
  console.log(`Draft-room DOM snapshot written to ${path}`);
  console.log(`Page: ${page.url()}`);
  await detach(a);
}

function cmdRank(rest: string[]) {
  const csv = valueOf(rest, "--csv") ?? "data/rankings.sample.csv";
  const rankings = loadRankings(csv);
  const baselines = replacementBaselines(rankings, DEFAULT_LEAGUE);
  const valued = withVOR(rankings, baselines).sort((x, y) => y.vor - x.vor);
  console.log(`Top 15 by VOR (baselines: ${JSON.stringify(baselines)}):`);
  for (const p of valued.slice(0, 15)) {
    console.log(`  ${p.vor.toFixed(1).padStart(6)}  ${p.pos.padEnd(3)} ${p.name} (${p.team})`);
  }
}

async function cmdMock(rest: string[]) {
  const csv = valueOf(rest, "--csv") ?? "data/rankings.sample.csv";
  const a = await attachFor(rest);
  const page = findPage(a, "espn.com");
  if (!page) {
    console.error("No espn.com tab open. Join an ESPN mock draft first.");
    await detach(a);
    process.exit(2);
  }
  await runDraft(page, {
    rankingsPath: csv,
    league: DEFAULT_LEAGUE,
    overrideWindowSec: 8,
    pollMs: 1500,
  });
}

function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
