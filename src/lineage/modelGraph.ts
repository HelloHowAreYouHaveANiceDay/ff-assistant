// THE MODEL PAGE'S GRAPH IS DERIVED FROM THE REGISTRY, NOT A CURATED LIST OF BOXES.
//
// It used to be a hardcoded MODEL_NODES/MODEL_EDGES pair in app/renderer/app.js, and it rotted the
// way every hand-maintained enumeration rots: it drew `age-curve` and `opportunity` as live feeders
// of the projection for months after Phase 2b retired them into the trained artifact, and it had no
// box at all for the seven models added since -- the trained `projection` itself, the weekly pair,
// `streaming`, `price`, `injury-duration`, `faab`. The table beneath it was live off the registry
// the whole time, so the page showed a current table under a stale picture.
//
// The fix, so it cannot happen again: the MODEL nodes are GENERATED from `MODELS` +
// `EVALUATED_NOT_SHIPPED`. Add a model to the registry and a box appears with no edit here. What
// stays curated is (a) the structural nodes that are not models -- the sources, the simulator, the
// outputs -- and (b) the EDGES, because what-feeds-what is genuine editorial knowledge the registry
// does not carry. The guard against the curated half rotting is test/model-graph-derivation.test.ts:
// every generated model node must be named by at least one edge, so a new registry entry that nobody
// wired here surfaces as a floating box and fails the test. A node's status (shipped / retired /
// unused) is read from the registry's `status` field, never re-decided here.
import { MODELS, EVALUATED_NOT_SHIPPED } from "../draft/models.js";

export interface ModelGraphNode {
  id: string;
  name: string;
  /** A CSS node kind in app/renderer/app.css: source | calc | output | model | retired | unused |
   *  rejected. Model nodes map their registry `status` onto the last three. */
  kind: string;
  sub: string;
}
export interface ModelGraph {
  nodes: ModelGraphNode[];
  edges: [string, string][];
}

// The NON-model nodes: sources feeding the fitted artifacts, the two calc stages, and the three
// decision outputs. Model boxes are added by computeModelGraph from the registry.
const STRUCTURAL_NODES: ModelGraphNode[] = [
  { id: "hist", name: "history-weekly.csv", kind: "source", sub: "27 seasons of real weeks" },
  { id: "nflv", name: "nflverse", kind: "source", sub: "usage · bio · injury · depth · schedule" },
  { id: "boardn", name: "board", kind: "source", sub: "consensus rank + ECR" },
  { id: "leaguehx", name: "league history", kind: "source", sub: "auction picks · waiver claims" },
  { id: "replacement", name: "streaming floor", kind: "calc", sub: "replacement level" },
  { id: "sim", name: "season simulator", kind: "calc", sub: "Monte Carlo × 14 weeks" },
  { id: "title", name: "title odds", kind: "output", sub: "the number decisions use" },
  { id: "trades", name: "trades · waivers", kind: "output", sub: "Δ vs base · FAAB bids" },
  { id: "lineup", name: "weekly lineup", kind: "output", sub: "start/sit · streaming · handcuffs" },
];

// EVERY edge names a structural id or a REGISTRY KEY. A model key that appears in no edge is a
// floating box, which test/model-graph-derivation.test.ts refuses -- that is what forces a newly
// registered model to be wired here rather than silently omitted. `retired`/`unused` models hang off
// their sources with no downstream edge, the same way the Data page draws a dead-end table; their
// kind, not a missing edge, is what says they produce no live number.
const EDGES: [string, string][] = [
  // sources -> the trained projection artifact (its own curve + named features, incl. age and usage
  // as FEATURES since Phase 2b -- which is why age-curve/opportunity no longer feed `proj`)
  ["hist", "projection"], ["nflv", "projection"], ["boardn", "projection"],
  // sources -> the simulator's other fitted inputs
  ["hist", "rank-outcomes"], ["hist", "variance-model"], ["hist", "correlation"],
  // measured-but-not-wired and retired branches: incoming only, kind carries the status
  ["nflv", "opponent-correlation"],
  ["hist", "age-curve"], ["nflv", "age-curve"],
  ["hist", "opportunity"], ["nflv", "opportunity"],
  ["nflv", "kdst"],
  // the weekly / in-season track (the challenger is not served but accrues scorecard evidence)
  ["hist", "weekly"], ["nflv", "weekly"],
  ["hist", "weekly-challenger"], ["nflv", "weekly-challenger"],
  ["hist", "streaming"], ["nflv", "streaming"],
  ["nflv", "injury-duration"],
  // the pricing track, fitted on this room's own money
  ["leaguehx", "price"], ["leaguehx", "faab"],
  // into the simulator, and out to the season outputs
  ["boardn", "replacement"],
  ["projection", "sim"], ["rank-outcomes", "sim"], ["variance-model", "sim"],
  ["correlation", "sim"], ["replacement", "sim"], ["price", "sim"],
  ["sim", "title"], ["title", "trades"], ["faab", "trades"],
  ["weekly", "lineup"], ["weekly-challenger", "lineup"], ["streaming", "lineup"], ["injury-duration", "lineup"],
];

const KIND_BY_STATUS: Record<string, string> = { retired: "retired", unused: "unused" };

/** The model graph as the engine serves it: structural nodes + one node per registered model +
 *  one per evaluated-not-shipped model, with the curated edges. The renderer draws exactly this and
 *  overlays each model node's live measured lift / failing-check state by key. */
export function computeModelGraph(): ModelGraph {
  const modelNodes: ModelGraphNode[] = MODELS.map((m) => ({
    id: m.key,
    name: m.key,
    kind: (m.status && KIND_BY_STATUS[m.status]) || "model",
    // A fallback subtitle; the renderer replaces it with the live lift or "FAILING CHECK" from the
    // registry status payload, so this only shows for a model whose artifact is absent on this clone.
    sub: m.nestedLift != null ? `nested R2 +${m.nestedLift.toFixed(4)}` : (m.required ? "required" : "optional"),
  }));
  const rejectedNodes: ModelGraphNode[] = EVALUATED_NOT_SHIPPED.map((r) => ({
    id: r.key,
    name: r.key,
    kind: "rejected",
    sub: "measured · not shipped",
  }));
  return { nodes: [...STRUCTURAL_NODES, ...modelNodes, ...rejectedNodes], edges: EDGES };
}
