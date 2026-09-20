# Multi-league refactor — shared NFL core + per-league layers

**Goal (owner, 2026-09-15):** run models for multiple leagues/teams. The NFL is the same; each league has
different scoring / roster structure / draft. Share one NFL layer; build a per-league layer for each
league we calculate for.

## Approved decisions (2026-09-15)

1. **Storage: single `data/ff.db` + `league_id` namespacing.** Not separate DBs. 18 tables already carry
   `league_id`; the refactor adds it to the ~15 derived tables that are per-league but single-slot today.
2. **Scoring: RE-TARGET the projection model per scoring format.** A projection variant per format
   (half-PPR / PPR / standard, plus superflex/roster where it changes the target), not one half-PPR model
   with a scoring map. Components live in `raw_pbp_player_week`, so any format's target is computable.
3. **Calibration: per-league golden master, lazily.** Each league gets its own backtest gate number,
   computed when first needed. The current 96%-playoff golden stays valid for the current league.

## The layer boundary (grounded in the current table inventory)

**Layer 1 — SHARED NFL core (no `league_id`, one copy):**
- Raw NFL feeds: `raw_pbp_player_week`, `raw_nfl_game`, `raw_injury`, `raw_ngs`, `raw_snap_count`,
  `raw_participation`, `raw_depth_chart`, `raw_combine`, `raw_contract`, `raw_college_*`,
  `raw_nfl_draft_pick`, `raw_gameday_status`.
- Identity: `player`, `player_bio`, `player_xref`, `player_ids*`, `player_identity`.
- Production features (component stats): `feat_player_season(_ext)`, `feat_player_week(_context/_model/
  _stream)`, `feat_curve`, `feat_coverage`, `feat_player_prospect`, `feat_injury_horizon`, `team_bye`,
  `game`. NOTE: these carry a baked `pts` (half-PPR) today — see the scoring note below.
- Market: `raw_adp_history`, `raw_fftoday_proj`, `raw_espn_projection`, `boris_tier`, `ranking*`,
  `weekly_rank`, `adp`, `market_value`, `trade_value`, `trending`, `news`.
- The projection MODEL (rank curve + trained artifacts of production).

**Layer 2 — PER-LEAGUE (one per league, all `league_id`-keyed):**
- Already keyed (18): `league`, `raw_league_*`, `draft`, `roster`, `ownership`, `projection`, `matchup`.
  **CORRECTION (2026-09-16 architecture review, finding S-5):** `fact_draft_pick`, `fact_team_season`
  and `fact_matchup` carry a `league_id` COLUMN but it is NOT part of their primary key (live PKs are
  `[season,team_name,pick_order]`, `[season,team_id]` and `[season,week,home_id]`), so a second league's
  upserts collide with the first's. These three are NOT correctly keyed today; see
  `docs/architecture-review-2026-09-16.md` S-5/S-6 for the fix (WP2).
- MUST ADD `league_id` (~15 single-slot today): `settings` (the config!), `board`, `player_value`,
  `player_value_position`, `draft_state`, `draft_pick`, `my_roster` (draft-keyed today), `fact_lineup_week`,
  `fact_roster_week`, `fact_fa_pool_week`, `fact_waiver_claim`, `scorecard_prediction`, `scorecard_result`,
  `decision_snapshot`, `team_odds`, `fact_prediction`.

## The scoring boundary (the one real subtlety)

`feat_player_week/season.pts` is baked **half-PPR** — scoring-specific. The **components**
(rush/rec yds, receptions, rush/rec TDs, pass yds/TDs) live in the shared `raw_pbp_player_week`. Under the
approved decision #2, the projection is **re-targeted per format**: the target `pts` is recomputed from
components under each league's scoring, and a model variant is trained per format. The value/board layer
already parameterizes scoring (`scoringFromEspn`) and roster (`resolveValueLeague(cfg)`) — those become
per-league-context driven rather than global.

## Mechanism

- **`LeagueContext`** — `{ leagueId, season, scoring, slots, teams, budget, format, config }`, resolved from
  the store for a league. Replaces implicit `currentLeagueId()` (12 sites) and global `getConfig(db)`
  (~15 sites). Threaded through the verbs; `--league <id>` flag selects it, default = current
  (most-recently-synced), so existing behavior is byte-identical until a second league is added.
- **Config becomes per-league** — `settings` key `config` → per-league (`config:<leagueId>` or a
  `league_id`-keyed column). `getConfig(db, ctx)` / `setConfig(db, ctx, ...)`.
- **Board/values recompute per context** — apply the league's scoring+roster to the shared projections.

## Phases (each independently shippable + reversible; STOP-POINTS marked)

