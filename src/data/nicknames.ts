/**
 * FIRST-NAME EQUIVALENCE -- the one place a nickname may stand for a given name (2026-10-06).
 *
 * WHY THIS EXISTS. Two feeds spell the same man two ways and every key in the store is a NAME key:
 * the Yahoo league's board says "Andrew Ogletree" and "Josh Palmer", the crosswalk staging is built
 * from says "Drew Ogletree" and "Joshua Palmer". `nameKey` cannot see that `andrewogletree` and
 * `drewogletree` are one person, so the board row resolved to nobody (board.player_sk NULL) -- and a
 * naive fix (stage the board's spelling as a new row) would have minted a SECOND person for the same
 * man, which is the exact duplicate the staging layer exists to prevent.
 *
 * WHAT IT IS NOT. Not a fuzzy matcher. Every group below is a set of spellings of ONE given name, and
 * a variant is only ever a CANDIDATE: the caller (stgPlayer.ts) accepts it only when the surname is
 * identical, the position agrees, and exactly one staged player answers to it. Two people who share
 * a surname and a nickname-equivalent first name at one position is a coin flip, and the caller
 * refuses it rather than guessing.
 *
 * Deliberately conservative: pairs that are DIFFERENT names in practice (Jon / John, Steven / Stephen
 * as separate given names, Christian / Chris) are left out. A missing pair costs one unresolved row,
 * which is visible; a wrong pair merges two men, which is not.
 */
import { nameKey } from "../draft/values.js";

const GROUPS: string[][] = [
  ["andrew", "drew", "andy"],
  ["joshua", "josh"],
  ["michael", "mike"],
  ["matthew", "matt"],
  ["christopher", "chris"],
  ["robert", "rob", "robbie", "bob", "bobby"],
  ["william", "will", "bill", "billy"],
  ["daniel", "dan", "danny"],
  ["joseph", "joe", "joey"],
  ["anthony", "tony"],
  ["benjamin", "ben"],
  ["nicholas", "nick"],
  ["samuel", "sam"],
  ["gabriel", "gabe"],
  ["jeffrey", "jeff"],
  ["kenneth", "ken", "kenny"],
  ["thomas", "tom", "tommy"],
  ["timothy", "tim"],
  ["zachary", "zach", "zack"],
  ["alexander", "alex"],
  ["cameron", "cam"],
  ["jacob", "jake"],
  ["edward", "ed", "eddie"],
  ["richard", "rich", "rick", "ricky"],
  ["james", "jim", "jimmy"],
  ["charles", "chuck", "charlie"],
  ["patrick", "pat"],
  ["gregory", "greg"],
  ["frederick", "fred"],
  ["kristopher", "kris"],
  ["nathaniel", "nate"],
  ["jonathan", "jon"],
  ["douglas", "doug"],
  ["ronald", "ron"],
  ["donald", "don"],
  ["lawrence", "larry"],
  ["phillip", "phil"],
  ["philip", "phil"],
  ["maxwell", "max"],
];

const BY_NAME = new Map<string, Set<string>>();
for (const g of GROUPS) {
  for (const n of g) {
    const s = BY_NAME.get(n) ?? new Set<string>();
    for (const m of g) if (m !== n) s.add(m);
    BY_NAME.set(n, s);
  }
}

/** The other spellings of this first name (lower-case), empty when it has none. */
export function firstNameVariants(first: string): string[] {
  return [...(BY_NAME.get(first.trim().toLowerCase()) ?? [])];
}

/**
 * The NAME KEYS this full name could also be written as, by swapping its first name for an
 * equivalent spelling. Surname, suffix and everything after the first token are kept verbatim. The
 * input's own key is NOT included. Empty when the first name has no listed equivalents.
 */
export function nicknameKeys(fullName: string): string[] {
  const parts = String(fullName ?? "").trim().split(/\s+/);
  if (parts.length < 2) return [];
  const rest = parts.slice(1).join(" ");
  const own = nameKey(fullName);
  const out = new Set<string>();
  for (const v of firstNameVariants(parts[0].replace(/\./g, ""))) {
    const k = nameKey(`${v} ${rest}`);
    if (k && k !== own) out.add(k);
  }
  return [...out];
}
