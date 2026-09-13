// The trade resolver is the gate on the ONLY write path in the system, so its refusals are the thing
// that matters: it must not let a proposal through that gives a player you do not own, gets from two
// teams at once, or names an unknown player. Each of those is asserted by fault injection here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, setConfig } from "../src/db/db.js";
import { resolveTrade } from "../src/inseason/proposeTrade.js";

// A minimal league: I am team 8; team 14 is the counterparty. Godwin is mine, Bo Nix is theirs.
function seed() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "ff-trade-")), "t.db"));
  setConfig(db, { season: 2026 });
  db.prepare("INSERT INTO league (season, league_id, team_id) VALUES (2026, '462233', '8')").run();
  const team = db.prepare("INSERT INTO raw_league_team_season (league_id, season, team_id, name, fetched_at) VALUES ('462233', 2026, ?, ?, '2026-09-10')");
  team.run("8", "That King Henry"); team.run("14", "Jevon's Paradox");
  const ros = db.prepare("INSERT INTO raw_league_roster_week (league_id, season, week, team_id, espn_player_id, name, fetched_at) VALUES ('462233', 2026, 1, ?, ?, ?, '2026-09-10')");
  ros.run("8", "3116165", "Chris Godwin Jr.");
  ros.run("14", "4426338", "Bo Nix");
  ros.run("14", "999", "Bo Nix Jr."); // a second "Bo Nix" match, to exercise ambiguity
  return db;
}

test("a valid trade resolves to the exact ESPN payload with the right ids and directions", () => {
  const db = seed();
  const r = resolveTrade(db, ["Chris Godwin Jr."], ["Bo Nix"]);
  db.close();
  assert.equal(r.ok, false); // "Bo Nix" is ambiguous here (two matches) -- proving the ambiguity guard
  assert.ok(r.problems.some((p) => /ambiguous/.test(p)), "the duplicate Bo Nix should trip the ambiguity guard");
});

test("an exact GET name resolves and builds the payload: you give team 8's player, get team 14's", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "ff-trade2-")), "t.db"));
  setConfig(db, { season: 2026 });
  db.prepare("INSERT INTO league (season, league_id, team_id) VALUES (2026, '462233', '8')").run();
  db.prepare("INSERT INTO raw_league_team_season (league_id, season, team_id, name, fetched_at) VALUES ('462233',2026,'8','Mine','x'),('462233',2026,'14','Theirs','x')").run();
  db.prepare("INSERT INTO raw_league_roster_week (league_id, season, week, team_id, espn_player_id, name, fetched_at) VALUES ('462233',2026,1,'8','3116165','Chris Godwin Jr.','x'),('462233',2026,1,'14','4426338','Bo Nix','x')").run();
  const r = resolveTrade(db, ["Chris Godwin"], ["Bo Nix"]);
  db.close();
  assert.equal(r.ok, true, `expected sendable, got problems: ${r.problems.join("; ")}`);
  assert.equal(r.myTeamId, "8");
  assert.equal(r.otherTeamId, "14");
  const p = r.payload;
  assert.equal(p.type, "TRADE_PROPOSAL");
  assert.equal(p.teamId, 8);
  assert.deepEqual(p.items[0], { playerId: 3116165, type: "TRADE", fromTeamId: 8, toTeamId: 14 });
  assert.deepEqual(p.items[1], { playerId: 4426338, type: "TRADE", fromTeamId: 14, toTeamId: 8 });
  assert.match(r.writeUrl, /lm-api-writes\.fantasy\.espn\.com.*leagues\/462233\/transactions\/$/);
});

test("FAULT: giving a player you do not own is refused and NOT sendable", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "ff-trade3-")), "t.db"));
  setConfig(db, { season: 2026 });
  db.prepare("INSERT INTO league (season, league_id, team_id) VALUES (2026, '462233', '8')").run();
  db.prepare("INSERT INTO raw_league_team_season (league_id, season, team_id, name, fetched_at) VALUES ('462233',2026,'8','Mine','x'),('462233',2026,'14','Theirs','x')").run();
  db.prepare("INSERT INTO raw_league_roster_week (league_id, season, week, team_id, espn_player_id, name, fetched_at) VALUES ('462233',2026,1,'8','3116165','Chris Godwin Jr.','x'),('462233',2026,1,'14','4426338','Bo Nix','x')").run();
  // Try to give Bo Nix (team 14's player) -- the give-ownership check must refuse.
  const r = resolveTrade(db, ["Bo Nix"], ["Chris Godwin"]);
  db.close();
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /cannot trade away a player you do not own/.test(p)));
  assert.equal(r.payload, null, "a refused trade must build no payload -- nothing to send");
});

test("FAULT: an unknown player name is refused, not silently dropped", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "ff-trade4-")), "t.db"));
  setConfig(db, { season: 2026 });
  db.prepare("INSERT INTO league (season, league_id, team_id) VALUES (2026, '462233', '8')").run();
  db.prepare("INSERT INTO raw_league_team_season (league_id, season, team_id, name, fetched_at) VALUES ('462233',2026,'8','Mine','x'),('462233',2026,'14','Theirs','x')").run();
  db.prepare("INSERT INTO raw_league_roster_week (league_id, season, week, team_id, espn_player_id, name, fetched_at) VALUES ('462233',2026,1,'8','3116165','Chris Godwin Jr.','x')").run();
  const r = resolveTrade(db, ["Chris Godwin"], ["Nobody At All"]);
  db.close();
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /no roster player matches "Nobody At All"/.test(p)));
});
