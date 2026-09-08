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

`fact_draft_pick` sits beside them: one row per pick this league really made, with the market
consensus as it stood. It is a FACT table rather than a feature table -- a record of an event, not a
point-in-time view of an entity -- and it is deliberately not `draft_pick`, which is draft-runtime
state keyed by a live `draft_id` and empty between drafts. Built by `ff build-picks`.

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
