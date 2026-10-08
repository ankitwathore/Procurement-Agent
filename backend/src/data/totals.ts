import type { RfxLine } from "../schemas.js";

/** Spec section 17.2: baseline annual value of the 30 lines, in whole rupees. */
export const EXPECTED_BASELINE_TOTAL_INR = 39_985_580;

/**
 * Annual value of one line at baseline, in rupees.
 * Summed in integer paise so float error cannot creep into the total.
 */
export function lineAnnualValuePaise(line: RfxLine): number {
  return Math.round(line.annual_qty * line.baseline_price_inr * 100);
}

export function lineAnnualValue(line: RfxLine): number {
  return lineAnnualValuePaise(line) / 100;
}

export function baselineTotal(lines: readonly RfxLine[]): number {
  return lines.reduce((sum, l) => sum + lineAnnualValuePaise(l), 0) / 100;
}
