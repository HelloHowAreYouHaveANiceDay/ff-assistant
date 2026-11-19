# BUILD BRIEF -- retire the Electron app, run ESPN + Yahoo through `bim bro` (D55)

Branch `feat/bro-cutover` (from main dce64e7). Lands TODAY 2026-11-18, before TNF Thu 11-19.
Owner decisions (libo, final): bro sessions are the only live transport; the board cockpit UI is
dropped with no replacement (CLI + Slack only); HARD switch in one change, `app/` deleted in it.

## 0. Spike results (live, 2026-11-18 ~22:00 ET)

| check | result |
|---|---|
| `bim bro doctor` | ok: node 22, playwright, chromium, 57 sites |
| bro site `espn` | EXISTS (`H:/working/bro/sites/espn/site.json`), persistent profile `%LOCALAPPDATA%/bro/profiles/espn`, auth present |
| `bim bro session --op start --site espn --detach` | started, CDP port **9222** |
| ESPN logged in non-interactively? | **YES.** `espn_s2` + `SWID` present; no human step |
| ESPN read, league 462233 | in-page `fetch(lm-api-reads .../leagues/462233?view=mRoster&view=mTeam, {credentials:"include"})` -> **200, 16 teams, roster entries 12**; `view=mSettings` -> name `seacaptaindate.com` |
| bro site `yahoo` | did NOT exist. Created `H:/working/bro/sites/yahoo/site.json` (persistent, loginUrl login.yahoo.com) -- uncommitted in the bro repo |
| Yahoo logged in? | **NO.** Session (port **9223**) opens league 129048 and is redirected to `login.yahoo.com` (Sign in). Fresh profile. |

ESPN STOP condition is NOT hit. Yahoo needs one owner login (section 6). Yahoo is read-only in this
repo (writes are ESPN-only by the write contract), so ESPN cutover does not wait on it.

Gotchas found:
- bro picks ports itself: espn got 9222, yahoo 9223 -- **9223 is the old app default** (`FF_CDP_PORT`
  fallback). Nothing new may assume a port; resolve the session via `bim bro sessions`/`page --site`.
- `bim bro page --site espn --action eval` refuses when 2+ tabs are on the domain: always pass
  `--tab <id>` (take it from `bim bro open` output or `--action tabs`).
- `--detach` is a bare flag (`--detach true` is rejected).

## 1. The transport (one new module)

`src/browser/broSession.ts` (replaces `src/browser/appBridge.ts` + `webviewPage.ts` + `attach.ts`):

- `ensureSession(site: "espn"|"yahoo")`: `bim bro sessions` -> if not live, `bim bro session --op start
  --site <s> --detach`; then `bim bro page --site <s> --action tabs`, pick/open ONE tab on the site's
  home host (`bim bro open --site <s> --url <homeUrl>`), cache the tab id for the process.
- `broEval(site, js)`: `execFile("bim", ["bro","page","--site",s,"--tab",id,"--action","eval","--arg",js])`
  (argv array, never a shell string), parse JSON `{value}`; on `{ok:false}` throw with `error.kind`.
  If the tab died, re-ensure once and retry once.
- `broFetch(site, url, headers?)`: builds `(async()=>{const r=await fetch(URL,{credentials:"include",headers:H});return JSON.stringify({status:r.status,body:await r.text()})})()`
  with URL/H injected via `JSON.stringify` (no string concatenation of untrusted text). Non-2xx -> throw
  `"<status> <statusText> for <url>"` (same message shape `cookiePlatformIO` uses -- `espnSession.ts`
  probes key off it).
- `broPost(site, url, body)`: same, `method:"POST"`, `content-type: application/json`; returns
  `{status, body}` and NEVER throws on non-2xx (write contract: status is the result). This is exactly
  the request the app's `/write-transaction` made from inside the espnview guest (app/main.js ~L592).
- `broLogin(site)`: detect logged-out (ESPN: no `SWID` cookie or 401 from lm-api-reads; Yahoo: tab URL
  on `login.yahoo.com`) -> throw `NotLoggedIn` with the exact owner action text from section 6. Never
  automate the password (D2): login is `bim bro auth --site <s>` or the Slack `request_secure_login` flow.

