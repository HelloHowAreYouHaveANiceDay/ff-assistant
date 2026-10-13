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

/**
 * PLAYING NAMES (2026-10-13): a man the feeds know by a name that is NOT a spelling of his given
 * name, so no first-name group can reach it. Each entry is ONE named man, full name key -> full
 * name key, checked by hand against his ids -- never a pattern. The same caller rules apply: the
 * position must agree and exactly one staged person may answer, else the alias is refused.
 *
 * hollywoodbrown -> marquisebrown: the FantasyPros consensus (and so the ESPN board) calls him
 * "Hollywood Brown"; the crosswalk holds "Marquise Brown" (gsis 00-0035662, WR PHI). Unaliased,
 * build-staging minted a board-only stub (sk 12119, no ids) beside his real row (sk 2612), and the
 * D51 live universe then carried him TWICE: the consensus row under the stub, his prior season as
 * an extra under the real key.
 *
 * KNOWN, DELIBERATELY NOT LISTED YET: Chig/Chigoziem Okonkwo, Andy/Andres Borregales and Juice
 * Wells Jr./Antwane Wells are the same kind of stub, but none has a twin row on any board today, and
 * aliasing them re-keys a consensus man's board row onto his real identity (age, played weeks) --
 * a number-moving change that needs its own before/after and sign-off.
 */
const PLAYING_NAMES: [string, string][] = [
  ["hollywoodbrown", "marquisebrown"],
  // D51 extras named by their PRIOR-season feed, which the crosswalk spells differently. Both feature
  // rows already carry the crosswalk's key (feat_key 606 / 1270), so only the board's name lookup was
  // lost: natecarter -> Nathan Carter (sk 606, gsis 00-0040547, RB ATL; "nate" is a Nathaniel
  // spelling in GROUPS, so no first-name rule reaches Nathan), jalenmorenocropper -> Jalen Cropper
  // (sk 1270, gsis 00-0038740, WR NO).
  ["natecarter", "nathancarter"],
  ["jalenmorenocropper", "jalencropper"],
];
const PLAYING_BY_KEY = new Map<string, Set<string>>();
for (const [a, b] of PLAYING_NAMES) {
  (PLAYING_BY_KEY.get(a) ?? PLAYING_BY_KEY.set(a, new Set()).get(a)!).add(b);
  (PLAYING_BY_KEY.get(b) ?? PLAYING_BY_KEY.set(b, new Set()).get(b)!).add(a);
}

/** The other spellings of this first name (lower-case), empty when it has none. */
export function firstNameVariants(first: string): string[] {
  return [...(BY_NAME.get(first.trim().toLowerCase()) ?? [])];
}

/**
 * The NAME KEYS this full name could also be written as, by swapping its first name for an
 * equivalent spelling. Surname, suffix and everything after the first token are kept verbatim. The
 * input's own key is NOT included. Empty when the first name has no listed equivalents. A listed
 * PLAYING NAME's partner key is included too (whole name, both directions).
 */
export function nicknameKeys(fullName: string): string[] {
  const parts = String(fullName ?? "").trim().split(/\s+/);
  if (parts.length < 2) return [];
  const rest = parts.slice(1).join(" ");
  const own = nameKey(fullName);
  const out = new Set<string>();
  for (const k of PLAYING_BY_KEY.get(own) ?? []) if (k !== own) out.add(k);
  for (const v of firstNameVariants(parts[0].replace(/\./g, ""))) {
    const k = nameKey(`${v} ${rest}`);
    if (k && k !== own) out.add(k);
  }
  return [...out];
}
