// The draft copilot: a Claude Agent SDK session (subscription auth via the machine's `claude` login,
// no API key). Only our MCP tools are exposed (no built-in Bash/Read/etc.). It can READ the store,
// ACT on my roster (draft/drop/set_price -- each logged to action_log, plan->act->verify), and
// freely NAVIGATE ESPN through the app's OWN authenticated webview (navigate/read_page/
// discover_leagues, driven via the renderer). No bro -- everything goes through the app session.
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { openDb, getConfig, setConfig, appendUsage, getMyRoster, setMyRoster, logAction, completeAction, recentActions, type RosterEntry } from "../db/db.js";
import { nameKey } from "../draft/values.js";
import { scoringFromEspn, type ScoringRules } from "../draft/scoring.js";
import { LEVER_META, clampLever, applyLevers } from "../draft/levers.js";
import { browserTools } from "./browserTools.js";

// ESPN fantasy id maps (defaultPositionId / lineupSlotId)
const ESPN_POS: Record<number, string> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };
const ESPN_SLOT: Record<number, string> = { 0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP", 16: "DST", 17: "K", 20: "BE", 21: "IR", 23: "FLEX", 24: "ER" };
// Build the app's ordered slots array (starters, then DST/K, then bench) from ESPN's lineupSlotCounts.
const SLOT_ORDER = [0, 2, 3, 4, 5, 6, 23, 7, 16, 17, 20, 21, 24];
function espnSlotsToConfig(counts: Record<string, number>): string[] {
  const out: string[] = [];
  for (const id of SLOT_ORDER) { const n = Number(counts[id] ?? 0); for (let i = 0; i < n; i++) out.push(ESPN_SLOT[id] ?? String(id)); }
  return out;
}
const espnLeagueUrl = (season: number, leagueId: string, views: string[]) =>
  `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?` + views.map((v) => `view=${v}`).join("&");
const normSwid = (s: string) => (s || "").replace(/[{}]/g, "").toUpperCase();

// One row per player joining our value + both consensus sources, for the tools to format.
const BOARD_SQL = `
  SELECT p.name, p.position AS pos, p.nfl_team AS team, pv.our_value, pv.our_rank, pv.pos_rank, pv.proj_pts, pv.tier,
         re.overall_rank AS ecr, re.bye AS bye, rs.overall_rank AS espn
  FROM player_value pv JOIN player p USING(player_id)
  LEFT JOIN ranking re ON re.player_id=pv.player_id AND re.source='fantasypros_ecr' AND re.season=pv.season
  LEFT JOIN ranking rs ON rs.player_id=pv.player_id AND rs.source='espn'            AND rs.season=pv.season
  WHERE pv.season=@season`;

type Row = { name: string; pos: string; team: string; our_value: number; our_rank: number; pos_rank: string; proj_pts: number; tier: string; ecr: number; bye: number; espn: number };
// vsECR/vsESPN = consensus rank minus OUR rank. POSITIVE = we rank them earlier than the room (a
// VALUE); negative = the room likes them more than we do. Computed here so the model never has to
// reason about rank direction (which it gets wrong).
const sgn = (n: number | null) => n == null ? "?" : (n > 0 ? "+" + n : String(n));
const fmt = (rows: Row[]) => rows.length === 0 ? "none" : rows.map((r) => {
  const vsEcr = r.ecr != null ? Math.round(r.ecr - r.our_rank) : null;
  const vsEspn = r.espn != null ? Math.round(r.espn - r.our_rank) : null;
  return `#${r.our_rank} ${r.name} (${r.pos}${r.pos_rank ? " " + r.pos_rank : ""}) $${r.our_value} | vsECR ${sgn(vsEcr)} | vsESPN ${sgn(vsEspn)} | proj ${r.proj_pts ?? "?"} | ECR ${r.ecr ?? "?"} ESPN ${r.espn ?? "?"} | tier ${r.tier ?? "?"} bye ${r.bye ?? "?"}`;
}).join("\n");

// The ONE control surface. Both consumers are built from this array: the in-app copilot
// (boardServer -> the Agent SDK) and any EXTERNAL agent such as Claude Code (src/agent/mcp-stdio.ts
// serves the very same McpServer instance over stdio). Add a tool here and both surfaces get it --
// there is no second list to keep in sync.
function buildTools(dbPath: string | undefined, season: number) {
  return [
      tool(
        "read_board",
        "Read the top available players by OUR auction $ value, optionally filtered by position (QB, RB, WR, TE, K, DST). Returns our rank/value, projection, FantasyPros ECR, ESPN rank, tier, and bye.",
        { pos: z.string().optional().describe("position filter e.g. RB; omit for overall"), limit: z.number().optional().describe("how many rows, default 12, max 60") },
        async (args) => {
          const db = openDb(dbPath);
          const pos = (args.pos || "").toUpperCase();
          const limit = args.limit && args.limit > 0 ? Math.min(args.limit, 60) : 12;
          const sql = (pos && pos !== "ALL" ? BOARD_SQL + " AND p.position=@pos" : BOARD_SQL) + " ORDER BY pv.our_value DESC LIMIT @limit";
          const rows = db.prepare(sql).all({ season, pos, limit }) as Row[];
          db.close();
          return { content: [{ type: "text", text: fmt(rows) }] };
        },
      ),
      tool(
        "player_detail",
        "Look up ONE player by (partial) name: our value/rank, projection, ECR & ESPN ranks, tier, bye, latest news, PLUS draft-market ADP + range, Boris Chen tier, FantasyCalc market value & 30-day momentum, waiver adds/24h, prior-season usage (snap %, aDOT, drop%), trade value, live injury/status, Vegas implied total, and this-week rank.",
        { name: z.string().describe("player name, full or partial") },
        async (args) => {
          const db = openDb(dbPath);
          const row = db.prepare(BOARD_SQL + " AND lower(p.name) LIKE @q ORDER BY pv.our_value DESC LIMIT 1")
            .get({ season, q: `%${(args.name || "").toLowerCase()}%` }) as Row | undefined;
          let extra = "";
          if (row) {
            const k = nameKey(row.name);
            const n = db.prepare("SELECT detail FROM news WHERE player_name=@nm AND category IN ('injury','headline') ORDER BY id DESC LIMIT 1").get({ nm: row.name }) as { detail: string } | undefined;
            const a = db.prepare("SELECT snap_pct, adot, yac_r, drop_pct FROM player_advanced WHERE player_id=?").get(k) as { snap_pct: number; adot: number; yac_r: number; drop_pct: number } | undefined;
            const tv = db.prepare("SELECT value_1qb FROM trade_value WHERE player_id=?").get(k) as { value_1qb: number } | undefined;
            const wk = db.prepare("SELECT rank, ecr FROM weekly_rank WHERE player_id=? ORDER BY rank LIMIT 1").get(k) as { rank: number; ecr: number } | undefined;
            const bc = db.prepare("SELECT tier, pos_rank FROM boris_tier WHERE player_id=?").get(k) as { tier: number; pos_rank: number } | undefined;
            const adp = db.prepare("SELECT adp, high, low FROM adp WHERE player_id=?").get(k) as { adp: number; high: number; low: number } | undefined;
            const mv = db.prepare("SELECT value, trend_30d FROM market_value WHERE player_id=?").get(k) as { value: number; trend_30d: number } | undefined;
            const tr = db.prepare("SELECT count FROM trending WHERE player_id=? AND kind='add'").get(k) as { count: number } | undefined;
            const st = db.prepare("SELECT injury_status, injury_body, depth_order FROM player_status WHERE player_id=?").get(k) as { injury_status: string; injury_body: string; depth_order: number } | undefined;
            const od = db.prepare("SELECT implied_total, opponent FROM team_odds WHERE team=?").get(row.team) as { implied_total: number; opponent: string } | undefined;
            if (adp) extra += ` | ADP ${adp.adp} (rng ${adp.high}-${adp.low})`;
            if (bc) extra += ` | Boris tier ${bc.tier} (${row.pos}${bc.pos_rank})`;
            if (mv) extra += ` | market ${mv.value}${mv.trend_30d != null ? ` (30d ${mv.trend_30d > 0 ? "+" : ""}${mv.trend_30d})` : ""}`;
            if (tr) extra += ` | ${tr.count.toLocaleString()} adds/24h`;
            if (a && (a.snap_pct != null || a.adot != null)) extra += ` | usage: snap ${a.snap_pct != null ? Math.round(a.snap_pct * 100) + "%" : "?"}${a.adot != null ? `, aDOT ${a.adot}` : ""}${a.drop_pct != null ? `, drop ${a.drop_pct}%` : ""}`;
            if (st?.injury_status) extra += ` | STATUS: ${st.injury_status}${st.injury_body ? ` (${st.injury_body})` : ""}`;
            else if (st && st.depth_order != null) extra += ` | depth #${st.depth_order}`;
            if (od) extra += ` | Vegas: ${od.implied_total} implied vs ${od.opponent}`;
            if (tv) extra += ` | trade value ${tv.value_1qb}`;
            if (wk) extra += ` | this week: rank ${wk.rank} (ECR ${wk.ecr})`;
            if (n) extra += ` | news: ${n.detail}`;
          }
          db.close();
          return { content: [{ type: "text", text: row ? fmt([row]) + extra : `no player matching "${args.name}"` }] };
        },
      ),
      tool(
        "read_my_team",
        "Read MY current drafted roster and remaining auction budget.",
        {},
        async () => {
          const db = openDb(dbPath);
          const budget = getConfig(db).budget;
          // join my_roster -> player + player_value so the agent sees each pick's value/pos/proj
          const rows = db.prepare(`
            SELECT mr.name, mr.price, p.position AS pos, pv.pos_rank, pv.our_value, pv.proj_pts
            FROM my_roster mr
            LEFT JOIN player p ON p.player_id = mr.player_id
            LEFT JOIN player_value pv ON pv.player_id = mr.player_id
            WHERE mr.draft_id = 'local' ORDER BY mr.price DESC`,
          ).all() as { name: string; price: number; pos: string; pos_rank: string; our_value: number; proj_pts: number }[];
          db.close();
          const spent = rows.reduce((s, r) => s + (r.price || 0), 0);
          const text = rows.length
            ? `${rows.length} drafted, $${spent} spent, $${budget - spent} left:\n` + rows.map((r) => `${r.pos || "?"} ${r.name} $${r.price} (${r.pos_rank || "?"}, our value $${r.our_value ?? "?"}, proj ${r.proj_pts ?? "?"})`).join("\n")
            : `no players drafted yet (budget $${budget})`;
          return { content: [{ type: "text", text }] };
        },
      ),
      // --- ACT tools: mutate MY roster, each with the D3 audit trail (plan -> act -> verify -> log).
      // This is the governance pattern every future in-season act (lineup/waiver/trade) will reuse.
      tool(
        "draft_player",
        "Draft/add a player to MY team at a price (records the pick; reversible via drop_player). Logged to the action log.",
        { name: z.string().describe("player name"), price: z.number().optional().describe("auction $ paid; defaults to our value") },
        async (args) => {
          const db = openDb(dbPath);
          const row = db.prepare("SELECT p.name, p.position, pv.our_value FROM player p LEFT JOIN player_value pv USING(player_id) WHERE lower(p.name) LIKE @q ORDER BY pv.our_value DESC LIMIT 1").get({ q: `%${(args.name || "").toLowerCase()}%` }) as { name: string; position: string; our_value: number } | undefined;
          if (!row) { db.close(); return { content: [{ type: "text", text: `no player matching "${args.name}"` }] }; }
          const price = args.price ?? (row.our_value || 1);
          const id = logAction(db, { runType: "chat", action: "draft_player", detail: { name: row.name, price } });
          try {
            const cur = getMyRoster(db, "local");
            if (cur.some((r) => r.name === row.name)) { completeAction(db, id, "skipped", "already on roster"); db.close(); return { content: [{ type: "text", text: `${row.name} is already on your team` }] }; }
            setMyRoster(db, "local", [...cur, { name: row.name, price }]);
            const ok = getMyRoster(db, "local").some((r) => r.name === row.name); // verify the write
            completeAction(db, id, ok ? "done" : "failed", ok ? undefined : "not present after write");
            db.close();
            return { content: [{ type: "text", text: ok ? `drafted ${row.name} (${row.position}) for $${price}` : `failed to draft ${row.name}` }] };
          } catch (e) { completeAction(db, id, "failed", String(e)); db.close(); return { content: [{ type: "text", text: "error: " + String(e) }] }; }
        },
      ),
      tool(
        "drop_player",
        "Remove a player from MY team (reverses a draft/add). Logged to the action log.",
        { name: z.string().describe("player name to drop") },
        async (args) => {
          const db = openDb(dbPath);
          const cur = getMyRoster(db, "local");
          const hit = cur.find((r) => r.name.toLowerCase().includes((args.name || "").toLowerCase()));
          if (!hit) { db.close(); return { content: [{ type: "text", text: `"${args.name}" is not on your team` }] }; }
          const id = logAction(db, { runType: "chat", action: "drop_player", detail: { name: hit.name } });
          setMyRoster(db, "local", cur.filter((r) => r.name !== hit.name));
          const ok = !getMyRoster(db, "local").some((r) => r.name === hit.name); // verify the removal
          completeAction(db, id, ok ? "done" : "failed");
          db.close();
          return { content: [{ type: "text", text: ok ? `dropped ${hit.name}` : `failed to drop ${hit.name}` }] };
        },
      ),
      tool(
        "read_actions",
        "Read the recent action log -- what the agent has done to the roster (draft/drop) and whether it succeeded.",
        {},
        async () => {
          const db = openDb(dbPath);
          const acts = recentActions(db, 10);
          db.close();
          const text = acts.length ? acts.map((a) => `${a.status.toUpperCase()} ${a.action} ${a.detail_json}${a.reason ? " -- " + a.reason : ""}`).join("\n") : "no actions yet";
          return { content: [{ type: "text", text }] };
        },
      ),
      tool(
        "read_needs",
        "What roster slots are still OPEN (what to draft next), plus budget left and max legal bid, given my drafted players. Use this to target picks.",
        {},
        async () => {
          const db = openDb(dbPath);
          const cfg = getConfig(db);
          const roster = getMyRoster(db, "local");
          const posOf = new Map<string, string>();
          for (const r of roster) { const p = db.prepare("SELECT position FROM player WHERE player_id = ?").get(nameKey(r.name)) as { position: string } | undefined; if (p) posOf.set(r.name, p.position); }
          db.close();
          // greedy fill: base slots by exact position, then FLEX from flex_ok, then bench
          const slots = cfg.slots.map((base) => ({ base, filled: false }));
          const flexOk = new Set(cfg.flex_ok);
          const pool = roster.map((r) => ({ name: r.name, pos: posOf.get(r.name) || "?" }));
          const take = (pred: (p: { pos: string }) => boolean) => { const i = pool.findIndex(pred); return i >= 0 ? pool.splice(i, 1)[0] : null; };
          for (const s of slots) if (s.base !== "FLEX" && s.base !== "BE" && take((p) => p.pos === s.base)) s.filled = true;
          for (const s of slots) if (s.base === "FLEX" && take((p) => flexOk.has(p.pos))) s.filled = true;
          for (const s of slots) if (s.base === "BE" && pool.length) { pool.shift(); s.filled = true; }
          const open = slots.filter((s) => !s.filled).map((s) => s.base);
          const spent = roster.reduce((s, r) => s + (r.price || 0), 0);
          const rem = cfg.budget - spent;
          const maxBid = Math.max(1, rem - Math.max(0, open.length - 1)); // must keep $1 for each other open slot
          const text = `filled ${roster.length}/${cfg.slots.length} | $${rem} left, max legal bid $${maxBid}\nopen slots: ${open.length ? open.join(", ") : "none -- roster full"}`;
          return { content: [{ type: "text", text }] };
        },
      ),
      tool(
        "set_price",
        "Correct the auction price paid for a player already on MY team. Logged to the action log.",
        { name: z.string().describe("player on my team"), price: z.number().describe("corrected auction $") },
        async (args) => {
          const db = openDb(dbPath);
          const cur = getMyRoster(db, "local");
          const hit = cur.find((r) => r.name.toLowerCase().includes((args.name || "").toLowerCase()));
          if (!hit) { db.close(); return { content: [{ type: "text", text: `"${args.name}" is not on your team` }] }; }
          const id = logAction(db, { runType: "chat", action: "set_price", detail: { name: hit.name, from: hit.price, to: args.price } });
          const next: RosterEntry[] = cur.map((r) => r.name === hit.name ? { name: r.name, price: Math.round(args.price) } : r);
          setMyRoster(db, "local", next);
          const ok = getMyRoster(db, "local").some((r) => r.name === hit.name && r.price === Math.round(args.price));
          completeAction(db, id, ok ? "done" : "failed");
          db.close();
          return { content: [{ type: "text", text: ok ? `set ${hit.name} to $${Math.round(args.price)}` : `failed to update ${hit.name}` }] };
        },
      ),
      tool(
        "read_levers",
        "Read the tunable LEVERS that shape our values/tiers/bidding (tier break, K/DST cap, starter/bench reserve, max share, aggressiveness, outbid premium, sleeper cutoff) with their current values and valid ranges.",
        {},
        async () => {
          const db = openDb(dbPath);
          const lv = getConfig(db).levers as unknown as Record<string, number>;
          db.close();
          const lines = Object.entries(LEVER_META).map(([k, m]) => `${k} = ${lv[k]} (${m.label}; ${m.min}..${m.max}${m.board ? "; affects board -> needs refresh" : ""}) -- ${m.help}`);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        },
      ),
      tool(
        "set_lever",
        "Change ONE tuning lever (e.g. tierBreak, maxKDst, starterReserve, maxShare, aggr, premium, sleeperThreshold). Value is clamped to the lever's valid range. Board-affecting levers (tierBreak, maxKDst) take effect after the next data refresh; bidding/UI levers apply immediately. Logged to the action log.",
        { key: z.string().describe("lever name, e.g. tierBreak"), value: z.number().describe("new value (clamped to range)") },
        async (args) => {
          const db = openDb(dbPath);
          const meta = (LEVER_META as Record<string, { min: number; max: number; board: boolean }>)[args.key];
          if (!meta) { db.close(); return { content: [{ type: "text", text: `unknown lever "${args.key}". Valid: ${Object.keys(LEVER_META).join(", ")}` }] }; }
          const clamped = clampLever(args.key, args.value);
          if (clamped == null) { db.close(); return { content: [{ type: "text", text: `invalid value for ${args.key}` }] }; }
          const id = logAction(db, { runType: "chat", action: "set_lever", detail: { key: args.key, value: clamped } });
          const cur = getConfig(db).levers;
          const next = applyLevers(cur, { [args.key]: clamped });
          setConfig(db, { levers: next });
          const ok = ((getConfig(db).levers as unknown as Record<string, number>)[args.key]) === clamped;
          completeAction(db, id, ok ? "done" : "failed");
          db.close();
          const note = meta.board ? " (affects the board -- run a data refresh to apply)" : " (applies immediately)";
          return { content: [{ type: "text", text: ok ? `set ${args.key} = ${clamped}${clamped !== Number(args.value) ? ` (clamped from ${args.value})` : ""}${note}` : `failed to set ${args.key}` }] };
        },
      ),
      // --- NAVIGATION: the agent freely browses ESPN through the app's OWN authenticated webview
      // (persistent, always a CDP target). No bro; everything goes through the logged-in app session.
      tool(
        "navigate",
        "Navigate the embedded ESPN browser (my logged-in session) to a URL; shows it in Live Draft and returns the resulting URL + title. Browse my fantasy home / team / league pages.",
        { url: z.string().describe("full URL, e.g. https://fantasy.espn.com/football/") },
        async (args) => {
          const { browser, page } = await rendererPage();
          if (!page) { await browser?.close().catch(() => {}); return { content: [{ type: "text", text: "app not available (open the desktop app)" }] }; }
          try { const info = await wvNavigate(page, args.url); await browser?.close().catch(() => {}); return { content: [{ type: "text", text: `at ${info.url || args.url} | ${info.title || ""}` }] }; }
          catch (e) { await browser?.close().catch(() => {}); return { content: [{ type: "text", text: "nav error: " + String(e).slice(0, 120) }] }; }
        },
      ),
      tool(
        "read_page",
        "Read the visible text of the current embedded ESPN page (optionally only lines containing a keyword). Use after navigate to see what's there.",
        { contains: z.string().optional().describe("filter to lines containing this text") },
        async (args) => {
          const { browser, page } = await rendererPage();
          if (!page) { await browser?.close().catch(() => {}); return { content: [{ type: "text", text: "app not available" }] }; }
          try {
            const text = await wvEval(page, "(document.body&&document.body.innerText||'').slice(0,6000)");
            await browser?.close().catch(() => {});
            const filtered = args.contains ? (text.split("\n").filter((l) => l.toLowerCase().includes(args.contains!.toLowerCase())).join("\n") || "(no matching lines)") : text;
            return { content: [{ type: "text", text: filtered.slice(0, 3500) || "(empty)" }] };
          } catch (e) { await browser?.close().catch(() => {}); return { content: [{ type: "text", text: "read error: " + String(e).slice(0, 120) }] }; }
        },
      ),
      tool(
        "click_page",
        "Click an element in the embedded ESPN page by its visible TEXT (or a CSS selector). Use after navigate/read_page to actually operate the site -- e.g. entering a mock draft room from the lobby. Returns what was clicked and the resulting URL/title.",
        {
          text: z.string().optional().describe("visible text of the button/link, e.g. 'Practice Draft'"),
          selector: z.string().optional().describe("CSS selector, used instead of text when given"),
          nth: z.number().optional().describe("which match to click when several tie, 0-based (default 0)"),
        },
        async (args) => {
          const { browser, page } = await rendererPage();
          if (!page) { await browser?.close().catch(() => {}); return { content: [{ type: "text", text: "app not available" }] }; }
          try {
            // Runs INSIDE the webview guest. Matches only rendered, non-hidden elements and prefers
            // the SMALLEST element containing the text, so "Practice Draft" hits the button and not
            // the <body> that also contains it.
            const payload = JSON.stringify({ text: args.text ?? "", selector: args.selector ?? "", nth: args.nth ?? 0 });
            // The webview BLOCKS window.open, so any control that launches a popup (ESPN opens every
            // draft room that way) silently does nothing. Patch window.open to capture the URL
            // instead -- same trick cmdEnterDraft uses -- then navigate the webview there ourselves.
            const js = "(function(){var a=" + payload + ";" +
              "window.__ffOpen=null;if(!window.__ffPatched){window.__ffPatched=1;" +
              "window.open=function(u){try{window.__ffOpen=String(u||'');}catch(e){}" +
              "return {closed:false,focus:function(){},blur:function(){},close:function(){},postMessage:function(){}};};}" +
              "function vis(e){var r=e.getBoundingClientRect();var s=getComputedStyle(e);" +
              "return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}" +
              "var c=[];" +
              "if(a.selector){c=Array.prototype.slice.call(document.querySelectorAll(a.selector)).filter(vis);}" +
              "else{var t=a.text.toLowerCase();" +
              "c=Array.prototype.slice.call(document.querySelectorAll('a,button,input,[role=button],div,span,td'))" +
              ".filter(function(e){var x=(e.innerText||e.value||'').trim().toLowerCase();return x&&x.indexOf(t)>=0&&vis(e);})" +
              ".sort(function(p,q){return (p.innerText||'').length-(q.innerText||'').length;});}" +
              "if(!c.length)return 'NOMATCH';" +
              "var el=c[Math.min(a.nth,c.length-1)];" +
              "var label=(el.innerText||el.value||el.tagName).trim().slice(0,60);" +
              "el.scrollIntoView({block:'center'});el.click();" +
              "return 'CLICKED:'+label;})()";
            const res = await wvEval(page, js);
            if (res === "NOMATCH") { await browser?.close().catch(() => {}); return { content: [{ type: "text", text: `no visible element matched ${args.selector ? "selector " + args.selector : `text "${args.text}"`}` }] }; }
            await page.waitForTimeout(2000);
            // If the click tried to pop a window, follow it in-place.
            const popped = await wvEval(page, "String(window.__ffOpen||'')");
            let followed = "";
            if (popped && popped !== "null") {
              const abs = popped.startsWith("http") ? popped : new URL(popped, await wvEval(page, "location.href")).href;
              await wvNavigate(page, abs);
              followed = ` (followed blocked popup -> ${abs})`;
            }
            await page.waitForTimeout(1500);
            const after = await page.evaluate(() => { const wv = document.getElementById("espnview") as unknown as { getURL?: () => string; getTitle?: () => string }; return { url: wv?.getURL ? wv.getURL() : "", title: wv?.getTitle ? wv.getTitle() : "" }; });
            await browser?.close().catch(() => {});
            return { content: [{ type: "text", text: `${res}${followed} -> ${after.url || "(same page)"} | ${after.title || ""}` }] };
          } catch (e) { await browser?.close().catch(() => {}); return { content: [{ type: "text", text: "click error: " + String(e).slice(0, 140) }] }; }
        },
      ),
      ...(browserTools(tool as never) as never[]),
      tool(
        "discover_leagues",
        "Browse MY ESPN fantasy home and list my leagues/teams (leagueId, season, team) by reading page links -- more reliable than guessing IDs. Saves them to the store.",
        {},
        async () => {
          const { browser, page } = await rendererPage();
          if (!page) { await browser?.close().catch(() => {}); return { content: [{ type: "text", text: "app not available" }] }; }
          try {
            await wvNavigate(page, "https://fantasy.espn.com/football/");
            await page.waitForTimeout(2500);
            // grab leagueId-bearing hrefs + the current URL from inside the webview; parse them in Node
            const raw = await wvEval(page, "JSON.stringify(Array.prototype.slice.call(document.querySelectorAll('a')).map(function(a){return a.href}).filter(function(h){return h.indexOf('leagueId')>=0}).concat([location.href]))");
            await browser?.close().catch(() => {});
            let hrefs: string[] = []; try { hrefs = JSON.parse(raw || "[]"); } catch { /* empty */ }
            const seen: Record<string, boolean> = {}; const found: { leagueId: string; seasonId: string; teamId: string }[] = [];
            for (const h of hrefs) { try { const u = new URL(h); const lg = u.searchParams.get("leagueId"); if (!lg) continue; const se = u.searchParams.get("seasonId") || ""; const k = lg + "|" + se; if (!seen[k]) { seen[k] = true; found.push({ leagueId: lg, seasonId: se, teamId: u.searchParams.get("teamId") || "" }); } } catch { /* skip */ } }
            const db = openDb(dbPath); const now = new Date().toISOString();
            for (const l of found) db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?, 'espn', ?, ?, ?, ?) ON CONFLICT(league_id) DO UPDATE SET season=excluded.season, team_id=excluded.team_id, last_synced_at=excluded.last_synced_at").run(l.leagueId, null, Number(l.seasonId) || null, l.teamId || null, now);
            db.close();
            return { content: [{ type: "text", text: found.length ? `found ${found.length} league(s):\n` + found.map((l) => `leagueId ${l.leagueId}, season ${l.seasonId || "?"}, team ${l.teamId || "?"}`).join("\n") : "no league links on the fantasy home -- navigate into a team page + read_page, or confirm I'm logged in" }] };
          } catch (e) { await browser?.close().catch(() => {}); return { content: [{ type: "text", text: "discover error: " + String(e).slice(0, 120) }] }; }
        },
      ),
      tool(
        "league_sync",
        "Sync my REAL ESPN league into the app from my logged-in session: name, size, scoring (auto-detects PPR/Half/Standard from the league's rules), roster slots, and which team is mine. Run discover_leagues first. If it changes the scoring format, tell me to run `ff refresh` so tiers/ADP rebuild for that format.",
        {},
        async () => {
          const { browser, page } = await rendererPage();
          if (!page) { await browser?.close().catch(() => {}); return { content: [{ type: "text", text: "app not available (open the desktop app)" }] }; }
          const db = openDb(dbPath); let closed = false; const shut = () => { if (!closed) { closed = true; try { db.close(); } catch { /* already closed */ } } };
          try {
            const lg = activeLeague(db);
            if (!lg) { shut(); await browser?.close().catch(() => {}); return { content: [{ type: "text", text: "no league known -- run discover_leagues first" }] }; }
            const swid = await espnSwid(page);
            const j = await espnGet<any>(page, espnLeagueUrl(lg.season, lg.league_id, ["mSettings", "mTeam"]));
            await browser?.close().catch(() => {});
            if (!j) { shut(); return { content: [{ type: "text", text: "could not read league (not logged in, or wrong league id)" }] }; }
            const s = j.settings ?? {}; const rs = s.rosterSettings ?? {}; const sc = s.scoringSettings ?? {}; const ds = s.draftSettings ?? {};
            const mine = (j.teams ?? []).find((t: any) => (t.owners ?? []).some((o: string) => swid && normSwid(o) === normSwid(swid)));
            const slots = rs.lineupSlotCounts ?? {};
            const slotSummary = Object.entries(slots).filter(([, n]) => Number(n) > 0).map(([id, n]) => `${n}x${ESPN_SLOT[Number(id)] ?? id}`).join(", ");
            // auto-detect PPR from the receptions scoring item (statId 53)
            const rec = (sc.scoringItems ?? []).find((it: any) => it.statId === 53);
            const recPts = rec ? Number(rec.points ?? 0) : 0;
            const scoring = recPts >= 1 ? "PPR" : recPts >= 0.5 ? "HALF" : "STD";
            const mineName = mine ? (mine.name ?? `${mine.location ?? ""} ${mine.nickname ?? ""}`.trim()) : null;
            const configSlots = espnSlotsToConfig(slots);
            const budget = ds.type === "AUCTION" && ds.auctionBudget ? Number(ds.auctionBudget) : getConfig(db).budget;
            const teams = Number(s.size) || getConfig(db).teams;
            // Build the actual per-stat scoring model from the league's real scoringItems -- this is
            // what tailors OUR points/values (not just the HALF/PPR consensus bucket).
            // Build the WHOLE model -- offence, kicking AND defence. Only the offensive third used to
            // be synced, so a league with different K/DST scoring kept ours and nothing failed.
            const model = scoringFromEspn(sc.scoringItems ?? []);
            const rules: ScoringRules = model.rules;
            db.prepare("UPDATE league SET name=@n, season=@se, scoring_json=@sj, team_id=@tid, last_synced_at=@now WHERE league_id=@lid")
              .run({ n: s.name ?? null, se: lg.season, sj: JSON.stringify({ scoringType: sc.scoringType, ppr: recPts, draftType: ds.type, auctionBudget: ds.auctionBudget, slots, size: s.size, rules, kicker: model.kicker, defense: model.defense }), tid: mine ? String(mine.id) : lg.team_id, now: new Date().toISOString(), lid: lg.league_id });
            // THE FORMAT BLOCK, built from the SAME payload the rest of this sync reads.
            //
            // This used to write only the two flat numbers, each with a `|| <whatever is stored>`
            // fallback -- so a sync against a league whose settings had changed could leave the
            // calendar at the old value with nothing to show for it. `formatFromEspnSettings`
            // refuses to default any field, and it carries the seeding rule, the divisions and the
            // reseed flag that the flat pair cannot express. The flat keys are still written, but
            // FROM the block, so the two cannot disagree.
            const { formatFromEspnSettings } = await import("../league/index.js");
            const format = formatFromEspnSettings({ settings: s, teams: j.teams ?? [] });
            const playoffTeams = format.playoffTeams;
            const regWeeks = format.regWeeks;
            const before = getConfig(db);
            // align the app's format + scoring MODEL to the real league (values recompute on next `ff refresh`)
            setConfig(db, { scoring, slots: configSlots, budget, teams, scoring_rules: rules, playoffTeams, regWeeks, format, formatEspn: format } as never);
            const changed = scoring !== before.scoring || budget !== before.budget || teams !== before.teams || JSON.stringify(configSlots) !== JSON.stringify(before.slots) || JSON.stringify(rules) !== JSON.stringify(before.scoring_rules);
            shut();
            return { content: [{ type: "text", text: `synced "${s.name}" (league ${lg.league_id}, ${lg.season}): ${s.size} teams, ${ds.type ?? "?"} draft${ds.auctionBudget ? ` $${ds.auctionBudget}` : ""}, ${sc.scoringType}, ${scoring} scoring. My team: "${mineName ?? "?"}" (id ${mine?.id ?? "?"}). Roster: ${slotSummary}.${changed ? " Config updated to match -- run `ff refresh` to recompute values/tiers for this format." : ""}` }] };
          } catch (e) { await browser?.close().catch(() => {}); shut(); return { content: [{ type: "text", text: "sync error: " + String(e).slice(0, 140) }] }; }
        },
      ),
      tool(
        "read_league",
        "Read my REAL ESPN league live (not the local draft board): my roster with lineup slots, the standings, and draft status. Before the draft this shows an empty roster and 'draft not started'.",
        {},
        async () => {
          const { browser, page } = await rendererPage();
          if (!page) { await browser?.close().catch(() => {}); return { content: [{ type: "text", text: "app not available" }] }; }
          const db = openDb(dbPath); let closed = false; const shut = () => { if (!closed) { closed = true; try { db.close(); } catch { /* already closed */ } } };
          try {
            const lg = activeLeague(db);
            if (!lg) { shut(); await browser?.close().catch(() => {}); return { content: [{ type: "text", text: "no league known -- run discover_leagues then league_sync" }] }; }
            const j = await espnGet<any>(page, espnLeagueUrl(lg.season, lg.league_id, ["mTeam", "mRoster", "mSettings", "mStandings", "mDraftDetail"]));
            await browser?.close().catch(() => {});
            if (!j) { shut(); return { content: [{ type: "text", text: "could not read league (auth?)" }] }; }
            const teams = j.teams ?? [];
            const mine = teams.find((t: any) => t.id === Number(lg.team_id));
            const entries = mine?.roster?.entries ?? [];
            const roster = entries.map((e: any) => { const p = e.playerPoolEntry?.player ?? {}; return `${ESPN_SLOT[e.lineupSlotId] ?? e.lineupSlotId}: ${p.fullName ?? "?"} (${ESPN_POS[p.defaultPositionId] ?? "?"}${p.injuryStatus && p.injuryStatus !== "ACTIVE" ? " " + p.injuryStatus : ""})`; });
            if (entries.length) { // persist snapshot -- ready for the in-season tools
              const snap = new Date().toISOString();
              const up = db.prepare("INSERT OR REPLACE INTO roster (league_id, player_id, slot, is_starter, snapshot_at) VALUES (?,?,?,?,?)");
              db.transaction(() => { for (const e of entries) { const p = e.playerPoolEntry?.player ?? {}; const k = nameKey(p.fullName ?? ""); if (k) up.run(lg.league_id, k, ESPN_SLOT[e.lineupSlotId] ?? String(e.lineupSlotId), (e.lineupSlotId === 20 || e.lineupSlotId === 21) ? 0 : 1, snap); } })();
            }
            const standings = teams.map((t: any) => ({ name: t.name ?? `${t.location ?? ""} ${t.nickname ?? ""}`.trim(), w: t.record?.overall?.wins ?? 0, l: t.record?.overall?.losses ?? 0, pf: Math.round(t.record?.overall?.pointsFor ?? 0) }))
              .sort((a: any, b: any) => b.w - a.w || b.pf - a.pf);
            const drafted = j.draftDetail?.drafted ?? false; const inProg = j.draftDetail?.inProgress ?? false;
            shut();
            const draftLine = drafted ? "draft complete" : inProg ? "DRAFT IN PROGRESS" : "draft not started";
            const rosterBlock = roster.length ? `My roster (${roster.length}):\n` + roster.join("\n") : "My roster: empty (pre-draft)";
            const standBlock = "Standings:\n" + standings.slice(0, 16).map((t: any, i: number) => `${i + 1}. ${t.name} ${t.w}-${t.l} (${t.pf} pf)`).join("\n");
            return { content: [{ type: "text", text: `${lg.name ?? "league"} -- ${teams.length} teams -- ${draftLine}\n\n${rosterBlock}\n\n${standBlock}` }] };
          } catch (e) { await browser?.close().catch(() => {}); shut(); return { content: [{ type: "text", text: "read error: " + String(e).slice(0, 140) }] }; }
        },
      ),
      // --- IN-SEASON COPILOT: the decision surface, READ-ONLY.
      //
      // Nine verbs over ONE sim context (src/inseason/copilot.ts), reached through ONE dispatcher
      // (copilotActions.ts) that `ff copilot` also uses -- so a number the Assistant quotes and a
      // number a terminal prints are the same computation, and both are written to the action log
      // BEFORE they are returned (D3), even though this phase makes no ESPN writes at all. The
      // reason to log advice is that advice a human acts on is still the agent driving the team, and
      // when the write tools arrive an ESPN move will sit in the same log directly beneath the
      // recommendation that produced it.
      //
      // EVERY DESCRIPTION SAYS WHAT THE NUMBER MEANS AND WHERE IT IS WEAK. A model handed a bare
      // percentage will quote it as a fact; the returned JSON carries an `assumptions` block (real
      // vs generated schedule, trials, seeds, data stamp) and these descriptions tell the model to
      // read it. The pair is deliberate -- a field is only a caveat if the reader knows to look.
      ...(copilotTools(tool as never, dbPath) as never[]),
  ];
}

