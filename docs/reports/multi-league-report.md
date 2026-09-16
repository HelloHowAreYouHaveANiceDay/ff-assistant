# Multi-League Fantasy Football Engine — Build Report

**Prepared:** 2026-09-16 · **Repo:** ff-assistant · **Scope:** multi-format architecture + a second
(Yahoo) league brought fully onto our own model.

---

## 1. Executive summary

We set out to run our fantasy-football engine for **more than one league at once**, with the thesis that
**the edge comes from tailoring the model to each league's rules**, not from stretching one model across
formats. We delivered exactly that for a second league — a Yahoo **superflex, full-PPR, bonus-heavy**
format that is structurally very different from the existing ESPN half-PPR auction league — and produced
a waiver/trade analysis from **our own model, under Yahoo's own rules**, replacing the borrowed Yahoo
projections used in the first pass.

Headline results:

- **Scoring generalized and verified against Yahoo's own applied points, 8/8 exact** — milestones, 40+
  yard-play bonuses, first downs, 6-pt passing TDs, and the TE reception premium all reproduce Yahoo's
  numbers to the decimal.
- **A per-format projection model trained** for Yahoo (golden self-check passed), projecting
  format-correct points (e.g. a top QB at ~497 Yahoo points vs ~310 under ESPN half-PPR).
- **Superflex valuation built** — the value layer now understands a QB-eligible flex, which flips QBs
  from **2 of the top 24 by value (ESPN) to 8 of 24 (Yahoo)**. This is the concrete, format-specific edge.
- **Rest-of-season blend applied**, folding the season so far into the value so the waiver call is
  in-season-aware (start Shough over Goff; Gesicki and Freiermuth surface as flex upgrades).
- The ESPN league is **provably unchanged** (byte-for-byte) at every step.

---

## 2. The architecture: League vs Format vs Model

The core idea is to stop conflating three things that had been one:

| Identity | What it is | Keyed by | Examples |
|---|---|---|---|
| **League** | an account/team you manage | `league_id` | ESPN 462233, Yahoo 129048 |
| **Format** | the ruleset that determines the model | a content hash | half-PPR/16-team/auction; superflex-PPR/12-team/snake |
| **Model** | trained artifacts + values + settings | **the format**, not the league | one per distinct format |

**Two leagues with the same rules share one model.** Add a league whose format already exists and it
reuses that model for free; add a new format and it is trained once. The model also decomposes into
layers, each reused independently:

- **Layer 0 — components** (shared): raw per-player production (yards, TDs, receptions, first downs,
  40+ plays), no scoring baked in.
- **Layer 1 — projection** `scoringKey`: the target points and trained heads; shared by any leagues with
  the same scoring.
- **Layer 2 — value** `valueKey`: replacement levels / VOR under the roster (this is where superflex
  lives).
- **Layer 3 — strategy + gate** `formatKey`: settings and the championship benchmark.

Full design: `docs/multi-format-design.md`.

---

## 3. What was built, and how each step was verified

Every step carried a **positive control** proving the existing ESPN league's numbers did not move, and a
**fault-injection or external check** proving the new behavior is real — the house discipline that a
plausible-looking output is the default failure mode.

### 3a. Scoring generalization
The scoring model was extended from linear per-stat weights to also express **yardage milestones**
(e.g. +2 at 300 pass yds, +3 at 400), **per-position receptions** (TE premium 1.5 vs 1.0), **first-down
points**, and **40+ yard-play bonuses** — none of which the old model could represent. A ruleset that
uses none of these scores byte-for-byte as before, so ESPN is untouched by construction.

- **External ground-truth: 8/8 exact vs Yahoo's own applied points** (Josh Allen 49.26, Lamar 38.66,
  Goff 22.44, Burrow 20.96, Bijan 35.80, Jefferson 33.70, Nacua 15.40, McBride 32.00). These jointly
  validate the milestone-cumulative reading, the 40+ mapping, the TE premium, PPR, first downs, and 6-pt
  TDs — all at once.
- 14/14 unit tests including the byte-exact half-PPR positive control.
- **Key finding:** every Yahoo component was already present in the source data feed, so **no data
  re-ingest was needed** — the scope collapsed to a pure scoring change.

### 3b. Per-format projection model
The training target was recomputed under Yahoo scoring and a projector trained on it, stored per-format
(`data/formats/<key>/`) so it never touches the active ESPN files.

- Retarget gate passed: the rescored target matched the verified scoring 8/8, and the point-in-time
  feature invariant held 503/503.
