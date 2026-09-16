// RUN A PLAIN `.mjs` SCRIPT THAT IMPORTS TYPESCRIPT, UNDER PLAIN `node`.
//
// `node scripts/read-config.mjs` is the invocation the runbook and CLAUDE.md document, and it must
// keep working. Those scripts now go through `src/db/db.ts` (the ONE config chokepoint) rather than
// re-spelling the SQL -- and plain node cannot load our TypeScript, because every internal import is
// written `./x.js` against a file that is `./x.ts` (the tsx/TS convention; node's own type stripping
// does not remap the extension).
//
// So: try the import; if the runtime cannot do it, re-exec this exact script under `node --import
// tsx` and exit with its status. One hop, guarded by an env var so a genuine module error under tsx
// surfaces as itself rather than as an exec loop.
import { spawnSync } from "node:child_process";

const GUARD = "FF_ENSURE_TSX";

/**
 * Dynamic-import a module that may be TypeScript, re-execing under tsx when it cannot be loaded.
 * Returns the module; does not return at all on the re-exec path (the process exits).
 */
export async function importTs(specifier, parentUrl) {
  // Resolved against the CALLER's url, not this file's -- a bare "../src/x.ts" would otherwise be
  // looked up relative to scripts/lib/ and fail with a confusing ERR_MODULE_NOT_FOUND.
  const url = parentUrl ? new URL(specifier, parentUrl).href : specifier;
  try {
    return await import(url);
  } catch (e) {
    if (process.env[GUARD] === "1") throw e;            // already under tsx: a real error, not a loader gap
    const r = spawnSync(process.execPath, ["--import", "tsx", ...process.argv.slice(1)], {
      stdio: "inherit",
      env: { ...process.env, [GUARD]: "1" },
    });
    process.exit(r.status ?? 1);
  }
}