/**
 * The in-season tools, built from `COPILOT_VERBS` so this list cannot drift from the dispatcher.
 *
 * Split into its own function purely for length; it is spread into buildTools above, so TOOL_NAMES
 * still derives from the one surface and `test/mcp-surface.test.ts` still guards the whole of it.
 */
type ToolFn = (name: string, desc: string, schema: Record<string, z.ZodTypeAny>, handler: (a: Record<string, never>) => Promise<{ content: { type: "text"; text: string }[] }>) => unknown;
function copilotTools(tool: ToolFn, dbPath: string | undefined) {
  // One handler shape for all nine. The result is returned as its SUMMARY followed by the full JSON,
  // in that order: the summary already carries the caveat sentence, so a model that reads only the
  // first line still cannot quote the headline number naked.
  const call = (verb: string) => async (args: Record<string, unknown>) => {
    const { runCopilot } = await import("../inseason/copilotActions.js");
    try {
      const run = await runCopilot(verb as never, (args ?? {}) as never, { dbPath });
      return { content: [{ type: "text" as const, text: `${run.summary}\n\n${JSON.stringify(run.result)}` }] };
    } catch (e) {
      // A failure is ALSO logged (runCopilot marks the row `failed` before rethrowing), so a
      // recommendation that could not be produced is visible in the log rather than absent from it.
      return { content: [{ type: "text" as const, text: `copilot ${verb} failed: ${String(e instanceof Error ? e.message : e).slice(0, 400)}` }] };
    }
  };
  const SCHEDULE = z.enum(["real", "generated", "auto"]).optional()
    .describe("REAL uses the league's actual matchups and needs the desktop app running (it FAILS rather than silently substituting); GENERATED is deterministic and offline but its playoff seeding is not this league's; AUTO (default) prefers real and reports which it used in assumptions.schedule.");
  const TRIALS = z.number().optional().describe("Monte Carlo trials. More trials narrow the noise floor, which is returned with the result -- a difference smaller than the floor is not a difference.");
  const SEED = z.number().optional().describe("random seed; results are compared under common random numbers, so leave it alone unless re-measuring.");

  return [
    tool(
      "season_odds",
      "PLAYOFF AND CHAMPIONSHIP ODDS for every team in my league from the rosters that actually exist, mine flagged, plus THE CURRENT OBJECTIVE REGIME. Returns each team's playoff%, title%, mean wins, mean points and expected optimal-lineup points in the league PLAYOFF WEEKS (weeks 14-16 under the current format block), with the conservation checks (titles sum to 1, playoff shares sum to the playoff field) -- it REFUSES to return a table that fails one. LEAD WITH THE PLAYOFF NUMBER and say so: scored against 114 real team-seasons this simulator BEATS a uniform baseline on the playoff berth (Brier 0.2370 vs 0.2451) and LOSES to it on the champion (0.0659 vs 0.0652), so the title figure is reported alongside and is not a number to plan on. `objective.regime` says whether the seed is secure (playoff probability at or above the threshold, default 70%, derived from the calibration) -- in the secure regime every other tool ranks moves on the league PLAYOFF WEEKS (weeks 14-16 under the current format block) instead. ALWAYS report assumptions.schedule too: a generated schedule is not this league's seeding.",
      { schedule: SCHEDULE, trials: TRIALS, seed: SEED },
      call("season_odds"),
    ),
    tool(
      "lineup_recommend",
      "THIS WEEK'S BEST LEGAL STARTING LINEUP, with everyone who cannot play named and why (bye, or ruled OUT/IR/PUP in the store). QUESTIONABLE players are still started -- they play more often than not. Weekly points come through the PER-POSITION serve table (`WEEKLY_SERVE`): the matchup-aware streaming model at QB, K and DST, and the season-line floor -- season projection over 17, no matchup, no form, no weather -- at RB, WR and TE, because no candidate passed the gate there. Do not present the RB/WR/TE numbers as matchup-aware. It REFUSES to return a lineup that starts a man on a bye or ruled out. `objective` picks WHICH QUESTION: the default `expected` maximises expected points; `winprob` maximises P(beating this week's real opponent) and is NOT the default because a 2018-2025 replay measured it at -0.59 percentage points of team-weeks won -- quote that number whenever you use it, and note it REFUSES a generated schedule rather than inventing an opponent. If you do not pass `week`, the result says where the week came from -- the store often does not know, and `weekSource: default` means ASK THE USER which week they mean.",
      {
        week: z.number().optional().describe("NFL week to set a lineup for. Pass it: the store usually cannot determine the current week."),
        objective: z.enum(["expected", "winprob"]).optional().describe("what to maximise. Default \"expected\" (expected points). \"winprob\" maximises P(beating this week's actual opponent); it needs the REAL schedule and measured -0.59pp of team-weeks won in replay, so it is a thing to show, not a thing to default to."),
        schedule: SCHEDULE,
      },
      call("lineup_recommend"),
    ),
    tool(
      "waiver_targets",
      "WAIVER CLAIMS SCORED BY THE CHANGE IN MY PLAYOFF PROBABILITY -- every add paired with every legal drop, under common random numbers. Each row carries THREE numbers and you must name which you are quoting: `playoffsPp` is the primary (the factor the simulator has measured skill on), `playoffWeekPts` is expected optimal-lineup points in the league PLAYOFF WEEKS (weeks 14-16 under the current format block), and `titlePp` is reported alongside and never decides. `rankValue` is whichever the current regime ranks on -- see `objective`. A claim is two decisions and the DROP is the one people get wrong, so each add lists its drop options with their own deltas. Drops that would leave a mandatory slot unfillable (dropping the only kicker) are REFUSED and named, not scored. Compare every delta against noiseFloorPp, which is computed for the PRIMARY quantity: a target that does not clear it is not distinguishable from doing nothing. The FAAB figure is a STATED RULE OF THUMB priced per point of PLAYOFF probability, not a fitted value -- say so when you quote it.",
      { schedule: SCHEDULE, trials: TRIALS, seed: SEED, limit: z.number().optional().describe("how many free agents to evaluate (default 4); each costs simulation time"), positions: z.array(z.string()).optional().describe("restrict the add candidates, e.g. [\"RB\"]") },
      call("waiver_targets"),
    ),
    tool(
      "trade_check",
      "SCORE ONE NAMED TRADE OFFER FROM BOTH SIDES, primarily in PLAYOFF probability, with playoff-week points and title probability reported alongside. Both sides always, and not out of fairness: a proposal the other manager loses on is simply rejected, so `them.playoffsPp` is what separates 'this helps us' from 'this is proposable'. The verdict is on the playoff delta because that is the factor this simulator has been measured to predict; quoting the title delta as the reason would be quoting the factor it cannot. Give and get are player names; every `get` must sit on ONE opponent's roster and every `give` on mine. Reports each side's legality (a trade that leaves either roster unable to field a lineup is flagged) and the noise floor.",
      { give: z.array(z.string()).describe("players I send"), get: z.array(z.string()).describe("players I receive -- all from the same opponent"), schedule: SCHEDULE, trials: TRIALS, seed: SEED },
      call("trade_check"),
    ),
    tool(
      "trade_finder",
      "FIND ONE-FOR-ONE TRADES WORTH PROPOSING: balanced on CONSENSUS MARKET VALUE first, then ranked by the change in my PLAYOFF probability (or, once the seed is secure, by expected points in the league PLAYOFF WEEKS (weeks 14-16 under the current format block) -- `objective` says which). The value gate is the important half -- filtering on the partner's simulated equity instead once produced 'my WR4 for Christian McCaffrey' as a recommendation, which passes the simulator and no human accepts. `mutual: true` means it clears the noise floor for BOTH teams and is the only kind worth actually sending. Players with no consensus value are SKIPPED and counted, never priced at zero.",
      { schedule: SCHEDULE, trials: TRIALS, seed: SEED, limit: z.number().optional().describe("how many candidate deals to simulate (default 8)"), maxGap: z.number().optional().describe("consensus-value band, default 0.15 = the two sides within 15% of each other"), positions: z.array(z.string()).optional().describe("restrict what I am shopping FOR") },
      call("trade_finder"),
    ),
    tool(
      "handcuffs",
      "WHAT EACH BACKUP SCORES IF THE MAN AHEAD OF HIM MISSES A WEEK -- a conditional POINTS payoff, not a probability, and `objective` says so rather than dressing it as one. Ranked by that conditional payoff, not by the lift, because ranking on lift is degenerate (its coefficient on the backup's own value is negative, so it returns the worst player behind the best starter). Rows are flagged `ours` and `rostered`. A handcuff is worth about the same once activated whoever he backs up; the reason to prefer an elite team's handcuff is that he is CHEAPER for the same payoff, not that his ceiling is higher. `contested: true` means the published depth chart and our projection disagree, i.e. a genuine timeshare -- often the most useful row on the page.",
      { positions: z.array(z.string()).optional().describe("positions to scan, default [\"RB\"]"), week: z.number().optional().describe("current week, so the EV is over the REMAINING horizon rather than a full season"), freeOnly: z.boolean().optional().describe("only men nobody in the league rosters"), schedule: SCHEDULE },
      call("handcuffs"),
    ),
    tool(
      "depth_risk",
      "WHAT LOSING ONE OF MY PLAYERS WOULD COST, in percentage points of PLAYOFF probability, and who insures him. `costPp` is POSITIVE when we are worse off without him; `costPlayoffWeekPts` and `costTitlePp` are the same loss in the league PLAYOFF WEEKS (weeks 14-16 under the current format block) and in championship probability, reported alongside. The insurance list deliberately mixes free agents with players on other rosters and shortlists them SEPARATELY -- ranking them together on projection fills the list with the fifteen best starters in the league and never shows a claim, which is not an answer to 'my back is hurt'. A trade-finder ranked on points cannot see this: it prices a backup at what he adds to a HEALTHY lineup, which is usually zero.",
      { player: z.string().describe("a player on MY roster"), schedule: SCHEDULE, trials: TRIALS, seed: SEED, limit: z.number().optional().describe("how many insurance candidates (default 4)") },
      call("depth_risk"),
    ),
    tool(
      "power_rankings",
      "THE LEAGUE RANKED BY BEST STARTING LINEUP on OUR projections, with each team's simulated playoff% and title% beside it (the same run season_odds returns, so the two cannot disagree). HONEST LIMIT, state it when you quote this: it ranks teams by the same board we bid from, so it is not an independent grade of our own roster -- if our projection is wrong about a player it is wrong here the same way. Read the SPREAD between teams rather than any single absolute.",
      { schedule: SCHEDULE, trials: TRIALS, seed: SEED },
      call("power_rankings"),
    ),
    tool(
      "playoff_sos",
      "STRENGTH OF SCHEDULE FOR THE FANTASY PLAYOFF WEEKS -- the only weeks that decide a title. Opponent quality is solved from the POSTED BETTING LINES as a simultaneous system (a team's average spread is confounded by whom it played; this is not), because prior-year defense-vs-position was measured and does not carry year to year. NEGATIVE sos = weaker opponents = better. `costPerWeek` is the MEASURED fantasy swing per position and is under a point a week for a typical starter: it breaks ties between comparable players and does NOT overturn a projection gap. Check `pricedPlayoffGames` -- early in the season most playoff-week games have no line yet and the number is the market's current read projected forward.",
      { schedule: SCHEDULE },
      call("playoff_sos"),
    ),
    tool(
      "stream_recommend",
      "WHOM TO START OR ADD AT ONE POSITION THIS WEEK, out of my own men AND everyone nobody in the league rosters. This is the question lineup_recommend cannot answer: it sets the best eleven out of the twelve I already own, and cannot say 'your defence is on bye, claim this one'. Returns my players and the streamable pool ranked by the WEEKLY projection with p10/p90 and, where the serving model publishes one, P(he scores nothing) -- plus the start/sit, and the add/drop with the change in EXPECTED POINTS THIS WEEK. THE UNIT IS POINTS AND NOT PLAYOFF PROBABILITY, and say so: a single slot on a single Sunday has no season simulation behind it and the noise floor of one would swamp the effect. Drops that leave a mandatory slot unfillable are REFUSED and named, not scored. READ `artifactByPos` AND QUOTE IT: the streaming gate is applied per position, so at some positions this is the matchup-aware streaming model and at others it is the same season-line floor the lineup is served from, which has no matchup, no form and no weather in it. A position with no rows returns empty lists and says so in assumptions.basisNote -- that is 'we cannot answer', not 'do nothing'.",
      {
        pos: z.string().describe("the ONE position to stream: QB, RB, WR, TE, K or DST"),
        week: z.number().optional().describe("NFL week. Pass it: the store usually cannot determine the current week, and the result says where the week came from."),
        limit: z.number().optional().describe("how many pool rows to return (default 8); the ranking is over all of them"),
        schedule: SCHEDULE,
      },
      call("stream_recommend"),
    ),
  ];
}

