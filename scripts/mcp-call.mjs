// Call ONE tool on the stdio MCP control surface -- the same surface Claude Code drives, exercised
// from a shell. Lets you drive/debug the app through MCP without an MCP client, and makes a mock
// draft reproducible as a script.
//
//   node scripts/mcp-call.mjs read_board '{"pos":"TE","limit":5}'
//   node scripts/mcp-call.mjs navigate '{"url":"https://fantasy.espn.com/football/mockdraftlobby"}'
//   node scripts/mcp-call.mjs --list
import { spawn } from "node:child_process";

const [, , toolArg, argsArg] = process.argv;
if (!toolArg) { console.error("usage: node scripts/mcp-call.mjs <tool|--list> ['<json args>']"); process.exit(2); }
let toolArgs = {};
if (argsArg) { try { toolArgs = JSON.parse(argsArg); } catch (e) { console.error("args must be JSON: " + e.message); process.exit(2); } }

const child = spawn("npx", ["tsx", "src/ff.ts", "mcp"], { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on("data", (d) => { if (process.env.MCP_VERBOSE) process.stderr.write("[server] " + d); });

let nextId = 1;
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 180000);
});

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcp-call", version: "1.0.0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

if (toolArg === "--list") {
  const list = await rpc("tools/list", {});
  for (const t of list.result?.tools ?? []) console.log(`${t.name}\n    ${t.description.slice(0, 150)}`);
  child.kill(); process.exit(0);
}

const res = await rpc("tools/call", { name: toolArg, arguments: toolArgs });
child.kill();
if (res.error) { console.error("ERROR " + JSON.stringify(res.error)); process.exit(1); }
for (const c of res.result?.content ?? []) console.log(c.text ?? JSON.stringify(c));
process.exit(0);
