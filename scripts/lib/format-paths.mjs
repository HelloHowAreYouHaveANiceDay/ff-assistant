// WHICH FORMAT'S HISTORY DOES A FITTER READ, AND WHERE DOES ITS ARTIFACT GO? (WP7)
//
// `fit-variance`, `fit-correlation` and `fit-bootstrap` each opened `data/history-weekly.csv` by
// literal and wrote `data/<artifact>.json` by literal. Those three artifacts are PER SCORING FORMAT --
// a weekly CV, a teammate correlation and a rank-outcome pool measured under half-PPR say nothing
// about a full-PPR superflex league -- and all three are exactly what the D18 seeded season simulator
// reads (src/draft/simContext.ts). So a second league could not have season odds at all without either
// fitting them, or being served the incumbent's, which is the wrong-number failure this pass exists to
// remove.
//
// THE NO-FLAG PATH DOES NOT OPEN A DATABASE. With no `--league`, this returns the SAME two literals
// the fitters always used, so the shipped run is unchanged by construction rather than by a resolver
// that happens to agree. `FIT_OUT`/`FIT_EXCLUDE` (the leave-season-out calibration harness) keep
// working in both modes: FIT_OUT still wins over everything.
import { createRequire } from "node:module";
import { resolveFormat } from "../../src/data/formatResolve.ts";

const require = createRequire(import.meta.url);

/** The `--league <id>` argument, or null. */
export function leagueArg(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--league");
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/**
 * Resolve a fitter's INPUT csv and OUTPUT path.
 *
 *   artifact  the `FORMAT_ARTIFACTS` name this fitter writes ("variance" | "correlation" |
 *             "rank-outcomes"), so the path comes from the one artifact table rather than a literal.
 *   fallback  the historical literal, used when no `--league` is given.
 *
 * Returns `{ weeklyCsv, out, label }`. A league whose format has no `history-weekly.csv` THROWS out of
 * `model.require`, naming the file and the build command -- it never falls back to the data/ root,
 * which would fit the incumbent's history and write it into the other format's directory.
 */
export function fitPaths(artifact, fallback, argv = process.argv.slice(2)) {
  const league = leagueArg(argv);
  if (league == null) {
    return { weeklyCsv: "data/history-weekly.csv", out: process.env.FIT_OUT || fallback, label: "incumbent (data/ root)" };
  }
  // Required lazily so the no-flag path costs nothing and needs no store on disk.
  const Database = require("better-sqlite3");
  const db = new Database("data/ff.db", { readonly: true });
  try {
    const fmt = resolveFormat(db, league);
    return {
      weeklyCsv: fmt.model.require("history-weekly"),
      out: process.env.FIT_OUT || fmt.model.path(artifact),
      label: `league ${league} -> format ${fmt.scoringKey} (${fmt.provenance})`,
    };
  } finally { db.close(); }
}

/**
 * The same resolve for a fitter whose INPUT is a feature DATABASE rather than a history csv
 * (scripts/fit-ros-blend.mjs reads `feat_player_week_model`, which lives in the store for the
 * incumbent and in `features.db` for every other format).
 *
 *   artifact    the FORMAT_ARTIFACTS name this fitter writes ("ros-blend")
 *   fallbackDb  the historical literal db, used when no `--league` is given
 *   fallbackOut the historical literal output path, same rule
 *
 * The no-flag path opens nothing and returns the two literals, so the shipped run is unchanged by
 * construction rather than by a resolver that happens to agree.
 */
export function fitDbPaths(artifact, fallbackDb, fallbackOut, argv = process.argv.slice(2)) {
  const league = leagueArg(argv);
  if (league == null) {
    return { db: fallbackDb, out: process.env.FIT_OUT || fallbackOut, label: "incumbent (data/ root)" };
  }
  const Database = require("better-sqlite3");
  const db = new Database("data/ff.db", { readonly: true });
  try {
    const fmt = resolveFormat(db, league);
    return {
      db: fmt.model.require("features-db"),
      out: process.env.FIT_OUT || fmt.model.path(artifact),
      label: `league ${league} -> format ${fmt.scoringKey} (${fmt.provenance})`,
    };
  } finally { db.close(); }
}
