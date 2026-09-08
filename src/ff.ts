#!/usr/bin/env tsx
// The `ff` CLI -- the engine (D7). Runnable in a terminal for iteration; the
// unattended agent will later reach a constrained subset of these as tools.
//
//   npm run ff -- attach            test the copresent CDP connection, list tabs
//   npm run ff -- inspect-draft     dump the live ESPN draft-room DOM to a file
//   npm run ff -- rank              print top players by VOR from the rankings CSV

import { findPage, detach, type Attached } from "./browser/attach.js";
import { inspectDraftDom } from "./draft/espnReader.js";
import { loadRankings } from "./data/rankings.js";
import { replacementBaselines, withVOR, type LeagueSettings } from "./draft/rank.js";
import { ingestAll } from "./data/ingest.js";
import { openDb } from "./db/db.js";
import { dataPath } from "./data/paths.js";

const DEFAULT_LEAGUE: LeagueSettings = {
  teams: 10,
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "bro":
      // Kept only to say where it went. A verb that silently vanishes leaves a user's muscle memory
      // failing with "unknown command" and no idea what replaced it.
      console.log("`ff bro` is gone -- the desktop app IS the browser now.\n" +
        "  It holds the authenticated ESPN session in its own partition and is always a CDP target,\n" +
        "  so there is no second browser to start or log into. Just open the app.\n" +
        "  Escape hatch for a manually-launched Chrome: pass --port <N> to any browser verb.");
      return void process.exit(2);
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
    case "values-check":
      return cmdValuesCheck(rest);
    case "news":
      return cmdNews(rest);
    case "cheatsheet":
      return cmdCheatsheet(rest);
    case "project":
      return cmdProject(rest);
    case "lineup":
      return cmdLineup(rest);
    case "handcuffs":
      return cmdHandcuffs(rest);
    case "calibrate":
      return cmdCalibrate(rest);
    case "sim":
      return cmdSim(rest);
    case "backtest":
      return cmdBacktest(rest);
    case "build-history":
      return cmdBuildHistory(rest);
    case "build-features":
      return cmdBuildFeatures(rest);
    case "build-picks":
      return cmdBuildPicks(rest);
    case "build-artifact":
      return cmdBuildArtifact(rest);
    case "scrape-league":
      return cmdScrapeLeague(rest);
    case "ingest-source":
      return cmdIngestSource(rest);
    case "sync-rosters":
      return cmdSyncRosters(rest);
    case "enter-draft":
      return cmdEnterDraft(rest);
    case "preflight":
      return cmdPreflight(rest);
    case "inspect-draft":
      return cmdInspect(rest);
    case "rank":
      return cmdRank(rest);
    case "models":
      return cmdModels();
    case "build-identity":
      return cmdBuildIdentity(rest);
    case "build-staging":
      return cmdBuildStaging(rest);
    case "ingest-playerids":
      return cmdIngestPlayerIds(rest);
    case "ingest-ecr":
      return cmdIngestEcr(rest);
    case "ingest":
      return ingestAll(valueOf(rest, "--db"));
    case "migrate": {
      const db = openDb(valueOf(rest, "--db"));
      db.close();
      console.log("migrated");
      return;
    }
    case "app-data":
      return cmdAppData(rest);
    case "serve":
      return cmdServe(rest);
    case "auth": {
      const { authStatus } = await import("./agent/auth.js");
      console.log(JSON.stringify(authStatus()));
      return;
    }
    case "agent-ask":
      return cmdAgentAsk(rest);
    // BYO agent: serve the SAME control surface the in-app copilot uses over stdio MCP, so Claude
    // Code (or any MCP client) can drive the draft. See docs/mcp.md.
    case "mcp": {
      const { serveMcpStdio } = await import("./agent/mcp-stdio.js");
      const seasonArg = valueOf(rest, "--season");
      return serveMcpStdio({ dbPath: valueOf(rest, "--db"), season: seasonArg ? Number(seasonArg) : undefined });
    }
    case "my-roster-set":
      return cmdMyRosterSet(rest);
    case "assemble":
      return cmdAssemble(rest);
    case "projections":
      return cmdProjections(rest);
    case "refresh":
      return cmdRefresh(rest);
    default:
      console.log(
        "commands:\n" +
          "  attach [--port N]          test the connection to the app's embedded ESPN webview\n" +
          "  goto <url>                 navigate the app's webview\n" +
          "  inspect-draft [--out FILE] dump the live ESPN draft-room DOM\n" +
          "  rank [--csv FILE]          top players by VOR (offline)",
      );
  }
}

// The app's data payload, read LIVE from the SQLite store (the materialized `board` view + the
// `news` feed). Prints ONE JSON line to stdout so the Electron main process can parse it. This is
// what replaces the generated data.js -- the app reads the DB through the engine, no regeneration.
async function cmdAppData(rest: string[]) {
  const { openDb } = await import("./db/db.js");
  const { appDataPayload } = await import("./data/appdata.js");
  const db = openDb(valueOf(rest, "--db"));
  const season = Number(valueOf(rest, "--season") ?? new Date().getFullYear());
  const payload = appDataPayload(db, season);
  db.close();
  process.stdout.write(JSON.stringify(payload) + "\n");
}

// The persistent helper: one long-lived process holding an open DB connection, speaking NDJSON
// request/response on stdin/stdout ({id, method, params} -> {id, ok, result|error}). The Electron
// app spawns ONE of these and pipes fast reads/writes to it -- no per-op process spawn, no native
// SQLite in Electron. Methods are additive; agent-ask stays its own streamed spawn.
async function cmdServe(rest: string[]) {
  const readline = await import("node:readline");
  const { openDb, getConfig, setMyRoster, getMyRoster, setConfig } = await import("./db/db.js");
  const { appDataPayload } = await import("./data/appdata.js");
  const { authStatus } = await import("./agent/auth.js");
  const { applyLevers, DEFAULT_LEVERS } = await import("./draft/levers.js");
  const db = openDb(valueOf(rest, "--db"));
  const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
  const curSeason = () => getConfig(db).season;
  const rl = readline.createInterface({ input: process.stdin });
  send({ event: "ready", pid: process.pid });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: { id?: number; method?: string; params?: Record<string, unknown> };
    try { req = JSON.parse(line); } catch { continue; }
    const { id, method, params = {} } = req;
    try {
      let result: unknown;
      switch (method) {
        case "ping": result = "pong"; break;
        // Cheap staleness probe: MAX(board.updated_at) and a row count, nothing else. The app calls
        // this after EVERY engine invocation to decide whether the open window is now showing an
        // out-of-date board, so it must stay a single indexed aggregate -- app-data serialises 523
        // player rows and is far too expensive to poll.
        case "board-stamp": {
          const s = Number(params.season) || curSeason();
          const row = db.prepare("SELECT MAX(updated_at) AS m, COUNT(*) AS n FROM board WHERE season = ?")
            .get(s) as { m: string | null; n: number };
          result = { builtAt: row?.m ?? null, players: row?.n ?? 0, season: s };
          break;
        }
        case "app-data": result = appDataPayload(db, Number(params.season) || curSeason()); break;
        case "my-roster-get": result = getMyRoster(db, String(params.draftId ?? "local")); break;
        case "my-roster-set": setMyRoster(db, String(params.draftId ?? "local"), (params.roster as { name: string; price: number }[]) ?? []); result = { ok: true, n: ((params.roster as unknown[]) ?? []).length }; break;
        case "live-state": {
          const row = db.prepare("SELECT updated_at, state_json FROM draft_state WHERE draft_id = ?").get(String(params.draftId ?? "local")) as { updated_at: string; state_json: string } | undefined;
          result = row ? { ageSec: Math.round((Date.now() - Date.parse(row.updated_at)) / 1000), data: JSON.parse(row.state_json) } : null;
          break;
        }
        case "draft-picks": {
          const picks = db.prepare("SELECT pick_no, player_id, team, price, ts FROM draft_pick WHERE draft_id = ? ORDER BY pick_no").all(String(params.draftId ?? "local"));
          result = picks.length ? { picks } : null;
          break;
        }
        case "data-sources": {
          // freshness (rows + last-updated) for every table node in the warehouse DAG; the renderer
          // holds the static lineage and looks up each table here by name.
          const TS: [string, string][] = [
            ["player", "updated_at"], ["ranking", "fetched_at"], ["player_bio", "updated_at"], ["team_bye", ""],
            ["player_advanced", "updated_at"], ["trade_value", "updated_at"], ["weekly_rank", "scraped"],
            ["player_status", "updated_at"], ["trending", "scraped"], ["team_odds", "updated_at"], ["boris_tier", "scraped"],
            ["adp", "scraped"], ["market_value", "updated_at"], ["news", "asof"], ["league", "last_synced_at"],
            ["player_value", "updated_at"], ["board", "updated_at"],
            // identity + staging: freshness for the new spine, so the lineage view can show row
            // counts for them like any other node rather than rendering them permanently empty.
            ["ranking_history", "fetched_at"], ["player_ids", "updated_at"],
            ["player_identity", "created_at"], ["player_xref", "created_at"], ["player_position", ""],
            ["stg_player", "updated_at"],
          ];
          const tables: Record<string, { rows: number; updated: string | null }> = {};
          for (const [t, col] of TS) {
            try {
              const r = db.prepare(`SELECT count(*) c${col ? `, max(${col}) u` : ""} FROM ${t}`).get() as { c: number; u?: string | null };
              tables[t] = { rows: r.c, updated: r.u ?? null };
            } catch { tables[t] = { rows: 0, updated: null }; }
          }
          const lastIngest = (db.prepare("SELECT value FROM settings WHERE key='last_ingest'").get() as { value: string } | undefined)?.value ?? null;
          result = { lastIngest, tables };
          break;
        }
        case "model-graph": {
          // WHAT THE MODEL IS, AND WHERE A NUMBER CAME FROM.
          //
          // The warehouse lineage answers "where did this ROW come from". It stops at the board,
          // which is exactly where the interesting part starts: a projection is a rank-curve value
          // multiplied by fitted factors, then fed to a simulator that turns points into title
          // probability. None of that was visible anywhere, so a number on the board had to be taken
          // on trust -- and this session found three separate cases where trust was misplaced
          // (a quarterback scored on receiving columns, sixteen rosters missing a defense, an empty
          // slot scored as zero). Things that cannot be seen do not get checked.
          //
          // Two payloads: the REGISTRY (what is fitted, what it measured, what is failing its own
          // check) and a TRACE (for real players, the multiplication that produced their projection,
          // step by step).
          const { readFileSync } = await import("node:fs");
          const { dataPath } = await import("./data/paths.js");
          const { modelStatus, EVALUATED_NOT_SHIPPED } = await import("./draft/models.js");
          const { ageFactor } = await import("./draft/age.js");
          const { opportunityFactor } = await import("./draft/opportunity.js");
          const cfgRow = db.prepare("SELECT value FROM settings WHERE key='config'").get() as { value: string } | undefined;
          const cfg = cfgRow ? JSON.parse(cfgRow.value) : {};
          const season = Number(cfg.season) || new Date().getFullYear();

          let ageCurve: Record<string, unknown> | null = null, oppModel: Record<string, unknown> | null = null;
          try { ageCurve = JSON.parse(readFileSync(dataPath("age-curve.json"), "utf8")); } catch { /* status says so */ }
          try { oppModel = JSON.parse(readFileSync(dataPath("opportunity-model.json"), "utf8")); } catch { /* same */ }

          // The trace runs on the REAL board rows, and per position so the rank each factor is keyed
          // on is the rank the projection was actually built at.
          const rows = db.prepare("SELECT row_json FROM board WHERE season=?").all(season) as { row_json: string }[];
          const parsed = rows.map((r) => JSON.parse(r.row_json) as Record<string, unknown>);
          const byPos: Record<string, { name: string; proj: number }[]> = {};
          for (const j of parsed) {
            const pos = String(j.Pos ?? "");
            if (!pos) continue;
            (byPos[pos] ??= []).push({ name: String(j.Player), proj: Number(j.ProjPts) || 0 });
          }
          const trace: Record<string, unknown>[] = [];
          for (const [pos, list] of Object.entries(byPos)) {
            list.sort((a, b) => b.proj - a.proj);
            list.slice(0, 12).forEach((pl, i) => {
              const rank = i + 1;
              const age = ageCurve ? ageFactor(ageCurve as never, pl.name, pos, season) : 1;
              const opp = oppModel ? opportunityFactor(oppModel as never, pl.name, pos, rank, season) : 1;
              // The board value is POST-factor, so the pre-factor base is recovered by dividing. Doing
              // it the other way -- multiplying the shipped number by the factors again -- would apply
              // them twice and is the kind of error a display makes look authoritative.
              const denom = (age || 1) * (opp || 1);
              trace.push({
                pos, rank, name: pl.name,
                base: denom ? pl.proj / denom : pl.proj,
                age, opp, final: pl.proj,
              });
            });
          }
          result = {
            season,
            models: modelStatus(),
            rejected: EVALUATED_NOT_SHIPPED,
            trace,
            sim: {
              slots: cfg.slots ?? [], flexOk: cfg.flex_ok ?? [],
              playoffTeams: cfg.playoffTeams ?? null, regWeeks: cfg.regWeeks ?? null,
              teams: cfg.teams ?? null, scoring: cfg.scoring ?? null,
            },
          };
          break;
        }
        case "ownership": {
          const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get() as { league_id: string } | undefined;
          const map: Record<string, { owner: string; team: string; slot: string }> = {};
          if (lg) {
            for (const r of db.prepare("SELECT p.name AS name, o.owner, o.team_abbrev, o.slot FROM ownership o JOIN player p ON p.player_id=o.player_id WHERE o.league_id=?").all(lg.league_id) as { name: string; owner: string; team_abbrev: string; slot: string }[]) {
              map[r.name] = { owner: r.owner, team: r.team_abbrev, slot: r.slot };
            }
          }
          result = { leagueId: lg?.league_id ?? null, ownership: map };
          break;
        }
        case "config-get": result = getConfig(db); break;
        case "config-set": setConfig(db, (params.config as Record<string, unknown>) ?? {}); result = getConfig(db); break;
        case "levers-set": { // clamp each knob to its valid range before storing
          const patch = (params.patch as Record<string, unknown>) ?? {};
          // `reset: true` restores DEFAULT_LEVERS *server-side*. The renderer must never carry its
          // own copy of the values: it did, and that copy went stale -- the app's "Reset levers"
          // button held aggr 1.0 / reserve 15 / maxShare 0.35 and no benchDiscount or multipliers,
          // so one click would have silently reverted the tuned config to the pre-shading posture
          // (worth about -10 championship pts) with nothing to warn you.
          const next = patch.reset === true
            ? { ...DEFAULT_LEVERS }
            : applyLevers(getConfig(db).levers, patch);
          setConfig(db, { levers: next }); result = next; break;
        }
        case "league-info": {
          const cfg = getConfig(db);
          const lg = db.prepare("SELECT league_id, name, season, team_id, scoring_json FROM league ORDER BY last_synced_at DESC LIMIT 1").get() as { league_id: string; name: string; season: number; team_id: string; scoring_json: string } | undefined;
          const nPlayers = (db.prepare("SELECT count(*) c FROM player_value WHERE season = ?").get(cfg.season) as { c: number }).c;
          result = { config: cfg, league: lg ?? null, players: nPlayers, onboarded: nPlayers > 0 && !!lg };
          break;
        }
        case "auth-status": result = authStatus(); break;
        default: throw new Error(`unknown method: ${method}`);
      }
      send({ id, ok: true, result });
    } catch (e) { send({ id, ok: false, error: String(e) }); }
  }
  db.close();
}

// The real draft copilot: a Claude Agent SDK session (subscription auth via the machine's `claude`
// login) reasoning over the SQLite store through read-only tools. `--json` streams one event per
// line for the Electron chat sink: {t:"text"|"tool"|"done", ...}. Human mode prints text inline.
async function cmdAgentAsk(rest: string[]) {
  const { agentAsk } = await import("./agent/agent.js");
  const json = rest.includes("--json");
  let question = rest.filter((a) => !a.startsWith("--")).join(" ").trim();
  // no positional question + piped stdin -> read it there (how the Electron app passes the message,
  // avoiding any shell-quoting of user text)
  if (!question && !process.stdin.isTTY) {
    question = await new Promise<string>((res) => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => res(s.trim())); });
  }
  if (!question) { console.log('usage: ff agent-ask "your question"  [--json] [--db F] [--season N]'); return; }
  const emit = (e: Record<string, unknown>) => process.stdout.write(JSON.stringify(e) + "\n");
  await agentAsk(question, {
    dbPath: valueOf(rest, "--db"),
    season: valueOf(rest, "--season") ? Number(valueOf(rest, "--season")) : undefined,
    onEvent: (m) => {
      const msg = m as { type: string; message?: { content: { type: string; text?: string; name?: string; input?: unknown }[] }; subtype?: string };
      if (msg.type === "assistant" && msg.message) {
        for (const c of msg.message.content) {
          if (c.type === "text" && c.text) json ? emit({ t: "text", s: c.text }) : process.stdout.write(c.text);
          else if (c.type === "tool_use" && (c.name || "").startsWith("mcp__ff-draft__")) { const name = (c.name || "").replace(/^mcp__ff-draft__/, ""); json ? emit({ t: "tool", name, args: c.input }) : process.stderr.write(`\n  [tool ${name}]\n`); }
        }
      } else if (msg.type === "result") {
        json ? emit({ t: "done", subtype: msg.subtype }) : process.stdout.write("\n");
      }
    },
  });
}

