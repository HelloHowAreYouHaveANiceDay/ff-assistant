# Decoupling the engine from Electron and from ESPN

**Status: A, B and D LANDED 2026-09-19. C is DESIGNED AND UNBUILT, pending review.**

Owner decisions taken (2026-09-19):

1. **Scope** — A + B + D now; **C separately**, because it touches the one live write path.
2. **Session choice** — a central resolver, flag -> env -> bridge. Not persisted per league: stored
   state that can disagree with what is actually running is the stored-levers trap.
3. **Yahoo writes** — `writes: undefined`. Declared unable, refused by name. No new power over a
   real league ships with this.

The ask: an agent should be able to drive this engine with a different browser tool, or against Yahoo
only, without the Electron app and without ESPN.

## First, what is already right — because the answer changes the size of the job

I expected to find the engine soaked in ESPN. It is not. Measured:

| layer | ESPN coupling |
|---|---|
| `src/model` | **0 of 6 files** mention ESPN |
| `src/inseason` (the whole decision surface) | **1 file** touches transport — `proposeTrade.ts`, 2 lines |
| `src/draft` | 17 of 36 files mention ESPN, nearly all comments and column names |

And the abstractions exist, properly built:

- **`PlatformIO`** — `get(url, headers) => body`. Three providers: bridge, cookie, file.
- **`PlatformWriteIO`** — `post(url, body) => {status, body}`. Three: bridge, cookie, recording.
- **`Platform`** — `discover`/`syncSettings`/`syncRosters`/`readTeam`, and **every method takes `io` as a
  parameter**. That is real dependency injection, not a global.
- **`LeagueProvider`** — optional capabilities (`draftPicks?`, `matchups?`, `acquisitionRules?`) with the
  rule stated on the interface: a consumer must check for the method and say so plainly when absent,
  "rather than a caller reaching around the interface to the platform API — which is how the adaptor
  boundary erodes."
- **A registry** — `platformFor(id)` with lazy imports; `espnPlatform` and `yahooPlatform` both exist.

So this is not a rewrite. It is four specific breaks in an architecture that is otherwise sound.

## Break 1 — writes are an ESPN transport, not a platform capability

This is the big one and the only one that blocks a Yahoo-only agent outright.

`PlatformWriteIO` abstracts the **transport** (post a url and a body). Nothing abstracts the
**operation**. The consequences:

- `ESPN_WRITE_URL_PATTERN` is literally `lm-api-writes.fantasy.espn.com/...`. **A Yahoo write cannot
  pass the guard by construction.** The operation allowlist added on 2026-09-19 is ESPN-shaped too.
- `executeTradeProposal` builds the ESPN URL and the ESPN payload **inside `src/inseason`** — the
  decision layer. That is the single transport leak in the entire decision surface, and it is a write.
- There is no `Platform.proposeTrade()`. A second platform cannot implement writing even in principle.

So: Yahoo has **zero** write capability, and the recently-tightened guard is a guard for one platform.

## Break 2 — the Electron bridge is the default in seven scattered places

```
agent/agent.ts:34          bridgePlatformIO(host)
data/leagueRosters.ts:465  bridgePlatformIO(plat.webview.host, 40000)
ff.ts:1795                 bridgePlatformIO(plat.webview.host)
ff.ts:4899                 bridgePlatformIO("fantasy.espn.com")
inseason/proposeTrade.ts:160  bridgeWriteIO()
inseason/proposeTrade.ts:147  bridgeFetch(...)          ← direct, for scoringPeriodId
league/yahoo.ts:514,524    io: PlatformIO = yahooIO     ← module-level default
```

The contract is injectable; the **defaults are not centralized**. "Use a different browser tool"
therefore means patching seven sites, and `--cookie-file` exists on 2 verbs out of ~40. A capability
that requires editing seven defaults is a capability the architecture claims but does not offer.

## Break 3 — Electron vocabulary sits on the platform-agnostic contract

```ts
export interface WebviewSpec { elementId: string; host: string; partition: string }
export interface Platform { readonly webview: WebviewSpec; ... }
```

`elementId` and `partition` are Electron `<webview>` concepts. Every `Platform` must supply them even
if it never runs in Electron. Worse, `host` — a genuine platform fact needed to pick a session — is
only reachable *through* that Electron-shaped struct, which is why two call sites read
`plat.webview.host` to configure a transport that has nothing to do with a webview.

## Break 4 — the Yahoo adapter imports the bridge at module top

`src/league/yahoo.ts:35` — `import { bridgeFetch } from "../browser/appBridge.js"`. Every other
consumer of the bridge imports it lazily. This pulls the Electron path into the Yahoo module graph
unconditionally.

## The design

Four changes, each independently shippable and reversible, in dependency order.

### A. Lift `host` out of `WebviewSpec`; make the webview spec optional

```ts
export interface Platform {
  readonly id: PlatformId;
  readonly host: string;                 // the session host. A platform fact.
  readonly webview?: WebviewSpec;        // Electron presentation only; absent is legal
  ...
}
export interface WebviewSpec { elementId: string; partition: string }   // host removed
```

