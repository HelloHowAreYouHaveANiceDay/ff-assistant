/**
 * THE ONLY LIVE TRANSPORT (D55): authenticated requests run INSIDE a `bim bro` persistent browser
 * session (site `espn`), via `bim bro page --action eval`. Replaces the Electron app bridge.
 *
 * - No local HTTP server, no token, no port assumed: the session is resolved with `bim bro sessions`.
 * - Every call is an argv array to `bim` (never a shell string).
 * - The host allowlist lives HERE: parsed hostname, https only, default port, no userinfo,
 *   dot-boundary suffix. The site is chosen from the URL host, never from the caller's say-so.
 * - Login is never automated (D2): a logged-out session throws NotLoggedIn with the owner action.
 * - Yahoo is NOT supported (owner decision 2026-11-18): a Yahoo host is refused by name.
 */
import { execFile } from "node:child_process";

export type BroSite = "espn";
export type ExecFn = (file: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;

const SITES: Record<BroSite, { suffix: string; home: string; loginAction: string }> = {
  espn: {
    suffix: "espn.com",
    home: "https://fantasy.espn.com/football/",
    loginAction: "bro espn session not logged in -- run `bim bro auth --site espn`",
  },
};

/** Max chars passed as one argv entry (Windows CreateProcess caps the whole command line at 32767). */
const MAX_ARG = 30000;

export class NotLoggedIn extends Error {
  constructor(msg: string) { super(msg); this.name = "NotLoggedIn"; }
}

/** The exec seam. Tests inject a recorder; production runs `bim`. */
let execImpl: ExecFn = (file, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    if (err) {
      const e = err as Error & { code?: string };
      if (e.code === "ENOENT") return reject(new Error("`bim` not found on PATH -- the bro transport needs bim-cli"));
      const detail = String(stdout || stderr || "").slice(0, 300);
      return reject(new Error(`bim ${args.slice(0, 4).join(" ")} failed: ${e.message.split("\n")[0]}${detail ? ` | ${detail}` : ""}`));
    }
    resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});
const defaultExec = execImpl;
export function setExec(fn: ExecFn | null): void {
  execImpl = fn ?? defaultExec;
  tabs.clear();
}

const tabs = new Map<BroSite, string>();

/** Which site may serve this URL, or null. Strict parsed-hostname check (dce64e7 semantics). */
export function siteForUrl(url: string): BroSite | null {
  let u: URL;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  for (const [site, c] of Object.entries(SITES) as [BroSite, typeof SITES[BroSite]][]) {
    if (h === c.suffix || h.endsWith("." + c.suffix)) return site;
  }
  return null;
}

/** Site for a host string (PlatformIO `host`, e.g. "espn.com"); Yahoo is refused by name. */
export function siteForHost(host: string): BroSite {
  const h = String(host ?? "").toLowerCase();
  if (h.includes("yahoo")) throw new Error("Yahoo not supported -- the bro cutover (D55) dropped Yahoo league 129048; ESPN 462233 is the only live target");
  if (h === "espn.com" || h.endsWith(".espn.com")) return "espn";
  throw new Error(`no bro site for host "${host}"`);
}

async function bim(args: string[], timeoutMs = 60000): Promise<string> {
  return (await execImpl("bim", args, timeoutMs)).stdout;
}

function parseJson(s: string, what: string): any {
  const t = s.trim();
  const i = t.indexOf("{");
  try { return JSON.parse(i > 0 ? t.slice(i) : t); } catch { throw new Error(`bim ${what} returned non-JSON: ${t.slice(0, 160)}`); }
}

/** Make sure a live session + exactly one tab on the site's home host; cache the tab id. */
export async function ensureSession(site: BroSite, force = false): Promise<string> {
  if (!force && tabs.has(site)) return tabs.get(site)!;
  tabs.delete(site);
  const list = parseJson(await bim(["bro", "sessions"]), "sessions");
  const live = (list.sessions ?? []).some((s: any) => s.site === site && s.alive);
  if (!live) {
    await bim(["bro", "session", "--op", "start", "--site", site, "--detach"], 120000);
  }
  const suffix = SITES[site].suffix;
  const onSite = (u: string) => { try { const h = new URL(u).hostname; return h === suffix || h.endsWith("." + suffix); } catch { return false; } };
  let t = parseJson(await bim(["bro", "page", "--site", site, "--action", "tabs"]), "page tabs");
  let mine = (t.tabs ?? []).find((x: any) => onSite(x.url));
  if (!mine) {
    await bim(["bro", "open", "--site", site, "--url", SITES[site].home], 90000);
    t = parseJson(await bim(["bro", "page", "--site", site, "--action", "tabs"]), "page tabs");
    mine = (t.tabs ?? []).find((x: any) => onSite(x.url));
  }
  if (!mine) throw new Error(`bro ${site}: no tab on ${suffix} after open`);
  tabs.set(site, String(mine.id));
  return String(mine.id);
}