**Host allowlist (keep the semantics of `app/bridgeHosts.js` + the dce64e7 /fetch fix):** move the host
check into `broFetch`: parsed `new URL()` hostname, https only, default port, no userinfo, dot-boundary
suffix match against the per-site list (espn: `espn.com`; yahoo: `yahoo.com`). The site is chosen from
the URL host, never from the caller's say-so; a URL whose host matches no site is refused before any
`bim` call. Port the cases from the bridge allowlist tests into `test/bro-session.test.ts`.

**Write guard stays in `src/league/writeIO.ts` unchanged** (`ESPN_WRITE_URL_PATTERN`,
`ESPN_WRITE_TYPES`, execution-type + ROSTER-is-LINEUP-only checks, `MAX_WRITE_BODY`). Replace
`bridgeWriteIO` with `broWriteIO` that calls `assertWritableUrl`/body checks FIRST, then `broPost("espn",...)`.
The app's duplicate allowlist disappears with `app/`; `test/write-contract.test.ts`'s
app-vs-TS agreement assertion is deleted and replaced by fault-injection tests that `broWriteIO`
refuses a non-allowlisted URL, a FREEAGENT CANCEL, a ROSTER with an ADD item, and an oversize body,
WITHOUT spawning `bim` (inject the exec function; assert it was never called).

## 2. Inventory -> mapping

Session resolver `src/league/session.ts`: kinds become `"bro" | "cookie"`, default `"bro"`.
`bridgePlatformIO(host)` -> `broPlatformIO(host)` (`get: (url,h)=>broFetch(siteFor(host),url,h)`), in
`src/league/platform.ts`. `FF_SESSION=bridge` is rejected with a message naming D55.

| caller | today | becomes |
|---|---|---|
| `src/league/platform.ts`, `session.ts`, `agent/agent.ts`, `data/espnSession.ts`, `scripts/platform-onboard.ts` | `bridgePlatformIO` | `broPlatformIO` |
| `src/league/writeIO.ts` | `bridgeWriteIO` -> `bridgeWriteTransaction` | `broWriteIO` -> `broPost` (guards unchanged) |
| `src/league/yahoo.ts` (yahooIO; `yahooview` guest) | `bridgeFetch(..,{host})` | `broFetch("yahoo", ...)` (HTML page reads, same parsers in yahooDom.ts) |
| `src/league/espn.ts` (`attachWebview` for settings DOM) | webview page | `broEval("espn", <DOM snippet>)` after `goto` via `bim bro page --action goto`; if the snippet uses Playwright Page API beyond evaluate, port to plain DOM JS |
| `src/data/leagueRosters.ts` (**sync-rosters**) | `bridgeFetch` | `broFetch("espn")` |
| `src/data/leagueTransactions.ts`, `data/eligibility.ts`, `weekly/espnProjections.ts` | `bridgeFetch`/`bridgeAvailable` | `broFetch`; `bridgeAvailable()` -> `broAvailable()` = `bim` on PATH + session live/startable |
| `src/inseason/waiverClaim.ts` (**claim --add/--bid, --fa-add, --list, cancel**) | `bridgeFetch` reads + writeIO | `broFetch` reads + `broWriteIO`; locked-man refusal, WAIVERS-vs-FA refusal, dry-run default, live-roster VERIFIED re-read all unchanged |
| `src/inseason/lineupWrite.ts` (**set-lineup --week N**) | same | same swap; locked-slot refusal + VERIFIED re-read unchanged |
| `src/inseason/proposeTrade.ts` (**propose-trade**) | same | same swap |
| `src/ff.ts` L4842 (read-only GET) | `bridgeFetch` | `broFetch("espn")` |
| `src/ff.ts` L1798, L2493 (`--port` / `FF_CDP_PORT ?? "9223"`), L636-664, L847-986 (`--app`, `attachWebview`, draft room verbs `enter-draft`/`auto-draft`/`launch-practice`/`roster --app`), `bridgeRead` (L1784) | Electron webview / CDP | **draft-room verbs are deleted** (season is in progress, no draft until 2027; record in D55 that 2027 draft needs a bro-based room driver -- open item). `bridgeRead` callers -> `broEval` after `goto`. Remove `--app`/`--port`/`FF_CDP_PORT` parsing entirely |
| `src/agent/agent.ts` L789 (`connectOverCDP` on FF_CDP_PORT) | CDP | delete with the draft agent path, or point at `broEval` if used in-season (check: if only draft, delete) |
| `src/agent/browserTools.ts` (`bridgeReadFrame`, `bridgeClick`, `attachWebview`) | draft-room frame read/click | delete (draft-only) |
| `src/browser/appBridge.ts`, `webviewPage.ts`, `attach.ts` | | delete |
| `scripts/mock-suite.mjs`, `webview-selftest.mjs`, `validate-scoring.mjs` | `--app`/webview | delete (draft mock harness) -- or `validate-scoring` -> broFetch if it is not draft-only |
| `scripts/format-fetch.mjs`, `weekly-espn-probe.mjs` | `bridgeFetch` | `broFetch` |
| `test/serve-client.test.ts` (requires `app/serveClient.js`) | | delete |
| `test/sleeper-adapter.test.ts` L360 | asserts public IO avoids bridge | change regex to `/bim bro|bro session/` |
| `test/platform-io-providers.test.ts`, `platform-seam.test.ts`, `session-resolver.test.ts`, `write-contract.test.ts` | bridge providers | rewrite for bro with injected exec (no live `bim` in unit tests) |
| `app/` (main.js, preload.js, renderer/, bridgeHosts.js, blockHosts.js, serveClient.js, package*.json) | | **delete**; drop any root `package.json` scripts/workspaces that reference it (`npm run app`, electron dev dep) |
| `data/app-bridge.json`, `x-ff-token` | bridge discovery/auth | gone (no local HTTP server any more, so no token to protect) |
| docs: README, CLAUDE.md (Electron webview traps, single-instance lock), AGENTS.md (ESPN/Yahoo sessions section), docs/architecture.md, docs/platform-adapter.md | | rewrite the session sections to "bro session `espn`/`yahoo`"; mark historical bits as such |
| `ff serve` (NDJSON server used by the app) | | delete if its only client was `app/serveClient.js` (grep first) |
| Hermes `scripts/ff_news_watch.py` L29-37 | loops FF_CDP_PORT 9225/9224/9223 for `sync-rosters` | single call `ff sync-rosters --league 462233` (no env); failure note becomes "bro espn session not logged in -- run `bim bro auth --site espn`" |
| Hermes `scripts/ff_trade_watch.py` | public feeds + sqlite only; no app/port refs found | no code change expected; must still pass `--dry` |

