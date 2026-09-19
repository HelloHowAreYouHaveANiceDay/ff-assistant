/**
 * WHICH SESSION A REQUEST USES -- one place, instead of seven.
 *
 * `PlatformIO` and `PlatformWriteIO` were always injectable, and `Platform` takes an `io` on every
 * method, so the CONTRACT never assumed Electron. The DEFAULTS did. Before this module the desktop
 * bridge was named directly at seven call sites:
 *
 *   agent/agent.ts, data/leagueRosters.ts, ff.ts (twice), inseason/proposeTrade.ts (read and write),
 *   and league/yahoo.ts's module-level `yahooIO`
 *
 * so "drive this with a different browser tool" meant editing seven defaults, and `--cookie-file`
 * reached 2 verbs out of ~40. A capability that requires seven edits is one the architecture claims
 * and does not offer.
 *
 * THE POINT IS NOT INDIRECTION. It is that "which session am I using, and why?" becomes a question
 * with ONE answer, and the fall back to the bridge happens in an auditable place rather than
 * implicitly in seven.
 *
 * RESOLUTION ORDER, most explicit first:
 *
 *   1. an `io` handed in by the caller        -- a test, or an agent that built its own
 *   2. `kind` passed explicitly               -- a CLI flag, e.g. --session cookie --cookie-file f
 *   3. FF_SESSION / FF_SESSION_COOKIE_FILE    -- for an agent process that cannot pass flags
 *   4. the desktop bridge                     -- TODAY'S BEHAVIOUR, so nothing changes by default
 *
 * THE DEFAULT IS DELIBERATELY UNCHANGED. Every existing install keeps the Electron path, and this
 * module is judged by whether it can also return the others -- a resolver that can only ever hand
 * back the bridge is indistinguishable from the code it replaced, which is this repo's dead-lever
 * shape wearing a new file name.
 */
import { readFileSync } from "node:fs";
import {
  bridgePlatformIO, cookiePlatformIO, type Platform, type PlatformIO,
} from "./platform.js";
import { bridgeWriteIO, cookieWriteIO, type PlatformWriteIO } from "./writeIO.js";

export type SessionKind = "bridge" | "cookie";

export interface SessionOpts {
  /** An already-built provider. Wins over everything -- this is how a test or an embedding agent
   *  supplies a transport this module has never heard of. */
  io?: PlatformIO;
  writeIO?: PlatformWriteIO;
  kind?: SessionKind;
  /** A file holding the cookie header for `kind: "cookie"`. */
  cookieFile?: string;
  /** The cookie header itself, where the caller already has it in memory. */
  cookie?: string;
  timeoutMs?: number;
}

/** What the environment asks for, or nothing. Read at CALL TIME, never cached at module load --
 *  a value captured at import would ignore a flag parsed afterwards, and would make this resolver
 *  untestable in the same process. */
function fromEnv(): { kind?: SessionKind; cookieFile?: string } {
  const raw = String(process.env.FF_SESSION ?? "").trim().toLowerCase();
  const kind = raw === "bridge" || raw === "cookie" ? (raw as SessionKind) : undefined;
  const cookieFile = String(process.env.FF_SESSION_COOKIE_FILE ?? "").trim() || undefined;
  // A cookie file with no explicit kind is an unambiguous request for the cookie session; requiring
  // both would be a footgun whose only symptom is silently using the wrong login.
  return { kind: kind ?? (cookieFile ? "cookie" : undefined), cookieFile };
}

/** The cookie header for a cookie session, from whichever source supplied it. Throws rather than
 *  falling back to the bridge: a caller that ASKED for a cookie session and silently got the app's
 *  login would be writing with the wrong identity and never know. */
function cookieFor(opts: SessionOpts, env: { cookieFile?: string }): string {
  if (opts.cookie?.trim()) return opts.cookie;
  const file = opts.cookieFile ?? env.cookieFile;
  if (!file) {
    throw new Error(
      "a cookie session was requested but no cookie was supplied -- pass --cookie-file, " +
      "FF_SESSION_COOKIE_FILE, or SessionOpts.cookie. Refusing to fall back to the desktop app's " +
      "login, which would act as a different identity than the one asked for.",
    );
  }
  return readFileSync(file, "utf8");
}

/** Which session this call will use, without building it. Exported so a caveat can SAY which login
 *  produced a number -- a read nobody can attribute is a read nobody can audit. */
export function sessionKind(opts: SessionOpts = {}): SessionKind | "supplied" {
  if (opts.io || opts.writeIO) return "supplied";
  return opts.kind ?? fromEnv().kind ?? "bridge";
}

/** A READ session for `host`. */
export function resolveIO(host: string, opts: SessionOpts = {}): PlatformIO {
  if (opts.io) return opts.io;
  const env = fromEnv();
  const kind = opts.kind ?? env.kind ?? "bridge";
  if (kind === "cookie") return cookiePlatformIO(cookieFor(opts, env), { timeoutMs: opts.timeoutMs });
  return bridgePlatformIO(host, opts.timeoutMs ?? 25000);
}

/** A READ session for a platform, using the host it declares. The reason `host` was lifted off
 *  `WebviewSpec`: choosing a session is not a rendering question. */
export function resolveIOFor(platform: Platform, opts: SessionOpts = {}): PlatformIO {
  return resolveIO(platform.host, opts);
}

/** A WRITE session. Same order, same default, same refusal to substitute a different identity. */
export function resolveWriteIO(opts: SessionOpts = {}): PlatformWriteIO {
  if (opts.writeIO) return opts.writeIO;
  const env = fromEnv();
  const kind = opts.kind ?? env.kind ?? "bridge";
  if (kind === "cookie") return cookieWriteIO(cookieFor(opts, env), { timeoutMs: opts.timeoutMs });
  return bridgeWriteIO(opts.timeoutMs ?? 25000);
}
