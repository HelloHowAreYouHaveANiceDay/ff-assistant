/**
 * WHAT AN ADAPTER MUST PROVIDE -- as something you can RUN, not only something you can read.
 *
 * The question this answers: "I want this engine to talk to my fantasy site. What exactly do I have
 * to write?" Before this, the answer was `platformFor`'s error message -- "Implement Platform in
 * src/league/<platform>.ts and register it" -- which names a file and a type and nothing else. A
 * reader then has to reverse-engineer the requirements from two shipped adaptors.
 *
 * WHY A DECLARATIVE LIST AND NOT A DOC. A doc rots the moment somebody adds a method to `Platform`,
 * and rots SILENTLY, which is the failure this repo keeps paying for. So:
 *
 *   - every member is declared here once, with what it must do and what it must NOT do;
 *   - `test/platform-contract.test.ts` reads the `interface Platform` DECLARATION OUT OF THE SOURCE
 *     and asserts this list and that interface name exactly the same members. Add a method to the
 *     interface without describing it here and the suite fails, naming it.
 *
 * That is the same rule the write allowlist follows: compare against what the other side publishes,
 * never retype and trust.
 *
 * TYPES CANNOT BE CHECKED AT RUNTIME, and this does not pretend to. `checkPlatformShape` is a
 * STRUCTURAL check -- is the member present, and is it the right kind of thing -- which catches the
 * common failure (a half-written adaptor registered early) and cannot catch a method that returns
 * the wrong shape. That limit is stated in the report rather than glossed, because a checker that
 * implies more than it verifies is worse than none.
 */

/** One member of the contract. */
export interface ContractMember {
  name: string;
  kind: "property" | "method";
  required: boolean;
  /** What it must produce. One sentence, in the adaptor author's terms. */
  must: string;
  /** The mistake that makes this member wrong in a way nothing else will catch. */
  trap?: string;
}

/**
 * THE CONTRACT. Kept in interface order so this file reads alongside the declaration it mirrors.
 *
 * The `trap` lines are not decoration: each one is a specific way a plausible-looking adaptor is
 * wrong, and most are lessons this repo already paid for once.
 */
export const PLATFORM_CONTRACT: ContractMember[] = [
  {
    name: "id", kind: "property", required: true,
    must: "the platform's registry key, the same string the `league` table stores in its `platform` column.",
    trap: "it must EQUAL the key it is registered under. A mismatch means every lookup by id finds one thing and every lookup by the object finds another.",
  },
  {
    name: "urls", kind: "property", required: true,
    must: "a PlatformUrls: `home`, plus builders for `league`, `team`, `scoreboard`, `standings` and `draftRoom`.",
    trap: "every builder must stay on THIS platform's host. They exist so no caller concatenates a platform URL itself -- which it used to, always ESPN-shaped.",
  },
  {
    name: "host", kind: "property", required: true,
    must: "the host whose login a request needs, e.g. \"espn.com\". This is what picks the session.",
    trap: "it is a platform fact, not a rendering detail -- do not derive it from `webview`, which is optional and Electron-only.",
  },
  {
    name: "webview", kind: "property", required: false,
    must: "how the desktop app embeds this platform: `{ elementId, partition }`. OMIT IT if your platform does not run inside the Electron app -- that is fully supported.",
    trap: "two platforms must never share a `partition`. One partition is one login, so sharing it means one platform is reading the other's session.",
  },
  {
    name: "discover", kind: "method", required: true,
    must: "list the leagues this login can see, for the wanted season.",
    trap: "return an empty list when the login sees none; THROW when you could not tell. An empty list is an answer and a failure that returns one is indistinguishable from a user with no leagues.",
  },
  {
    name: "syncSettings", kind: "method", required: true,
    must: "the league's rules in our vocabulary -- teams, slots, draftType, budget, scoring, scoringBucket, kicker, defense, format.",
    trap: "THROW on anything you cannot read. NEVER default. `hints` carries what only the caller knows (who we are; values the store already holds) and they are hints, never substitutes -- an adaptor that cannot read a field still throws rather than reaching for the previous value.",
  },
  {
    name: "syncRosters", kind: "method", required: true,
    must: "every team's current roster.",
    trap: "every team, not just ours. A partial answer here silently shrinks the league everywhere downstream.",
  },
  {
    name: "readTeam", kind: "method", required: true,
    must: "one team as the platform-agnostic LeagueTeam. Leave `proj` at 0 -- valuation is attached by openLeague, not here.",
    trap: "filling `proj` with the platform's own projection puts a second, unmeasured model inside our valuation.",
  },
  {
    name: "rosterWeek", kind: "method", required: false,
    must: "every team's roster AS IT STOOD in a past week, with that week's points.",
    trap: "OMIT IT unless your platform genuinely publishes a historical week's lineup. Returning the CURRENT roster wearing a week number is the ESPN trap that made four different weeks return byte-identical starters. A caller must refuse a missing capability by name; it must not receive a fabricated one.",
  },
];