Verb -> bro call summary: every read is `broFetch(site, url)` = `bim bro page --site <s> --tab <t>
--action eval --arg <fetch-js>`; every write is `broWriteIO` (TS guards) -> `broPost("espn",
lm-api-writes .../transactions)` via the same eval. Yahoo is reads only.

## 3. Build steps (ONE Sonnet card, worktree H:/working/ff-assistant-bro)

1. `npm install better-sqlite3 && npm install` in the worktree (order matters, see CLAUDE.md). Copy or
   point at `data/ff.db` read-only for dry runs: set `FF_DB=H:/working/ff-assistant/data/ff.db` if the
   code supports it, else copy `ff.db`+`-wal`+`-shm` into the worktree `data/` (gitignored). Never write
   the shared main checkout.
2. Add `src/browser/broSession.ts` + `test/bro-session.test.ts` (host allowlist cases, exec injected,
   argv-not-shell, tab-retry, NotLoggedIn message). Fault-inject: break the hostname check, watch it fail.
3. Add `broPlatformIO`/`broWriteIO`; switch `session.ts` default to `bro`; rewrite the four provider tests.
4. Swap every caller in the table; delete draft-room verbs + browserTools + appBridge/webviewPage/attach.
5. `git rm -r app/`, delete `test/serve-client.test.ts`, draft mock scripts; fix package.json.
6. `rg -n "FF_CDP_PORT|MC_CDP_PORT|app-bridge|x-ff-token|serveClient|--app\b|bridge(Fetch|Read|Click|WriteTransaction|PlatformIO|WriteIO)|attachWebview|connectOverCDP" src scripts test`
   -> zero hits (docs may keep historical mentions marked as such).
7. Docs + D55 status `APPLIED` in docs/decisions.md (the PROPOSED entry is already on this branch).
8. Verify (acceptance below), commit explicit paths, push `feat/bro-cutover`, open PR, `kanban_complete`.

