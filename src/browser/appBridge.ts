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

/** Fetch an ESPN URL through the app's logged-in webview. Throws with an actionable message. */
export async function bridgeFetch(url: string, headers?: Record<string, string>, timeoutMs = 20000): Promise<string> {
  const info = bridgeInfo();
  if (!info) throw new Error("app bridge not available (app not running, or started before the bridge existed -- restart it)");
  const payload = JSON.stringify({ url, headers: headers ?? {} });
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
  if (parsed.status && parsed.status >= 400) throw new Error(`ESPN returned HTTP ${parsed.status} through the app session`);
  if (typeof parsed.body !== "string") throw new Error("app bridge returned no body");
  return parsed.body;
}

/** True when the app is up and reachable -- used to prefer the bridge over CDP without guessing. */
export function bridgeAvailable(): boolean {
  return bridgeInfo() !== null;
}
