// Drive the desktop app's embedded ESPN <webview> with the SAME draft code that drives a bro
// browser tab.
//
// Why this exists: Playwright's connectOverCDP does NOT enumerate an Electron <webview> as a page
// (the guest shows up in /json/list as a target of type "webview"; `attach()` sees only the file://
// renderer). So `--port 9223` handed every draft verb the renderer instead of ESPN. The only channel
// into the guest is the renderer's `webview.executeJavaScript(<string>)`.
//
// Rather than reimplement espnAuction.ts against that channel -- it is the live-verified reader and
// actor, and a parallel copy would drift -- this module implements the SUBSET of Playwright's Page
// API that espnAuction actually uses, on top of executeJavaScript. espnAuction.ts is unchanged.
//
// Surface actually used (measured, not guessed): page.evaluate(string) x6, page.locator(...) with
// {hasText}/{has}/.first()/.count()/.isDisabled()/.click()/.fill()/.boundingBox(), page.mouse
// .move/.wheel (dumpValues only), page.waitForTimeout.
import { chromium, type Browser, type Page } from "playwright-core";

type Step =
  | { k: "css"; sel: string }
  | { k: "hasText"; src: string; flags: string }
  | { k: "has"; steps: Step[] }
  | { k: "first" };

// Resolver injected into the guest for every call. Mirrors Playwright's semantics for the subset we
// use: css descends from the current set, hasText filters, has keeps elements containing a match,
// first truncates.
const RESOLVER = `
function __ffFrom(roots, steps){
  var cur = roots;
  for (var i=0;i<steps.length;i++){
    var s = steps[i];
    if (s.k === 'css'){
      var next = [];
      for (var j=0;j<cur.length;j++){
        var f = cur[j].querySelectorAll(s.sel);
        for (var m=0;m<f.length;m++) next.push(f[m]);
      }
      cur = next;
    } else if (s.k === 'hasText'){
      var re = new RegExp(s.src, s.flags);
      cur = cur.filter(function(e){ return re.test(((e.innerText||e.textContent||'')+'').trim()); });
    } else if (s.k === 'has'){
      cur = cur.filter(function(e){ return __ffFrom([e], s.steps).length > 0; });
    } else if (s.k === 'first'){
      cur = cur.slice(0,1);
    }
  }
  return cur;
}
function __ffResolve(steps){ return __ffFrom([document], steps); }
`;

/** A Playwright-shaped locator backed by a serialized step chain evaluated in the guest. */
class WvLocator {
  constructor(private readonly ev: (js: string) => Promise<unknown>, private readonly steps: Step[]) {}

  private chain(extra: Step[]): WvLocator { return new WvLocator(this.ev, [...this.steps, ...extra]); }
  // evalRaw wraps this in `(function(){ <js> })()`, so the inner IIFE's value must be RETURNED.
  // Without the `return` every locator silently resolved to undefined -> count 0, which reads
  // exactly like "no such element" and is invisible outside a draft room.
  private call(op: string): Promise<unknown> {
    return this.ev(`${RESOLVER}
      return (function(){ var els = __ffResolve(${JSON.stringify(this.steps)}); ${op} })();`);
  }

  locator(sel: string, opts?: { hasText?: RegExp | string; has?: WvLocator }): WvLocator {
    return this.chain(stepsFor(sel, opts));
  }
  first(): WvLocator { return this.chain([{ k: "first" }]); }

  async count(): Promise<number> { return Number(await this.call("return els.length;")); }

  async isDisabled(): Promise<boolean> {
    return Boolean(await this.call(
      "if(!els.length) return true; var e=els[0];" +
      "return !!(e.disabled || e.getAttribute('aria-disabled')==='true' || (e.className||'').indexOf('disabled')>=0);",
    ));
  }

  async click(_opts?: { timeout?: number }): Promise<void> {
    await this.call("if(!els.length) return false; var e=els[0]; e.scrollIntoView({block:'center'}); e.click(); return true;");
  }

  /** React ignores a plain `value =` assignment: it tracks the previous value on the node and skips
   *  the synthetic event. Use the prototype's native setter, then dispatch input+change. */
  async fill(value: string): Promise<void> {
    await this.call(
      "if(!els.length) return false; var e=els[0];" +
      "var proto = e.tagName==='TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;" +
      "var setter = Object.getOwnPropertyDescriptor(proto,'value').set;" +
      "e.focus(); setter.call(e, " + JSON.stringify(value) + ");" +
      "e.dispatchEvent(new Event('input',{bubbles:true}));" +
      "e.dispatchEvent(new Event('change',{bubbles:true}));" +
      "return true;",
    );
  }

  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const r = await this.call("if(!els.length) return null; var b=els[0].getBoundingClientRect();" +
      "return {x:b.x,y:b.y,width:b.width,height:b.height};");
    return (r ?? null) as { x: number; y: number; width: number; height: number } | null;
  }
}

/** `return (js);` if js is a valid expression, else run it as statements. Compiled (not run) here to
 *  classify it -- a syntax error in the guest surfaces only as Electron's locationless
 *  "Script failed to execute". */