// Projection curve (TS port of build_projections) -> data/points.csv. Reads ECR from the store.
async function cmdProjections(rest: string[]) {
  const { project } = await import("./data/projections.js");
  // --curve orderstat restores the pre-2026-09-08 order-statistic curve, for A/B only. The default
  // is the conditional curve; see the header of src/data/projections.ts for why they differ.
  const curve = valueOf(rest, "--curve") === "orderstat" ? "orderstat" : "conditional";
  const n = await project(valueOf(rest, "--db"), valueOf(rest, "--out") ?? dataPath("points.csv"), true, true, curve);
  console.log(`wrote points.csv (${n} players)`);
}

// The full data refresh, ALL TS (no Python): ingest reference+news -> project curve -> assemble value/board.
async function cmdRefresh(rest: string[]) {
  const db = valueOf(rest, "--db");
  const { ingestAll } = await import("./data/ingest.js");
  const { project } = await import("./data/projections.js");
  const { assemble } = await import("./data/assemble.js");
  await ingestAll(db);
  console.log(`projections: ${await project(db)} players`);
  console.log(`refresh complete: ${await assemble(db)} players (all TS, no Python)`);
}

// Assemble L1 player_value + L2 board (TS port of build_report). Reads reference data from the store
// + points.csv, fetches ESPN/last-year, computes derived fields, writes the value/board tables.
async function cmdAssemble(rest: string[]) {
  const { assemble } = await import("./data/assemble.js");
  const n = await assemble(valueOf(rest, "--db"), valueOf(rest, "--points") ?? dataPath("points.csv"));
  console.log(`assembled ${n} players -> player_value + board + ranking:espn`);
}

// Mirror the app's drafted team into SQLite (my_roster). Reads a JSON array [{name,price}] on stdin;
// the Electron app pipes it here on every roster change so the agent (and durability) see the team.
async function cmdMyRosterSet(rest: string[]) {
  const { openDb, setMyRoster } = await import("./db/db.js");
  const draftId = valueOf(rest, "--draft") ?? "local";
  const raw = await new Promise<string>((res) => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => res(s.trim())); });
  let roster: { name: string; price: number }[] = [];
  try { const parsed = JSON.parse(raw || "[]"); if (Array.isArray(parsed)) roster = parsed.map((r) => ({ name: String(r.name), price: Number(r.price) || 0 })); } catch { /* empty */ }
  const db = openDb(valueOf(rest, "--db"));
  setMyRoster(db, draftId, roster);
  db.close();
  console.log(`my_roster[${draftId}] set: ${roster.length} players`);
}

// Attach via bro's session by default; allow --port for a manually-launched browser.
//
// `--app` targets the DESKTOP APP's embedded ESPN webview instead. That guest is not a Playwright
// page (connectOverCDP enumerates only the file:// renderer), so it is wrapped by
// src/browser/webviewPage.ts, which implements the slice of the Page API espnAuction uses on top of
// webview.executeJavaScript. Plain `--port <app port>` does NOT work for draft verbs: it hands them
// the renderer. The app webview is the only session now.
/** `--pos-mult QB:0.7,RB:1.1` -> { QB: 0.7, RB: 1.1 }. Overrides the persisted lever per position,
 *  for sweeps; positions not named keep the lever value. */
function parsePosMult(arg: string | undefined): Record<string, number> {
  if (!arg) return {};
  const out: Record<string, number> = {};
  for (const kv of arg.split(",")) { const [k, v] = kv.split(":"); if (k && v != null && Number.isFinite(Number(v))) out[k.toUpperCase()] = Number(v); }
  return out;
}

/**
 * THE APP IS THE BROWSER. Every verb attaches to the desktop app's embedded ESPN webview.
 *
 * This used to default to a `bro` session and reach the app only behind `--app`, which had the
 * dependency exactly backwards: it made the second browser -- a separate checkout, a separate login,
 * a separate profile the user had to remember to start -- the normal path, and the app the special
 * case. The app already holds an authenticated ESPN session in a persistent partition and is always
 * a CDP target, so there is nothing bro provided that it does not.
 *
 * `--port` survives for a manually-launched Chrome, which is a genuine debugging escape hatch. The
 * bro path is gone; `--site` went with it, since there is only one session now.
 */
