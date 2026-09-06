// LIVE DRAFT BOARD -- the whole room at a glance, for spotting automation trouble.
//
// Read-only: consumes the draft log `auto-draft` already writes (every ~4 ticks) plus
// data/live-state.json. It touches no browser, opens no CDP session, and never writes -- so it is
// safe to run repeatedly DURING a live draft, unlike anything that edits app/renderer (electronmon
// hot-reloads the renderer, and the ESPN webview lives inside it).
//
//   node scripts/draft-board.mjs            one snapshot
//   node scripts/draft-board.mjs --watch    refresh every 10s
import { readFileSync, readdirSync, statSync } from "node:fs";

const OUR_TEAM = process.env.FF_OUR_TEAM ?? '"That" King Henry';
const ROSTER_SLOTS = 12;
const BUDGET = 200;
const STARTERS = { QB: 1, RB: 1, WR: 1, TE: 1, K: 1, DST: 1, FLEX: 2 }; // + 4 bench

const newestLog = () => {
  const f = readdirSync("data").filter((x) => x.startsWith("draft-log-")).map((x) => "data/" + x);
  if (!f.length) return null;
  return f.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
};
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const money = (n) => "$" + Math.round(Number(n) || 0);
const pad = (s, n) => String(s).slice(0, n).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

function render() {
  const lf = newestLog();
  const log = lf ? readJson(lf) : null;
  const live = readJson("data/live-state.json");
  if (!log) { console.log("no draft log yet -- is auto-draft running?"); return; }

  const picks = log.picks || [];
  const teams = log.teams || 16;
  const totalMoney = teams * BUDGET;
  const totalSlots = teams * ROSTER_SLOTS;
  const spent = picks.reduce((a, p) => a + (p.price || 0), 0);

  // Per-team aggregation: spend, picks, positional shape.
  const by = new Map();
  for (const p of picks) {
    const k = p.fantasyTeam || p.team || "?";
    if (!by.has(k)) by.set(k, { spent: 0, n: 0, pos: {} });
    const t = by.get(k);
    t.spent += p.price || 0; t.n++;
    t.pos[p.pos] = (t.pos[p.pos] || 0) + 1;
  }

  const ageSec = live?.updated ? Math.round((Date.now() - Date.parse(live.updated)) / 1000) : null;
  console.clear?.();
  console.log(`\n=== DRAFT BOARD  ${new Date().toLocaleTimeString()} ${ageSec != null ? `(agent data ${ageSec}s old${ageSec > 45 ? "  <<< STALE, CHECK THE BOT" : ""})` : "(no agent state)"}`);

  // PACE. Money burns far faster than picks in this room -- that gap IS the strategy's thesis, so
  // seeing it directly tells you whether the "wait for the middle" plan is playing out or not.
  const moneyPct = Math.round((spent / totalMoney) * 100);
  const pickPct = Math.round((picks.length / totalSlots) * 100);
  console.log(`PACE  picks ${picks.length}/${totalSlots} (${pickPct}%)   money ${money(spent)}/${money(totalMoney)} (${moneyPct}%)   ` +
    `${moneyPct > pickPct + 10 ? `FRONT-LOADED by ${moneyPct - pickPct}pp -- studs going now, value comes later` : "even pace"}` +
    `   infl ${live?.liveInflation != null ? live.liveInflation.toFixed(2) : "--"}`);

  // US
  const us = by.get(OUR_TEAM) || { spent: 0, n: 0, pos: {} };
  const ourLeft = BUDGET - us.spent, ourOpen = ROSTER_SLOTS - us.n;
  const roomLeft = totalMoney - spent - ourLeft, roomOpen = totalSlots - picks.length - ourOpen;
  const ourPer = ourOpen > 0 ? ourLeft / ourOpen : 0;
  const roomPer = roomOpen > 0 ? roomLeft / roomOpen : 0;
  console.log(`US    ${us.n}/${ROSTER_SLOTS} filled  ${money(us.spent)} spent  ${money(ourLeft)} left  ` +
    `| ${money(ourPer.toFixed(0))}/slot vs room ${money(roomPer.toFixed(0))}/slot ` +
    `${roomPer > 0 && ourPer / roomPer > 1.5 ? `(we are ${(ourPer / roomPer).toFixed(1)}x richer -- SPEND)` : ""}`);
  if (live?.us?.roster?.length) {
    console.log("      " + live.us.roster.map((r) => `${r.slot}:${String(r.player).split(" ").pop()} ${money(r.price)}`).join("  "));
  }

  // THE ROOM. Needs = slots left; a team with money AND many slots is your competition for the
  // middle rounds, which is exactly when this strategy intends to buy.
  console.log(`\n${pad("TEAM", 26)} ${rpad("SPENT", 6)} ${rpad("LEFT", 6)} ${rpad("PICKS", 6)} ${rpad("$/SLOT", 7)}  SHAPE`);
  const rows = [...by.entries()].map(([name, t]) => {
    const left = BUDGET - t.spent, open = ROSTER_SLOTS - t.n;
    return { name, ...t, left, open, per: open > 0 ? left / open : 0 };
  }).sort((a, b) => b.left - a.left);
  for (const r of rows) {
    const shape = ["QB", "RB", "WR", "TE", "K", "DST"].filter((p) => r.pos[p]).map((p) => `${p}${r.pos[p]}`).join(" ");
    const mark = r.name === OUR_TEAM ? " <<" : "";
    console.log(`${pad(r.name, 26)} ${rpad(money(r.spent), 6)} ${rpad(money(r.left), 6)} ${rpad(`${r.n}/12`, 6)} ${rpad(money(r.per.toFixed(0)), 7)}  ${shape}${mark}`);
  }

  // Recent action + the current decision, so a wrong-looking pass is visible immediately.
  const recent = picks.slice(-8).reverse();
  if (recent.length) {
    console.log(`\nLAST ${recent.length} PICKS`);
    for (const p of recent) console.log(`  ${rpad(money(p.price), 5)}  ${pad(p.name, 24)} ${pad(p.pos, 4)} -> ${p.fantasyTeam || p.team}`);
  }
  const d = live?.decision, b = live?.onBlock;
  if (b?.player) {
    console.log(`\nON THE BLOCK  ${b.player} (${b.pos})  offer ${money(b.currentOffer)}  ` +
      `our cap ${d ? money(d.cap) : "--"}  => ${d ? d.action.toUpperCase() : "--"}   ${d?.reason ?? ""}`);
  }
  const ck = live?.clicks;
  if (ck?.attempts) {
    const pct = Math.round((ck.fails / ck.attempts) * 100);
    console.log(`CLICKS  ${ck.attempts - ck.fails}/${ck.attempts} landed${pct >= 10 ? `  <<< ${pct}% FAILING` : ""}`);
  }
}

render();
if (process.argv.includes("--watch")) setInterval(render, 10000);