function asBody(js: string): string {
  try { new Function(`return (${js});`); return `return (${js});`; } catch { return js; }
}

function stepsFor(sel: string, opts?: { hasText?: RegExp | string; has?: WvLocator }): Step[] {
  const steps: Step[] = [{ k: "css", sel }];
  if (opts?.hasText) {
    const re = typeof opts.hasText === "string" ? new RegExp(opts.hasText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : opts.hasText;
    steps.push({ k: "hasText", src: re.source, flags: re.flags });
  }
  if (opts?.has) steps.push({ k: "has", steps: (opts.has as unknown as { steps: Step[] }).steps });
  return steps;
}

/** The page-shaped object espnAuction.ts receives. */
export class WebviewPage {
  private lastX = 0;
  private lastY = 0;
  constructor(private readonly renderer: Page) {}

  /** Raw string eval in the guest, JSON round-tripped so structured returns survive. */
  private async evalRaw(js: string): Promise<unknown> {
    const wrapped = `(function(){ try { return JSON.stringify({v: (function(){ ${js} })()}); }
      catch(e){ return JSON.stringify({e: String(e && e.message || e)}); } })()`;
    const out = await this.renderer.evaluate(async (code) => {
      const wv = document.getElementById("espnview") as unknown as { executeJavaScript?: (c: string) => Promise<string> };
      if (!wv?.executeJavaScript) return JSON.stringify({ e: "no webview" });
      try { return await wv.executeJavaScript(code); } catch (e) { return JSON.stringify({ e: String(e) }); }
    }, wrapped);
    let parsed: { v?: unknown; e?: string };
    try { parsed = JSON.parse(String(out || "{}")); } catch { return null; }
    // Include the offending source: "Script failed to execute" from Electron carries no location,
    // and without the snippet there is no way to tell WHICH of the calls failed.
    if (parsed.e) throw new Error("webview eval: " + parsed.e + "\n--- script: " + js.replace(/\s+/g, " ").slice(0, 300));
    return parsed.v ?? null;
  }

  /** Playwright's page.evaluate accepts a function, an EXPRESSION string (`(() => {...})()` -- what
   *  espnAuction passes), or a STATEMENT string (`window.x=null; if(...){...}` -- what
   *  cmdLaunchPractice passes). Wrapping a statement string in `return (...)` is a syntax error, so
   *  decide which it is by compiling it here, in Node, where the failure is catchable. */
  async evaluate(js: string | (() => unknown)): Promise<unknown> {
    if (typeof js === "function") return await this.evalRaw(`return (${js.toString()})();`);
    return await this.evalRaw(asBody(js));
  }

  /**
   * Authenticated fetch from INSIDE the guest, so the logged-in user's cookies apply. This is the
   * transport primitive every league adaptor needs -- read the site's own API as the user, without
   * scraping the DOM or handling credentials ourselves. It is deliberately platform-agnostic: the
   * caller supplies the URL and headers, so an ESPN, Sleeper or Yahoo adaptor all use this one path.
   *
   * It canNOT go through evaluate(): evalRaw JSON.stringifies its result synchronously, and a
   * Promise stringifies to `{}`, so a fetch would silently return nothing. Electron's
   * executeJavaScript DOES resolve promises, so this drives it directly.
   *
   * Returns the raw body. Network and HTTP errors surface as a thrown Error rather than an empty
   * string -- a caller that JSON.parses "" gets an unreadable failure a dozen frames from the cause.
   */
  async fetchText(url: string, headers?: Record<string, string>): Promise<string> {
    // PREFER THE APP BRIDGE. Same webview, same cookies, same result -- but reached through a
    // one-route loopback endpoint the app publishes rather than through Chromium's debugging port.
    // The CDP path below is kept as the fallback, not deleted: the bridge only exists in an app
    // started from the current main.js, and a hard cutover would strand anyone who has not
    // restarted. See browser/appBridge.ts for why the debugging port is the worse channel.
    const { bridgeAvailable, bridgeFetch } = await import("./appBridge.js");
    if (bridgeAvailable()) return bridgeFetch(url, headers);

    const init = JSON.stringify({ credentials: "include", headers: headers ?? {} });
    const js = `fetch(${JSON.stringify(url)},${init}).then(function(r){
      return r.ok ? r.text() : ('__HTTP__' + r.status);
    }).catch(function(e){ return '__ERR__' + (e && e.message || e); })`;
    const out = await this.renderer.evaluate(async (code) => {
      const wv = document.getElementById("espnview") as unknown as { executeJavaScript?: (c: string) => Promise<string> };
      if (!wv?.executeJavaScript) return "__ERR__no webview";
      try { return await wv.executeJavaScript(code); } catch (e) { return "__ERR__" + String(e); }
    }, js);
    const body = String(out ?? "");
    if (body.startsWith("__HTTP__")) throw new Error(`fetch ${url} -> HTTP ${body.slice(8)}`);
    if (body.startsWith("__ERR__")) throw new Error(`fetch ${url} -> ${body.slice(7)}`);
    return body;
  }

  /** fetchText + JSON.parse, with the response head in the error when the body is not JSON (an
   *  expired session returns an HTML login page, which is the single most common failure). */
  async fetchJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T> {
    const body = await this.fetchText(url, headers);
    try { return JSON.parse(body) as T; }
    catch { throw new Error(`fetch ${url} -> not JSON (session expired?): ${body.slice(0, 120)}`); }
  }

  locator(sel: string, opts?: { hasText?: RegExp | string; has?: WvLocator }): WvLocator {
    return new WvLocator((j) => this.evalRaw(j), stepsFor(sel, opts));
  }

  async waitForTimeout(ms: number): Promise<void> { await this.renderer.waitForTimeout(ms); }

  /** Poll `fn` in the guest until it returns truthy. Playwright rejects on timeout; match that, so
   *  callers that `.catch(() => false)` (cmdLaunchPractice does) keep behaving identically. */
  async waitForFunction(fn: string | (() => unknown), opts?: { timeout?: number }): Promise<void> {
    const timeout = opts?.timeout ?? 30000;
    const deadline = Date.now() + timeout;
    for (;;) {
      const v = await this.evaluate(fn).catch(() => null);
      if (v) return;
      if (Date.now() >= deadline) throw new Error(`waitForFunction timed out after ${timeout}ms`);
      await this.renderer.waitForTimeout(250);
    }
  }

  // dumpValues scrolls the virtualized board. There is no real input device here, so scroll the
  // element under the last move point.
  mouse = {
    move: async (x: number, y: number): Promise<void> => { this.lastX = x; this.lastY = y; },
    wheel: async (_dx: number, dy: number): Promise<void> => {
      await this.evalRaw(
        `var e=document.elementFromPoint(${this.lastX},${this.lastY});` +
        `while(e && e.scrollHeight<=e.clientHeight) e=e.parentElement;` +
        `if(e) e.scrollTop += ${Math.round(dy)}; return true;`,
      );
    },
  };

  // Playwright's page.url() is SYNCHRONOUS and callers use it that way (findPage does
  // `p.url().includes(...)`), so serve a cached value and refresh it around navigation/reads.
  private cachedUrl = "";
  url(): string { return this.cachedUrl; }
  async refreshUrl(): Promise<string> {
    this.cachedUrl = String(await this.evalRaw("return location.href;") ?? "");
    return this.cachedUrl;
  }
  async title(): Promise<string> { return String(await this.evalRaw("return document.title;") ?? ""); }

  /** Navigate the guest (webview.loadURL, since the guest has no Playwright navigation). */
  async goto(url: string, _opts?: unknown): Promise<void> {
    await this.renderer.evaluate((u) => {
      const w = window as unknown as { setView?: (v: string) => void };
      if (w.setView) w.setView("live");
      const wv = document.getElementById("espnview") as unknown as { loadURL?: (u: string) => void };
      if (wv?.loadURL) wv.loadURL(u);
    }, url);
    await this.renderer.waitForTimeout(4000);
    await this.refreshUrl();
  }

  /** ESPN opens draft rooms in a new window; Electron sends those to the system browser, so the
   *  room never lands in the webview. Neutralize BOTH routes in the guest: record window.open
   *  targets, and retarget `_blank` anchors to `_self` as they are clicked. */
  async capturePopups(): Promise<void> {
    await this.evalRaw(
      "window.__ffOpen = window.__ffOpen || null;" +
      "if(!window.__ffPatched){ window.__ffPatched=1;" +
      "  window.open = function(u){ try{ window.__ffOpen = String(u||''); }catch(e){}" +
      "    return {closed:false,focus:function(){},blur:function(){},close:function(){},postMessage:function(){}}; };" +
      "  document.addEventListener('click', function(ev){" +
      "    var a = ev.target && ev.target.closest ? ev.target.closest('a[target=\"_blank\"]') : null;" +
      "    if(a){ try{ window.__ffOpen = a.href; }catch(e){} a.target='_self'; }" +
      "  }, true);" +
      "}" +
      "return true;",
    );
  }

  async takePopup(): Promise<string | null> {
    const u = await this.evalRaw("var u=window.__ffOpen; window.__ffOpen=null; return u||null;");
    return u ? String(u) : null;
  }
}

export interface AttachedWebview { browser: Browser; page: Page; raw: WebviewPage }

/** Connect to the running desktop app and return its embedded ESPN guest as a Page-shaped object. */
export async function attachWebview(port = Number(process.env.FF_CDP_PORT ?? 9223)): Promise<AttachedWebview> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
  if (!browser) throw new Error(`No app on CDP port ${port} -- open the desktop app (it exposes ${port}).`);
  const renderer = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file://"));
  if (!renderer) { await browser.close().catch(() => {}); throw new Error("App renderer page not found on the CDP endpoint."); }
  const raw = new WebviewPage(renderer);
  // Fail loudly here rather than returning a shim that silently reads nothing.
  const href = await raw.refreshUrl();
  if (!href) { await browser.close().catch(() => {}); throw new Error("Embedded webview not reachable (open the Live Draft view once)."); }
  return { browser, page: raw as unknown as Page, raw };
}
