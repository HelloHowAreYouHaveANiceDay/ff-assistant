// Smoke-test the stdio MCP surface the way a real client drives it: spawn `ff mcp`, speak JSON-RPC
// over stdin/stdout, list the tools, and CALL one for real. Proves the transport is wired and the
// handlers execute -- a server that lists tools but cannot run one looks identical from outside.
//
// Run: node scripts/mcp-smoke.mjs
import { spawn } from "node:child_process";

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
  setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60000);
});

const fail = (m) => { console.log("FAIL: " + m); child.kill(); process.exit(1); };

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "ff-mcp-smoke", version: "1.0.0" },
});
if (init.error) fail("initialize: " + JSON.stringify(init.error));
console.log("initialize OK -> server:", JSON.stringify(init.result?.serverInfo));
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const list = await rpc("tools/list", {});
if (list.error) fail("tools/list: " + JSON.stringify(list.error));
const names = (list.result?.tools ?? []).map((t) => t.name).sort();
console.log(`tools/list OK -> ${names.length} tools: ${names.join(", ")}`);

// Every tool must carry a description and an inputSchema, or a client cannot present it.
const bad = (list.result?.tools ?? []).filter((t) => !t.description || !t.inputSchema);
if (bad.length) fail(`${bad.length} tool(s) missing description/inputSchema: ${bad.map((t) => t.name).join(", ")}`);
console.log("all tools carry description + inputSchema");

// Actually CALL one (read-only) -- listing proves registration, not execution.
const call = await rpc("tools/call", { name: "read_board", arguments: { pos: "TE", limit: 3 } });
if (call.error) fail("tools/call read_board: " + JSON.stringify(call.error));
const text = call.result?.content?.[0]?.text ?? "";
console.log("tools/call read_board(TE,3) OK ->");
console.log(text.split("\n").map((l) => "    " + l).join("\n"));
if (!text || text === "none") fail("read_board returned nothing -- the DB is not reachable from the server");

child.kill();
console.log("\nMCP STDIO SMOKE PASSED");
