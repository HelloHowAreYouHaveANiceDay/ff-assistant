# Browser sync: pulling ESPN without the Electron app

This repo grew up assuming one thing about the ESPN login: that it lives in the desktop app's
embedded webview, and that anything wanting a league read can speak that app's bridge protocol
(`bridgeFetch`, `src/browser/appBridge.ts`). Every sync path in `src/` still reaches for it.

That assumption excludes an entire class of caller. An agent whose ESPN login lives in a
server-side browser can drive pages and save what comes back, but it cannot serve a bridge. Before
the two paths below it had exactly one route in: read a payload and describe it in prose. That does
not work, and the reason is worth stating once because it is the reason this document exists -- a
2.27 MB boxscore hand-summarised into a chat message has lost the identity fields the guards check,
the hollow-payload shape the refusals look for, and every field nobody thought to mention. It is
not a payload, it is a claim about one.

So there are now two first-class ways in besides the bridge:

- **File handoff.** The browser saves the raw API JSON to disk; `ff ingest-espn-payload` reads it
  and runs it through the SAME pure parsers the live path uses
  (`src/data/espnPayload.ts`).
- **Cookie session.** The caller supplies a cookie header and a plain `fetch` does the GET
  (`cookiePlatformIO` in `src/league/platform.ts`).

This page is the recipe: per goal, the exact URL to save, and what the ingest verb will and will not
accept. It exists so a pull is repeatable without reading `src/agent/agent.ts`.

---

## 1. The URLs

Every URL below was read out of the code and is cited with the file and line it was verified at.
None of them is reconstructed from memory. Where two call sites build the same view with the query
parameters in a different order, both are listed, because that difference is real in the source.

**The bases** (`src/data/espnApi.ts:4-5`; a leaf module with no imports, which is why it is the one
place the host is spelled):

```
ESPN_READS_BASE   https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl
ESPN_WRITES_BASE  https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl
```

Everything on this page is a READ, against `ESPN_READS_BASE`. Two path shapes hang off it:

```
{READS}/seasons/{season}/segments/0/leagues/{leagueId}          one league, needs the login
{READS}/seasons/{season}/segments/0/leaguedefaults/3            the public player pool, no login
```

`{season}` is the four-digit season (`2026`), `{leagueId}` the numeric ESPN league id, `{week}` a
**scoringPeriodId** -- ESPN's NFL week number, not a fantasy matchup period.

### 1.1 League reads (require the session)

| Goal | URL after `{READS}/seasons/{season}/segments/0/leagues/{leagueId}` | Verified at |
| --- | --- | --- |
| League settings + our team id (format, scoring, slots, budget) | `?view=mSettings&view=mTeam` | `src/ff.ts:4477`, `src/league/espn.ts:121`, `src/league/espnPlatform.ts:198` (built by `espnLeagueApiUrl`, `src/league/espnPlatform.ts:38-39`) |
| Settings alone (acquisition rules, roster settings) | `?view=mSettings` | `src/league/espn.ts:312`, `src/league/espn.ts:367` |
| Every team's current roster | `?view=mRoster&view=mTeam` | `src/league/espn.ts:126` |
| Every team's current roster (platform adaptor, same views, other order) | `?view=mTeam&view=mRoster` | `src/league/espnPlatform.ts:209` |
| Completed draft (auction prices / pick order) | `?view=mDraftDetail&view=mTeam` | `src/ff.ts:2288`, `src/league/espn.ts:240` |
| One week's rosters, starters and applied points | `?scoringPeriodId={week}&view=mBoxscore` | `src/data/leagueRosters.ts:191` |
| One week's transaction log (adds, drops, waivers, trades) | `?scoringPeriodId={week}&view=mTransactions2` | `src/data/leagueTransactions.ts:144` |
| Pending transactions (live trade proposals, with full terms) | `?view=mPendingTransactions` | `src/data/leagueTransactions.ts:411` |
| Head-to-head schedule + divisions | `?view=mSettings&view=mTeam&view=mMatchup` | `src/league/espn.ts:387` |
| The league's current scoring period | `?view=mStatus` | `src/inseason/proposeTrade.ts:138` |
| League-scoped player pool | `?view=kona_player_info` | `src/league/espn.ts:153` |

### 1.2 Player-pool reads

These use the `leaguedefaults/3` path and are fetched with a plain Node `fetch` in two of the three
call sites, i.e. **no login needed** -- which is why they are separated out here. They carry an
`x-fantasy-filter` header holding a JSON filter object.

