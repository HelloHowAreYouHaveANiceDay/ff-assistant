# Architecture review -- multi-league / multi-format state of the repo (2026-09-16)

Read-only review of `main` @ 0835e7a by five parallel reviewers (storage seam, format/model layer,
platform layer + app, in-season copilot, docs/hygiene), cross-checked against the live store and the
running app. This file is the consolidated finding list, the target architecture, and the work plan
the fix session executes against. Line numbers are as of 0835e7a.

**Pre-change baseline (the incumbent's byte-identity gate):** `backtest --full --no-lookahead
--inflation --seasons 1999-2024 --n 150` at 0835e7a = **39.5% championships / 96% playoffs**, per-season
line `2000:28 2001:31 2002:44 2003:47 2004:32 2005:29 2006:49 2007:19 2008:47 2009:55 2010:44 2011:62
2012:47 2013:41 2014:29 2015:38 2016:29 2017:33 2018:41 2019:36 2020:43 2021:35 2022:54 2023:33 2024:40`.
Every wave below must reproduce this line exactly (CRN seeds make the trials a matched pair; a
different season number means an input drifted). Store backup taken before any migration:
`data/ff.db.bak-prearchfix-2026-09-16` (integrity ok, 3 league rows, 24,367 fact_roster_week rows).

Tooling state at 0835e7a: `tsc` clean; `eslint` 0 errors / 49 warnings (`no-useless-assignment`);
`npm test` 508 pass, 1 FAIL -- `test/roster-completeness.test.ts` HANGS for 9 minutes whenever the app
is running (see I-8 below), then is reported failed by the runner.

## 1. What is actually true today (live store, 2026-09-16)

- `league` rows: **462233** espn (team 8, scoring_json present, synced 09-13); **129048** yahoo
  (`team_id NULL`, `scoring_json NULL`, synced 09-16 -- the NEWEST); **211696** espn 2027 stub (name
  NULL, no config; a `discover_leagues` artifact of a link scrape).
- `settings.active_league = 462233`. So `activeLeagueId()` says ESPN while every
  `ORDER BY last_synced_at DESC LIMIT 1` resolver says Yahoo. Both are live in the same process.
- `config:129048` is a byte-copy of the ESPN config with `teams`, `slots` and `scoring:"STD"` edited.
  It still carries ESPN's `format` block verbatim (13 reg weeks, 7-team playoff wk14-16, four ESPN
  divisions with ESPN team ids, `source:"espn"`), ESPN's half-PPR `scoring_rules` (`rec 0.5`), ESPN's
  `kicker`/`defense`/`posMax`/`rosterSettings` ("League Name: seacaptaindate.com", "Draft Type: Salary
  Cap"), `budget 200`, `flex_ok [RB,WR,TE]` beside a `SUPERFLEX` slot, and no `platform`. Root cause:
  `getConfig(db, id)` falls back to the legacy `config` MIRROR (another league's config) when
  `config:<id>` is absent, and `setConfig` merges on top of that (db.ts:329, :341).
- The ground-truthed Yahoo scoring exists only as the constant `YAHOO_129048_SCORING`
  (scoring.ts:68); nothing in `src/` reads it, and `scoringKey(config:129048.scoring_rules)` =
  `sc-f6143a8dfb13` = the ESPN key, not the Yahoo dir `sc-a845f67652fb`.
- `data/formats/sc-a845f67652fb/` holds history CSVs, `features.db`, a trained projection artifact and
  a hand-built `fa-pool.json`. Nothing under `src/` reads `data/formats/` at all; the Yahoo model is
  reachable only from five `scripts/yahoo-*.mjs` / `value-format-compare.mjs` that hardcode the key
  and the league id. `feat_player_week_model` inside the format DB is a row-for-row half-PPR copy
  (measured), so any weekly serve off it would be half-PPR.
- `.gitignore:9` carried a trailing `# comment` on the `data/formats/` pattern line; git does not
  support inline comments, so the ~1GB format dir was NOT ignored (`git add --dry-run` staged it).
  Fixed in this session.
- The app: one Electron instance (pid 39000, CDP 9223), two guests -- `espnview` at
  fantasy.espn.com/football/ (home page) and `yahooview` at the Yahoo fantasy home.
  `mcp read_league` returns "could not read league (auth?)".

## 2. Findings, by seam (BLOCKER = wrong numbers / data loss / wrong-league action, silently)

### S. Storage + LeagueContext seam

- **S-1 BLOCKER. Four disagreeing "which league" resolvers.** `activeLeagueId` (db.ts:303) honours
  `settings.active_league`; `currentLeagueId` (leagueHistory.ts:37) and `activeLeague`
  (agent.ts:690) use last-synced only; `simContext.ts:96` and `proposeTrade.ts:41` do
  `WHERE season=? AND team_id IS NOT NULL` with `.get()` (arbitrary row). ~16 more inline
  last-synced queries: espn.ts:85, ff.ts:427/464/748/1646/1711/2118/4041, backtest/faab.ts:104,
  copilotStore.ts:198. `REAL_LEAGUE="462233"` hardcoded at ff.ts:725.
- **S-2 BLOCKER. Writers stamp `league_id` from the wrong resolver.** leagueRosters.ts:314,
  leagueTransactions.ts:200/230, rosterState.ts:324, leagueHistory.ts:164 use `currentLeagueId`
  -> today they would fetch ESPN 462233 data and write it under `league_id='129048'`.
- **S-3 BLOCKER. `league_sync` reads league A and writes league B.** agent.ts:388 picks by
  last-synced (Yahoo), :391 fetches ESPN `leagues/129048`, :412 UPDATEs the Yahoo row with ESPN
  scoring, :449 `setConfig(db, ...)` with no id -> lands on the ACTIVE league (ESPN). The
  degenerate-read guard (:445) checks emptiness, not identity.
- **S-4 BLOCKER. `fact_team_season` / `fact_matchup` wiped for ALL leagues** on rebuild
  (picks.ts:303-304, `DELETE` with no WHERE) -- the `DELETE FROM team_odds` lesson recorded in
  docs/multi-league-refactor.md:130-133, still present.
- **S-5 BLOCKER. `fact_draft_pick`, `fact_team_season`, `fact_matchup` have `league_id` as a
  column but NOT in the PK** (live PKs `[season,team_name,pick_order]`, `[season,team_id]`,
  `[season,week,home_id]`); upserts at picks.ts:101/287/299 collide across leagues. The refactor
  doc's "already keyed (18)" list is wrong for these three.
- **S-6 BLOCKER. The feeds of those tables are unfiltered** (picks.ts:58/85/89/250/255/263 read
  `raw_league_*` by season only; `shape.get(yr)` returns whichever league loaded last).
- **S-7 BLOCKER. New-league config is seeded from the active league** (db.ts:329/341) -- the
  root cause of section 1's fabricated Yahoo config. `validateFormat` (league/index.ts:100) checks
  shape only, so a copied block passes.
- **S-8 BLOCKER. Switching the active league does not rebuild or invalidate `board` /
  `player_value` / `player_value_position`.** `setActiveLeagueId` (db.ts:314) writes two settings
  and stops; the "rebuilt on switch" claim in multi-league-refactor.md:134-136 describes code that
  does not exist. 529 ESPN half-PPR auction rows would be served as Yahoo values by appdata.ts:10/50,
  copilotStore.ts:97/133, simContext.ts:107, ff.ts:384/1097/3143, agent.ts:33.
- **S-9 BLOCKER. 21 unfiltered readers of the Phase-2b league-keyed tables** (`fact_roster_week`,
  `fact_lineup_week`, `fact_fa_pool_week`, `fact_waiver_claim`): inseason/faab.ts:104/192/292-311,
  backtest/{faab,waiver,lineup,winprobLineup,harness,streaming}.ts, population.ts:150/177,
  streamingEvaluate.ts:316, proposeTrade.ts:34/52, scorecard.ts:412, ff.ts:2084/2688, plus
  `raw_league_transaction` readers (faab.ts:129, backtest/waiver.ts:84/109, inseason/faab.ts:257).
  Team ids collide numerically across platforms (ESPN 1-18, Yahoo 1-12).
- **S-10 SHOULD-FIX. `resolveLeagueContext` has zero production callers and ignores its own
  argument** (leagueContext.ts:30-34: `id` from one resolver, `getConfig(db)` from another). Phase 1
  "swap the call sites" was never done.
- **S-11 SHOULD-FIX. 12 direct `settings WHERE key='config'` readers** bypass `getConfig`
  (league/index.ts:125/134/203, espn.ts:88, copilotStore.ts:34, simContext.ts:95, stgPlayer.ts:190,
  ff.ts:374/1028/1033) plus scripts (`read-config`, `set-lever` WRITES it, `lever-connected`,
  `value-gates`, `waiver-sweep`, `sim-convergence`, `validate-scoring`, `audit-selfref`,
  `lib/deps.mjs`). `setConfig`'s `!id` branch (db.ts:344) can write the mirror with no league.
- **S-12 SHOULD-FIX. `openLeague` dispatches on `cfg.platform`, a field `AppConfig` does not have**
  (league/index.ts:205-218) -- the loud "no adaptor" refusal is unreachable; the Yahoo league gets an
  ESPN adaptor holding id 129048. `AppConfig` also has no `draftType`.
- **S-13 SHOULD-FIX. `draft`/`draft_state`/`draft_pick`/`my_roster` share one `'local'` session
  across leagues; `action_log` has no `league_id`; `decision_snapshot`'s own CREATE (decisionSnapshot.ts:19)
  lacks the `league_id` its INSERT (:46) uses; `migrateLeagueIdPk` drops indexes it cannot restore
  (db.ts:115 runs after schema.sql, not before); `scheduler`/`season`/`last_ingest` settings and
  `data/live-state.json` are single-slot.**
- **S-14 NIT.** Junk league row 211696; `discover_leagues` writes `name NULL` and any leagueId in any
  href (agent.ts:373); four copies of the ESPN slot/pos id maps (agent.ts:16, ff.ts:1720,
  leagueRosters.ts:51, espnSlots.ts).

### F. Format / model layer

- **F-1 BLOCKER.** `scoringKey(config:129048)` = the ESPN key (section 1). Any naive resolver routes
  Yahoo to the ESPN model.
- **F-2 BLOCKER. Nothing in `src/` computes a format key or reads `data/formats/`**; `valueKey` and
  `formatKey` do not exist as functions (formatKey.ts exports `canonicalJson` + `scoringKey` only;
  D24's text claims all three). No `config -> format -> artifact paths` resolver exists.
- **F-3 BLOCKER. The ESPN incumbent has no format dir and no alias rule.** `scoringKey(DEFAULT_SCORING)`
  = `sc-f6143a8dfb13`; every ESPN artifact is read from the `data/` root via `dataPath()`. A resolver
  that silently falls back to `data/` for a missing key would serve every unbuilt format the ESPN
  numbers -- the exact blocker shape.
- **F-4 BLOCKER. The weekly track has no format axis.** `loadWeeklyBaseArtifact` defaults to the
  ESPN projection artifact (weekly/features.ts:585); `WEEKLY_SERVE` files resolve through `dataPath`
  (streamingServe.ts:102-109, :206); scorecard.ts:510/529 the same; the format DB's
  `feat_player_week_model` is a stale half-PPR copy (build-format-features.mjs never rebuilds it).
- **F-5 SHOULD-FIX.** Format dir carries no `scoring.json`/`features.json`/`golden.json` preimage
  (design doc:102-110 specifies them); the key is unverifiable against anything but the constant.
- **F-6 SHOULD-FIX.** All five format scripts hardcode `"sc-a845f67652fb"` and `"129048"`; the two
  builders hardcode the constant (`SCORINGS = { yahoo: YAHOO_129048_SCORING }`).
- **F-7 SHOULD-FIX.** Per-scoring artifacts read from the ESPN root regardless of league:
  `points.csv`, `values.csv`, `current-actuals.csv` (one file, active league's scoring,
  history.ts:179-196), `variance-model.json`, `rank-outcomes.json`, `correlation-model.json` (all three
  feed the D18 seeded simulator), `def-ratings.csv`, `fold-artifacts-d16`, `managers.json` (ESPN
  owners), `faab-model.json`. Correctly shared: injury-duration, opponent-correlation, age-curve,
  opportunity-model, nflverse cache, identity, `raw_pbp_player_week`, `ros-blend.json` (K, asserted
  NFL-level).
- **F-8 SHOULD-FIX.** The format target CSVs include the LIVE season (2026) while the ESPN target
  stops at 2025 (history.ts:166-177 says history-*.csv are frozen backtest inputs); 421 of 590 2026
  rows carry a partial-season `pts`.
- **F-9 SHOULD-FIX.** No `--league`/`--format` axis on `cmdBacktest` (ff.ts:2179-2188) or
  `cpcv.mjs`; the golden (`GOLDEN=96.0`) and the ledger are not keyed by format.
- **F-10 NIT.** `scripts/read-config.mjs:11` prints `scoring rec: undefined` (reads `cfg.scoring`, a
  string, not `cfg.scoring_rules`) -- the repo's "trust this" reader shows nothing about scoring.
  `AppConfig.format` (playoff calendar) vs "format" (ruleset identity) is an overloaded word.

### P. Platform layer + app

- **P-1 BLOCKER. No platform dispatch on discover/sync.** `discover_leagues` hardcodes `'espn'`
  (agent.ts:373); `league_sync`, `read_league`, `sync-rosters` (ff.ts:1711-1766, DELETE + reinsert
  under the last-synced id), `ingestAll`'s league sources (ingest.ts:227/447/461) all build ESPN
  URLs for whatever league id they resolve.
- **P-2 BLOCKER (latent). `propose_trade` picks its league with an unordered `.get()`**
  (proposeTrade.ts:41) and POSTs to ESPN (:90) -- the system's only outward write; excluded from the
  Yahoo row only because its `team_id` is NULL today.
- **P-3 SHOULD-FIX. The app bridge's host filter falls back to ANY guest** (app/main.js:458
  `onHost.length ? onHost : guests`): with no guest on espn.com, `/read-frame` and `/click` act on
  the Yahoo webview silently. `/fetch` hardcodes `espnview` (:680) with an espn.com-only allowlist;
  `bridgeFetch`/`bridgeReadFrame`/`bridgeClick` (appBridge.ts:44/114/146) take no host/platform.
- **P-4 SHOULD-FIX. Renderer page tabs build ESPN URLs for every league** (app.js:48-58, `espnGo`
  :60 always targets `#espnview`); `switchLeague` (:98-104) calls `setView("live")` BEFORE
  `setBrowserPlatform`, so every switch first navigates the hidden ESPN webview to
  `fantasy.espn.com/football/draft?leagueId=129048` -- a different, real ESPN league -- and that URL
  becomes the longest espn.com url the bridge prefers.
- **P-5 SHOULD-FIX. No Yahoo adaptor exists** (`src/league/` has espn only); the Yahoo roster is a
  hardcoded 18-name array in `scripts/yahoo-waiver-trade.mjs:15`; the Yahoo `league` row and
  `config:129048` were created by hand (no verb writes `platform='yahoo'`).
- **P-6. MCP: 0 of 39 tools take a league argument; 14 are ESPN-hardcoded with no platform check;
  3 (`league_sync`, `read_league`, `refresh`) resolve by a rule the app's tabs do not use.**
- **P-7 NIT.** `attachWebview`/`rendererPage` hardcode CDP port 9223 while the bridge file names the
  newest instance -- with two platform webviews per instance a split-brain can pick the wrong
  PLATFORM, not just the wrong page.

### I. In-season copilot

- **I-1 BLOCKER.** `loadSimContext` is single-league by construction (S-1) and reads the raw
  `config` mirror (simContext.ts:95), the single-slot board (:107), `points.csv` pool ranks (:149),
  and the ESPN variance/rank-outcomes/correlation artifacts (:90-92).
- **I-2 BLOCKER. The lineup optimizer and `rosterGaps` have their own literal-FLEX rule** instead of
  `slotEligibility` (lineup.ts:59-66, season.ts:361-365/394-397): a `SUPERFLEX` slot matches nobody
  (lineup silently scores it 0; `assertRostersCanFillLineup` refuses every Yahoo roster so six verbs
  throw). `values.ts:108-123` already parses SUPERFLEX/`Q/W/R/T`/`W/R/T` correctly.
- **I-3 SHOULD-FIX. Four enumerations of "bench"** (lineup.ts:62 and winprob.ts:476 `BE|BENCH`;
  season.ts:362 `+IR`; values.ts:154 `+IR|ER`) -> Yahoo's two IR slots become two permanent
  "no available player to fill IR" flags.
- **I-4 BLOCKER. FAAB is ESPN-only** in model (`faab-model.json` fitted on 462233), queries
  (inseason/faab.ts:249-259/296-298 season-only), and rules (`AcquisitionRules` exists,
  types.ts:252, implemented once, ZERO consumers). Yahoo FAB 2-day rolling has no representation.
- **I-5 BLOCKER. `scorecard_prediction`/`scorecard_result` are shared across FORMATS** with PK
  `(season, week, kind, model, subject)` and `INSERT OR IGNORE` everywhere (scorecard.ts:571-734): the
  second format's rows are silently dropped, and `odds` subjects (team ids) collide outright.
  Sharing is correct per format, false across formats.
- **I-6 SHOULD-FIX.** `scripts/yahoo-ros-analysis.mjs` re-implements the ROS rate with a DIFFERENT
  denominator (rows present vs scheduled non-bye weeks, simContext.ts:240-258 -- the frame K was
  fitted in), its own greedy lineup fill, a hardcoded roster and its own FA pool.
- **I-7 SHOULD-FIX.** `action_log` and `routines` are league-blind; `ff copilot` has no `--league`
  and silently ignores an unknown flag (ff.ts:3788-3805); `regWeeksFor` (regWeeks.ts:15) takes
  `MAX(reg_weeks)` across leagues; `NFL_WEEKS=17` vs `regWeeks` as "a week" divisor (copilot.ts:53
  vs simContext.ts:359).
- **I-8 BLOCKER (test hygiene). `loadSimContext` "auto" opens the live league over CDP with NO
  timeout** (simContext.ts:273-292) and `test/roster-completeness.test.ts:162` calls it -> the unit
  suite hangs ~9 minutes whenever the app is running (measured: 533 s, 1.25 s CPU). The test also
  reads the config mirror and the ambiguous league query.

### D. Docs / hygiene

- AGENTS.md:57 says the Electron app "is the part still to be scaffolded" (it is built, AGENTS.md:9).
- README.md:282 "35-tool" (truth: `TOOL_NAMES.length` = 39); README.md:48-50 lists multi-league
  fan-out as "not yet built"; README.md:316-317 "Shipped levers" is pre-D14/D15/D21 (benchDiscount
  0.35, consensusBlend 1); README Layout tree omits `src/{features,league,lineage,model,util,weekly}`;
  "(D0-D11)" at README.md:116/444, AGENTS.md:19, CLAUDE.md:264 while decisions run to D24;
  docs/validation.md:4559 names `sim-calibration.mjs` (renamed `season-calibration.mjs` in d8a7fc3);
  D24 (decisions.md:831) claims `valueKey`/`formatKey` exist.
- No test for `formatKey` canonicalization (key-order / float-noise / tier-order invariance + a
  positive control that a real rule change moves the key); no test for `config:<id>` isolation; no
  test that a second league's rows leave the first league's reads unchanged.
- `data/experiments.jsonl` (+2 appended ledger rows) and `data/player-report.csv` (ADP drift only)
  are regenerated output, not hand edits.

## 3. Target architecture (what "done" means for this pass)

```
LeagueContext (src/data/leagueContext.ts)  -- THE ONLY WAY code learns which league / config / model
  { leagueId, platform, config: AppConfig(+platform,+draftType), format: ResolvedFormat }
  resolved ONCE per verb from activeLeagueId(db) or --league <id>; threaded, never re-derived.
  currentLeagueId / activeLeague / inline last-synced queries / REAL_LEAGUE: DELETED.
  getConfig(db, explicitId): config:<id> else DEFAULT_CONFIG  (NEVER another league's mirror).
  legacy `config` key: a derived mirror written only by setActiveLeagueId; no reader left.

ResolvedFormat (src/data/formatResolve.ts)
  keys: scoringKey(LeagueScoring incl. kicker/defense) / valueKey(resolveValueLeague shape + draftType)
        / formatKey(valueKey + calendar)     -- all via canonicalJson; tested for invariance.
  model: ModelHandle = every per-scoring/per-value path a format owns (history CSVs, current-actuals,
        features.db, projection + fold + weekly artifacts, variance/rank-outcomes/correlation,
        points/values csv, golden.json).
  INCUMBENT ALIAS: scoringKey(ESPN) -> data/ root, pinned as a constant AND asserted at load.
  any other key -> data/formats/<key>/ must exist AND <dir>/scoring.json must re-hash to the key;
  a MISS THROWS naming the build command -- never a fallback to data/.
  SHARED-NFL artifacts (injury, opponent-corr, age, opportunity, ros-blend K) stay at the root.

Platform (src/league/platform.ts)  -- the SYNC/DISCOVER/URL half beside the read-side LeagueProvider
  { id, urls{home,league,team,scoreboard,standings,draftRoom}, webview{elementId,host,partition},
    discover, syncSettings -> LeagueSettings{scoring,kicker|null,defense|null,slots,teams,draftType,
    budget|null,format(+leagueId,+platform),acquisition}, syncRosters, syncTransactions?, readTeam }
  espn: lifted from agent.ts/espnApi/leagueRosters/leagueTransactions/espn.ts.
  yahoo: NET-NEW DOM reader through the yahooview guest (bridge routes take a host).
  openLeague / every sync verb dispatch on the LEAGUE ROW's platform; an absent adaptor REFUSES BY NAME.

Storage
  league_id in the PK of every per-league table (adds fact_draft_pick, fact_team_season, fact_matchup;
  draft_id league-qualified; action_log.league_id); every reader filtered by ctx.leagueId; every DELETE
  scoped. board/player_value* carry a league+valueKey stamp; readers REFUSE on mismatch; league-set-active
  invalidates and rebuilds. scorecard_* keyed by format_key.

In-season
  slot matching = slotEligibility everywhere (lineup, rosterGaps, winprob); one isBenchSlot;
  loadSimContext(ctx) with a TIMEOUT on the live read; weekly serve per format (refuse or fall back to
  the format's own season line, named in basisNote); FAAB per league (rule basis when no fitted model);
  --league on ff copilot + optional league on MCP; provenance names league + format.

App
  league switch = one transactional engine call returning the context; platform set BEFORE view;
  page URLs platform-dispatched through activeWv(); bridge guest resolution by host with NO fallback.
```

## 4. Work packages (owner / executor model / gate)

Each WP: tsc clean, `npm test` green (and not hanging with the app up), the golden line above
byte-identical, plus the WP's own positive control and fault injection. Commits per WP with explicit
paths. ESPN behaviour must not move in WP1-WP5; Yahoo becomes correct or REFUSES loudly, never
silently ESPN-shaped.

- **WP1 (opus) -- One resolver + the context seam.** S-1, S-2, S-3, S-7, S-10, S-11, S-12, S-14
  (name/season on discover; junk row), I-7 `--league` flag + MCP arg, I-8 timeout. Adds `platform`
  + `draftType` to AppConfig. Tests: config isolation, explicit-id no-inheritance (fault injection),
  resolver agreement, league_sync identity guard.
  **DONE 2026-09-16 (working tree, uncommitted).** `resolveLeagueContext` is the only resolver;
  `currentLeagueId`/`activeLeague`/`REAL_LEAGUE` and every inline last-synced league query are gone
  (`src` now has `last_synced_at DESC` only inside `activeLeagueId` and the `league-list` ORDER BY);
  no reader of `settings key='config'` is left in `src/` or `scripts/`. `getConfig(db, <explicit id>)`
  falls back to `DEFAULT_CONFIG`, never the mirror; `setConfig` refuses a league-less write.
  `openLeague` dispatches on the league ROW's platform and its refusal is now reachable and tested.
  `--league <id>` on the CLI + an optional `league` on all ten MCP copilot tools; `ff copilot` rejects
  unknown flags. `loadSimContext`'s live read is bounded by `FF_LIVE_READ_TIMEOUT_MS` (default 15 s;
  positive control `scripts/live-read-timeout-probe.mjs`), so `npm test` now finishes in ~185 s with
  the app running (was 533 s + 1 fail). Junk league row 211696 deleted. Gate: `backtest --full
  --no-lookahead --inflation --seasons 1999-2024 --n 150` = 39.5% / 96% with the per-season line
  byte-identical to the baseline above. Not done in WP1: `app/engine/ff.cjs` is a stale build artifact
  (`npm run build:engine` regenerates it); `ingest-source` has no `--league` passthrough yet (its
  league sources resolve the active league and refuse a non-ESPN platform by name).
