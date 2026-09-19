/**
 * THE WRITE CONTRACT -- the mutating twin of `PlatformIO`, and the allowlist that guards it.
 *
 * WHY THIS EXISTS. Reads got three session providers (bridge, cookie, file) once `PlatformIO` stopped
 * being Electron-only. Writes did not, and could not be given one safely as things stood, because of
 * where the guard lived:
 *
 *   THE ONLY THING RESTRICTING WHAT THIS SYSTEM MAY WRITE TO ESPN WAS A REGEX IN `app/main.js`.
 *
 * `bridgeWriteTransaction` posts a url and a body to the app's `/write-transaction` route, and the
 * app checks the url against the ESPN league-transactions endpoint before executing it in the
 * authenticated guest. That check is real and it is good -- but it is in the ELECTRON APP. Adding a
 * cookie-based writer beside it, which is the whole point of a portable write path, would have
 * created a second route to ESPN's write API with NO allowlist at all. The safety property was not a
 * property of the system; it was a property of one transport.
 *
 * So the allowlist moves here, into the layer every provider goes through, and the app keeps its own
 * copy as defence in depth. The two are asserted to agree in `test/write-contract.test.ts` -- they
 * cannot share code (the app is plain JS in its own package), so they are checked against each other
 * instead of trusted, which is this repo's rule for any guard that exists in two places.
 *
 * WHAT A WRITE PROVIDER OWES ITS CALLER, and how it differs from a read provider:
 *
 *   THE STATUS IS THE RESULT. A read provider returns a body and the caller parses it; for a write,
 *   `403` versus `200` IS the outcome, so `post` returns both and never throws on a non-2xx. A
 *   thrown 403 loses the body, which is where ESPN puts the reason.
 *
 *   NOTHING IS SENT THAT WAS NOT ALLOWLISTED. `assertWritableUrl` runs inside every provider, not at
 *   the call site, so a future caller cannot reach ESPN's write API by forgetting to call it.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not widen what may be written. The allowlist is exactly the
 * endpoint the app already permitted -- league transactions -- because adding waiver or lineup
 * endpoints is a decision about what the tool may do to a real league, not a refactor, and it is not
 * one to take while moving a guard.
 */

/**
 * THE ONE ALLOWLIST. Exactly the ESPN league-transactions write endpoint: a season, segment 0, a
 * numeric league, `transactions`, nothing else. Not `lm-api-reads`, not another ESPN path, not a
 * different game.
 *
 * Kept as an exported constant rather than inlined so the test can compare it against the app's copy
 * character by character, and so a reader can see the whole permitted surface in one line.
 */
export const ESPN_WRITE_URL_PATTERN =
  /^https:\/\/lm-api-writes\.fantasy\.espn\.com\/apis\/v3\/games\/ffl\/seasons\/\d+\/segments\/0\/leagues\/\d+\/transactions\/?$/i;

/** The most a write body may be. The app caps at 1e5; the same cap is applied here so a provider
 *  that does not go through the app cannot send something the app would have refused. */
export const MAX_WRITE_BODY = 1e5;

/**
 * REFUSE ANYTHING NOT ON THE ALLOWLIST, loudly and by name.
 *
 * Throws rather than returning false: a caller that ignored a boolean would send the request, and
 * the whole point is that there is no path to ESPN's write API that skips this.
 */
export function assertWritableUrl(url: string, body: string): void {
  if (!ESPN_WRITE_URL_PATTERN.test(String(url))) {
    throw new Error(
      `REFUSED to write to ${String(url).slice(0, 200)} -- the only permitted write endpoint is ` +
      "ESPN's league-transactions URL (lm-api-writes .../seasons/<Y>/segments/0/leagues/<id>/transactions). " +
      "This is the one place that decides what this tool may change in a real league, and it is deliberately narrow.",
    );
  }
  if (typeof body !== "string") throw new Error("REFUSED to write: the body must be a JSON string.");
  if (body.length > MAX_WRITE_BODY) {
    throw new Error(`REFUSED to write: body is ${body.length} bytes, over the ${MAX_WRITE_BODY} cap.`);
  }
}

/** One authenticated POST to a permitted write endpoint. `status` and `body` are BOTH returned,
 *  because for a write the status is the result and the body is the reason. */
export interface PlatformWriteIO {
  post(url: string, body: string): Promise<{ status: number; body: string }>;
  /** How the write was authenticated, for the caveat. A write nobody can attribute is a write
   *  nobody can audit. */
  readonly via: string;
}

/**
 * THE APP BRIDGE WRITER -- what `ff propose-trade --send` has always used, now behind the contract.
 *
 * The app applies its own allowlist after this one, which is the defence in depth: two independent
 * checks, neither relying on the other being correct.
 */
export function bridgeWriteIO(timeoutMs = 25000): PlatformWriteIO {
  return {
    via: "the desktop app's authenticated ESPN webview",
    async post(url, body) {
      assertWritableUrl(url, body);
      const { bridgeWriteTransaction } = await import("../browser/appBridge.js");
      // `bridgeWriteTransaction` throws on a >=400, which loses the status. It is caught and
      // re-expressed as a result, because a refusal from ESPN is an outcome to report, not a crash.
      try {
        return { status: 200, body: await bridgeWriteTransaction(url, body, timeoutMs) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const m = /ESPN returned HTTP (\d{3}):\s*([\s\S]*)$/.exec(msg);
        if (m) return { status: Number(m[1]), body: m[2] };
        throw e;                       // a transport failure is not an ESPN answer
      }
    },
  };
}

/**
 * A WRITER FOR A SESSION THAT IS NOT THE APP -- a server-side browser, a saved cookie, anything that
 * can present ESPN with an authenticated cookie header.
 *
 * It goes through `assertWritableUrl` like every other provider. That line is the entire reason this
 * module exists: without it, this function would be a way to POST anywhere on ESPN with the user's
 * credentials, and the guard protecting against that would still be sitting in `app/main.js`.
 */
export function cookieWriteIO(cookie: string, opts: { timeoutMs?: number; userAgent?: string } = {}): PlatformWriteIO {
  const jar = String(cookie ?? "").trim();
  if (!jar) throw new Error("cookieWriteIO: empty cookie. Writing with no session would 401 at best, and a 401 on a write is not a safe thing to retry blindly.");
  const timeoutMs = opts.timeoutMs ?? 25000;
  return {
    via: "a supplied ESPN cookie",
    async post(url, body) {
      assertWritableUrl(url, body);
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          signal: ctl.signal,
          headers: {
            cookie: jar,
            "content-type": "application/json",
            accept: "application/json, text/plain, */*",
            ...(opts.userAgent ? { "user-agent": opts.userAgent } : {}),
          },
          body,
        });
        // Deliberately NOT throwing on a non-2xx: see the header. The caller decides what a 403 means.
        return { status: res.status, body: await res.text() };
      } finally { clearTimeout(t); }
    },
  };
}

/**
 * A WRITER THAT SENDS NOTHING and records what it would have sent.
 *
 * Not a test double -- it is how `--dry-run` becomes structural rather than a flag every future
 * caller has to remember to check. A caller handed this one cannot send, whatever it does.
 */
export function recordingWriteIO(): PlatformWriteIO & { sent: { url: string; body: string }[] } {
  const sent: { url: string; body: string }[] = [];
  return {
    via: "DRY RUN -- nothing was sent",
    sent,
    async post(url, body) {
      assertWritableUrl(url, body);   // a dry run that skipped the guard would not be a rehearsal
      sent.push({ url, body });
      return { status: 0, body: "" };
    },
  };
}
