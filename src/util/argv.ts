/**
 * READING A BARE POSITIONAL OUT OF argv, WITHOUT SWALLOWING A FLAG'S VALUE.
 *
 * THE BUG THIS EXISTS TO END, which this repo has now written three times and got wrong twice:
 *
 *   rest.find((a) => !a.startsWith("--"))
 *
 * reads "the first token that is not a flag". A flag's VALUE is not a flag, so with
 * `ff copilot depth-risk --week 2` -- the spelling of the day -- that expression returns **"2"** and hands it on as the player
 * name -- which then fuzzy-matched a real person and answered
 * `"2" is not on our roster -- he is on HMLS`. A documented flag broke the verb, and the message
 * blamed somebody nobody had typed. `ff ingest-source --seasons 2018-2026 <id>` had the identical
 * defect and its fix is commented in place; `ff copilot --week 2 lineup` had it too and silently
 * printed usage because the VERB resolved to "2".
 *
 * Fixed in two callers and missed in the rest, which is the "fix two of three" shape recorded in
 * this repo's own notes. So the rule lives HERE, once, and every positional scan calls it.
 *
 * WHY A SET OF VALUE-TAKING FLAGS RATHER THAN "SKIP THE NEXT TOKEN". Boolean flags consume nothing:
 * with `--json Breece Hall`, skipping the token after every flag would drop a real positional. The
 * two kinds cannot be told apart without knowing the verb's own flags, so the caller supplies them
 * -- and a caller that supplies an INCOMPLETE set reopens the bug for the flags it omitted, which is
 * why each caller's set is asserted against its own usage text rather than trusted.
 */

/** Every bare token that is neither a flag nor a flag's value, in order. */
export function positionals(argv: readonly string[], valueFlags: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) continue;
    if (i > 0 && valueFlags.has(argv[i - 1])) continue;   // this token belongs to the flag before it
    out.push(t);
  }
  return out;
}

/** The first such token, or undefined. The drop-in for `rest.find((a) => !a.startsWith("--"))`. */
export function firstPositional(argv: readonly string[], valueFlags: ReadonlySet<string>): string | undefined {
  return positionals(argv, valueFlags)[0];
}
