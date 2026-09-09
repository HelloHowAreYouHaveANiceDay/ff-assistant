# Data layers: raw, staging, consumer

## The problem this fixes

The store already had a layer model (`L0` identity, `L1` reference facts, `L2` presentation, `L3`
draft runtime, `L4` governance, `L5` in-season). It is not wrong, but it splits on **lifecycle**
(how often a table is rewritten) rather than on **trust** (how far the data is from the source and
what has been guaranteed about it). That distinction is not academic. It is why three identity bugs
shipped in one week:

- `resolvePlayer` matched *Josh Allen* to *Josh Allen Jr.*
- the ECR ingest merged *A.J. Green* the WR with *A.J. Green* the DB
- the age curve aged *Antonio Williams* the RB with the birth year of *Antonio Williams* the WR, and
  that one reached the shipped board as a +19.5% markup on a 29-year-old scored as 22

All three are the same failure: **raw, name-keyed source data flowed directly into a derived model
with no step in between that was responsible for saying who a player is.** L1 holds both
`player_bio` (whatever nflverse said) and `player_value` (something we computed), so there was no
layer boundary to hang that guarantee on, and every consumer re-solved identity ad hoc — differently,
and some of them wrong.

We have RAW and we have CONSUMER. We have never had STAGING. That is the gap.

## The three layers

### RAW — `raw_*`

Exactly what a source gave us, transformed as little as possible. One table per source feed.

- **Rule:** no joins, no identity resolution, no derived columns. If the source says a player's name
  is `A.J. Green` and his position is `DB`, that is what the row says.
- **Rule:** a raw table must be reproducible by re-fetching. Nothing else in the store may be its only
  home.
- **Keyed** by whatever the source is keyed by, plus enough to be unique. Where the source has no
  stable id, the key includes the discriminators that make rows distinct — this is why
  `ranking_history` is keyed `(source, type, date, name_key, position)`: dropping `position`
  silently merged two people.
- **Ambiguity is preserved here, never resolved.** Two Antonio Williamses are two rows.

Current: `ranking_history`, `player_ids`, `game`, `news`, `adp`, `market_value`, `trending`,
`player_advanced`, `player_status`, `team_odds`, `boris_tier`, `weekly_rank`, `trade_value`,
`player_bio`, `team_bye`, `ranking`, `ownership`.

### The identity registry sits under staging

`player_identity` + `player_xref` are the foundation the whole dimension rests on, and they follow
standard master-data practice rather than anything invented here:

- **Surrogate key.** `player_sk` is an internal integer, minted once, never reused or renumbered.
  It carries no meaning, which is precisely why it cannot go stale.
- **Source ids are attributes, not identity.** They live in `player_xref` as `(player_sk, source,
  source_id)`, many rows per player. A single `espn_id` column cannot express a player with two ids,
  nor an id later reassigned to someone else.
- **Matching is exact and ordered**, strongest evidence first: gsis, espn, sleeper, then
  (name_key, **birthdate**). No fuzzy scoring -- fuzzy matching is where master-data systems quietly
  merge people, and this store managed to merge two men three separate ways without any fuzziness.
- **Position is an ATTRIBUTE, never identity.** It is multi-valued (ESPN grants one player RB *and*
  WR eligibility), time-varying (Bredeson RB -> TE, Ojulari LB -> EDGE) and source-specific (PK vs K).
  Keying identity on it split **178 real players into two surrogate keys each** -- every man a source
  ever reclassified became two people. Birthdate is the stable discriminator: of 493 name keys that
  look ambiguous by position, 230 are genuinely different people whom birthdate separates and 178 are
  one person who moved. Eligibility lives in `player_position`, many rows per player.
- **A disputed id is inert.** An id claimed by two people neither matches nor is recorded. Both
  guards are needed and they protect different steps: refusing the LINK is too late, because the
  merge already happened at MATCH time.
- **Unmatched is a state, not an error.** A player who resolves to nothing gets a fresh key and says
  so. Dropping him loses a current player; guessing recreates the bug.

The property that makes it a foundation is that a rebuild mints nothing and moves no key, including
when new ids arrive for a player who previously had none. That is asserted in test/identity.test.ts,
because a registry whose keys move on rebuild is not a foundation -- it is a cache.

> The first version of `stg_player` keyed on `gsis_id || "POS:name_key"`. That is a NATURAL key and
> it moves when the attributes move: a player learning his gsis, or being reclassified RB -> TE, would
> silently change identity. The surrogate key exists to make that impossible.

### STAGING — `stg_*`

Conformed. This is where identity is decided, once, so nothing downstream has to.

