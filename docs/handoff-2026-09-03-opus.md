# Handoff prompt -- paste into a fresh Claude session (Opus) in H:/working/ff-assistant

Launch from PowerShell (the whole file is the prompt; this header is harmless to include):

```
cd H:\working\ff-assistant
claude --model opus "$(Get-Content -Raw docs\handoff-2026-09-03-opus.md)"
```

(or just open `claude --model opus` in this directory and paste everything below the line.)

---

You are executing a pre-draft hardening plan for ff-assistant, a TypeScript CLI that
auto-drafts an ESPN $200 auction (16-team league 462233). **The real draft is ~2026-09-06 --
everything except the optional Step 9 must land before it.**

## Your single source of truth

Read `docs/plan-2026-09-03-value-curve-fix.md` FIRST and follow it step by step (Steps 0-10).
It contains the findings, the measured evidence, the exact patches, per-step acceptance
criteria, fault-injection requirements, and decision gates. Do not improvise around it; where
it says STOP at a failed gate, stop and report.

One-paragraph summary so you know why you are here: a deep review (2026-09-03) found that
`baselines()` in `src/draft/values.ts` splits FLEX slots evenly across RB/WR/TE, which hands TE
11 phantom starting slots (a points-weighted fill gives TE zero). The shipped bid table
therefore carries $803 of TE value (room reality: ~$206) and starves WRs by ~$9 each in a
half-PPR league. An A/B on the repo's own deterministic championship backtest measured the fix
at **13.6% -> 22.2% championships** (n=3,600/arm, better in 8 of 9 seasons). The review left NO
code changes (its measurement patch was reverted); your job is to reproduce that measurement,
land the fix properly, re-verify the tuned defaults under the new curve, close three smaller
live-day traps (uncapped live DST bids, a self-defeating live nomination policy, stale/
contradictory docs and value surfaces), and rebuild every value surface from one build.

## Execution discipline (non-negotiable)

1. **Step 0 before anything**: reproduce the baseline numbers exactly (the harness is seeded
   and deterministic -- 13.6%/70% at n=400 or an input has drifted; find it, don't proceed).
2. **One commit per step**, explicit file paths only (never `git add -A`), `npm test` green
   before each commit. Commit messages are given per step in the plan.
3. **Every new guard/test: inject its target failure once and watch it fail** before trusting
   green. The plan marks these as "FI:".
4. **Never put file content through a shell string**: multi-line or quote-bearing content goes
   through the Write/Edit tools, never heredocs, `python -c`, or `node -e`.
5. Bash cwd resets between calls -- every call starts `cd H:/working/ff-assistant && ...`.
   Scripts importing `better-sqlite3` must live and run in the repo root.
6. ASCII only in CLI output, commit messages, and docs.
7. **Do NOT**: rebuild `data/history-*.csv`; enable the backtest-rejected features
   (`--scarcity --pos-inflation --drain-nom --waivers`); pick any config from `ff sim` (the
   championship backtest is the only arbiter); touch `app/`; run `ff enter-draft` against the
   real league (a duplicate draft connection kicks the seat); commit `data/ff.db*`.
8. The DB config trap: the live agent reads levers from the PERSISTED config
   (`settings.config`), which overrides code defaults -- if Step 4 changes a default, change
   the stored config too and READ IT BACK to verify.
9. `npm run ff -- refresh` hits the network (nflverse, ESPN, RSS). Verify its output by row
   counts and the SQL sanity gates in Step 7 -- never by its success line alone.

## Definition of done

- Steps 0-8 complete, each committed; Step 9 only if time remains (9c needs a human to start
  the bro espn session -- ask, don't block on it).
- Final `npm test` green; final backtest headline (n=400, weighted curve) recorded in
  `docs/validation.md` with the curve it was measured under.
- All value surfaces agree (player_value == values.csv top-12; cheatsheet regenerated same
  build) and the Step 7 SQL sanity gates pass (TE book ~$380-470, WR >= $1,050).
- `git status --short` clean; no stray temp files.
- Wiki close-out per plan Step 10: Decision Log entry on
  `H:/working/wiki/wiki/projects/project--ff-assistant.md` + a prepended `wiki/log.md` entry
  (Read limit=3 then Edit on the `# Ingest Log` anchor -- never a script).

## Report back

End with: per-step status (done/skipped + evidence line each), the M1/M2/M3 + sweep numbers in
one table, any gate that failed and why, and the exact remaining human actions before draft day
(expected: start bro espn session + log in; run the runbook's pre-draft sequence on draft
morning; dry-run `ff enter-draft` when ESPN opens the room).