| Goal | URL | Verified at |
| --- | --- | --- |
| ESPN draft rank + ADP | `{READS}/seasons/{season}/segments/0/leaguedefaults/3?view=kona_player_info` | `src/data/assemble.ts:35`, `src/ff.ts:2279`, `src/league/espn.ts:225` |
| Position eligibility | `{base}?view=kona_player_info`, where `{base}` is the league path when a `leagueId` is given and `leaguedefaults/3` otherwise | `src/data/eligibility.ts:101` (base built at `:98-100`) |
| ESPN's own weekly projections | `{base}?view=kona_player_info&scoringPeriodId={week}`, same base choice | `src/weekly/espnProjections.ts:65` |

The eligibility and weekly-projection readers go through `bridgeFetch`, so today they need the app
even when the URL itself would not.

### 1.3 What could not be verified

**`view=kona_league_communication`** -- the Fantasy Chat / league-message view. The task named
`src/data/assemble.ts:35` for it; that line is `view=kona_player_info`, not the communication view.
A repo-wide grep finds `kona_league_communication` in exactly one place, `CLAUDE.md:137`, as prose,
and in no `.ts` file at all. So: **no code in this repo builds that URL**, and the exact query shape
is not verifiable from source. What `CLAUDE.md` records about it is that it carries chat message
METADATA rather than the typed bodies, and that the bodies are read instead through the app's
`read_frame` / `/read-frame` route because the chat is a cross-origin `chat.espn.com` iframe. Treat
the URL as unverified until someone writes the call site.

---

## 2. Traps that decide whether a saved URL is worth anything

These are all measured findings already recorded in the code. They matter more, not less, on a file
handoff, because a file on disk carries no record of what was requested.

**`leagueHistory` is not "the same API for old seasons."** Four shapes were probed against this
league (`src/data/leagueRosters.ts:9-24`). `leagueHistory + mRoster + scoringPeriodId` **ignores**
`scoringPeriodId`: weeks 1, 3, 8 and 14 of 2020 came back byte-identical, rosters and starters both.
It is the final roster wearing a week number, and a lineup backtest built on it is one in which
nobody ever changed a lineup. `leagueHistory + mBoxscore` returns an empty
`rosterForCurrentScoringPeriod`. The shape that works, for past seasons as well as the current one,
is the `/seasons/{Y}/` path with `mBoxscore` and `scoringPeriodId` -- which is the row in the table
above. Save that one.

**`mTransactions2` returns an EMPTY array without `scoringPeriodId`** -- on the `leagueHistory` path
and on the `/seasons/{Y}/` path alike (`src/data/leagueTransactions.ts:4-9`). With it, the same URL
returns the week's real transactions; probed 2026-09-09, 2024 week 5 returns 21. For three probes
"the log is empty" was a statement about a missing query parameter, not about ESPN's retention.

**Do not send `x-fantasy-filter` to `mTransactions2`.** `{"transactions":{"limit":1000}}` makes ESPN
answer HTTP 400 there (`src/data/leagueTransactions.ts:11-12`). The unfiltered request already
returns the whole period. The header IS required on the `kona_player_info` reads -- it is the view,
not the endpoint, that decides.

**A week's payload keeps changing until the week is over.** `weekPayloadFreshAfter`
(`src/data/leagueRosters.ts:216`) will not trust a capture of week W until one day past W's last
kickoff, and treats a week whose last kickoff is today or later as never cacheable. A boxscore or
transaction file saved mid-week is a snapshot of an unsettled week; that is fine as long as it is
re-saved later, and misleading if it is filed away as final.

**ESPN answers some league endpoints with a one-element ARRAY and others with the object.** Both are
handled by `espnRoot` (`src/data/leagueRosters.ts:133`), which the ingest verb uses, so a file saved
in either shape is fine. Do not "helpfully" unwrap it before saving.

**Save the raw response body, not a rendered page.** `readPayload`
(`src/data/espnPayload.ts:86-92`) refuses a non-JSON file by name and says so: "Save the raw API
response, not a rendered page or a summary of it."

---

## 3. `ff ingest-espn-payload`

```
ff ingest-espn-payload --file <json> --kind <settings|rosters|draft|boxscore|transactions> \
    --league <id> --season <YYYY> [--week N] [--dry-run]
```

Implemented in `src/data/espnPayload.ts` (`ingestEspnPayload`), dispatched from `src/ff.ts:112-113`
into `cmdIngestEspnPayload` (`src/ff.ts:4767`). `--league` and `--season` are optional in the CLI
wrapper: it falls back to the resolved league context and the stored season
(`src/ff.ts:4786-4788`), and refuses outright if neither yields a league. `--file` and `--kind`
together are what make it run -- with either missing, the verb prints its usage, including the
`KIND_VIEW` table below, and exits without touching the store. A `--db` flag picks a different
store.

