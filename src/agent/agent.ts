// The draft copilot: a Claude Agent SDK session (subscription auth via the machine's `claude` login,
// no API key). Only our MCP tools are exposed (no built-in Bash/Read/etc.). It can READ the store,
// ACT on my roster (draft/drop/set_price -- each logged to action_log, plan->act->verify), and
// freely NAVIGATE ESPN through the app's OWN authenticated webview (navigate/read_page/
// discover_leagues, driven via the renderer). No bro -- everything goes through the app session.
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { openDb, getConfig, setConfig, appendUsage, getMyRoster, setMyRoster, logAction, completeAction, recentActions, type RosterEntry } from "../db/db.js";
import { nameKey } from "../draft/values.js";
import { DEFAULT_SCORING, ESPN_STAT_TO_RULE, type ScoringRules } from "../draft/scoring.js";
import { LEVER_META, clampLever, applyLevers } from "../draft/levers.js";

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

function boardServer(dbPath: string | undefined, season: number) {
  return createSdkMcpServer({
    name: "ff-draft",
    version: "1.0.0",
    tools: [
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
            const rules: ScoringRules = { ...DEFAULT_SCORING };
            for (const it of sc.scoringItems ?? []) { const key = ESPN_STAT_TO_RULE[it.statId]; if (key) rules[key] = Number(it.points ?? it.pointsOverrides?.["16"] ?? 0); }
            db.prepare("UPDATE league SET name=@n, season=@se, scoring_json=@sj, team_id=@tid, last_synced_at=@now WHERE league_id=@lid")
              .run({ n: s.name ?? null, se: lg.season, sj: JSON.stringify({ scoringType: sc.scoringType, ppr: recPts, draftType: ds.type, auctionBudget: ds.auctionBudget, slots, size: s.size, rules }), tid: mine ? String(mine.id) : lg.team_id, now: new Date().toISOString(), lid: lg.league_id });
            const before = getConfig(db);
            // align the app's format + scoring MODEL to the real league (values recompute on next `ff refresh`)
            setConfig(db, { scoring, slots: configSlots, budget, teams, scoring_rules: rules });
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
    ],
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
For my REAL league (not the local draft board): discover_leagues -> league_sync reads the actual league rules from my logged-in session (size, scoring incl. PPR/Half/Standard, roster slots, my team) and stores them; read_league shows my live roster, standings, and draft status. Run league_sync before relying on scoring-specific data. Writing to the league (setting lineups, waivers, trades) is NOT yet available -- only reads.`;

export async function agentAsk(question: string, opts: { dbPath?: string; season?: number; onEvent: (m: unknown) => void }) {
  const season = opts.season ?? new Date().getFullYear();
  const server = boardServer(opts.dbPath, season);
  for await (const m of query({
    prompt: question,
    options: {
      mcpServers: { "ff-draft": server },
      allowedTools: ["mcp__ff-draft__read_board", "mcp__ff-draft__player_detail", "mcp__ff-draft__read_my_team", "mcp__ff-draft__read_needs", "mcp__ff-draft__draft_player", "mcp__ff-draft__drop_player", "mcp__ff-draft__set_price", "mcp__ff-draft__read_actions", "mcp__ff-draft__navigate", "mcp__ff-draft__read_page", "mcp__ff-draft__discover_leagues", "mcp__ff-draft__league_sync", "mcp__ff-draft__read_league", "mcp__ff-draft__read_levers", "mcp__ff-draft__set_lever"],
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
