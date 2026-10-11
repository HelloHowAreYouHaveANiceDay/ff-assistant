// What KIND of story a news headline is -- league-neutral, pure, unit-tested (test/news-watch.test.ts).
//
// Every RSS headline used to be written as `category=headline, severity=low`, and Layer 2
// (`classifyNews`) treats a low headline as informational. So "Report: Cardinals will be trading
// receiver Marvin Harrison Jr." (PFT, 2026-10-10) sat in the feed for a day as background noise
// while he was a free agent in our league, and another team added him on 2026-10-11 at 12:08 ET.
// A trade, a release, a season-ending injury or a new starter is a change in a player's VALUE, not
// colour -- the severity has to say so, or nothing downstream can act on it.
//
// Rules, in precedence order (first match wins; a trade story that mentions "inactive" is a trade):
//   transaction  trade / release / waive / sign / claim   high = done or reported-as-happening,
//                                                          medium = rumour, interest, "could"
//   injury       structural or game-status injury words   high = season-ending / ruled out / IR
//   role         depth-chart or job change                 medium
// Anything else is "" (a plain headline; severity low, as before).
export type HeadlineKind = "transaction" | "injury" | "role" | "";

const TRANSACTION = /\b(trade[sd]?|trading|dealt|acquir(e|es|ed|ing)|releas(e|es|ed|ing)|waive[sd]?|waiving|cut by|claimed off waivers|signs with|re-signs?|signed|signing|destination|landing spot)\b/i;
// A transaction reported as fact (or as imminent by a named report), not as speculation.
const TRANSACTION_FIRM = /\b(traded|dealt|acquires?|acquired|released|waived|signed|signs with|finaliz(e|es|ed|ing)|agree(s|d)? to|will be trading|are trading|is being traded|sends?|lands?|completes?|completed)\b/i;
const SPECULATIVE = /\b(rumou?r(s|ed)?|interest|could|would|might|ideas?|packages?|potential|whether|if the|mystery|chatter|value of|wild)\b|\?/i;

const INJURY = /\b(acl|mcl|achilles|torn|tears?|fracture[sd]?|broken|injured reserve|ir\b|carted|concussion|surgery|sprain(ed)?|hamstring|ruled out|out for (the )?(season|year)|season-ending|inactive|won'?t play|will not play|doubtful|week-to-week|multiple weeks)\b/i;
const INJURY_HIGH = /\b(acl|achilles|torn|fracture[sd]?|broken|injured reserve|ir\b|surgery|ruled out|out for (the )?(season|year)|season-ending|won'?t play|will not play|multiple weeks)\b/i;

const ROLE = /\b(named (the )?starter|named starting|start(s|ing)? at (qb|quarterback)|starting (qb|quarterback|job)|benched|demoted|promoted|lead back|takes over|first-team|workhorse|bell-?cow|depth chart|starter going forward)\b/i;

export function classifyHeadline(title: string): { kind: HeadlineKind; severity: "high" | "medium" | "low" } {
  const t = title || "";
  if (TRANSACTION.test(t)) {
    const firm = TRANSACTION_FIRM.test(t) && !SPECULATIVE.test(t);
    return { kind: "transaction", severity: firm ? "high" : "medium" };
  }
  if (INJURY.test(t)) return { kind: "injury", severity: INJURY_HIGH.test(t) ? "high" : "medium" };
  if (ROLE.test(t)) return { kind: "role", severity: "medium" };
  return { kind: "", severity: "low" };
}