- **Rule:** one row per real-world entity. If two raw rows are the same player, they are one staging
  row. If two raw rows share a name and are different people, they are two staging rows with
  different keys.
- **Rule:** every staging row carries `player_sk` from the identity registry, and every consumer
  joins on it rather than on a name. Staging does not DECIDE identity, it READS it -- deciding it
  here is how the layer ended up minting its own natural key and reproducing the merge.
- **Rule:** where identity cannot be resolved, the row is marked `ambiguous` rather than guessed.
  A consumer may then choose to skip it — which is what the age curve does by returning a multiplier
  of 1 for an unknown player.
- **Rule:** no business logic. Conforming is not valuing. `player_value` does not belong here.

Current: `stg_player`, keyed by `player_sk` and rebuilt from the registry. 11,966 rows: 11,927 from
the crosswalk plus 39 board players it does not know. Building out the rest -- staged projections,
staged rankings -- is the work.

### CONSUMER — `cons_*` (and the existing `board`)

What the app, the models and the simulator read. Derived, single-writer, always rebuildable from
raw + staging.

- **Rule:** exactly one writer per table. If two code paths write it they will disagree.
- **Rule:** droppable. Anything that cannot be rebuilt from raw belongs in raw, not here.
- **Rule:** consumers may not read raw directly for identity-bearing joins. Read staging.

Current: `board`, `player_value`, `projection`.

### FEATURE -- `feat_*` (a consumer table with one extra rule)

What a MODEL is fitted on and served from. Derived, single-writer, rebuildable from raw + staging --
so it obeys every consumer rule above -- plus one more that only a model needs.

- **Rule: POINT-IN-TIME.** Every row carries an `as_of`, and nothing in it may depend on information
  that did not exist at that moment. A preseason row is stamped `<season>-09-01`; a week row is
  stamped the day before that week's first game. This is not tidiness: a feature derived from the
  whole history and then used for 2010 is lookahead moved one level UP, out of the data and into the
  model, where no data-level check can see it. It is why the curve columns are refitted per season on
  an expanding window instead of once on everything.
- **Rule: the TARGET lives in the same row, and is named as a target.** `pts` and `games` are what a
  model is fitted against. A feature table you have to join to a second table to train from is a
  feature table people bypass, and the bypass is where the leakage gets in.
- **Rule: one derivation per feature, here and nowhere else.** Before this layer, prior-year finish
  rank was re-derived in five scripts and prior-season usage in three, each with its own season range
  and its own name-keyed join, and there were three separate copies of the rank-curve builder in
  `scripts/`. Copies drift, and a copy that drifts inside a fit script produces a COEFFICIENT, not an
  error.
- **Rule: a row that cannot be resolved is KEPT and MARKED**, never dropped. `player_sk` is NULL and
  `feat_key` says so. Dropping it shrinks the training set in a way nothing downstream can notice.

Current: `feat_player_season` (preseason, one row per scored player-season), `feat_player_week`
(one row per player-week including byes). Built by `ff build-features`.

### FACT -- `fact_*`

A record of an EVENT, not a point-in-time view of an entity. Rebuildable from raw like any consumer
table, single-writer like any consumer table, and separated only because "what happened" and "what
was knowable" are different questions and a table that answers both answers neither.

| table | rows | grain | built by |
|---|---|---|---|
| `fact_draft_pick` | 1,658 (2018-2026) | one pick | `ff build-picks` |
| `fact_team_season` | 130 (2018-2026) | one team-season | `ff build-picks` |
| `fact_matchup` | 1,050 (2018-2026) | one regular-or-post-season game | `ff build-picks` |

