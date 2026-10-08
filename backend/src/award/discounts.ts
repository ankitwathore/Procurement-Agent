import { parseNumber } from "../normalize/parse.js";

/**
 * Conditional (threshold) discounts, applied at scenario level only (spec 9.2, 15.3, T02, W07).
 * The discount depends on the vendor's whole awarded value, so it can never be baked into a per-line price.
 */

export interface RawDiscount {
  pct: number;
  condition_text: string;
  /** As written, e.g. "25 lakh" or "Rs 25,00,000". Code parses it; the model does not convert. */
  threshold_text: string;
  /** Spec 9.2 and 15.3 use "at least". A vendor who writes "exceeds" can set this false. */
  threshold_inclusive: boolean;
  snippet: string;
}

export interface ResolvedDiscount {
  pct: number;
  threshold_inr: number;
  inclusive: boolean;
  condition_text: string;
  snippet: string;
}

/** Returns null when the percentage or the threshold cannot be read, so nothing is applied on a guess. */
export function resolveDiscount(raw: RawDiscount): ResolvedDiscount | null {
  if (!(raw.pct > 0 && raw.pct <= 100)) return null;
  let threshold: number;
  try {
    threshold = parseNumber(raw.threshold_text);
  } catch {
    return null;
  }
  if (!(threshold > 0)) return null;
  return {
    pct: raw.pct,
    threshold_inr: threshold,
    inclusive: raw.threshold_inclusive,
    condition_text: raw.condition_text,
    snippet: raw.snippet,
  };
}

export interface DiscountEvaluation {
  applies: boolean;
  /** Rupees taken off; 0 when the threshold is not met. */
  amount: number;
  /** Value after the discount. */
  net: number;
  /** Value minus threshold: headroom when positive, shortfall when negative. */
  margin: number;
}

/** Evaluates one discount against a vendor's pre-discount awarded value in INR (ex GST). */
export function evaluateDiscount(
  preDiscountValue: number,
  d: Pick<ResolvedDiscount, "pct" | "threshold_inr" | "inclusive">,
): DiscountEvaluation {
  const margin = preDiscountValue - d.threshold_inr;
  const applies = d.inclusive ? margin >= 0 : margin > 0;
  const amount = applies ? (preDiscountValue * d.pct) / 100 : 0;
  return { applies, amount, net: preDiscountValue - amount, margin };
}