async function attachFor(rest: string[]): Promise<Attached> {
  const port = valueOf(rest, "--port");
  const { attachWebview } = await import("./browser/webviewPage.js");
  const w = await attachWebview(port ? Number(port) : undefined);
  return { browser: w.browser, context: w.browser.contexts()[0], pages: [w.page] } as Attached;
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
  // The embedded ESPN webview is our ONE working page -- reuse it whatever it's showing (the old
  // the old logic looked for a separate non-draft tab; here there's just the webview). Fall back to any
  // non-draft page, then a new page.
  let page = a.pages.find((p) => /espn\.com/.test(p.url()) && !/recaptcha|imrworldwide|registerdisney/.test(p.url()))
    || a.pages.find((p) => !/\/football\/draft/.test(p.url()))
    || await a.context.newPage();
  // Now close any OTHER draft tabs -- ESPN allows only ONE draft connection; a duplicate
  // triggers "disconnected... from another location". Our working page is not a draft tab.
  for (const p of a.pages) {
    if (p !== page && /\/football\/draft/.test(p.url())) await p.close().catch(() => {});
  }
  // Land on a fresh lobby. Use domcontentloaded, NOT networkidle -- ESPN's lobby never goes idle
  // (constant ad/polling traffic), so networkidle hangs; then poll natively for the button by text
  // (getByRole's accessible-name match was unreliable for this button).
  await page.goto("https://fantasy.espn.com/football/mockdraftlobby", { waitUntil: "domcontentloaded" }).catch(() => {});
  const ready = await page.waitForFunction(
    () => Array.from(document.querySelectorAll("button")).some((b) => b.textContent.trim() === "Practice Draft"),
    { timeout: 20000 },
  ).then(() => true).catch(() => false);
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
  // Current ESPN UI (verified 2026-09): the flow is just "Practice Draft" -> "Start Practice Draft",
  // with NO position <select> (the old select step aborted the launch). Native clicks are more robust
  // than getByRole against ESPN's late-rendering React; the window.open shim above captures the draft
  // URL so we navigate our ONE tab (the embedded webview) into it instead of popping a new window.
  await page.evaluate(() => { const x = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Practice Draft"); if (x) (x as HTMLButtonElement).click(); });
  await page.waitForTimeout(3000);
  let started = false;
  for (let i = 0; i < 6 && !started; i++) {
    started = await page.evaluate(() => { const x = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Start Practice Draft"); if (x) { (x as HTMLButtonElement).click(); return true; } return false; });
    if (!started) await page.waitForTimeout(1000);
  }
  if (!started) { console.error("could not start practice draft (Start button never rendered)"); await detach(a); return; }
  await page.waitForTimeout(3500);
  const opened = (await page.evaluate("window.__ffOpen")) as string | null; // the draft-room URL
  if (opened) {
    const url = opened.startsWith("http") ? opened : new URL(opened, page.url()).href;
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(2000);
    console.log(`practice draft started -> ${page.url()} | ${await page.title()}`);
  } else {
    console.error(`no draft window captured; still at ${page.url()}`);
  }
  await detach(a);
}

// Last-resort fallbacks only. The real identity comes from the synced `league` table (below);
// these are used only if nothing has been discovered/synced yet.
const REAL_LEAGUE = "462233"; // seacaptaindate.com (16-team $200 auction)
const REAL_TEAM = "8";

// Enter the REAL league draft room (G1). Same auction app as practice, so once we're in,
// readBlock/readRoster/readBoard/quickBid/jumpBid all transfer. The real draft opens a few
// minutes before start; run this then, then `ff auto-draft`. Tries, in order: an "Enter Draft"
// control from the league (captured window.open), then the direct draft URL.
/** The SWID cookie, which ESPN's draft URL wants as `memberId`. Read straight from the page we are
 *  already on, so it works for both a real Playwright Page and the webview shim (both have
 *  `evaluate`). Returns null rather than throwing -- the URL still resolves without it in some
 *  cases, and a missing memberId should degrade to the clubhouse fallback, not abort entry. */
async function espnSwidFor(page: { evaluate: (js: string) => Promise<unknown> }): Promise<string | null> {
  try {
    const raw = String((await page.evaluate("(document.cookie.match(/SWID=([^;]+)/)||[])[1]||''")) || "");
    return raw ? decodeURIComponent(raw) : null;
  } catch { return null; }
}

async function cmdEnterDraft(rest: string[]) {
  const { readRoster } = await import("./draft/espnAuction.js");
  const { openDb, getConfig } = await import("./db/db.js");
  const db = openDb(valueOf(rest, "--db"));
  const season = getConfig(db).season;
  const active = (db.prepare("SELECT league_id, team_id FROM league WHERE season=@s ORDER BY last_synced_at DESC LIMIT 1").get({ s: season })
    ?? db.prepare("SELECT league_id, team_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get()) as { league_id: string; team_id: string } | undefined;
  db.close();
  const league = valueOf(rest, "--league") ?? active?.league_id ?? REAL_LEAGUE;
  const team = valueOf(rest, "--team") ?? active?.team_id ?? REAL_TEAM;
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

  // ORDER MATTERS, and this is why (2026-09-06, the real draft): the clubhouse-click strategy used
  // to run FIRST and called `page.getByRole`, which the webview shim (src/browser/webviewPage.ts)
  // does not implement -- it only ports the slice of the Page API espnAuction.ts uses. So under
  // --app it threw "page.getByRole is not a function" and died BEFORE reaching the direct-URL
  // fallback that actually works. Every mock used `launch-practice`, so this path had never run.
  //
  // Direct URL is now Strategy 1: it needs no Locator API, and it is the same navigation
  // `launch-practice` has always used. Note the memberId param -- without it ESPN redirects to the
  // fantasy homepage rather than the draft room.
  const swid = await espnSwidFor(page).catch(() => null);
  const directUrl = `https://fantasy.espn.com/football/draft?leagueId=${league}&seasonId=${season}&teamId=${team}`
    + (swid ? `&memberId=${swid}` : "");
  await page.goto(directUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(1500);

  // Strategy 2 (fallback): from the clubhouse, click an "Enter Draft" control -- it opens the draft
  // app via window.open, which we shim to capture the URL rather than spawn a second tab (a
  // duplicate draft connection kicks the seat). Guarded: `getByRole` exists on a real Playwright
  // Page but not on the webview shim, so feature-detect instead of assuming.
  if (!(await inDraft(page)) && typeof (page as { getByRole?: unknown }).getByRole === "function") {
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
      console.log("No 'Enter Draft' control on the clubhouse (draft not open yet?).");
    }
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
// Draft-morning go/no-go. The OFFLINE half runs with no browser and answers "is the engine ready to
// bid": is the book built, are the levers the ones we validated, is there a stale lock, how old is
// the data. Then the ONLINE half checks the session. Everything prints OK / CHECK / FAIL so it can
// be read in ten seconds at 08:30 without interpreting anything.
async function preflightOffline(rest: string[]): Promise<void> {
  const { openDb, getConfig } = await import("./db/db.js");
  const { valueBook } = await import("./data/appdata.js");
  const { DEFAULT_LEVERS } = await import("./draft/levers.js");
  const { existsSync, statSync, readFileSync } = await import("node:fs");
  const line = (ok: boolean | null, msg: string) => console.log(`${ok === null ? "CHECK" : ok ? "OK   " : "FAIL "}: ${msg}`);
  let db;
  try { db = openDb(valueOf(rest, "--db")); } catch (e) { line(false, `cannot open the store -- ${(e as Error).message}`); return; }
  const cfg = getConfig(db);
  const season = Number(valueOf(rest, "--season") ?? cfg.season);

  // 1. The value book the bidder will actually use.
  const book = valueBook(db, season);
  line(book.length >= 450, `value book: ${book.length} priced players for ${season} (player_value)`);
  if (book.length) line(true, `  top: ${book.slice(0, 5).map((p) => `${p.name} $${p.value}`).join(", ")}`);

  // 2. Levers -- STORED config wins over code defaults, so print what will really be used and say
  //    loudly if it differs from the validated posture (a mid-draft retune left behind, say).
  const lv = cfg.levers as unknown as Record<string, number>;
  const def = DEFAULT_LEVERS as unknown as Record<string, number>;
  const drift = Object.keys(def).filter((k) => lv[k] !== def[k]).map((k) => `${k} ${lv[k]} (validated ${def[k]})`);
  line(drift.length === 0, drift.length ? `levers DIFFER from the validated posture: ${drift.join(", ")}` : `levers match the validated posture (aggr ${lv.aggr}, maxShare ${lv.maxShare}, reserve ${lv.starterReserve})`);

  // 3. League shape.
  line(cfg.teams > 0 && cfg.slots.length > 0, `league: ${cfg.teams} teams, $${cfg.budget}, ${cfg.slots.length} slots, ${cfg.scoring}, ${cfg.playoffTeams}-team playoff`);

  // 4. A lock left by a killed run blocks the next auto-draft -- at 09:00 that is the last thing
  //    you want to debug. Killing the shell does NOT kill the node tree on Windows.
  const lock = dataPath("auto-draft.lock");
  if (existsSync(lock)) {
    let pid = "";
    try { pid = readFileSync(lock, "utf8").trim(); } catch { /* unreadable */ }
    line(false, `STALE LOCK present (${pid}) -- delete data/auto-draft.lock or auto-draft will refuse to start`);
  } else line(true, "no stale auto-draft lock");

  // 5. Data freshness. Rebuild the morning of: projections move on injury news.
  for (const f of ["points.csv", "values.csv"]) {
    try {
      const h = (Date.now() - statSync(dataPath(f)).mtimeMs) / 3600000;
      line(h < 24 ? true : null, `data/${f} is ${h.toFixed(1)}h old${h >= 24 ? " -- run `ff refresh`" : ""}`);
    } catch { line(false, `data/${f} missing -- run \`ff refresh\``); }
  }

  // 6. The clock. ESPN's draftSettings.date was read at setup; if we stored it, say how long is left.
  try {
    const row = db.prepare("SELECT scoring_json FROM league WHERE league_id = ?").get(REAL_LEAGUE) as { scoring_json?: string } | undefined;
    const draftAt = row?.scoring_json ? (JSON.parse(row.scoring_json) as { draftDate?: number }).draftDate : undefined;
    if (draftAt) {
      const mins = Math.round((draftAt - Date.now()) / 60000);
      line(true, `draft at ${new Date(draftAt).toLocaleString()} (${mins > 0 ? `${Math.floor(mins / 60)}h ${mins % 60}m away; room opens 60m before` : "STARTED"})`);
    }
  } catch { /* optional */ }
  db.close();
}

async function cmdPreflight(rest: string[]) {
  const { readRoster } = await import("./draft/espnAuction.js");
  const league = valueOf(rest, "--league") ?? REAL_LEAGUE;
  const team = valueOf(rest, "--team") ?? REAL_TEAM;
  console.log("--- engine (offline) ---");
  await preflightOffline(rest).catch((e) => console.log(`FAIL : offline checks threw -- ${(e as Error).message}`));
  console.log("--- session (browser) ---");
  let a: Attached;
  try { a = await attachFor(rest); } catch (e) { console.log(`FAIL: cannot attach to the app webview -- ${(e as Error).message}`); return; }
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
  // --app is mandatory: plain --port hands the draft verbs the app's own UI window, not the ESPN
  // webview, and fails silently. Do not enter before the room opens -- a duplicate connection kicks
  // the seat (docs/draft-day-runbook.md).
  console.log(`When the room OPENS (not before): npm run ff -- enter-draft --app   then: npm run ff -- auto-draft --app`);
  await detach(a);
}

// Scrape ESPN's full board values (calibrated to our league) into a values CSV.
// Compute OUR auction values from a points table (VOR->$) and write a values CSV.
// Demo the shared projection layer: season / this-week-vs-opponent / rest-of-season for a player.
// In-season weekly lineup optimizer. Reads a roster (offline CSV now: player[,opp][,injury]; live
// copresent read once the season starts), projects each via the shared layer, and recommends the
// optimal legal AVAILABLE lineup. `--set` would submit it (live, at season start).
/**
 * `ff handcuffs [--pos RB,WR] [--weeks N] [--free] [--json]`
 *
 * Who is worth a bench slot because of who is ahead of them. Ranked by the CONDITIONAL payoff -- what
 * the man scores in a week the starter misses -- rather than by expected value, because a handcuff's
 * EV is a small probability times a moderate gain and sorting on it buries precisely the asymmetric
 * bets that justify holding one.
 */
/**
 * `ff models`
 *
 * What is fitted, how old it is, whether it still passes its own checks, and -- the part that kept
 * getting lost -- what each model is HONESTLY worth under nested cross-validation rather than under
 * the loop that also chose its shape.
 */
async function cmdModels(): Promise<void> {
  const { modelStatus } = await import("./draft/models.js");
  const rows = modelStatus();
  console.log("FITTED MODELS\n");
  console.log("  model                 age    size   OOS lift (nested)   status");
  for (const r of rows) {
    const lift = r.nestedLift == null ? "      n/a" : `${r.nestedLift >= 0 ? "+" : ""}${r.nestedLift.toFixed(4)}`;
    const claim = r.claimedLift != null && r.nestedLift != null && Math.abs(r.claimedLift - r.nestedLift) > 1e-6
      ? `  (was claimed ${r.claimedLift >= 0 ? "+" : ""}${r.claimedLift.toFixed(4)})` : "";
    const state = !r.present ? (r.required ? "MISSING -- required" : "missing (optional)")
      : r.problem ? `FAILS: ${r.problem}` : "ok";
    console.log(`  ${r.key.padEnd(20)} ${(r.ageDays == null ? "-" : r.ageDays + "d").padStart(5)} ${(r.sizeKb == null ? "-" : r.sizeKb + "kb").padStart(7)}   ${lift.padStart(10)}${claim ? "" : "        "}   ${state}${claim}`);
  }
  for (const r of rows) console.log(`\n  ${r.key}: ${r.what}`);
  const bad = rows.filter((r) => !r.present || r.problem);
  console.log(bad.length
    ? `\n  ${bad.length} model(s) need attention. A missing optional model degrades SILENTLY -- every
  factor returns 1 and the board looks entirely normal, which is why this command exists.`
    : `\n  All models present and passing their checks.`);
  console.log(`\n  Lifts are measured under NESTED cross-validation (scripts/nested-cv.mjs): the model is
  refit inside every fold, so the score never includes the seasons used to choose its shape. Where a
  claimed figure differs, the claim came from a single hold-one-out loop that ALSO picked the
  amplitudes and clamps -- roughly half of those numbers was selection.`);
}

/**
 * `ff build-identity`
 *
 * Mint/refresh the durable player surrogate keys. Rerunnable: existing players match on their source
 * ids and keep their keys, so a second run mints nothing.
 */
async function cmdBuildIdentity(rest: string[]) {
  const { buildIdentity } = await import("./data/identity.js");
  const { openDb } = await import("./db/db.js");
  const r = buildIdentity(valueOf(rest, "--db"));
  console.log(`identity registry: ${r.players.toLocaleString()} players processed, ${r.minted.toLocaleString()} newly minted`);
  console.log(`  matched by: ${Object.entries(r.matched).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(", ")}`);
  const db = openDb(valueOf(rest, "--db"));
  const sk = db.prepare("SELECT COUNT(*) c FROM player_identity").get() as { c: number };
  const xr = db.prepare("SELECT source, COUNT(*) c FROM player_xref GROUP BY source ORDER BY source").all() as { source: string; c: number }[];
  console.log(`  registry holds ${sk.c.toLocaleString()} surrogate keys`);
  console.log(`  crosswalk links: ${xr.map((x) => `${x.source} ${x.c.toLocaleString()}`).join(", ")}`);
  db.close();
  if (r.conflicts.length) {
    console.log(`\n  ${r.conflicts.length} REFUSED id links -- one id claimed by two players:`);
    for (const c of r.conflicts.slice(0, 6)) console.log(`    ${c}`);
    console.log(`  Refused rather than moved: reassigning an id silently changes who a stored id points at.`);
  }
}

/**
 * `ff build-staging`
 *
 * Rebuild the staging layer from raw. Cheap and full-rebuild by design -- a staging table that
 * drifts from its sources is worse than one rebuilt on demand.
 */
async function cmdBuildStaging(rest: string[]) {
  const { buildStgPlayer } = await import("./data/stgPlayer.js");
  const { openDb } = await import("./db/db.js");
  const r = buildStgPlayer(valueOf(rest, "--db"));
  console.log(`stg_player: ${r.rows.toLocaleString()} rows`);
  console.log(`  ${r.withGsis.toLocaleString()} carry a trusted gsis_id (the key is player_sk for every row)`);
  console.log(`  ${r.ambiguous.toLocaleString()} flagged ambiguous (name shared with another real player)`);
  console.log(`  ${r.fromBoardOnly} on our board but absent from the crosswalk -- kept, with no ids`);
  const db = openDb(valueOf(rest, "--db"));
  const cov = db.prepare(
    `SELECT COUNT(*) n, SUM(EXISTS(SELECT 1 FROM stg_player s WHERE s.name_key=b.player_id)) matched
     FROM board b WHERE b.season = (SELECT CAST(json_extract(value,'$.season') AS INTEGER) FROM settings WHERE key='config')`,
  ).get() as { n: number; matched: number };
  console.log(`\n  board coverage: ${cov.matched}/${cov.n} current players resolve into staging`);
  const amb = db.prepare(
    `SELECT COUNT(*) c FROM board b JOIN stg_player s ON s.name_key=b.player_id
     WHERE s.ambiguous=1 AND b.season=(SELECT CAST(json_extract(value,'$.season') AS INTEGER) FROM settings WHERE key='config')`,
  ).get() as { c: number };
  console.log(`  of which ${amb.c} carry a name shared with another real player -- the rows where a`);
  console.log(`  name-based join can still silently return the wrong man.`);
  db.close();
}

/**
 * `ff ingest-playerids [--file db_playerids.csv]`
 *
 * Load the cross-source identity crosswalk and backfill player.gsis_id / player.espn_id, which have
 * been empty on every row since the schema was written. Also reports how many names are genuinely
 * ambiguous -- the blast radius of keying this store on normalised names.
 */
async function cmdIngestPlayerIds(rest: string[]) {
  const { ingestPlayerIds, ambiguousNames } = await import("./data/playerIds.js");
  const { openDb } = await import("./db/db.js");
  const r = await ingestPlayerIds({ dbPath: valueOf(rest, "--db"), file: valueOf(rest, "--file") });
  console.log(`read ${r.read.toLocaleString()} -> stored ${r.kept.toLocaleString()} players`);
  console.log(`  with gsis_id ${r.withGsis.toLocaleString()}   with espn_id ${r.withEspn.toLocaleString()}`);
  const db = openDb(valueOf(rest, "--db"));
  const p = db.prepare("SELECT COUNT(*) n, SUM(gsis_id IS NOT NULL) g, SUM(espn_id IS NOT NULL) e FROM player").get() as { n: number; g: number; e: number };
  console.log(`  backfilled player: ${p.g}/${p.n} now have gsis_id, ${p.e}/${p.n} have espn_id`);
  const amb = ambiguousNames(db, 10);
  console.log(`\n  ${r.ambiguous} name keys stand for MORE THAN ONE real player. Top:`);
  for (const a of amb) console.log(`    ${a.name_key.padEnd(22)} ${String(a.names).slice(0, 40).padEnd(41)} ${a.positions}`);
  console.log(`\n  Those are the names where a string join can silently return the wrong man. Joins in`);
  console.log(`  this store still key on name_key -- this table makes the problem enumerable, and`);
  console.log(`  migrating the joins is a separate change.`);
  db.close();
}

/**
 * `ff ingest-ecr [--file <db_fpecr.csv.gz>] [--types ro,rp,wo,wp]`
 *
 * Load the DynastyProcess FantasyPros ECR archive into ranking_history. Downloads by default;
 * `--file` uses a local copy, which is what you want when iterating, since the archive is ~100 MB.
 */
async function cmdIngestEcr(rest: string[]) {
  const { ingestEcrHistory, REDRAFT_TYPES } = await import("./data/ecrHistory.js");
  const file = valueOf(rest, "--file");
  const types = (valueOf(rest, "--types") ?? REDRAFT_TYPES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  console.log(`ingesting ECR history (${file ? `local ${file}` : "downloading ~100MB"}), keeping types: ${types.join(", ")}`);
  const r = await ingestEcrHistory({
    dbPath: valueOf(rest, "--db"), file, types,
    onProgress: (n) => { if (n % 100000 === 0) console.log(`  ${n.toLocaleString()} rows...`); },
  });
  console.log(`read ${r.read.toLocaleString()} rows -> kept ${r.kept.toLocaleString()}`);
  console.log(`  skipped ${r.skippedType.toLocaleString()} (other ranking types), ${r.badRow.toLocaleString()} unparseable`);
  console.log(`  seasons ${r.seasons.join(", ")}   types ${r.types.join(", ")}`);
  if (!r.kept) console.log(`  NOTHING KEPT -- check --types against what the archive actually contains.`);
}

async function cmdHandcuffs(rest: string[]) {
  const { openDb, getConfig } = await import("./db/db.js");
  const { handcuffBoard } = await import("./inseason/handcuff.js");
  const { readFileSync } = await import("node:fs");
  const db = openDb(valueOf(rest, "--db"));
  const season = getConfig(db).season;
  const vm = JSON.parse(readFileSync(dataPath("variance-model.json"), "utf8"));
  const positions = (valueOf(rest, "--pos") ?? "RB").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const weeks = Number(valueOf(rest, "--weeks") ?? 17);

  const rows = db.prepare(
    "SELECT b.row_json, s.depth_order AS depth FROM board b LEFT JOIN player_status s USING(player_id) WHERE b.season = ?",
  ).all(season) as { row_json: string; depth: number | null }[];
  if (!rows.length) { console.log("no board -- run `ff refresh` first"); return; }

  const parsed = rows.map((r) => ({ j: JSON.parse(r.row_json) as Record<string, unknown>, depth: r.depth }));
  // Pool rank per position, from OUR ranking, so the lead's injury tier lines up with how the
  // variance model was fitted (tiers are fractions of the full positional pool, not of a roster).
  const poolSize: Record<string, number> = {};
  const poolRank = new Map<string, number>();
  for (const pos of positions) {
    const list = parsed.filter((p) => p.j.Pos === pos).sort((a, b) => (Number(b.j.ProjPts) || 0) - (Number(a.j.ProjPts) || 0));
    poolSize[pos] = list.length;
    list.forEach((p, i) => poolRank.set(String(p.j.Player), i));
  }
  const entries = parsed.map((p) => ({
    name: String(p.j.Player), pos: String(p.j.Pos), team: String(p.j.Team ?? ""),
    depthOrder: p.depth, projPts: Number(p.j.ProjPts) || 0,
    rosteredPct: typeof p.j["Rostered%"] === "number" ? (p.j["Rostered%"] as number) : null,
    poolRank: poolRank.get(String(p.j.Player)) ?? null,
  }));

  let board = handcuffBoard(entries, vm, { weeks, positions, poolSize });
  if (rest.includes("--free")) board = board.filter((r) => r.rosteredPct == null || r.rosteredPct < 50);
  if (rest.includes("--json")) { console.log(JSON.stringify(board, null, 2)); return; }

  console.log(`HANDCUFFS -- ${positions.join("/")}, ${weeks} weeks remaining${rest.includes("--free") ? ", rostered <50% only" : ""}`);
  console.log(`what each man scores IF the starter ahead of him misses a week.\n`);
  console.log("  backup                team  d  behind                now    if out    lift   miss%   EV    own%");
  for (const r of board.slice(0, 25)) {
    console.log(
      `  ${(r.name.slice(0, 19) + (r.contested ? "*" : "")).padEnd(20)} ${r.team.padEnd(4)} ${String(r.depthOrder).padStart(1)}  ${r.lead.slice(0, 18).padEnd(18)}` +
      ` ${r.basePerWk.toFixed(1).padStart(5)} ${r.activePerWk.toFixed(1).padStart(8)} ${("+" + r.liftPerWk.toFixed(1)).padStart(7)}` +
      ` ${(100 * r.missProb).toFixed(0).padStart(6)}% ${r.expectedPts.toFixed(0).padStart(5)} ${r.rosteredPct == null ? "   --" : (r.rosteredPct.toFixed(0) + "%").padStart(6)}`,
    );
  }
  console.log(`\n  * = the published depth chart calls him the starter but our projection does not -- a`);
  console.log(`    TIMESHARE, where he may take over with nobody getting hurt at all.`);
  console.log(`  Sorted by IF-OUT. Not by lift or EV: lift = -0.078*base + 0.402*lead, so its coefficient`);
  console.log(`  on the backup's own value is NEGATIVE and ranking on it returns the WORST player behind`);
  console.log(`  the best starter (Vaki 9.6 above Pacheco 12.5 behind the same back). EV inherits that.`);
  console.log(`  Measured on 27 seasons: a depth-2 back gains +4.4 pts/wk when the lead misses (t=14.2,`);
  console.log(`  positive in 79% of 307 cases). The payoff lands near 10.7 pts/wk REGARDLESS of how good`);
  console.log(`  the starter is -- elite handcuffs are cheaper for the same payoff, not richer.`);
  console.log(`  NOT added to the board projection: the rank curve already contains the seasons where`);
  console.log(`  the man ahead got hurt, so adding it there would count the same event twice.`);
}

async function cmdLineup(rest: string[]) {
  const { loadProjections } = await import("./projections.js");
  const { optimalLineup } = await import("./inseason/lineup.js");
  const { isAvailable } = await import("./inseason/espnTeam.js");
  const { SIM_LEAGUE } = await import("./draft/sim.js");
  const { readFileSync } = await import("node:fs");
  const proj = loadProjections(valueOf(rest, "--points") ?? dataPath("points.csv"), valueOf(rest, "--def") ?? dataPath("def-ratings.csv"));
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
  const proj = loadProjections(valueOf(rest, "--points") ?? dataPath("points.csv"), valueOf(rest, "--def") ?? dataPath("def-ratings.csv"));
  if (!name) {
    const top = proj.all().sort((a, b) => b.season - a.season).slice(0, 10);
    console.log("top by season projection:"); for (const p of top) console.log(`  ${p.season.toFixed(0)}  ${p.pos}  ${p.name}`);
    return;
  }
  const p = proj.all().find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!p) { console.log(`no projection for "${name}"`); return; }
  console.log(`${p.name} (${p.pos}): season ${proj.season(p.name).toFixed(0)} | this week${opp ? " vs " + opp : ""} ${proj.week(p.name, p.pos, opp).toFixed(1)} | ROS(10 gms) ${proj.ros(p.name, 10).toFixed(0)}`);
}

// Load OUR value book for a reporting surface (cheatsheet / news / values-check). The STORE wins:
// player_value is what the live bidder reads (`sqlite:player_value(...)`), so a report built from a
// stale data/values.csv could show numbers we will not actually bid. The CSV stays the checked-in
// SEED and the fallback for a clone that has not run `ff refresh` yet -- and when it is used we SAY
// so, rather than letting the two quietly differ. An explicit --values always wins: that is the
// caller deliberately asking for a file.
async function loadValueBook(rest: string[]): Promise<{ name: string; pos: string; value: number }[]> {
  const explicit = valueOf(rest, "--values");
  const season = Number(valueOf(rest, "--season") ?? new Date().getFullYear());
  if (!explicit) {
    try {
      const { openDb } = await import("./db/db.js");
      const { valueBook } = await import("./data/appdata.js");
      const db = openDb(valueOf(rest, "--db"));
      const rows = valueBook(db, season);
      db.close();
      if (rows.length) return rows;
    } catch { /* fall through to the CSV seed */ }
  }
  const { readFileSync } = await import("node:fs");
  const file = explicit ?? dataPath("values.csv");
  if (!explicit) console.log(`  (player_value empty for ${season} -- using the ${file} seed; run 'ff refresh')`);
  return readFileSync(file, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","))
    .map((f) => ({ name: (f[0] ?? "").trim(), pos: (f[1] ?? "").trim().toUpperCase(), value: Number(f[2]) }))
    .filter((v) => v.name && v.value > 0);
}

// Draft-day cheat sheet: a tiered value board + the per-manager nomination drain plan + budget
// guidance, written to a markdown file to keep in front of you DURING the draft. Pure offline --
// operationalizes our values (player_value, the same book the bidder uses) + manager scouting
// (data/league-managers.md, per-install). The agent bids from these same values; the sheet is the
// human-copilot view of the same plan.
async function cmdCheatsheet(rest: string[]) {
  const { writeFileSync } = await import("node:fs");
  const out = valueOf(rest, "--out") ?? dataPath("cheatsheet.md");
  const budget = Number(valueOf(rest, "--budget") ?? 200);
  const { tierize } = await import("./draft/cheatsheet.js");
  const players = await loadValueBook(rest);
  // How many players per position are actually rosterable/relevant (skip the $1 replacement tail).
  const RELEVANT: Record<string, number> = { RB: 40, WR: 45, TE: 18, QB: 18, K: 12, DST: 12 };
  const tiersFor = (pos: string) => tierize(players.filter((p) => p.pos === pos).sort((a, b) => b.value - a.value).slice(0, RELEVANT[pos] ?? 20));
  // Manager nomination plan: owners who overweight a position (share/leagueShare high) are the ones to
  // drain -- nominate that position early. (Human-only edge; sim showed it's not an auto-win, but it's
  // a live read for you -- data/league-managers.md, per-install and gitignored.)
  const { readFileSync } = await import("node:fs");
  let nomPlan = "";
  try {
    const mgr = JSON.parse(readFileSync(dataPath("managers.json"), "utf8")) as { leagueShare: Record<string, number>; profiles: { owner: string; share: Record<string, number> }[] };
    const payers = (pos: string) => mgr.profiles.filter((p) => (p.share[pos] ?? 0) / Math.max(mgr.leagueShare[pos] ?? 0.01, 0.01) > 1.25).map((p) => p.owner);
    const lines = ["QB", "TE"].map((pos) => { const who = payers(pos); return who.length ? `- **Nominate a top ${pos} early** to drain: ${who.join(", ")}` : ""; }).filter(Boolean);
    nomPlan = lines.join("\n");
  } catch { nomPlan = "_(run analyze.mjs to build data/managers.json for the nomination plan)_"; }

  const POS = ["RB", "WR", "TE", "QB", "K", "DST"];
  const fmtTier = (t: { name: string; value: number }[], i: number) => `  T${i + 1} ($${t[0].value}-${t[t.length - 1].value}): ` + t.map((p) => `${p.name} $${p.value}`).join(", ");
  // Quote the levers the ENGINE will actually use, never a hardcoded pair -- this sheet is what you
  // read during the draft, and it previously advertised reserve 15 / max-share 0.35 (a cap of $70)
  // while the shipped posture was reserve 4 / max-share 0.25 (a cap of $50).
  const { openDb, getConfig } = await import("./db/db.js");
  const cdb = openDb(valueOf(rest, "--db")); const lv = getConfig(cdb).levers; cdb.close();
  const shareCap = Math.round(budget * lv.maxShare);
  let md = `# Draft-day cheat sheet\n\nGenerated from player_value -- the same book the agent bids from (VOR->auction $, $${budget} budget). This is your live copilot view of that plan.\n\n`;
  md += `## Budget plan (shipped posture -- aggr ${lv.aggr} / reserve ${lv.starterReserve} / max-share ${lv.maxShare})\nSpread the budget for a DEEP roster of solid starters, not 2-3 studs: any one player is capped at $${shareCap} (max-share) and >=$1/slot is held back so every slot fills. The room is stars-and-scrubs (61% of picks $1-5) and overpays for studs that bust weekly -- let those bidding wars pass and buy the middle where the room is broke. This posture is the backtest winner (~33% titles on 25 seasons; docs/validation.md).\n\n`;
  md += `## Nomination drain plan\n${nomPlan}\n- QB/TE go **cheap once the payers are spent** -- wait them out.\n\n`;
  md += `## Top overall (by value)\n` + players.sort((a, b) => b.value - a.value).slice(0, 15).map((p, i) => `${i + 1}. ${p.name} (${p.pos}) **$${p.value}**`).join("\n") + "\n\n";
  md += `## Tiers by position\n`;
  for (const pos of POS) {
    const tiers = tiersFor(pos);
    if (!tiers.length) continue;
    md += `\n### ${pos}\n` + tiers.slice(0, 6).map((t, i) => fmtTier(t, i)).join("\n") + "\n";
  }
  writeFileSync(out, md, "utf8");
  console.log(`wrote cheat sheet -> ${out}`);
  for (const pos of ["RB", "WR", "TE", "QB"]) { const t = tiersFor(pos); console.log(`${pos}: ${t.length} tiers; T1 = ${t[0]?.map((p) => p.name).join(", ")}`); }
  if (nomPlan) console.log("\nNomination drain plan:\n" + nomPlan);
}

// Offline join-quality check (finding #5): how many of a past season's DRAFTED players (from the
// recap) does our value table resolve via nameKey? Reports exact-name matches, nameKey matches,
// the players nameKey RESCUED (spelling drift the old exact lookup missed), true "fuzzy-only"
// misses (an entry for the SAME entity exists in our table but nameKey failed to bridge it -> a
// normalizer bug, target 0), and genuinely-absent players (rookies / outside top-N -- expected,
// listed with --list-absent). Reuses the REAL nameKey so the check can't drift from production.
async function cmdValuesCheck(rest: string[]) {
  const { readFileSync } = await import("node:fs");
  const { nameKey, dstAliasKey } = await import("./draft/values.js");
  const recapFile = valueOf(rest, "--recap") ?? dataPath("recaps.json");
  const season = Number(valueOf(rest, "--season") ?? new Date().getFullYear() - 1);
  const topN = Number(valueOf(rest, "--top") ?? 150);
  // Check the book the BIDDER uses. Checking the CSV instead would let a name-normalizer bug pass
  // here and still bite live, which is the whole point of this command.
  const vals = (await loadValueBook(rest)).sort((a, b) => b.value - a.value).slice(0, topN);
  const keySet = new Set(vals.map((v) => nameKey(v.name)));
  const displaySet = new Set(vals.map((v) => v.name));
  // surname / team nickname = the LAST word after removing suffix + d/st tokens (so "Tyrone Tracy
  // Jr." -> "tracy", not "" from the "Jr." token; "Broncos D/ST" -> "broncos").
  const lastTok = (s: string) => {
    const toks = s.toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b/g, " ").replace(/\bd\/?st\b/g, " ").replace(/[^a-z ]/g, " ").trim().split(/\s+/);
    return toks[toks.length - 1] ?? "";
  };
  const firstInit = (s: string) => (s.trim()[0] ?? "").toLowerCase();
  // Entity signatures present in our table, per position: DST keyed by nickname, players by
  // first-initial + surname. Used to decide "same entity we have but nameKey missed".
  const sigSet = new Set(vals.map((v) => v.pos === "DST" ? `DST|${lastTok(v.name)}` : `${v.pos}|${firstInit(v.name)}|${lastTok(v.name)}`));
  const recaps = JSON.parse(readFileSync(recapFile, "utf8")) as { season: number; picks: { player: string; pos: string; price: number }[] }[];
  const picks = recaps.filter((t) => t.season === season).flatMap((t) => t.picks);
  const norm = (p: string) => p.toUpperCase().replace("/", "") === "DST" ? "DST" : p.toUpperCase();
  let exact = 0, keyM = 0;
  const rescued: string[] = [], absent: string[] = [], fuzzy: string[] = [];
  for (const pk of picks) {
    const pos = norm(pk.pos);
    const isExact = displaySet.has(pk.player);
    // Mirror production's lookup exactly: the live strategy resolves a DST nickname through the
    // alias map (Step 9a), so this check must too -- otherwise every defense lands in "absent" and
    // the guard buries the very miss it exists to surface (F3).
    const alias = pos === "DST" ? dstAliasKey(pk.player) : null;
    const isKey = keySet.has(nameKey(pk.player)) || (alias != null && keySet.has(alias));
    if (isExact) exact++;
    if (isKey) { keyM++; if (!isExact) rescued.push(`${pk.player} (${pos})`); }
    else {
      const sig = pos === "DST" ? `DST|${lastTok(pk.player)}` : `${pos}|${firstInit(pk.player)}|${lastTok(pk.player)}`;
      (sigSet.has(sig) ? fuzzy : absent).push(`${pk.player} (${pos})`);
    }
  }
  console.log(`VALUES-CHECK ${valueOf(rest, "--values") ?? "player_value"} top-${topN} vs ${season} recap (${picks.length} drafted)`);
  console.log(`  exact-name matches: ${exact}  |  nameKey matches: ${keyM}  |  rescued by nameKey: ${rescued.length}${rescued.length ? " (" + rescued.join(", ") + ")" : ""}`);
  console.log(`  FUZZY-ONLY misses (our table has the entity, nameKey failed): ${fuzzy.length}${fuzzy.length ? " -- " + fuzzy.join(", ") : ""}`);
  console.log(`  absent (rookies / outside top-${topN}, expected): ${absent.length}`);
  if (rest.includes("--list-absent")) console.log("   " + absent.join(", "));
  if (fuzzy.length) process.exitCode = 1;
}

// Draft-day NEWS view (Layer 2 tailoring): consume the GENERAL league-neutral feed
// data/player-news.csv (built by `ff ingest-source news` -- src/data/news.ts: injuries + RSS
// headlines + Sleeper trending), join it to OUR value table via nameKey, and surface the draftable
// players whose news the consensus rank may not fully price. Read-only; it does NOT change values.
async function cmdNews(rest: string[]) {
  const { readFileSync, existsSync } = await import("node:fs");
  const { nameKey } = await import("./draft/values.js");
  const { classifyNews } = await import("./news.js");
  const newsFile = valueOf(rest, "--news") ?? dataPath("player-news.csv");
  const minVal = Number(valueOf(rest, "--min") ?? 3); // skip the $1-2 replacement tail
  const showHeadlines = !rest.includes("--no-headlines");
  if (!existsSync(newsFile)) {
    console.log(`no ${newsFile} -- build it first:\n  npm run ff -- ingest-source news`);
    return;
  }
  // OUR values keyed by nameKey (so ESPN/nflverse spelling drift resolves the same as the bidder),
  // read from player_value so the digest ranks players by what we will actually bid.
  const val = new Map<string, { value: number; pos: string; name: string }>();
  for (const r of await loadValueBook(rest)) val.set(nameKey(r.name), { value: r.value, pos: r.pos, name: r.name });
  // Group feed items by OUR player (only those in the value table >= minVal).
  interface Item { category: string; severity: string; detail: string; source: string; asof: string; }
  const byPlayer = new Map<string, { v: { value: number; pos: string; name: string }; items: Item[] }>();
  for (const l of readFileSync(newsFile, "utf8").trim().split(/\r?\n/).slice(1)) {
    const [player, , , category, severity, detail, source, asof] = l.split(",");
    const ours = val.get(nameKey(player || "")); if (!ours || ours.value < minVal) continue;
    const g = byPlayer.get(ours.name) ?? { v: ours, items: [] };
    g.items.push({ category, severity, detail, source, asof }); byPlayer.set(ours.name, g);
  }
  const rank: Record<string, number> = { AVOID: 3, WATCH: 2, BURIED: 1, "": 0 };
  const isInfo = (it: Item) => it.category === "headline" || it.category === "trending";
  const entries = [...byPlayer.values()].map((g) => {
    let flag = "", flagItem: Item | undefined;
    for (const it of g.items) { const f = classifyNews(it.category, it.severity); if ((rank[f] ?? 0) > (rank[flag] ?? 0)) { flag = f; flagItem = it; } }
    // one info line per source, newest wins, headlines before trending
    const info = g.items.filter(isInfo).sort((a, b) => (a.category === b.category ? 0 : a.category === "headline" ? -1 : 1));
    return { v: g.v, flag, flagItem, info };
  }).filter((e) => e.flag || e.info.length);
  entries.sort((a, b) => (rank[b.flag] - rank[a.flag]) || (b.v.value - a.v.value));
  console.log(`NEWS -- ${entries.length} of your draftable players (>= $${minVal}) have news [${newsFile}]:\n`);
  for (const e of entries) {
    console.log(`  $${String(e.v.value).padStart(3)}  ${e.v.name.padEnd(24)} ${e.v.pos.padEnd(3)} ${e.flag}${e.flagItem ? "  " + e.flagItem.detail : ""}`);
    if (showHeadlines) for (const h of e.info.slice(0, 3)) console.log(`         - ${h.detail} [${h.source} ${h.asof}]`);
  }
  const c = (f: string) => entries.filter((e) => e.flag === f).length;
  console.log(`\n  ${c("AVOID")} AVOID, ${c("WATCH")} WATCH, ${c("BURIED")} buried, ${entries.filter((e) => e.info.length).length} with headlines/buzz. Read-only draft flag -- cross-check before you bid.`);
}

async function cmdValues(rest: string[]) {
  const { computeValues, resolveValueLeague } = await import("./draft/values.js");
  const { openDb, getConfig } = await import("./db/db.js");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const src = valueOf(rest, "--points") ?? dataPath("points.csv");
  const out = valueOf(rest, "--out") ?? dataPath("values.csv");
  const [, ...lines] = readFileSync(src, "utf8").trim().split(/\r?\n/);
  const points = lines.map((l) => { const f = l.split(","); return { name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) }; }).filter((p) => p.name && p.points);
  // config-driven so values.csv matches the board (same league shape + K/DST cap)
  const db = openDb(valueOf(rest, "--db")); const cfg = getConfig(db); db.close();
  const vals = computeValues(points, resolveValueLeague(cfg), cfg.levers.maxKDst);
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
  const points = readCsv(valueOf(rest, "--points") ?? dataPath("points.csv")).map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) })).filter((p) => p.name && p.points);
  const ourValues = new Map<string, number>();
  for (const f of readCsv(valueOf(rest, "--values") ?? dataPath("values.csv"))) ourValues.set(f[0].trim(), Number(f[2]));
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
  const { runSim, leagueFromConfig } = await import("./draft/sim.js");
  const { openDb, getConfig } = await import("./db/db.js");
  const { readFileSync } = await import("node:fs");
  const readCsv = (p: string) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
  const pointsFile = valueOf(rest, "--points") ?? dataPath("points.csv");
  const valuesFile = valueOf(rest, "--values") ?? dataPath("values.csv");
  const n = Number(valueOf(rest, "--n") ?? 100);
  const points = readCsv(pointsFile).map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) })).filter((p) => p.name && p.points);
  const ourValues = new Map<string, number>();
  for (const f of readCsv(valuesFile)) ourValues.set(f[0].trim(), Number(f[2]));
  // league shape + bidding levers come from the SYNCED config (per league); CLI flags still override
  const db = openDb(valueOf(rest, "--db")); const conf = getConfig(db); db.close();
  const lg = leagueFromConfig(conf); const lv = conf.levers;
  const cfg = {
    values: Object.fromEntries(ourValues),
    starterReserve: Number(valueOf(rest, "--starter-reserve") ?? lv.starterReserve),
    benchReserve: Number(valueOf(rest, "--bench-reserve") ?? lv.benchReserve),
    premium: Number(valueOf(rest, "--premium") ?? lv.premium),
    aggr: Number(valueOf(rest, "--aggr") ?? lv.aggr),
    maxShare: Number(valueOf(rest, "--max-share") ?? lv.maxShare),
    maxKDst: Number(valueOf(rest, "--max-kdst") ?? lv.maxKDst),
    benchDiscount: Number(valueOf(rest, "--bench-discount") ?? lv.benchDiscount),
    posMult: { QB: lv.multQB, RB: lv.multRB, WR: lv.multWR, TE: lv.multTE, ...parsePosMult(valueOf(rest, "--pos-mult")) },
  };
  let sumPts = 0, sumRank = 0, sumField = 0, top1 = 0, top3 = 0, sumTop3Spend = 0;
  for (let s = 0; s < n; s++) {
    const r = runSim(points, ourValues, cfg, s + 1, lg);
    sumPts += r.ourPoints; sumRank += r.ourRank; sumField += r.fieldMean; sumTop3Spend += r.ourSpentTop3;
    if (r.ourRank === 1) top1++; if (r.ourRank <= 3) top3++;
  }
  console.log(`SIM (${n} drafts) ${lg.teams}-team $${lg.budget} ${conf.scoring} | reserve=${cfg.starterReserve} maxShare=${cfg.maxShare} premium=${cfg.premium}`);
  console.log(`  our starting pts: ${(sumPts / n).toFixed(0)}  |  field avg: ${(sumField / n).toFixed(0)}  |  edge: ${((sumPts / n) - (sumField / n)).toFixed(0)}`);
  console.log(`  avg finish: ${(sumRank / n).toFixed(2)} of ${lg.teams}  |  1st: ${((top1 / n) * 100).toFixed(0)}%  |  top-3: ${((top3 / n) * 100).toFixed(0)}%  |  $ on top3 players: ${(sumTop3Spend / n).toFixed(0)}`);
}