Nothing in the module re-implements a parser. `settings` goes through `espnSettingsFromPayload`,
`rosters` through `espnRostersFromPayload`, `boxscore` through `parseRosterWeek` and `transactions`
through `parseTransactionWeek` -- the same functions the live path calls. Every refusal they make,
they still make. A second implementation is a second thing to drift.

### 3.1 `--kind` is required and is never sniffed

`KIND_VIEW` (`src/data/espnPayload.ts:31-37`) is the map from kind to the view to save. It lives in
the code as data specifically so this page and the verb cannot disagree about which URL produces
which kind:

| `--kind` | `view=` |
| --- | --- |
| `settings` | `mSettings&view=mTeam` |
| `rosters` | `mRoster` |
| `draft` | `mDraftDetail` |
| `boxscore` | `mBoxscore` |
| `transactions` | `mTransactions2` |

(`KIND_VIEW.rosters` names `mRoster` alone, while both live roster call sites ask for `mTeam` as
well and `espnRostersFromPayload` is documented as parsing a `view=mRoster&view=mTeam` payload,
`src/league/espnPlatform.ts:147`. Save both views. Whether `mRoster` alone parses was not tested
here.)

The kind is DECLARED because a settings payload and a boxscore payload share a top-level shape --
both carry `id`, `seasonId` and `teams` -- so a sniffer would be guessing, and guessing which view a
file holds means writing one view's data under another's name. `kindMismatch`
(`:71-83`) exists only to say "this does not look like what you said it was", which is a refusal and
not a guess. It is deliberately weak: it checks for the one field the kind cannot be without
(`settings`, `teams[].roster`, `draftDetail`, `schedule`, `transactions`) and says nothing else. The
decision about which view a file holds belongs to whoever saved it.

### 3.2 The refusals

Every one of these happens BEFORE anything is written, and each says "Nothing was written."

- **Kind mismatch.** The declared kind's required field is absent. The message names the field and
  the `view=` to save instead.
- **Wrong league.** ESPN echoes the league id back as `id`. If it does not match `--league`, the
  ingest refuses: reading one league and writing another is how a league inherits another league's
  rules (`:111-115`). A live fetch at least asked for the league it got; a file did not, which is
  why this guard matters more here.
- **Wrong season.** Same check against `seasonId` (`:116-119`).
- **`--kind boxscore` without `--week`** (`:148`) and **`--kind transactions` without `--week`**
  (`:157`). The week is the `scoringPeriodId` the file was saved for -- it is in the URL, not in the
  payload's top level, so the verb cannot recover it.
- **`--kind draft`** is **not wired** (`:186-191`). The draft reader still lives behind
  `ff ingest-raw league-history`. It refuses rather than being stubbed, because a verb that accepts
  a file and writes nothing is worse than one that refuses.
- **An empty-looking roster file.** `--kind rosters` goes through `writeOwnership`, the same writer
  the live sync uses, including its refuse-empty-wipe guard. If the file parses to 0 rostered
  players while the store already holds some, the ingest refuses and keeps the existing rows
  (`:174-178`) -- because that is exactly what a payload saved from a logged-out session looks like.
  A genuinely empty league (pre-draft) returns `noop-empty` and writes nothing, without erroring.

### 3.3 Identity is reported on every ingest

`payloadIdentity` (`:54-62`) pulls `id`, `seasonId`, `teams.length` and whether `settings` is
present, and `PayloadIngestResult.identity` carries them back on every call. That is the cheapest
possible guard against a file-handoff loop quietly ingesting yesterday's download: read the three
numbers and confirm the file is the league, season and size you meant.

### 3.4 `--dry-run`

Parses and validates, writes nothing. Each kind returns a `note` beginning `DRY RUN` and the row
count it WOULD have written -- roster rows for `boxscore`, item rows for `transactions`, team
rosters for `rosters`, 0 for `settings`. All the refusals above still fire, because they run before
the dry-run branch. `readPayload` is also exported separately so a caller can validate a file with
no database open at all.

---

## 4. Session providers: `PlatformIO`

`PlatformIO` (`src/league/platform.ts:145-147`) is a one-method interface:

```ts
export interface PlatformIO {
  get(url: string, headers?: Record<string, string>): Promise<string>;
}
```

That is the whole session contract -- "GET this URL with the user's session, return the body." It
was always the right abstraction; the problem was that `bridgePlatformIO` was its only
implementation, so in practice the repo assumed the login lived in the desktop app's webview and
that any caller could speak its bridge protocol. Three implementations now exist.

