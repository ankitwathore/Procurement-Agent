import type { Quote } from "../ingest/quotes.js";
import { isSafe } from "../model/states.js";

/**
 * Scores one vendor's quotes against ground_truth.json (spec 19.1). Reads ground truth; never feeds it back to the app.
 * The number that matters most is `dangerous`: cells shown as safe whose value is wrong.
 */

export interface GtLine {
  quoted: boolean;
  expected_state: string;
  landed_unit_inr_point: number | null;
  /** Flags the quote stage must raise (evidence-stage flags live under expected_evidence_flags). */
  expected_flags?: string[];
  /** Other states that are also a correct outcome, for a line the document leaves genuinely ambiguous. */
  also_acceptable?: string[];
  /** What the vendor meant, where no price is expected to be shown (a slip): a safe cell must still match it. */
  true_landed_point?: number;
}

export interface LineScore {
  line_id: string;
  expected_state: string;
  got_state: string;
  state_ok: boolean;
  expected_point: number | null;
  got_point: number | null;
  /** null when ground truth has no price to compare (missing, or a deliberate review case). */
  price_ok: boolean | null;
  dangerous: boolean;
  /** Expected flags the quote did not raise. */
  missing_flags: string[];
}

export interface VendorScore {
  lines: LineScore[];
  state_accuracy: number;
  price_checked: number;
  price_accuracy: number;
  /** Shown as safe but wrong: the failure the whole design exists to prevent. */
  dangerous: string[];
  /** Ground truth says quoted, the app says MISSING; or the reverse. */
  coverage_errors: string[];
  flags_expected: number;
  /** Share of expected flags raised (trap recall at the quote stage). 1 when none were expected. */
  flag_recall: number;
  /** "L04:hidden_value_differs" for each expected flag not raised. */
  missing_flags: string[];
}

/** Within this relative tolerance a landed price counts as correct (spec 19.1: 0.5 percent). */
export const PRICE_TOLERANCE = 0.005;

export function scoreVendor(quotes: readonly Quote[], gt: Readonly<Record<string, GtLine>>, safeStates: readonly string[]): VendorScore {
  const lines: LineScore[] = [];
  for (const [line_id, g] of Object.entries(gt)) {
    const q = quotes.find((x) => x.line_id === line_id);
    const got_state = q?.state ?? "MISSING";
    const got_point = q?.landed?.point ?? null;
    const expected_point = g.landed_unit_inr_point;
    const acceptable = [g.expected_state, ...(g.also_acceptable ?? [])];
    let price_ok: boolean | null = null;
    // An acceptable review outcome carries no price, so there is no price to check.
    const unpricedReview = got_state === "NEEDS_REVIEW" && got_point === null && acceptable.includes("NEEDS_REVIEW");
    if (expected_point !== null && !unpricedReview) price_ok = got_point !== null && Math.abs(got_point - expected_point) / expected_point <= PRICE_TOLERANCE;
    const safe = isSafe(got_state as never, safeStates);
    // A cell with no expected price (a slip) is still dangerous when shown safe at a value the vendor did not mean.
    const truth = expected_point ?? g.true_landed_point ?? null;
    const offTruth = truth !== null && got_point !== null && Math.abs(got_point - truth) / truth > PRICE_TOLERANCE;
    const dangerous = safe && (price_ok === false || offTruth || (!g.quoted && got_state !== "MISSING" && expected_point === null));
    const missing_flags = (g.expected_flags ?? []).filter((f) => !(q?.flags ?? []).includes(f));
    lines.push({ line_id, expected_state: g.expected_state, got_state, state_ok: acceptable.includes(got_state), expected_point, got_point, price_ok, dangerous, missing_flags });
  }
  const checked = lines.filter((l) => l.price_ok !== null);
  const flagsExpected = Object.values(gt).reduce((n, g) => n + (g.expected_flags?.length ?? 0), 0);
  const missing = lines.flatMap((l) => l.missing_flags.map((f) => `${l.line_id}:${f}`));
  return {
    lines,
    state_accuracy: lines.length ? lines.filter((l) => l.state_ok).length / lines.length : 0,
    price_checked: checked.length,
    price_accuracy: checked.length ? checked.filter((l) => l.price_ok).length / checked.length : 0,
    dangerous: lines.filter((l) => l.dangerous).map((l) => l.line_id),
    coverage_errors: lines.filter((l) => (l.expected_state === "MISSING") !== (l.got_state === "MISSING")).map((l) => l.line_id),
    flags_expected: flagsExpected,
    flag_recall: flagsExpected === 0 ? 1 : (flagsExpected - missing.length) / flagsExpected,
    missing_flags: missing,
  };
}