Pure mechanical change. `plat.webview.host` → `plat.host` at both call sites. Nothing else moves.

### B. One place that chooses a session provider

```ts
// src/league/session.ts
export type SessionKind = "bridge" | "cookie" | "file";
export function resolveIO(host: string, opts?: SessionOpts): PlatformIO;
export function resolveWriteIO(platform: Platform, opts?: SessionOpts): PlatformWriteIO;
```

Resolution order: explicit argument → `--session`/`--cookie-file` flag → `FF_SESSION` env →
**bridge** (today's behaviour, so nothing changes by default). Every one of the seven sites above
calls this instead of naming a provider.

The win is not indirection for its own sake: it makes "which session am I using?" a question with one
answer, and it puts the fallback-to-bridge decision in one auditable place instead of seven implicit
ones.

### C. Writes become a platform capability

The operation moves out of `src/inseason` and behind the platform interface:

```ts
export interface WriteRequest { url: string; body: string; operation: string }

export interface PlatformWrites {
  readonly writeUrlPattern: RegExp;                 // per-platform endpoint allowlist
  readonly writeOperations: readonly string[];      // per-platform operation allowlist
  proposeTrade?(ctx: WriteCtx, give: TradePlayer[], get: TradePlayer[]): WriteRequest;
  setLineup?(ctx: WriteCtx, moves: LineupMove[]): WriteRequest;
  claimWaiver?(ctx: WriteCtx, claim: WaiverClaim): WriteRequest;
}
```

`Platform.writes?: PlatformWrites` — **optional**, so a platform that cannot write says so by absence
and the caller must refuse it by name, exactly as `draftPicks?` already works.

The guard generalizes rather than loosening:

```ts
assertWritable(platform, req)   // req.url matches THAT platform's pattern,
                                // req.operation is in THAT platform's list
```

ESPN's entry stays exactly what it is today — the one transactions URL, operations `["TRADE_PROPOSAL"]`.
**Nothing this tool may currently do to a real league changes.** Yahoo's entry starts as
`writes: undefined` — declared unable, not silently unable.

`executeTradeProposal` keeps the orchestration (resolve → inject scoring period → gate on `send`) and
loses the payload construction, which is the part that was ESPN.

### D. Lazy-import the bridge in `yahoo.ts`

One line, matching every other consumer.

## What this deliberately does NOT do

- **It does not add a single write operation.** Giving Yahoo a trade builder, or ESPN a lineup or
  waiver builder, is a separate decision about what this tool may do to somebody's real league — and
  after C it is a visible, per-platform edit rather than a diffuse one.
- **It does not change any default.** The bridge stays the default session; ESPN stays the default
  platform. An existing install behaves identically.
- **It does not touch the engine.** `src/model`, `src/draft`, `src/weekly` are not in scope because the
  measurement says they are not the problem.

## How each step is verified

Same discipline as the rest of the repo — a guard is proven to fail, and proven able to say yes:

- **A**: typecheck plus the existing platform tests; `plat.host` must equal the old `plat.webview.host`
  for both platforms, asserted.
- **B**: a test that `resolveIO` returns the bridge by default (the no-change property) **and** that
  each non-default kind is reachable — a resolver that can only ever return one provider is the
  dead-lever shape.
- **C**: the existing write-contract tests must pass unchanged against ESPN, plus: a Yahoo URL is
  refused under ESPN's pattern; a platform with `writes: undefined` is refused **by name** rather than
  falling through to ESPN's; and the real `resolveTrade` payload still clears the guard end-to-end
  (the check that caught nothing in the unit layer last time).
- **D**: assert `appBridge` is not in `yahoo.ts`'s static import graph.

## What landed (2026-09-19)

**A** — `Platform.host` is a first-class field; `Platform.webview?` is optional and carries only
`{ elementId, partition }`. Making it optional immediately caught the one place that assumed a
webview exists (`activeGuest` in agent.ts), which now refuses by name rather than falling back to
ESPN's element id — that fallback would have pointed a caller at another platform's guest, the
wrong-site read `appBridge` already warns about.

**B** — `src/league/session.ts`. All seven sites now resolve through it. Default unchanged.

**D** — `yahoo.ts` no longer statically imports the bridge; `yahooIO` resolves per call, so a flag
parsed after import still takes effect.

Verified: full suite 1,286 pass / 0 fail. Two existing tests asserted the old `webview.host` shape
and were updated to the moved field rather than weakened. Fault injection on the resolver: forcing it
to always return the bridge fails 3 tests; flipping the default to cookie fails 2.

## C — still to do

Unchanged from the design above. The one thing to re-check when it is built: `executeTradeProposal`
still constructs an ESPN URL for `scoringPeriodId` at `proposeTrade.ts:147`. That read is the last
transport leak in `src/inseason` and belongs behind the platform capability, not beside it.
