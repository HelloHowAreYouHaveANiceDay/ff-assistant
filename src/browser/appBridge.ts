/**
 * Talk to the desktop app's authenticated ESPN session WITHOUT the CDP debugging port.
 *
 * WHY THIS EXISTS. The engine is a separate OS process. The app spawns it and talks to it over stdio
 * (`ff serve`), which is app -> engine; roster sync and the league adaptor need the other direction --
 * reach into the app to run a fetch inside the webview that holds the login. CDP was the only wire
 * for that and it is a poor fit three ways:
 *
 *   - It depends on Chromium's `remote-debugging-port` switch actually binding. On 2026-09-07 it
 *     silently did not, on a running app, for hours: no listener on 9223 on any interface while the
 *     window was open and healthy. Every browser-backed verb failed and the only symptom was a
 *     connection refused.
 *   - It exposes the ENTIRE app to any process on the machine. A debugging port is not an API.
 *   - It drags in playwright-core to make one authenticated HTTP request.
 *
 * The app already owns the webview, so it now publishes a one-route loopback endpoint and writes the
 * port and a random token to data/app-bridge.json. This reads that file and posts to it. The surface
 * is a single function instead of the whole renderer, and there is no debug switch to fail.
 *
 * CDP REMAINS AS A FALLBACK rather than being ripped out, because the bridge only exists in an app
 * started from the current main.js -- an older running instance publishes no file, and a hard cutover
 * would strand exactly the user who has not restarted yet.
 */
import { readFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import { dataPath } from "../data/paths.js";

export interface BridgeInfo { port: number; token: string; pid: number; started: string }

/** Read the app's published endpoint, or null if it is not running (or predates the bridge). */
export function bridgeInfo(): BridgeInfo | null {
  const f = dataPath("app-bridge.json");
  if (!existsSync(f)) return null;
  let info: BridgeInfo;
  try { info = JSON.parse(readFileSync(f, "utf8")) as BridgeInfo; } catch { return null; }
  if (!info?.port || !info?.token) return null;
  // A crashed app leaves the file behind. Checking the pid turns a confusing timeout into an
  // immediate, accurate "the app is not running".
  try { process.kill(info.pid, 0); } catch { return null; }
  return info;
}

/**
 * WHICH GUEST a bridge call acts on. The app mounts one webview PER PLATFORM, each on its own
 * persistent partition, so "the webview" is no longer a thing (P-3). Omitting `host` keeps the
 * historical behaviour exactly -- espn.com -- so every existing caller is unchanged.
 *
 * There is NO fallback to another guest. The route used to take "any guest" when none was on the
 * requested host, which meant that with the ESPN view closed a `/read-frame` or `/click` meant for
 * ESPN silently acted on the YAHOO webview. A wrong-site read is not a degraded read.
 */
export interface GuestTarget { host?: string }

/** Fetch a URL through the app's logged-in webview for `host` (default espn.com). Throws with an
 *  actionable message; a host with no guest is a named refusal, never another platform's page. */
export async function bridgeFetch(url: string, headers?: Record<string, string>, timeoutMs = 20000, target: GuestTarget = {}): Promise<string> {
  const info = bridgeInfo();
  if (!info) throw new Error("app bridge not available (app not running, or started before the bridge existed -- restart it)");
  const payload = JSON.stringify({ url, headers: headers ?? {}, host: target.host });
  const body = await new Promise<string>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port: info.port, path: "/fetch", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "x-ff-token": info.token },
      timeout: timeoutMs,
    }, (res) => {
      let out = "";
      res.on("data", (d) => (out += d));
      res.on("end", () => resolve(out));
    });
    req.on("timeout", () => { req.destroy(new Error(`app bridge timed out after ${timeoutMs}ms`)); });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
  let parsed: { status?: number; body?: string; error?: string };
  try { parsed = JSON.parse(body); } catch { throw new Error(`app bridge returned non-JSON: ${body.slice(0, 120)}`); }
  if (parsed.error) throw new Error(`app bridge: ${parsed.error}`);
  if (parsed.status && parsed.status >= 400) throw new Error(`${target.host ?? "espn.com"} returned HTTP ${parsed.status} through the app session`);
  if (typeof parsed.body !== "string") throw new Error("app bridge returned no body");
  return parsed.body;
}

/** True when the app is up and reachable -- used to prefer the bridge over CDP without guessing. */
export function bridgeAvailable(): boolean {
  return bridgeInfo() !== null;
}

/**
 * WRITE a transaction to ESPN through the app's authenticated session. This is the ONLY write path in
 * the system and it goes through a DEDICATED bridge route (`/write-transaction`) that accepts only the
 * league-transactions write URL -- never the general `/fetch` GET reader -- so the ability to write can
 * never be reached by a caller that only meant to read. Used exclusively by `ff propose-trade --send`,
 * behind its own dry-run gate.
 */
