// Smoke-test the IN-SEASON half of the stdio MCP surface the way a real client drives it: spawn
// `ff mcp`, speak JSON-RPC over stdin/stdout, list the tools, and actually CALL season_odds.
//
//   node scripts/copilot-mcp-smoke.mjs
//
// WHY A SECOND SMOKE SCRIPT. scripts/mcp-smoke.mjs proves the transport by calling read_board, a
// pure SQLite read. The copilot tools are a different animal: each one builds a full sim context and
// runs a Monte Carlo, so "the server lists nine new tools" says nothing about whether any of them
// can execute. A tool that lists and cannot run looks identical from outside -- which is the whole
// reason this repo insists on calling one for real rather than counting names.
//
// It also asserts the two properties the tool descriptions promise: that the answer carries its
// assumptions, and that the call left a row in the action log (D3).
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

const COPILOT_TOOLS = [
  "season_odds", "lineup_recommend", "waiver_targets", "trade_check",
  "trade_finder", "handcuffs", "depth_risk", "power_rankings", "playoff_sos",
];

const child = spawn("npx", ["tsx", "src/ff.ts", "mcp"], { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { console.log("NON-JSON ON STDOUT (would corrupt the protocol):", line.slice(0, 120)); continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on("data", (d) => process.stderr.write("[server] " + d.toString()));

let nextId = 1;
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 180000);
});
const fail = (m) => { console.log("FAIL: " + m); child.kill(); process.exit(1); };

const before = (() => {
  const db = new Database("data/ff.db", { readonly: true });
  const n = db.prepare("SELECT count(*) n FROM action_log").get().n;
  db.close();
  return n;
})();

const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ff-copilot-smoke", version: "1.0.0" } });
if (init.error) fail("initialize: " + JSON.stringify(init.error));
console.log("initialize OK -> server:", JSON.stringify(init.result?.serverInfo));
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const list = await rpc("tools/list", {});
if (list.error) fail("tools/list: " + JSON.stringify(list.error));
const tools = list.result?.tools ?? [];
const names = tools.map((t) => t.name);
console.log(`tools/list OK -> ${names.length} tools`);
const missing = COPILOT_TOOLS.filter((t) => !names.includes(t));
if (missing.length) fail(`the in-season surface is incomplete: missing ${missing.join(", ")}`);
console.log(`all ${COPILOT_TOOLS.length} copilot tools present: ${COPILOT_TOOLS.join(", ")}`);

// A description that does not say what the number MEANS is how a model ends up quoting a
// probability as a fact. Every copilot tool's description is checked for length, not just presence.
for (const t of tools.filter((x) => COPILOT_TOOLS.includes(x.name))) {
  if (!t.inputSchema) fail(`${t.name} has no inputSchema`);
  if (!t.description || t.description.length < 200) fail(`${t.name} has a description too thin to carry its caveats (${t.description?.length ?? 0} chars)`);
}
console.log("every copilot tool carries an inputSchema and a description that states its caveats");

// EXECUTE one for real. Generated schedule so this runs with the app closed.
const t0 = Date.now();
const call = await rpc("tools/call", { name: "season_odds", arguments: { schedule: "generated", trials: 400 } });
if (call.error) fail("tools/call season_odds: " + JSON.stringify(call.error));
const text = call.result?.content?.[0]?.text ?? "";
console.log(`tools/call season_odds(generated, 400) OK in ${((Date.now() - t0) / 1000).toFixed(1)}s ->`);
console.log("    " + text.split("\n")[0]);
if (/failed/.test(text.split("\n")[0])) fail("the tool returned a failure: " + text.slice(0, 300));

let payload;
try { payload = JSON.parse(text.split("\n\n").slice(1).join("\n\n")); } catch { fail("the tool did not return parseable JSON after its summary"); }
if (!payload.assumptions) fail("the result carries no assumptions block -- a number without its caveats");
if (payload.assumptions.schedule !== "generated") fail(`assumptions.schedule says ${payload.assumptions.schedule}, we asked for generated`);
if (!payload.invariants?.every((c) => c.ok)) fail("conservation checks did not all pass: " + JSON.stringify(payload.invariants));
console.log("    assumptions:", JSON.stringify(payload.assumptions));
console.log("    invariants:", payload.invariants.map((c) => `${c.ok ? "OK" : "FAIL"} ${c.name}`).join(" | "));

const after = (() => {
  const db = new Database("data/ff.db", { readonly: true });
  const r = db.prepare("SELECT count(*) n FROM action_log").get().n;
  const last = db.prepare("SELECT action, status FROM action_log ORDER BY id DESC LIMIT 1").get();
  db.close();
  return { n: r, last };
})();
if (after.n <= before) fail(`the call left no action_log row (${before} -> ${after.n}) -- D3 says every recommendation is recorded`);
if (after.last.action !== "season_odds" || after.last.status !== "recommended") fail("the logged row is not the recommendation: " + JSON.stringify(after.last));
console.log(`action_log ${before} -> ${after.n}, last row: ${after.last.action} / ${after.last.status}`);

child.kill();
console.log("\nCOPILOT MCP STDIO SMOKE PASSED");
