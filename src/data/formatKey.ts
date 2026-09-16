// FORMAT KEYS -- the content hashes that let two leagues SHARE a model when their rules match, and
// force a new model only where they genuinely differ (docs/multi-format-design.md, "layered cache keys").
//
// The model decomposes into layers of increasing specificity; each layer reuses whatever a league
// matches at that layer:
//   scoringKey = hash(ScoringRules)                          -> the projection TARGET + trained heads
//   valueKey   = hash(scoring + roster/eligibility + teams)  -> the value book (added when Layer 2 lands)
//   formatKey  = hash(everything incl. playoff calendar)     -> strategy/levers + golden master
//
// This module owns scoringKey today; the wider keys join it as their layers are built. A key must be
// STABLE: the SAME rules must always produce the SAME key regardless of object key order or float
// noise, or a league would silently retrain every run and never reuse a model. So the input is
// canonicalized (keys sorted, numbers rounded, tier arrays sorted) before hashing.
import { createHash } from "node:crypto";
import type { ScoringRules } from "../draft/scoring.js";

/** Round to 6 dp so 0.1 vs 0.09999999999 (JSON float noise) cannot fork the key. */
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Canonical, order-independent JSON of any value: object keys sorted, numbers rounded, arrays kept in
 *  a canonical order (tier arrays are sorted by their first element so [[400,3],[300,2]] == [[300,2],[400,3]]).
 *  Absent/undefined fields are dropped so `{rec:1}` and `{rec:1, recByPos:undefined}` hash identically. */
function canonical(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === "number") return r6(v);
  if (Array.isArray(v)) {
    const items = v.map(canonical);
    // A tier array is an array of [number, number] pairs; sort those canonically. Leave other arrays
    // (there are none in ScoringRules today) in place.
    if (items.every((x) => Array.isArray(x) && x.length === 2 && typeof (x as unknown[])[0] === "number")) {
      return [...items].sort((a, b) => ((a as number[])[0] - (b as number[])[0]) || ((a as number[])[1] - (b as number[])[1]));
    }
    return items;
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const cv = canonical((v as Record<string, unknown>)[k]);
      if (cv !== undefined) out[k] = cv;
    }
    return out;
  }
  return v;
}

/** Deterministic canonical JSON string -- the exact bytes that get hashed (also useful in a manifest). */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(canonical(v));
}

/** The scoring-layer key: `sc-<12 hex>` of the canonicalized scoring rules. Determines the projection
 *  target and the trained heads; any two leagues with byte-identical scoring share them. */
export function scoringKey(scoring: ScoringRules): string {
  const h = createHash("sha256").update(canonicalJson(scoring)).digest("hex").slice(0, 12);
  return `sc-${h}`;
}