// Sync all teams' rosters for the active league -> ownership overlay (who owns each player). Read
// through the app's logged-in ESPN session. Empty pre-draft; populates once the league drafts.
async function cmdSyncRosters(rest: string[]) {
  const { chromium } = await import("playwright-core");
  const { openDb, nowIso } = await import("./db/db.js");
  const { nameKey, dstAliasKey } = await import("./draft/values.js");
  const port = valueOf(rest, "--port") ?? process.env.FF_CDP_PORT ?? "9223";
  const db = openDb(valueOf(rest, "--db"));
  const lg = db.prepare("SELECT league_id, season FROM league ORDER BY last_synced_at DESC LIMIT 1").get() as { league_id: string; season: number } | undefined;
  if (!lg) { db.close(); console.log("no league synced -- run league_sync first"); return; }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
  if (!browser) { db.close(); console.log("app not running -- open the desktop app (its logged-in session is needed)"); return; }
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file://"));
  if (!page) { db.close(); await browser.close(); console.log("app renderer not found"); return; }
  const wvEval = (js: string): Promise<string> => page.evaluate(async (code) => { const wv = document.getElementById("espnview") as any; if (!wv?.executeJavaScript) return ""; try { return await wv.executeJavaScript(code); } catch (e: any) { return "ERR:" + (e?.message ?? e); } }, js);
  const cur = await wvEval("location.href");
  if (!/fantasy\.espn\.com/.test(cur)) { await page.evaluate(() => { const wv = document.getElementById("espnview") as any; if (wv?.loadURL) wv.loadURL("https://fantasy.espn.com/football/"); }); await page.waitForTimeout(4000); }
  const ESPN_SLOT: Record<number, string> = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "DST", 17: "K", 20: "BE", 21: "IR", 23: "FLEX" };
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${lg.season}/segments/0/leagues/${lg.league_id}?view=mRoster&view=mTeam`;
  const raw = await wvEval(`fetch(${JSON.stringify(url)},{credentials:'include'}).then(function(r){return r.ok?r.text():('HTTP '+r.status)}).catch(function(e){return 'ERR '+e.message})`);
  await browser.close();
  let j: any; try { j = JSON.parse(raw); } catch { db.close(); console.log(`could not read rosters: ${raw?.slice(0, 60)}`); return; }
  const memberName = new Map<string, string>((j.members ?? []).map((m: any) => [m.id, m.displayName || m.firstName || m.id]));
  const up = db.prepare("INSERT OR REPLACE INTO ownership (league_id, player_id, owner, team_abbrev, slot, team_id, updated_at) VALUES (@lid,@pid,@own,@abr,@slot,@tid,@now)");
  const now = nowIso(); let n = 0, teams = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM ownership WHERE league_id=?").run(lg.league_id);
    for (const t of j.teams ?? []) {
      const owner = memberName.get((t.owners ?? [])[0]) || `${t.location ?? ""} ${t.nickname ?? ""}`.trim() || `Team ${t.id}`;
      const abbr = t.abbrev || `T${t.id}`;
      const entries = t.roster?.entries ?? []; if (entries.length) teams++;
      for (const e of entries) {
        const p = e.playerPoolEntry?.player ?? {};
        let k = nameKey(p.fullName ?? "");
        if (!k) continue;
        // ESPN names a defense by its nickname ("Packers D/ST" -> "packers") while every table we
        // join against keys it by abbreviation ("GB D/ST" -> "gb"). Written raw, the row matches
        // nothing downstream and the roster silently comes up one starter short. Gated on ESPN's own
        // position id rather than the lineup slot, because a benched defense sits in a BE slot.
        if (p.defaultPositionId === 16) k = dstAliasKey(k) ?? k;
        up.run({ lid: lg.league_id, pid: k, own: owner, abr: abbr, slot: ESPN_SLOT[e.lineupSlotId] ?? "", tid: String(t.id ?? ""), now });
        n++;
      }
    }
  })();
  db.close();
  console.log(`ownership synced: ${n} rostered players across ${teams} teams (league ${lg.league_id})`);
}

// Materialize ONE data source (asset) + its downstream (project/assemble). Powers the DAG view's
// per-node update.
async function cmdIngestSource(rest: string[]) {
  const { ingestOne } = await import("./data/ingest.js");
  const id = rest.find((a) => !a.startsWith("--")) ?? "";
  if (!id) { console.log("usage: ff ingest-source <id>"); return; }
  const t0 = Date.now();
  const r = await ingestOne(valueOf(rest, "--db"), id);
  console.log(`materialized ${id}: ${r.rows} rows + rebuilt board (${Date.now() - t0}ms)`);
}

// Rebuild the multi-season backtest history scored under the LEAGUE's scoring model (so the
// championship backtest validates the strategy on the same ruleset the league actually uses).
async function cmdBuildHistory(rest: string[]) {
  const { buildHistory } = await import("./data/history.js");
  const { openDb, getConfig } = await import("./db/db.js");
  const range = (valueOf(rest, "--seasons") ?? `2014-${new Date().getFullYear() - 1}`).split("-").map(Number);
  const [lo, hi] = [range[0], range[1] ?? range[0]];
  const seasons: number[] = []; for (let y = lo; y <= hi; y++) seasons.push(y);
  const db = openDb(valueOf(rest, "--db")); const conf = getConfig(db);
  // IDENTITY IS RESOLVED WHERE THE FILE IS PRODUCED, once, and carried in a `player_sk` column --
  // the same move points.csv already makes. Every fit script downstream has been re-joining these
  // rows on a display name, which is the join that put one man's birth year on another.
  const { buildSkResolver } = await import("./data/skResolve.js");
  const resolver = buildSkResolver(db);
  db.close();
  // Pass the FULL model when the league has synced one; the bare rules form silently means
  // "K/DST from OUR defaults", which is the gap this closes.
  const { DEFAULT_LEAGUE_SCORING } = await import("./draft/scoring.js");
  const c = conf as unknown as { kicker?: unknown; defense?: unknown };
  const model = { ...DEFAULT_LEAGUE_SCORING(), rules: conf.scoring_rules,
    ...(c.kicker ? { kicker: c.kicker as never } : {}), ...(c.defense ? { defense: c.defense as never } : {}) };
  const synced = c.kicker && c.defense ? "league-synced" : "DEFAULTS (league has not synced K/DST scoring)";
  console.log(`building history for ${seasons.length} seasons under ${conf.scoring} scoring (rec ${conf.scoring_rules.rec}/pt); K/DST rules: ${synced}...`);
  const r = await buildHistory(seasons, model, resolver);
  console.log(`wrote history-points (${r.points} rows) + history-weekly (${r.weekly} rows) for ${r.seasons.length} seasons: ${r.seasons.join(",")}`);
  const tot = r.resolved + r.unresolved;
  console.log(`  player_sk resolved for ${r.resolved}/${tot} season rows (${((r.resolved / Math.max(1, tot)) * 100).toFixed(1)}%) ` +
    `from ${resolver.staged} staged players; unresolved rows are KEPT and carry an empty key`);
}

// Build per-manager draft tendencies for MY league from its real auction history (prior seasons),
// read through the app's logged-in ESPN session. Config-driven: works for any league. Writes
// managers.json (the sim's bot field). Needs the desktop app open (for the authenticated session).
async function cmdScrapeLeague(rest: string[]) {
  const { chromium } = await import("playwright-core");
  const { openDb, getConfig } = await import("./db/db.js");
  const { buildManagerProfiles } = await import("./draft/scout.js");
  type Recap = import("./draft/scout.js").Recap;
  const { writeFileSync } = await import("node:fs");
  const port = valueOf(rest, "--port") ?? process.env.FF_CDP_PORT ?? "9223";
  const db = openDb(valueOf(rest, "--db")); const conf = getConfig(db);
  const lgRow = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get() as { league_id: string } | undefined;
  db.close();
  if (!lgRow) { console.log("no league synced -- run league_sync (or discover_leagues) first"); return; }
  const leagueId = lgRow.league_id;
  const years = Number(valueOf(rest, "--years") ?? 4);
  const seasons: number[] = []; for (let y = conf.season - years; y < conf.season; y++) seasons.push(y); // prior N seasons
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
  if (!browser) { console.log("app not running -- open the desktop app (its logged-in session is needed)"); return; }
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file://"));
  if (!page) { console.log("app renderer not found"); await browser.close(); return; }
  const wvEval = (js: string): Promise<string> => page.evaluate(async (code) => { const wv = document.getElementById("espnview") as any; if (!wv?.executeJavaScript) return ""; try { return await wv.executeJavaScript(code); } catch (e: any) { return "ERR:" + (e?.message ?? e); } }, js);
  const cur = await wvEval("location.href");
  if (!/fantasy\.espn\.com/.test(cur)) { await page.evaluate(() => { const w = window as any; if (w.setView) w.setView("live"); const wv = document.getElementById("espnview") as any; if (wv?.loadURL) wv.loadURL("https://fantasy.espn.com/football/"); }); await page.waitForTimeout(4000); }
  const SLOT_POS: Record<number, string> = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "DST", 17: "K" };
  const ESPN_POS: Record<number, string> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };
  // ESPN playerId -> position, from the public player pools (fetched Node-side, no auth). In an auction
  // most picks are slotted to bench, so lineupSlotId alone can't give position -- this is the real map.
  const posMap = new Map<number, string>();
  const poolFilter = JSON.stringify({ players: { limit: 1500, sortDraftRanks: { sortPriority: 1, sortAsc: true, value: "STANDARD" } } });
  for (const yr of [...seasons, conf.season]) {
    try {
      const res = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${yr}/segments/0/leaguedefaults/3?view=kona_player_info`, { headers: { "x-fantasy-filter": poolFilter } });
      if (!res.ok) continue;
      const data = await res.json() as { players?: { player?: { id?: number; defaultPositionId?: number } }[] };
      for (const pe of data.players ?? []) { const pl = pe.player ?? {}; if (pl.id != null && !posMap.has(pl.id)) { const pos = ESPN_POS[pl.defaultPositionId ?? -1]; if (pos) posMap.set(pl.id, pos); } }
    } catch { /* skip a season's pool */ }
  }
  console.log(`scraping league ${leagueId} draft history for seasons ${seasons.join(", ")} (${posMap.size} players position-mapped)...`);
  const recaps: Recap[] = [];
  for (const yr of seasons) {
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${yr}/segments/0/leagues/${leagueId}?view=mDraftDetail&view=mTeam`;
    const raw = await wvEval(`fetch(${JSON.stringify(url)},{credentials:'include'}).then(function(r){return r.ok?r.text():('HTTP '+r.status)}).catch(function(e){return 'ERR '+e.message})`);
    if (!raw || raw.startsWith("HTTP") || raw.startsWith("ERR")) { console.log(`  ${yr}: ${raw || "no data"}`); continue; }
    let j: any; try { j = JSON.parse(raw); } catch { console.log(`  ${yr}: parse error`); continue; }
    const picks = j.draftDetail?.picks ?? [];
    if (!j.draftDetail?.drafted || !picks.length) { console.log(`  ${yr}: no completed draft`); continue; }
    const memberName = new Map<string, string>((j.members ?? []).map((m: any) => [m.id, (m.displayName || m.firstName || m.id)]));
    const teamAbbrev = new Map<number, string>((j.teams ?? []).map((t: any) => [t.id, t.abbrev || ("T" + t.id)]));
    const posById = new Map<number, string>(); // resolve FLEX/bench via any concrete-slot appearance
    for (const p of picks) { const sp = SLOT_POS[p.lineupSlotId]; if (sp && !posById.has(p.playerId)) posById.set(p.playerId, sp); }
    const byMember = new Map<string, { owner: string; teamId: number; picks: { pos: string; price: number }[] }>();
    for (const p of picks) {
      const owner = memberName.get(p.memberId) || `member ${String(p.memberId).slice(0, 8)}`;
      const pos = posMap.get(p.playerId) ?? SLOT_POS[p.lineupSlotId] ?? posById.get(p.playerId) ?? "FLEX";
      const rec = byMember.get(p.memberId) ?? byMember.set(p.memberId, { owner, teamId: p.teamId, picks: [] }).get(p.memberId)!;
      rec.picks.push({ pos, price: p.bidAmount || 1 });
    }
    for (const v of byMember.values()) recaps.push({ season: yr, owner: v.owner, abbrev: teamAbbrev.get(v.teamId) || v.owner.slice(0, 4), picks: v.picks });
    console.log(`  ${yr}: ${picks.length} picks, ${byMember.size} owners`);
  }
  await browser.close();
  if (!recaps.length) { console.log("no draft history found (league may predate these seasons, or be snake not auction)"); return; }
  const data = buildManagerProfiles(recaps);
  writeFileSync(dataPath("managers.json"), JSON.stringify(data), "utf8");
  console.log(`wrote ${data.profiles.length} owner profiles from ${recaps.length} team-seasons -> ${dataPath("managers.json")}`);
  console.log("league spend mix: " + Object.entries(data.leagueShare).map(([p, s]) => `${p} ${Math.round(Number(s) * 100)}%`).join(" "));
}

// Championship backtest: draft with a past season's values, play a real H2H season + playoffs on
// that season's ACTUAL weekly results, report OUR championship / playoff rate. The trustworthy
// objective for "optimize championship wins".
async function cmdBacktest(rest: string[]) {
  const { runBacktest } = await import("./draft/backtest.js");
  const { leagueFromConfig } = await import("./draft/sim.js");
  const { openDb, getConfig } = await import("./db/db.js");
  const { readFileSync } = await import("node:fs");
  const rows = (p: string) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
  const nPerSeason = Number(valueOf(rest, "--n") ?? 300);
  // league shape, bidding levers, and playoff format all come from the SYNCED config (per league)
  const db = openDb(valueOf(rest, "--db")); const conf = getConfig(db); db.close();
  const lg = leagueFromConfig(conf); const lv = conf.levers;
  // Levers resolve in one place: registry defaults <- STORED config <- CLI overrides. Because
  // `leverOverridesFromArgv` walks the registry rather than a hand-written list of flags, a lever
  // added to LEVER_SPECS is measurable by the arbiter immediately -- the gap that left `maxKDst`
  // with no backtest flag at all. Out-of-range requests are clamped LOUDLY, never silently.
  const { applyLevers, leverOverridesFromArgv, leversToV2Config } = await import("./draft/levers.js");
  const lvEff = applyLevers(lv, leverOverridesFromArgv(rest, (k, asked, got) =>
    console.log(`  NOTE: --${k} ${asked} is outside its allowed range; clamped to ${got}`)));
  const fromLevers = leversToV2Config(lvEff);
  const cfg = {
    values: {} as Record<string, number>,
    ...fromLevers,
    posMult: { ...fromLevers.posMult, ...parsePosMult(valueOf(rest, "--pos-mult")) },
    inflation: rest.includes("--inflation"), scarcity: rest.includes("--scarcity"),
    posInflation: rest.includes("--pos-inflation"),
    budgetPressure: rest.includes("--budget-pressure"),
    maxPressure: Number(valueOf(rest, "--max-pressure") ?? 1.6),
    maxAtPos: parsePosMult(valueOf(rest, "--max-at-pos")),
  };
  // Load all seasons from the combined history files, filter to --seasons range (default all).
  const range = (valueOf(rest, "--seasons") ?? `2014-${new Date().getFullYear() - 1}`).split("-").map(Number);
  const [lo, hi] = [range[0], range[1] ?? range[0]];
  const pts = new Map<number, { name: string; pos: string; points: number }[]>();
  for (const f of rows(valueOf(rest, "--points") ?? dataPath("history-points.csv"))) {
    const yr = Number(f[0]); if (yr < lo || yr > hi) continue;
    (pts.get(yr) ?? pts.set(yr, []).get(yr)!).push({ name: f[1].trim(), pos: f[2].trim().toUpperCase(), points: Number(f[3]) });
  }
  const wk = new Map<number, Map<string, Map<number, number>>>();
  for (const f of rows(valueOf(rest, "--weekly") ?? dataPath("history-weekly.csv"))) {
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
  const injuryLever = valueOf(rest, "--injury-lever") != null ? Number(valueOf(rest, "--injury-lever")) : 0; // discount OUR values by prior-yr availability
  const seasons = [...pts.keys()].sort();
  let champ = 0, playoffs = 0, total = 0;
  const perYear: string[] = [];
  // Whose book do the BOTS bid? Default "vor" reuses computeValues -- our own function -- so the
  // field is a noisy mirror of us. "rank" gives them an independent curve; if an edge survives that,
  // it is not an artifact of self-reference.
  const botBook = (valueOf(rest, "--bot-book") === "rank" ? "rank" : "vor") as "vor" | "rank";
  const homogeneous = rest.includes("--homogeneous"); // all bots = one league-average manager
  // SCHEDULE. A real schedule is the default: standard divisional play (6 in-division + 8 cross)
  // for a 16/4 league, and a plain round-robin otherwise -- both strictly more faithful than the
  // fresh random weekly pairing this replaced, which capped no repeat and erased correlated
  // schedule risk. Measured against the old behaviour on identical seeds it moves the championship
  // rate by +1.0pp, t=0.76 over 11 seasons (95% CI -1.9 to +3.9) -- i.e. not at all, which is the
  // expected result for replacing an unbiased sampler. `--random-schedule` restores the old
  // pairing for comparison; `--divisions N` overrides the division count.
  const divisions = rest.includes("--random-schedule") ? 0 : Number(valueOf(rest, "--divisions") ?? 4);
  // AGE CURVE ON BY DEFAULT, matching the shipped board. projections.ts applies it, so a backtest
  // that skipped it would be validating a system we do not actually run -- the exact mismatch that
  // let the FLEX-baseline and K/DST bugs survive. `--no-age-curve` is the escape hatch for A/B.
  const { ageFactor } = await import("./draft/age.js");
  const { opportunityFactor } = await import("./draft/opportunity.js");
  const fsMod = await import("node:fs");
  const agePath = dataPath("age-curve.json");
  const ageCurve = (!rest.includes("--no-age-curve") && fsMod.existsSync(agePath))
    ? JSON.parse(fsMod.readFileSync(agePath, "utf8"))
    : null;
  const oppPath = dataPath("opportunity-model.json");
  const oppModel = (!rest.includes("--no-opportunity") && fsMod.existsSync(oppPath))
    ? JSON.parse(fsMod.readFileSync(oppPath, "utf8"))
    : null;
  const dumpPath = valueOf(rest, "--dump-trials");
  const dumpRows: string[] = [];
  const { writeFileSync: writeDump } = await import("node:fs");

  // OUR PROJECTION: raw prior-year actuals (default) or the CONDITIONAL CURVE evaluated at each
  // player's prior-year finish rank (`--projection conditional`).
  //
  // The market/bots are UNCHANGED either way -- they keep drafting on prior-year actuals plus noise.
  // That is the point of the comparison: it isolates the effect of OUR book being a conditional
  // expectation while the room's is still an order statistic, which is exactly the live situation.
  //
  // EXPANDING WINDOW, and it is load-bearing. The curve for season Y is fitted on season pairs
  // STRICTLY BEFORE Y. Fitting it on all 25 seasons and then testing on 2010 would let the curve
  // know how 2010 turned out -- the lookahead this whole mode exists to exclude, reintroduced one
  // level up in the model rather than in the data. Seasons with fewer than MIN_PAIRS prior pairs are
  // skipped rather than run on a curve fitted on nothing, which also means the season SET shrinks:
  // the baseline arm must be re-run over the same --seasons range or the trials are not paired.
  //
  // The ECR level correction is likewise restricted to scrapes before Y, and the archive only starts
  // in 2019 -- so early backtest seasons get the prior-rank shape with no level rescale. That is the
  // honest no-lookahead answer (nobody had a FantasyPros archive in 2005), not a degradation.
  //
  // PHASE 2a: THE ARM NOW CALLS THE SHIPPED PROJECTOR. Phase 1 rebuilt the conditional curve here
  // and looked it up inline, which was a second implementation of what projections.ts does -- so
  // the thing being validated and the thing being shipped were two different pieces of code that
  // happened to agree. `--projection artifact` loads data/projection-artifact.json and calls
  // src/model/features.ts:backtestProjection, the same function the board path calls with a
  // different rank basis. `--projection conditional` is kept as an alias so Phase 1's recorded
  // command still runs and still means what it meant.
  const projArg = valueOf(rest, "--projection");
  const projMode = (projArg === "artifact" || projArg === "conditional") ? "artifact" : "actuals";
  // THE SEASON GATE IS KEYED ON THE CURVE, NOT ON THE PAIR COUNT -- and the difference was not
  // academic. Gating on `pairs >= 5` admitted 2005-2010, whose curves came back EMPTY (the per-rank
  // minimum-observation rule needs ~10 pairs before rank 1 has a sample), and an empty curve falls
  // through to raw actuals. Those six seasons therefore ran the BASELINE inside the arm labelled
  // "conditional", and reported themselves as six seasons of exactly zero effect. The tell was that
  // their per-season championship percentages were IDENTICAL to the baseline arm's, to the point --
  // which is not something two different projections do.
  //
  // So the gate asks the question that actually matters: did a usable curve come out at every
  // position the league starts? A season that cannot answer yes is skipped.
  const CURVE_POS_REQUIRED = ["QB", "RB", "WR", "TE"];
  const projByYear = new Map<number, Map<string, number>>();
  if (projMode === "artifact") {
    if (!noLookahead) throw new Error("--projection artifact is only meaningful with --no-lookahead");
    const { loadArtifact } = await import("./model/projector.js");
    const { backtestProjection } = await import("./model/features.js");
    const { readFileSync: rf, existsSync: ex } = await import("node:fs");
    const ap = valueOf(rest, "--artifact") ?? dataPath("projection-artifact.json");
    if (!ex(ap)) throw new Error(`${ap} missing -- build one with \`npm run ff -- build-artifact --curve-only\``);
    const artifact = loadArtifact(JSON.parse(rf(ap, "utf8")));
    const db2 = openDb(valueOf(rest, "--db"));
    const skipped: number[] = [];
    for (const yr of [...pts.keys()].sort()) {
      // THE SEASON GATE IS KEYED ON THE CURVE, and the difference was never academic. Gating on a
      // pair count admitted 2005-2010, whose curves came back EMPTY, and an empty curve falls
      // through to raw actuals -- so six seasons ran the BASELINE inside the arm labelled
      // "conditional" and reported themselves as six seasons of exactly zero effect. Their
      // per-season percentages were IDENTICAL to the baseline's, to the point, which is not
      // something two different projections do.
      const cov = db2.prepare(
        "SELECT pos, MAX(rank) n FROM feat_curve WHERE season = ? AND kind = 'conditional' GROUP BY pos",
      ).all(yr) as { pos: string; n: number }[];
      const have = new Map(cov.map((c) => [c.pos, c.n]));
      if (!CURVE_POS_REQUIRED.every((p) => (have.get(p) ?? 0) >= 24)) { skipped.push(yr); continue; }
      const rows = backtestProjection(db2, yr, artifact);
      if (!rows.length) { skipped.push(yr); continue; }
      projByYear.set(yr, new Map(rows.map((r) => [r.name, r.mean])));
    }
    db2.close();
    console.log(`  --projection ${projArg}: the SHIPPED projector, artifact ${ap}`);
    console.log(`    ${artifact.fittedFrom}; base ${artifact.base}; ` +
      `${artifact.features.length} fitted features; multiplicative [${artifact.multiplicative.join(", ") || "none"}]`);
    console.log(`    usable in ${projByYear.size}/${pts.size} seasons; skipped ${skipped.join(",") || "none"}`);
    // The ECR level correction cannot reach any backtested season: the FantasyPros archive begins in
    // 2020 and rank 1 needs ~5 seasons of it, so a no-lookahead curve for any season through 2024
    // gets the prior-rank SHAPE with no level rescale. The shipped board (2026) gets both halves.
    // Stated here rather than in a footnote because it bounds what this measurement can be read as.
    console.log(`    NOTE: ECR level correction is unavailable before 2025 (archive starts 2020),`);
    console.log(`          so this arm measures the SHAPE half of the conditional curve only.`);
  }

  for (const yr of seasons) {
    const projYr = noLookahead ? yr - 1 : yr; // no-lookahead: our projection = prior season's actuals
    let proj = pts.get(projYr); if (!proj) continue; // skip the first year when no prior exists
    if (projMode === "artifact") {
      const m = projByYear.get(yr);
      if (!m) continue;                              // no usable curve -> not a season this arm can run
      // A player the projector produced no row for keeps his raw prior-year actual, which is the
      // baseline's answer for him. Substituting a zero would delete him from the pool instead, and
      // a pool that differs between arms is not a paired comparison.
      proj = proj.map((r) => ({ ...r, points: m.get(r.name) ?? r.points }));
    }
    // AGE CURVE. Only meaningful in no-lookahead mode, where our projection really IS a projection
    // (prior-season actuals) rather than the season's truth plus noise -- with lookahead there is
    // nothing for an age adjustment to improve. Off by default so the historical numbers stay
    // comparable; --age-curve turns it on and the pair is the measurement.
    //
    // NOT IN THE ARTIFACT ARM: the artifact declares its own multiplicative stage and the projector
    // has already applied it. Applying it again here would square the multiplier -- the exact defect
    // the guard test in test/projector.test.ts fault-injects.
    if (ageCurve && noLookahead && projMode !== "artifact") {
      proj = proj.map((r) => ({ ...r, points: r.points * ageFactor(ageCurve, r.name, r.pos, yr) }));
    }
    // OPPORTUNITY, same rule and for the same reason: it adjusts a PROJECTION, so it is meaningless
    // where the "projection" is the season's own truth. Rank is recomputed from the proj list here
    // rather than taken from the board -- inside the backtest there is no board, and the model's
    // rank buckets must be indexed by the same within-position ordering the live path uses or the
    // "relative to your rank" denominator silently refers to a different rank.
    if (oppModel && noLookahead && projMode !== "artifact") {
      const seen: Record<string, number> = {};
      const ranked = proj.slice().sort((a, b) => b.points - a.points);
      const rankOf = new Map<string, number>();
      for (const r of ranked) { seen[r.pos] = (seen[r.pos] ?? 0) + 1; rankOf.set(r.name, seen[r.pos]); }
      proj = proj.map((r) => ({ ...r, points: r.points * opportunityFactor(oppModel, r.name, r.pos, rankOf.get(r.name) ?? 999, yr) }));
    }
    // availability signal for the injury lever: prior-season games played / the busiest player's games
    const avail = new Map<string, number>();
    const priorWk = wk.get(projYr);
    if (injuryLever && priorWk) { let maxG = 1; for (const w of priorWk.values()) maxG = Math.max(maxG, w.size); for (const [nm, w] of priorWk) avail.set(nm, w.size / maxG); }
    let c = 0;
    for (let s = 0; s < nPerSeason; s++) { const r = runBacktest(proj, wk.get(yr)!, new Map(), cfg, s + 1 + yr * 1000, lg, marketSd, noLookahead ? 0 : ourSd, ourWeeklySd, botWeeklySd, full, waivers, drainNom, greedyNom, conf.playoffTeams, conf.regWeeks, avail, injuryLever, botBook, homogeneous, divisions); if (r.champ) { champ++; c++; } if (r.madePlayoffs) playoffs++; total++;
      // Per-TRIAL dump. The aggregate rate cannot support the statistics this needs: seeds are
      // COMMON RANDOM NUMBERS across configs (seed = s+1+yr*1000 depends only on season+index), so
      // two configs meet the same market noise and the same bot seats. That makes every trial a
      // matched PAIR, and paired tests on those pairs are far more powerful -- and far more honest
      // -- than comparing two aggregate percentages. Also: the unit of GENERALISATION is the season,
      // not the trial, so downstream analysis needs the season label on every row.
      if (dumpPath) dumpRows.push([yr, s + 1 + yr * 1000, r.champ ? 1 : 0, r.madePlayoffs ? 1 : 0, r.wins, r.regPoints].join("\t"));
    }
    perYear.push(`${yr}:${((c / nPerSeason) * 100).toFixed(0)}%`);
  }
  const mode = `${ageCurve && noLookahead ? "age-curve " : ""}${oppModel && noLookahead ? "opportunity " : ""}${full ? "FULL-SYSTEM(real lineup)" : "draft-only"}${waivers ? "+waivers" : ""}${drainNom ? "+drain-nom" : ""}${cfg.inflation ? "+inflation" : ""}${cfg.posInflation ? "+pos-inflation" : ""}${cfg.scarcity ? "+scarcity" : ""}${cfg.budgetPressure ? `+budget-pressure(${cfg.maxPressure})` : ""}${cfg.maxAtPos && Object.keys(cfg.maxAtPos).length ? `+max-at-pos(${JSON.stringify(cfg.maxAtPos)})` : ""}${injuryLever ? `+injury-lever(${injuryLever})` : ""}${projMode === "artifact" ? "+PROJECTOR-ARTIFACT" : ""}${noLookahead ? " no-lookahead(prev-yr proj)" : ""}`;
  console.log(`BACKTEST ${mode}  ${lg.teams}-team $${lg.budget} ${conf.scoring} ${conf.playoffTeams}-team-playoff | reserve=${cfg.starterReserve} maxShare=${cfg.maxShare}  market ${marketSd}${ourSd != null && !noLookahead ? ` ourSd ${ourSd}` : ""}`);
  console.log(`  CHAMPIONSHIPS: ${((champ / total) * 100).toFixed(1)}%  (random ${(100 / lg.teams).toFixed(1)}%)  |  playoffs: ${((playoffs / total) * 100).toFixed(0)}%`);
  if (dumpPath) {
    writeDump(dumpPath, ["season", "seed", "champ", "playoffs", "wins", "regPoints"].join("\t") + "\n" + dumpRows.join("\n") + "\n", "utf8");
    console.log(`  wrote ${dumpRows.length} trial rows -> ${dumpPath}`);
  }
  console.log(`  per season: ${perYear.join("  ")}`);
}

