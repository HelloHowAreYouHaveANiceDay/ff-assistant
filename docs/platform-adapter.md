# Writing a platform adapter

You want this engine to talk to a fantasy site it does not support. This is what that takes.

**Start here — the contract is runnable, not just written down:**

```
npm run ff -- platform-contract                 # what you must provide, with the traps
npm run ff -- platform-contract --check yahoo   # the same check, run against a real adaptor
npm run ff -- platform-contract --json          # machine-readable, for an agent
```

That output is generated from `PLATFORM_CONTRACT` (`src/league/platformContract.ts`), and
`test/platform-contract.test.ts` reads the `interface Platform` **declaration out of the source** and
fails if the two ever name different members. So the checklist cannot quietly go stale the way this
document could — if they disagree, the suite says so and names the member.

## The two steps

1. **Implement `Platform`.**
2. **Register it** — either at runtime, without touching this repo:

   ```ts
   import { registerPlatform } from "ff-assistant/league/platform.js";
   registerPlatform(sleeperPlatform);
   ```

   or, to ship it here, add a line to `REGISTRY` in `src/league/platform.ts`.

That is all. There is no type union to widen and no second list to maintain: `PlatformId` accepts any
string, `LeaguePlatform` is an alias of it, `knownPlatforms()` is computed from the registry at call
time, and the validator that decides whether a stored league row names a usable platform asks the
registry rather than naming platforms.

Then check your work:

```
npm run ff -- platform-contract --check <yourid>
```

**`registerPlatform` runs the contract check for you** and refuses a half-built adaptor, naming every
member that is missing — so the failure happens at registration with a message you can act on,
rather than as a missing-method `TypeError` three layers into a sync. Re-registering an existing id
is refused unless you pass `{ replace: true }`, because silently overwriting an adaptor would hand
one platform's leagues to another.

## What the checker does and does not tell you

It is **structural**: it verifies each member exists and is a function or a value. It never calls
anything. So a green result means "this is shaped like an adaptor", not "this adaptor works". The
report says so every time, and the per-member traps below are where the real failures live.

## The four required methods, and what makes each one wrong

`discover`, `syncSettings`, `syncRosters`, `readTeam` — all take `io: PlatformIO` as their first
argument. **Use it.** Do not reach for `fetch` or the desktop bridge directly: `io` is how the caller
chooses a session (the Electron webview, a cookie, a file), and an adaptor that bypasses it works only
on the author's machine.

The trap that matters most:

> **`syncSettings` must THROW on anything it cannot read. Never default.**

`hints` carries the two things only the caller knows — who we are on this platform, and values the
store already holds for fields the platform does not publish. They are hints, never substitutes. An
adaptor that cannot read `teams` and quietly returns the previous value produces a successful-looking
sync of a league that does not exist. Everything downstream — valuation, the simulator, the gate —
then runs on it.

The rest are in `platform-contract` output; they are not repeated here so there is one source.

## Optional capabilities: omit them honestly

`webview` and `rosterWeek` are optional, and **absence is a supported answer**.

- No `webview` → your platform does not run inside the Electron app. Fully supported; sessions come
  from `resolveIO` either way.
- No `rosterWeek` → your platform does not publish a historical week's lineup. A caller must refuse a
  missing capability **by name**. Do not satisfy it by returning the current roster with a week
  number attached — that is the ESPN trap where four different weeks returned byte-identical starters.

## Writes

Writes ARE a platform capability now (`Platform.writes?`): a URL pattern, a permitted-operation list,
and a builder per operation. OMITTING it is the honest answer until you have observed a real write --
a caller refuses a missing capability by name. Run `ff platform-contract` for the full shape.

ESPN ships the only one: its transactions URL and `["TRADE_PROPOSAL"]`. There is **no** `setLineup`
or `claimWaiver` builder for any platform, and no Yahoo write at all — adding one is a decision about
what this tool may do to a real league, not a refactor. See step C of
`docs/platform-decoupling-design-2026-09-19.md`.

## A skeleton

```ts
import type { Platform, PlatformIO } from "./platform.js";

export const sleeperPlatform: Platform = {
  id: "sleeper",
  host: "sleeper.app",
  // No `webview`: this adaptor does not run in the desktop app.
  urls: {
    home: "https://sleeper.app/leagues",
    league: (id, season) => `https://sleeper.app/leagues/${id}/${season}`,
    team: (id, season, teamId) => `https://sleeper.app/leagues/${id}/${season}/team/${teamId ?? ""}`,
    scoreboard: (id, season, week) => `https://sleeper.app/leagues/${id}/${season}/matchup/${week ?? 1}`,
    standings: (id, season) => `https://sleeper.app/leagues/${id}/${season}/standings`,
    draftRoom: (id, season) => `https://sleeper.app/draft/${id}/${season}`,
  },
  async discover(io, wantSeason) {
    const body = await io.get(`https://api.sleeper.app/v1/user/me/leagues/nfl/${wantSeason}`);
    return JSON.parse(body).map(/* ... */);
  },
  async syncSettings(io, leagueId, season, hints) {
    const raw = JSON.parse(await io.get(`https://api.sleeper.app/v1/league/${leagueId}`));
    if (raw?.total_rosters == null) {
      throw new Error(`sleeper ${leagueId}: no team count in the settings response -- refusing to guess`);
    }
    return { /* ...every field, or throw... */ };
  },
  async syncRosters(io, leagueId, season) { /* EVERY team */ },
  async readTeam(io, leagueId, season, teamId) { /* proj stays 0 */ },
  // rosterWeek omitted: Sleeper's history is not a per-week lineup we can trust.
};
```

Register it:

```ts
const REGISTRY = new Map<string, () => Promise<Platform>>([
  ["espn",    async () => (await import("./espnPlatform.js")).espnPlatform],
  ["yahoo",   async () => (await import("./yahoo.js")).yahooPlatform],
  ["sleeper", async () => (await import("./sleeper.js")).sleeperPlatform],
]);
```

## Sessions: you get these for free

`resolveIO` (`src/league/session.ts`) picks the session for your `host`: an explicitly supplied `io`,
then `--session`/`--cookie-file`, then `FF_SESSION`/`FF_SESSION_COOKIE_FILE`, then the desktop bridge.
Your adaptor takes `io` and never asks which one it got.

## Known rough edges

Honest about what is still awkward, so nobody rediscovers it:

- **Some verbs are ESPN-only by construction and say so.** `src/inseason/routines.ts` declares
  `platforms: ["espn"]` on the roster routine, so a non-ESPN league is skipped **by name** rather
  than run against an ESPN-shaped sync. Your platform will not be picked up by those routines until
  they are generalized; that is visible rather than silent, but it is real.
- **The contract check is structural.** It cannot tell you whether `syncSettings` throws where it
  should. Your first real sync is still the test that matters.
- **An unknown platform in the store reads as `null`.** If a league row names a platform that is not
  registered in the running process, `ctx.platform` is `null`. The raw string survives as
  `platformRaw` and `platformFor` refuses it **by name**, so nothing is silently handed ESPN's
  adaptor — but a runtime registration must happen before the context is resolved, not after.