`fact_draft_pick` carries the market consensus as it stood and the auction state at the moment of the
pick (money and slots remaining, and `price_share`, the share of the room's money it took). It is
deliberately not `draft_pick`, which is draft-runtime state keyed by a live `draft_id` and empty
between drafts. Until Phase 2c it was built from `data/recaps.json` -- ESPN recap pages scraped by
hand into a gitignored file covering four seasons -- which violated the raw layer's own rule that a
table must be reproducible by re-fetching. It now reads `raw_league_pick`, nine seasons, and its
totals are asserted against that table **to the dollar** in every season.

Three rules these tables added:

- **A DERIVED FLAG IS DERIVED ONCE, HERE.** `champion`, `made_playoffs` and `settled` live on
  `fact_team_season` rather than in each consumer, which is the same lesson prior-year finish rank
  taught when it was re-derived in five scripts. `settled` comes from the DATA -- every team has a
  final rank and one of them is 1 -- not from the calendar, because an in-progress season's
  placeholder rank looks exactly like a result.
- **NORMALISE ACROSS ERAS OR DO NOT COMPARE.** Six of the nine seasons are 14-team ($2,800) rooms and
  three are 16-team ($3,200). Raw dollars across them are two currencies; `price_share` is the one
  quantity that means the same thing in both, and it is why the price model, the face-validity ranges
  and the positional gates all work in shares.
- **A CONSTANT THAT CANNOT BE DERIVED SAYS SO.** The playoff field looked derivable from the finishes
  and is not: `k = teams` satisfies the "top k finishers are the top k seeds" property trivially, and
  bounded to a plausible bracket the six settled 14-team seasons read 6, 8, 6, 4, 6, 8, because
  ESPN's `final_rank` is a consolation-inclusive ordering. So it is a stated constant (6 below 16
  teams, 7 at or above, matching `settings.config.playoffTeams`) and `seedsAgreeAtField` reports the
  check beside it -- seven of eight settled seasons agree, 2021 does not.

## Why the runtime tables are not one of the three

`draft`, `draft_pick`, `draft_state`, `my_roster`, `usage_log`, `action_log`, `league`, `roster`,
`matchup`, `settings` are **operational state**, not a pipeline. They record what happened or what
the user configured; they are not derived from a source feed and cannot be rebuilt by re-fetching.
Forcing them into raw/staging/consumer would make the model tidier and less true. They keep their
own section.

## Migration stance

The three layers are a target, not a completed state. Today most tables sit in raw and most
consumers still join on `name_key`. Renaming everything at once would be a large, risky change whose
only immediate benefit is that the names look right.

The order that actually buys something:

1. **`stg_player` first** — it is where the identity guarantee lives, and identity is what broke.
2. **Move consumers onto `player_key` one at a time**, starting with the ones that have already been
   burned: the age curve, the opportunity model, the ECR joins.
3. **Rename raw tables to `raw_*`** last, when the boundary is real rather than aspirational. A
   prefix on a table nobody treats as raw is decoration.

## The data-track tables (2026-09-08)

Thirteen new `raw_*` tables and two `feat_*` extension tables. The full source inventory -- grain,
key, as-of semantics, measured season coverage, fetch cost and consumer, for every source whether
ingested or not -- is `docs/data-sources.md`. This section is only what the LAYER MODEL gained.

### Raw

| table | rows | grain / key | as-of | verb |
|---|---|---|---|---|
| `raw_league_season` | 15 | (league, season) | the season | `ff ingest-raw league-history` |
| `raw_league_team_season` | 130 | (league, season, team) | mixed: prices in August, `final_rank` after the playoffs | same |
| `raw_league_pick` | 1,658 | (league, season, pick_no) | the auction | same |
| `raw_league_matchup` | 1,050 | (league, season, week, home) | the schedule | same |
| `raw_league_division` | 15 | (league, season, division) | the season | same |
| `raw_nfl_game` | 7,548 | (season, game_id) | `gameday` | `ff ingest-raw nfl-games` |
| `raw_injury` | 90,762 | (season, week, team, player, report_date) | `date_modified`, NULL from 2025 | `ff ingest-raw injuries` |
| `raw_depth_chart` | 1,907,518 | (season, week, as_of_key, team, player, formation, position, depth_position) | `dt` for 2025+, NULL before | `ff ingest-raw depth-charts` |
| `raw_snap_count` | 324,611 | (season, week, game_id, pfr id) | the game day | `ff ingest-raw snap-counts` |
| `raw_nfl_draft_pick` | 12,927 | (season, round, pick) | `<season>-05-01` | `ff ingest-raw nfl-draft` |
| `raw_participation` | 182,303 | (season, week, gsis, team) -- AGGREGATED from the play grain | the game day | `ff ingest-raw participation` |
| `raw_adp_history` | 8,750 | (format, season, teams, ffc id) | the archive's window end | `ff ingest-raw adp-history` |
| `raw_contract` | 31,893 | (player_key, contract_no) | `<year_signed>-03-01` | `ff ingest-raw contracts` |

`ff ingest-raw --list` prints the registry; `ff ingest-source <id>` reaches the same assets with
their default season ranges, which is what the app's Data page calls.

Three rules these tables made concrete, all of them learned the expensive way in one afternoon:

- **The raw layer must be reproducible by re-fetching, and the league's own history was not.**
  Fifteen seasons of auction prices reached the store once, by a hand-run script in a scratchpad
  directory. Deleting `data/ff.db` would have destroyed the most league-specific data we own with no
  verb that rebuilt it. That is now `src/data/leagueHistory.ts` and an asset.