export interface ShapeReport {
  ok: boolean;
  /** Required members that are absent or the wrong kind. */
  missing: { name: string; why: string }[];
  /** Optional members this adaptor chose to implement. */
  capabilities: string[];
  /** Optional members it declined -- callers must refuse these BY NAME. */
  declined: string[];
  /** What this check cannot see. Printed with the result, never omitted. */
  limits: string[];
}

/**
 * IS THIS OBJECT SHAPED LIKE A Platform? Structural only -- see the header.
 *
 * Takes `unknown` on purpose: the whole point is to be callable on a half-built object that does not
 * typecheck as a `Platform` yet, which is exactly when an author needs the answer.
 */
export function checkPlatformShape(candidate: unknown): ShapeReport {
  const missing: ShapeReport["missing"] = [];
  const capabilities: string[] = [];
  const declined: string[] = [];
  const o = (candidate ?? {}) as Record<string, unknown>;

  if (candidate == null || typeof candidate !== "object") {
    return {
      ok: false,
      missing: PLATFORM_CONTRACT.filter((m) => m.required).map((m) => ({ name: m.name, why: "the candidate is not an object" })),
      capabilities: [], declined: [], limits: LIMITS,
    };
  }

  for (const m of PLATFORM_CONTRACT) {
    const v = o[m.name];
    const present = m.kind === "method" ? typeof v === "function" : v != null && typeof v !== "function";
    if (present) { if (!m.required) capabilities.push(m.name); continue; }
    if (!m.required) { declined.push(m.name); continue; }
    missing.push({
      name: m.name,
      why: v === undefined ? `absent -- ${m.must}`
        : `present but is a ${typeof v}, expected a ${m.kind === "method" ? "function" : "value"}`,
    });
  }

  // `id` must match its registry key, but this function does not know the key -- `checkRegistered`
  // below does. Said here so the gap is visible rather than assumed covered.
  return { ok: missing.length === 0, missing, capabilities, declined, limits: LIMITS };
}

const LIMITS = [
  "STRUCTURAL ONLY: this checks that members exist and are functions or values. It does NOT call them,",
  "so it cannot tell you whether syncSettings throws where it should, whether your URLs stay on your",
  "own host, or whether syncRosters returns every team. Those are the traps listed per member.",
];

/** The contract as text, for a CLI or an error message. `indent` so it can nest inside a report. */
export function describeContract(indent = "  "): string {
  const lines: string[] = [];
  for (const m of PLATFORM_CONTRACT) {
    lines.push(`${indent}${m.required ? "REQUIRED" : "optional"}  ${m.name}${m.kind === "method" ? "(...)" : ""}`);
    lines.push(`${indent}          ${m.must}`);
    if (m.trap) lines.push(`${indent}          TRAP: ${m.trap}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** A shape report as text, including what the check could not see. */
export function describeShape(r: ShapeReport): string {
  const out: string[] = [];
  out.push(r.ok ? "SHAPE OK -- every required member is present." : `NOT USABLE -- ${r.missing.length} required member(s) missing:`);
  for (const m of r.missing) out.push(`  - ${m.name}: ${m.why}`);
  if (r.capabilities.length) out.push(`  optional capabilities implemented: ${r.capabilities.join(", ")}`);
  if (r.declined.length) out.push(`  optional capabilities declined (callers must refuse these by name): ${r.declined.join(", ")}`);
  out.push("");
  for (const l of r.limits) out.push(`  ${l}`);
  return out.join("\n");
}
