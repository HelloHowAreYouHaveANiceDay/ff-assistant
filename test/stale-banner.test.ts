// The stale-data banner must fire when the live board is unavailable, and stay silent when it is
// not. Both directions are tested, because a guard that can only ever say "no" is dead code that
// reads exactly like a guard that is passing.
//
// WHY THIS TEST EXISTS. app/renderer/data.js is a checked-in snapshot that nothing regenerates, and
// it renders identically to the live board. A rebuilt board therefore "did not update" in the UI
// while actually being perfectly up to date in SQLite -- the renderer had silently fallen back and
// was showing four-day-old dollar values that looked entirely plausible. The banner is the only
// thing standing between that and a trade priced off stale numbers.
//
// It runs the REAL bytes of app.js -- the file is read, the two functions are cut out of it by name
// and evaluated -- rather than a copy pasted into the test, so an edit to app.js that breaks the
// banner fails here instead of passing against a stale duplicate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync("app/renderer/app.js", "utf8");

/** Cut one top-level `function name(...) { ... }` out of a source file by brace matching. */
function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}() not found in app/renderer/app.js`);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

type El = { id: string; style: { cssText: string }; textContent: string };
function fakeDom() {
  const appended: El[] = [];
  const body = { style: { paddingTop: "" }, appendChild: (el: El) => appended.push(el) };
  const document = {
    getElementById: (id: string) => appended.find((e) => e.id === id) ?? null,
    createElement: () => ({ id: "", style: { cssText: "" }, textContent: "" }) as El,
    body,
  };
  return { document, body, appended };
}

function runBanner(src: { live: boolean; why: string; stamp: string }) {
  const dom = fakeDom();
  const fn = new Function("document", `${extractFn(SRC, "showStaleBanner")}; return showStaleBanner;`);
  fn(dom.document)(src);
  return dom;
}

test("banner appears, names the snapshot date, and says why the live path lost", () => {
  const dom = runBanner({ live: false, why: "no engine bridge (window.mc)", stamp: "2026-09-03" });
  assert.equal(dom.appended.length, 1, "expected exactly one banner element");
  const b = dom.appended[0];
  assert.equal(b.id, "stale-banner");
  // The three things a reader needs: that it is stale, how stale, and why.
  assert.match(b.textContent, /SNAPSHOT DATA/);
  assert.match(b.textContent, /2026-09-03/, "must name the snapshot date, not just 'stale'");
  assert.match(b.textContent, /no engine bridge/, "must name the reason the live path failed");
  assert.match(b.textContent, /will not appear/i, "must say rebuilds won't show up");
  assert.ok(dom.body.style.paddingTop, "must reserve space so it cannot cover the board");
});

test("banner is not duplicated if boot runs twice", () => {
  const dom = fakeDom();
  const fn = new Function("document", `${extractFn(SRC, "showStaleBanner")}; return showStaleBanner;`);
  const show = fn(dom.document);
  show({ live: false, why: "x", stamp: "2026-09-03" });
  show({ live: false, why: "x", stamp: "2026-09-03" });
  assert.equal(dom.appended.length, 1, "second call must be a no-op");
});

// THE POSITIVE DIRECTION. Fault injection proves the banner rejects a dead live path; it says
// nothing about whether the banner can ever stay quiet. If boot() called showStaleBanner
// unconditionally, every test above would still pass while the app permanently cried wolf.
test("boot only banners when the live path did NOT win", () => {
  const boot = extractFn(SRC, "boot");
  const call = boot.match(/^.*showStaleBanner.*$/m);
  assert.ok(call, "boot() must call showStaleBanner");
  assert.match(call[0], /if\s*\(\s*!\s*DATA_SOURCE\.live\s*\)/,
    "the call must be guarded on the live path having failed, not unconditional");
  assert.match(boot, /DATA_SOURCE\s*=\s*\{\s*live:\s*true/,
    "boot() must record live:true on the success path, or the guard can never be false");
});

// The empty-result path is the likelier real bug and is NOT a thrown error: appDataPayload queries
// `board` for config.season, so a season with no rows returns [] rather than raising.
test("an empty engine result is treated as failure, not success", () => {
  const boot = extractFn(SRC, "boot");
  assert.match(boot, /d\.players\.length/, "boot() must check the array is non-empty");
  assert.match(boot, /else\s*\{[\s\S]*?engine returned/,
    "a successful call returning zero players must set a reason, not fall through silently");
});

// The second staleness path: the renderer HAD live data and it aged out underneath it. Nothing is
// broken in that case, which is why nothing used to say anything.
test("boot arms the rebuild watcher on the live path", () => {
  const boot = extractFn(SRC, "boot");
  assert.match(boot, /watchForRebuild\(/, "boot() must arm the watcher when live data loads");
  const w = extractFn(SRC, "watchForRebuild");
  assert.match(w, /if\s*\(!seenAt\s*\|\|\s*!window\.mc/,
    "the watcher must no-op without a stamp or an engine bridge, or it polls forever in a browser");
  assert.match(w, /stamp === seenAt/, "it must compare against the stamp it booted with");
  // Push and poll must funnel through ONE comparison. Two copies of "has it changed?" is how the
  // fast path and the backstop drift into disagreeing about what stale means.
  assert.equal((w.match(/stamp === seenAt/g) || []).length, 1,
    "exactly one change-comparison, shared by the push and the poll");
});

test("data.js carries a generation stamp so the banner can name a date", () => {
  const dj = readFileSync("app/renderer/data.js", "utf8").slice(0, 200);
  assert.match(dj, /^window\.DATA_JS_STAMP\s*=\s*"\d{4}-\d{2}-\d{2}"/,
    "data.js must begin with an ISO date stamp; nothing regenerates it, so it must self-describe");
});
