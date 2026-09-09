// Post-merge sanity: the failures a clean typecheck and a green test run do not notice.
//
// Two branches that both appended to the same tail can merge without a conflict and still
// produce a duplicate MCP tool name, a second CREATE TABLE for the same table, a shadowed
// CLI case label, or two renderer list entries with the same id. Each of those is silent:
// the later one wins and the earlier one is simply never reached.
//
// Scoping matters. `ff.ts` has more than one switch and `app.js` more than one id list, and
// the same label legitimately appears in two of them -- four such pairs exist at the merge
// base. So duplicates are checked WITHIN a scope, never across the file.
//
// Self-test: `--self-test` injects one duplicate of each kind into the parsed data and
// asserts the checker reports all four. A checker that can only ever say "clean" reads
// exactly like a passing one.
import { readFileSync } from 'node:fs';
import { TOOL_NAMES } from '../src/agent/agent.ts';

const selfTest = process.argv.includes('--self-test');
const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const dupOf = (a) => [...new Set(a.filter((x, i) => a.indexOf(x) !== i))];

const findings = [];
const check = (label, groups) => {
  let n = 0;
  const dups = [];
  for (const g of groups) {
    n += g.length;
    for (const d of dupOf(g)) dups.push(d);
  }
  console.log(label + ': ' + n + ' in ' + groups.length + ' scope(s)');
  if (dups.length) {
    console.log('  DUPLICATE: ' + [...new Set(dups)].join(', '));
    findings.push(label);
  }
};

// --- MCP tools: one flat namespace, so one scope.
const tools = TOOL_NAMES.slice();
if (selfTest) tools.push(tools[0]);
check('MCP tool names', [tools]);

// --- schema.sql: one database, so one scope.
const schema = read('src/db/schema.sql');
const tables = [...schema.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase());
if (selfTest) tables.push(tables[0]);
check('schema tables', [tables]);

// --- ff.ts: one scope per `switch (`.
const ff = read('src/ff.ts');
const caseScopes = ff.split(/\bswitch\s*\(/).slice(1)
  .map((chunk) => [...chunk.matchAll(/^[ \t]*case\s+["']([^"']+)["']\s*:/gm)].map((m) => m[1]));
if (selfTest && caseScopes[0]) caseScopes[0].push(caseScopes[0][0]);
check('ff.ts case labels', caseScopes);

// --- app/renderer/app.js: one scope per run of `{ id: ... }` entries on adjacent lines.
const appJs = read('app/renderer/app.js');
const idHits = [];
{
  const lines = appJs.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /\{\s*id:\s*["']([a-z0-9_.-]+)["']/i.exec(lines[i]);
    if (m) idHits.push({ line: i, id: m[1] });
  }
}
const idScopes = [];
for (const hit of idHits) {
  const last = idScopes[idScopes.length - 1];
  if (last && hit.line - last.line <= 3) { last.ids.push(hit.id); last.line = hit.line; }
  else idScopes.push({ line: hit.line, ids: [hit.id] });
}
const idGroups = idScopes.map((s) => s.ids);
if (selfTest && idGroups[0]) idGroups[0].push(idGroups[0][0]);
check('renderer list ids', idGroups);

if (selfTest) {
  const want = ['MCP tool names', 'schema tables', 'ff.ts case labels', 'renderer list ids'];
  const missed = want.filter((w) => !findings.includes(w));
  if (missed.length) {
    console.log('SELF-TEST FAIL -- these checks did not fire on an injected duplicate: ' + missed.join(', '));
    process.exit(1);
  }
  console.log('SELF-TEST PASS -- all four checks fired on an injected duplicate');
  process.exit(0);
}

console.log(findings.length ? 'MERGE SANITY: FAIL' : 'MERGE SANITY: PASS');
process.exit(findings.length ? 1 : 0);
