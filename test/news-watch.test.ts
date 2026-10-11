// The breaking-news watch (src/inseason/newsWatch.ts) and the headline classifier it rests on
// (src/data/headlineKind.ts). The fixture is the real miss: Marvin Harrison Jr. was a free agent in
// league 462233 while the feed said he was being traded, and nothing alerted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHeadline } from "../src/data/headlineKind.js";
import { pickAlerts, type WatchItem, type Relevance, type WatchState } from "../src/inseason/newsWatch.js";

test("headline kinds: the real 2026-10-10/11 Harrison headlines", () => {
  assert.deepEqual(classifyHeadline("Report: Cardinals will be trading receiver Marvin Harrison Jr."), { kind: "transaction", severity: "high" });
  assert.deepEqual(classifyHeadline("Cardinals finalizing Marvin Harrison Jr. trade, former No. 4 pick inactive vs. Lions"), { kind: "transaction", severity: "high" });
  assert.deepEqual(classifyHeadline("Marvin Harrison Jr. is drawing trade interest from intriguing team"), { kind: "transaction", severity: "medium" });
  assert.deepEqual(classifyHeadline("Where is Marvin Harrison Jr. headed? Inside the mystery surrounding Cardinals' unfinished trade"), { kind: "transaction", severity: "medium" });
  assert.equal(classifyHeadline("Texans are the likely destination for Marvin Harrison Jr.").kind, "transaction");
});

test("headline kinds: injury, role, and plain colour", () => {
  assert.deepEqual(classifyHeadline("Star RB tears ACL, out for the season"), { kind: "injury", severity: "high" });
  assert.deepEqual(classifyHeadline("WR limited with hamstring tightness"), { kind: "injury", severity: "medium" });
  assert.equal(classifyHeadline("Rookie named the starter going forward").kind, "role");
  assert.deepEqual(classifyHeadline("Jacoby Brissett throws Michael Wilson under bus"), { kind: "", severity: "low" });
  assert.equal(classifyHeadline("QB shows signs of life in win").kind, "", "bare 'signs' is not a signing");
});

const NOW = new Date("2026-10-10T15:30:00Z");
const item = (o: Partial<WatchItem>): WatchItem => ({
  playerId: "marvinharrison", player: "Marvin Harrison Jr.", pos: "WR", team: "ARI", category: "headline",
  source: "rss:pft", severity: "low", detail: "Report: Cardinals will be trading receiver Marvin Harrison Jr.", url: "", firstSeen: "2026-10-10T15:16:53Z", ...o,
});
const REL = new Map<string, Relevance>([["marvinharrison", { rosteredPct: 90, value: 20, projPts: 150, usPos: "WR22" }]]);
const empty = (): WatchState => ({ seen: {}, lastAlert: {} });
const run = (items: WatchItem[], owner: Record<string, string>, state = empty(), now = NOW, rel = REL) =>
  pickAlerts(items, { owner: new Map(Object.entries(owner)), ourTeam: "8", relevance: rel, state, now });

test("a trade headline about a relevant FREE AGENT alerts", () => {
  const r = run([item({})], {});
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].scope, "fa");
  assert.deepEqual(r.alerts[0].reasons, ["transaction:high"]);
});

test("another team's player never alerts; ours does", () => {
  assert.equal(run([item({})], { marvinharrison: "15" }).alerts.length, 0);
  const ours = run([item({})], { marvinharrison: "8" });
  assert.equal(ours.alerts[0].scope, "ours");
});

test("an irrelevant free agent's trade headline is gated out; Sleeper top-10 is not", () => {
  const low = new Map<string, Relevance>([["marvinharrison", { rosteredPct: 2, value: 0, projPts: 3, usPos: "WR140" }]]);
  assert.equal(run([item({})], {}, empty(), NOW, low).alerts.length, 0);
  const trend = item({ category: "trending", source: "sleeper:add", detail: "trending added across leagues (Sleeper #4, 223876 moves)" });
  assert.equal(run([trend], {}, empty(), NOW, low).alerts.length, 1);
  const trend11 = item({ category: "trending", source: "sleeper:add", detail: "trending added across leagues (Sleeper #11, 5 moves)" });
  assert.equal(run([trend11], {}, empty(), NOW, low).alerts.length, 0);
});

test("each story alerts once; a second outlet with the same reason is suppressed in cooldown; a new reason re-alerts", () => {
  const first = run([item({})], {});
  assert.equal(first.alerts.length, 1);
  assert.equal(run([item({})], {}, first.state).alerts.length, 0, "same row twice");
  const later = new Date(NOW.getTime() + 3600e3);
  const sameReason = item({ source: "rss:cbs", detail: "Cardinals finalizing Marvin Harrison Jr. trade", firstSeen: "2026-10-10T16:00:00Z" });
  assert.equal(run([sameReason], {}, first.state, later).alerts.length, 0, "transaction:high again inside cooldown");
  const trend = item({ category: "trending", source: "sleeper:add", detail: "trending added across leagues (Sleeper #4, 1 moves)", firstSeen: later.toISOString() });
  assert.equal(run([trend], {}, first.state, later).alerts.length, 1, "trending is a new reason");
});

test("old items are not news, and an ESPN status change on OUR player alerts", () => {
  assert.equal(run([item({ firstSeen: "2026-10-01T00:00:00Z" })], {}).alerts.length, 0);
  const st = item({ category: "injury", source: "espn-status", detail: "OUT - Ankle", firstSeen: NOW.toISOString() });
  assert.equal(run([st], { marvinharrison: "8" }).alerts.length, 1);
  assert.equal(run([st], {}).alerts.length, 0, "a free agent's injury is not a pickup");
});