- **WP2 (opus) -- Storage integrity.** S-4, S-5, S-6, S-8 (stamp + refuse + rebuild hook), S-9, S-13,
  I-5 (format_key on scorecard_*), P-2. Migration is idempotent, runs against the backed-up store.
  Test: synthetic second-league rows in every keyed table leave every ESPN read byte-identical.
  **DONE 2026-09-16 (working tree, uncommitted).** `league_id` now leads the PK of `fact_draft_pick`/`fact_team_season`/`fact_matchup` (live rows preserved 1658/130/1050, indexes recreated + asserted); `buildLeagueFacts`'s two bare `DELETE FROM`s are scoped; every `fact_*`/`raw_league_*` reader in `src/` is filtered (test/league-isolation-readers.test.ts is differential -- league A's reads on a two-league store vs an A-only store -- and four filters were fault-injected to prove it fails); the local draft session is `local:<leagueId>`, `action_log.league_id` exists and `logAction` records it, `decision_snapshot`'s divergent CREATE moved into schema.sql; `scorecard_*` are keyed by `format_key` (3650 rows backfilled `sc-f6143a8dfb13`, asserted); `board`/`player_value` carry a league stamp and every reader calls `assertBoardFor`, with `ff league-set-active`/the serve RPC clearing + rebuilding through `switchActiveLeague`. Golden 39.5%/96%, per-season line byte-identical. NOT done: `tools/train_{price,faab}.py` still read their fact tables unfiltered; `player_value_position` has no producer and no `CREATE` in schema.sql (noted there); `liveFaabState`/`buildPopulation`/`realFaPool` take an optional `leagueId` that defaults to the active league because their callers (copilot.ts, weekly/features.ts) are WP5/WP3's to thread.