// ONE pipeline for the point-in-time feature tables. See src/features/build.ts for what it replaces.
async function cmdBuildFeatures(rest: string[]) {
  const { buildFeatures } = await import("./features/build.js");
  const range = (valueOf(rest, "--seasons") ?? "1999-2025").split("-").map(Number);
  const [lo, hi] = [range[0], range[1] ?? range[0]];
  const seasons: number[] = []; for (let y = lo; y <= hi; y++) seasons.push(y);
  const t0 = Date.now();
  const r = await buildFeatures({ dbPath: valueOf(rest, "--db"), seasons, weeks: !rest.includes("--no-weeks") });
  console.log(`feat_player_season: ${r.seasonRows} rows over ${r.seasons.length} seasons ` +
    `(${((r.seasonResolved / Math.max(1, r.seasonRows)) * 100).toFixed(1)}% with player_sk)`);
  console.log(`feat_player_week:   ${r.weekRows} rows ` +
    `(${((r.weekResolved / Math.max(1, r.weekRows)) * 100).toFixed(1)}% with player_sk)`);
  console.log(`  season   rows  scored   +ecr  +usage    +age`);
  for (const s of r.perSeason) {
    console.log(`  ${s.season}  ${String(s.rows).padStart(5)}  ${String(s.scored).padStart(6)}  ` +
      `${String(s.withEcr).padStart(5)}  ${String(s.withUsage).padStart(6)}  ${String(s.withAge).padStart(6)}`);
  }
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// One row per real draft pick this league made, with the consensus as it stood. See features/picks.ts.
async function cmdBuildPicks(rest: string[]) {
  const { buildDraftPicks } = await import("./features/picks.js");
  const r = buildDraftPicks({ dbPath: valueOf(rest, "--db"), recapPath: valueOf(rest, "--recap") });
  console.log(`fact_draft_pick: ${r.rows} rows`);
  console.log(`  season  picks  total$   sk%   consensus  as-of`);
  for (const s of r.perSeason) {
    console.log(`  ${s.season}  ${String(s.picks).padStart(5)}  ${String(s.total).padStart(6)}  ` +
      `${((s.resolved / Math.max(1, s.picks)) * 100).toFixed(0).padStart(3)}%  ` +
      `${String(s.withConsensus).padStart(9)}  ${s.asOf ?? "(none)"}`);
  }
  if (r.absent.length) console.log(`  seasons ABSENT from the store: ${r.absent.join(", ")}`);
}

// The honest floor: a projection artifact that IS the point-in-time curve, with the two shipped
// multipliers declared in its multiplicative stage. `--curve-only` is currently the only kind this
// command produces; a trained one comes from tools/train_projection.py.
async function cmdBuildArtifact(rest: string[]) {
  const { buildCurveOnlyArtifact } = await import("./model/build.js");
  const { loadArtifact } = await import("./model/projector.js");
  const { writeFileSync } = await import("node:fs");
  const range = (valueOf(rest, "--seasons") ?? "1999-2025").split("-").map(Number);
  const hold = valueOf(rest, "--holdout-season");
  const out = valueOf(rest, "--out") ?? dataPath("projection-artifact.json");
  const base = (valueOf(rest, "--base") ?? "curve_value_ecr") as "curve_value_prior" | "curve_value_ecr" | "curve_value_orderstat";
  const { artifact, quantiles } = buildCurveOnlyArtifact({
    dbPath: valueOf(rest, "--db"), from: range[0], to: range[1] ?? range[0], base,
    holdoutSeason: hold && hold !== "none" ? Number(hold) : null,
  });
  // Validated through the SHIPPED loader before it is written. An artifact that cannot be loaded is
  // not an artifact, and finding that out at board-build time is finding it out too late.
  loadArtifact(artifact);
  writeFileSync(out, JSON.stringify(artifact, null, 2), "utf8");
  console.log(`wrote ${out} -- curve-only, base ${artifact.base}, ${artifact.seasons.length} seasons` +
    (artifact.holdoutSeason ? `, holding out ${artifact.holdoutSeason}` : ""));
  console.log(`  ratio quantiles of actual/curve (the p10/p50/p90 heads):`);
  for (const [p, q] of Object.entries(quantiles)) {
    console.log(`    ${p.padEnd(4)} n=${String(q.n).padStart(5)}  p10 ${q.p10.toFixed(3)}  p50 ${q.p50.toFixed(3)}  p90 ${q.p90.toFixed(3)}`);
  }
}

async function cmdDumpValues(rest: string[]) {
  const { dumpValues } = await import("./draft/espnAuction.js");
  const out = valueOf(rest, "--out") ?? dataPath("values.espn.csv");
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

// Per-position draft stats: how much supply is gone and the EMPIRICAL inflation (actual $ paid vs our
// book value) at each position -- RB can be inflating while WR deflates. Captured to the draft log.
function positionalStats(picks: { pos: string | null; price: number; name: string }[], universe: { pos: string; value: number; key: string }[], nkey: (s: string) => string) {
  const valByKey = new Map(universe.map((u) => [u.key, u.value]));
  const suppliedByPos: Record<string, number> = {};
  for (const u of universe) suppliedByPos[u.pos] = (suppliedByPos[u.pos] ?? 0) + 1;
  const out: Record<string, { drafted: number; supplyLeft: number; spent: number; bookValue: number; inflation: number | null }> = {};
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    const dr = picks.filter((p) => p.pos === pos);
    const spent = dr.reduce((s, p) => s + p.price, 0);
    const bookValue = dr.reduce((s, p) => s + (valByKey.get(nkey(p.name)) ?? 0), 0);
    out[pos] = { drafted: dr.length, supplyLeft: Math.max(0, (suppliedByPos[pos] ?? 0) - dr.length), spent, bookValue: Math.round(bookValue), inflation: bookValue > 0 ? Math.round((spent / bookValue) * 100) / 100 : null };
  }
  return out;
}

// Full-auto auction engine (MVP): fill a complete legal roster in budget. Bots nominate
// (ESPN auto-nominates on our turn); we bid on any on-block player that fills an open slot,
// up to min(our value / ESPN pre-draft val / floor, ESPN's legal max). ESPN's myMax already
// reserves $1/open slot, so we can never strand a slot -> the done-bar is structurally safe.
/** Refuse to run a second bidding agent in the same seat. Returns a release function.
 *  A lock whose PID is no longer alive is stale (crash/kill) and is taken over. */
async function acquireDraftLock(force: boolean): Promise<() => void> {
  const { existsSync, readFileSync, writeFileSync, unlinkSync } = await import("node:fs");
  const lock = dataPath("auto-draft.lock");
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  if (existsSync(lock) && !force) {
    const prev = Number((readFileSync(lock, "utf8").match(/pid=(\d+)/) ?? [])[1] ?? 0);
    if (prev && prev !== process.pid && alive(prev)) {
      console.error(`another auto-draft is already running (pid ${prev}). Two agents in one seat bid`);
      console.error(`against each other. Stop it first, or pass --force-lock if you know it is dead.`);
      console.error(`Windows: taskkill /F /T /PID ${prev}`);
      process.exit(2);
    }
    console.log(`[auto-draft] reclaiming stale lock (pid ${prev || "?"} not running)`);
  }
  writeFileSync(lock, `pid=${process.pid} started=${new Date().toISOString()}\n`, "utf8");
  let released = false;
  return () => { if (released) return; released = true; try { unlinkSync(lock); } catch { /* already gone */ } };
}

async function cmdAutoDraft(rest: string[]) {
  // SINGLE INSTANCE. Two agents in one seat bid against each other, re-nominate the same player,
  // and produce a draft nobody can interpret -- and it is easy to end up there, because killing the
  // shell that launched an agent does NOT kill the node process tree on Windows. Observed
  // 2026-09-04: three concurrent auto-drafts in one practice room. Refuse to start unless the
  // holder is genuinely gone (stale lock from a crash is reclaimed).
  const releaseLock = await acquireDraftLock(rest.includes("--force-lock"));
  process.on("exit", releaseLock);
  process.on("SIGINT", () => { releaseLock(); process.exit(130); });
  process.on("SIGTERM", () => { releaseLock(); process.exit(143); });
  const { readBlock, readRoster, hasOpenSlotFor, quickBid, jumpBid, readBoard, readLeague, nominate, readTurn } = await import("./draft/espnAuction.js");
  const { loadRankings } = await import("./data/rankings.js");
  const { makeV2Strategy, legalCap, jumpTarget } = await import("./draft/strategy.js");
  const { SIM_LEAGUE } = await import("./draft/sim.js");
  // A full 16-team auction runs ~25-30 min; at ~1.4s/tick + read overhead that's ~1000+ ticks, so the
  // cap must comfortably outlast the whole draft (it exits early on a full roster or a stall).
  // How long to keep bidding. Expressed in TIME, not ticks: `--rounds 1600` used to be the default
  // and it silently ended the 2026-09-06 real draft at 3/12 filled -- 1600 x 1.4s is ~37 minutes,
  // and a 16-team auction runs far longer. It printed a normal `final:` line and exited 0, which is
  // indistinguishable from a completed draft unless you read the roster count. Every mock finished
  // inside 1600 ticks, so the ceiling was never hit before the one draft that mattered.
  //
  // The real stop conditions are the roster filling (`DONE`) and the stall guard; this is only a
  // backstop against an unattended process running forever. 6h covers any draft.
  const tick = Number(valueOf(rest, "--tick") ?? 1400); // poll cadence (ms); lower for a fast bid timer
  const maxHours = Number(valueOf(rest, "--max-hours") ?? 6);
  const rounds = valueOf(rest, "--rounds")
    ? Number(valueOf(rest, "--rounds"))
    : Math.ceil((maxHours * 3600 * 1000) / tick);
  const jump = Number(valueOf(rest, "--jump") ?? 5);   // fixed jump-bid step (Step 8); 0 = +1 bids only
  // Value source (the pluggable knob). Preference: the single SQLite store (player_value) ->
  // data/values.csv -> ESPN's on-screen pre-draft value. Pass an explicit --csv (incl. --csv "")
  // to bypass the DB and force the CSV/ESPN path.
  const { existsSync } = await import("node:fs");
  const { nameKey } = await import("./draft/values.js");
  const csvArg = valueOf(rest, "--csv");
  const csvExplicit = csvArg !== undefined;
  let csv = csvArg;
  if (csv === undefined) csv = existsSync(dataPath("values.csv")) ? dataPath("values.csv") : undefined;

  // OUR value overrides (nameKey -> $) + pos. Both sides of the join are keyed by nameKey so ESPN
  // spelling drift (suffixes, "D/ST") does not silently miss (finding #5). Crucially, when loading
  // from the DB we re-derive the key with the TS nameKey FROM THE STORED NAME -- never trust the
  // stored player_id (Python's nkey) to equal the TS nameKey, or a divergence misses at draft time.
  const values: Record<string, number> = {};
  const posByName = new Map<string, string>();
  let valueSource = "espn-fallback";
  if (!csvExplicit) {
    try {
      const { openDb } = await import("./db/db.js");
      const db = openDb(valueOf(rest, "--db"));
      const season = Number(valueOf(rest, "--season") ?? new Date().getFullYear());
      const vrows = db
        .prepare("SELECT p.name AS name, p.position AS pos, pv.our_value AS v FROM player_value pv JOIN player p USING(player_id) WHERE pv.season = ?")
        .all(season) as { name: string; pos: string; v: number }[];
      db.close();
      for (const r of vrows) {
        const k = nameKey(r.name);
        posByName.set(k, r.pos);
        if (typeof r.v === "number" && !Number.isNaN(r.v)) values[k] = r.v;
      }
      if (vrows.length) valueSource = `sqlite:player_value(${vrows.length}, season ${season})`;
    } catch { /* fall through to CSV */ }
  }
  if (Object.keys(values).length === 0 && csv) {
    try {
      for (const p of loadRankings(csv)) {
        posByName.set(nameKey(p.name), p.pos);
        const v = (p as unknown as { value?: number }).value;
        if (typeof v === "number" && !Number.isNaN(v)) values[nameKey(p.name)] = v;
      }
      valueSource = `csv:${csv}`;
    } catch { /* optional */ }
  }
  console.log(`[auto-draft] value source: ${valueSource} (${Object.keys(values).length} priced)`);
  const { openDb: openCfgDb, getConfig: getCfg } = await import("./db/db.js");
  const { leversToV2Config } = await import("./draft/levers.js");
  // Bidding levers come from the configured levers, RE-READ each tick (see refreshStrategy below).
  // They used to be read once here and frozen into the strategy closure, so changing a lever in the
  // app's Settings mid-draft did nothing to a running auto-draft -- while the UI said "Bidding/UI
  // levers apply now". Live-reading them is the only mid-draft escape hatch there is: `aggr` and
  // `maxShare` are otherwise fixed for the whole auction, and `maxShare` is the lever the backtest
  // says matters most (~6pp). Behaviour is unchanged if nobody touches the levers.
  //
  // CLI flags still WIN over stored levers, for the whole run: passing --aggr means "use this",
  // not "use this until someone edits the database".
  const cliOverrides: Record<string, string | undefined> = {
    starterReserve: valueOf(rest, "--starter-reserve"), benchReserve: valueOf(rest, "--bench-reserve"),
    premium: valueOf(rest, "--premium"), aggr: valueOf(rest, "--aggr"),
    maxShare: valueOf(rest, "--max-share"), maxKDst: valueOf(rest, "--max-kdst"),
    benchDiscount: valueOf(rest, "--bench-discount"),
  };
  const readLevers = () => {
    const d = openCfgDb(valueOf(rest, "--db"));
    const l = { ...getCfg(d).levers } as Record<string, number>;
    d.close();
    for (const [k, v] of Object.entries(cliOverrides)) if (v != null) l[k] = Number(v);
    return l as unknown as import("./draft/levers.js").Levers;
  };
  const buildStrat = (l: import("./draft/levers.js").Levers) => makeV2Strategy({
    values: Object.keys(values).length ? values : undefined,
    nameKey,
    ...leversToV2Config(l),
    posMult: { ...leversToV2Config(l).posMult, ...parsePosMult(valueOf(rest, "--pos-mult")) },
    // LIVE inflation repricing is ON by default -- backtested +4.8pp at aggr 0.7 (docs/validation.md).
    // Toggle: --no-inflation. Scarcity is a REJECTED feature (backtested NEGATIVE at 10.6% vs 32.9%,
    // and its live wiring passed teams=[ours]) -- removed from auto-draft (Step 6).
    inflation: !rest.includes("--no-inflation"),
    budgetPressure: rest.includes("--budget-pressure"),
    maxPressure: Number(valueOf(rest, "--max-pressure") ?? 1.6),
    maxAtPos: parsePosMult(valueOf(rest, "--max-at-pos")),
  });
  let lv = readLevers();
  let strat = buildStrat(lv);
  const leverSig = (l: Record<string, unknown>) => JSON.stringify(l);
  let lastLeverSig = leverSig(lv as unknown as Record<string, unknown>);
  // Cheap: one indexed read of the settings row per tick, and the strategy is only rebuilt when a
  // value actually changed -- announced, so a mid-draft edit is visible in the log you post-mortem.
  const refreshStrategy = () => {
    try {
      const next = readLevers();
      const sig = leverSig(next as unknown as Record<string, unknown>);
      if (sig === lastLeverSig) return;
      const before = lv as unknown as Record<string, number>, after = next as unknown as Record<string, number>;
      const changed = Object.keys(after).filter((k) => after[k] !== before[k])
        .map((k) => `${k} ${before[k]} -> ${after[k]}`).join(", ");
      lv = next; strat = buildStrat(next); lastLeverSig = sig;
      console.log(`[auto-draft] LEVERS CHANGED mid-draft: ${changed}`);
    } catch { /* a locked/!busy db must never stop the bidder -- keep the last good strategy */ }
  };
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
  const { computeInflation } = await import("./draft/inflation.js");
  const { readDraft } = await import("./draft/espnAuction.js");
  const { writeFileSync } = await import("node:fs");
  // Our full player universe (key/pos/value) -> lets us compute EXACT remaining book value from the
  // scraped drafted set (no virtualized-board guessing). Built once from the values CSV; already
  // keyed by nameKey, so `key` is the entry's own key.
  const universe = Object.entries(values).map(([key, value]) => ({ name: key, pos: posByName.get(key) ?? "RB", value, key }));
  let league = { remainingDollars: 0, teams: 16 };
  let picks: import("./draft/espnAuction.js").DraftPick[] = [];
  let liveInflation = 1;
  let lastPicksLen = -1, stallRefreshes = 0; // draft-over / stall detection
  // Stall guard: stop after ~--stall-min minutes of no new LEAGUE picks (real drafts pause 1-2 min
  // between nominations, so a short window stops prematurely). Refresh cadence is every 4 ticks x
  // ~1.4s ~= 5.6s, so N minutes ~= N*10.7 refreshes; WARN once at ~3 min (Step 6).
  const stallMin = Number(valueOf(rest, "--stall-min") ?? 10);
  const refreshesPerMin = 60 / 5.6;
  const stallStop = Math.round(stallMin * refreshesPerMin);
  const stallWarn = Math.round(3 * refreshesPerMin);
  let loggedSlots = false;
  let nomCooldownUntil = 0; // round index before which we must not nominate again (see below) // one-time live-vs-sim slot-count check
  let wasPaused = false; // copresent PAUSE-file state (Step 9)
  // Losing the draft room MID-DRAFT is the one failure that costs you the season silently: the empty
  // -roster guard below fires, prints a calm "not in a draft room", and exits 0 with slots unfilled.
  // A 2026-09-05 mock died exactly this way at r412 -- ESPN raised a Disney-ID re-auth + reCAPTCHA
  // and the page context went away -- and another finished at 2/12 the same way. So: remember the
  // room we were in, tell the two cases apart, SHOUT about the bad one, and try to walk back in.
  let draftUrl: string | null = null;
  let sawDraft = false, lastFilled = 0, lastOpen = 0, recoveries = 0;
  let bidAttempts = 0, bidFails = 0; // click health -- surfaced live and in the final summary
  const MAX_RECOVERIES = 3;
  // What does the page look like right now? Used only for the operator-facing message.
  const diagnose = async (): Promise<string> => {
    let where = "";
    try { where = page.url() || ""; } catch { /* shim may not have a cached url yet */ }
    let auth = false;
    try {
      auth = Boolean(await page.evaluate(
        "!!document.querySelector('iframe[src*=\"registerdisney\"], iframe[src*=\"recaptcha\"], input[type=\"password\"]')",
      ));
    } catch { /* evaluate can itself fail if the context is gone -- that is informative too */ }
    return `url=${where || "(unknown)"}${auth ? " | AUTH CHALLENGE VISIBLE (Disney login / reCAPTCHA)" : ""}`;
  };
  // Live-state file the desktop app (Mission Control) reads each tick to render the agent's
  // current decision (on-block player, our recommended max bid + reason), our roster/budget, and
  // live inflation. Stable filename so the app polls ONE file. Best-effort, overwritten each tick.
  const liveStatePath = dataPath("live-state.json");
  let lastDecision: { player: string; pos: string | null; offer: number; cap: number; reason: string; action: string } | null = null;
  const logPath = `data/draft-log-${Date.now()}.json`;
  // also write the live snapshot into the store (draft_state) so the app reads it via the helper
  const { openDb: openDbForDraft, writeDraftState } = await import("./db/db.js");
  const draftDb = (() => { try { return openDbForDraft(); } catch { return null; } })();
  for (let i = 0; i < rounds; i++) {
    const r = await readRoster(page);
    if (r.filled === 0 && r.open === 0) {
      // Roster panel not rendered yet (pre-draft countdown) OR not in a draft. Tolerate a
      // startup window before giving up.
      if (++emptyReads > 25) {
        const where = await diagnose();
        // Case 1: we were IN the draft and still had slots to fill -> we were thrown out. Do not
        // quietly stop with an unfinished roster; say so at top volume and try to walk back in.
        if (sawDraft && lastOpen > 0 && draftUrl && recoveries < MAX_RECOVERIES) {
          recoveries++;
          console.log(`\n*** r${i}: LOST THE DRAFT ROOM mid-draft -- ${lastFilled}/${lastFilled + lastOpen} slots filled, $${r.spent || 0} spent.`);
          console.log(`*** ${where}`);
          console.log(`*** Re-entering (attempt ${recoveries}/${MAX_RECOVERIES}). If an ESPN login is on screen, clear it NOW -- the agent cannot log in for you.\n`);
          await page.goto(draftUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
          await page.waitForTimeout(3000);
          emptyReads = 0;
          continue;
        }
        if (sawDraft && lastOpen > 0) {
          console.log(`\n*** r${i}: FATAL -- out of the draft room with ${lastFilled}/${lastFilled + lastOpen} slots UNFILLED after ${recoveries} re-entry attempts.`);
          console.log(`*** ${where}`);
          console.log(`*** DRAFT MANUALLY NOW. Your remaining slots will otherwise be auto-picked by ESPN.\n`);
        } else {
          console.log(`no draft roster after ${emptyReads} reads -- not in a draft room (${where}). Stopping.`);
        }
        break;
      }
      await page.waitForTimeout(1400);
      continue;
    }
    emptyReads = 0;
    // We are demonstrably in a room: remember it so a later eviction can be told apart from
    // "never started", and so we know where to walk back to.
    if (!sawDraft) { sawDraft = true; try { draftUrl = page.url() || null; } catch { draftUrl = null; } }
    lastFilled = r.filled; lastOpen = r.open;
    if (!loggedSlots) {
      const liveSlots = r.filled + r.open;
      console.log(`roster slots live=${liveSlots} sim=${SIM_LEAGUE.slots.length}`);
      if (liveSlots !== SIM_LEAGUE.slots.length)
        console.log(`WARN: live roster has ${liveSlots} slots but sim assumes ${SIM_LEAGUE.slots.length} -- engine adapts to live, but re-check SIM_LEAGUE before trusting backtests.`);
      loggedSlots = true;
    }
    if (r.open === 0) {
      console.log(`DONE: full roster (${r.filled} slots), spent $${r.spent}.`);
      break;
    }
    // Refresh league money + the full drafted set every few ticks -> EXACT live inflation (remaining$
    // / value of the top undrafted players from our table) + a persisted draft log for review.
    if (i % 4 === 0) {
      league = await readLeague(page).catch(() => league);
      picks = await readDraft(page).catch(() => picks);
      if (universe.length > 20) {
        const drafted = new Set(picks.map((p) => nameKey(p.name)));
        const undrafted = universe.filter((u) => !drafted.has(u.key));
        const rosterSize = r.filled + r.open; // our slots = league roster size
        const remainingSlots = Math.max(1, league.teams * rosterSize - picks.length);
        liveInflation = computeInflation(undrafted, league.remainingDollars || (200 - r.spent) * league.teams, remainingSlots);
        try { writeFileSync(logPath, JSON.stringify({ updated: new Date().toISOString(), remainingDollars: league.remainingDollars, teams: league.teams, picksMade: picks.length, liveInflation, positional: positionalStats(picks, universe, nameKey), picks }, null, 0)); } catch { /* best-effort */ }
      }
      // Draft-over / stall guard: if the LEAGUE hasn't drafted anyone new for ~--stall-min minutes
      // while we still have open slots, the draft has ended or wedged -> stop instead of spinning to
      // the round cap. WARN once at ~3 min so a live operator sees a long-but-not-yet-fatal quiet.
      if (picks.length > 0 && picks.length === lastPicksLen) {
        stallRefreshes++;
        if (stallRefreshes === stallWarn) console.log(`r${i}: WARN no new league picks in ~3 min (roster ${r.filled}/${r.filled + r.open}); will stop at ~${stallMin} min quiet.`);
        if (stallRefreshes >= stallStop) { console.log(`draft over/stalled: no new league picks in ~${stallMin} min, roster ${r.filled}/${r.filled + r.open}. Stopping.`); break; }
      }
      else { stallRefreshes = 0; lastPicksLen = picks.length; }
    }
    // Copresent PAUSE (Step 9): while data/PAUSE exists, READ state but never bid or nominate --
    // the human has the wheel. Log once per transition; delete the file to resume.
    const paused = existsSync(dataPath("PAUSE"));
    if (paused !== wasPaused) { console.log(`r${i}: ${paused ? "PAUSED -- data/PAUSE present; reading only, not bidding/nominating (delete to resume)" : "RESUMED -- data/PAUSE removed"}`); wasPaused = paused; }
    // Pick up any mid-draft lever edit (app Settings / set_lever) BEFORE reading the block, so the
    // very next bid uses it. Pairs with data/PAUSE: pause, retune, resume.
    refreshStrategy();
    // EARLY auth-challenge warning. The eviction guard below is reactive -- it fires only after the
    // page context is already gone, and by then ESPN may have auto-bid on our behalf (2026-09-06:
    // an eviction at pick 1 let ESPN buy a $59-book player for $88 while we were disconnected).
    // The Disney login iframe appears BEFORE the teardown, so polling for it cheaply gives the human
    // a window to clear it first. Throttled -- one warning per minute, not per tick.
    if (i % Math.max(1, Math.round(60000 / tick)) === 0) {
      const challenged = await page.evaluate(
        "!!document.querySelector('iframe[src*=\"registerdisney\"], iframe[src*=\"recaptcha\"], input[type=\"password\"]')",
      ).catch(() => false);
      if (challenged) {
        console.log(`r${i}: !! ESPN AUTH CHALLENGE ON SCREEN -- clear the login NOW. If it evicts us mid-auction, ESPN bids for you at ITS price, not ours.`);
      }
    }
    const b = await readBlock(page);
    if (!paused && b.onBlock && b.player && b.canBid) {
      const pos = normPos(b.pos) ?? normPos(posByName.get(nameKey(b.player)) ?? null);
      const need = pos ? hasOpenSlotFor(r, pos) : r.benchOpen > 0; // unknown pos -> bench only
      if (need && pos) {
        // Delegate the ceiling to the Strategy (budget-aware value); Engine clamps to ESPN's hard
        // legal max (myMax) and slot legality. liveInflation is the EXACT remaining$/remaining-value
        // factor computed above from the scraped drafted set (refreshed every few ticks).
        // What we have already WON, by position -- feeds maxAtPos. The ESPN roster panel gives the
        // slot a player sits in, which is NOT his position once he is on the bench ("BE"), so resolve
        // through the same posByName/nameKey path the bidder uses; fall back to the slot label when
        // the slot IS a position. Without this the cap would silently never fire on bench players --
        // exactly the case it exists for.
        const myPosCounts: Record<string, number> = {};
        for (const sl of r.slots) {
          if (!sl.player) continue;
          const rp = normPos(posByName.get(nameKey(sl.player)) ?? null) ?? normPos(sl.slot);
          if (rp) myPosCounts[rp] = (myPosCounts[rp] ?? 0) + 1;
        }
        const state = {
          myBudget: 200 - r.spent,
          mySlots: { ...r.openByBase, FLEX: r.flexOpen, BENCH: r.benchOpen },
          myRoster: [],
          myPosCounts,
          onBlock: { name: b.player, pos: pos as never, team: "", espnPreDraftVal: b.preDraftVal },
          currentOffer: b.currentOffer,
          secondsLeft: null,
          iAmHighBidder: !b.canBid,
          liveInflation,
          board: [{ name: b.player, pos: pos as never, team: "", espnPreDraftVal: b.preDraftVal }], // non-empty so the inflation branch runs
          teams: [{ name: "LEAGUE", budgetLeft: league.remainingDollars || (200 - r.spent), openSlots: r.open }],
          // Room money + unfilled slots, EXPLICIT (see DraftState). Note `teams` above is a single
          // aggregate pseudo-team whose openSlots is OURS, not the league's -- reading the room off
          // it is the bug that made `--scarcity` compute something different live than in the sim.
          leagueDollars: league.remainingDollars,
          leagueOpenSlots: Math.max(0, league.teams * (r.filled + r.open) - picks.length),
        };
        const decision = strat.maxBid(state);
        // ESPN's myMax already reserves $ for a legal roster. If it is UNREADABLE, legalCap falls
        // back to our own affordableMax rather than cap=0 (a silent pass on everything -- finding #9).
        if (b.myMax == null) console.log(`r${i}: WARN myMax unreadable -- falling back to affordableMax`);
        const cap = legalCap(decision.maxBid, b.myMax, state);
        const offer = b.currentOffer ?? 0;
        lastDecision = { player: b.player, pos, offer, cap, reason: decision.reason ?? "", action: offer < cap ? "bid" : "pass" };
        if (offer < cap) {
          // When outbid but still under cap, JUMP-bid a FIXED $jump above the current offer (never
          // past cap) -- the +1 button is too slow for fast stud auctions, and a flat step wins
          // without leaping far past the runner-up (Step 8). --jump 0 -> +1 quick bids only.
          const gap = cap - offer;
          let ok: boolean;
          if (jump > 0 && gap >= jump && cap >= 12) {
            ok = await jumpBid(page, jumpTarget(offer, cap, jump));
            if (!ok) ok = await quickBid(page); // fallback if the manual field isn't ready
          } else {
            ok = await quickBid(page);
          }
          // Click health. A bid we DECIDED to make but failed to click is invisible otherwise: the
          // "(noclick)" suffix below only prints on a player's FIRST sighting, so every re-bid that
          // silently failed left no trace at all. Manual probing on 2026-09-05 measured ~2 failures
          // in 14 clicks (button re-render race), which would be undetectable in a real draft.
          // Count every attempt, and shout on each failure with the running rate.
          bidAttempts++;
          if (!ok) {
            bidFails++;
            console.log(`r${i}: !! CLICK FAILED on ${b.player} at $${offer} (cap ${cap}) -- ${bidFails}/${bidAttempts} bids have failed to click (${Math.round((bidFails / bidAttempts) * 100)}%)`);
          }
          if (b.player !== lastPlayer)
            console.log(`r${i}: bid ${b.player} (${pos}) $${offer} cap=${cap} infl=${liveInflation.toFixed(2)} [${decision.reason}] myMax=${b.myMax} [$${league.remainingDollars} left, open ${r.open}]${ok ? "" : " (noclick)"}`);
          lastPlayer = b.player;
        } else if (b.player !== lastPlayer) {
          console.log(`r${i}: pass ${b.player} (${pos}) $${offer} cap=${cap} [${decision.reason}] [open ${r.open}]`);
          lastPlayer = b.player;
        }
      } else {
        lastDecision = { player: b.player, pos: pos ?? null, offer: b.currentOffer ?? 0, cap: 0, reason: "no open slot for pos", action: "skip" };
        if (b.player !== lastPlayer) {
          console.log(`r${i}: skip ${b.player} (${pos ?? "?"}) -- no open slot [open ${r.open}]`);
          lastPlayer = b.player;
        }
      }
    }
    // Nomination (G3, Step 7): only when it is actually OUR turn. readTurn() gates on the real
    // signal (an enabled board Select with an empty block); the fallback fires only after a long
    // idle AND at least one pick made (never during the pre-draft countdown). We pick THROUGH the
    // Strategy seam (strat.nominate) so the choice is the strategy's, not an ad-hoc board scan.
    if (!paused && !b.onBlock) {
      idlePolls++;
      const turn = await readTurn(page).catch(() => ({ ourNomination: false, nominatingTeam: null }));
      const fallbackTurn = idlePolls >= 14 && picks.length > 0; // ~14 ticks x 1.4s ~= 20s, post-countdown
      // COOLDOWN. ESPN does not clear "our nomination turn" the instant the click lands, so the next
      // poll saw the same turn and nominated AGAIN -- on every nomination (mock 1: r149/r151,
      // r476/r478, r800/r801). MEASURED IMPACT: benign. The repeat targets the SAME player (the
      // board has not changed, so the strategy re-picks him) and exactly one nomination results --
      // mock 3 r283/r291 A.J. Brown then bid at r304, r618/r626 Waddle then bid at r640. So this is
      // a redundant click, not a wasted nomination; the cooldown just stops us spamming it. It does
      // NOT eliminate the repeat (ESPN can still report our turn 8 rounds later) and does not need
      // to -- do not "fix" it further without evidence that a duplicate ever nominates a DIFFERENT
      // player, which no log has shown.
      if ((turn.ourNomination || fallbackTurn) && i >= nomCooldownUntil) {
        const board = await readBoard(page);
        const boardRefs = board.map((p) => ({ name: p.name, pos: (normPos(p.pos) ?? "RB") as never, team: "", espnPreDraftVal: p.value }));
        const myNames = r.slots.filter((s) => s.player).map((s) => ({ name: s.player as string, pos: "RB" as never, team: "", espnPreDraftVal: null }));
        const choice = strat.nominate({
          myBudget: 200 - r.spent, mySlots: { ...r.openByBase, FLEX: r.flexOpen, BENCH: r.benchOpen },
          myRoster: myNames, onBlock: null, currentOffer: null, secondsLeft: null,
          iAmHighBidder: false, board: boardRefs, teams: [],
        });
        const ok = choice.player ? await nominate(page, choice.player.name) : false;
        console.log(`r${i}: NOMINATE ${choice.player?.name ?? "?"} ${turn.ourNomination ? "(our turn)" : "(fallback)"} ${ok ? "" : "(failed -- not our turn / not visible)"}`);
        // A successful click needs a few ticks for ESPN to put the player on the block; a FAILED one
        // should retry sooner (it may simply not have been our turn yet).
        nomCooldownUntil = i + (ok ? 8 : 3);
        idlePolls = 0;
      }
    } else {
      idlePolls = 0;
    }
    // Emit the live-state file the desktop app renders as the copilot (agent's current decision +
    // our roster/budget + inflation). Best-effort; overwritten each tick.
    try {
      const onBlock = b.onBlock && b.player
        ? { player: b.player, pos: normPos(b.pos), currentOffer: b.currentOffer, myMax: b.myMax, canBid: b.canBid }
        : null;
      const decisionOut = paused ? { action: "paused" }
        : !onBlock ? { action: "idle" }
        : (lastDecision && lastDecision.player === b.player) ? lastDecision
        : b.canBid ? { player: b.player, action: "watch" }
        : { player: b.player, action: "leading" }; // can't bid == we're high bidder / locked
      const roster = r.slots.filter((s) => s.player).map((s) => ({ slot: s.slot, player: s.player, price: s.price }));
      const liveState = {
        updated: new Date().toISOString(), round: i, paused, onBlock, decision: decisionOut,
        us: { budget: 200 - r.spent, spent: r.spent, filled: r.filled, open: r.open,
              openByBase: r.openByBase, flexOpen: r.flexOpen, benchOpen: r.benchOpen, roster },
        liveInflation,
        // Click health rides along so the cockpit can show it: a rising failure rate means the
        // bidder is DECIDING correctly but not landing the clicks -- invisible in the roster.
        clicks: { attempts: bidAttempts, fails: bidFails },
        league: { remainingDollars: league.remainingDollars, teams: league.teams, picksMade: picks.length },
        recentPicks: picks.slice(-12).map((p) => ({ pick: p.pick, name: p.name, pos: p.pos, team: p.fantasyTeam, price: p.price })),
      };
      writeFileSync(liveStatePath, JSON.stringify(liveState, null, 0)); // fast-path file for the poll
      if (draftDb) writeDraftState(draftDb, "local", Object.assign({    // + the store, read via the helper
        onBlockPlayer: onBlock?.player ?? null, onBlockPos: onBlock ? normPos(b.pos) : null,
        bid: onBlock?.currentOffer ?? null, ourBudget: 200 - r.spent, ourSpent: r.spent, ourFilled: r.filled,
      }, liveState));
    } catch { /* best-effort */ }
    await page.waitForTimeout(tick);
  }
  try { draftDb?.close(); } catch { /* ignore */ }
  const fin = await readRoster(page);
  console.log(`final: filled ${fin.filled}/${fin.filled + fin.open} spent $${fin.spent} open ${fin.open}`);
  console.log(`clicks: ${bidAttempts - bidFails}/${bidAttempts} landed${bidAttempts ? ` (${Math.round((bidFails / bidAttempts) * 100)}% failed)` : ""}`);
  await detach(a);
}

async function cmdInspect(rest: string[]) {
  const out = valueOf(rest, "--out") ?? dataPath("draft-dom-snapshot.json");
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
  const csv = valueOf(rest, "--csv") ?? dataPath("rankings.sample.csv");
  const rankings = loadRankings(csv);
  const baselines = replacementBaselines(rankings, DEFAULT_LEAGUE);
  const valued = withVOR(rankings, baselines).sort((x, y) => y.vor - x.vor);
  console.log(`Top 15 by VOR (baselines: ${JSON.stringify(baselines)}):`);
  for (const p of valued.slice(0, 15)) {
    console.log(`  ${p.vor.toFixed(1).padStart(6)}  ${p.pos.padEnd(3)} ${p.name} (${p.team})`);
  }
}

function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