- The trained artifact's **golden self-check passed** (predictions reproduce the library's own to the
  tolerance).
- Serves format-correct points: a top QB projects ~497 (Yahoo) vs ~310 (ESPN half-PPR).

### Layer 2. Value book + superflex
Roster slots are now modeled as **eligibility sets** and filled by a greedy that provably reduces to the
old behavior for ESPN's single flex, while correctly handling Yahoo's two flex types (`W/R/T` and the
`Q/W/R/T` superflex). QBs claim superflex slots, deepening QB replacement from ~QB13 to ~QB25.

**The edge, made concrete** (same 2025 player pool, our models, only the format differs):

| | Yahoo (superflex) | ESPN (1-QB half-PPR) |
|---|---|---|
| QBs in top-24 by value | **8 / 24** | **2 / 24** |
| Top asset | Jalen Hurts $55, Lamar $47 | Bijan Robinson $103 (top QB #11) |

- ESPN byte-exact via existing regression locks; +3 new superflex tests incl. fault injection
  (remove the superflex slot → QB value reverts). 15/15 pass.

### Step 4. Rest-of-season blend
The season-so-far is folded into value via the shipped rest-of-season estimator
`ros = (K·line + k·rate)/(K+k)`, K=6 — so one played week carries ~14% weight (disciplined; it does not
overreact to a hot game). Only NFL week 1 is final, so the update is deliberately modest.

---

## 4. The payoff — our-model Yahoo analysis (team "Joe's Rookie Daycare")

**Format:** 12-team, superflex, full PPR + bonuses, 3 flex + 1 superflex.

### Optimal starting lineup (our rest-of-season value)
| Slot | Player | Our value |
|---|---|---|
| QB | Joe Burrow | $27 |
| SUPERFLEX | **Tyler Shough** | $26 |
| RB | Omarion Hampton | $35 (elite) |
| RB | Chase Brown | $24 |
| WR | Garrett Wilson | $23 |
| WR | Jameson Williams | $15 |
| TE | Kyle Pitts | $11 |
| FLEX | Carnell Tate | $11 |
| FLEX / FLEX | Croskey-Merritt / Spears | $3 / $1 |

Bench of note: **Jared Goff ($18)** — a startable superflex QB now on the bench behind Burrow and Shough.

### The recommendations
1. **Trade from your QB surplus — the clearest edge.** You roster three startable superflex QBs
   (Burrow, Shough, Goff). Superflex makes QBs the scarcest asset in the format, so the odd man out —
   **Goff** — is a genuine trade chip. Package him for an RB/WR that upgrades a flex, your one real
   weakness. A half-PPR model would price these QBs near replacement and hide this entirely.
2. **Waiver targets:** **Mike Gesicki** and **Pat Freiermuth** (both TE, flex-eligible here) are the only
   free agents that beat your weak flex bodies on rest-of-season value — consistent with Yahoo's own
   in-season projections, now derived from our model. Drop a deep-bench stash to add one.
3. **Your weakness is flex depth, not the core** — the drop-off after Tate is steep (two flex slots are
   near replacement level).

---

## 5. Limitations & next steps (honest boundaries)

- **Market anchors are format-approximate.** Two features the projector uses (a preseason external
  projection and consensus draft rank) are still on the ESPN/half-PPR scale; the model rescales them, but
  a Yahoo-native consensus would be cleaner.
- **Rest-of-season K is a shared constant.** K=6 is fitted on ESPN data and reused; refitting on Yahoo
  scoring is a minor follow-up once the weekly track is retargeted.
- **Snake-draft value is not built.** The draft/backtest engine is auction-only; Yahoo is a snake draft.
  Nothing in the *in-season* analysis above needs it (the season simulator starts from the current
  roster), but draft-day value for Yahoo is future work.
- **Per-league championship benchmark** (the gate number under each format) is computed lazily and not yet
  pinned for Yahoo.

---

## 6. Verification ledger

| Claim | Control | Result |
|---|---|---|
| Yahoo scoring correct | vs Yahoo's applied points, real player-weeks | 8/8 exact |
| Scoring generalization safe | byte-exact half-PPR reproduction | pass (14/14 tests) |
| Feature retarget correct | rescored target + point-in-time invariant | 8/8, 503/503 |
| Yahoo projector valid | golden self-check vs library predict | pass |
| Superflex value correct | fault injection (remove slot → revert) | pass (15/15 tests) |
| ESPN unchanged | existing regression locks | pass |

All work is reversible (new files under `data/formats/<key>/`); nothing has been wired as a league
default without sign-off.