/** Every tool name on the control surface, derived from the surface itself (never hand-typed -- an
 *  enumerated copy silently stops covering tools added later). Building the array is pure; the
 *  handlers only touch the DB when called, so throwaway args are fine. */
export const TOOL_NAMES: string[] = buildTools(undefined, 0).map((t) => t.name);

export function boardServer(dbPath: string | undefined, season: number) {
  return createSdkMcpServer({
    name: "ff-draft",
    version: "1.0.0",
    tools: buildTools(dbPath, season),
  });
}

// The app's RENDERER page (file://) over CDP. We drive the embedded ESPN webview THROUGH it: the
// webview guest is a CDP target of type "webview" (playwright won't wrap it as a page), but the
// renderer holds the <webview> element whose loadURL/executeJavaScript we can call. Showing Live
// Draft first both attaches the guest and lets the user watch the agent browse (copresent).
async function rendererPage(): Promise<{ browser: import("playwright-core").Browser | null; page: import("playwright-core").Page | null }> {
  const port = process.env.FF_CDP_PORT ?? "9223";
  try {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file://")) ?? null;
    return { browser, page };
  } catch { return { browser: null, page: null }; }
}
// Show Live Draft (attaches the webview) and navigate it to url; returns the guest's url+title.
async function wvNavigate(page: import("playwright-core").Page, url: string): Promise<{ url: string; title: string }> {
  await page.evaluate((u) => { const w = window as unknown as { setView?: (v: string) => void }; if (w.setView) w.setView("live"); const wv = document.getElementById("espnview") as unknown as { loadURL?: (u: string) => void }; if (wv?.loadURL) wv.loadURL(u); }, url);
  await page.waitForTimeout(4500);
  return await page.evaluate(() => { const wv = document.getElementById("espnview") as unknown as { getURL?: () => string; getTitle?: () => string }; return { url: wv?.getURL ? wv.getURL() : "", title: wv?.getTitle ? wv.getTitle() : "" }; });
}
// Run JS inside the webview guest and return the result (string).
async function wvEval(page: import("playwright-core").Page, js: string): Promise<string> {
  return await page.evaluate(async (code) => { const wv = document.getElementById("espnview") as unknown as { executeJavaScript?: (c: string) => Promise<string> }; if (!wv?.executeJavaScript) return ""; try { return await wv.executeJavaScript(code); } catch { return ""; } }, js);
}
// Authenticated ESPN fantasy READ through the app's logged-in webview: the fetch runs in the guest's
// fantasy.espn.com page context, so its espn_s2/SWID cookies ride along (credentials:'include'). The
// league API lives on lm-api-reads.* which honors CORS+credentials from the fantasy.espn.com origin.
async function espnGet<T = unknown>(page: import("playwright-core").Page, url: string): Promise<T | null> {
  const cur = await wvEval(page, "location.href");
  if (!/fantasy\.espn\.com/.test(cur)) await wvNavigate(page, "https://fantasy.espn.com/football/");
  const raw = await wvEval(page, `fetch(${JSON.stringify(url)},{credentials:'include'}).then(function(r){return r.ok?r.text():('HTTP '+r.status)}).catch(function(e){return 'ERR '+e.message})`);
  if (!raw || raw.startsWith("HTTP") || raw.startsWith("ERR")) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}
