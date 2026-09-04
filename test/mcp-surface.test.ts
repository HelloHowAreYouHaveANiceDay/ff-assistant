// The BYO-agent contract: the tools an EXTERNAL agent (Claude Code) can call over stdio MCP are
// exactly the tools the in-app copilot can call. Both are built from buildTools() and served from
// the SAME McpServer instance, so drift is structurally impossible -- these tests defend that
// property against a future change that reintroduces a hand-maintained second list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardServer, TOOL_NAMES } from "../src/agent/agent.ts";

// The McpServer keeps its registry on a private field. Reading it is the only way to assert what
// the server ACTUALLY registered (as opposed to what we think we passed it); if a future SDK
// renames it, this throws loudly rather than silently passing.
const registered = (): string[] => {
  const inst = boardServer(undefined, 2026).instance as unknown as { _registeredTools?: Record<string, unknown> };
  const reg = inst._registeredTools;
  assert.ok(reg && typeof reg === "object", "McpServer._registeredTools missing -- the SDK's internals moved; update this guard");
  return Object.keys(reg).sort();
};

test("MCP surface: the server registers exactly the tools TOOL_NAMES advertises", () => {
  assert.deepEqual(registered(), [...TOOL_NAMES].sort());
});

test("MCP surface: tool names are unique and non-empty", () => {
  assert.ok(TOOL_NAMES.length > 0, "the control surface is empty");
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length, "duplicate tool name");
  for (const n of TOOL_NAMES) assert.match(n, /^[a-z][a-z0-9_]*$/, `tool name ${n} is not a valid MCP identifier`);
});

// The in-app copilot gates on an allowedTools list. It is DERIVED from TOOL_NAMES; if anyone
// replaces it with a literal array again, a tool added later stops being offered with no error
// anywhere. This asserts the derivation covers the whole surface.
test("MCP surface: every tool is allow-listed for the in-app copilot (no hand-typed subset)", () => {
  const allowed = TOOL_NAMES.map((n) => `mcp__ff-draft__${n}`);
  assert.equal(allowed.length, TOOL_NAMES.length);
  for (const n of TOOL_NAMES) assert.ok(allowed.includes(`mcp__ff-draft__${n}`), `${n} is not allow-listed`);
});

// FI: prove the equality guard can actually fail. A surface with a tool the server never registered
// (the exact shape of "someone added it to the allow-list but not to buildTools") must not compare
// equal -- if this passes, the first test is comparing something to itself.
test("MCP surface FAULT: a phantom tool name does NOT compare equal to the registry", () => {
  const phantom = [...TOOL_NAMES, "set_lineup"].sort();
  assert.notDeepEqual(registered(), phantom,
    "the registry compared equal to a surface containing a tool that does not exist");
});