- **A source's schema changes underneath a season range, and the branch must be read from the FILE.**
  nflverse injuries dropped `date_modified` in 2025; depth charts became a dated snapshot with
  different column names in the same year. Keying either on the season number is a guard keyed on a
  name: it keeps passing after the thing it guards moves. Both ingesters read the header.
- **`as_of` and `fetched_at` are different columns and the difference is the whole point.** For a
  2014 row they are twelve years apart. Where a feed publishes no date, `as_of` is NULL and the
  derivation is pushed to the feature layer, which knows the schedule -- a computed date sitting in
  a raw column is indistinguishable from a published one.

### Feature extension

`feat_player_week_context` (131,892 rows, 2013-2025, keyed `(season, week, player_sk)`) and
`feat_player_season_ext` (8,021 rows, keyed `(season, player_sk)`, anchored `<season>-09-01`) extend
the Phase 2a feature rows SIDEWAYS. They never rewrite `feat_player_season` or `feat_player_week`,
and `src/features/build.ts` is untouched, so `ff build-features` and `ff build-features-ext` may run
in either order. Built by `ff build-features-ext --seasons 2013-2025`.

Two rules they add to the feature-layer list:

- **A column that CANNOT satisfy the point-in-time rule says so in its own name.** `temp_observed`
  and `wind_observed` are measured at the game, not knowable before it. They are here for asking how
  much wind costs a passing game, never for projecting one, and a query using them is visible as
  such rather than hidden behind a column called `temp`.
- **Coverage is DATA.** `feat_coverage` holds rows, non-nulls, per column, per season, written by
  the same run that builds the tables, and generated from `PRAGMA table_info` rather than from a
  hand-written column list -- an enumerated list rots the moment a column is added, in exactly the
  way that makes the new column the one nobody watches. A test asserts no column drops to zero in a
  season it should cover, and asserts the one legitimate zero (`report_status_fri` from 2025, where
  the feed stopped publishing a report date) explicitly, so the day it returns is a failure someone
  reads.

### The identity split this work uncovered -- and how Phase 2c closed it (2026-09-09)

`player_xref` and `stg_player` held **different surrogate key spaces for the same men**. Of the 7,961
gsis ids present in both, **7,902 disagreed** on `player_sk`; only 59 agreed. `player_identity` had
22,814 rows against staging's 11,966. `stgPlayer.ts` called `resolveOrMint` with an EMPTY id bag and
no birthdate, so every match attempt fell through to the "name_key + position, among rows that also
have no birthdate" branch -- which misses every registry row, because registry rows all carry a
birthdate. Staging therefore minted a fresh key for almost everybody.

A consumer resolving through `player_xref` got keys that joined nothing -- not `stg_player`, not
`feat_player_season`, not `feat_player_week` -- with no error anywhere, and a healthy-looking
resolution rate the whole time. A rate measures whether a key was FOUND, never whether it means
anything to the table it will be used against.

**After.** 7,939 of 7,939 shared gsis ids agree. `player_identity` and `stg_player` are both 12,122
rows. Staging mints 39 keys -- the board-only players -- where it used to mint 10,897.

Four things had to move together, and they are the rules the layer now carries:

- **Staging passes the real id bag AND the birthdate**, so the registry actually decides.
- **THE REGISTRY WINS every tie-break.** It is the foundation and staging is a reader; a reader that
  overrides its own source of truth is not one. The previous staging key is never consulted -- it
  appears only in `identity_rekey`, as the old side of the map.
- **An ambiguous raw key is EXPANDED, not collapsed.** `player_ids` is keyed (name_key, position) and
  the ingest resolves a key two men share by NULLing every field they disagree about, keeping both
  sides in `player_ids_variant`. Read alone, that row can only ever produce ONE key for the pair --
  the merge the layer exists to prevent, arrived at from the raw side. `crosswalkPeople()` expands
  them and is shared by the registry and staging, because two readers that disagree about how many
  people a key stands for is how the two spaces diverged in the first place. Marvin Harrison is
  three staged rows: the son (2002, with the son's gsis), the Hall of Fame receiver (1972-08-25,
  Syracuse, drafted 1996) and a third man the crosswalk lists at 315lb out of TCU.
- **The vocabularies are conformed, teams as well as positions.** The crosswalk writes SFO/NEP/GNB
  and everything else writes SF/NE/GB. Nothing compared them, so every consumer using team as a
  DISCRIMINATOR silently lost it -- `pickStaged` had no usable staged row for Christian McCaffrey and
  his age fell back to the name-keyed bio table, which is the exact join this layer removes, defeated
  by a spelling. `normTeam` sits beside `normPos` for that reason.

