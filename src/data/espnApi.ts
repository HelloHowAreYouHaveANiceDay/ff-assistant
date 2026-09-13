// The ESPN fantasy API bases, in ONE place. The read base was retyped in ~8 files (as a local
// `const HOST` in five, inline in ff.ts/agent.ts/assemble.ts) and the write base in a ninth, so ESPN
// moving the path was an N-file edit. A leaf module with no imports -- importing it cannot create a cycle.
export const ESPN_READS_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
export const ESPN_WRITES_BASE = "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl";