- **Phase 1 — `LeagueContext` scaffolding (behavior-preserving).** Introduce the type +
  `resolveLeagueContext(db, leagueId=currentLeagueId(db))` reading the current global config; swap the
  `currentLeagueId()` / `getConfig(db)` call sites to take the context. No storage change; output
  byte-identical. Add `--league` flag parsing (no-op with one league). REVERSIBLE.
- **Phase 2 — STORE MIGRATION (the hard-to-reverse boundary; CONFIRM before running).** Add `league_id`
  to the ~15 derived tables (backfill = current league); make config per-league. Additive columns via
  db.ts's ALTER path; a backfill migration; a reversal note.
- **Phase 3 — per-format model retargeting.** Compute the projection/weekly target from components under a
  league's scoring; train + store a variant per format; the served artifact selected by
  `LeagueContext.format`. Its own gate.
- **Phase 4 — per-league calibration.** Lazy golden master per league/format; `cpcv`/`season-calibration`
  keyed by league.
- **Phase 5 — verb threading + UX.** `--league` through every in-season/draft verb; the copilot/MCP takes a
  league; `league_sync` no longer overwrites — it adds/updates a league's layer.

## Confirmed 2026-09-15 (owner)

- **The second league is a DIFFERENT scoring format, and models are retrained per league.** So Phase 3 is
  core, not deferrable: each league gets its OWN trained artifacts (projector + weekly + fold set), fit
  to its scoring, stored per-league (proposed `data/leagues/<leagueId>/*.json`) and selected by
  `LeagueContext`. The shared NFL layer shares the DATA and the component-stat features; the MODEL is
  per-league. Training cost is once-per-league-per-season (acceptable).

## Phase 2 migration reality (why it needs a dedicated, backed-up run)

Getting `league_id` into the derived tables is NOT all cheap `ALTER ADD COLUMN`. Two shapes:
- **Config (`settings`) is key-value (PK = `key`)** -> per-league is a KEY convention (`config:<leagueId>`)
  with a fallback to the legacy `config` key. No schema change; low risk. But it touches the config
  chokepoint (`getConfig`/`setConfig` + ~5 direct `settings WHERE key='config'` readers), so it is still
  a careful edit of the path every verb reads.
