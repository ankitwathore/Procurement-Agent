import type { Rng } from "./rng.js";
import type { RfxLine } from "../schemas.js";

/**
 * Price generation rule from spec 17.5:
 *   quote_rate = baseline * vendor_factor * (1 + noise), noise uniform in +/-1.5%, rounded to 2 dp.
 * Factors are ex GST, in the vendor's own freight basis. Freight is added later, at landing.
 *
 * This is generator-only logic. The app never imports it.
 */

export const NOISE_PCT = 1.5;

export type VendorId = "V1" | "V2" | "V3" | "V4" | "V5";

/**
 * Factor per line, or null when the line is not generated from baseline for that vendor.
 * V5 is statement based ("rest same as last year"), so it has no generated factors.
 */
export const VENDOR_FACTORS: Partial<Record<VendorId, (lineId: string) => number | null>> = {
  // V1: 0.985 on L01 to L25, 1.00 on L26 to L30.
  V1: (lineId) => (lineNumber(lineId) <= 25 ? 0.985 : 1.0),
  // V2: displayed rates are inclusive of GST; these factors are the ex GST basis.
  V2: (lineId) => {
    const n = lineNumber(lineId);
    if (n >= 23 && n <= 25) return 0.92;
    if ((n >= 26 && n <= 28) || n === 30) return 0.95;
    return 0.9;
  },
  // V3: 1.03 on INR lines. L26 to L28 are quoted in USD, so they are not generated here.
  V3: (lineId) => {
    const n = lineNumber(lineId);
    return n >= 26 && n <= 28 ? null : 1.03;
  },
  // V4: 0.88 ex GST, ex works Bahadurgarh.
  V4: () => 0.88,
};

export function lineNumber(lineId: string): number {
  const n = Number(lineId.slice(1));
  if (!/^L\d{2}$/.test(lineId) || Number.isNaN(n)) throw new Error(`bad line id: ${lineId}`);
  return n;
}

/** One rate. Deterministic given the rng state. */
export function quoteRate(baselineInr: number, factor: number, rng: Rng): number {
  const noise = rng.uniform(-NOISE_PCT / 100, NOISE_PCT / 100);
  return roundTo2dp(baselineInr * factor * (1 + noise));
}

/**
 * Generates one vendor's rates for every line, in RFx order, so the same seed
 * always produces the same sequence of draws.
 */
export function generateVendorRates(
  vendor: VendorId,
  lines: readonly RfxLine[],
  rng: Rng,
  /** Per-line factors that replace the vendor's usual one, e.g. a lighter board offered at a lower price. */
  factorOverrides: Readonly<Record<string, number>> = {},
): Map<string, number> {
  const factorFor = VENDOR_FACTORS[vendor];
  if (!factorFor) throw new Error(`${vendor} rates are not generated from baseline`);
  const out = new Map<string, number>();
  for (const line of lines) {
    const factor = factorOverrides[line.line_id] ?? factorFor(line.line_id);
    // Draw for every line, even skipped ones, so the seed stream does not depend on which lines are generated.
    const rate = quoteRate(line.baseline_price_inr, factor ?? 1, rng);
    if (factor !== null) out.set(line.line_id, rate);
  }
  return out;
}

export function roundTo2dp(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}
