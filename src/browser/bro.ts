// bro as a subdriver (like `bim bro`). bro owns the browser session + login; ff
// attaches Playwright to the session bro is holding. We never launch or log in a
// browser ourselves -- that is bro's job (D2). ff depends outward on bro.
//
// Session lifecycle (run by the human, once):
//   cd <bro> && npm run -s bro -- session start espn   # log into ESPN, leave running
// ff then resolves the CDP port from bro's shared registry and connectOverCDP to it.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Locate the bro checkout. Override with BRO_DIR; defaults to the sibling repo. */
export function broDir(): string {
  const env = process.env.BRO_DIR;
  const dir = env ? resolve(env) : resolve(process.cwd(), "..", "bro");
  if (!existsSync(dir)) {
    throw new Error(
      `bro checkout not found at ${dir}. Set BRO_DIR to your bro repo path.`,
    );
  }
  return dir;
}

export interface BroSession {
  site: string;
  port: number;
  pid: number;
  alive: boolean;
}

/** Run `bro sessions --json` and return the parsed rows. */
export function listSessions(): BroSession[] {
  const res = spawnSync("npm", ["run", "-s", "bro", "--", "sessions", "--json"], {
    cwd: broDir(),
    encoding: "utf8",
    shell: process.platform === "win32", // npm.cmd on Windows
  });
  if (res.status !== 0) {
    throw new Error(`bro sessions failed: ${res.stderr || res.stdout}`);
  }
  const json = lastJson(res.stdout);
  // bro wraps payloads as { ok, result: {...} }; tolerate a flat shape too.
  const rows = (json?.result?.sessions ?? json?.sessions ?? []) as BroSession[];
  return rows;
}

/** Resolve the live CDP port for a site's bro session, or throw with guidance. */
export function sessionPort(site: string): number {
  const s = listSessions().find((r) => r.site === site && r.alive);
  if (!s) {
    throw new Error(
      `No live bro session for "${site}". Start one:\n` +
        `  cd ${broDir()} && npm run -s bro -- session start ${site}\n` +
        `then log into ${site} in the window that opens and leave it running.`,
    );
  }
  return s.port;
}

/** Passthrough to the bro CLI with inherited stdio (for `ff bro ...`). */
export function passthrough(args: string[]): number {
  const res = spawnSync("npm", ["run", "-s", "bro", "--", ...args], {
    cwd: broDir(),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return res.status ?? 1;
}

/** Parse bro's JSON from stdout. bro emits one pretty-printed object; npm -s may
 *  prepend stray lines, so try the whole blob first, then the last {...} block. */
function lastJson(out: string): any {
  const trimmed = out.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  // Grab from the first "{" to the last "}" (handles leading npm noise).
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* give up */
    }
  }
  return null;
}

// Keep spawn imported for future streaming use (session start passthrough already
// covered by passthrough()).
void spawn;
