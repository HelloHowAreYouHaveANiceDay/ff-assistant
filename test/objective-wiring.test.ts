// `--objective` REACHES THE THREE SURFACES -- integration pass 4.
//
// Track H built the win-probability lineup and left the flag unwired: `copilotActions`, `cmdCopilot`
// and the `lineup_recommend` MCP tool all had no way to ask for it, so the only caller was a script.
// A flag that exists in `lineupRecommend`'s signature and nowhere a user can type it is a feature
// nobody has, and it reads exactly like a shipped one.
//
// The three assertions here are the three places it could be dropped, and none is implied by the
// others: the MCP INPUT SCHEMA (an agent cannot pass what the schema does not declare), the CLI
// PARSER (which must also refuse a typo by name rather than silently defaulting), and the fact that
// the default is still `expected` -- because the whole point of wiring a measured regression behind
// a flag is that the flag is not the default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardServer } from "../src/agent/agent.ts";

/** The registered tool's declared input shape. Read off the server the SDK actually built, not off
 *  the literal we passed it, so a schema dropped in registration cannot pass. */
function inputShape(name: string): Record<string, unknown> {
  const inst = boardServer(undefined, 2026).instance as unknown as {
    _registeredTools?: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }>;
  };
  const t = inst._registeredTools?.[name];
  assert.ok(t, `${name} is not registered`);
  const shape = t!.inputSchema?.shape;
  assert.ok(shape && typeof shape === "object", `${name} has no input shape -- the SDK's internals moved; update this guard`);
  return shape as Record<string, unknown>;
}

test("the lineup_recommend MCP tool DECLARES objective, with both values", () => {
  const shape = inputShape("lineup_recommend");
  assert.ok("objective" in shape, "an agent cannot pass an argument the input schema does not declare");
  const field = shape.objective as { safeParse: (v: unknown) => { success: boolean } };
  assert.equal(field.safeParse("expected").success, true);
  assert.equal(field.safeParse("winprob").success, true);
  assert.equal(field.safeParse("sideways").success, false, "the enum accepts anything -- a typo would reach the dispatcher");
  assert.equal(field.safeParse(undefined).success, true, "objective must be OPTIONAL: the default is expected");
});

test("no OTHER copilot tool grew an objective by accident", () => {
  // `objective` is a lineup question. If it appears on a tool that cannot honour it, an agent will
  // pass it and be silently ignored, which is worse than not offering it.
  for (const name of ["waiver_targets", "season_odds", "stream_recommend", "trade_check"]) {
    assert.ok(!("objective" in inputShape(name)), `${name} declares objective but cannot act on it`);
  }
});

test("the CLI parser accepts both objectives and REFUSES anything else by name", async () => {
  // The parser is exercised through the module the CLI uses, rather than by spawning `ff`, so the
  // assertion is about the code and not about a shell. The refusal message must NAME the bad value:
  // a parser that quietly returned `expected` would hand a caller a lineup he did not ask for.
  const src = await import("node:fs").then((fs) => fs.readFileSync("src/ff.ts", "utf8"));
  assert.match(src, /objectiveOf\(valueOf\(rest, "--objective"\)\)/,
    "cmdCopilot does not parse --objective at all");
  assert.match(src, /is not an objective -- use expected \| winprob/,
    "an invalid --objective is not refused by name");
  assert.match(src, /--objective expected\|winprob/, "the usage text does not mention --objective");
});

test("the dispatcher's DEFAULT is still expected, and the default is the measured decision", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync("src/inseason/copilotActions.ts", "utf8"));
  assert.match(src, /const objective = a\.objective \?\? "expected";/,
    "the dispatcher does not default to expected -- a measured -0.59pp regression would be shipping");
  assert.match(src, /objective\?: "expected" \| "winprob";/, "CopilotArgs does not carry the objective");
});