**`bridgePlatformIO(host, timeoutMs = 25000)`** (`:156-158`) -- the default. One authenticated GET
executed inside the app guest that holds `host`'s login, via `bridgeFetch`. Deliberately not a plain
`fetch`: the request runs in the guest, same-origin and credentialed, and a bare Node fetch gets a
login page. One spelling, so `league_sync`, `ff sync-rosters` and any future sync verb cannot drift
into three slightly different transports -- which is what happened once, when the roster sync grew
its own Playwright/CDP body while `league_sync` went through the bridge.

**`cookiePlatformIO(cookie, opts)`** (`:176-208`) -- the new one. The caller supplies the cookie
header and the transport is a plain `fetch`; `opts` takes `timeoutMs` (default 25000) and an
optional `userAgent`. Anything that can produce a valid cookie header for the host -- a headless
browser, a saved session, a curl-style export -- is now a provider on equal footing with the app.

Two properties worth knowing:

- **It throws on any non-2xx, and that is the point.** ESPN answers an expired session with valid
  JSON that simply has no teams in it, which reads downstream as "the league is empty" rather than
  "you are logged out". The status is checked in the provider so it cannot be lost, and a 401/403
  gets a message that says outright: refresh the cookie, do NOT treat this as an empty league. An
  empty cookie is rejected at construction for the same reason ("a session provider with no session
  is a 401 waiting to be misread as an empty league").
- **It reads no cookie for itself.** No browser profile is scraped, no login is automated, nothing
  is persisted -- the cookie arrives from the caller and lives for the process. A credential this
  module fetched for itself would be a credential nobody decided to share.

**`filePlatformIO(files)`** (`:222-234`) -- the file handoff as a provider rather than as a verb.
`files` maps a substring of the URL (in practice the `view=` token) to the file holding that view's
response, so an adaptor's own `syncSettings`/`syncRosters` can run against saved payloads. It
**refuses an unmatched URL** and lists the tokens it does know, rather than returning an empty body:
"no file for this view" and "the league has no data" must not produce the same result.

Because the adaptor is handed its IO rather than opening a browser itself, every parser in
`src/league/espnPlatform.ts` is testable against a saved fixture rather than only against the live
site.

---

## 5. Session health

```
ff session-check [--league <id>] [--season Y] [--cookie-file F] [--payload F]
```

The cheap probe: one GET of the league URL with `view=mSettings`, expecting a body that parses and
whose `id` is the league asked for. It is the smallest read that separates the states that otherwise
arrive as the same bytes -- authenticated, logged out, and pointed at the wrong league -- and it is
meant to be run BEFORE a long pull, because a sweep against a lapsed session produces a directory of
plausible-looking files that all parse to nothing.

`probeEspnSession` (`src/data/espnSession.ts:123`) takes an injected `PlatformIO`, so the same probe
covers all three providers, and the CLI picks one (`src/ff.ts:4838-4849`): `--payload F` builds a
`filePlatformIO({"view=mSettings": F})` and checks a file handoff with no network at all,
`--cookie-file F` reads the file as a cookie header into `cookiePlatformIO`, and with neither it
uses `bridgePlatformIO("fantasy.espn.com")`. The URL itself is built by `espnSessionProbeUrl`
(`src/data/espnSession.ts:67-69`) -- `view=mSettings` alone, because this is a probe and not a sync,
and that view still carries both facts it needs: the league's own `id` and `settings.size`.

It returns rather than throws on a failed probe -- a pre-flight check that throws is the original
failure wearing a stack trace -- but an invalid ARGUMENT (no `io`, an empty league id, a non-numeric
season) still throws, because that is a caller bug and not a session state. Five outcomes, each with
a `reason` string deliberately distinct from the other four (`src/data/espnSession.ts:105-119`):

| Outcome | `reason` prefix | What it means |
| --- | --- | --- |
| ok | `OK:` | parsed, and `id` is the league asked for |
| transport threw | `TRANSPORT FAILED:` | no body; `status` is recovered from the message when it starts with one, e.g. `cookiePlatformIO`'s `401 Unauthorized ...` |
| zero bytes | `EMPTY BODY:` | the provider answered and said nothing -- **not** an empty league |
| not JSON | `NOT JSON:` | almost always an ESPN login or interstitial page, the clearest logged-out signal there is |
| no league id | `NO LEAGUE ID:` | the hollow-payload shape |
| wrong league | `WRONG LEAGUE:` | JSON for a different league than requested |

The last two are delegated to `espnIdentityProblem` (`src/league/espnPlatform.ts:46-58`) -- the same
check `espnSettingsFromPayload` refuses on and `ingestEspnPayload` repeats -- so the probe and the
sync cannot drift apart about what counts as the right league. A 200 returning another league's
settings is a successful HTTP request and a failed session check.

The verb prints the verdict, the reason, and the payload's own league/season/team-count beside the
ones asked for, and **sets exit code 3 on failure** (`src/ff.ts:4859`) so it works as a gate:
`ff session-check && ff sync-rosters`.

`teams` is best-effort: the `teams` ARRAY is counted when present and `settings.size` used otherwise,
because the array is the thing that empties out on a dead session while `size` may not
(`src/data/espnSession.ts:87-94`). A mismatched `seasonId` is reported but is NOT a session failure
-- the probe refuses to report a season problem as a login problem.

---

## 6. The write path

Reads got three session providers once `PlatformIO` stopped being Electron-only (section 2). Writes
got the same treatment on 2026-09-18, but the interesting part is what had to move first.

### 6.1 The guard lived in the app, not in the system

Before this, the only thing restricting what this tool could write to ESPN was a regular expression
inside `app/main.js` (the `/write-transaction` route). That check is real and narrow -- exactly the
league-transactions endpoint, nothing else -- but it belonged to **one transport**.
`bridgeWriteTransaction` posts a url and a body to the app; the app checks the url; the app executes
it in the authenticated guest.

Adding a cookie-based writer beside that, which is the entire point of a portable write path, would
have created a second route to ESPN's write API **with no allowlist on it at all**. The safety
property was a property of the desktop app, not of the system.

So the allowlist moved into `src/league/writeIO.ts`, which every provider goes through, and the app
kept its own copy as defence in depth. They cannot share code -- `app/main.js` is plain JavaScript in
its own package -- so `test/write-contract.test.ts` asserts the two regexes are **character
identical**, and fails if they ever drift. The same rule the repo applies to any duplicated guard:
compare, never retype and trust.

### 6.2 What may be written

Exactly one endpoint:

```
POST https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl
       /seasons/{season}/segments/0/leagues/{leagueId}/transactions
```

Refused, each with a named reason: the `lm-api-reads` host, any other path on the writes host, a
different game (`fba`), a non-numeric league, a segment other than 0, a query string, plain `http`,
and a body over 100,000 bytes. Nothing has been widened -- adding waiver or lineup endpoints is a
decision about what the tool may do to a real league, not a refactor, and it was not taken while
moving a guard.

### 6.3 The contract

```ts
interface PlatformWriteIO {
  post(url: string, body: string): Promise<{ status: number; body: string }>;
  readonly via: string;
}
```

Three differences from the read contract, each deliberate:

| | why |
|---|---|
| returns `{ status, body }` | for a write the STATUS is the result and the BODY is the reason. ESPN puts "ineligible player", "roster locked", "deadline passed" in the body of a refusal; throwing the status away loses exactly the sentence the manager needs |
| never throws on a non-2xx | a 403 is an outcome to report, not a crash |
| carries `via` | a write nobody can attribute is a write nobody can audit |

Providers, all of which run `assertWritableUrl` **inside** the provider rather than at the call site,
so a future caller cannot reach ESPN's write API by forgetting to call it:

| provider | session |
|---|---|
| `bridgeWriteIO()` | the desktop app's authenticated ESPN webview (the default, unchanged) |
| `cookieWriteIO(cookie)` | a supplied ESPN cookie header -- any browser that can export one |
| `recordingWriteIO()` | sends nothing, records what it would have sent |

`recordingWriteIO` is not a test double. It is how a dry run becomes structural rather than a flag
every future caller has to remember to check: a caller handed it **cannot** send, whatever it does.

### 6.4 Using it

```
ff propose-trade --give "Player A" --get "Player B"                      # dry run, the default
ff propose-trade --give "Player A" --get "Player B" --cookie-file F      # dry run, names the session
ff propose-trade --give "Player A" --get "Player B" --send               # SENDS, via the app
ff propose-trade --give "Player A" --get "Player B" --send --cookie-file F   # SENDS, via the cookie
```

Dry run remains the default and the dry-run output now names which session **would** have sent it.
`--send` is the only thing that writes, it is an irreversible outward action visible to another
manager, and nothing in this repo sends one without it.

### 6.5 What is still not writable

`ff propose-trade` is the only write verb there is. Waivers and lineups are **not implemented as
writes at all** -- `espnTeam.setLineup` throws `selectors not yet pinned`, and there is no waiver
claim writer. The portable transport now exists for when they are built; the endpoints do not, and
the allowlist deliberately does not admit them yet.