- **Board / player_value / in-season `fact_*` etc. need `league_id` IN THE PRIMARY KEY** (so league B's
  board does not collide with league A's). SQLite cannot add a PK column in place -> each is a TABLE
  REBUILD (create new, copy, drop, rename) under a transaction, with `data/ff.db` backed up first. This
  is the hard-to-reverse core of Phase 2 and gets its own run + owner sign-off + a verified backup.

## Yahoo recon (2026-09-15, live read of league 129048 via the app's yahooview + raw CDP)

"Fappening World Cup Edition", Yahoo id 129048, 12-team Head-to-Head. Read from the live logged-in
webview. It is structurally FAR from the ESPN league, which is the point of doing B first -- it enumerates
what the per-league layer must actually vary:

- **DRAFT TYPE: snake/standard, NOT auction.** The whole draft engine (values.ts VOR->$, sim.ts, backtest,
  cpcv) assumes an AUCTION with a budget. A snake league needs rank/ADP-based draft logic instead. This is
  the single biggest scope item the smoke test surfaced -- per-league draft FORMAT, not just scoring.
- **ROSTER: superflex + triple flex** -- `QB, WR, WR, RB, RB, TE, W/R/T x3, Q/W/R/T x1, BN x7, IR x2`.
  Superflex (a QB-eligible flex) changes QB replacement level dramatically; resolveValueLeague already
  reads slots, but the flex/superflex handling and the value model must reflect it.
- **SCORING: bonuses our model does not compute** -- yardage milestones (2pt @300 pass yds, 2pt @100
  rush/rec, 3pt at the next tier), 40+ yard completions/runs/receptions, passing/rushing/receiving 1st
  downs; fractional + negative points on. Reception and passing-TD point values need a precise scoring-table
  re-read (the flat text grab missed the cell values). scoring.ts is per-stat but has no milestone/1st-down/
  big-play terms -- the scoring model needs extending for Yahoo.
- **FORMAT: 8 playoff teams, weeks 15-17, reseeding** (ESPN league: 7 teams, weeks 14-16). Per-league format
  block already exists (LeagueFormat); just needs Yahoo's values.
- **Waivers: FAB (FAAB), 2-day, continual rolling.**

Implication for the plan: the per-league layer must carry draft FORMAT (auction|snake) and an extended
scoring model, not only scoring numbers + slots. The projection model retrain per league (decision #2)
already covers the scoring/target; snake-draft VALUE logic is net-new draft work beyond the 2b store
migration. Read path that works today with no app restart: raw CDP (Node built-in WebSocket) to the
yahooview target's ws url from http://127.0.0.1:9223/json/list.

## Phase 2b EXECUTED (2026-09-15)

Ran on the live store (verified backup `data/ff.db.bak-premultileague` taken first). `league_id` prepended
to the PRIMARY KEY of the genuinely per-league HISTORY/state tables, via an idempotent create-copy-drop-
rename in `migrate()` (`migrateLeagueIdPk`), existing rows backfilled to the active ESPN league (462233):
- **Migrated (per-league):** `fact_roster_week`, `fact_lineup_week`, `fact_fa_pool_week`,
  `fact_waiver_claim`, `decision_snapshot`. Row counts preserved, integrity ok.
- **Classification correction:** `team_odds` (NFL game spreads/totals -- same for every league) and
  `scorecard_prediction`/`scorecard_result` (measure the shared MODEL's accuracy, not a league) are
  SHARED. They were wrongly migrated first, then reverted (rebuilt without `league_id`). Lesson: classify
  each table as league-data vs NFL/model-data before migrating; the tell was `DELETE FROM team_odds`
  wiping all leagues.
- **CLOSED 2026-09-20: `board`, `player_value` and `player_value_position` are PER LEAGUE.** They now
  carry `league_id` at the head of their primary key, exactly as line 38 of this document always said
  they must. `migrateSlotTable` converts an existing store in place (create-copy-drop-rename, row
  count asserted); the live store migrated with its board content BYTE-IDENTICAL (sha `eac4bfee5a18`
  before and after, 529 rows) and the ESPN lineup served the same eight men and the same 101.8 points
  either side of it. Readers filter through one helper, `slotFilter(leagueId)`, which is EMPTY when
  no league is known so a bare store reads exactly as it did before partitioning.

  **What forced it, beyond tidiness:** the single slot meant `switchActiveLeague` began by deleting
  all three tables for every league. Onboarding a second league mid-season therefore destroyed the
  league you are actually playing -- its lineup stopped working until the board was rebuilt. The
  stamp guard made that visible, which was the right fix for the shape the tables had, but visible
  destruction is still destruction. Switching is now non-destructive and, for a league already built,
  free.

  **Backfilled from the STAMP, not the active league**, and deliberately not folded into
  `migrateLeagueIdPk`: the board's owner is whoever built it, and a store whose active league had been
  switched without a rebuild would have had its rows filed under the wrong league -- silently, in the
  direction that serves one league's dollars under another's name.

  Fault injection earned its keep twice here. Restoring the old `DELETE FROM board` left the first
  version of the test GREEN, because switching to an ALREADY-BUILT league returns early and never
  reaches the clear; the destructive path is switching to an UNBUILT one, which is the onboarding case.
  And `switchActiveLeague` was reporting the GLOBAL stamp after a per-league switch -- null exactly
  when a league is being onboarded, since the legacy key is written only for an active league that
  already has a `league` row. Both are pinned in `test/board-multileague.test.ts`.

- **Superseded (kept for the record) -- kept single-slot (active-league cache):** `board`,
  `player_value`, `player_value_position` -- the
  INTENT was that they stay the active league's working set, regenerated whenever the active league
  switches, avoiding a pervasive reader cascade. **CORRECTION (2026-09-16 architecture review, finding
  S-8): the rebuild-on-switch half was never built.** `setActiveLeagueId` writes the two settings rows
  and stops; there is no invalidation or rebuild hook, so switching the active league silently serves
  the PREVIOUS league's board/values under the new league's name. This is a known gap, not a shipped
  behavior -- see `docs/architecture-review-2026-09-16.md` S-8 (WP2) for the fix.
- **Writers updated** to write `league_id` (= `activeLeagueId(db)`) and key `ON CONFLICT` on it:
  `rosterState.ts` (the 3 positional inserts -- `@lg` prepended), `faab.ts`, `decisionSnapshot.ts`.
- **Readers are NOT yet league-filtered** (confirmed still true by the 2026-09-16 architecture review,
  which counted 21 unfiltered readers of these tables -- finding S-9); harmless while only one league's
  data exists, and this is now being fixed under that review's WP2, not deferred to "when Yahoo history
  is ingested" (Yahoo rows already exist in some of these tables today).

## Invariants (do not break)

- The one rule (D13) still gates every value/strategy change — now per league.
- The charter (CLAUDE.md): no ship without stop-and-confirm; Phase 2 (migration) and Phase 3 (model) are
  boundaries that get owner sign-off before landing.
- Single-league behavior must stay byte-identical until a second league is actually added.