/** Evaluate JS in the site's tab; returns the eval `value`. Re-ensures once if the tab died. */
export async function broEval(site: BroSite, js: string, timeoutMs = 60000): Promise<unknown> {
  if (js.length > MAX_ARG) throw new Error(`bro eval payload is ${js.length} chars, over the ${MAX_ARG} argv cap`);
  for (let attempt = 0; ; attempt++) {
    const tab = await ensureSession(site, attempt > 0);
    try {
      const out = parseJson(await bim(["bro", "page", "--site", site, "--tab", tab, "--action", "eval", "--arg", js], timeoutMs), "page eval");
      if (out && out.ok === false) throw new Error(`bro eval failed (${out.error?.kind ?? "unknown"}): ${out.error?.message ?? ""}`);
      return out.value;
    } catch (e) {
      if (attempt === 0) { tabs.delete(site); continue; }
      throw e;
    }
  }
}

function fetchJs(url: string, init: Record<string, unknown>): string {
  return `(async()=>{const r=await fetch(${JSON.stringify(url)},${JSON.stringify({ credentials: "include", ...init })});return JSON.stringify({status:r.status,statusText:r.statusText,body:await r.text()})})()`;
}

function notLoggedIn(site: BroSite): never { throw new NotLoggedIn(SITES[site].loginAction); }

async function run(site: BroSite, url: string, init: Record<string, unknown>, timeoutMs: number): Promise<{ status: number; statusText: string; body: string }> {
  const v = await broEval(site, fetchJs(url, init), timeoutMs);
  let r: any;
  try { r = JSON.parse(String(v)); } catch { throw new Error(`bro fetch returned non-JSON: ${String(v).slice(0, 120)}`); }
  return r;
}

/** Authenticated GET. Non-2xx throws "<status> <statusText> for <url>" (cookiePlatformIO's shape). */
export async function broFetch(url: string, headers: Record<string, string> = {}, timeoutMs = 25000): Promise<string> {
  const site = siteForUrl(url);
  if (!site) throw new Error(`REFUSED: ${String(url).slice(0, 120)} is not an allowlisted https host for any bro site`);
  const r = await run(site, url, { headers }, timeoutMs);
  if (r.status === 401) notLoggedIn(site);
  if (r.status < 200 || r.status >= 300) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.body;
}

/** Authenticated POST. NEVER throws on non-2xx: for a write the status is the result. */
export async function broPost(url: string, body: string, timeoutMs = 25000): Promise<{ status: number; body: string }> {
  const site = siteForUrl(url);
  if (!site) throw new Error(`REFUSED: ${String(url).slice(0, 120)} is not an allowlisted https host for any bro site`);
  const r = await run(site, url, { method: "POST", headers: { "content-type": "application/json" }, body }, timeoutMs);
  if (r.status === 401) notLoggedIn(site);
  return { status: r.status, body: r.body };
}

/** True when `bim` is on PATH. (A stopped session is started on demand by ensureSession.) */
export async function broAvailable(): Promise<boolean> {
  try { await bim(["bro", "sessions"], 20000); return true; } catch { return false; }
}

/** Navigate the site's tab, for DOM reads. */
export async function broGoto(site: BroSite, url: string): Promise<void> {
  if (siteForUrl(url) !== site) throw new Error(`REFUSED: ${url.slice(0, 120)} is not on ${site}`);
  const tab = await ensureSession(site);
  await bim(["bro", "page", "--site", site, "--tab", tab, "--action", "goto", "--arg", url], 90000);
}

/**
 * A tiny page-shaped handle over the espn session for DOM-reading adaptors (src/league/espn.ts):
 * goto / waitForTimeout / refreshUrl / evaluate(body-or-expression string) / fetchJson.
 * Plain DOM JS only -- no Playwright Page API.
 */
export interface BroPage {
  goto(url: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  refreshUrl(): Promise<string>;
  evaluate(js: string): Promise<unknown>;
  fetchJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T>;
}

/** A string is an EXPRESSION when `return (<js>)` compiles; otherwise it is a function BODY. */
function asBody(js: string): string {
  try { new Function(`return (${js});`); return `return (${js});`; } catch { return js; }
}

export function broPage(site: BroSite = "espn"): BroPage {
  return {
    async goto(url) { await broGoto(site, url); },
    waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    async refreshUrl() { return String(await broEval(site, "location.href")); },
    async evaluate(js) {
      const v = await broEval(site, `(async()=>JSON.stringify((await (async()=>{${asBody(js)}})())??null))()`);
      return typeof v === "string" ? JSON.parse(v) : v;
    },
    async fetchJson<T>(url: string, headers?: Record<string, string>) {
      return JSON.parse(await broFetch(url, headers ?? {})) as T;
    },
  };
}