export async function bridgeWriteTransaction(url: string, body: string, timeoutMs = 25000): Promise<string> {
  const info = bridgeInfo();
  if (!info) throw new Error("app bridge not available (open the desktop app and sign in to ESPN)");
  const payload = JSON.stringify({ url, body });
  const respBody = await new Promise<string>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port: info.port, path: "/write-transaction", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "x-ff-token": info.token },
      timeout: timeoutMs,
    }, (res) => { let o = ""; res.on("data", (d) => (o += d)); res.on("end", () => resolve(o)); });
    req.on("timeout", () => req.destroy(new Error(`write timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(payload); req.end();
  });
  let parsed: { status?: number; body?: string; error?: string };
  try { parsed = JSON.parse(respBody); } catch { throw new Error(`app bridge returned non-JSON: ${respBody.slice(0, 160)}`); }
  if (parsed.error) throw new Error(`app bridge: ${parsed.error}`);
  if (parsed.status && parsed.status >= 400) throw new Error(`ESPN returned HTTP ${parsed.status}: ${(parsed.body ?? "").slice(0, 300)}`);
  return typeof parsed.body === "string" ? parsed.body : JSON.stringify(parsed);
}

export interface FrameInfo { url: string; name: string }
export interface FrameRead { frames?: FrameInfo[]; url?: string; name?: string; text?: string }

/**
 * Read text from a NESTED frame of the app's ESPN webview -- the one place `bridgeFetch` and the DOM
 * readers cannot reach, because they run in the guest's TOP document and a cross-origin child iframe
 * (the Fantasy Chat / DM panel) is walled off from it. The main process does the frame walk; this is
 * only the loopback client for it. Omit `match` to list every frame's URL; pass `match` (a substring
 * of the frame URL) to get that frame's text, optionally scoped to a CSS `selector`.
 */
export async function bridgeReadFrame(
  opts: { match?: string; selector?: string; waitMs?: number; scrollUp?: boolean; host?: string } = {},
  timeoutMs = 20000,
): Promise<FrameRead> {
  const info = bridgeInfo();
  if (!info) throw new Error("app bridge not available (open the desktop app and sign in to ESPN)");
  const payload = JSON.stringify(opts);
  const body = await new Promise<string>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port: info.port, path: "/read-frame", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "x-ff-token": info.token },
      timeout: timeoutMs,
    }, (res) => { let o = ""; res.on("data", (d) => (o += d)); res.on("end", () => resolve(o)); });
    req.on("timeout", () => req.destroy(new Error(`read-frame timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(payload); req.end();
  });
  let parsed: FrameRead & { error?: string };
  try { parsed = JSON.parse(body) as FrameRead & { error?: string }; }
  catch { throw new Error(`app bridge returned non-JSON: ${body.slice(0, 120)}`); }
  if (parsed.error) throw new Error(`read-frame: ${parsed.error}`);
  return parsed;
}

export interface ClickResult { ok: boolean; clicked?: string; err?: string; popup?: string }

/**
 * HARDENED click on an element in the app's ESPN webview: dispatches the full bubbling pointer/mouse/
 * click sequence, not just `el.click()`, so a React onClick on a chrome-less control (the Fantasy
 * Chat toggle) actually fires. Target by CSS `selector` or by visible `text` (smallest match wins).
 * The main process does the dispatch; this is only the loopback client. Mirrors bridgeFetch's shape.
 */
export async function bridgeClick(
  opts: { selector?: string; text?: string; nth?: number; frame?: string; host?: string },
  timeoutMs = 15000,
): Promise<ClickResult> {
  const info = bridgeInfo();
  if (!info) throw new Error("app bridge not available (open the desktop app and sign in to ESPN)");
  const payload = JSON.stringify(opts);
  const body = await new Promise<string>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port: info.port, path: "/click", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "x-ff-token": info.token },
      timeout: timeoutMs,
    }, (res) => { let o = ""; res.on("data", (d) => (o += d)); res.on("end", () => resolve(o)); });
    req.on("timeout", () => req.destroy(new Error(`click timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(payload); req.end();
  });
  let parsed: ClickResult & { error?: string };
  try { parsed = JSON.parse(body) as ClickResult & { error?: string }; }
  catch { throw new Error(`app bridge returned non-JSON: ${body.slice(0, 120)}`); }
  if (parsed.error) throw new Error(`click: ${parsed.error}`);
  return parsed;
}

export interface ReadResult { title: string; url: string; text: string }

/**
 * Render any public page in the app's browser and return its text.
 *
 * This is a DIFFERENT route from bridgeFetch and runs in a separate, off-the-record session
 * partition -- research pages must not receive the ESPN cookies, and one route doing both jobs would
 * send them to whatever host the caller named. The reason to route through the app rather than
 * WebFetch is that this is a real Chromium: JavaScript executes and the fingerprint is a genuine
 * browser, so pages that refuse a plain HTTP client render normally.
 */
export async function bridgeRead(url: string, waitMs = 2500, timeoutMs = 45000): Promise<ReadResult> {
  const info = bridgeInfo();
  if (!info) throw new Error("app bridge not available -- open the desktop app");
  const payload = JSON.stringify({ url, waitMs });
  const body = await new Promise<string>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port: info.port, path: "/read", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "x-ff-token": info.token },
      timeout: timeoutMs,
    }, (res) => { let o = ""; res.on("data", (d) => (o += d)); res.on("end", () => resolve(o)); });
    req.on("timeout", () => req.destroy(new Error(`page read timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(payload); req.end();
  });
  const parsed = JSON.parse(body) as ReadResult & { error?: string };
  if (parsed.error) throw new Error(`read ${url}: ${parsed.error}`);
  return parsed;
}