**Acceptance (all with output pasted in the completion metadata):**
- `npm run typecheck` clean; `npm run lint` clean.
- full `npm test` green -- run it in the background (~20 min), data-dependent tests may SKIP.
- live, bro espn session, all DRY-RUN (no `--send`/`--write` of any roster move -- those need libo's yes):
  `ff sync-rosters --league 462233`; `ff claim --list`; `ff claim --fa-add <FA> --drop <bench>` (dry);
  `ff claim --add <WAIVERS man> --bid 1 --drop <bench>` (dry); `ff set-lineup --week 12` (dry);
  `ff propose-trade ...` (dry); `ff news-watch --state <tmp> --dry-run`;
  `python C:/Users/TLDR/AppData/Local/hermes/scripts/ff_trade_watch.py --dry`;
  `python .../ff_news_watch.py` with the edited sync call (or its dry path).
  Each dry run must print the would-send body and pass `assertWritableUrl` + type checks.
- A locked-man claim/lineup dry run is still refused (pick a player whose game started, or TNF man
  after kickoff; else assert via unit test).
- With the espn session STOPPED, a read fails loudly with the NotLoggedIn/no-session message, never an
  empty league.
- Yahoo: if the owner has logged in (section 6), `ff sync-rosters`/`discover` for Yahoo league 129048
  reads; if not, it fails with the NotLoggedIn text -- record which.

## 4. Cutover (the Slack session runs these; each needs an approval prompt)

1. Merge the PR to main (after the card's acceptance passes). Pull into the shared checkout ONLY after
   the other session's WIP there is committed/stashed by its owner -- do not clobber
   `app/renderer/app.js`, `src/ff.ts`, `src/inseason/newsWatch.ts`.
2. Stop the Electron app: find it (`tasklist | findstr /i electron` -- note: hung for 180s from bash in
   this run; use PowerShell `Get-Process electron`), `taskkill /PID <pid>`. Remove any startup shortcut /
   scheduled task that launches it.
3. Start the session: `bim bro session --op start --site espn --detach` (and `yahoo`). Decide whether a
   cron/startup entry keeps it alive (recommended: `broSession.ensureSession` starts it on demand, so no
   daemon needed).
4. Update cron prompts in `C:/Users/TLDR/AppData/Local/hermes/cron/jobs.json` (back it up first) that
   mention the app, `--app`, ports 9223/9224/9225, or "is the ff app running":
   ff-espn-mon-mnf-check, ff-espn-sat-set-lineup, ff-espn-sun-inactives-early, ff-espn-sun-inactives-late,
   ff-espn-thu-tnf-lock (fires Thu -- must be done before 11-19), ff-espn-tue-waiver-day,
   ff-espn-wed-waiver-results, ff-news-watch, ff-wk11-dst-bye, ff-wk11-dst-fa-add (wk11 ones: likely
   stale, propose removal). Edit via `hermes cron` (load the hermes-agent skill), not by hand if avoidable.
5. Edit `scripts/ff_news_watch.py` per section 2.
6. Update skill `productivity/ff-assistant` SKILL.md + `references/outside-issues-and-app-fixes.md`:
   app/bridge sections -> bro sessions; bridge security rules -> "host allowlist + write contract live in
   TS (`broSession.ts`, `writeIO.ts`)".
7. Smoke from Slack: `ff sync-rosters --league 462233` and `ff set-lineup --week 12` (dry).

## 5. Rollback

Last commit with `app/`: **dce64e7** (main before this change). `git revert <merge-sha>` on main (or
`git checkout dce64e7 -- app src scripts test` in an emergency worktree), `cd app && npm install &&
npm start` (see app/README.md at dce64e7), restore the backed-up cron `jobs.json` and the old
`ff_news_watch.py`. The app's own ESPN login lives in its Electron profile and is untouched by this change.

## 6. Owner actions

- **None for ESPN** -- the bro `espn` profile is already logged in.
- **Yahoo (league 129048): one interactive login.** On the PC run `bim bro auth --site yahoo` (or from
  Slack, tot runs `request_secure_login` on the `yahoo` session with a Proton Pass link), sign in to
  Yahoo, finish any 2FA. One time; the persistent profile keeps it. Also commit
  `H:/working/bro/sites/yahoo/site.json` in the bro repo (created in this spike).
- Approve the cutover prompts in section 4 and, separately, any `--send` roster move.
- 2027 draft: the draft-room driver goes with `app/`; a bro-based room driver is an open item for 2027.
