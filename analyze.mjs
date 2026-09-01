import { readFileSync } from "node:fs";
const file = process.argv[2] || "data/draft-recap-2025-raw.txt";
const lines = readFileSync(file, "utf8").split("\n");
const picks = [];
for (const l of lines) {
  const m = l.match(/^(\d+)(.+?) ([A-Za-z]{2,4}), ([A-Za-z/]+)\$(\d+)$/);
  if (m) picks.push({ pick: +m[1], player: m[2].trim(), team: m[3], pos: m[4], price: +m[5] });
}
const prices = picks.map((p) => p.price).sort((a, b) => b - a);
const sum = prices.reduce((a, b) => a + b, 0);
const byPos = {};
for (const p of picks) (byPos[p.pos] = byPos[p.pos] || []).push(p);
const posLine = Object.keys(byPos).map((pos) => {
  const arr = byPos[pos].sort((a, b) => b.price - a.price);
  const tot = arr.reduce((s, x) => s + x.price, 0);
  return `${pos}:$${tot}(avg${(tot / arr.length).toFixed(0)},max${arr[0].price})`;
}).join("  ");
console.log(`${file}`);
console.log(`  picks=${picks.length} total$${sum} avg${(sum / picks.length).toFixed(1)} median${prices[Math.floor(prices.length / 2)]}`);
console.log(`  top8: ${prices.slice(0, 8).join(",")}  >$50:${prices.filter((p) => p > 50).length} >$30:${prices.filter((p) => p > 30).length} $1-5:${prices.filter((p) => p < 6).length}(${((prices.filter((p) => p < 6).length / picks.length) * 100).toFixed(0)}%)`);
console.log(`  by pos: ${posLine}`);