// My SWID (identifies my team among the league's owners), read from the guest's cookies.
async function espnSwid(page: import("playwright-core").Page): Promise<string> {
  return await wvEval(page, "(document.cookie.match(/SWID=([^;]+)/)||[])[1]||''");
}
// The active league row (current season preferred), as discovered/synced into the store.
function activeLeague(db: import("better-sqlite3").Database): { league_id: string; season: number; team_id: string | null; name: string | null } | undefined {
  return (db.prepare("SELECT league_id, season, team_id, name FROM league WHERE season=@s ORDER BY last_synced_at DESC LIMIT 1").get({ s: new Date().getFullYear() })
    ?? db.prepare("SELECT league_id, season, team_id, name FROM league ORDER BY last_synced_at DESC LIMIT 1").get()) as any;
}

const SYSTEM = `You are a fantasy football draft copilot for a 16-team, half-PPR $200 AUCTION with 12 roster slots (QB, RB, WR, TE, 2x FLEX [RB/WR/TE], DST, K, and 4 bench). Use read_needs for the live open slots + max bid rather than assuming.
Use the tools to read the live value board -- never guess players or numbers.
"our_value" is OUR auction $ valuation. Each row gives vsECR and vsESPN = the consensus rank minus OUR rank: a POSITIVE vsECR/vsESPN means we rank the player EARLIER than the room (a VALUE -- you can win them below their real worth); NEGATIVE means the room likes them more than we do (NOT a value). Judge "value" strictly by these signs -- a bigger positive number is a bigger value. Never call a player with negative vsECR/vsESPN a value.
Answer concisely and specifically: name the players, their $ value, and vsECR/vsESPN, with a one-line reason. Prefer a short ranked list over prose.
You can also ACT on my roster: draft_player / drop_player / set_price change my team (every change is recorded in the action log).
You can read and TUNE the strategy levers: read_levers shows every knob (tier break, K/DST cap, starter/bench reserve, max share, aggressiveness, outbid premium, sleeper cutoff) with its range; set_lever changes one (clamped, logged). Board levers (tierBreak, maxKDst) need a data refresh to show; bidding/UI levers apply immediately. When I ask to be more/less aggressive, value depth over studs, widen tiers, cap kickers, etc., translate that into the right lever(s) and set them. Only act when I clearly ask you to; confirm what you changed. Use read_needs to see open roster slots + max legal bid before recommending or making a pick, and read_actions to review what you've done.
You can freely BROWSE my ESPN account through my logged-in session: navigate(url) + read_page() drive the app's embedded browser, and discover_leagues finds my real leagues/teams/seasons by reading page links (prefer this over guessing IDs).
For my REAL league (not the local draft board): discover_leagues -> league_sync reads the actual league rules from my logged-in session (size, scoring incl. PPR/Half/Standard, roster slots, my team) and stores them; read_league shows my live roster, standings, and draft status. Run league_sync before relying on scoring-specific data. Writing to the league (setting lineups, waivers, trades) is NOT yet available -- only reads.

IN-SEASON DECISIONS -- season_odds, lineup_recommend, waiver_targets, trade_check, trade_finder, handcuffs, depth_risk, power_rankings, playoff_sos. Prefer these over reasoning from the board for any in-season question: they run the season simulator over the real sixteen rosters, and almost every one answers in the SAME unit -- the change in MY PLAYOFF probability. THE UNIT CHANGED AND IT MATTERS WHEN YOU QUOTE IT: scored against 114 real team-seasons of this league the simulator beats a uniform baseline on the playoff berth and LOSES to it on the champion, so P(playoffs) is the number that decides and P(title) travels beside it as context. Every result carries an "objective" block naming the primary quantity and the regime; state it when you quote a delta. Points cannot see a mandatory slot going empty or that this league pays on a 7-of-16 threshold; these can.
Three rules when you quote one of them. (1) NEVER quote a number without its caveat: every result carries an "assumptions" block and the tool returns a one-line summary that already ends with it -- say whether the schedule was REAL or GENERATED, and how many trials. A generated schedule is not this league's playoff seeding. (2) NEVER rank two options whose gap is smaller than the returned noiseFloorPp; that is reading noise as a preference, and say so instead of picking. (3) Trust the PLAYOFF number more than the TITLE number.
These are RECOMMENDATIONS ONLY -- nothing here changes my ESPN team, so present the move and let me make it. Every call is recorded in the action log before you see the answer, so read_actions shows what you have advised as well as what you have done.`;

export async function agentAsk(question: string, opts: { dbPath?: string; season?: number; onEvent: (m: unknown) => void }) {
  const season = opts.season ?? new Date().getFullYear();
  const server = boardServer(opts.dbPath, season);
  for await (const m of query({
    prompt: question,
    options: {
      mcpServers: { "ff-draft": server },
      // Derived from the surface, not retyped: a hand-listed copy silently omits any tool added
      // later (the omitted tool is simply never offered, with no error anywhere).
      allowedTools: TOOL_NAMES.map((n) => `mcp__ff-draft__${n}`),
      systemPrompt: SYSTEM,
      maxTurns: 8,
      permissionMode: "bypassPermissions",
    },
  })) {
    // record token usage per turn (feeds the budget governor)
    const mm = m as { type?: string; usage?: Record<string, number>; message?: { usage?: Record<string, number> } };
    const u = mm.usage ?? mm.message?.usage;
    if (mm.type === "result" && u) {
      try {
        const db = openDb(opts.dbPath);
        appendUsage(db, { runType: "chat", input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens });
        db.close();
      } catch { /* best-effort */ }
    }
    opts.onEvent(m);
  }
}
