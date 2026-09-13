/** Round to 3 decimals -- the display precision the in-season surfaces round to. It was redefined as
 *  a local `r3` / `round3` in four files; a pure function with no real drift risk, but one home is one
 *  definition to read. A leaf module (no imports), so importing it cannot create a cycle. */
export const round3 = (x: number): number => Math.round(x * 1000) / 1000;