`pfr` joined `ID_SOURCES` and `stg_player.pfr_id` with it, retiring the parallel route that mapped a
per-person id through (name_key, position) and had to refuse for anyone sharing a name.

### `identity_rekey`: a key that moves must say where it went

A surrogate key exists so stored references do not break. Fixing the above moved 11,946 of them, so
the move is RECORDED rather than performed invisibly. One row per OLD staging key, with the reason
DERIVED from the shape of the mapping rather than asserted by the writer:

| reason | meaning | count |
|---|---|---|
| `unchanged` | the old and new key are the same integer | 3 |
| `moved` | one old key -> one new key | 11,946 |
| `merged` | several old keys -> one new key (they were the same man) | 14 |
| `split` | one old key -> several new keys (it was several men) | 3 |
| `dropped` | no successor at all | 0 |

**Frozen tables are MIGRATED THROUGH IT, never regenerated.** `scorecard_prediction` is write-once by
design and its `subject` column IS a `player_sk` for the `season` and `weekly` kinds, so the rekey
silently unjoined every frozen row: season subjects that resolved to a staged player went from
63/490 to **490/490** after migration. 2,874 rows moved, 5 were left alone where a merge would have
collided with an existing row, and the table's own count is unchanged at 3,077. The `odds` kind is
keyed by TEAM id -- also small integers, also numeric, a different domain entirely -- and migrating
it through a player map was caught only by a UNIQUE constraint. **A numeric column is not a key
space.** `raw_espn_projection` is keyed by ESPN player id and needed nothing.

### The rekey exposed a second defect, in every feature builder

Every one of them upserts on a key that CONTAINS the surrogate key -- `(season, feat_key)`,
`(season, player_sk)`, `(season, week, feat_key)`. After the keys moved, a rebuild could not reach
the old rows and simply added the new ones beside them: `feat_player_season` went 17,189 ->
**33,086** and `feat_player_week` 287,632 -> **553,900**, with every per-season count still looking
exactly right. Each builder now DELETES the season it is about to rebuild. **A rebuild of a season is
a replacement of that season**, and an upsert cannot express that when the key itself is what moved.

## The lineage graph is declared once, not photographed (Track K, 2026-09-09)

Every layer above was documented by hand in this file. That is exactly the failure mode the Data
page's node list hit twice: a curated list is a photograph of the day it was written, and the RAW and
EXTENSION FEATURE layers both went invisible on the app's Data page for months because nobody typed a
node for them (see `docs/validation.md`'s Phase 2d entry).

`src/lineage/dag.ts` closes this at the source instead of patching the symptom again. Two registries
declare, per producer, which tables/artifacts it `reads` and which it `writes`:

- `src/data/ingest.ts` -- `RAW_ASSETS` (the raw-only sources `ff ingest-source` already knew about)
  and a new `L1_ASSETS` (the L1 sources materialized through `ingestOne`'s switch: ecr, bio, byes,
  advanced, trade, weekly, status, odds, boris, adp, market, news).
- `src/lineage/registry.ts` -- `PRODUCERS`, the feature builders (`build-features`,
  `build-features-ext`, `build-live-context`, `build-weekly-features`), `assemble`, `project`, the
  four python trainers, and `scorecard`.

`computeLineage()` builds the graph from those two registries plus the model registry
(`src/draft/models.ts`), with external `src_*` nodes for the outside world. Nodes and edges are pure
functions of the declarations -- there is no third list for the app to fall behind. It is a
DIRECTED ACYCLIC graph by construction, checked by `test/dag-lineage.test.ts`; getting there required
resolving three real coarse-grained false cycles by hand (documented at each exclusion in
`src/lineage/registry.ts` and `src/lineage/dag.ts`): a producer reading back one of its own outputs
(not a cross-producer dependency), and two cases of table-level lineage being too coarse to see that a
producer writes a DIFFERENT partition of a shared table than the one another producer reads (`player`
via a defensive backstop upsert, `ranking`'s `source='espn'` rows versus `source='fantasypros_ecr'`).

Served as `lineage` over `ff serve` and `ff lineage --json`; the Data page (`app/renderer/app.js`)
draws exactly that JSON (see "app: the Data page renders the declared lineage" and
`test/dag-derivation.test.ts`). Registering a table's producer in one of the two registries is the
whole of making it appear on the page, with the freshness/row-count/rebuild-button wiring that used to
require a hand-typed entry.
