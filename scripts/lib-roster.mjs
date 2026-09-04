// Shared parser for `ff roster` output. Both the suite and the single-run recorder use THIS -- a
// second copy would drift, and the metrics it feeds (TE count, max K/DST price) are exactly the
// numbers we judge a draft by.
//
// Two traps this handles:
//  1. The line reports the SLOT, not the position. A TE in a FLEX or BE slot still prints FLEX/BE,
//     so counting TEs off the slot undercounts precisely what we are measuring.
//  2. `ff roster` ABBREVIATES names ("L. Jackson", "H. Mevis"), which never match the store's full
//     names -- a naive lookup returns "?" for every starter and silently zeroes the metrics.
import Database from "better-sqlite3";

export const nameKey = (s) => String(s).toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, " ").replace(/\bd\/?st\b/g, " ").replace(/[^a-z]/g, "");

/** first-initial + surname, e.g. "L. Jackson" and "Lamar Jackson" both -> "l|jackson". */
export const initialKey = (s) => {
  const clean = String(s).replace(/\((QB|RB|WR|TE|K|DST)\)\s*$/, "").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return nameKey(clean);
  const surname = nameKey(parts[parts.length - 1]);
  const initial = (parts[0][0] || "").toLowerCase();
  return `${initial}|${surname}`;
};

export function loadPositionIndex(dbPath = "data/ff.db") {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("SELECT name, position FROM player").all();
  db.close();
  const byFull = new Map(), byInitial = new Map();
  for (const r of rows) {
    byFull.set(nameKey(r.name), r.position);
    const k = initialKey(r.name);
    // Ambiguous initial+surname (two "J. Smith") -> refuse rather than guess wrong.
    if (byInitial.has(k) && byInitial.get(k) !== r.position) byInitial.set(k, "?");
    else if (!byInitial.has(k)) byInitial.set(k, r.position);
  }
  return { byFull, byInitial };
}

const SLOT_POS = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);

export function parseRoster(txt, idx) {
  const filled = /filled (\d+)\/(\d+)/.exec(txt);
  const spent = /spent \$(\d+)/.exec(txt);
  const won = [];
  const line = (/^won: (.*)$/m.exec(txt) || [])[1] || "";
  if (line && !/^\(none\)/.test(line)) {
    for (const part of line.split("|")) {
      const m = /^\s*(QB|RB|WR|TE|K|DST|D-ST|FLEX|BE|BENCH|IR)\s+(.+?)\s+\$(\d+)\s*$/.exec(part);
      if (!m) continue;
      const slot = m[1] === "D-ST" ? "DST" : m[1];
      const raw = m[2].trim();
      const inline = (/\((QB|RB|WR|TE|K|DST)\)\s*$/.exec(raw) || [])[1];
      const nm = raw.replace(/\((QB|RB|WR|TE|K|DST)\)\s*$/, "").trim();
      // Priority: the slot itself (unambiguous for dedicated slots) -> an inline "(WR)" annotation
      // -> full-name lookup -> initial+surname lookup.
      const pos = SLOT_POS.has(slot) ? slot
        : inline || idx?.byFull.get(nameKey(nm)) || idx?.byInitial.get(initialKey(nm)) || "?";
      won.push({ slot, name: nm, pos, price: Number(m[3]) });
    }
  }
  const byPos = {};
  for (const w of won) byPos[w.pos] = (byPos[w.pos] || 0) + 1;
  return {
    filled: filled ? Number(filled[1]) : null,
    slots: filled ? Number(filled[2]) : null,
    spent: spent ? Number(spent[1]) : null,
    won, byPos,
    teCount: byPos.TE || 0,
    kdstMax: Math.max(0, ...won.filter((w) => w.pos === "K" || w.pos === "DST").map((w) => w.price)),
    unresolved: won.filter((w) => w.pos === "?").map((w) => w.name),
  };
}

/** Metrics read out of an auto-draft log. Shared so the suite and the single-run recorder report the
 *  SAME fields -- the suite previously omitted dupeNominations entirely, and `(r.dupeNominations||[])
 *  .length` then reported 0 for every run, which reads exactly like "no duplicates found". */
export function parseDraftLog(log) {
  const noms = [...log.matchAll(/^r(\d+): NOMINATE (.+?) \((our turn|fallback)\)(.*)$/gm)]
    .map((m) => ({ round: Number(m[1]), player: m[2].trim(), turn: m[3], failed: /failed/.test(m[4]) }));
  const counts = new Map();
  for (const n of noms) counts.set(n.player, (counts.get(n.player) || 0) + 1);
  return {
    srcCounts: (log.match(/src=[a-z()-]+/g) || []).reduce((a, s) => (a[s] = (a[s] || 0) + 1, a), {}),
    nominations: noms.length,
    failedNominations: noms.filter((n) => n.failed).length,
    // Same player nominated more than once. Benign in practice (the repeat targets the SAME player
    // and only one nomination results), but tracked so a change in the pattern is visible.
    dupeNominations: [...counts.entries()].filter(([, c]) => c > 1).map(([n, c]) => `${n} x${c}`),
    stalls: log.split("\n").filter((l) => /stall|disconnect|error|Error|cannot|failed to/i.test(l)).slice(0, 10),
  };
}
