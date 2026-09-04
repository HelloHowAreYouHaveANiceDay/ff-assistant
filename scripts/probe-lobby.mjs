// How does ESPN's mock-draft lobby actually launch a room? The webview blocks window.open, so
// clicking does nothing visible -- find the href/onclick/data-* the button carries so we can
// navigate() straight to the room URL instead. Read-only probe.
import { chromium } from "playwright-core";

const PORT = process.env.FF_CDP_PORT ?? "9223";
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file://"));
if (!page) { console.log("renderer not found"); await browser.close(); process.exit(1); }

const wvEval = (js) => page.evaluate(async (code) => {
  const wv = document.getElementById("espnview");
  if (!wv?.executeJavaScript) return "";
  try { return await wv.executeJavaScript(code); } catch (e) { return "ERR:" + (e?.message ?? e); }
}, js);

const js = "(function(){" +
  "var out=[];" +
  "var els=Array.prototype.slice.call(document.querySelectorAll('a,button,[role=button],[onclick]'));" +
  "els.forEach(function(e){var t=(e.innerText||e.value||'').trim();" +
  "if(!t)return; var tl=t.toLowerCase();" +
  "if(tl.indexOf('practice')<0&&tl.indexOf('draft')<0&&tl.indexOf('join')<0)return;" +
  "var d={};for(var i=0;i<e.attributes.length;i++){var a=e.attributes[i];if(a.name.indexOf('data-')===0||a.name==='href'||a.name==='onclick')d[a.name]=String(a.value).slice(0,160);}" +
  "out.push({tag:e.tagName,text:t.slice(0,50),attrs:d});});" +
  "return JSON.stringify(out.slice(0,25));})()";

const raw = await wvEval(js);
console.log("current url:", await wvEval("location.href"));
try {
  for (const e of JSON.parse(raw || "[]")) console.log(`  <${e.tag}> "${e.text}"  ${JSON.stringify(e.attrs)}`);
} catch { console.log("raw:", String(raw).slice(0, 500)); }
await browser.close();
