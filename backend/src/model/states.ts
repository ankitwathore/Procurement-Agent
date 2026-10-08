/**
 * Cell states and the first-match-wins assignment from spec 8.4.
 */

export type CellState =
  | "CONFIRMED"
  | "HIGH_CONF"
  | "BUYER_VERIFIED"
  | "INFERRED"
  | "NEEDS_REVIEW"
  | "MISSING";

/** Higher is worse. BUYER_VERIFIED ranks with CONFIRMED. */
const SEVERITY: Record<CellState, number> = {
  MISSING: 5,
  NEEDS_REVIEW: 4,
  INFERRED: 3,
  HIGH_CONF: 2,
  CONFIRMED: 1,
  BUYER_VERIFIED: 1,
};

/** Higher is worse. Used for tie-breaks (spec 15.3). */
export function stateRank(state: CellState): number {
  return SEVERITY[state];
}

export function worstState(states: readonly CellState[]): CellState {
  if (states.length === 0) throw new Error("worstState of nothing");
  return states.reduce((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst));
}

export function isSafe(state: CellState, safeStates: readonly string[]): boolean {
  return safeStates.includes(state);
}

/** Image legibility below this is treated as unreadable (rule 3). */
export const LEGIBILITY_MIN = 0.6;

export interface StateInputs {
  hasQuoteEvidence: boolean;
  /** Vendor said "rest same as last year" (or equivalent) and it resolves to baseline. */
  coveredByDefaultStatement: boolean;
  passesDisagree: boolean;
  adjudication: "none" | "resolved" | "unresolved";
  unreadable: boolean;
  unitAmbiguous: boolean;
  hardOutlier: boolean;
  /** More than one conflicting row for the same line. */
  conflictingRows: boolean;
  arithmeticFails: boolean;
  struckOut: boolean;
  /** Foreign currency price that is "subject to the rate on the date of order" (spec C02). */
  fxClause: boolean;
  /**
   * The unit or currency is not written next to the value: carried over from the same sentence, or a missing
   * currency taken as the RFx currency. Priced, but awaiting the buyer's confirmation.
   */
  carriedOver: boolean;
  visionDerived: boolean;
  lowImpactAssumption: boolean;
  /** Extra context appended to the reason, e.g. why a unit was ambiguous. */
  detail?: string;
}

export const NO_FLAGS: StateInputs = {
  hasQuoteEvidence: true,
  coveredByDefaultStatement: false,
  passesDisagree: false,
  adjudication: "none",
  unreadable: false,
  unitAmbiguous: false,
  hardOutlier: false,
  conflictingRows: false,
  arithmeticFails: false,
  struckOut: false,
  fxClause: false,
  carriedOver: false,
  visionDerived: false,
  lowImpactAssumption: false,
};

export interface StateResult {
  state: CellState;
  rule: number;
  reason: string;
}

export function assignState(i: StateInputs): StateResult {
  const why = (text: string): string => (i.detail ? `${text}: ${i.detail}` : text);
  const r = (state: CellState, rule: number, reason: string): StateResult => ({ state, rule, reason });

  if (!i.hasQuoteEvidence) {
    return i.coveredByDefaultStatement
      ? r("INFERRED", 1, "Not quoted; derived from the vendor's default statement for unquoted lines.")
      : r("MISSING", 1, "Vendor did not quote this line. Never imputed.");
  }
  if (i.passesDisagree && i.adjudication !== "resolved") {
    return r("NEEDS_REVIEW", 2, "Two readings disagree and adjudication could not settle it.");
  }
  if (i.unreadable) return r("NEEDS_REVIEW", 3, why("Region unreadable"));
  if (i.unitAmbiguous) return r("NEEDS_REVIEW", 4, why("Unit or currency ambiguous"));
  if (i.hardOutlier) return r("NEEDS_REVIEW", 5, why("Hard outlier or magnitude slip"));
  if (i.conflictingRows) return r("NEEDS_REVIEW", 5, why("Conflicting rows for the same line"));
  if (i.arithmeticFails) return r("NEEDS_REVIEW", 6, why("Arithmetic check failed"));
  if (i.struckOut) return r("NEEDS_REVIEW", 7, why("Value struck out or overwritten"));
  // Added beyond spec 8.4's ten rules: the price is not final, so it can never be safe (spec 8.5 gives it a band).
  if (i.fxClause) return r("INFERRED", 11, why("Price depends on the FX rate at the order date"));
  // Also beyond spec 8.4: a value whose unit or currency was read from elsewhere in the sentence is priced, but not
  // safe until the buyer confirms the reading (one confirmation per vendor batch).
  if (i.carriedOver) return r("INFERRED", 12, why("Unit or currency not written next to the price; awaiting buyer confirmation"));
  if (i.passesDisagree) return r("HIGH_CONF", 2, "Passes disagreed; adjudicator resolved it with cited evidence.");
  if (i.visionDerived) return r("HIGH_CONF", 8, "Read from an image or OCR; passes agree and checks pass.");
  if (i.lowImpactAssumption) return r("HIGH_CONF", 9, why("Agreed and checked, with a stated low impact assumption"));
  return r("CONFIRMED", 10, "Stated explicitly in a text source; checks pass.");
}