- **WP3 (opus) -- Format resolver + artifact chokepoint.** F-2..F-9, F-10, I-1 (artifact side).
  `formatResolve.ts`, `valueKey`/`formatKey`, `scoring.json` preimage, `models.ts` registry through
  `ModelHandle`, weekly/scorecard/simContext loaders threaded, `build-format-*` write the preimage and
  rebuild the weekly table, scripts use the resolver, `current-actuals` per format, format target
  frozen at settled seasons. Tests: incumbent path identity; miss throws; positive resolve to the
  Yahoo dir; formatKey invariance.
  **DONE 2026-09-16 (working tree, uncommitted).** `src/data/formatResolve.ts` is the one map from league to model files: the incumbent key aliases the `data/` root (pinned as `INCUMBENT_SCORING_KEY` in formatKey.ts, asserted at module load against `DEFAULT_SCORING`; `db.ts`'s `ESPN_SCORING_KEY` is now an alias of it), any other key must have `data/formats/<key>/` AND a `scoring.json` whose canonical re-hash equals the dir name, and a miss THROWS naming the build command -- never a fallback to the root. `valueKey`/`formatKey` are real functions; `scoringKeyFor` folds kicker/defense in by DEFAULT-ELISION, which keeps both live keys (`sc-f6143a8dfb13`, `sc-a845f67652fb`) unchanged while a non-default K or DST table moves the key (both proven in test/format-key.test.ts). Threaded through `assemble` (WP2's blanket refusal replaced by the resolver -- a format-dir league now BUILDS its board, generating its `points.csv` from its own artifact through the same `project` path), `simContext` (variance/rank-outcomes/correlation + the pool ranks), the weekly serve and scorecard, `models.ts`, `projections.ts`, `history.ts` (`current-actuals` per format; the format target frozen at SETTLED seasons, F-8) and the `ff` verbs (`project`/`assemble`/`values`/`simulate`/`calibrate`/`cheatsheet`/`sync-actuals`/`handcuffs`/`backtest`). The Yahoo format's `feat_player_week_model` was REBUILT under its own scoring (F-4): against the main store's table, 1102 of 1670 shared 2025 wk1-4 rows differ in `pts` (max |d| 20.5) and 1563 differ in `season_line_pg`, and `manifest.weekly.seasonLineBlind: false` records that no fold set exists for it yet. `player_value_position`'s producer, `CREATE` and lineage entry are restored, so `switchActiveLeague` clears all three tables. Positive controls: on a copy of the live store, switching to 129048 builds a 574-row Yahoo board stamped `sc-a845f67652fb` from the YAHOO artifact (QB 6/24 of the top value against ESPN's 1/24; `value-format-compare` on 2025 still reproduces this doc's 8/24 with Hurts $55 / Lamar $47 vs Bijan $103); the live ESPN board is byte-identical to the backup and the store is left ACTIVE = 462233. Gates: tsc clean; 886 tests / 884 pass / 2 skip; eslint 0 errors, no new warnings; golden 39.5% / 96% with the per-season line byte-identical (run twice). NOT done: `cpcv.mjs` has no `--league` and there is no per-format `golden.json`, so F-9 is only half closed (`ff backtest --league` reads the right target but the gate number is still the incumbent's); `price-model.json`/`faab-model.json` are per-LEAGUE, not per-format, and stay at the root with that stated on the registry; `src/draft/sim.ts` and `src/inseason/**` still read `variance-model.json`/`correlation-model.json`/`projection-artifact.json` through `dataPath` (other WPs' files -- see the WP3 report); the Yahoo format has no `current-actuals`, weekly artifact, variance/rank-outcomes/correlation or fold set, so its board carries no p10/p90 band and the in-season copilot on it falls back by name.
- **WP4 (opus, needs the live app) -- Yahoo config + Platform + app switch.** Correct
  `config:129048` from the LIVE Yahoo settings page (not from the recon note); `src/league/yahoo.ts`
  + `platform.ts`; bridge host param + no-fallback (P-3); renderer P-4; `league-set-active` returns
  the context and triggers the board rebuild (S-8 rebuild half). Positive control: Yahoo roster read
  live = 18 names matching the array in `scripts/yahoo-waiver-trade.mjs`, 12 teams, the schedule.
  **DONE 2026-09-16 (working tree, uncommitted).** `config:129048` rebuilt BY CODE from the live settings page (`yahooPlatform.syncSettings`, not by hand): 12 teams, snake, PPR, slots QB/WR2/RB2/TE/FLEX3/SUPERFLEX/BE7/IR2, format 14 reg weeks + 8-team playoff wk15-17 reseeding, no divisions, `kicker`/`defense`/`posMax` explicitly null (no K/DST slot), FAB $100 2-day continual, `source:"owner-override"` with a `note` naming the page; all 20 scoring terms verified term-by-term against `YAHOO_129048_SCORING` (0 mismatches) and `scoringKey` = `sc-a845f67652fb`, the existing Yahoo model dir; `league` row 129048 gets `team_id=11`, `scoring_json`, name. New `src/league/{platform,espnPlatform,yahooDom,yahoo}.ts` + `openLeague`'s `yahoo` case; bridge `/fetch`,`/read-frame`,`/click` take a `host` with a per-platform allowlist (`app/bridgeHosts.js`) and the guest resolver's any-guest fallback is GONE; renderer page tabs are per-platform through `activeWv()`, `switchLeague` sets the platform BEFORE the view and renders what `league-set-active` returns. Positive controls: live Yahoo 12 teams / 18-of-18 roster match / 14x6 = 84 schedule games; ESPN 462233 unchanged (16 teams, 13 reg weeks); bridge refuses an unknown host, a crossed-over url and a missing guest (fault-injected by driving the Yahoo guest off its host); app ESPN->Yahoo->ESPN shows the right webview and never navigates the ESPN guest to 129048. Not done here: `agent.ts`/`ff.ts` still call their own ESPN sync bodies (WP5 wiring); `app/engine/ff.cjs` is stale so the app's `league-set-active` returns only `{active}` until `npm run build:engine`; `YahooLeague.freeAgents` refuses by name (unbuilt).
- **WP5 (opus) -- In-season format correctness.** I-2, I-3, I-4, I-6, I-7 (action_log/routines/
  regWeeks), F-4 serve rule, `loadSimContext(ctx)` league side. ESPN byte-identity via the existing
  lineup/values regression locks.
  **DONE 2026-09-16 (working tree, uncommitted).** Slot vocabulary is ONE module (`src/draft/slots.ts`: `slotEligibility`/`isBenchSlot`/`slotAdmits`/`startingSlots`/`splitTemplate`), imported by lineup.ts, winprob.ts, season.ts, values.ts, lineupMarginal.ts and rosterMarginal.ts -- six hand-typed bench enumerations and five literal-`FLEX` rules gone; `flex_ok` still overrides the literal `FLEX` token and nothing else, so ESPN is unmoved. A Yahoo roster now fills `SUPERFLEX` with the spare QB and its two `IR` slots are never flagged unfillable; `rosterGaps` fills flex GROUPS narrowest-first (laminar, so exactly optimal) and `assertRostersCanFillLineup` accepts a legal superflex roster while still refusing the systematic shortfall. FAAB is per league (`faabArtifactFor`: `FF_FAAB_MODEL` > `data/faab-model.<id>.json` > the pinned incumbent 462233; any other league gets `faabBasis:"rule"` naming the artifact it would need) and `AcquisitionRules` has consumers at last (budget + process day, via `loadAcquisition`). Every copilot `Provenance` carries `leagueId`/`platform`/`scoringKey` and the caveat sentence leads with them; `runCopilot` stamps `action_log.league_id`; `refreshDecisionSnapshot` resolves the league ONCE and stamps from that instead of re-reading `activeLeagueId` after the three simulations. Routines are league-aware (`planRoutines`/`routineLeagues`; per-league `scheduler:<id>` with the global row as the default) and skip a platform BY NAME. Platform wiring: `discover_leagues` uses `espnDiscoverFromLinks` and stamps `platform` from the adaptor; `league_sync` dispatches through `platformFor(ctx.platformRaw).syncSettings` over a bridge `PlatformIO` and maps `LeagueSettings` (now carrying `teamId`) onto the row + `setConfig`; `read_league` sends a non-ESPN league through `openLeague`; the browse tools drive the ACTIVE platform's guest and the five ESPN draft-room tools refuse by name. `LeagueContext.platformRaw` lets every refusal name the platform, and `requirePlatform(..., adaptorMethod)` names the missing method. Gates: `tsc` clean in every WP5 file; `npm test` 885 tests, 881 pass, 2 skip, 2 failures BOTH in WP3's concurrently-edited `src/data/formatResolve.ts`; eslint 0 errors, no new warnings; golden **39.5% / 96% with the per-season line byte-identical**; live Yahoo `openLeague` still 12 teams / 18-man roster; `ff copilot lineup --league 129048` REFUSES by name (board stamp). NOT done: the `NFL_WEEKS`-vs-`regWeeks` divisor is DOCUMENTED, not unified -- `simContext.ts:399` builds `replacement` as `seasonPts / regWeeks` while every consumer is in the `proj / 17` frame (~1.31x high here); that file is WP3's and the fix moves live ESPN in-season numbers, so it needs owner sign-off. `lineupMarginal.baselines()` still builds its flex pool from `flexOk` only, so a SUPERFLEX group does not move QB replacement level there (values.ts `flexGroups` does). `ingestLeagueRosters`/`ingestLeagueTransactions` still refuse non-ESPN rather than dispatching to `yahooPlatform.syncRosters`.
- **WP6 (sonnet) -- Docs + hygiene.** Section D; D24 accuracy; refactor doc corrections (the three
  half-keyed tables, "rebuilt on switch"); lint warnings; this file's status.
- **WP7 -- Per-format gate + Yahoo in-season odds** (after WP1-5): `cpcv --league`, per-format
  `golden.json`, `ff copilot season-odds --league 129048` from the seeded simulator.
  **DONE 2026-09-16 (commit 8edb34e).** `ff sync-rosters` is PLATFORM-DISPATCHED: it resolves
  the league once, hands `platformFor(ctx.platformRaw)` one authenticated GET inside that platform's own
  guest (`bridgePlatformIO`), and writes through one shared writer (`src/data/ownershipSync.ts`) that
  keys every row by `nameKey` with the DST nickname->abbreviation alias applied on POSITION. The ESPN
  rows it produces are **byte-identical** to the ones the old ESPN-only body wrote (192 rows compared
  field-for-field before and after); Yahoo 129048 now holds **207 ownership rows across 12 teams**
  (17-18 each), our 18 matching the live team page name-for-name. New `ff sync-schedule [--league]`
  writes `raw_league_matchup` through any platform's `provider.matchups()`: **84 games over 14 weeks**
  for 129048, ESPN's 1042 untouched. `raw_league_matchup` carries pairings only (no score columns), and
  the Yahoo league has no started-lineup snapshot, so `loadSimContext` now REFUSES to seed a league whose
  settled weeks have no `raw_league_roster_week` rows -- previously every team scored 0, every matchup
  tied, and the home side "won", i.e. fabricated standings that render exactly like real ones. The
  refusal is carried into `assumptions.played.seedBlocked` and leads the caveat as "NOT SEEDED: ...".
  `fit-variance` / `fit-correlation` / `fit-bootstrap` take `--league` (`scripts/lib/format-paths.mjs`):
  with no flag they return the historical literals BY CONSTRUCTION, opening no store -- re-run flagless
  they reproduced `variance-model.json` and `rank-outcomes.json` BYTE-IDENTICAL and
  `correlation-model.json` identical modulo the CRLF the git checkout applies (the writer emits LF;
  `git diff` is empty). All three are now fitted into `data/formats/sc-a845f67652fb/` from the Yahoo
  target: 16 of 24 CV cells differ from ESPN's (K and DST are identical, because the Yahoo target still
  scores them under the default rules -- the league rosters neither, so nothing consumes them, but it is
  a cosmetic untruth in that file). `ff sync-actuals --league 129048` writes the format's own
  `current-actuals.csv` (Rodgers wk1 16.5 PPR vs the root's 12.5 half-PPR) and REFUSES the forward-board
  rebuild by name, because `buildForwardBoard` writes the shared `feat_player_week*` tables that hold the
  INCUMBENT's scored target; its scoring model now comes from the same resolved context as its output
  path (it took the ACTIVE league's rules while writing another league's file). `scripts/cpcv.mjs` gains
  `--league`: it resolves the format, passes `--league` down to both child backtests, reads
  `<dir>/golden.json` (new `data/golden.json` pins the incumbent's 96.0 / 38.5 / 3.0pp), stamps
  `league`+`format_key` on the ledger row, and for 129048 REFUSES by name ("format sc-a845f67652fb has no
  golden -- a pre-draft gate needs the snake DraftModel; in-season odds are reachable but ungated"),
  running nothing and appending nothing. Flagless it reads 96.0/38.5 from `data/golden.json` and is
  otherwise unchanged (verified end-to-end on cached dumps). The leftover `dataPath` per-format reads are
  closed: `copilotStore` (handcuff variance model, provenance variance + projection stamps, and the two
  weekly loaders, all now per league), `backtest/scorers.ts`, `backtest/winprobLineup.ts`,
  `injuryHorizon.ts` (variance per format; `injury-duration-artifact.json` confirmed SHARED-NFL and read
  through `model.shared`), and `draft/sim.ts` (a `variancePath` threaded from the backtest's resolved
  format through `DraftFieldOpts`). LIVE RUN on 129048: playoff shares sum to **exactly 8.0000** over 12
  teams and title shares to 1.0000; the lineup fills SUPERFLEX with Jared Goff beside Burrow at QB and
  flags no IR slot; the weekly serve falls back BY NAME to the format's season line
  (`basisNote: "no weekly projector was supplied..."`); waivers report `faabBasis: "rule"` on a $100
  budget. `copilot-crosscheck.mjs --league 129048`: ALL CHECKS PASSED, fault injection included. ESPN
  identity after switching back: `player_value` 529 rows byte-identical to the backup, `board` differs
  only in `ESPN_ADP` on 151 players (live market drift of 0.1, diagnosed field-by-field), the week-2
  lineup JSON identical to its pre-switch capture, golden **39.5% / 96%** with the per-season line
  byte-identical. Gates: tsc clean; 898 tests / 896 pass / 2 skip / 0 fail; eslint 0 errors, 47 warnings
  (two fewer than the 0835e7a baseline); `active_league = 462233`. NOT done: the Yahoo format has no
  weekly/streaming artifact and no fold set, so the weekly serve and the D18 seed both degrade and say so;
  `player_value_position` went 523 -> 529 rows on the ESPN rebuild because this was the first ESPN board
  rebuild since WP3 restored its producer (the backup's 523 is the pre-WP3 table) -- the six additions are
  board rows that previously had no pvp row at all; the Yahoo board still carries K and DST players even
  though the league rosters neither, so `waivers` can suggest a kicker.
- **Model improvement (after the architecture is at target):** re-screen the feature library under
  the Yahoo target (pre-filter first), Yahoo-native market anchors, K refit per format, the snake
  draft `DraftModel`.
  **M1 DONE 2026-09-16 -- the Yahoo re-screen is MEASURED and the projection-layer edge thesis is NOT supported (`docs/format-edge-screen-2026-09-16.md`):** Yahoo baseline nested CV recorded (trained RMSE 71.3 / pinball 15.7 pooled over 13 blind folds, beating the free curve at every position); 18 paired-floor screens under the Yahoo target with the identical 18 run against `data/ff.db` in the same session -- **zero ADMITs**, the only near-miss `prior_adot` TE (+0.0582 vs floor 0.0633, ESPN -0.0387, holdout reverses to -0.2708); `prior_carries_per_game` QB rejects, so superflex is a Layer-2 value effect not a projection effect, as the design doc already argued from the other side; the half-PPR-scaled `fftoday_proj` anchor still KEEPs strongly under Yahoo (+0.5698, 8/8), so that approximation is flagged but not costly. Nothing shipped; new read-only `scripts/prefilter-feature.mjs`; no Yahoo championship gate exists (F-9/WP7), so any admission would have been pinball-floor-only.

Execution order: WP1 + WP6 in parallel (disjoint files) -> WP2 -> WP3 -> WP4 + WP5 (disjoint) -> WP7.

**WP6 status (2026-09-16): DONE.** AGENTS.md/README.md/CLAUDE.md D0-D11 refs and the stale "still to be scaffolded" line fixed; README 35-tool/Not-yet-built/Shipped-levers/Layout-tree corrected; docs/validation.md sim-calibration rename noted; D24 valueKey/formatKey claim corrected; multi-league-refactor.md S-5/S-8/S-9 corrections added; multi-format-design.md Status note added.

## 5. Status at the end of the session (2026-09-16)

Commits, in order: bbd4e79 (review + docs + .gitignore), 3777546 (WP1), 72efc6b (WP4), 4b52583 (WP2),
37e96fd (WP5), 84a9f0d (WP3), 8edb34e (WP7), then the M1 screen + the admit-feature guard. Every wave
was gated on the same three facts, measured by the orchestrator independently of the executor: tsc
clean, the full suite green with the app running (508 -> 898 tests), and the golden line
39.5% / 96% byte-identical to the pre-change baseline. The ESPN board's values, ranks and tiers are
byte-identical to `data/ff.db.bak-prearchfix-2026-09-16`; the only board difference is the live
`ESPN_ADP` market column. The store is left with `active_league = 462233`.

**At target (section 3):** one resolver and a real LeagueContext; per-league config isolated;
`league_id` in every per-league PK with every reader filtered and every DELETE scoped; a format
resolver with the incumbent alias and no silent fallback; every per-format artifact resolved through
the league's format (the shared-NFL set classified individually); one slot-eligibility module; FAAB
per league; the Platform seam with an ESPN and a Yahoo adaptor; bridge guest resolution by host with
no fallback; the app switch per platform with a board stamp that refuses the wrong league; `--league`
on the verbs and an optional `league` on the copilot MCP tools; cpcv reads a per-format golden and
refuses a format without one. The Yahoo league runs end to end from its own artifact and config.

**Open, needing OWNER SIGN-OFF (each moves a live ESPN in-season number; charter rule 1):**
1. `simContext.ts` builds the streaming replacement level as `seasonPts / regWeeks` while every consumer
   compares it against `proj / 17` quantities -- the floor is high by 17/regWeeks (~1.31x under 13 weeks).
2. The handcuff horizon uses `NFL_WEEKS` (17) where the question is weeks left in the LEAGUE's season
   (ESPN ends week 16); `leagueSeasonWeeks(ctx)` exists, the default is not flipped.
3. `lineupMarginal.baselines()` builds its flex pool from `flex_ok` only, so a SUPERFLEX group does not
   raise QB replacement level there (values.ts `flexGroups` already does) -- a value-book change, so
   it belongs behind the arbiter.

**Open, engineering (no sign-off needed, not started):**
- Snake `DraftModel` (design doc phase 5): the only route to a Yahoo pre-draft gate / golden.
- Yahoo weekly + streaming artifacts and a per-season BLIND fold set (`tools/train_*.py` runs; the
  format's `manifest.weekly.seasonLineBlind: false` says why the current season lines are lookahead).
- Yahoo started-lineup ingestion (a `raw_league_roster_week` equivalent) and scores on
  `raw_league_matchup`, so the D18 seed can run for Yahoo instead of refusing by name.
- A per-format forward board (`buildForwardBoard` writes the shared `feat_player_week*` tables).
- `tools/train_price.py` and `tools/train_faab.py` read `fact_draft_pick` / `fact_waiver_claim`
  unfiltered; harmless with one league's rows, wrong once Yahoo history exists.
- One-off analysis scripts still unfiltered (kdst-analysis, manager-stability, format-history,
  schedule-balance, stream-horizon, inseason-lineup-diagnose, face-validity); `ingest-source` has no
  `--league` passthrough (the league sources resolve the active league and refuse non-ESPN).
- The Yahoo format's target still scores K/DST under the default rules and its board carries K/DST
  players although the league rosters neither (cosmetic; `waivers` can suggest a kicker).
- `YahooLeague.freeAgents` is unbuilt (the FA pool is the hand-built `fa-pool.json`); `discover` for
  Yahoo is unbuilt (the league row was created by hand); Return TD / Offensive Fumble Return TD are
  Yahoo scoring terms `ScoringRules` cannot express (carried in `rosterSettings`, do not move the key).
- eslint: 47 warnings (`no-useless-assignment`), 0 errors -- untouched.
- Operational: `app/engine/ff.cjs` is rebuilt (`npm run build:engine`) but an EXTERNAL Claude Code
  session's `ff-draft` MCP server keeps the process it started with -- restart it to see the new tools.

**Model improvement, first pass (M1, `docs/format-edge-screen-2026-09-16.md`):** the projection-layer
format-edge thesis is NOT supported -- 18 candidates screened under the Yahoo target and the same 18
under ESPN in one session, zero ADMITs, the ESPN arm reproducing the recorded frontier numbers to four
decimals, positive controls passing (the screen returns KEEP for `fftoday_proj` under both targets).
Two arms were DEGENERATE rather than null (`prior_cpoe` QB, `prior_ryoe` RB: below the trainer's
coverage floor on the decision seasons, so both arms were the same model and printed REJECT);
`scripts/admit-feature.mjs` now refuses a verdict on identical decision arms, fault-injected on that
exact candidate. The first honest accuracy figure for the Yahoo format is recorded (trained RMSE 71.3
/ pinball 15.7 pooled over 13 blind folds). Where the edge is, on the evidence: the VALUE and DECISION
layer (superflex is a Layer-2 effect -- QB 6/24 of top value on the 2026 Yahoo board vs 1/24 under
ESPN; item 3 above; the frontier doc's own reading), not the projector.
