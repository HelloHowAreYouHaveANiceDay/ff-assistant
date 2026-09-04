// BYO-agent entry point: serve the draft control surface over stdio MCP so an EXTERNAL agent
// (Claude Code, or anything else that speaks MCP) gets exactly what the in-app copilot gets.
//
// This is deliberately NOT a second implementation. `boardServer()` returns a live `McpServer` from
// @modelcontextprotocol/sdk; the in-app copilot hands that instance to the Agent SDK in-process,
// and here we connect the SAME instance to a stdio transport. There is no mirrored tool list, so
// the two surfaces cannot drift -- a tool added to buildTools() appears on both, and one removed
// disappears from both.
//
// Run: `ff mcp` (see docs/mcp.md for the Claude Code .mcp.json wiring).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { boardServer, TOOL_NAMES } from "./agent.js";

/** STDOUT IS THE PROTOCOL. Anything else printed there corrupts the JSON-RPC framing and the client
 *  sees an unparseable-message error rather than a useful one, so route every stray write to stderr
 *  BEFORE the transport is connected. `ingest`/`openDb`/tool handlers all log freely. */
function protectStdout(): void {
  const toErr = (...a: unknown[]) => { process.stderr.write(a.map(String).join(" ") + "\n"); };
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
  console.warn = toErr;
}

export async function serveMcpStdio(opts: { dbPath?: string; season?: number } = {}): Promise<void> {
  protectStdout();
  const season = opts.season ?? new Date().getFullYear();
  const server = boardServer(opts.dbPath, season);
  // Announce on stderr so `ff mcp` is debuggable without touching the protocol stream.
  process.stderr.write(`[ff mcp] serving ${TOOL_NAMES.length} tools over stdio (season ${season}): ${TOOL_NAMES.join(", ")}\n`);
  await server.instance.connect(new StdioServerTransport());
  // connect() resolves once wired; the process stays alive on the stdin stream until the client
  // closes it. Exit cleanly when it does, so a dropped client does not leave an orphan.
  await new Promise<void>((resolve) => { process.stdin.once("end", resolve); process.stdin.once("close", resolve); });
}
